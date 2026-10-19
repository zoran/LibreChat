/** Private approval binding for the durable upload owner; public rows never expose receipts. */
import {
  isUploadOriginalIntegrity,
  isUploadSecurityApproval,
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
import { reject } from './uploadManagementStore';

/** Snapshot before the first await: scanner callers must not retain a mutable persisted proof. */
export function captureUploadSecurityApproval(value: unknown): UploadSecurityApproval | undefined {
  if (!isUploadSecurityApproval(value)) return undefined;
  return { ...value, subject: { ...value.subject }, coverage: { ...value.coverage } };
}

export function hasCompleteUploadSecurityExecution(row: StoredUpload): boolean {
  const execution = readUploadSecurityExecution(row.securityExecution);
  return (
    execution !== null &&
    execution.attemptId === `${row._id}.${row.attemptGeneration}` &&
    (row.mediaType === 'application/pdf'
      ? execution.custody.kind === 'pdf-ocr'
      : execution.custody.kind === 'none') &&
    isCompleteUploadSecuritySettlement(row.securitySettlement, execution)
  );
}

/** A complete acknowledgement is monotone; separate incomplete observations never combine. */
export function recordUploadSecuritySettlement(
  row: StoredUpload,
  settlement: UploadSecuritySettlement,
): void {
  if (!matchesUploadSecurityExecution(row.securityExecution, settlement.execution))
    reject('lease_lost');
  if (isCompleteUploadSecuritySettlement(settlement, row.securityExecution!))
    row.securitySettlement = settlement;
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
    original.source !== 's3' ||
    original.storageKey !==
      `${row.tenantId === null ? '' : `t/${row.tenantId}/`}managed-uploads/${row.userId}/${row._id}.${row.attemptGeneration}__original`
  )
    return false;
  const execution = readUploadSecurityExecution(row.securityExecution);
  if (
    !execution ||
    (execution.custody.kind === 'pdf-ocr' &&
      execution.custody.scope.documentSha256 !== original.integrity.sha256)
  )
    return false;
  return matchesUploadSecurityApproval(
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
  return captureUploadSecurityApproval(approval)!;
}

/** Live imports need current approval; historical tombstones retain cleanup/accounting authority. */
export function validateUploadMigrationSecurity(
  row: StoredUpload,
  policySha256: string | undefined,
  now: number,
): void {
  if (row.securityExecution !== undefined) {
    const execution = readUploadSecurityExecution(row.securityExecution);
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
    if (!isUploadSecurityApproval(row.securityApproval) || row.acceptedAt == null)
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
