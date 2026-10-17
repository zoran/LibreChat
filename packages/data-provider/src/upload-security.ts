/** Private scanner receipt data. Validation binds a receipt; only trusted server owners may issue it. */
import { UPLOAD_MAX_FILE_BYTES } from './upload-management';

export type UploadSecuritySubject = {
  tenantId: string | null;
  userId: string;
  operationId: string;
  /** The original transfer generation, independent of subsequent processing retries. */
  transferGeneration: number;
  mediaType: string;
  bytes: number;
  sha256: string;
};

export type UploadSecurityApproval = {
  version: 1;
  decision: 'approved';
  policySha256: string;
  subject: UploadSecuritySubject;
  scannerVersion: string;
  checkedAt: string;
  coverage: { complete: true; pages: number; parts: number };
};

export type UploadSecurityReason =
  | 'classification_marking'
  | 'incomplete_coverage'
  | 'unsupported_format'
  | 'encrypted'
  | 'active_content'
  | 'invalid_content'
  | 'resource_limit'
  | 'scanner_unavailable'
  | 'ambiguous_marking';

export type UploadSecurityDecision =
  | UploadSecurityApproval
  | { version: 1; decision: 'rejected'; reason: 'classification_marking' }
  | { version: 1; decision: 'uninspectable'; reason: UploadSecurityReason };

/** A trusted adapter must explicitly attest execution stop and removal of its transient copies. */
export type UploadSecurityInspection = {
  decision: UploadSecurityDecision;
  cleanup: { writerStopped: true; transientDataRemoved: true };
};

/** Inert execution identity; issuer authentication and lease expiry belong to the server owner. */
export type UploadSecurityExecution = {
  version: 1;
  attemptId: string;
  instanceId: string;
  executionId: string;
  expiresAt: string;
};

/** False means unconfirmed, never a successful cancellation or proof that copies were removed. */
export type UploadSecuritySettlement = {
  execution: UploadSecurityExecution;
  writerStopped: boolean;
  transientDataRemoved: boolean;
};

const EXECUTION_KEYS = ['version', 'attemptId', 'instanceId', 'executionId', 'expiresAt'] as const;
const SETTLEMENT_KEYS = ['execution', 'writerStopped', 'transientDataRemoved'] as const;
const NEGATIVE_DECISION_KEYS = ['version', 'decision', 'reason'] as const;
const INSPECTION_KEYS = ['decision', 'cleanup'] as const;
const CLEANUP_KEYS = ['writerStopped', 'transientDataRemoved'] as const;
const SECURITY_REASONS: readonly UploadSecurityReason[] = [
  'classification_marking',
  'incomplete_coverage',
  'unsupported_format',
  'encrypted',
  'active_content',
  'invalid_content',
  'resource_limit',
  'scanner_unavailable',
  'ambiguous_marking',
];

const SUBJECT_KEYS = [
  'tenantId',
  'userId',
  'operationId',
  'transferGeneration',
  'mediaType',
  'bytes',
  'sha256',
] as const;
const APPROVAL_KEYS = [
  'version',
  'decision',
  'policySha256',
  'subject',
  'scannerVersion',
  'checkedAt',
  'coverage',
] as const;
const COVERAGE_KEYS = ['complete', 'pages', 'parts'] as const;

/** Snapshot data descriptors once: never read attacker-supplied getters or inherited fields. */
function readClosedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length) return null;
    const record: Record<string, unknown> = Object.create(null);
    for (const key of ownKeys) {
      if (typeof key !== 'string' || !keys.includes(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value'))
        return null;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    // Revoked proxies and failed reflection are invalid input, never validation exceptions.
    return null;
  }
}

function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    !/[^a-zA-Z0-9_.-]/.test(value)
  );
}

function hash(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && !/[^a-f0-9]/.test(value);
}

function positiveInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;
}

function mediaType(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 127) return false;
  const match = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.exec(value);
  return match?.[0] === value;
}

function scannerVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[a-zA-Z0-9]/.test(value) &&
    !/[^a-zA-Z0-9._:+/-]/.test(value)
  );
}

function checkedAt(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/** Detached subject data for trusted server consumers; no accessor or inherited field is read. */
export function readUploadSecuritySubject(value: unknown): UploadSecuritySubject | null {
  const record = readClosedRecord(value, SUBJECT_KEYS);
  if (
    !record ||
    (record.tenantId !== null &&
      (!identifier(record.tenantId) || record.tenantId === '__SYSTEM__')) ||
    !identifier(record.userId) ||
    !identifier(record.operationId) ||
    !positiveInteger(record.transferGeneration) ||
    !mediaType(record.mediaType) ||
    !positiveInteger(record.bytes, UPLOAD_MAX_FILE_BYTES) ||
    !hash(record.sha256)
  )
    return null;
  return {
    tenantId: record.tenantId,
    userId: record.userId,
    operationId: record.operationId,
    transferGeneration: record.transferGeneration,
    mediaType: record.mediaType,
    bytes: record.bytes,
    sha256: record.sha256,
  };
}

function readApproval(value: unknown): UploadSecurityApproval | null {
  const record = readClosedRecord(value, APPROVAL_KEYS);
  if (
    !record ||
    record.version !== 1 ||
    record.decision !== 'approved' ||
    !hash(record.policySha256) ||
    !scannerVersion(record.scannerVersion) ||
    !checkedAt(record.checkedAt)
  )
    return null;
  const subject = readUploadSecuritySubject(record.subject);
  const coverage = readClosedRecord(record.coverage, COVERAGE_KEYS);
  // Existing isolated inspection bounds: at most 500 pages/slides and 2,048 archive parts.
  if (
    !subject ||
    !coverage ||
    coverage.complete !== true ||
    !positiveInteger(coverage.pages, 500) ||
    !positiveInteger(coverage.parts, 2048)
  )
    return null;
  return {
    version: 1,
    decision: 'approved',
    policySha256: record.policySha256,
    subject,
    scannerVersion: record.scannerVersion,
    checkedAt: record.checkedAt,
    coverage: { complete: true, pages: coverage.pages, parts: coverage.parts },
  };
}

function readDecision(value: unknown): UploadSecurityDecision | null {
  const approval = readApproval(value);
  if (approval) return approval;
  const record = readClosedRecord(value, NEGATIVE_DECISION_KEYS);
  if (!record || record.version !== 1) return null;
  if (record.decision === 'rejected' && record.reason === 'classification_marking')
    return { version: 1, decision: 'rejected', reason: 'classification_marking' };
  const reason = SECURITY_REASONS.find((reason) => reason === record.reason);
  if (record.decision === 'uninspectable' && reason)
    return { version: 1, decision: 'uninspectable', reason };
  return null;
}

/** Shape only: closed decision data cannot authenticate its issuer. */
export function isUploadSecurityDecision(value: unknown): value is UploadSecurityDecision {
  return readDecision(value) !== null;
}

/** Return detached data so consumers never re-read untrusted properties after validation. */
export function readUploadSecurityInspection(value: unknown): UploadSecurityInspection | null {
  const record = readClosedRecord(value, INSPECTION_KEYS);
  if (!record) return null;
  const cleanup = readClosedRecord(record.cleanup, CLEANUP_KEYS);
  if (!cleanup || cleanup.writerStopped !== true || cleanup.transientDataRemoved !== true)
    return null;
  const decision = readDecision(record.decision);
  if (!decision) return null;
  return { decision, cleanup: { writerStopped: true, transientDataRemoved: true } };
}

/** Explicit adapter attestation, never inferred from promise resolution or local stream closure. */
export function isUploadSecurityInspection(value: unknown): value is UploadSecurityInspection {
  return readUploadSecurityInspection(value) !== null;
}

export function isUploadSecuritySubject(value: unknown): value is UploadSecuritySubject {
  return readUploadSecuritySubject(value) !== null;
}

/** Shape only, without a wall-clock dependency or any assertion about the receipt's issuer. */
export function isUploadSecurityApproval(value: unknown): value is UploadSecurityApproval {
  return readApproval(value) !== null;
}

/** Matches current server facts; policy or original changes invalidate approval, not an invented TTL. */
export function matchesUploadSecurityApproval(
  value: unknown,
  subject: UploadSecuritySubject,
  policySha256: string,
  now: number,
): boolean {
  if (!hash(policySha256) || !Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000)
    return false;
  const approval = readApproval(value);
  const expected = readUploadSecuritySubject(subject);
  return (
    approval !== null &&
    expected !== null &&
    approval.policySha256 === policySha256 &&
    Date.parse(approval.checkedAt) <= now &&
    SUBJECT_KEYS.every((key) => approval.subject[key] === expected[key])
  );
}

function executionAttemptId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 144) return false;
  const match = /^[a-zA-Z0-9_-]{1,128}\.[1-9][0-9]{0,14}$/.exec(value);
  return match?.[0] === value;
}

function uuidV4(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === 36 &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
  );
}

/** Shape and snapshot only; callers must authenticate the issuer and enforce their lease clock. */
export function readUploadSecurityExecution(value: unknown): UploadSecurityExecution | null {
  const record = readClosedRecord(value, EXECUTION_KEYS);
  if (
    !record ||
    record.version !== 1 ||
    !executionAttemptId(record.attemptId) ||
    !uuidV4(record.instanceId) ||
    !uuidV4(record.executionId) ||
    !checkedAt(record.expiresAt)
  )
    return null;
  return {
    version: 1,
    attemptId: record.attemptId,
    instanceId: record.instanceId,
    executionId: record.executionId,
    expiresAt: record.expiresAt,
  };
}

/** Preserve unknown outcomes explicitly and detach the nested identity before consumers await. */
export function readUploadSecuritySettlement(value: unknown): UploadSecuritySettlement | null {
  const record = readClosedRecord(value, SETTLEMENT_KEYS);
  if (
    !record ||
    typeof record.writerStopped !== 'boolean' ||
    typeof record.transientDataRemoved !== 'boolean'
  )
    return null;
  const execution = readUploadSecurityExecution(record.execution);
  if (!execution) return null;
  return {
    execution,
    writerStopped: record.writerStopped,
    transientDataRemoved: record.transientDataRemoved,
  };
}

export function matchesUploadSecurityExecution(value: unknown, expected: unknown): boolean {
  const execution = readUploadSecurityExecution(value);
  const identity = readUploadSecurityExecution(expected);
  return (
    execution !== null &&
    identity !== null &&
    EXECUTION_KEYS.every((key) => execution[key] === identity[key])
  );
}

export function isCompleteUploadSecuritySettlement(value: unknown, execution: unknown): boolean {
  const settlement = readUploadSecuritySettlement(value);
  return (
    settlement !== null &&
    settlement.writerStopped &&
    settlement.transientDataRemoved &&
    matchesUploadSecurityExecution(settlement.execution, execution)
  );
}
