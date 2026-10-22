/** Private technical recovery snapshots. Shape never establishes peer authority or writer exit. */
import type { StorageDeletionBinding, StorageDeletionTerminalReceipt } from './storage-deletion';
import type { UploadSecurityExecution, UploadSecuritySettlement } from './upload-security';
import type { UploadWorker } from './upload-management';
import {
  isCompleteUploadSecuritySettlement,
  matchesUploadSecurityExecution,
  readUploadSecurityExecution,
  readUploadSecuritySettlement,
} from './upload-security';
import { isStorageDeletionBinding, isStorageDeletionResult } from './storage-deletion';

export type UploadIntakeRecoveryBinding = {
  version: 1;
  operationId: string;
  transferGeneration: number;
  worker: UploadWorker;
  capabilitySha256: string;
};

/** Persisted owner accounting commit, never a caller's local-settlement assertion. */
export type UploadOwnerCleanupReceipt = {
  binding: StorageDeletionBinding;
  receipt: StorageDeletionTerminalReceipt;
  receiptSHA256: string;
  consumerCommitId: string;
};

export type UploadIntakeRecovery = {
  version: 1;
  operationId: string;
  transferGeneration: number;
  worker: UploadWorker;
  closed: true;
  acknowledged: boolean;
  storageOutcome: 'not_started' | 'absent' | 'durable' | 'unknown';
  appWriterStopped: boolean;
  cleanupReceipt?: UploadOwnerCleanupReceipt;
  promotion?: { promotionId: string; worker: UploadWorker };
  securityExecution?: UploadSecurityExecution;
  securitySettlement?: UploadSecuritySettlement;
};

/** Local completion does not attest application storage or authorize deletion of an original. */
export type UploadIntakeLocalSettlement = {
  version: 1;
  operationId: string;
  transferGeneration: number;
  worker: UploadWorker;
  localWriterStopped: true;
  localCopiesAbsent: boolean;
  securitySettlement?: UploadSecuritySettlement;
};

type Scope = Omit<UploadIntakeRecoveryBinding, 'capabilitySha256'>;
const SCOPE_KEYS = ['version', 'operationId', 'transferGeneration', 'worker'];

/** Only fixed-depth shapes are visited; descriptors prevent getters and inherited data reads. */
function closed(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length < required.length || keys.length > required.length + optional.length)
      return null;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key)))
        return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value'))
        return null;
      result[key] = descriptor.value;
    }
    return required.every((key) => Object.prototype.hasOwnProperty.call(result, key))
      ? result
      : null;
  } catch {
    return null;
  }
}

// Match the existing intake identifier/worker contract; no extra host or incarnation semantics.
function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    !/[^a-zA-Z0-9_.-]/.test(value)
  );
}

function worker(value: unknown): UploadWorker | null {
  const data = closed(value, ['hostId', 'instanceId']);
  return data && identifier(data.hostId) && identifier(data.instanceId)
    ? { hostId: data.hostId, instanceId: data.instanceId }
    : null;
}

function scope(data: Record<string, unknown>): Scope | null {
  const owner = worker(data.worker);
  return data.version === 1 &&
    identifier(data.operationId) &&
    typeof data.transferGeneration === 'number' &&
    Number.isSafeInteger(data.transferGeneration) &&
    data.transferGeneration > 0 &&
    owner
    ? {
        version: 1,
        operationId: data.operationId,
        transferGeneration: data.transferGeneration,
        worker: owner,
      }
    : null;
}

function bound(execution: UploadSecurityExecution, target: Scope): boolean {
  return execution.attemptId === `${target.operationId}.${target.transferGeneration}`;
}

export function readUploadIntakeRecoveryBinding(
  value: unknown,
): UploadIntakeRecoveryBinding | null {
  const data = closed(value, [...SCOPE_KEYS, 'capabilitySha256']);
  if (
    !data ||
    typeof data.capabilitySha256 !== 'string' ||
    data.capabilitySha256.length !== 64 ||
    /[^a-f0-9]/.test(data.capabilitySha256)
  )
    return null;
  const identity = scope(data);
  return identity ? { ...identity, capabilitySha256: data.capabilitySha256 } : null;
}

function cleanupReceipt(value: unknown, target: Scope): UploadOwnerCleanupReceipt | null {
  const data = closed(value, ['binding', 'receipt', 'receiptSHA256', 'consumerCommitId']);
  if (!data) return null;
  const keys = [
    'protocol',
    'requestId',
    'generation',
    'authorityBindingSHA256',
    'acceptedObjectSHA256',
    'bucket',
    'key',
  ];
  const binding = closed(data.binding, keys);
  const receipt = closed(data.receipt, [
    ...keys,
    'state',
    'obligationId',
    'aggregateRevision',
    'proofSHA256',
  ]);
  if (
    !binding ||
    !receipt ||
    !isStorageDeletionBinding(binding) ||
    !isStorageDeletionResult(receipt, binding) ||
    receipt.state !== 'durable_delete_complete' ||
    binding.generation !== String(target.transferGeneration) ||
    !binding.key.endsWith(`/${target.operationId}.${target.transferGeneration}__original`) ||
    typeof data.receiptSHA256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(data.receiptSHA256) ||
    typeof data.consumerCommitId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(data.consumerCommitId)
  )
    return null;
  return {
    binding: { ...binding },
    receipt: { ...receipt },
    receiptSHA256: data.receiptSHA256,
    consumerCommitId: data.consumerCommitId,
  };
}

export function readUploadIntakeRecovery(value: unknown): UploadIntakeRecovery | null {
  const data = closed(
    value,
    [...SCOPE_KEYS, 'closed', 'acknowledged', 'storageOutcome', 'appWriterStopped'],
    ['promotion', 'securityExecution', 'securitySettlement', 'cleanupReceipt'],
  );
  if (
    !data ||
    data.closed !== true ||
    typeof data.acknowledged !== 'boolean' ||
    typeof data.appWriterStopped !== 'boolean' ||
    (data.storageOutcome !== 'not_started' &&
      data.storageOutcome !== 'absent' &&
      data.storageOutcome !== 'durable' &&
      data.storageOutcome !== 'unknown')
  )
    return null;
  const identity = scope(data);
  if (!identity) return null;
  const cleanup =
    'cleanupReceipt' in data ? cleanupReceipt(data.cleanupReceipt, identity) : undefined;
  if (
    cleanup === null ||
    data.appWriterStopped !== (data.storageOutcome !== 'unknown' || !!cleanup)
  )
    return null;
  let promotion: UploadIntakeRecovery['promotion'];
  if ('promotion' in data) {
    const record = closed(data.promotion, ['promotionId', 'worker']);
    const owner = record && worker(record.worker);
    if (
      !record ||
      !owner ||
      typeof record.promotionId !== 'string' ||
      record.promotionId.length !== 36 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        record.promotionId,
      )
    )
      return null;
    promotion = { promotionId: record.promotionId, worker: owner };
  }
  let securityExecution: UploadSecurityExecution | undefined;
  if ('securityExecution' in data) {
    const execution = readUploadSecurityExecution(data.securityExecution);
    if (!execution || !bound(execution, identity)) return null;
    securityExecution = execution;
  }
  let securitySettlement: UploadSecuritySettlement | undefined;
  if ('securitySettlement' in data) {
    const settlement = readUploadSecuritySettlement(data.securitySettlement);
    if (!settlement || !matchesUploadSecurityExecution(settlement.execution, securityExecution))
      return null;
    securitySettlement = settlement;
  }
  if (
    data.acknowledged &&
    ((data.storageOutcome === 'unknown' && !cleanup) ||
      (securityExecution &&
        !isCompleteUploadSecuritySettlement(securitySettlement, securityExecution)))
  )
    return null;
  return {
    ...identity,
    closed: true,
    acknowledged: data.acknowledged,
    storageOutcome: data.storageOutcome,
    appWriterStopped: data.appWriterStopped,
    ...(cleanup ? { cleanupReceipt: cleanup } : {}),
    ...(promotion ? { promotion } : {}),
    ...(securityExecution ? { securityExecution } : {}),
    ...(securitySettlement ? { securitySettlement } : {}),
  };
}

export function readUploadIntakeLocalSettlement(
  value: unknown,
): UploadIntakeLocalSettlement | null {
  const data = closed(
    value,
    [...SCOPE_KEYS, 'localWriterStopped', 'localCopiesAbsent'],
    ['securitySettlement'],
  );
  if (!data || data.localWriterStopped !== true || typeof data.localCopiesAbsent !== 'boolean')
    return null;
  const identity = scope(data);
  if (!identity) return null;
  let securitySettlement: UploadSecuritySettlement | undefined;
  if ('securitySettlement' in data) {
    const settlement = readUploadSecuritySettlement(data.securitySettlement);
    if (!settlement || !bound(settlement.execution, identity)) return null;
    securitySettlement = settlement;
  }
  return {
    ...identity,
    localWriterStopped: true,
    localCopiesAbsent: data.localCopiesAbsent,
    ...(securitySettlement ? { securitySettlement } : {}),
  };
}
