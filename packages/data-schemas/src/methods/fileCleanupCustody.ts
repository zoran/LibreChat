/** Sole File lifecycle custody validation, shared by mutation and completion observation. */
import { createHash } from 'node:crypto';
import {
  isStorageDeletionBinding,
  isStorageDeletionRequest,
  isStorageDeletionResult,
  isStorageDeletionConsumptionResult,
  canonicalStorageDeletionReceipt,
  canonicalManagedJson,
  readNasS3Backend,
} from 'librechat-data-provider';
import type { StorageDeletionBinding } from 'librechat-data-provider';
import type {
  FileCleanupProgress,
  FileLifecycleCustody,
  FileStorageCleanupCustody,
  NasFileStorageCustody,
} from '../types/fileCleanup';
import type { IMongoFile } from '../types/file';
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
    typeof v.contentPrepared !== 'boolean' ||
    (v.storage != null && v.nasStorage !== undefined)
  )
    throw new Pending('invalid_custody');
  assertFileCleanupCustody(value);
  return v;
}

/** NAS custody has its own truthful scope; it can never satisfy the managed storage validator. */
export function validateNasFileStorage(value: FileCleanupProgress): NasFileStorageCustody {
  const l = lifecycle(value),
    n = l.nasStorage;
  const r = n?.receipt;
  if (
    !n ||
    l.storage ||
    !r ||
    !['terminal', 'consumed'].includes(n.state) ||
    r.protocol !== 'nas-acknowledged-delete-v1' ||
    r.scope !== 'nas-live-key-absent' ||
    !readNasS3Backend(r.backend) ||
    !same(r.backend, l.upload.backend) ||
    r.bindingSha256 !== l.upload.originalWriteBindingSha256 ||
    !/^[a-f0-9]{64}$/.test(r.bindingSha256) ||
    r.absenceStatus !== 404 ||
    ![200, 204].includes(r.deleteStatus) ||
    r.originalTerminal !== 'acknowledged' ||
    !/^[a-f0-9-]{36}$/.test(r.requestId) ||
    Object.keys(r).length !== 8 ||
    n.receiptSHA256 !== digest(canonicalManagedJson(r))
  )
    throw new Pending('invalid_nas_receipt');
  if (
    n.state === 'consumed' &&
    (!n.uploadAck ||
      !validId(n.consumerCommitId) ||
      n.uploadAck.operationId !== l.upload.operationId ||
      n.uploadAck.cleanupGeneration !== l.upload.cleanupGeneration ||
      n.uploadAck.attemptGeneration !== l.upload.attemptGeneration ||
      n.uploadAck.revocationId !== value.revocationId ||
      n.uploadAck.receiptSHA256 !== n.receiptSHA256)
  )
    throw new Pending('invalid_nas_consumption');
  return n;
}

/** Shared retained File readiness guard used before removal and final completion. */
export function nasFileCleanupReady(value: FileCleanupProgress, finalize: boolean): boolean {
  try {
    const n = validateNasFileStorage(value),
      l = lifecycle(value);
    return (
      derivativesComplete(value) &&
      (!finalize ||
        (n.state === 'consumed' && l.contentPrepared === true && validId(l.completionRef)))
    );
  } catch {
    return false;
  }
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

/** All cleanup entry paths retain the real File custody, receipt and consumption guard. */
export function fileCleanupReady(file: IMongoFile, finalize: boolean): boolean {
  const p = file.retentionCleanup;
  if (p?.lifecycle?.nasStorage)
    return p.revocationId === file.retentionRevocationId && nasFileCleanupReady(p, finalize);
  const l = p?.lifecycle;
  const s = l?.storage;
  if (
    !p ||
    p.schema !== 1 ||
    p.revocationId !== file.retentionRevocationId ||
    p.capture.complete !== true ||
    p.capture.recoveryUnresolved !== false ||
    typeof p.generationReceiptRef !== 'string' ||
    !p.generationReceiptRef.length ||
    p.generationReceiptRef.length > 256 ||
    !l ||
    l.derivatives.retrieval !== 'complete' ||
    l.derivatives.checkpoints !== 'complete' ||
    l.derivatives.messages !== 'complete' ||
    !s ||
    !['terminal', 'committed', 'consumed'].includes(s.state) ||
    !('receipt' in s) ||
    Buffer.byteLength(JSON.stringify(p)) > 32768
  )
    return false;
  if (
    !isStorageDeletionResult(s.receipt, s.binding) ||
    s.receipt.state !== 'durable_delete_complete' ||
    s.receiptSHA256 !==
      createHash('sha256').update(canonicalStorageDeletionReceipt(s.receipt)).digest('hex')
  )
    return false;
  return (
    !finalize ||
    (s.state === 'consumed' &&
      s.consumption.state === 'recorded' &&
      l.contentPrepared === true &&
      typeof l.completionRef === 'string' &&
      l.completionRef.length > 0 &&
      l.completionRef.length <= 256 &&
      isStorageDeletionConsumptionResult(s.consumption, {
        obligationId: s.receipt.obligationId,
        receiptSHA256: s.receiptSHA256,
        consumerCommitId: s.consumerCommitId,
      }))
  );
}
