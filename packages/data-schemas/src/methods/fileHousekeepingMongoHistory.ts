/** File/Upload-owned classification of raw historical rows; no deadline or reservation normalization. */
import { isUploadPrincipal, isUploadStorageReceipt } from 'librechat-data-provider';
import type {
  FileCoveragePopulation,
  FileHistoryAccounting,
  FileHistoryEntry,
  FileHistoryOwner,
  FileHistoryPrincipal,
  FileHistoryScope,
} from 'librechat-data-provider';
import type { StoredUpload } from './uploadManagementState';
import {
  validateUploadCleanupCustody,
  hasUploadActorClosure,
  hasUploadAcceptedFileAck,
} from './uploadCleanupReceipts';
import {
  entryHistoryAccounting,
  recordHistoryBytes,
  addInteger,
} from './fileHousekeepingHistoryAccounting';
import { digest, integer, taggedSource } from './fileHousekeepingData';

export type MongoHistoryObservation = {
  row: Record<string, unknown>;
  classification: 'retained' | 'excluded' | 'unknown';
  linkedFileKnown: boolean;
  linkedUploadOwner?: FileHistoryOwner;
};
export type MongoHistoryLeaf = {
  entry: FileHistoryEntry;
  accounting: FileHistoryAccounting;
  queueCount: number;
  population: FileCoveragePopulation;
  source: unknown;
};
type MutablePopulation = { -readonly [K in keyof FileCoveragePopulation]: number };
const emptyPopulation = (): MutablePopulation => ({
  filesSeen: 0,
  retainedFiles: 0,
  excludedFiles: 0,
  fileJobsSeen: 0,
  unclassifiedFiles: 0,
  unclassifiedJobs: 0,
});
const valueString = (v: unknown): string | null => {
  if (typeof v === 'string') return v;
  const bson = v as { _bsontype?: string; toHexString?: () => string } | null;
  return bson?._bsontype === 'ObjectId' ? bson.toHexString!() : null;
};
function principal(row: Record<string, unknown>, file: boolean): FileHistoryPrincipal {
  const userId = valueString(file ? row.user : row.userId),
    tenantId = row.tenantId;
  if (
    Object.prototype.hasOwnProperty.call(row, 'tenantId') &&
    userId &&
    isUploadPrincipal({
      tenantId,
      userId,
      authentication: tenantId === null ? 'guest' : 'verified-email',
    })
  )
    return { kind: 'resolved', tenantId: tenantId as string | null, userId };
  return {
    kind: 'unresolved',
    rawSha256: digest(taggedSource({ tenantId, user: file ? row.user : row.userId })),
  };
}
function sumKnown(values: unknown[]): number | null {
  if (!values.every(integer)) return null;
  return values.reduce<number>((sum, value) => addInteger(sum, value as number), 0);
}
export function mongoHistoryLeaf(
  scope: Extract<FileHistoryScope, { kind: 'mongo' }>,
  observation: MongoHistoryObservation,
): MongoHistoryLeaf {
  const { row, classification } = observation;
  const source = taggedSource(row),
    sourceRevision = digest(source);
  const file = scope.collection === 'files',
    upload = scope.collection === 'uploads';
  const persistedId = valueString(row._id);
  if (!persistedId) throw new Error('FILE_HISTORY_UNCLASSIFIED');
  let p =
    scope.collection === 'file-jobs'
      ? principal(
          {
            tenantId: (row.work as { subject?: { tenantId?: unknown } })?.subject?.tenantId,
            userId: (row.work as { subject?: { ownerUserId?: unknown } })?.subject?.ownerUserId,
          },
          false,
        )
      : principal(row, file);
  if (observation.linkedUploadOwner?.kind === 'upload')
    p = {
      kind: 'resolved',
      tenantId: observation.linkedUploadOwner.tenantId,
      userId: observation.linkedUploadOwner.userId,
    };
  let revision: unknown;
  if (file) revision = row.retentionRevision;
  else if (upload) revision = row.revision;
  else revision = row.progressRevision;
  const generation = file ? row.retentionRevision : row.generation;
  let owner: FileHistoryOwner = { kind: 'unresolved' };
  if (p.kind === 'resolved' && integer(revision)) {
    if (file && typeof row.file_id === 'string')
      owner = {
        kind: 'file',
        storeId: scope.storeId,
        tenantId: p.tenantId,
        userId: p.userId,
        fileId: row.file_id,
        revision,
      };
    else if (upload && integer(generation))
      owner = {
        kind: 'upload',
        storeId: scope.storeId,
        tenantId: p.tenantId,
        userId: p.userId,
        operationId: persistedId,
        generation,
        custodyIdentitySha256: digest(
          taggedSource({
            attemptGeneration: row.attemptGeneration,
            worker: row.worker,
            cleanupCustody: row.cleanupCustody,
            securityExecution: row.securityExecution,
            securitySettlement: row.securitySettlement,
            intake: row.intake,
            promotion: row.promotion,
            actorSettlement: row.actorSettlement,
          }),
        ),
      };
    else if (!file && !upload) {
      const work = row.work as {
        handler?: string;
        subject?: { fileId?: unknown };
        deadlineGeneration?: unknown;
      };
      if (typeof work?.subject?.fileId === 'string' && integer(work.deadlineGeneration))
        owner = {
          kind: 'file',
          storeId: scope.storeId,
          tenantId: p.tenantId,
          userId: p.userId,
          fileId: work.subject.fileId,
          revision: work.deadlineGeneration,
        };
      // Upload cleanup jobs remain classified by the exact Upload join, not a synthetic File.
      if (work?.handler === 'upload.cleanup')
        owner = observation.linkedUploadOwner ?? { kind: 'unresolved' };
    }
  }
  let disposition: FileHistoryEntry['disposition'] = 'unclassified';
  let measuredBytes: number | null = 0;
  if (file) measuredBytes = integer(row.bytes) ? row.bytes : null;
  let reservedBytes: number | null = 0;
  let custodyValid = true,
    actorHeld = false,
    unknownPut = false,
    queueCount = 0;
  if (file && classification === 'retained' && owner.kind === 'file') {
    disposition =
      row.deletionRequestedAt ||
      !(row.expiredAt instanceof Date) ||
      row.expiredAt.getTime() <= Date.now()
        ? 'deletion-required'
        : 'retained-owned';
  } else if (!file && !upload && classification === 'retained' && owner.kind !== 'unresolved') {
    disposition = 'retained-owned';
  } else if (upload) {
    const stored = row as unknown as StoredUpload;
    try {
      validateUploadCleanupCustody(stored);
    } catch {
      custodyValid = false;
    }
    const started =
      row.attemptGeneration !== undefined ||
      row.worker !== undefined ||
      row.securityExecution !== undefined ||
      row.promotion !== undefined;
    actorHeld = row.slot !== undefined || (started && !hasUploadActorClosure(stored));
    const original = isUploadStorageReceipt(row.original) ? row.original : null;
    unknownPut =
      started &&
      (!original || original.outcome === 'unknown') &&
      !(
        custodyValid &&
        (stored.cleanupCustody?.consumed?.state === 'recorded' || hasUploadAcceptedFileAck(stored))
      );
    if (original?.outcome === 'durable') measuredBytes = original.bytes;
    else if (!started || original?.outcome === 'absent') measuredBytes = 0;
    else measuredBytes = null;
    const pendingBytes = row.pendingBytes;
    let stagingBytes: unknown = null;
    if (row.stagingHeld === false) stagingBytes = 0;
    else if (row.stagingHeld === true) stagingBytes = row.declaredBytes;
    reservedBytes = sumKnown([pendingBytes, stagingBytes]);
    const consumed =
      custodyValid &&
      hasUploadActorClosure(stored) &&
      (hasUploadAcceptedFileAck(stored) ||
        (stored.cleanupCustody?.consumed?.state === 'recorded' &&
          integer(stored.cleanupCustody.retiredAt)));
    if (owner.kind !== 'unresolved' && custodyValid) {
      if (consumed) disposition = 'absent-and-consumed';
      else if (
        row.cleanupPending === true ||
        ['failed', 'cancelled', 'deleted', 'expired'].includes(String(row.state))
      )
        disposition = stored.cleanupCustody?.request ? 'deletion-in-flight' : 'deletion-required';
      else if (row.state === 'ready' && observation.linkedFileKnown && !actorHeld && !unknownPut)
        disposition = 'retained-owned';
      else if (
        ['waiting', 'transferring', 'queued_processing', 'processing'].includes(String(row.state))
      )
        disposition = 'deletion-in-flight';
    }
    queueCount = row.queueCharged === true ? 1 : 0;
  }
  let kind: 'file' | 'upload' | 'fileJob' = 'fileJob';
  if (file) kind = 'file';
  else if (upload) kind = 'upload';
  const entry: FileHistoryEntry = {
    kind,
    identity: {
      domain: 'mongo',
      storeId: scope.storeId,
      collection: scope.collection,
      idType: file ? 'object-id' : 'string',
      persistedId,
      principal: p,
      revision: integer(revision) ? revision : null,
      generation: integer(generation) ? generation : null,
      component: kind,
    },
    sourceRevision,
    owner,
    disposition,
    measuredBytes,
    reservedBytes,
    referenceIdentitySha256: [], // Exact source hints below are joined by Objects inside its existing owner.
  };
  const accounting = entryHistoryAccounting(entry),
    population = emptyPopulation();
  if (file) {
    population.filesSeen = 1;
    if (classification === 'retained') population.retainedFiles = 1;
    else if (classification === 'excluded') population.excludedFiles = 1;
    else population.unclassifiedFiles = 1;
    // File bytes are baseline/source observations, not an extra Upload quota charge.
    accounting.counts.unknownSizeCount = 0;
    accounting.blockers.unknownSize = 0;
    recordHistoryBytes(accounting, 'fileOriginal', row.bytes);
    recordHistoryBytes(accounting, 'fileDerivative', row.retainedDerivativeBytes);
    const reservations = row.retainedDerivativeReservations;
    if (reservations === undefined) recordHistoryBytes(accounting, 'fileDerivativeReservation', 0);
    else if (!Array.isArray(reservations))
      recordHistoryBytes(accounting, 'fileDerivativeReservation', null);
    else
      for (const reservation of reservations) {
        if (
          !reservation ||
          typeof reservation !== 'object' ||
          typeof reservation.reservationId !== 'string' ||
          !['held', 'released'].includes(reservation.state)
        ) {
          recordHistoryBytes(accounting, 'fileDerivativeReservation', null);
          continue;
        }
        if (reservation.state === 'held') {
          recordHistoryBytes(accounting, 'fileDerivativeReservation', reservation.bytes);
          accounting.counts.heldReservations = addInteger(accounting.counts.heldReservations, 1);
          accounting.blockers.reservation = addInteger(accounting.blockers.reservation, 1);
        }
      }
  } else if (upload) {
    const map: Partial<Record<keyof typeof accounting.bytes, unknown>> = {
      uploadOriginal: row.originalBytes,
      uploadText: row.textBytes,
      uploadPending: row.pendingBytes,
      uploadRecord: row.recordBytes,
    };
    if (row.stagingHeld === false) map.uploadStaging = 0;
    else if (row.stagingHeld === true) map.uploadStaging = row.declaredBytes;
    else map.uploadStaging = null;
    if (row.queueCharged === false) map.uploadQueue = 0;
    else if (row.queueCharged === true) map.uploadQueue = row.declaredBytes;
    else map.uploadQueue = null;
    for (const [key, value] of Object.entries(map))
      recordHistoryBytes(accounting, key as keyof typeof accounting.bytes, value);
    accounting.counts.heldSlots = row.slot === undefined ? 0 : 1;
    if (actorHeld) accounting.blockers.actor = 1;
    if (unknownPut) accounting.blockers.unknownPut = 1;
    if (!custodyValid) accounting.blockers.unclassified = 1;
  } else {
    population.fileJobsSeen = row.handler === 'upload.cleanup' ? 0 : 1;
    population.unclassifiedJobs = classification === 'retained' ? 0 : population.fileJobsSeen;
  }
  return { entry, accounting, queueCount, population, source };
}
