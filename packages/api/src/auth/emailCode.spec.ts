import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type {
  EmailCodeChallenge,
  EmailCodeIdentity,
  EmailCodeRepository,
} from '@librechat/data-schemas';
import {
  EMAIL_ATTEMPT_COOKIE,
  AUTH_SELECTION_COOKIE,
  getAuthSelection,
  getEmailCodeConfig,
  mayRefreshGuest,
  setAuthSelection,
} from './authMode';
import { createEmailCodeAuth, validateEmailCodeBearer } from './emailCode';

const parseCookies: (value: string) => Record<string, string> = jest.requireActual('cookie').parse;
const error = (code: string) => Object.assign(new Error(code), { code });
const copy = <T>(value: T): T => structuredClone(value);

/** A deterministic port fixture proves HTTP/crypto composition, not Mongo transaction isolation. */
function fixture(sendFails = false) {
  const challenges = new Map<string, EmailCodeChallenge>();
  let identity: EmailCodeIdentity | undefined;
  let refreshHash = '';
  let sentCode = '';
  const repository: EmailCodeRepository = {
    consumeEmailCodeNetwork: jest.fn(async () => undefined),
    reserveEmailCodeAttempt: jest.fn(async ({ challenge, previousGeneration }) => {
      const old = challenges.get(challenge._id);
      if (old && old.generation !== previousGeneration) throw error('EMAIL_CODE_INVALID');
      challenges.set(challenge._id, copy(challenge));
    }),
    finishEmailCodeSend: jest.fn(async (id, generation, accepted) => {
      const current = challenges.get(id);
      if (current?.generation === generation) current.accepted = accepted;
    }),
    getEmailCodeChallenge: jest.fn(async (id, tenant) => {
      const current = challenges.get(id);
      return current?.tenantId === tenant ? copy(current) : null;
    }),
    redeemEmailCode: jest.fn(async (input) => {
      const c = challenges.get(input.attemptId);
      if (
        !c ||
        !c.accepted ||
        c.consumedAt ||
        c.nonceHash !== input.nonceHash ||
        c.verifier !== input.verifier ||
        c.generation !== input.generation ||
        c.expiresAt <= input.now
      ) {
        throw error('EMAIL_CODE_INVALID');
      }
      c.consumedAt = input.now;
      refreshHash = input.refreshTokenHash;
      identity = {
        user: {
          id: '1'.repeat(24),
          _id: '1'.repeat(24),
          email: c.email,
          emailVerified: true,
          name: '',
          username: '',
          provider: 'email_code',
          role: 'USER',
          tenantId: c.tenantId,
        },
        grant: {
          userId: '1'.repeat(24),
          sessionId: input.sessionId,
          tenantId: c.tenantId,
          authVersion: 0,
          policyVersion: input.policyVersion,
          refreshGeneration: 0,
          createdAt: Date.now(),
          absoluteExpiresAt: Date.now() + 43_200_000,
          idleExpiresAt: Date.now() + 3_600_000,
        },
      };
      return copy(identity);
    }),
    readEmailCodeIdentity: jest.fn(async (sid, tenant) =>
      identity?.grant.sessionId === sid && identity.grant.tenantId === tenant
        ? copy(identity)
        : null,
    ),
    rotateEmailCodeRefresh: jest.fn(async ({ grant, oldHash, newHash }) => {
      if (
        !identity ||
        refreshHash !== oldHash ||
        identity.grant.refreshGeneration !== grant.refreshGeneration
      ) {
        throw error('REFRESH_REPLACED');
      }
      refreshHash = newHash;
      identity.grant.refreshGeneration++;
    }),
    revokeEmailCodeSession: jest.fn(async () => {
      identity = undefined;
    }),
    revokeEmailCodeAccount: jest.fn(async () => {
      identity = undefined;
    }),
    touchEmailCodeSession: jest.fn(async () => undefined),
  };
  const sender = {
    sendCode: jest.fn(async ({ code }: { code: string }) => {
      sentCode = code;
      if (sendFails) throw new Error('private transport detail must not escape');
    }),
  };
  const clearAuxiliaryCookies = jest.fn();
  const auth = createEmailCodeAuth({
    repository,
    sender,
    clearAuxiliaryCookies,
    write: (action) => action(),
  });
  const app = express();
  app.use(express.json({ limit: '4kb' }));
  app.use((req, _res, next) => {
    req.cookies = parseCookies(req.headers.cookie ?? '');
    next();
  });
  app.post('/request', auth.requestCode);
  app.post('/verify', auth.verifyCode);
  app.post('/refresh', auth.refresh);
  app.post('/logout', auth.logout);
  return { app, repository, sender, clearAuxiliaryCookies, challenges, code: () => sentCode };
}

const cookies = (response: request.Response) => {
  const values = response.headers['set-cookie'] as unknown as string[] | undefined;
  return (values ?? []).map((value) => value.split(';')[0]).join('; ');
};

describe('email-code authentication composition', () => {
  const original = { ...process.env };
  beforeEach(() => {
    process.env.AUTH_MODE = 'transition';
    process.env.EMAIL_CODE_TENANT_ID = 'cortex-bwi';
    process.env.EMAIL_CODE_ALLOWED_DOMAINS = 'employees.example.test,partners.example.test';
    process.env.EMAIL_CODE_HMAC_KEY = 'test-only-separate-key-'.repeat(3);
    process.env.EMAIL_CODE_POLICY_VERSION = '1';
    process.env.EMAIL_CODE_ENABLED = 'true';
    process.env.JWT_SECRET = 'test-only-access-key';
    process.env.JWT_REFRESH_SECRET = 'test-only-refresh-key';
  });
  afterAll(() => {
    process.env = original;
  });

  it.each(['person@employees.example.test', 'person@partners.example.test'])(
    'binds %s to one tenant and consumes a code once',
    async (email) => {
      const f = fixture();
      const challenge = await request(f.app).post('/request').send({ email });
      expect(challenge.status).toBe(202);
      expect(f.code()).toMatch(/^\d{8}$/);
      expect(cookies(challenge)).toContain(EMAIL_ATTEMPT_COOKIE);
      const verify = () =>
        request(f.app)
          .post('/verify')
          .set('Cookie', cookies(challenge))
          .send({ attemptId: challenge.body.attemptId, code: f.code() });
      const results = await Promise.all([verify(), verify()]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
      const success = results.find((r) => r.status === 200)!;
      expect(success.body.user).toMatchObject({
        tenantId: 'cortex-bwi',
        role: 'USER',
        provider: 'email_code',
      });
      const payload = jwt.verify(success.body.token, process.env.JWT_SECRET!) as jwt.JwtPayload;
      expect(payload).toMatchObject({
        authMethod: 'email_code',
        tokenUse: 'access',
        tenantId: 'cortex-bwi',
        authVersion: 0,
        policyVersion: 1,
      });
      expect(payload.sessionId).toMatch(/^[a-f0-9]{24}$/);
      expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(300);
      expect(cookies(success)).toContain(AUTH_SELECTION_COOKIE);
      expect(await validateEmailCodeBearer(payload, f.repository)).not.toBeNull();
      await f.repository.revokeEmailCodeSession(payload.sessionId, payload.id, 'cortex-bwi');
      expect(await validateEmailCodeBearer(payload, f.repository)).toBeNull();
    },
  );

  it('denies suffix domains, client tenant grants and a code without its browser binding', async () => {
    const f = fixture();
    expect(
      (
        await request(f.app)
          .post('/request')
          .send({ email: 'person@employees.example.test.attacker.test' })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(f.app)
          .post('/request')
          .send({ email: 'person@employees.example.test', tenantId: 'another' })
      ).status,
    ).toBe(400);
    expect(f.sender.sendCode).not.toHaveBeenCalled();
    const challenge = await request(f.app)
      .post('/request')
      .send({ email: 'person@employees.example.test' });
    expect(
      (
        await request(f.app)
          .post('/verify')
          .send({ attemptId: challenge.body.attemptId, code: f.code() })
      ).status,
    ).toBe(400);
    expect(f.repository.redeemEmailCode).not.toHaveBeenCalled();
  });

  it('never activates a failed send or exposes the raw transport error', async () => {
    const f = fixture(true);
    const response = await request(f.app)
      .post('/request')
      .send({ email: 'person@employees.example.test' });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ code: 'EMAIL_CODE_UNAVAILABLE' });
    const attempt = [...f.challenges.values()][0];
    expect(attempt.accepted).toBe(false);
    expect(
      (
        await request(f.app)
          .post('/verify')
          .set('Cookie', cookies(response))
          .send({ attemptId: attempt._id, code: f.code() })
      ).status,
    ).toBe(400);
  });

  it('allows one refresh successor and never clears the winning cookie on conflict', async () => {
    const f = fixture();
    const challenge = await request(f.app)
      .post('/request')
      .send({ email: 'person@employees.example.test' });
    const login = await request(f.app)
      .post('/verify')
      .set('Cookie', cookies(challenge))
      .send({ attemptId: challenge.body.attemptId, code: f.code() });
    const refresh = () => request(f.app).post('/refresh').set('Cookie', cookies(login)).send({});
    const results = await Promise.all([refresh(), refresh()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(loser.body).toEqual({ code: 'REFRESH_REPLACED' });
    expect(loser.headers['set-cookie']).toBeUndefined();
  });

  it('rejects legacy bearer claims and rechecks policy/domain changes', async () => {
    const f = fixture();
    expect(
      await validateEmailCodeBearer({ id: '1'.repeat(24), provider: 'email_code' }, f.repository),
    ).toBeNull();
    const challenge = await request(f.app)
      .post('/request')
      .send({ email: 'person@partners.example.test' });
    process.env.EMAIL_CODE_ALLOWED_DOMAINS = 'employees.example.test';
    expect(
      (
        await request(f.app)
          .post('/verify')
          .set('Cookie', cookies(challenge))
          .send({ attemptId: challenge.body.attemptId, code: f.code() })
      ).status,
    ).toBe(400);
    expect(f.repository.redeemEmailCode).not.toHaveBeenCalled();
  });

  const refreshCredential = (overrides: Record<string, unknown> = {}) =>
    jwt.sign(
      {
        id: '1'.repeat(24),
        sessionId: '2'.repeat(24),
        tenantId: 'cortex-bwi',
        authMethod: 'email_code',
        tokenUse: 'refresh',
        authVersion: 0,
        policyVersion: 1,
        issuedAtMs: 1,
        generation: 0,
        jti: 'a'.repeat(43),
        exp: 1,
        ...overrides,
      },
      process.env.JWT_REFRESH_SECRET!,
      { algorithm: 'HS256' },
    );

  it('uses an expired signed refresh only for exact-session revocation, then clears credentials', async () => {
    const f = fixture();
    const credential = refreshCredential();
    expect(
      (await request(f.app).post('/refresh').set('Cookie', `refreshToken=${credential}`)).status,
    ).toBe(401);
    const response = await request(f.app)
      .post('/logout')
      .set('Cookie', `refreshToken=${credential}`);
    expect(response.status).toBe(200);
    expect(f.repository.revokeEmailCodeSession).toHaveBeenCalledWith(
      '2'.repeat(24),
      '1'.repeat(24),
      'cortex-bwi',
    );
    expect(f.repository.readEmailCodeIdentity).not.toHaveBeenCalled();
    expect(f.repository.rotateEmailCodeRefresh).not.toHaveBeenCalled();
    expect(f.clearAuxiliaryCookies).toHaveBeenCalledTimes(1);
    expect(cookies(response)).toContain('refreshToken=;');
    expect(cookies(response)).not.toContain(AUTH_SELECTION_COOKIE);
    expect(response.body.token).toBeUndefined();
  });

  it.each([{ tokenUse: 'access' }, { authMethod: 'browser' }, { tenantId: 'other-tenant' }])(
    'rejects a signed but ineligible logout credential %j',
    async (overrides) => {
      const f = fixture();
      const response = await request(f.app)
        .post('/logout')
        .set('Cookie', `refreshToken=${refreshCredential(overrides)}`);
      expect(response.status).toBe(401);
      expect(f.repository.revokeEmailCodeSession).not.toHaveBeenCalled();
      expect(response.headers['set-cookie']).toBeUndefined();
    },
  );

  it('rejects malformed and wrongly signed logout credentials without modifying cookies', async () => {
    const f = fixture();
    const foreign = jwt.sign(
      jwt.decode(refreshCredential()) as jwt.JwtPayload,
      'another-signing-key',
      { algorithm: 'HS256' },
    );
    for (const credential of ['malformed', foreign]) {
      const response = await request(f.app)
        .post('/logout')
        .set('Cookie', `refreshToken=${credential}`);
      expect(response.status).toBe(401);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(f.repository.revokeEmailCodeSession).not.toHaveBeenCalled();
  });

  it('does not clear credentials when logout revocation acknowledgement fails', async () => {
    const f = fixture();
    jest
      .mocked(f.repository.revokeEmailCodeSession)
      .mockRejectedValueOnce(new Error('private database error'));
    const response = await request(f.app)
      .post('/logout')
      .set('Cookie', `refreshToken=${refreshCredential()}`);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ code: 'EMAIL_CODE_UNAVAILABLE' });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(f.clearAuxiliaryCookies).not.toHaveBeenCalled();
  });

  it('advertises email login only with a configured sender, while injected adapters remain testable', () => {
    for (const key of ['PASSWORD', 'CA', 'USERNAME', 'FROM', 'TLS_SERVERNAME'])
      delete process.env[`EMAIL_CODE_SMTP_${key}`];
    expect(getEmailCodeConfig().emailCodeEnabled).toBe(false);
    expect(getEmailCodeConfig(true).emailCodeEnabled).toBe(true);
    process.env.AUTH_MODE = 'default';
    process.env.EMAIL_CODE_SMTP_PASSWORD = 'incomplete-but-unused';
    expect(getEmailCodeConfig().emailCodeEnabled).toBe(false);
  });

  it('keeps the email selection latch after credentials disappear', () => {
    let value = '';
    setAuthSelection(
      {
        cookie: (_name: string, cookie: string) => {
          value = cookie;
        },
      } as never,
      'email',
    );
    const req = { cookies: { [AUTH_SELECTION_COOKIE]: value } } as never;
    expect(getAuthSelection(req)).toBe('email');
    expect(mayRefreshGuest(req)).toBe(false);
    expect(mayRefreshGuest({ cookies: {} } as never)).toBe(true);
    process.env.AUTH_MODE = 'email_code';
    expect(mayRefreshGuest({ cookies: {} } as never)).toBe(false);
  });

  it('keeps the new issuer closed in default mode', async () => {
    process.env.AUTH_MODE = 'default';
    const f = fixture();
    expect(
      (await request(f.app).post('/request').send({ email: 'person@employees.example.test' }))
        .status,
    ).toBe(404);
    expect(f.sender.sendCode).not.toHaveBeenCalled();
  });
});
