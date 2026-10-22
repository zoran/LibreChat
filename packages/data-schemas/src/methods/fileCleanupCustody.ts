/** Sole File lifecycle custody validation, shared by mutation and completion observation. */
import { createHash } from 'node:crypto';
import {
  isStorageDeletionBinding,
  isStorageDeletionRequest,
  isStorageDeletionResult,
  isStorageDeletionConsumptionResult,
  canonicalStorageDeletionReceipt,
  canonicalManagedJson,
} from 'librechat-data-provider';
import type { StorageDeletionBinding } from 'librechat-data-provider';
import type {
  FileCleanupProgress,
  FileLifecycleCustody,
  FileStorageCleanupCustody,
} from '../types/fileCleanup';
import { assertFileCleanupCustody, FileCleanupPending as Pending } from './fileCleanupAuthority';
export const digest = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');
export const same = (a: unknown, b: unknown): boolean =>
  canonicalManagedJson(a) === canonicalManagedJson(b);
export const validId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 256;
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
export function lifecycle(value: FileCleanupProgress): FileLifecycleCustody {
  const v = value.lifecycle;
  if (
    !v ||
    !validId(v.upload?.operationId) ||
    !positive(v.upload.attemptGeneration) ||
    !positive(v.upload.cleanupGeneration) ||
    !/^[a-f0-9]{64}$/.test(v.upload.acceptedObjectSHA256) ||
    !validId(v.upload.originalSource) ||
    typeof v.upload.originalKey !== 'string' ||
    Buffer.byteLength(v.upload.originalKey) > 4096 ||
    !Number.isSafeInteger(v.upload.originalBytes) ||
    v.upload.originalBytes < 0 ||
    !['pending', 'complete'].includes(v.derivatives?.retrieval) ||
    !['pending', 'complete'].includes(v.derivatives?.checkpoints) ||
    !['pending', 'complete'].includes(v.derivatives?.messages) ||
    typeof v.contentPrepared !== 'boolean'
  )
    throw new Pending('invalid_custody');
  assertFileCleanupCustody(value);
  return v;
}
export function derivativesComplete(value: FileCleanupProgress): boolean {
  const v = lifecycle(value);
  return (
    value.capture.complete === true &&
    value.capture.recoveryUnresolved === false &&
    validId(value.generationReceiptRef) &&
    v.derivatives.retrieval === 'complete' &&
    v.derivatives.checkpoints === 'complete' &&
    v.derivatives.messages === 'complete'
  );
}
/** Reserve the worst allowed terminal/ACK/consumption envelope before the first storage effect. */
export function assertFileStorageHeadroom(
  value: FileCleanupProgress,
  binding: StorageDeletionBinding,
): void {
  const v = lifecycle(value);
  const receipt = {
    ...binding,
    state: 'durable_delete_complete' as const,
    obligationId: 'x'.repeat(128),
    aggregateRevision: '9223372036854775807',
    proofSHA256: 'a'.repeat(64),
  };
  const request = {
    protocol: binding.protocol,
    requestId: binding.requestId,
    generation: binding.generation,
    authorityBindingSHA256: binding.authorityBindingSHA256,
    acceptedObjectSHA256: binding.acceptedObjectSHA256,
  };
  assertFileCleanupCustody({
    ...value,
    lifecycle: {
      ...v,
      completionRef: 'file:' + 'x'.repeat(36),
      storage: {
        state: 'consumed',
        request,
        binding,
        receipt,
        receiptSHA256: 'a'.repeat(64),
        consumerCommitId: 'x'.repeat(128),
        uploadAck: {
          reference: '\ud800'.repeat(256),
          operationId: v.upload.operationId,
          cleanupGeneration: v.upload.cleanupGeneration,
          attemptGeneration: v.upload.attemptGeneration,
          revocationId: value.revocationId,
          receiptSHA256: 'a'.repeat(64),
        },
        consumption: {
          state: 'recorded',
          obligationId: 'x'.repeat(128),
          receiptSHA256: 'a'.repeat(64),
          consumerCommitId: 'x'.repeat(128),
        },
      },
    },
  });
}
export function validateStorage(value: FileCleanupProgress): FileStorageCleanupCustody {
  const storage = lifecycle(value).storage;
  if (
    !storage ||
    !isStorageDeletionRequest(storage.request) ||
    storage.request.obligationId !== undefined
  )
    throw new Pending('invalid_storage_custody');
  if (!['binding', 'observing', 'terminal', 'committed', 'consumed'].includes(storage.state))
    throw new Pending('invalid_storage_custody');
  if (
    storage.request.generation !== String(lifecycle(value).upload.attemptGeneration) ||
    storage.request.acceptedObjectSHA256 !== lifecycle(value).upload.acceptedObjectSHA256
  )
    throw new Pending('invalid_storage_custody');
  if (storage.state === 'binding') return storage;
  if (
    !isStorageDeletionBinding(storage.binding) ||
    !same(storage.request, {
      protocol: storage.binding.protocol,
      requestId: storage.binding.requestId,
      generation: storage.binding.generation,
      authorityBindingSHA256: storage.binding.authorityBindingSHA256,
      acceptedObjectSHA256: storage.binding.acceptedObjectSHA256,
    })
  )
    throw new Pending('invalid_storage_custody');
  assertFileStorageHeadroom(value, storage.binding);
  if (storage.state === 'observing') return storage;
  if (
    !isStorageDeletionResult(storage.receipt, storage.binding) ||
    storage.receipt.state !== 'durable_delete_complete' ||
    storage.receiptSHA256 !== digest(canonicalStorageDeletionReceipt(storage.receipt))
  )
    throw new Pending('invalid_receipt');
  if (
    storage.state === 'consumed' &&
    (storage.consumption.state !== 'recorded' ||
      !isStorageDeletionConsumptionResult(storage.consumption, {
        obligationId: storage.receipt.obligationId,
        receiptSHA256: storage.receiptSHA256,
        consumerCommitId: storage.consumerCommitId,
      }))
  )
    throw new Pending('invalid_consumption');
  return storage;
}
