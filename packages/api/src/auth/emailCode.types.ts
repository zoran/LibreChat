import type { EmailCodeRepository, BalanceConfig } from '@librechat/data-schemas';
import type { Response } from 'express';

export interface EmailCodeSender {
  /** Resolves only on positive SMTP acceptance; must terminate sockets within 20 seconds. */
  sendCode(input: {
    email: string;
    code: string;
    expiresInMinutes: number;
    locale: 'de' | 'en';
  }): Promise<void>;
}

export interface EmailCodeDependencies {
  repository: EmailCodeRepository;
  sender?: EmailCodeSender;
  getBalance?: () => Promise<BalanceConfig | undefined>;
  clearAuxiliaryCookies?: (res: Response, scope: { userId: string; tenantId: string }) => void;
  write: <T>(action: () => Promise<T>) => Promise<T>;
}
