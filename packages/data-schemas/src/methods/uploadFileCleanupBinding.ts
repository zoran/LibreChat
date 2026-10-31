/** uploadFileCleanupBinding owns the immutable shared File/Upload original cleanup identity. */
import { isUploadOriginalIntegrity } from 'librechat-data-provider';
import type { FileUploadCleanupBinding } from '../types/fileCleanup';
import type { StoredUpload } from './uploadManagementState';
import { uploadOriginalKey, readStoredUploadPromotion } from './uploadManagementIntake';
import { nasBindingDigest } from './uploadManagementNasState';
import { uploadDigest } from './uploadManagementStore';
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
export function uploadFileCleanupBinding(row: StoredUpload): FileUploadCleanupBinding | null {
  const original = row.original;
  if (
    row.acceptedAt == null ||
    !row.fileId ||
    !positive(row.attemptGeneration) ||
    !positive(row.generation) ||
    !original ||
    original.outcome !== 'durable' ||
    original.storageKey !== uploadOriginalKey(row) ||
    original.bytes !== row.actualBytes ||
    !isUploadOriginalIntegrity(original.integrity, original.bytes)
  )
    return null;
  const promotion = readStoredUploadPromotion(row);
  return {
    tenantId: row.tenantId,
    userId: row.userId,
    fileId: row.fileId,
    operationId: row._id,
    cleanupGeneration: row.generation,
    attemptGeneration: row.attemptGeneration,
    workerGeneration: row.workerGeneration ?? null,
    worker: row.worker ? { ...row.worker } : null,
    promotion: promotion
      ? {
          promotionId: promotion.promotionId,
          generation: promotion.lease.generation,
          worker: { ...promotion.worker },
        }
      : null,
    originalKey: original.storageKey,
    originalSource: original.source,
    originalBytes: original.bytes,
    ...(row.writeBinding?.version === 2
      ? {
          backend: row.writeBinding.backend,
          originalWriteBindingSha256: nasBindingDigest(row.writeBinding),
        }
      : {}),
    acceptedObjectSHA256: uploadDigest([
      'upload-original-receipt-binding-v1',
      {
        tenantId: row.tenantId,
        userId: row.userId,
        operationId: row._id,
        attemptGeneration: row.attemptGeneration,
        key: original.storageKey,
      },
      original,
    ]),
  };
}
