/** Private scanner receipt data. Validation binds a receipt; only trusted server owners may issue it. */
import type {
  UploadAntivirusCustody,
  UploadAntivirusApproval,
  UploadAntivirusReceipt,
} from './upload-antivirus';
import {
  readClosedRecord,
  identifier,
  hash,
  positiveInteger,
  scannerVersion,
  checkedAt,
  uuidV4,
  readUploadSecuritySubject,
} from './upload-security-data';
import {
  readUploadAntivirusCustody,
  readUploadAntivirusApproval,
  readUploadAntivirusReceipt,
} from './upload-antivirus';

export { readUploadSecuritySubject } from './upload-security-data';

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

export type LegacyUploadSecurityApproval = {
  version: 1;
  decision: 'approved';
  policySha256: string;
  subject: UploadSecuritySubject;
  scannerVersion: string;
  checkedAt: string;
  coverage: { complete: true; pages: number; parts: number };
};

/** Current authenticated scanner approval; version1 is retained only for old-bound obligations. */
export type CurrentUploadSecurityApproval = Omit<LegacyUploadSecurityApproval, 'version'> & {
  version: 2;
  antivirus: UploadAntivirusApproval;
};
export type UploadSecurityApproval = LegacyUploadSecurityApproval | CurrentUploadSecurityApproval;

export type UploadSecurityReason =
  | 'classification_marking'
  | 'incomplete_coverage'
  | 'unsupported_format'
  | 'encrypted'
  | 'active_content'
  | 'invalid_content'
  | 'resource_limit'
  | 'scanner_unavailable'
  | 'ambiguous_marking'
  | 'malware';

export type UploadSecurityDecision =
  | UploadSecurityApproval
  | { version: 1; decision: 'rejected'; reason: 'classification_marking' | 'malware' }
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
export type LegacyUploadSecurityExecution = {
  version: 2;
  attemptId: string;
  instanceId: string;
  executionId: string;
  expiresAt: string;
  custody: { kind: 'none' } | { kind: 'pdf-ocr'; scope: UploadSecurityProviderScope };
};

/** Current per-document execution includes the bound original AV process/generation. */
export type CurrentUploadSecurityExecution = Omit<LegacyUploadSecurityExecution, 'version'> & {
  version: 3;
  antivirus: UploadAntivirusCustody;
};
export type UploadSecurityExecution =
  | LegacyUploadSecurityExecution
  | CurrentUploadSecurityExecution;

/** False means unconfirmed, never a successful cancellation or proof that copies were removed. */
export type UploadSecuritySettlement = {
  execution: UploadSecurityExecution;
  writerStopped: boolean;
  transientDataRemoved: boolean;
  /** Required only for PDF; null means the original remote obligation remains unknown. */
  providerReceipt?: UploadSecurityScopeReceipt | null;
  /** Mandatory for current executions; null explicitly retains unknown AV retirement. */
  antivirusReceipt?: UploadAntivirusReceipt | null;
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
  'malware',
];

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
function readApproval(value: unknown, historical = false): UploadSecurityApproval | null {
  const record =
    readClosedRecord(value, [...APPROVAL_KEYS, 'antivirus']) ??
    (historical ? readClosedRecord(value, APPROVAL_KEYS) : null);
  if (
    !record ||
    (record.version !== 2 && !(historical && record.version === 1)) ||
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
  const base = {
    decision: 'approved' as const,
    policySha256: record.policySha256,
    subject,
    scannerVersion: record.scannerVersion,
    checkedAt: record.checkedAt,
    coverage: { complete: true as const, pages: coverage.pages, parts: coverage.parts },
  };
  if (record.version === 1) return { version: 1, ...base };
  const antivirus = readUploadAntivirusApproval(record.antivirus);
  if (
    !antivirus ||
    JSON.stringify(antivirus.custody.subject) !== JSON.stringify(subject) ||
    Date.parse(antivirus.cleanAt) > Date.parse(base.checkedAt) ||
    Date.parse(base.checkedAt) > Date.parse(antivirus.custody.expiresAt)
  )
    return null;
  return { version: 2, ...base, antivirus };
}

function readDecision(value: unknown): UploadSecurityDecision | null {
  const approval = readApproval(value);
  if (approval) return approval;
  const record = readClosedRecord(value, NEGATIVE_DECISION_KEYS);
  if (!record || record.version !== 1) return null;
  if (
    record.decision === 'rejected' &&
    ['classification_marking', 'malware'].includes(String(record.reason))
  )
    return {
      version: 1,
      decision: 'rejected',
      reason: record.reason as 'classification_marking' | 'malware',
    };
  const reason = SECURITY_REASONS.find((reason) => reason === record.reason);
  if (record.decision === 'uninspectable' && reason && reason !== 'malware')
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
  if (
    decision.decision === 'approved' &&
    (decision.version !== 2 ||
      settlement.execution.version !== 3 ||
      JSON.stringify(decision.antivirus.custody) !== JSON.stringify(settlement.execution.antivirus))
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

/** Current approval snapshot, with complete AV custody, never a classification-only fallback. */
export function readUploadSecurityApproval(value: unknown): CurrentUploadSecurityApproval | null {
  const a = readApproval(value);
  return a?.version === 2 ? a : null;
}
/** Retained old evidence reader; callers must independently prove an old-bound obligation. */
export function readHistoricalUploadSecurityApproval(
  value: unknown,
): UploadSecurityApproval | null {
  return readApproval(value, true);
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
    approval.version === 2 &&
    now <= Date.parse(approval.antivirus.custody.expiresAt) &&
    JSON.stringify(approval.subject) === JSON.stringify(expected)
  );
}

function executionAttemptId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 144) return false;
  const match = /^[a-zA-Z0-9_-]{1,128}\.[1-9][0-9]{0,14}$/.exec(value);
  return match?.[0] === value;
}

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
  const original = readHistoricalUploadSecurityExecution(execution);
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
function readExecution(value: unknown, historical = false): UploadSecurityExecution | null {
  const record =
    readClosedRecord(value, [...EXECUTION_KEYS, 'antivirus']) ??
    (historical ? readClosedRecord(value, EXECUTION_KEYS) : null);
  if (
    !record ||
    (record.version !== 3 && !(historical && record.version === 2)) ||
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
  const base = {
    attemptId: record.attemptId,
    instanceId: record.instanceId,
    executionId: record.executionId,
    expiresAt: record.expiresAt,
    custody,
  };
  if (record.version === 2) return Object.freeze({ version: 2, ...base });
  const antivirus = readUploadAntivirusCustody(record.antivirus);
  if (
    !antivirus ||
    antivirus.expiresAt !== record.expiresAt ||
    `${antivirus.subject.operationId}.${antivirus.subject.transferGeneration}` !==
      record.attemptId ||
    (custody.kind === 'pdf-ocr' && custody.scope.documentSha256 !== antivirus.subject.sha256)
  )
    return null;
  return Object.freeze({ version: 3, ...base, antivirus });
}

/** Current native worker protocol; legacy executions cannot start or approve a new write. */
export function readUploadSecurityExecution(value: unknown): CurrentUploadSecurityExecution | null {
  const e = readExecution(value);
  return e?.version === 3 ? e : null;
}
/** Explicit retained-protocol reader for genuinely old-bound actor/storage obligations. */
export function readHistoricalUploadSecurityExecution(
  value: unknown,
): UploadSecurityExecution | null {
  return readExecution(value, true);
}

/** Preserve unknown outcomes explicitly and detach the nested identity before consumers await. */
function readSettlement(value: unknown, historical = false): UploadSecuritySettlement | null {
  const record =
    readClosedRecord(value, [...SETTLEMENT_KEYS, 'antivirusReceipt']) ??
    readClosedRecord(value, [...SETTLEMENT_KEYS, 'providerReceipt', 'antivirusReceipt']) ??
    (historical
      ? (readClosedRecord(value, SETTLEMENT_KEYS) ??
        readClosedRecord(value, [...SETTLEMENT_KEYS, 'providerReceipt']))
      : null);
  if (
    !record ||
    typeof record.writerStopped !== 'boolean' ||
    typeof record.transientDataRemoved !== 'boolean'
  )
    return null;
  const execution = readExecution(record.execution, historical);
  if (!execution) return null;
  let antivirusReceipt: ReturnType<typeof readUploadAntivirusReceipt> | undefined;
  if (execution.version === 3) {
    antivirusReceipt = null;
    if (record.antivirusReceipt !== null)
      antivirusReceipt = readUploadAntivirusReceipt(record.antivirusReceipt, execution.antivirus);
  }
  if (
    execution.version === 3 &&
    (!Object.prototype.hasOwnProperty.call(record, 'antivirusReceipt') ||
      (record.antivirusReceipt !== null && !antivirusReceipt))
  )
    return null;
  if (execution.version === 2 && Object.prototype.hasOwnProperty.call(record, 'antivirusReceipt'))
    return null;
  const base = {
    execution,
    writerStopped: record.writerStopped,
    transientDataRemoved: record.transientDataRemoved,
    ...(execution.version === 3 ? { antivirusReceipt } : {}),
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

/** Current retirement requires an explicit AV receipt/null and the exact full execution. */
export function readUploadSecuritySettlement(value: unknown): UploadSecuritySettlement | null {
  return readSettlement(value);
}
/** Retained cleanup never synthesizes a current AV receipt for an old execution. */
export function readHistoricalUploadSecuritySettlement(
  value: unknown,
): UploadSecuritySettlement | null {
  return readSettlement(value, true);
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
    settlement.antivirusReceipt?.state === 'retired' &&
    settlement.antivirusReceipt.originalProcessJoined &&
    settlement.antivirusReceipt.ownedTransientDataRemoved &&
    (settlement.execution.custody.kind === 'none' ||
      settlement.providerReceipt?.state === 'retired') &&
    matchesUploadSecurityExecution(settlement.execution, execution)
  );
}

/** Historical equality is never new-dispatch authority; it preserves original cleanup identity. */
export function matchesHistoricalUploadSecurityExecution(
  value: unknown,
  expected: unknown,
): boolean {
  const e = readExecution(value, true),
    original = readExecution(expected, true);
  return !!e && !!original && JSON.stringify(e) === JSON.stringify(original);
}
export function isCompleteHistoricalUploadSecuritySettlement(
  value: unknown,
  execution: unknown,
): boolean {
  const s = readSettlement(value, true);
  return (
    !!s &&
    s.writerStopped &&
    s.transientDataRemoved &&
    (s.execution.custody.kind === 'none' || s.providerReceipt?.state === 'retired') &&
    (s.execution.version === 2 ||
      (s.antivirusReceipt?.state === 'retired' &&
        s.antivirusReceipt.originalProcessJoined &&
        s.antivirusReceipt.ownedTransientDataRemoved)) &&
    matchesHistoricalUploadSecurityExecution(s.execution, execution)
  );
}
export function matchesHistoricalUploadSecurityApproval(
  value: unknown,
  subject: UploadSecuritySubject,
  policySha256: string,
  now: number,
): boolean {
  const a = readApproval(value, true),
    scope = readUploadSecuritySubject(subject);
  return (
    !!a &&
    !!scope &&
    a.policySha256 === policySha256 &&
    JSON.stringify(a.subject) === JSON.stringify(scope) &&
    Date.parse(a.checkedAt) <= now
  );
}
