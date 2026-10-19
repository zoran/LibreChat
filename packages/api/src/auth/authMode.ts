export { EMAIL_CODE_IDLE_MS, EMAIL_CODE_ABSOLUTE_MS } from '@librechat/data-schemas';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AuthMode, EmailCodeConfig } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import { getEmailCodeMailConfig } from './mailSender';
import { qualificationMailbox, type EmailCodeQualificationMailbox } from './emailRecipientPolicy';

export const AUTH_SELECTION_COOKIE = '__Host-librechat-auth-selection';
export const EMAIL_ATTEMPT_COOKIE = '__Host-librechat-email-attempt';
export const EMAIL_CODE_ACCESS_MS: number = 5 * 60_000;
export const EMAIL_CODE_CHALLENGE_MS: number = 10 * 60_000;
export const EMAIL_CODE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: '/',
} as const;

export function getAuthMode(): AuthMode {
  const mode = process.env.AUTH_MODE ?? 'default';
  if (mode === 'default' || mode === 'transition' || mode === 'email_code') return mode;
  throw new Error('Invalid AUTH_MODE');
}

/** Explicit temporary personal-guest policy; other auth modes retain verified-email-only uploads. */
export function guestUploadTransitionEnabled(): boolean {
  return (
    getAuthMode() === 'transition' && process.env.CORTEX_UPLOAD_GUEST_TRANSITION_ENABLED === 'true'
  );
}

export function getEmailCodeSettings(): {
  tenantId: string;
  domains: string[];
  secret: string;
  policyVersion: number;
  configured: boolean;
  qualification: EmailCodeQualificationMailbox | undefined;
} {
  const tenantId = process.env.EMAIL_CODE_TENANT_ID ?? '';
  const domains = (process.env.EMAIL_CODE_ALLOWED_DOMAINS ?? '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
  const qualification = qualificationMailbox(process.env);
  const secret = process.env.EMAIL_CODE_HMAC_KEY ?? '';
  const policyVersion = Number(process.env.EMAIL_CODE_POLICY_VERSION ?? '1');
  const configured =
    tenantId !== '__SYSTEM__' &&
    /^[a-zA-Z0-9_.-]{1,128}$/.test(tenantId) &&
    domains.length > 0 &&
    domains.every((domain) => /^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,63}$/.test(domain)) &&
    Buffer.byteLength(secret) >= 32 &&
    Number.isSafeInteger(policyVersion) &&
    policyVersion > 0;
  return { tenantId, domains, secret, policyVersion, configured, qualification };
}

export function getEmailCodeConfig(senderConfigured?: boolean): EmailCodeConfig {
  const settings = getEmailCodeSettings();
  const authMode = getAuthMode();
  const senderAvailable =
    authMode !== 'default' &&
    (senderConfigured ?? Boolean(getEmailCodeMailConfig(process.env, settings.domains)));
  return {
    authMode,
    emailCodeEnabled:
      authMode !== 'default' &&
      settings.configured &&
      process.env.EMAIL_CODE_ENABLED === 'true' &&
      senderAvailable,
    emailCodeDomains: settings.domains,
  };
}

/** Selection persists beyond credential expiry. It never establishes user/tenant authority. */
export function setAuthSelection(res: Response, selection: 'guest' | 'email'): void {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('Authentication signing is unavailable');
  const signature = createHmac('sha256', secret)
    .update(`auth-selection:v1:${selection}`)
    .digest('hex');
  res.cookie(AUTH_SELECTION_COOKIE, `${selection}.${signature}`, {
    ...EMAIL_CODE_COOKIE_OPTIONS,
    maxAge: 180 * 24 * 60 * 60_000,
  });
}

export function getAuthSelection(req: Request): 'guest' | 'email' | 'invalid' | undefined {
  const value: unknown = req.cookies?.[AUTH_SELECTION_COOKIE];
  if (value == null) return undefined;
  if (typeof value !== 'string' || !/^(guest|email)\.[a-f0-9]{64}$/.test(value)) return 'invalid';
  const [selection, signature] = value.split('.');
  const secret = process.env.JWT_SECRET;
  if (!secret) return 'invalid';
  const expected = createHmac('sha256', secret)
    .update(`auth-selection:v1:${selection}`)
    .digest('hex');
  return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
    ? (selection as 'guest' | 'email')
    : 'invalid';
}

/** Guest bootstrap must never inherit the email tenant or be chosen by failed refresh. */
export function mayRefreshGuest(req: Request): boolean {
  const selection = getAuthSelection(req);
  return getAuthMode() === 'transition' && (selection === undefined || selection === 'guest');
}
