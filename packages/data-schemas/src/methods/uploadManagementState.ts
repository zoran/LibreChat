/** Private upload row contract and pure primitives shared below persistence and lifecycle owners. */
import { isUploadPrincipal, UPLOAD_RECORD_BYTES } from 'librechat-data-provider';
import type {
  UploadPrincipal,
  UploadDerivedOrigin,
  UploadScope,
  UploadState,
  UploadErrorCode,
  UploadWorker,
  UploadLease,
  UploadStorageReceipt,
  UploadParserExecution,
  UploadSecurityApproval,
  UploadSecurityExecution,
  UploadSecuritySettlement,
  UploadIntakeGrant,
  UploadPromotionRecord,
  StorageDeletionRequest,
  StorageDeletionBinding,
  StorageDeletionTerminalReceipt,
  StorageDeletionConsumptionResult,
} from 'librechat-data-provider';
import type { FileUploadCleanupAcknowledgment } from '../types/fileCleanup';

export const WAIT_MS = 600_000;
export const PROCESS_MS = 3_600_000;
export const UPLOAD_CLEANUP_HEADROOM: number = 16 * 1024;

export type UploadCleanupCustody = {
  version: 1;
  acceptedFileAck?: FileUploadCleanupAcknowledgment;
  request?: StorageDeletionRequest;
  cleanupGeneration?: number;
  binding?: StorageDeletionBinding;
  obligationId?: string;
  receipt?: StorageDeletionTerminalReceipt;
  receiptSHA256?: string;
  consumerCommitId?: string;
  consumed?: Extract<StorageDeletionConsumptionResult, { state: 'recorded' }>;
  retiredAt?: number;
  promotionLocal?: { promotionId: string; generation: number; worker: UploadWorker };
};

export type StoredUpload = {
  _id: string;
  tenantId: string | null;
  userId: string;
  scope: UploadScope;
  idempotencyKey: string;
  fingerprint: string;
  derivedOrigin?: UploadDerivedOrigin;
  filename?: string;
  mediaType: string;
  declaredBytes: number;
  actualBytes?: number;
  state: UploadState;
  revision: number;
  createdAt: number;
  acceptedAt?: number;
  expiresAt?: number;
  fileId?: string;
  error?: UploadErrorCode;
  cleanupPending: boolean;
  cleanupCustody?: UploadCleanupCustody;
  generation: number;
  slot?: 'transfer' | 'processing';
  worker?: UploadWorker;
  leaseExpiresAt?: number;
  attemptGeneration?: number;
  original?: UploadStorageReceipt;
  /** Trusted scanner receipt, private to the original transfer rather than processing attempts. */
  securityApproval?: UploadSecurityApproval;
  securityExecution?: UploadSecurityExecution;
  securitySettlement?: UploadSecuritySettlement;
  /** Private capability hash and native identity reference; never projected to ordinary clients. */
  intake?: {
    capabilitySha256: string;
    grant: UploadIntakeGrant;
    worker?: UploadWorker;
    generation?: number;
    closed?: true;
    cleanupAcknowledged?: true;
  };
  /** App writer is independent of the Intake transfer and scanner execution. */
  promotion?: UploadPromotionRecord;
  originalBytes: number;
  textBytes: number;
  recordBytes: number;
  queueCharged: boolean;
  pendingBytes: number;
  stagingHeld: boolean;
  processingQueuedAt?: number;
  byteLeaseUntil?: number;
  workerGeneration?: number;
  workerKind?: UploadLease['kind'];
  writerStopped?: boolean;
  /** Exact local facts; remote scanner/promotion/storage obligations remain independent. */
  actorSettlement?: {
    generation: number;
    worker: UploadWorker;
    writerStopped: boolean;
    localWriterStopped?: boolean;
    localCopiesAbsent: boolean;
  };
  byteLeaseGeneration?: number;
  originalRemoved?: boolean;
  textRemoved?: boolean;
  parserExecution?: UploadParserExecution;
  publishedDigest?: string;
  /** Immutable first actual publication time; absent historical rows remain unknown. Private. */
  firstPublishedAtMs?: number;
};

export function reject(code: UploadErrorCode): never {
  const error = Object.assign(new Error(code), { name: 'UploadManagementError', code });
  throw error;
}

export function storedUploadPrincipal(
  row: Pick<StoredUpload, 'tenantId' | 'userId'>,
): UploadPrincipal {
  const principal =
    row.tenantId === null
      ? { tenantId: null, userId: row.userId, authentication: 'guest' as const }
      : { tenantId: row.tenantId, userId: row.userId, authentication: 'verified-email' as const };
  if (!isUploadPrincipal(principal)) reject('unavailable');
  return principal;
}

export const uploadOriginalKey = (row: StoredUpload): string =>
  `${row.tenantId === null ? '' : `t/${row.tenantId}/`}managed-uploads/${row.userId}/${row._id}.${row.attemptGeneration}__original`;

/** Reserve bounded receipt room on admission and preserve it through every owner replacement. */
export function assertUploadCleanupCapacity(
  row: StoredUpload,
  size: (value: object) => number,
): void {
  if (!row.cleanupCustody) return;
  const { cleanupCustody, ...base } = row;
  if (
    size(base) + UPLOAD_CLEANUP_HEADROOM > UPLOAD_RECORD_BYTES ||
    size(cleanupCustody) > UPLOAD_CLEANUP_HEADROOM
  )
    reject('capacity_exceeded');
}
