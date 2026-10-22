/** Opaque managed-storage deletion protocol. Native inventory never crosses this boundary. */
export type StorageDeletionRequest = {
  protocol: 1;
  requestId: string;
  generation: string;
  authorityBindingSHA256: string;
  acceptedObjectSHA256: string;
  obligationId?: string;
};
export type StorageDeletionBinding = Omit<StorageDeletionRequest, 'obligationId'> & {
  bucket: string;
  key: string;
};
export type StorageDeletionResult = StorageDeletionBinding &
  (
    | { state: 'pending' | 'namespace_absent'; obligationId: string }
    | { state: 'unknown'; obligationId?: string }
    | {
        state: 'durable_delete_complete';
        obligationId: string;
        aggregateRevision: string;
        proofSHA256: string;
      }
  );
export const STORAGE_DELETION_MAX_RESPONSE_BYTES: number = 16384;
const token = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const decimal = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[1-9][0-9]{0,18}$/.test(v) &&
  BigInt(v) <= BigInt('9223372036854775807');
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const requestKeys = [
  'protocol',
  'requestId',
  'generation',
  'authorityBindingSHA256',
  'acceptedObjectSHA256',
];
export function isStorageDeletionRequest(v: unknown): v is StorageDeletionRequest {
  return (
    object(v) &&
    v.protocol === 1 &&
    token(v.requestId) &&
    decimal(v.generation) &&
    digest(v.authorityBindingSHA256) &&
    digest(v.acceptedObjectSHA256) &&
    (v.obligationId === undefined || token(v.obligationId)) &&
    Object.keys(v).every((k) => requestKeys.includes(k) || k === 'obligationId')
  );
}
/** Exact echo prevents a valid receipt for another request/key/generation from settling this one. */
export function isStorageDeletionResult(
  v: unknown,
  expected: StorageDeletionBinding,
  obligationId?: string,
): v is StorageDeletionResult {
  if (!object(v)) return false;
  const bindingKeys = [...requestKeys, 'bucket', 'key'];
  if (!bindingKeys.every((k) => v[k] === expected[k as keyof StorageDeletionBinding])) return false;
  if (obligationId !== undefined && v.obligationId !== obligationId) return false;
  const terminal = v.state === 'durable_delete_complete';
  if (
    typeof v.state !== 'string' ||
    !['pending', 'namespace_absent', 'durable_delete_complete', 'unknown'].includes(v.state)
  )
    return false;
  if (
    v.state !== 'unknown'
      ? !token(v.obligationId)
      : v.obligationId !== undefined && !token(v.obligationId)
  )
    return false;
  if (terminal && (!decimal(v.aggregateRevision) || !digest(v.proofSHA256))) return false;
  const allowed = [
    ...bindingKeys,
    'state',
    'obligationId',
    ...(terminal ? ['aggregateRevision', 'proofSHA256'] : []),
  ];
  return Object.keys(v).every((k) => allowed.includes(k));
}

export type StorageDeletionTerminalReceipt = Extract<
  StorageDeletionResult,
  { state: 'durable_delete_complete' }
>;
export type StorageDeletionConsumption = {
  receipt: StorageDeletionTerminalReceipt;
  consumerCommitId: string;
};
export type StorageDeletionConsumptionResult =
  | { state: 'recorded'; obligationId: string; receiptSHA256: string; consumerCommitId: string }
  | { state: 'unknown' };
export function isStorageDeletionBinding(v: unknown): v is StorageDeletionBinding {
  if (
    !object(v) ||
    typeof v.bucket !== 'string' ||
    !v.bucket ||
    v.bucket.length > 255 ||
    typeof v.key !== 'string' ||
    !v.key ||
    new TextEncoder().encode(v.key).length > 4096
  )
    return false;
  const { bucket: _bucket, key: _key, ...request } = v;
  return (
    isStorageDeletionRequest(request) &&
    request.obligationId === undefined &&
    Object.keys(v).every((k) => [...requestKeys, 'bucket', 'key'].includes(k))
  );
}
/** Primary-selected serialization: flat sorted keys, ordinary JSON escaping, no whitespace. */
export function canonicalStorageDeletionReceipt(receipt: StorageDeletionTerminalReceipt): string {
  const {
    state,
    obligationId: _obligationId,
    aggregateRevision: _aggregateRevision,
    proofSHA256: _proofSHA256,
    ...binding
  } = receipt;
  if (
    !isStorageDeletionBinding(binding) ||
    state !== 'durable_delete_complete' ||
    !isStorageDeletionResult(receipt, binding)
  )
    throw new Error('Invalid terminal deletion receipt');
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(receipt).sort(([a], [b]) => {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
      }),
    ),
  );
}
export function isStorageDeletionConsumptionResult(
  v: unknown,
  expected: {
    obligationId: string;
    receiptSHA256: string;
    consumerCommitId: string;
  },
): v is StorageDeletionConsumptionResult {
  if (!object(v)) return false;
  if (v.state === 'unknown') return Object.keys(v).length === 1;
  return (
    v.state === 'recorded' &&
    token(v.obligationId) &&
    digest(v.receiptSHA256) &&
    token(v.consumerCommitId) &&
    v.obligationId === expected.obligationId &&
    v.receiptSHA256 === expected.receiptSHA256 &&
    v.consumerCommitId === expected.consumerCommitId &&
    Object.keys(v).every((k) =>
      ['state', 'obligationId', 'receiptSHA256', 'consumerCommitId'].includes(k),
    )
  );
}
