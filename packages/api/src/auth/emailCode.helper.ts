/** Existing deterministic HTTP/crypto fixture shared by the authentication owner suite. */
import express from 'express';
import type {
  EmailCodeChallenge,
  EmailCodeIdentity,
  EmailCodeRepository,
} from '@librechat/data-schemas';
import type request from 'supertest';
import { createEmailCodeAuth } from './emailCode';

export const parseCookies: (value: string) => Record<string, string> =
  jest.requireActual('cookie').parse;
const error = (code: string) => Object.assign(new Error(code), { code });
const copy = <T>(value: T): T => structuredClone(value);

/** A deterministic port fixture proves HTTP/crypto composition, not Mongo transaction isolation. */
export function fixture(sendFails = false) {
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
    readEmailCodeIdentity: jest.fn(async (sid, tenant, currentRefresh) =>
      identity?.grant.sessionId === sid &&
      identity.grant.tenantId === tenant &&
      (!currentRefresh ||
        (currentRefresh.refreshTokenHash === refreshHash &&
          currentRefresh.refreshGeneration === identity.grant.refreshGeneration))
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

export const cookies = (response: request.Response) => {
  const values = response.headers['set-cookie'] as unknown as string[] | undefined;
  return (values ?? []).map((value) => value.split(';')[0]).join('; ');
};
