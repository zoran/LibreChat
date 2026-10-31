/** uploadManagementNasState validates persisted NAS custody; no transport or receipt-issuing authority. */
import { createHash } from 'node:crypto';
import { isUploadOriginalIntegrity, readNasUploadWriteBinding } from 'librechat-data-provider';
import type { NasUploadWriteBinding, UploadStorageReceipt } from 'librechat-data-provider';
import type { StoredUpload } from './uploadManagementState';
import { uploadDigest } from './uploadManagementState';
import { reject } from './uploadManagementState';

/** Canonical immutable binding is selected by its closed reader before hashing. */
export const nasBindingDigest = (binding: NasUploadWriteBinding): string =>
  createHash('sha256')
    .update(JSON.stringify(readNasUploadWriteBinding(binding)))
    .digest('hex');
const stamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

/** Unknown/lost ACK remains nonterminal even after every local actor has stopped. */
export function hasNasOriginalTerminal(row: StoredUpload): boolean {
  const original = row.originalWrite;
  return (
    row.writeBinding?.version === 2 &&
    !!original &&
    (original.state === 'not-dispatched' ||
      ((original.state === 'acknowledged' || original.state === 'verified') &&
        original.response?.status === 200 &&
        stamp(original.acknowledgedAt)))
  );
}

/** Consumption is assigned only inside the existing repository/File transaction. */
export function hasNasCleanupCompletion(row: StoredUpload): boolean {
  const n = row.cleanupCustody?.nas;
  return (
    hasNasOriginalTerminal(row) &&
    !!n &&
    n.state === 'consumed' &&
    typeof n.consumerCommitId === 'string' &&
    uuid(n.consumerCommitId) &&
    !!n.receipt &&
    n.receipt.bindingSha256 === nasBindingDigest(row.writeBinding as NasUploadWriteBinding) &&
    n.receipt.requestId === n.requestId &&
    n.receipt.protocol === 'nas-acknowledged-delete-v1' &&
    n.receipt.scope === 'nas-live-key-absent' &&
    n.receipt.absenceStatus === 404 &&
    (n.receipt.deleteStatus === 200 || n.receipt.deleteStatus === 204)
  );
}

/** Only the original recorder's persisted ACK and full verification authorize NAS publication. */
export function assertNasOriginalPublication(
  row: StoredUpload,
  receipt?: UploadStorageReceipt,
  now: number = Date.now(),
): void {
  if (row.writeBinding?.version !== 2) {
    if (receipt?.backend) reject('storage_uncertain');
    return;
  }
  validateNasUploadState(row);
  const binding = row.writeBinding;
  if (row.acceptedAt === undefined && now > Date.parse(binding.originalDeadline))
    reject('storage_uncertain');
  if (
    !receipt ||
    row.originalWrite?.state !== 'verified' ||
    receipt.outcome !== 'durable' ||
    receipt.source !== 'nas-s3' ||
    receipt.storageKey !== binding.key ||
    receipt.bytes !== binding.bytes ||
    !receipt.backend ||
    JSON.stringify(receipt.backend) !== JSON.stringify(binding.backend) ||
    !isUploadOriginalIntegrity(receipt.integrity, binding.bytes) ||
    receipt.integrity.sha256 !== binding.wholeSHA256 ||
    uploadDigest(receipt.integrity) !== row.originalWrite.integritySha256 ||
    receipt.versionId !== undefined
  )
    reject('storage_uncertain');
}

/** Import cannot turn an old record, local timeout or caller boolean into an original ACK. */
export function validateNasUploadState(row: StoredUpload): void {
  if (row.writeBinding?.version !== 2) {
    if (row.originalWrite || row.cleanupCustody?.nas || row.original?.backend)
      reject('migration_conflict');
    return;
  }
  const binding = readNasUploadWriteBinding(row.writeBinding);
  const original = row.originalWrite;
  if (
    !binding ||
    !original ||
    original.version !== 1 ||
    !uuid(original.dispatchId) ||
    original.bindingSha256 !== nasBindingDigest(binding) ||
    !stamp(original.intendedAt) ||
    binding.operationId !== row._id ||
    binding.generation !== String(row.attemptGeneration) ||
    binding.bytes !== row.declaredBytes ||
    binding.mediaType !== row.mediaType ||
    !['intended', 'unknown', 'acknowledged', 'verified', 'not-dispatched'].includes(
      original.state,
    ) ||
    Object.keys(original).some(
      (k) =>
        ![
          'version',
          'dispatchId',
          'bindingSha256',
          'state',
          'intendedAt',
          'acknowledgedAt',
          'verifiedAt',
          'integritySha256',
          'response',
        ].includes(k),
    )
  )
    reject('migration_conflict');
  if (original.state === 'acknowledged' || original.state === 'verified') {
    const response = original.response;
    if (
      !response ||
      response.status !== 200 ||
      !stamp(response.observedAt) ||
      !stamp(original.acknowledgedAt) ||
      response.observedAt !== original.acknowledgedAt ||
      Object.keys(response).sort().join(',') !== 'etag,observedAt,requestId,status,versionId' ||
      [response.requestId, response.etag, response.versionId].some(
        (v) => v !== null && (typeof v !== 'string' || v.length > 1024 || /[\r\n]/.test(v)),
      )
    )
      reject('migration_conflict');
  } else if (
    original.response ||
    original.acknowledgedAt !== undefined ||
    original.verifiedAt !== undefined ||
    original.integritySha256
  )
    reject('migration_conflict');
  if (original.state === 'verified') {
    if (
      !stamp(original.verifiedAt) ||
      original.response?.versionId !== null ||
      typeof original.integritySha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(original.integritySha256)
    )
      reject('migration_conflict');
  } else if (original.verifiedAt !== undefined || original.integritySha256)
    reject('migration_conflict');
  if (
    row.original?.backend &&
    JSON.stringify(row.original.backend) !== JSON.stringify(binding.backend)
  )
    reject('migration_conflict');
  if (row.acceptedAt !== undefined && (!row.original?.backend || original.state !== 'verified'))
    reject('migration_conflict');
  const custody = row.cleanupCustody;
  if (
    custody &&
    (custody.version !== 1 ||
      Object.keys(custody).some(
        (k) => !['version', 'nas', 'acceptedFileAck', 'retiredAt', 'promotionLocal'].includes(k),
      ))
  )
    reject('migration_conflict');
  if (
    custody?.request ||
    custody?.binding ||
    custody?.receipt ||
    custody?.consumed ||
    custody?.obligationId ||
    custody?.receiptSHA256 ||
    custody?.consumerCommitId
  )
    reject('migration_conflict');
  const n = custody?.nas;
  if (!n) return;
  if (
    n.version !== 1 ||
    !uuid(n.requestId) ||
    n.bindingSha256 !== nasBindingDigest(binding) ||
    !['intended', 'unknown', 'deleted', 'observed', 'consumed'].includes(n.state) ||
    !hasNasOriginalTerminal(row) ||
    Object.keys(n).some(
      (k) =>
        ![
          'version',
          'requestId',
          'state',
          'bindingSha256',
          'deleteStatus',
          'receipt',
          'consumerCommitId',
        ].includes(k),
    )
  )
    reject('migration_conflict');
  if (['deleted', 'observed', 'consumed'].includes(n.state)) {
    if (n.deleteStatus !== 200 && n.deleteStatus !== 204) reject('migration_conflict');
  } else if (n.deleteStatus !== undefined || n.receipt || n.consumerCommitId)
    reject('migration_conflict');
  if (n.state === 'observed' || n.state === 'consumed') {
    const receipt = n.receipt;
    if (
      !receipt ||
      receipt.protocol !== 'nas-acknowledged-delete-v1' ||
      receipt.scope !== 'nas-live-key-absent' ||
      receipt.requestId !== n.requestId ||
      receipt.bindingSha256 !== n.bindingSha256 ||
      receipt.deleteStatus !== n.deleteStatus ||
      receipt.absenceStatus !== 404 ||
      receipt.originalTerminal !==
        (original.state === 'not-dispatched' ? 'not-dispatched' : 'acknowledged') ||
      JSON.stringify(receipt.backend) !== JSON.stringify(binding.backend) ||
      Object.keys(receipt).length !== 8
    )
      reject('migration_conflict');
  } else if (n.receipt || n.consumerCommitId) reject('migration_conflict');
  if (n.state === 'consumed' ? !hasNasCleanupCompletion(row) : n.consumerCommitId !== undefined)
    reject('migration_conflict');
}
