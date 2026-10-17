/** Private approval binding for the durable upload owner; public rows never expose receipts. */
import {
  isUploadOriginalIntegrity,
  isUploadSecurityApproval,
  matchesUploadSecurityApproval,
} from 'librechat-data-provider';
import type { UploadSecurityApproval, UploadStorageReceipt } from 'librechat-data-provider';
import type { StoredUpload } from './uploadManagementStore';
import { reject } from './uploadManagementStore';

/** Snapshot before the first await: scanner callers must not retain a mutable persisted proof. */
export function captureUploadSecurityApproval(value: unknown): UploadSecurityApproval | undefined {
  if (!isUploadSecurityApproval(value)) return undefined;
  return { ...value, subject: { ...value.subject }, coverage: { ...value.coverage } };
}

export function hasCurrentUploadSecurityApproval(
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
  if (row.securityApproval !== undefined) {
    if (!isUploadSecurityApproval(row.securityApproval) || row.acceptedAt == null)
      reject('migration_conflict');
    // Retained historical proofs still bind their original; a policy change does not erase them.
    if (
      row.original?.integrity &&
      !hasCurrentUploadSecurityApproval(row, row.securityApproval.policySha256, now)
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
