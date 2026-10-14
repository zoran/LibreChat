import type { BalanceConfig } from './user';

/** Private identity adapter data; never returned from challenge/status HTTP endpoints. */
export interface EmailCodeChallenge {
  _id: string;
  tenantId: string;
  email: string;
  mailboxKey: string;
  nonceHash: string;
  generation: number;
  verifier: string;
  expiresAt: Date;
  resendAt: Date;
  accepted: boolean;
  failures: number;
  consumedAt?: Date;
}

export interface EmailCodeUser {
  _id: string;
  id: string;
  email: string;
  emailVerified: true;
  name: string;
  username: string;
  provider: 'email_code';
  role: string;
  tenantId: string;
}

export interface EmailCodeGrant {
  sessionId: string;
  userId: string;
  tenantId: string;
  authVersion: number;
  policyVersion: number;
  refreshGeneration: number;
  createdAt: number;
  absoluteExpiresAt: number;
  idleExpiresAt: number;
}

export interface EmailCodeIdentity {
  user: EmailCodeUser;
  grant: EmailCodeGrant;
}

export interface EmailCodeAttemptInput {
  challenge: EmailCodeChallenge;
  previousGeneration?: number;
  now: Date;
}

export interface EmailCodeRedeemInput {
  attemptId: string;
  tenantId: string;
  nonceHash: string;
  generation: number;
  verifier: string;
  refreshTokenHash: string;
  sessionId: string;
  policyVersion: number;
  now: Date;
  balance?: BalanceConfig;
}

export type EmailCodeRepositoryError =
  | 'EMAIL_CODE_INVALID'
  | 'EMAIL_CODE_THROTTLED'
  | 'EMAIL_CODE_ACCOUNT_CONFLICT'
  | 'AUTH_SESSION_REQUIRED'
  | 'REFRESH_REPLACED';

export interface EmailCodeRepository {
  reserveEmailCodeAttempt(input: EmailCodeAttemptInput): Promise<void>;
  finishEmailCodeSend(attemptId: string, generation: number, accepted: boolean): Promise<void>;
  getEmailCodeChallenge(attemptId: string, tenantId: string): Promise<EmailCodeChallenge | null>;
  consumeEmailCodeNetwork(key: string, now: Date): Promise<void>;
  redeemEmailCode(input: EmailCodeRedeemInput): Promise<EmailCodeIdentity>;
  readEmailCodeIdentity(sessionId: string, tenantId: string): Promise<EmailCodeIdentity | null>;
  rotateEmailCodeRefresh(input: {
    grant: EmailCodeGrant;
    oldHash: string;
    newHash: string;
    now: Date;
  }): Promise<void>;
  revokeEmailCodeSession(sessionId: string, userId: string, tenantId: string): Promise<void>;
  revokeEmailCodeAccount(userId: string, tenantId: string): Promise<void>;
  touchEmailCodeSession(grant: EmailCodeGrant, now: Date): Promise<void>;
}
