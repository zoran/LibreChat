import type { FileCoverageSource } from './file-housekeeping-coverage';
/** Versioned plain-data contract for managed uploads; no persistence or HTTP dependencies. */
import type {
  UploadSecurityApproval,
  UploadSecurityExecution,
  UploadSecuritySettlement,
} from './upload-security';
import type { ResourceScope as UploadScope } from './resource-ownership';
import type { UploadPromotionRecord } from './upload-intake';
import type { UploadDerivedIntent } from './upload-derived';
import { readNasS3Backend } from './upload-nas';
import type { NasS3Backend, NasUploadWriteBinding } from './upload-nas';

export const UPLOAD_CONTRACT_VERSION: number = 1;
export const UPLOAD_MAX_FILE_BYTES: number = 31_457_280;
export const UPLOAD_USER_WINDOW_BYTES: number = 314_572_800;
export const UPLOAD_WINDOW_MS: number = 30 * 86_400_000;
export const UPLOAD_RETENTION_MS: number = 28 * 86_400_000;
export const UPLOAD_REPLAY_MS: number = 31 * 86_400_000;
export const UPLOAD_MAX_TEXT_BYTES: number = 15 * 1_048_576;
export const UPLOAD_RECORD_BYTES: number = 32 * 1024;
/** Current AV receipts require a larger charged allowance; existing32KiB records retain their charge. */
export const UPLOAD_AV_RECORD_BYTES: number = 64 * 1024;
export const UPLOAD_INTEGRITY_CHUNK_BYTES: number = 262144;

/** Private identity of the received original; fixed blocks permit verification before delivery. */
export type UploadOriginalIntegrity = {
  version: 1;
  algorithm: 'sha256';
  sha256: string;
  chunkBytes: typeof UPLOAD_INTEGRITY_CHUNK_BYTES;
  chunkSha256: string[];
};

const INTEGRITY_KEYS = ['version', 'algorithm', 'sha256', 'chunkBytes', 'chunkSha256'];
const RECEIPT_KEYS = [
  'outcome',
  'bytes',
  'source',
  'filepath',
  'storageKey',
  'etag',
  'versionId',
  'integrity',
  'backend',
];
function closedUploadRecord(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).every((key) => typeof key === 'string' && keys.includes(key))
  );
}
function validUploadBytes(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= UPLOAD_MAX_FILE_BYTES
  );
}
function canonicalUploadHash(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && /^[a-f0-9]+$/.test(value);
}
/** Structural validation only: the storage owner compares these hashes with actual bytes. */
export function isUploadOriginalIntegrity(
  value: unknown,
  bytes: number,
): value is UploadOriginalIntegrity {
  if (
    !validUploadBytes(bytes) ||
    !closedUploadRecord(value, INTEGRITY_KEYS) ||
    Object.keys(value).length !== INTEGRITY_KEYS.length ||
    value.version !== 1 ||
    value.algorithm !== 'sha256' ||
    value.chunkBytes !== UPLOAD_INTEGRITY_CHUNK_BYTES ||
    !canonicalUploadHash(value.sha256) ||
    !Array.isArray(value.chunkSha256)
  )
    return false;
  const chunks = value.chunkSha256;
  const count = Math.ceil(bytes / UPLOAD_INTEGRITY_CHUNK_BYTES);
  return (
    chunks.length === count &&
    Reflect.ownKeys(chunks).length === count + 1 &&
    Array.from(chunks).every(canonicalUploadHash)
  );
}

/** Explicit null is the existing personal guest namespace, never a wildcard or missing tenant. */
export type UploadPrincipal =
  | { authentication: 'verified-email'; tenantId: string; userId: string }
  | { authentication: 'guest'; tenantId: null; userId: string };

/** Structural ownership only; the current server identity adapter still authenticates every request. */
export function isUploadPrincipal(value: unknown): value is UploadPrincipal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const principal = value as Record<string, unknown>;
  return (
    typeof principal.userId === 'string' &&
    principal.userId.length > 0 &&
    principal.userId.length <= 128 &&
    (principal.authentication === 'guest'
      ? principal.tenantId === null
      : principal.authentication === 'verified-email' &&
        typeof principal.tenantId === 'string' &&
        /^[a-zA-Z0-9_.-]{1,128}$/.test(principal.tenantId) &&
        principal.tenantId !== '__SYSTEM__')
  );
}
/** Compatibility name only; ResourceScope is the sole scope contract. */
export type { ResourceScope as UploadScope } from './resource-ownership';
/** Filename enters durable application state only with the accepted original and security proof. */
export type UploadAcceptedMetadata = { filename: string };

/** Exact own-data snapshot; no accessors, path interpretation, trimming or Unicode rewriting. */
export function readUploadAcceptedMetadata(value: unknown): UploadAcceptedMetadata | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 1 || keys[0] !== 'filename') return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'filename');
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    const filename: unknown = descriptor.value;
    if (
      typeof filename !== 'string' ||
      filename.length < 1 ||
      filename.length > 255 ||
      filename === '.' ||
      filename === '..' ||
      filename.includes('/') ||
      filename.includes('\\') ||
      Array.from(filename).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      return null;
    return { filename };
  } catch {
    return null;
  }
}

/** Canonical encodeURIComponent wire form; raw names never belong in a URL or reservation. */
export function readUploadFilenameHeader(value: unknown): UploadAcceptedMetadata | null {
  try {
    if (
      typeof value !== 'string' ||
      value.length > 3072 ||
      Array.from(value).some((character) => character.charCodeAt(0) > 127)
    )
      return null;
    const filename = decodeURIComponent(value);
    if (encodeURIComponent(filename) !== value) return null;
    return readUploadAcceptedMetadata({ filename });
  } catch {
    return null;
  }
}

export type UploadRequest = {
  mediaType: string;
  declaredBytes: number;
  idempotencyKey: string;
  scope?: UploadScope;
};
export type UploadState =
  | 'waiting'
  | 'transferring'
  | 'queued_processing'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'deleted'
  | 'expired';
export const UPLOAD_ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'invalid_request',
  'unsupported_type',
  'idempotency_conflict',
  'quota_exceeded',
  'capacity_exceeded',
  'queue_full',
  'not_ready',
  'lease_lost',
  'size_mismatch',
  'storage_uncertain',
  'processing_failed',
  'security_rejected',
  'security_uninspectable',
  'expired',
  'cancelled',
  'unavailable',
  'admission_paused',
  'storage_unavailable',
  'storage_stale',
  'migration_conflict',
] as const;
export type UploadErrorCode = (typeof UPLOAD_ERROR_CODES)[number];
export type UploadOperation = {
  version: 1;
  id: string;
  revision: number;
  scope: UploadScope;
  filename?: string;
  mediaType: string;
  declaredBytes: number;
  actualBytes?: number;
  state: UploadState;
  createdAt: string;
  acceptedAt?: string;
  expiresAt?: string;
  fileId?: string;
  error?: UploadErrorCode;
  cleanupPending: boolean;
  canUseInComposer: boolean;
  canRetryProcessing: boolean;
};
export type UploadUsage = {
  limitBytes: number;
  usedBytes: number;
  reservedBytes: number;
  availableBytes: number;
  retainedBytes: number;
  nextReleaseAt: string | null;
  nextReleaseBytes: number;
};
export type UploadWorker = { hostId: string; instanceId: string };
/** Private physical staging obligations for one exact worker, including failed/stale attempts. */
export type UploadLocalReservations = {
  worker: UploadWorker;
  observedAt: number;
  heldBytes: number;
  counts: { transfer: number; processing: number };
  attempts: {
    operationId: string;
    generation: number;
    declaredBytes: number;
    kind: 'transfer' | 'processing';
    worker: UploadWorker;
  }[];
};
/** Inert parser preparation, durably bound to a processing lease before execution. */
export type UploadParserExecution = { attemptId: string; instanceId: string; expiresAt: string };
export type UploadLease = UploadWorker & {
  tenantId: string | null;
  userId: string;
  operationId: string;
  generation: number;
  kind: 'transfer' | 'processing';
  expiresAt: string;
};
/** Controller may only lower these three global ceilings; host ceilings remain independent. */
export type UploadLimits = {
  transferPermits: number;
  processingPermits: number;
  /** Aggregate workflow traffic, including receive, original PUT and processing reads. */
  transferBytesPerSecond: number;
};
export type UploadStorageReceipt = {
  outcome: 'durable' | 'unknown' | 'absent';
  bytes: number;
  source: string;
  filepath: string;
  storageKey: string;
  etag?: string;
  versionId?: string;
  /** Absent only for uncertain or removed historical data; never invented from a later read. */
  integrity?: UploadOriginalIntegrity;
  /** Missing means the original managed provider; existing rows are never repointed. */
  backend?: NasS3Backend;
};
/** Existing managed protocol binding remains backend/version1, never repointed to NAS. */
export type ManagedUploadWriteInput = Readonly<{
  bucket: string;
  key: string;
  operationId: string;
  generation: string;
  bytes: number;
  wholeSHA256: string;
  mediaType: string;
}>;
export type ManagedUploadWriteBinding = ManagedUploadWriteInput &
  Readonly<{
    version: 1;
    originalDeadline: string;
  }>;
/** Trusted same-row projection only; an ordinary DTO never grants storage authority. */
export type UploadOriginalWriteBinding = ManagedUploadWriteBinding | NasUploadWriteBinding;
/** One bounded receipt shape; durability, authority and canonical keys belong to the caller. */
export function isUploadStorageReceipt(value: unknown): value is UploadStorageReceipt {
  if (
    !closedUploadRecord(value, RECEIPT_KEYS) ||
    !['outcome', 'bytes', 'source', 'filepath', 'storageKey'].every((key) =>
      Object.keys(value).includes(key),
    ) ||
    !['durable', 'unknown', 'absent'].includes(value.outcome as string) ||
    !validUploadBytes(value.bytes) ||
    !['source', 'filepath', 'storageKey'].every((key) => {
      const text = value[key];
      return typeof text === 'string' && text.length > 0;
    }) ||
    (value.filepath as string).length > 4096
  )
    return false;
  for (const key of ['etag', 'versionId']) {
    const text = value[key];
    if (
      text !== undefined &&
      (typeof text !== 'string' ||
        text.length > 1024 ||
        new TextEncoder().encode(text).length > 1024)
    )
      return false;
  }
  return (
    (value.backend === undefined || readNasS3Backend(value.backend) !== null) &&
    (value.integrity === undefined || isUploadOriginalIntegrity(value.integrity, value.bytes))
  );
}
export type UploadProcessingInput = {
  operationId: string;
  attemptGeneration: number;
  filename: string;
  mediaType: string;
  bytes: number;
  original: UploadStorageReceipt;
  /** Private scanner approval for this immutable original, never client-supplied metadata. */
  securityApproval: UploadSecurityApproval;
};
export type UploadCleanupTask = {
  /** Immutable original binding projected from this trusted operation row, including unknown PUTs. */
  writeBinding?: UploadOriginalWriteBinding;
  operationId: string;
  generation: number;
  attemptGeneration?: number;
  principal: UploadPrincipal;
  worker?: UploadWorker;
  original?: UploadStorageReceipt;
  fileId?: string;
  state: UploadState;
  parserExecution?: UploadParserExecution;
  securityExecution?: UploadSecurityExecution;
  securitySettlement?: UploadSecuritySettlement;
  /** Private actual application-writer obligation, independent of intake/scanner cleanup. */
  promotion?: UploadPromotionRecord;
  /** Explicit durable facts; missing historical journal values remain false/unknown. */
  writerStopped: boolean;
  localCopiesAbsent: boolean;
};
/** Trusted cleanup owner supplies this after joining writers and checking every owned resource. */
export type UploadCleanupProof = {
  operationId: string;
  generation: number;
  writerStopped: boolean;
  originalAbsent: boolean;
  localCopiesAbsent: boolean;
  textAndHistoryRemoved: boolean;
  securitySettlement?: UploadSecuritySettlement;
};
export type UploadReserveInput = UploadRequest & { operationId: string; fingerprint: string };
/** Trusted internal consumers only; the public UploadRequest remains unchanged. */
export type UploadDerivedRequest = UploadRequest & { derived: UploadDerivedIntent };
export type UploadDerivedReserveInput = UploadReserveInput & { derived: UploadDerivedIntent };
export type UploadClaimInput = {
  kind: 'transfer' | 'processing';
  worker: UploadWorker;
  principal?: UploadPrincipal;
  operationId?: string;
  /** Must match the still-current stored capability and grant in the claim transaction. */
  intake?: { capabilitySha256: string };
  now: number;
};
export type UploadControllerLease = { ownerId: string; generation: number; expiresAt: string };
export type UploadControlMode = 'normal' | 'fallback' | 'blocked';
export type UploadControlPolicy = {
  limits: UploadLimits;
  mode: UploadControlMode;
  sourceExpiresAt: number;
};
export type UploadByteLease = { bytes: number; expiresAt: string; generation: number };
export type UploadMetricsSnapshot = {
  observedAt: number;
  /** Independent admission policy; null means the observation cannot establish policy. */
  admissionsPaused: boolean | null;
  /** Private global view; consumers must preserve these source/lease deadlines. */
  control: UploadControlPolicy & { leaseExpiresAt: number; enabled: boolean };
  queue: { count: number; bytes: number; oldestAgeSeconds: number };
  quota: { usedBytes: number; reservedBytes: number; retainedBytes: number };
  staging: { count: number; bytes: number };
  states: Partial<Record<UploadState, number>>;
  originalBytes: number;
  objectBytes: number;
  textBytes: number;
  recordBytes: number;
  bundles: number;
  cleanupPending: number;
  transfers: number;
  processors: number;
};
/** Private operator contract. Neither the policy revision nor commands are employee input. */
export type UploadAdmissionPolicy = {
  storeId: string;
  revision: number;
  paused: boolean;
};
export type UploadAdmissionCommand = {
  storeId: string;
  expectedRevision: number;
  paused: boolean;
  /** Retained verbatim across retries; confirmation cannot grant a fresh mutation window. */
  originalDeadline: string;
};
export type FileRetentionMigrationRecord = Readonly<{
  kind: 'file-retention';
  subject: Readonly<{ tenantId: string | null; ownerUserId: string; fileId: string }>;
  acceptedAt: string | null;
  deadlineAt: string;
  sourceBindingSha256: string | null;
  custody: 'current' | 'cleanup-only';
  retention:
    | Readonly<{
        kind: 'original';
        version: 1;
        baselineDeadlineAt: string;
        trackedSince: string;
        historyConfidence: 'complete' | 'since-tracking';
        readCount: number;
        processingCount: number;
        lastSuccessfulReadAt: string | null;
        lastSuccessfulProcessingAt: string | null;
        deadlineGeneration: number;
      }>
    | Readonly<{
        kind: 'derived';
        version: 1;
        ownDeadlineAt: string;
        capBasis: 'admission' | 'legacy-baseline';
        trackedSince: string;
        deadlineGeneration: number;
        /** Canonical v2 for current rows; exact historical custody or proven absent after cleanup. */
        originSha256: string | null;
      }>;
}>;

/** Private migration data is paged, never exposed by employee HTTP handlers. */
export type UploadMigrationPage = {
  version: 2;
  epoch: string;
  cursor: string | null;
  nextCursor: string | null;
  records: Record<string, unknown>[];
};
export type UploadResourceTotals = {
  originalBytes: number;
  objectBytes: number;
  textBytes: number;
  recordBytes: number;
  bundles: number;
};
/** Private trusted coordinator must obtain this directly from the retired source owner. */
export type UploadMigrationReceipt = {
  version: 2;
  epoch: string;
  sourceId: string;
  digest: string;
  operations: number;
  sourceRetired: true;
  fileActivity: { version: 1; files: number; sha256: string };
};
/** Private reconciliation owner captures this before measuring all external populations. */
export type UploadReconciliationSnapshot = {
  storeId: string;
  revision: number;
  observedAt: string;
  ledgerTotals: UploadResourceTotals;
  baseline: UploadResourceTotals;
  /** Saturated presence checks; external writer quiescence remains the coordinator's obligation. */
  initialInventory: { operations: 0 | 1; files: 0 | 1; sourceMessages: 0 | 1 };
};
/** Attests actual owned inventory and history-copy accounting; never accepted from an employee. */
export type UploadActivationProof = {
  storeId: string;
  revision: number;
  baseline: UploadResourceTotals;
  inventoryEvidenceId: string;
  observedAt: string;
  historyCopiesAccounted: true;
  admission?: 'initial-empty';
  /** Required for initial-empty. An exact committed active proof remains replayable after expiry. */
  originalDeadline?: string;
};

export * from './file-housekeeping-coverage';

/** Diagnostic population observation. It never certifies writer exclusion or coverage. */
export const FILE_HOUSEKEEPING_INVENTORY_CONTRACT = {
  id: 'file-housekeeping-inventory',
  version: 1,
} as const;
export type FileInventoryRequest = Readonly<{
  action: 'inventory';
  version: 1;
  requestId: string;
  source: FileCoverageSource;
  target: Readonly<{
    namespaceUid: string;
    mongoReplicaSet: string;
    mongoDatabase: string;
  }>;
  originalDeadline: string;
  lookAheadMs: number; // Fixed diagnostic horizon, 0..300000; not a writer-hold grant.
}>;
export type FileInventoryCounts = Readonly<{
  totalFiles: number;
  managedMarker: number;
  standaloneMarker: number;
  inheritedDeadline: number;
  otherFiles: number;
  pastDueInheritedDeadline: number;
  malformedExpiredAt: number;
  deletionOrRetryMarkers: number;
  missingOrMalformedIdentity: number;
  expiresAtAbsentOrNull: number;
  expiresAtScalarDate: number;
  expiresAtArray: number;
  expiresAtOther: number;
}>;
export type FileInventoryResult =
  | Readonly<{
      outcome: 'inventoried';
      version: 1;
      diagnosticOnly: true;
      contract: typeof FILE_HOUSEKEEPING_INVENTORY_CONTRACT;
      requestSha256: string;
      collectionPresent: boolean;
      collectionSha256: string;
      indexSha256: string;
      catalogStable: boolean; // Equal bracketing observations do not exclude intervening DDL.
      primaryStable: boolean; // Equal primary identity and nondecreasing observed clock only.
      intervalAssurance: 'unknown'; // Requires separate actual DDL/clock/writer custody.
      serverTime: Readonly<{ from: string; through: string; horizon: string }>;
      snapshot: Readonly<{ seconds: number; increment: number }>;
      counts: FileInventoryCounts;
      ttl: Readonly<{
        semantics: 'absent' | 'supported-scalar' | 'unknown';
        indexes: readonly Readonly<{
          specSha256: string;
          kind: 'expiresAt' | 'unsupported';
          expireAfterSeconds: number | null;
        }>[];
        eligibleAtObservation: number | null;
        becomingEligibleByHorizon: number | null;
        afterHorizon: number | null;
      }>;
    }>
  | Readonly<{
      outcome: 'refused';
      code: 'invalid_input' | 'deadline' | 'capacity' | 'unavailable';
    }>;

export * from './file-housekeeping-history';
