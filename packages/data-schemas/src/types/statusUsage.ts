import type { EmailCodeGrant } from '~/types/emailCode';

export const STATUS_USAGE_STORAGE_LIMITS: Readonly<{
  mongoOperationMs: 2000;
  overallReadMs: 4000;
  transactionMs: 8000;
  casRetries: 3;
  batch: 100;
  queryMax: 10000;
  receiptReservations: 32768;
  receiptBytes: 8192;
  bucketBytes: 16384;
  completedRetentionHours: 192;
  collectorLeaseMs: 60000;
  collectorRenewMs: 30000;
}> = Object.freeze({
  mongoOperationMs: 2000,
  overallReadMs: 4000,
  transactionMs: 8000,
  casRetries: 3,
  batch: 100,
  queryMax: 10000,
  receiptReservations: 32768,
  receiptBytes: 8192,
  bucketBytes: 16384,
  completedRetentionHours: 192,
  collectorLeaseMs: 60000,
  collectorRenewMs: 30000,
});
export type StatusUsageWriteResult = 'recorded' | 'duplicate' | 'expired' | 'conflict' | 'capacity';
export type StatusUsageCoverageCause =
  | 'not_instrumented'
  | 'producer_gap'
  | 'query_timeout'
  | 'capacity'
  | 'purged_activity'
  | 'owner_conflict';
export interface StatusUsageGrantAction {
  grant: EmailCodeGrant;
  authorizedAtMs: number;
}
export interface StatusUsageVisiblePresence {
  grant: EmailCodeGrant;
  visibleObservedAtMs: number;
}
export interface StatusUsageOriginalPublication {
  tenantId: string | null;
  operationId: string;
  publishedAtMs: number;
}
export interface StatusUsageCollectorFence {
  ownerId: string;
  epoch: number;
}
export interface StatusUsageReceipt {
  _id: string;
  schemaVersion: 1;
  scopeId: string;
  tenantId: string | null;
  kind: 'activity_hour' | 'presence' | 'document_publication';
  revision: number;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAt: Date;
  userId?: string;
  hourStartMs?: number;
  activityBits?: Buffer;
  sessionId?: string;
  authVersion?: number;
  policyVersion?: number;
  lastVisibleAtMs?: number;
  leaseUntilMs?: number;
  publishedAtMs?: number;
}
export interface StatusUsageBucket {
  _id: string;
  schemaVersion: 1;
  scopeId: string;
  tenantId: string | null;
  kind: 'control' | 'hour';
  revision: number;
  hourStartMs?: number;
  expiresAt?: Date;
  active?: number;
  published?: number;
  acceptAfterMs?: number;
  reservedReceipts?: number;
  usersObservedFromMs?: number;
  documentsObservedFromMs?: number;
  usersGapFromMs?: number;
  documentsGapFromMs?: number;
  usersGap?: StatusUsageCoverageCause;
  documentsGap?: StatusUsageCoverageCause;
  collectorOwner?: string;
  collectorEpoch?: number;
  collectorUntilMs?: number;
}
/** Internal observed subtotals. Actual hook/census coverage is never inferred from storage. */
export interface StatusUsageWindowEvidence {
  startMs: number;
  endMs: number;
  activeUsers: number | null;
  publishedDocuments: number | null;
  complete: false;
  gap: StatusUsageCoverageCause;
}
