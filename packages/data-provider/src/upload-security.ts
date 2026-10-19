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
  settlement: UploadSecuritySettlement;
};

/** Original provider identity, never an endpoint, credential or replacement-provider claim. */
export type UploadSecurityProviderBinding = {
  podUid: string;
  containerId: string;
  apiIncarnation: string;
  engineIncarnation: string;
  workerIncarnation: string;
  runtimeImage: string;
  sourceManifestSha256: string;
  modelRevision: string;
  profileSha256: string;
};

/** One inert document scope covers every possible page before content may leave the scanner. */
export type UploadSecurityProviderScope = {
  version: 1;
  scopeId: string;
  attemptId: string;
  scannerInstanceId: string;
  scannerExecutionId: string;
  expiresAt: string;
  providerBinding: UploadSecurityProviderBinding;
  documentSha256: string;
  pageLimit: 32;
  requestIdScheme: 'cortex-ocr-page-sha256-v1';
  /** Original provider wire values in Unix UTC seconds, never renewed or rounded. */
  workDeadline: number;
  cleanupDeadline: number;
};

/** Metadata issued only by the authenticated original provider after its full document join. */
export type UploadSecurityScopeReceipt = {
  version: 1;
  scope: UploadSecurityProviderScope;
  state: 'unknown' | 'retired';
  writerStopped: boolean;
  transientDataRemoved: boolean;
  dispatchedPages: readonly number[];
};

/** One current contract. Ordinary readers never adopt legacy or replacement executions. */
export type UploadSecurityExecution = {
  version: 2;
  attemptId: string;
  instanceId: string;
  executionId: string;
  expiresAt: string;
  custody: { kind: 'none' } | { kind: 'pdf-ocr'; scope: UploadSecurityProviderScope };
};

/** False means unconfirmed, never a successful cancellation or proof that copies were removed. */
export type UploadSecuritySettlement = {
  execution: UploadSecurityExecution;
  writerStopped: boolean;
  transientDataRemoved: boolean;
  /** Required only for PDF; null means the original remote obligation remains unknown. */
  providerReceipt?: UploadSecurityScopeReceipt | null;
};

const EXECUTION_KEYS = [
  'version',
  'attemptId',
  'instanceId',
  'executionId',
  'expiresAt',
  'custody',
] as const;
const PROVIDER_BINDING_KEYS = [
  'podUid',
  'containerId',
  'apiIncarnation',
  'engineIncarnation',
  'workerIncarnation',
  'runtimeImage',
  'sourceManifestSha256',
  'modelRevision',
  'profileSha256',
] as const;
const PROVIDER_SCOPE_KEYS = [
  'version',
  'scopeId',
  'attemptId',
  'scannerInstanceId',
  'scannerExecutionId',
  'expiresAt',
  'providerBinding',
  'documentSha256',
  'pageLimit',
  'requestIdScheme',
  'workDeadline',
  'cleanupDeadline',
] as const;
const SCOPE_RECEIPT_KEYS = [
  'version',
  'scope',
  'state',
  'writerStopped',
  'transientDataRemoved',
  'dispatchedPages',
] as const;
const SETTLEMENT_KEYS = ['execution', 'writerStopped', 'transientDataRemoved'] as const;
const NEGATIVE_DECISION_KEYS = ['version', 'decision', 'reason'] as const;
const INSPECTION_KEYS = ['decision', 'settlement'] as const;
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
  const settlement = readUploadSecuritySettlement(record.settlement);
  if (!settlement || !isCompleteUploadSecuritySettlement(settlement, settlement.execution))
    return null;
  const decision = readDecision(record.decision);
  if (!decision) return null;
  if (
    decision.decision === 'approved' &&
    (settlement.execution.attemptId !==
      `${decision.subject.operationId}.${decision.subject.transferGeneration}` ||
      (decision.subject.mediaType === 'application/pdf') !==
        (settlement.execution.custody.kind === 'pdf-ocr') ||
      (settlement.execution.custody.kind === 'pdf-ocr' &&
        (settlement.execution.custody.scope.documentSha256 !== decision.subject.sha256 ||
          settlement.providerReceipt?.dispatchedPages.length !== decision.coverage.pages ||
          decision.coverage.parts !== 1)))
  )
    return null;
  return { decision, settlement };
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

/** Validate and detach every nested value before any consumer can await or persist it. */
function readProviderScope(
  value: unknown,
  execution: Pick<
    UploadSecurityExecution,
    'attemptId' | 'instanceId' | 'executionId' | 'expiresAt'
  >,
): UploadSecurityProviderScope | null {
  const scope = readClosedRecord(value, PROVIDER_SCOPE_KEYS);
  if (!scope) return null;
  const binding = readClosedRecord(scope.providerBinding, PROVIDER_BINDING_KEYS);
  if (
    !binding ||
    scope.version !== 1 ||
    !identifier(scope.scopeId) ||
    scope.attemptId !== execution.attemptId ||
    scope.scannerInstanceId !== execution.instanceId ||
    scope.scannerExecutionId !== execution.executionId ||
    scope.expiresAt !== execution.expiresAt ||
    !hash(scope.documentSha256) ||
    scope.pageLimit !== 32 ||
    scope.requestIdScheme !== 'cortex-ocr-page-sha256-v1' ||
    typeof scope.workDeadline !== 'number' ||
    !Number.isFinite(scope.workDeadline) ||
    scope.workDeadline <= 0 ||
    typeof scope.cleanupDeadline !== 'number' ||
    !Number.isFinite(scope.cleanupDeadline) ||
    scope.cleanupDeadline < scope.workDeadline ||
    scope.cleanupDeadline > scope.workDeadline + 1 ||
    scope.cleanupDeadline * 1000 > Date.parse(execution.expiresAt) ||
    !identifier(binding.podUid) ||
    !hash(binding.containerId) ||
    !identifier(binding.apiIncarnation) ||
    !identifier(binding.engineIncarnation) ||
    !identifier(binding.workerIncarnation) ||
    typeof binding.runtimeImage !== 'string' ||
    binding.runtimeImage.length > 512 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9./_:-]*@sha256:[a-f0-9]{64}$/.test(binding.runtimeImage) ||
    !hash(binding.sourceManifestSha256) ||
    !hash(binding.profileSha256) ||
    typeof binding.modelRevision !== 'string' ||
    !/^[a-f0-9]{40}$/.test(binding.modelRevision)
  )
    return null;
  return Object.freeze({
    version: 1,
    scopeId: scope.scopeId,
    attemptId: execution.attemptId,
    scannerInstanceId: execution.instanceId,
    scannerExecutionId: execution.executionId,
    expiresAt: execution.expiresAt,
    providerBinding: Object.freeze({
      podUid: binding.podUid,
      containerId: binding.containerId,
      apiIncarnation: binding.apiIncarnation,
      engineIncarnation: binding.engineIncarnation,
      workerIncarnation: binding.workerIncarnation,
      runtimeImage: binding.runtimeImage,
      sourceManifestSha256: binding.sourceManifestSha256,
      modelRevision: binding.modelRevision,
      profileSha256: binding.profileSha256,
    }),
    documentSha256: scope.documentSha256,
    pageLimit: 32,
    requestIdScheme: 'cortex-ocr-page-sha256-v1',
    workDeadline: scope.workDeadline,
    cleanupDeadline: scope.cleanupDeadline,
  });
}

/** Exact original scope only; remote not-found, a new incarnation and partial flags are not clean. */
export function readUploadSecurityScopeReceipt(
  value: unknown,
  execution: UploadSecurityExecution,
): UploadSecurityScopeReceipt | null {
  const original = readUploadSecurityExecution(execution);
  if (!original || original.custody.kind !== 'pdf-ocr') return null;
  const record = readClosedRecord(value, SCOPE_RECEIPT_KEYS);
  if (
    !record ||
    record.version !== 1 ||
    (record.state !== 'unknown' && record.state !== 'retired') ||
    typeof record.writerStopped !== 'boolean' ||
    typeof record.transientDataRemoved !== 'boolean'
  )
    return null;
  const scope = readProviderScope(record.scope, original);
  if (!scope || JSON.stringify(scope) !== JSON.stringify(original.custody.scope)) return null;
  const pages = record.dispatchedPages;
  try {
    if (!Array.isArray(pages) || Object.getPrototypeOf(pages) !== Array.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(pages);
    const length = Object.getOwnPropertyDescriptor(pages, 'length')?.value;
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > 32 ||
      Reflect.ownKeys(descriptors).length !== length + 1
    )
      return null;
    const dispatchedPages: number[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !('value' in descriptor) || descriptor.value !== index + 1) return null;
      dispatchedPages.push(descriptor.value);
    }
    if (record.state === 'retired' && (!record.writerStopped || !record.transientDataRemoved))
      return null;
    return Object.freeze({
      version: 1,
      scope,
      state: record.state,
      writerStopped: record.writerStopped,
      transientDataRemoved: record.transientDataRemoved,
      dispatchedPages: Object.freeze(dispatchedPages),
    });
  } catch {
    return null;
  }
}

/** Shape and snapshot only; callers must authenticate the issuer and enforce their lease clock. */
export function readUploadSecurityExecution(value: unknown): UploadSecurityExecution | null {
  const record = readClosedRecord(value, EXECUTION_KEYS);
  if (
    !record ||
    record.version !== 2 ||
    !executionAttemptId(record.attemptId) ||
    !uuidV4(record.instanceId) ||
    !uuidV4(record.executionId) ||
    !checkedAt(record.expiresAt)
  )
    return null;
  let custody: UploadSecurityExecution['custody'];
  const local = readClosedRecord(record.custody, ['kind']);
  if (local?.kind === 'none') custody = Object.freeze({ kind: 'none' });
  else {
    const remote = readClosedRecord(record.custody, ['kind', 'scope']);
    const scope =
      remote?.kind === 'pdf-ocr'
        ? readProviderScope(remote.scope, {
            attemptId: record.attemptId,
            instanceId: record.instanceId,
            executionId: record.executionId,
            expiresAt: record.expiresAt,
          })
        : null;
    if (!scope) return null;
    custody = Object.freeze({ kind: 'pdf-ocr', scope });
  }
  return Object.freeze({
    version: 2,
    attemptId: record.attemptId,
    instanceId: record.instanceId,
    executionId: record.executionId,
    expiresAt: record.expiresAt,
    custody,
  });
}

/** Preserve unknown outcomes explicitly and detach the nested identity before consumers await. */
export function readUploadSecuritySettlement(value: unknown): UploadSecuritySettlement | null {
  const record =
    readClosedRecord(value, SETTLEMENT_KEYS) ??
    readClosedRecord(value, [...SETTLEMENT_KEYS, 'providerReceipt']);
  if (
    !record ||
    typeof record.writerStopped !== 'boolean' ||
    typeof record.transientDataRemoved !== 'boolean'
  )
    return null;
  const execution = readUploadSecurityExecution(record.execution);
  if (!execution) return null;
  const base = {
    execution,
    writerStopped: record.writerStopped,
    transientDataRemoved: record.transientDataRemoved,
  };
  if (execution.custody.kind === 'none')
    return Object.prototype.hasOwnProperty.call(record, 'providerReceipt') ? null : base;
  if (!Object.prototype.hasOwnProperty.call(record, 'providerReceipt')) return null;
  const providerReceipt =
    record.providerReceipt === null
      ? null
      : readUploadSecurityScopeReceipt(record.providerReceipt, execution);
  if (record.providerReceipt !== null && !providerReceipt) return null;
  return { ...base, providerReceipt };
}

export function matchesUploadSecurityExecution(value: unknown, expected: unknown): boolean {
  const execution = readUploadSecurityExecution(value);
  const identity = readUploadSecurityExecution(expected);
  return (
    execution !== null &&
    identity !== null &&
    // Both operands were reconstructed in canonical key order without invoking getters.
    JSON.stringify(execution) === JSON.stringify(identity)
  );
}

export function isCompleteUploadSecuritySettlement(value: unknown, execution: unknown): boolean {
  const settlement = readUploadSecuritySettlement(value);
  return (
    settlement !== null &&
    settlement.writerStopped &&
    settlement.transientDataRemoved &&
    (settlement.execution.custody.kind === 'none' ||
      settlement.providerReceipt?.state === 'retired') &&
    matchesUploadSecurityExecution(settlement.execution, execution)
  );
}
