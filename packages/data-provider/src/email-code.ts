/** Public email-code transport contract. Authentication authority remains on the server. */
export type AuthMode = 'default' | 'transition' | 'email_code';

export interface EmailCodeConfig {
  authMode: AuthMode;
  emailCodeEnabled: boolean;
  emailCodeDomains: string[];
}

export interface EmailCodeRequest {
  email: string;
  attemptId?: string;
}

export interface EmailCodeChallengeResponse {
  attemptId: string;
  expiresAt: string;
  resendAt: string;
}

export interface EmailCodeVerification {
  attemptId: string;
  code: string;
}

export type EmailCodeErrorCode =
  | 'AUTH_MODE_DISABLED'
  | 'AUTH_SESSION_REQUIRED'
  | 'EMAIL_CODE_UNAVAILABLE'
  | 'EMAIL_CODE_INVALID_REQUEST'
  | 'EMAIL_CODE_DOMAIN_NOT_ALLOWED'
  | 'EMAIL_CODE_THROTTLED'
  | 'EMAIL_CODE_INVALID'
  | 'EMAIL_CODE_ACCOUNT_CONFLICT'
  | 'REFRESH_REPLACED';
