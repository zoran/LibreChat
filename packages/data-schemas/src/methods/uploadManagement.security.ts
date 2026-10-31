import {
  uploadOriginalSource,
  hasHistoricalUploadSecurityObligation as oldBound,
} from './uploadManagementState';
/** Private approval binding for the durable upload owner; public rows never expose receipts. */
/** Private approval binding for the durable upload owner; public rows never expose receipts. */
import {
  isUploadOriginalIntegrity,
  readUploadSecurityApproval,
  readHistoricalUploadSecurityApproval,
  readHistoricalUploadSecurityExecution,
  readHistoricalUploadSecuritySettlement,
  matchesHistoricalUploadSecurityExecution,
  matchesHistoricalUploadSecurityApproval,
  isCompleteHistoricalUploadSecuritySettlement,
  matchesCurrentUploadAntivirus,
  matchesUploadSecurityApproval,
  readUploadSecurityExecution,
  matchesUploadSecurityExecution,
  isCompleteUploadSecuritySettlement,
} from 'librechat-data-provider';
import type {
  UploadSecurityApproval,
  UploadSecuritySettlement,
  UploadStorageReceipt,
} from 'librechat-data-provider';
import type { StoredUpload } from './uploadManagementStore';
import { UPLOAD_RECORD_BYTES, UPLOAD_AV_RECORD_BYTES } from 'librechat-data-provider';
import type { GlobalState } from './uploadManagementStore';
import { RESOURCE_MAX, reject } from './uploadManagementStore';
import { uploadOriginalKey } from './uploadManagementState';
import type { UploadAntivirusPolicy, UploadSecurityExecution } from 'librechat-data-provider';
import type { NasAntivirusAdmission } from './uploadManagementNasTypes';

/** Snapshot before the first await: scanner callers must not retain a mutable persisted proof. */
export function captureUploadSecurityApproval(value: unknown): UploadSecurityApproval | undefined {
  return readUploadSecurityApproval(value) ?? undefined;
}

export function readStoredUploadSecurityExecution(
  row: StoredUpload,
): UploadSecurityExecution | null {
  return (
    readUploadSecurityExecution(row.securityExecution) ??
    (oldBound(row) ? readHistoricalUploadSecurityExecution(row.securityExecution) : null)
  );
}
export function hasCompleteUploadSecurityExecution(row: StoredUpload): boolean {
  const execution = readStoredUploadSecurityExecution(row);
  return (
    execution !== null &&
    execution.attemptId === `${row._id}.${row.attemptGeneration}` &&
    (row.mediaType === 'application/pdf'
      ? execution.custody.kind === 'pdf-ocr'
      : execution.custody.kind === 'none') &&
    (execution?.version === 3
      ? isCompleteUploadSecuritySettlement(row.securitySettlement, execution)
      : oldBound(row) &&
        isCompleteHistoricalUploadSecuritySettlement(row.securitySettlement, execution))
  );
}

/** A complete acknowledgement is monotone; separate incomplete observations never combine. */
export function recordUploadSecuritySettlement(
  row: StoredUpload,
  settlement: UploadSecuritySettlement,
): void {
  const current = readStoredUploadSecurityExecution(row);
  if (
    !current ||
    !(current.version === 3
      ? matchesUploadSecurityExecution(current, settlement.execution)
      : oldBound(row) && matchesHistoricalUploadSecurityExecution(current, settlement.execution))
  )
    reject('lease_lost');
  if (
    current.version === 3
      ? isCompleteUploadSecuritySettlement(settlement, current)
      : isCompleteHistoricalUploadSecuritySettlement(settlement, current)
  )
    row.securitySettlement = readHistoricalUploadSecuritySettlement(settlement)!;
}

function hasBoundUploadSecurityApproval(
  row: StoredUpload,
  policySha256: string | undefined,
  now: number,
  approval: unknown = row.securityApproval,
  original: UploadStorageReceipt | undefined = row.original,
): approval is UploadSecurityApproval {
  if (
    typeof policySha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(policySha256) ||
    !original ||
    original.outcome !== 'durable' ||
    original.bytes !== row.declaredBytes ||
    (row.actualBytes != null && row.actualBytes !== original.bytes) ||
    !isUploadOriginalIntegrity(original.integrity, original.bytes) ||
    original.source !== uploadOriginalSource(row) ||
    original.storageKey !== uploadOriginalKey(row)
  )
    return false;
  const execution = readStoredUploadSecurityExecution(row);
  if (
    !execution ||
    (execution.custody.kind === 'pdf-ocr' &&
      execution.custody.scope.documentSha256 !== original.integrity.sha256)
  )
    return false;
  return (
    row.acceptedAt != null ? matchesHistoricalUploadSecurityApproval : matchesUploadSecurityApproval
  )(
    approval,
    {
      tenantId: row.tenantId,
      userId: row.userId,
      operationId: row._id,
      transferGeneration: row.attemptGeneration!,
      mediaType: row.mediaType,
      bytes: original.bytes,
      sha256: original.integrity.sha256,
    },
    policySha256,
    now,
  );
}

export function hasCurrentUploadSecurityApproval(
  row: StoredUpload,
  policySha256: string | undefined,
  now: number,
  approval: unknown = row.securityApproval,
  original: UploadStorageReceipt | undefined = row.original,
): approval is UploadSecurityApproval {
  return (
    hasCompleteUploadSecurityExecution(row) &&
    hasBoundUploadSecurityApproval(row, policySha256, now, approval, original)
  );
}

export function requireUploadSecurityApproval(
  row: StoredUpload,
  policySha256: string | undefined,
  now: number,
  approval: unknown = row.securityApproval,
  original: UploadStorageReceipt | undefined = row.original,
): UploadSecurityApproval {
  if (!hasCurrentUploadSecurityApproval(row, policySha256, now, approval, original))
    reject('security_uninspectable');
  return (
    row.acceptedAt != null
      ? readHistoricalUploadSecurityApproval(approval)
      : readUploadSecurityApproval(approval)
  )!;
}

/** Live imports need current approval; historical tombstones retain cleanup/accounting authority. */
export function validateUploadMigrationSecurity(
  row: StoredUpload,
  policySha256: string | undefined,
  now: number,
): void {
  if (row.securityExecution !== undefined) {
    const execution = readStoredUploadSecurityExecution(row);
    if (
      !execution ||
      execution.attemptId !== `${row._id}.${row.attemptGeneration}` ||
      (!hasCompleteUploadSecurityExecution(row) && !row.cleanupPending)
    )
      reject('migration_conflict');
  }
  if (row.securitySettlement !== undefined && !hasCompleteUploadSecurityExecution(row))
    reject('migration_conflict');
  if (row.securityApproval !== undefined) {
    if (
      !(oldBound(row)
        ? readHistoricalUploadSecurityApproval(row.securityApproval)
        : readUploadSecurityApproval(row.securityApproval)) ||
      row.acceptedAt == null
    )
      reject('migration_conflict');
    // Retained historical proofs still bind their original; a policy change does not erase them.
    if (
      row.original?.integrity &&
      !hasBoundUploadSecurityApproval(row, row.securityApproval.policySha256, now)
    )
      reject('migration_conflict');
  }
  if (
    row.acceptedAt != null &&
    (['queued_processing', 'ready'].includes(row.state) ||
      (row.state === 'failed' && row.originalBytes > 0)) &&
    !hasCurrentUploadSecurityApproval(row, policySha256, now)
  )
    reject('migration_conflict');
}

/** Trusted current AV owner for NAS; this compares actual persisted execution and selected policy. */
export function createNasAntivirusAdmission(policy: UploadAntivirusPolicy): NasAntivirusAdmission {
  const selected = structuredClone(policy);
  return (input) => {
    const a = readUploadSecurityApproval(input.approval);
    const e = readUploadSecurityExecution(input.execution);
    return (
      !!a &&
      !!e &&
      JSON.stringify(a.subject) ===
        JSON.stringify({
          tenantId: input.tenantId,
          userId: input.userId,
          operationId: input.operationId,
          transferGeneration: input.generation,
          mediaType: input.mediaType,
          bytes: input.bytes,
          sha256: input.sha256,
        }) &&
      matchesCurrentUploadAntivirus(a.antivirus, e.antivirus, Date.now(), selected)
    );
  };
}

/** Upgrade only an unaccepted reservation, inside the same serialized row/global transaction. */
export function upgradeUploadAvRecord(row: StoredUpload, global: GlobalState): void {
  if (row.recordBytes === UPLOAD_AV_RECORD_BYTES) return;
  if (
    row.recordBytes !== UPLOAD_RECORD_BYTES ||
    row.acceptedAt != null ||
    !global.reconciled ||
    global.migrationEpoch
  )
    reject('capacity_exceeded');
  const delta = UPLOAD_AV_RECORD_BYTES - row.recordBytes;
  if (
    !Number.isSafeInteger(global.recordBytes) ||
    global.recordBytes < row.recordBytes ||
    global.recordBytes + delta > RESOURCE_MAX.recordBytes
  )
    reject('capacity_exceeded');
  row.recordBytes = UPLOAD_AV_RECORD_BYTES;
  global.recordBytes += delta;
}
