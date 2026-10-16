import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';
import type {
  EmailCodeIdentity,
  EmailCodeChallenge,
  EmailCodeRepository,
  EmailCodeGrant,
} from '@librechat/data-schemas';
import type { Request, Response, RequestHandler } from 'express';
import type { EmailCodeDependencies } from './emailCode.types';
import {
  getAuthMode,
  getEmailCodeConfig,
  getEmailCodeSettings,
  setAuthSelection,
  EMAIL_ATTEMPT_COOKIE,
  EMAIL_CODE_COOKIE_OPTIONS,
  EMAIL_CODE_ACCESS_MS,
  EMAIL_CODE_CHALLENGE_MS,
} from './authMode';

const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
const requestSchema = z
  .object({
    email: z
      .string()
      .trim()
      .max(254)
      .email()
      .transform((email) => email.toLowerCase()),
    attemptId: z.string().regex(OPAQUE).optional(),
  })
  .strict();
const verifySchema = z
  .object({ attemptId: z.string().regex(OPAQUE), code: z.string().regex(/^\d{8}$/) })
  .strict();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const mac = (purpose: string, ...values: unknown[]) =>
  createHmac('sha256', getEmailCodeSettings().secret)
    .update(JSON.stringify([purpose, ...values]))
    .digest('hex');
const verifier = (
  c: Pick<EmailCodeChallenge, '_id' | 'tenantId' | 'email' | 'nonceHash' | 'generation'>,
  code: string,
) => mac('email-code:v1', c.tenantId, c.email, c._id, c.nonceHash, c.generation, code);

interface GrantClaims extends jwt.JwtPayload {
  id: string;
  sessionId: string;
  tenantId: string;
  authMethod: 'email_code';
  authVersion: number;
  policyVersion: number;
  issuedAtMs: number;
  tokenUse: 'access' | 'refresh';
  generation: number;
  jti?: string;
}

function claims(value: unknown, use: 'access' | 'refresh'): value is GrantClaims {
  if (!value || typeof value !== 'object') return false;
  const c = value as GrantClaims;
  return (
    c.authMethod === 'email_code' &&
    c.tokenUse === use &&
    typeof c.id === 'string' &&
    /^[a-f0-9]{24}$/.test(c.id) &&
    typeof c.sessionId === 'string' &&
    /^[a-f0-9]{24}$/.test(c.sessionId) &&
    typeof c.tenantId === 'string' &&
    Number.isSafeInteger(c.authVersion) &&
    Number.isSafeInteger(c.policyVersion) &&
    Number.isSafeInteger(c.generation) &&
    Number.isFinite(c.issuedAtMs) &&
    (use !== 'refresh' || (typeof c.jti === 'string' && OPAQUE.test(c.jti)))
  );
}

function matches(c: GrantClaims, grant: EmailCodeGrant): boolean {
  const settings = getEmailCodeSettings();
  return (
    settings.configured &&
    c.tenantId === settings.tenantId &&
    c.policyVersion === settings.policyVersion &&
    c.id === grant.userId &&
    c.sessionId === grant.sessionId &&
    c.tenantId === grant.tenantId &&
    c.authVersion === grant.authVersion &&
    c.policyVersion === grant.policyVersion
  );
}
const eligible = (identity: EmailCodeIdentity) =>
  getEmailCodeSettings().domains.includes(
    identity.user.email.slice(identity.user.email.lastIndexOf('@') + 1).toLowerCase(),
  );

/** Passport already verified the signature; this adds current durable grant/account authority. */
export async function validateEmailCodeBearer(
  payload: unknown,
  repository: EmailCodeRepository,
): Promise<EmailCodeIdentity | null> {
  if (getAuthMode() === 'default' || !claims(payload, 'access')) return null;
  const configuredTenant = getEmailCodeSettings().tenantId;
  if (payload.tenantId !== configuredTenant) return null;
  const identity = await repository.readEmailCodeIdentity(payload.sessionId, configuredTenant);
  return identity && eligible(identity) && matches(payload, identity.grant) ? identity : null;
}

function issueTokens(identity: EmailCodeIdentity, refreshNonce: string) {
  const { grant } = identity;
  const now = Date.now();
  const common = {
    id: grant.userId,
    sessionId: grant.sessionId,
    tenantId: grant.tenantId,
    authMethod: 'email_code' as const,
    authVersion: grant.authVersion,
    policyVersion: grant.policyVersion,
    generation: grant.refreshGeneration,
    issuedAtMs: now,
  };
  if (!process.env.JWT_SECRET || !process.env.JWT_REFRESH_SECRET)
    throw new Error('Signing unavailable');
  const remaining = Math.floor(
    (Math.min(grant.absoluteExpiresAt, grant.idleExpiresAt) - now) / 1000,
  );
  if (remaining <= 0)
    throw Object.assign(new Error('AUTH_SESSION_REQUIRED'), { code: 'AUTH_SESSION_REQUIRED' });
  return {
    token: jwt.sign(
      { ...common, tokenUse: 'access', provider: 'email_code' },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: Math.min(EMAIL_CODE_ACCESS_MS / 1000, remaining) },
    ),
    refreshToken: jwt.sign(
      { ...common, tokenUse: 'refresh', jti: refreshNonce },
      process.env.JWT_REFRESH_SECRET,
      { algorithm: 'HS256', expiresIn: Math.floor((grant.absoluteExpiresAt - now) / 1000) },
    ),
  };
}

function writeCredentials(
  res: Response,
  identity: EmailCodeIdentity,
  tokens: ReturnType<typeof issueTokens>,
) {
  res.cookie('refreshToken', tokens.refreshToken, {
    ...EMAIL_CODE_COOKIE_OPTIONS,
    expires: new Date(identity.grant.absoluteExpiresAt),
  });
  res.cookie('token_provider', 'librechat', {
    ...EMAIL_CODE_COOKIE_OPTIONS,
    expires: new Date(identity.grant.absoluteExpiresAt),
  });
  setAuthSelection(res, 'email');
  return res.set('Cache-Control', 'no-store').json({ token: tokens.token, user: identity.user });
}

const safeCodes: Record<string, number> = {
  EMAIL_CODE_INVALID: 400,
  EMAIL_CODE_INVALID_REQUEST: 400,
  EMAIL_CODE_DOMAIN_NOT_ALLOWED: 400,
  EMAIL_CODE_THROTTLED: 429,
  EMAIL_CODE_ACCOUNT_CONFLICT: 403,
  AUTH_SESSION_REQUIRED: 401,
  REFRESH_REPLACED: 409,
  AUTH_MODE_DISABLED: 404,
};
function failure(res: Response, error: unknown) {
  const candidate = (error as { code?: string })?.code;
  const code =
    candidate && Object.prototype.hasOwnProperty.call(safeCodes, candidate)
      ? candidate
      : 'EMAIL_CODE_UNAVAILABLE';
  if (code === 'EMAIL_CODE_THROTTLED') res.set('Retry-After', '60');
  return res
    .set('Cache-Control', 'no-store')
    .status(safeCodes[code] ?? 503)
    .json({ code });
}
function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}

/** Routes supply same-origin admission and auth-maintenance ownership before entering this port. */
export function createEmailCodeAuth(deps: EmailCodeDependencies): {
  requestCode: RequestHandler;
  verifyCode: RequestHandler;
  refresh: RequestHandler;
  logout: RequestHandler;
  revokeCurrentRefresh(req: Request): Promise<void>;
} {
  const repo = deps.repository;
  const own =
    (action: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
    (req, res) =>
      action(req, res)
        .then(() => undefined)
        .catch((error) => {
          failure(res, error);
        });

  async function admit(req: Request) {
    if (getAuthMode() === 'default') fail('AUTH_MODE_DISABLED');
    const size = Buffer.byteLength(JSON.stringify(req.body ?? {}));
    if (size > 4096 || !req.is('application/json')) fail('EMAIL_CODE_INVALID_REQUEST');
    const settings = getEmailCodeSettings();
    if (!settings.configured) fail('EMAIL_CODE_UNAVAILABLE');
    await deps.write(() =>
      repo.consumeEmailCodeNetwork(mac('network:v1', req.ip ?? 'unknown'), new Date()),
    );
  }

  const requestCode = own(async (req, res) => {
    await admit(req);
    if (!getEmailCodeConfig(Boolean(deps.sender)).emailCodeEnabled || !deps.sender)
      fail('EMAIL_CODE_UNAVAILABLE');
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) fail('EMAIL_CODE_INVALID_REQUEST');
    const { email, attemptId } = parsed.data;
    const settings = getEmailCodeSettings();
    if (!settings.domains.includes(email.slice(email.lastIndexOf('@') + 1)))
      fail('EMAIL_CODE_DOMAIN_NOT_ALLOWED');
    const cookie = req.cookies?.[EMAIL_ATTEMPT_COOKIE];
    const nonce =
      typeof cookie === 'string' && OPAQUE.test(cookie)
        ? cookie
        : randomBytes(32).toString('base64url');
    const previous = attemptId
      ? await repo.getEmailCodeChallenge(attemptId, settings.tenantId)
      : null;
    if (attemptId && (!previous || previous.nonceHash !== hash(nonce) || previous.email !== email))
      fail('EMAIL_CODE_INVALID');
    const now = new Date();
    const code = randomInt(0, 100_000_000).toString().padStart(8, '0');
    const challenge: EmailCodeChallenge = {
      _id: attemptId ?? randomBytes(32).toString('base64url'),
      tenantId: settings.tenantId,
      email,
      mailboxKey: mac('mailbox:v1', settings.tenantId, email),
      nonceHash: hash(nonce),
      generation: (previous?.generation ?? -1) + 1,
      verifier: '',
      expiresAt: new Date(now.getTime() + EMAIL_CODE_CHALLENGE_MS),
      resendAt: new Date(now.getTime() + 60_000),
      accepted: false,
      failures: 0,
    };
    challenge.verifier = verifier(challenge, code);
    await deps.write(() =>
      repo.reserveEmailCodeAttempt({ challenge, previousGeneration: previous?.generation, now }),
    );
    // Set binding even on a transport failure, allowing a bounded resend of this browser attempt.
    res.cookie(EMAIL_ATTEMPT_COOKIE, nonce, {
      ...EMAIL_CODE_COOKIE_OPTIONS,
      maxAge: EMAIL_CODE_CHALLENGE_MS,
    });
    let accepted = false;
    try {
      await deps.write(() =>
        deps.sender!.sendCode({
          email,
          code,
          attemptId: challenge._id,
          expiresInMinutes: 10,
          locale: req.acceptsLanguages('de', 'en') === 'en' ? 'en' : 'de',
        }),
      );
      accepted = true;
    } finally {
      await deps.write(() =>
        repo.finishEmailCodeSend(challenge._id, challenge.generation, accepted),
      );
    }
    return res.set('Cache-Control', 'no-store').status(202).json({
      attemptId: challenge._id,
      expiresAt: challenge.expiresAt.toISOString(),
      resendAt: challenge.resendAt.toISOString(),
    });
  });

  const verifyCode = own(async (req, res) => {
    await admit(req);
    if (!getEmailCodeConfig(Boolean(deps.sender)).emailCodeEnabled) fail('EMAIL_CODE_UNAVAILABLE');
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) fail('EMAIL_CODE_INVALID');
    const nonce = req.cookies?.[EMAIL_ATTEMPT_COOKIE];
    if (typeof nonce !== 'string' || !OPAQUE.test(nonce)) fail('EMAIL_CODE_INVALID');
    const settings = getEmailCodeSettings();
    const challenge = await repo.getEmailCodeChallenge(parsed.data.attemptId, settings.tenantId);
    if (!challenge) fail('EMAIL_CODE_INVALID');
    if (!settings.domains.includes(challenge.email.slice(challenge.email.lastIndexOf('@') + 1)))
      fail('EMAIL_CODE_INVALID');
    const refreshNonce = randomBytes(32).toString('base64url');
    const balance = await deps.getBalance?.();
    const identity = await deps.write(() =>
      repo.redeemEmailCode({
        attemptId: challenge._id,
        tenantId: settings.tenantId,
        nonceHash: hash(nonce),
        generation: challenge.generation,
        verifier: verifier(challenge, parsed.data.code),
        refreshTokenHash: hash(refreshNonce),
        sessionId: randomBytes(12).toString('hex'),
        policyVersion: settings.policyVersion,
        now: new Date(),
        balance,
      }),
    );
    // A revoke racing issuance must not be published as a successful, resurrected session.
    const current = await repo.readEmailCodeIdentity(identity.grant.sessionId, settings.tenantId);
    if (!current) fail('AUTH_SESSION_REQUIRED');
    return writeCredentials(res, current, issueTokens(current, refreshNonce));
  });

  function signedRefresh(req: Request, ignoreExpiration = false): GrantClaims {
    const token = req.cookies?.refreshToken;
    if (typeof token !== 'string' || !process.env.JWT_REFRESH_SECRET) fail('AUTH_SESSION_REQUIRED');
    let payload: unknown;
    try {
      payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET, {
        algorithms: ['HS256'],
        ignoreExpiration,
      });
    } catch {
      fail('AUTH_SESSION_REQUIRED');
    }
    if (!claims(payload, 'refresh') || payload.tenantId !== getEmailCodeSettings().tenantId)
      fail('AUTH_SESSION_REQUIRED');
    return payload;
  }

  async function readRefresh(
    req: Request,
  ): Promise<{ payload: GrantClaims; identity: EmailCodeIdentity }> {
    const payload = signedRefresh(req);
    const identity = await repo.readEmailCodeIdentity(payload.sessionId, payload.tenantId);
    if (!identity || !eligible(identity) || !matches(payload, identity.grant))
      fail('AUTH_SESSION_REQUIRED');
    return { payload, identity };
  }

  const refresh = own(async (req, res) => {
    if (getAuthMode() === 'default') fail('AUTH_MODE_DISABLED');
    const { payload, identity } = await readRefresh(req);
    if (payload.generation !== identity.grant.refreshGeneration) fail('REFRESH_REPLACED');
    const refreshNonce = randomBytes(32).toString('base64url');
    await deps.write(() =>
      repo.rotateEmailCodeRefresh({
        grant: identity.grant,
        oldHash: hash(payload.jti!),
        newHash: hash(refreshNonce),
        now: new Date(),
      }),
    );
    const current = await repo.readEmailCodeIdentity(
      identity.grant.sessionId,
      identity.grant.tenantId,
    );
    if (!current) fail('AUTH_SESSION_REQUIRED');
    if (current.grant.refreshGeneration !== identity.grant.refreshGeneration + 1)
      fail('REFRESH_REPLACED');
    return writeCredentials(res, current, issueTokens(current, refreshNonce));
  });

  async function revokeSignedRefresh(req: Request): Promise<GrantClaims> {
    // Expiry, an older refresh generation, or account retirement must not prevent logout.
    // These signed claims authorize only revoking this exact session; they never grant access.
    const payload = signedRefresh(req, true);
    await deps.write(() =>
      repo.revokeEmailCodeSession(payload.sessionId, payload.id, payload.tenantId),
    );
    return payload;
  }

  const logout = own(async (req, res) => {
    if (getAuthMode() === 'default') fail('AUTH_MODE_DISABLED');
    const payload = await revokeSignedRefresh(req);
    // No cookie changes precede the durable majority acknowledgement.
    res.clearCookie('refreshToken', EMAIL_CODE_COOKIE_OPTIONS);
    res.clearCookie('token_provider', EMAIL_CODE_COOKIE_OPTIONS);
    deps.clearAuxiliaryCookies?.(res, { userId: payload.id, tenantId: payload.tenantId });
    return res.set('Cache-Control', 'no-store').json({ message: 'Logout successful' });
  });

  async function revokeCurrentRefresh(req: Request) {
    if (!req.cookies?.refreshToken) return;
    try {
      await revokeSignedRefresh(req);
    } catch (error) {
      if ((error as { code?: string }).code !== 'AUTH_SESSION_REQUIRED') throw error;
    }
  }
  return { requestCode, verifyCode, refresh, logout, revokeCurrentRefresh };
}
