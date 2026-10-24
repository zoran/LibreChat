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

/** Maximum reachable custody extension; stable identity is measured, never replaced by a locator cap. */
function cleanupCapacityEnvelope(row: StoredUpload): UploadCleanupCustody {
  const token = 'a'.repeat(128);
  const digest = 'a'.repeat(64);
  const generation = row.attemptGeneration ?? Number.MAX_SAFE_INTEGER;
  const promotionLocal = row.promotion
    ? {
        promotionId: row.promotion.promotionId,
        generation,
        worker: row.promotion.worker,
      }
    : undefined;
  // Accepted File owns physical deletion. Upload retains only its bounded acknowledgement.
  if (row.acceptedAt != null || row.fileId != null)
    return {
      version: 1,
      acceptedFileAck: {
        reference: token,
        operationId: row._id,
        cleanupGeneration: Number.MAX_SAFE_INTEGER,
        attemptGeneration: generation,
        revocationId: token,
        receiptSHA256: digest,
      },
      ...(promotionLocal ? { promotionLocal } : {}),
    };
  const request: StorageDeletionRequest = {
    protocol: 1,
    requestId: token,
    generation: String(generation),
    authorityBindingSHA256: digest,
    acceptedObjectSHA256: digest,
  };
  const binding: StorageDeletionBinding = {
    ...request,
    // The protocol bounds UTF-16 length. Three UTF-8 bytes per code unit is its maximum.
    bucket: '\u0800'.repeat(255),
    key: uploadOriginalKey({ ...row, attemptGeneration: generation }),
  };
  return {
    version: 1,
    request,
    cleanupGeneration: Number.MAX_SAFE_INTEGER,
    binding,
    obligationId: token,
    receipt: {
      ...binding,
      state: 'durable_delete_complete',
      obligationId: token,
      aggregateRevision: '9223372036854775807',
      proofSHA256: digest,
    },
    receiptSHA256: digest,
    consumerCommitId: token,
    consumed: {
      state: 'recorded',
      obligationId: token,
      receiptSHA256: digest,
      consumerCommitId: token,
    },
    retiredAt: Number.MAX_SAFE_INTEGER,
    ...(promotionLocal ? { promotionLocal } : {}),
  };
}

/** Keep actual bytes and the reachable durable-custody extension inside the existing record charge. */
export function assertUploadCleanupCapacity(
  row: StoredUpload,
  size: (value: object) => number,
): void {
  if (size(row) > UPLOAD_RECORD_BYTES) reject('capacity_exceeded');
  if (!row.cleanupCustody) return;
  const custody = cleanupCapacityEnvelope(row);
  // Future receipt writes can cross BSON's int32 boundary. Removal flags accompany final ACKs.
  const future = {
    ...row,
    revision: Number.MAX_SAFE_INTEGER,
    generation: Number.MAX_SAFE_INTEGER,
    originalRemoved: true,
    textRemoved: true,
    cleanupCustody: custody,
  };
  if (
    size(row.cleanupCustody) > UPLOAD_CLEANUP_HEADROOM ||
    size(custody) > UPLOAD_CLEANUP_HEADROOM ||
    size(future) > UPLOAD_RECORD_BYTES
  )
    reject('capacity_exceeded');
}
