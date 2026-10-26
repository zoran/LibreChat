jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  ...jest.requireActual('../../../data-schemas/src/emailCodePolicy'),
}));
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  ...jest.requireActual('../../../data-provider/src/upload-intake'),
}));
import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { EmailCodeIdentity } from '@librechat/data-schemas';
import {
  EMAIL_CODE_IDLE_MS,
  EMAIL_CODE_ABSOLUTE_MS,
  EMAIL_CODE_ACCESS_MS,
  EMAIL_CODE_CHALLENGE_MS,
  EMAIL_ATTEMPT_COOKIE,
  AUTH_SELECTION_COOKIE,
  getAuthSelection,
  getEmailCodeConfig,
  mayRefreshGuest,
  setAuthSelection,
} from './authMode';
import {
  validateEmailCodeBearer,
  validateEmailCodeRefresh,
  createEmailCodeUploadGrant,
  validateEmailCodeUploadGrant,
} from './emailCode';

import { fixture, cookies, parseCookies } from './emailCode.helper';

describe('email-code authentication composition', () => {
  const original = { ...process.env };
  beforeEach(() => {
    delete process.env.EMAIL_CODE_HIDDEN_ALLOWED_DOMAINS;
    delete process.env.EMAIL_CODE_QUALIFICATION_MAILBOX;
    delete process.env.EMAIL_CODE_QUALIFICATION_NOT_AFTER;
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

  async function authenticated() {
    const f = fixture();
    const challenge = await request(f.app)
      .post('/request')
      .send({ email: 'person@employees.example.test' });
    const response = await request(f.app)
      .post('/verify')
      .set('Cookie', cookies(challenge))
      .send({ attemptId: challenge.body.attemptId, code: f.code() });
    expect(response.status).toBe(200);
    const payload = jwt.verify(response.body.token, process.env.JWT_SECRET!) as jwt.JwtPayload;
    return { ...f, response, payload, token: parseCookies(cookies(response)).refreshToken };
  }

  it('authenticates a permanently allowed hidden domain without advertising it or admitting suffixes', async () => {
    process.env.EMAIL_CODE_HIDDEN_ALLOWED_DOMAINS = 'private.example.test';
    const f = fixture();
    const pending = await request(f.app)
      .post('/request')
      .send({ email: 'person@private.example.test' });
    expect(pending.status).toBe(202);
    const publicConfig = getEmailCodeConfig(true);
    expect(publicConfig.emailCodeDomains).toEqual([
      'employees.example.test',
      'partners.example.test',
    ]);
    expect(JSON.stringify(publicConfig)).not.toContain('private.example.test');
    const verified = await request(f.app)
      .post('/verify')
      .set('Cookie', cookies(pending))
      .send({ attemptId: pending.body.attemptId, code: f.code() });
    expect(verified.status).toBe(200);
    expect((await request(f.app).post('/refresh').set('Cookie', cookies(verified))).status).toBe(
      200,
    );
    expect(
      (
        await request(f.app)
          .post('/request')
          .send({ email: 'person@private.example.test.attacker.test' })
      ).status,
    ).not.toBe(202);
    process.env.EMAIL_CODE_HIDDEN_ALLOWED_DOMAINS = '*.private.example.test';
    expect(getEmailCodeConfig(true).emailCodeEnabled).toBe(false);
    expect(
      (await request(f.app).post('/refresh').set('Cookie', cookies(verified))).status,
    ).not.toBe(200);
  });

  describe('finite exact qualification mailbox', () => {
    const email = 'qualification@outside.example.test';
    function exception() {
      const until = Math.floor(Date.now() / 1000) + 120;
      process.env.EMAIL_CODE_QUALIFICATION_MAILBOX = email;
      process.env.EMAIL_CODE_QUALIFICATION_NOT_AFTER = String(until);
      return until * 1000;
    }
    async function challenge(f: ReturnType<typeof fixture>) {
      const reply = await request(f.app).post('/request').send({ email });
      expect(reply.status).toBe(202);
      return reply;
    }
    it('admits only the exact mailbox, keeps public domains unchanged and rejects after expiry', async () => {
      const expiry = exception();
      const f = fixture();
      expect(
        (await request(f.app).post('/request').send({ email: 'other@outside.example.test' }))
          .status,
      ).not.toBe(202);
      const pending = await challenge(f);
      expect(getEmailCodeConfig(true).emailCodeDomains).toEqual([
        'employees.example.test',
        'partners.example.test',
      ]);
      const verified = await request(f.app)
        .post('/verify')
        .set('Cookie', cookies(pending))
        .send({ attemptId: pending.body.attemptId, code: f.code() });
      expect(verified.status).toBe(200);
      jest.spyOn(Date, 'now').mockReturnValue(expiry);
      expect(
        (await request(f.app).post('/refresh').set('Cookie', cookies(verified))).status,
      ).not.toBe(200);
      expect((await request(f.app).post('/logout').set('Cookie', cookies(verified))).status).toBe(
        200,
      );
      expect(f.repository.revokeEmailCodeSession).toHaveBeenCalledTimes(1);
    });
    it('does not issue credentials when redemption crosses the expiry boundary', async () => {
      const expiry = exception();
      const f = fixture();
      const pending = await challenge(f);
      const redeem = jest.mocked(f.repository.redeemEmailCode);
      const original = redeem.getMockImplementation()!;
      let redeemed: EmailCodeIdentity | undefined;
      redeem.mockImplementation(async (input) => {
        const value = await original(input);
        redeemed = value;
        jest.spyOn(Date, 'now').mockReturnValue(expiry);
        return value;
      });
      const reply = await request(f.app)
        .post('/verify')
        .set('Cookie', cookies(pending))
        .send({ attemptId: pending.body.attemptId, code: f.code() });
      expect(redeem).toHaveBeenCalledTimes(1);
      expect(redeemed).toBeDefined();
      expect(f.challenges.get(pending.body.attemptId)?.consumedAt).toEqual(expect.any(Date));
      expect(Date.now()).toBe(expiry);
      expect(f.repository.revokeEmailCodeSession).toHaveBeenCalledWith(
        redeemed!.grant.sessionId,
        redeemed!.grant.userId,
        redeemed!.grant.tenantId,
      );
      expect(reply.status).toBe(401);
      expect(reply.body).toEqual({ code: 'AUTH_SESSION_REQUIRED' });
      expect(reply.body.token).toBeUndefined();
      expect(cookies(reply)).not.toContain('refreshToken=');
    });
    it('does not issue credentials when refresh persistence crosses the expiry boundary', async () => {
      const expiry = exception();
      const f = fixture();
      const pending = await challenge(f);
      const verified = await request(f.app)
        .post('/verify')
        .set('Cookie', cookies(pending))
        .send({ attemptId: pending.body.attemptId, code: f.code() });
      expect(verified.status).toBe(200);
      const rotate = jest.mocked(f.repository.rotateEmailCodeRefresh);
      const original = rotate.getMockImplementation()!;
      let persisted = false;
      rotate.mockImplementation(async (input) => {
        await original(input);
        persisted = true;
        jest.spyOn(Date, 'now').mockReturnValue(expiry);
      });
      const reply = await request(f.app).post('/refresh').set('Cookie', cookies(verified));
      expect(rotate).toHaveBeenCalledTimes(1);
      expect(persisted).toBe(true);
      expect(Date.now()).toBe(expiry);
      const [{ grant }] = rotate.mock.calls[0];
      const current = await f.repository.readEmailCodeIdentity(grant.sessionId, grant.tenantId);
      expect(current?.grant.refreshGeneration).toBe(grant.refreshGeneration + 1);
      expect(reply.status).toBe(401);
      expect(reply.body).toEqual({ code: 'AUTH_SESSION_REQUIRED' });
      expect(reply.body.token).toBeUndefined();
      expect(cookies(reply)).not.toContain('refreshToken=');
      expect((await request(f.app).post('/logout').set('Cookie', cookies(verified))).status).toBe(
        200,
      );
    });
  });

  describe('private native upload grants', () => {
    it('keeps only private identity bounds, survives normal refresh and follows native logout', async () => {
      const f = await authenticated();
      const grant = await createEmailCodeUploadGrant(f.payload, f.repository);
      expect(grant).toEqual({
        version: 1,
        principal: {
          tenantId: 'cortex-bwi',
          userId: '1'.repeat(24),
          authentication: 'verified-email',
        },
        sessionId: f.payload.sessionId,
        authVersion: 0,
        policyVersion: 1,
        expiresAt: new Date(f.payload.exp! * 1000).toISOString(),
      });
      expect(await validateEmailCodeUploadGrant(grant, f.repository)).not.toBeNull();
      expect(f.repository.touchEmailCodeSession).not.toHaveBeenCalled();
      expect(f.repository.rotateEmailCodeRefresh).not.toHaveBeenCalled();
      expect(
        (await request(f.app).post('/refresh').set('Cookie', cookies(f.response))).status,
      ).toBe(200);
      expect(await validateEmailCodeBearer(f.payload, f.repository)).not.toBeNull();
      expect(await validateEmailCodeUploadGrant(grant, f.repository)).not.toBeNull();
      expect((await request(f.app).post('/logout').set('Cookie', cookies(f.response))).status).toBe(
        200,
      );
      expect(await validateEmailCodeUploadGrant(grant, f.repository)).toBeNull();
      expect(await createEmailCodeUploadGrant(f.payload, f.repository)).toBeNull();
    });

    it('caps issuance at twelve minutes, original access expiry and both current session deadlines', async () => {
      const f = await authenticated();
      const now = Math.floor(Date.now() / 1000) * 1000;
      const identity = (await validateEmailCodeBearer(f.payload, f.repository))!;
      for (const [access, idle, absolute, expected] of [
        [30, 30, 30, 12],
        [3, 30, 30, 3],
        [30, 2, 30, 2],
        [30, 30, 1, 1],
      ]) {
        jest.mocked(f.repository.readEmailCodeIdentity).mockResolvedValueOnce({
          ...identity,
          grant: {
            ...identity.grant,
            idleExpiresAt: now + idle * 60000,
            absoluteExpiresAt: now + absolute * 60000,
          },
        });
        const grant = await createEmailCodeUploadGrant(
          { ...f.payload, exp: now / 1000 + access * 60 },
          f.repository,
          now,
        );
        expect(grant?.expiresAt).toBe(new Date(now + expected * 60000).toISOString());
      }
      const grant = await createEmailCodeUploadGrant(f.payload, f.repository, now);
      expect(
        await validateEmailCodeUploadGrant(grant, f.repository, Date.parse(grant!.expiresAt)),
      ).toBeNull();
      for (const key of ['idleExpiresAt', 'absoluteExpiresAt'] as const) {
        const expired = { ...identity, grant: { ...identity.grant, [key]: now } };
        jest.mocked(f.repository.readEmailCodeIdentity).mockResolvedValueOnce(expired);
        expect(await validateEmailCodeUploadGrant(grant, f.repository, now)).toBeNull();
        jest.mocked(f.repository.readEmailCodeIdentity).mockResolvedValueOnce(expired);
        expect(await createEmailCodeUploadGrant(f.payload, f.repository, now)).toBeNull();
      }
    });

    it('rejects guests, refresh claims, invalid clocks and missing or expired access bounds', async () => {
      const f = await authenticated();
      for (const change of [
        { authMethod: 'browser', provider: 'browser' },
        { tokenUse: 'refresh' },
        { exp: undefined },
        { exp: NaN },
        { exp: Infinity },
        { exp: 1 },
        { tenantId: 'other' },
        { id: '2'.repeat(24) },
        { sessionId: '2'.repeat(24) },
      ])
        expect(
          await createEmailCodeUploadGrant({ ...f.payload, ...change }, f.repository),
        ).toBeNull();
      const grant = await createEmailCodeUploadGrant(f.payload, f.repository);
      for (const now of [NaN, Infinity, -1]) {
        expect(await createEmailCodeUploadGrant(f.payload, f.repository, now)).toBeNull();
        expect(await validateEmailCodeUploadGrant(grant, f.repository, now)).toBeNull();
      }
      process.env.AUTH_MODE = 'default';
      expect(await createEmailCodeUploadGrant(f.payload, f.repository)).toBeNull();
      expect(await validateEmailCodeUploadGrant(grant, f.repository)).toBeNull();
    });

    it('reuses live policy, domain, auth-version and disabled-account decisions without masking DB errors', async () => {
      const f = await authenticated();
      const grant = await createEmailCodeUploadGrant(f.payload, f.repository);
      const identity = (await validateEmailCodeBearer(f.payload, f.repository))!;
      for (const key of ['authVersion', 'policyVersion'] as const) {
        jest.mocked(f.repository.readEmailCodeIdentity).mockResolvedValueOnce({
          ...identity,
          grant: { ...identity.grant, [key]: identity.grant[key] + 1 },
        });
        expect(await validateEmailCodeUploadGrant(grant, f.repository)).toBeNull();
      }
      process.env.EMAIL_CODE_POLICY_VERSION = '2';
      expect(await validateEmailCodeUploadGrant(grant, f.repository)).toBeNull();
      process.env.EMAIL_CODE_POLICY_VERSION = '1';
      process.env.EMAIL_CODE_ALLOWED_DOMAINS = 'other.example.test';
      expect(await validateEmailCodeUploadGrant(grant, f.repository)).toBeNull();
      process.env.EMAIL_CODE_ALLOWED_DOMAINS = 'employees.example.test';
      // The native repository returns null for disabled accounts; do not duplicate that owner.
      jest.mocked(f.repository.readEmailCodeIdentity).mockResolvedValueOnce(null);
      expect(await validateEmailCodeUploadGrant(grant, f.repository)).toBeNull();
      jest
        .mocked(f.repository.readEmailCodeIdentity)
        .mockRejectedValueOnce(new Error('DB unavailable'));
      await expect(validateEmailCodeUploadGrant(grant, f.repository)).rejects.toThrow(
        'DB unavailable',
      );
    });

    it('rejects hostile references before DB access and snapshots identity before awaiting it', async () => {
      const f = await authenticated();
      const grant = (await createEmailCodeUploadGrant(f.payload, f.repository))!;
      const identity = (await validateEmailCodeBearer(f.payload, f.repository))!;
      const read = jest.mocked(f.repository.readEmailCodeIdentity);
      read.mockClear();
      const getter = jest.fn(() => grant.principal);
      const hostile = Object.defineProperty({ ...grant }, 'principal', { get: getter });
      expect(await validateEmailCodeUploadGrant(hostile, f.repository)).toBeNull();
      expect(getter).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      let finish!: (value: EmailCodeIdentity) => void;
      read.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = validateEmailCodeUploadGrant(grant, f.repository);
      grant.principal.userId = '2'.repeat(24);
      grant.expiresAt = new Date(0).toISOString();
      finish(identity);
      expect(await pending).toEqual(identity);
      read.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const issued = createEmailCodeUploadGrant(f.payload, f.repository);
      f.payload.id = '2'.repeat(24);
      finish(identity);
      expect((await issued)?.principal.userId).toBe(identity.grant.userId);
    });
  });

  describe('read-only current refresh authority', () => {
    it('reads the current nonce and generation without rotation or idle extension', async () => {
      const f = await authenticated();
      const before = await validateEmailCodeRefresh(f.token, f.repository);
      expect(before?.user.provider).toBe('email_code');
      expect(await validateEmailCodeRefresh(f.token, f.repository)).toEqual(before);
      expect(f.repository.rotateEmailCodeRefresh).not.toHaveBeenCalled();
      expect(f.repository.touchEmailCodeSession).not.toHaveBeenCalled();
      expect(f.repository.revokeEmailCodeSession).not.toHaveBeenCalled();
      const refreshed = await request(f.app).post('/refresh').set('Cookie', cookies(f.response));
      expect(refreshed.status).toBe(200);
      expect(await validateEmailCodeRefresh(f.token, f.repository)).toBeNull();
      expect(
        (
          await validateEmailCodeRefresh(
            parseCookies(cookies(refreshed)).refreshToken,
            f.repository,
          )
        )?.grant,
      ).toMatchObject({
        refreshGeneration: 1,
        idleExpiresAt: before!.grant.idleExpiresAt,
        absoluteExpiresAt: before!.grant.absoluteExpiresAt,
      });
      // The replaced credential still has exact-session logout authority, never image authority.
      expect((await request(f.app).post('/logout').set('Cookie', cookies(f.response))).status).toBe(
        200,
      );
      expect(
        await validateEmailCodeRefresh(parseCookies(cookies(refreshed)).refreshToken, f.repository),
      ).toBeNull();
    });

    it('rejects signed but ineligible credentials and never treats database failure as absence', async () => {
      const f = await authenticated();
      const payload = jwt.decode(f.token) as jwt.JwtPayload;
      const invalidClaims = [
        { tokenUse: 'access' },
        { authMethod: 'browser' },
        { jti: 'malformed' },
        { generation: -1 },
        { tenantId: 'another-tenant' },
        { policyVersion: 2 },
        { authVersion: 2 },
        { id: '2'.repeat(24) },
        { sessionId: '2'.repeat(24) },
        { exp: 1 },
        { exp: undefined },
      ];
      for (const changes of invalidClaims) {
        const changed = { ...payload, ...changes };
        if (changed.exp === undefined) delete changed.exp;
        const token = jwt.sign(changed, process.env.JWT_REFRESH_SECRET!, { algorithm: 'HS256' });
        expect(await validateEmailCodeRefresh(token, f.repository)).toBeNull();
      }
      for (const token of [
        undefined,
        '',
        {},
        'openid-refresh',
        f.response.body.token,
        jwt.sign({ id: payload.id }, process.env.JWT_REFRESH_SECRET!, { expiresIn: '1h' }),
        jwt.sign(payload, 'wrong-secret'),
        jwt.sign(payload, process.env.JWT_REFRESH_SECRET!, { algorithm: 'HS384' }),
      ]) {
        expect(await validateEmailCodeRefresh(token, f.repository)).toBeNull();
      }
      process.env.EMAIL_CODE_ALLOWED_DOMAINS = 'other.example.test';
      expect(await validateEmailCodeRefresh(f.token, f.repository)).toBeNull();
      process.env.EMAIL_CODE_ALLOWED_DOMAINS = 'employees.example.test';
      process.env.EMAIL_CODE_ENABLED = 'false';
      expect(await validateEmailCodeRefresh(f.token, f.repository)).not.toBeNull();
      process.env.AUTH_MODE = 'default';
      expect(await validateEmailCodeRefresh(f.token, f.repository)).toBeNull();
      process.env.AUTH_MODE = 'email_code';
      (f.repository.readEmailCodeIdentity as jest.Mock).mockRejectedValueOnce(
        new Error('database unavailable'),
      );
      await expect(validateEmailCodeRefresh(f.token, f.repository)).rejects.toThrow(
        'database unavailable',
      );
      (f.repository.readEmailCodeIdentity as jest.Mock).mockResolvedValueOnce(null);
      expect(await validateEmailCodeRefresh(f.token, f.repository)).toBeNull();
    });
  });

  it('exports the shared90/270 policy while access/challenge stay short', () => {
    expect([EMAIL_CODE_IDLE_MS, EMAIL_CODE_ABSOLUTE_MS]).toEqual([90 * 86400000, 270 * 86400000]);
    expect([EMAIL_CODE_ACCESS_MS, EMAIL_CODE_CHALLENGE_MS]).toEqual([300000, 600000]);
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

  it.each(['existing', 'stale', 'absent'])(
    'redeems a fresh mailbox link from a different browser with an %s session',
    async (session) => {
      const existing = session === 'existing' ? await authenticated() : undefined;
      const f = existing ?? fixture();
      const pending = await request(f.app)
        .post('/request')
        .send({ email: 'person@employees.example.test' });
      const sent = f.sender.sendCode.mock.calls[f.sender.sendCode.mock.calls.length - 1]![0];
      expect(sent.linkProof).toMatch(/^[a-f0-9]{64}$/);
      expect(pending.body.linkProof).toBeUndefined();
      const verify = request(f.app).post('/verify');
      if (existing) verify.set('Cookie', cookies(existing.response));
      if (session === 'stale') verify.set('Cookie', 'refreshToken=expired-session');
      const result = await verify.send({
        attemptId: pending.body.attemptId,
        code: sent.code,
        linkProof: sent.linkProof,
      });
      expect(result.status).toBe(200);
      expect(result.body.user.email).toBe(sent.email);
      expect(parseCookies(cookies(result)).refreshToken).toBeTruthy();
      expect(f.repository.redeemEmailCode).toHaveBeenLastCalledWith(
        expect.objectContaining({ nonceHash: f.challenges.get(pending.body.attemptId)!.nonceHash }),
      );
      const replay = await request(f.app).post('/verify').set('Cookie', cookies(result)).send({
        attemptId: pending.body.attemptId,
        code: sent.code,
        linkProof: sent.linkProof,
      });
      expect(replay.status).toBe(400);
      expect(replay.headers['set-cookie']).toBeUndefined();
    },
  );

  it('rejects another MAC purpose and preserves the current login after failed link proof', async () => {
    const f = await authenticated();
    const pending = await request(f.app)
      .post('/request')
      .send({ email: 'person@employees.example.test' });
    const challenge = f.challenges.get(pending.body.attemptId)!;
    const failed = await request(f.app).post('/verify').set('Cookie', cookies(f.response)).send({
      attemptId: challenge._id,
      code: f.code(),
      linkProof: challenge.verifier,
    });
    expect(failed.status).toBe(400);
    expect(failed.headers['set-cookie']).toBeUndefined();
    expect(challenge.consumedAt).toBeUndefined();
    const refreshed = await request(f.app).post('/refresh').set('Cookie', cookies(f.response));
    expect(refreshed.status).toBe(200);
  });

  it('rejects an expired link without publishing credentials', async () => {
    const f = fixture();
    const pending = await request(f.app)
      .post('/request')
      .send({ email: 'person@employees.example.test' });
    const sent = f.sender.sendCode.mock.calls[0][0];
    f.challenges.get(pending.body.attemptId)!.expiresAt = new Date(0);
    const result = await request(f.app).post('/verify').send({
      attemptId: pending.body.attemptId,
      code: sent.code,
      linkProof: sent.linkProof,
    });
    expect(result.status).toBe(400);
    expect(result.headers['set-cookie']).toBeUndefined();
  });

  it('binds a link to its code, recipient and current resend generation', async () => {
    const f = fixture();
    const pending = await request(f.app)
      .post('/request')
      .send({ email: 'person@employees.example.test' });
    const first = f.sender.sendCode.mock.calls[0][0];
    const wrongCode = first.code === '00000000' ? '11111111' : '00000000';
    expect(
      (
        await request(f.app).post('/verify').send({
          attemptId: pending.body.attemptId,
          code: wrongCode,
          linkProof: first.linkProof,
        })
      ).status,
    ).toBe(400);
    const challenge = f.challenges.get(pending.body.attemptId)!;
    challenge.email = 'another@employees.example.test';
    expect(
      (
        await request(f.app).post('/verify').send({
          attemptId: pending.body.attemptId,
          code: first.code,
          linkProof: first.linkProof,
        })
      ).status,
    ).toBe(400);
    challenge.email = first.email;
    challenge.resendAt = new Date(0);
    const resend = await request(f.app).post('/request').set('Cookie', cookies(pending)).send({
      email: first.email,
      attemptId: pending.body.attemptId,
    });
    expect(resend.status).toBe(202);
    const next = f.sender.sendCode.mock.calls[f.sender.sendCode.mock.calls.length - 1]![0];
    expect(next.linkProof).not.toBe(first.linkProof);
    expect(
      (
        await request(f.app).post('/verify').send({
          attemptId: pending.body.attemptId,
          code: first.code,
          linkProof: first.linkProof,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(f.app).post('/verify').send({
          attemptId: pending.body.attemptId,
          code: next.code,
          linkProof: next.linkProof,
        })
      ).status,
    ).toBe(200);
  });

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
