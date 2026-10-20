import type { Document } from 'mongoose';

export interface ConfiguredAdministratorPolicy {
  revision: number;
  tenantId: string;
  emails: readonly string[];
}

export interface PlatformAdminPolicy {
  _id: 'configured-platform-administrators';
  revision: number;
  digest: string;
  tenantId: string;
  emails: string[];
  /** Every reconciliation writes this fence, including same-policy login calls. */
  writeSequence: number;
}

export type IPlatformAdminPolicy = PlatformAdminPolicy & Document<string>;
