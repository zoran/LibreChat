import { uploadOriginalSource } from './uploadManagementState';
/** Internal same-session join: File owns physical deletion; Upload owns its retained accounting ACK. */
/** Internal same-session join: File owns physical deletion; Upload owns its retained accounting ACK. */
import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalStorageDeletionReceipt,
  canonicalManagedJson,
  isStorageDeletionBinding,
  isStorageDeletionRequest,
  isStorageDeletionResult,
  isStorageDeletionConsumptionResult,
} from 'librechat-data-provider';
import type { ClientSession, mongo } from 'mongoose';
import type {
  FileCleanupProgress,
  FileUploadCleanupAcknowledgment,
  FileStorageCleanupCustody,
} from '../types/fileCleanup';
import type { AcceptedFileCleanupInput, AcceptedFileCleanupOwner } from './fileCleanupOwners';
import type { StoredUpload, CounterRow, GlobalState } from './uploadManagementStore';
import type { HousekeepingJobRecord } from '../models/housekeepingJob';
import type { IMongoFile } from '../types/file';
import {
  hasUploadActorClosure,
  validateUploadCleanupCustody,
  assertUploadCleanupCapacity,
} from './uploadCleanupReceipts';

import { createUploadStore, uploadDigest, reject } from './uploadManagementStore';
import { managedFileScope, currentFileDeadline } from './fileSourceAuthority';
import { createUploadCleanupTransitions } from './uploadManagementCleanup';
import { managedFileRetrievalDeletionSettled } from './fileRetrieval';
import { ownershipFilter } from './housekeepingStore';
import { uploadFileCleanupBinding } from './uploadFileCleanupBinding';
import { observeNasFileCleanup } from './uploadNasFileCleanup';

type Pending = Exclude<
  Awaited<ReturnType<AcceptedFileCleanupOwner['fenceAcceptedFileCleanup']>>,
  { state: 'bound' }
>;
type AcceptedFileCleanupPendingReason = Extract<Pending, { state: 'pending' }>['reason'];
type FileRow = IMongoFile & { retentionCleanup?: FileCleanupProgress };
const same = (a: unknown, b: unknown) => canonicalManagedJson(a) === canonicalManagedJson(b);
const validId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 256;
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const pending = (reason: AcceptedFileCleanupPendingReason = 'owner_pending'): Pending => ({
  state: 'pending',
  reason,
});
const digest = (v: string) => createHash('sha256').update(v).digest('hex');

const bindingOf = uploadFileCleanupBinding;

function retainedStorage(
  row: StoredUpload,
  file: FileRow,
): Extract<FileStorageCleanupCustody, { state: 'terminal' | 'committed' | 'consumed' }> | null {
  const progress = file.retentionCleanup;
  const lifecycle = progress?.lifecycle;
  const storage = lifecycle?.storage;
  const binding = bindingOf(row);
  if (
    !progress ||
    progress.schema !== 1 ||
    progress.revocationId !== file.retentionRevocationId ||
    !binding ||
    !lifecycle ||
    !same(lifecycle.upload, binding) ||
    !storage ||
    !['terminal', 'committed', 'consumed'].includes(storage.state) ||
    Buffer.byteLength(JSON.stringify(progress), 'utf8') > 32768
  )
    return null;
  if (storage.state !== 'terminal' && storage.state !== 'committed' && storage.state !== 'consumed')
    return null;
  const expectedAuthority = uploadDigest([
    'file-cleanup-authority-v1',
    row.tenantId,
    row.userId,
    row.fileId,
    progress.revocationId,
    currentFileDeadline(file).deadlineGeneration,
    row._id,
    row.attemptGeneration,
    lifecycle.upload.cleanupGeneration,
    lifecycle.upload.originalKey,
  ]);
  if (
    !isStorageDeletionRequest(storage.request) ||
    storage.request.obligationId !== undefined ||
    storage.request.generation !== String(row.attemptGeneration) ||
    storage.request.authorityBindingSHA256 !== expectedAuthority ||
    storage.request.acceptedObjectSHA256 !== binding.acceptedObjectSHA256 ||
    !isStorageDeletionBinding(storage.binding) ||
    storage.binding.key !== binding.originalKey ||
    !Object.entries(storage.request).every(
      ([k, v]) => storage.binding[k as keyof typeof storage.binding] === v,
    ) ||
    !isStorageDeletionResult(storage.receipt, storage.binding) ||
    storage.receipt.state !== 'durable_delete_complete' ||
    digest(canonicalStorageDeletionReceipt(storage.receipt)) !== storage.receiptSHA256
  )
    return null;
  if (
    (storage.state === 'committed' || storage.state === 'consumed') &&
    (typeof storage.consumerCommitId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(storage.consumerCommitId) ||
      !same(storage.uploadAck, row.cleanupCustody?.acceptedFileAck))
  )
    return null;
  if (
    storage.state === 'consumed' &&
    (!isStorageDeletionConsumptionResult(storage.consumption, {
      obligationId: storage.receipt.obligationId,
      receiptSHA256: storage.receiptSHA256,
      consumerCommitId: storage.consumerCommitId,
    }) ||
      storage.consumption.state !== 'recorded')
  )
    return null;
  return storage;
}

/** Shared persisted preparation proof; truthy values never stand in for producer states. */
function preparedFile(row: StoredUpload, file: FileRow): boolean {
  const p = file.retentionCleanup,
    l = p?.lifecycle;
  return (
    !!p &&
    p.schema === 1 &&
    p.revocationId === file.retentionRevocationId &&
    p.capture?.complete === true &&
    p.capture.recoveryUnresolved === false &&
    validId(p.generationReceiptRef) &&
    l?.contentPrepared === true &&
    ['deleted', 'expired'].includes(row.state) &&
    l.derivatives?.retrieval === 'complete' &&
    l.derivatives.checkpoints === 'complete' &&
    l.derivatives.messages === 'complete' &&
    file.retainedDerivativeBytes === 0 &&
    file.text === undefined &&
    file.documentStructure === undefined &&
    managedFileRetrievalDeletionSettled(file)
  );
}

/** Migration may preserve an ACK only with its actual File-owned committed custody. */
export async function validateUploadFileCleanupMigration(
  mongoose: typeof import('mongoose'),
  row: StoredUpload,
  session: ClientSession,
): Promise<void> {
  if (row.acceptedAt == null || !row.fileId) return;
  if (
    !session.inTransaction() ||
    (session as unknown as { client: unknown }).client !== mongoose.connection.getClient()
  )
    throw Error('UPLOAD_FILE_CLEANUP_SESSION');
  const file = await mongoose.models.File?.findOne({
    ...managedFileScope({ userId: row.userId, tenantId: row.tenantId }),
    file_id: row.fileId,
    uploadOperationId: row._id,
  })
    .select(
      '+retentionCleanup +retentionRevocationId +retentionActivity +derivedRetention +retainedDerivativeBytes +text +documentStructure +managedRetrieval +retrievalCreation',
    )
    .session(session)
    .maxTimeMS(1000)
    .lean<FileRow>();
  if (!row.cleanupCustody?.acceptedFileAck) {
    if (file?.retentionCleanup?.lifecycle?.nasStorage?.state === 'consumed')
      reject('migration_conflict');
    const state = file?.retentionCleanup?.lifecycle?.storage?.state;
    if (state === 'committed' || state === 'consumed') reject('migration_conflict');
    return;
  }
  if (row.writeBinding?.version === 2) {
    if (
      !file ||
      (await observeNasFileCleanup(mongoose, row, file, session)).state !== 'acknowledged'
    )
      reject('migration_conflict');
    return;
  }
  validateUploadCleanupCustody(row);
  const storage = file && retainedStorage(row, file);
  if (
    !file ||
    !preparedFile(row, file) ||
    !storage ||
    storage.state === 'terminal' ||
    !same(storage.uploadAck, row.cleanupCustody.acceptedFileAck)
  )
    reject('migration_conflict');
}

export function createUploadFileCleanupOwner(
  mongoose: typeof import('mongoose'),
): AcceptedFileCleanupOwner {
  const store = createUploadStore(mongoose, {});
  const transitions = createUploadCleanupTransitions(store);
  function sessionOnly(session: ClientSession): void {
    if (
      !session.inTransaction() ||
      (session as unknown as { client: unknown }).client !== mongoose.connection.getClient()
    )
      throw Error('UPLOAD_FILE_CLEANUP_SESSION');
  }
  async function load(
    input: AcceptedFileCleanupInput,
    session: ClientSession,
  ): Promise<
    | Pending
    | {
        row: StoredUpload;
        file: FileRow;
        job: HousekeepingJobRecord;
        counter: CounterRow;
        global: GlobalState;
      }
  > {
    sessionOnly(session);
    const claim = input.claim;
    if (claim.work.handler !== 'file.cleanup' || !claim.work.revocationId) return pending();
    const jobs = mongoose.models.HousekeepingJob
      .collection as unknown as mongo.Collection<HousekeepingJobRecord>;
    const job = (await jobs.findOne(
      {
        ...ownershipFilter(claim),
        handler: 'file.cleanup',
        work: claim.work,
        'execution.id': claim.executionId,
      },
      { session, maxTimeMS: 1000 },
    )) as HousekeepingJobRecord | null;
    if (!job) return { state: 'lost' };
    if (
      ![
        'revoked',
        'capturing_generations',
        'settling_generations',
        'purging_derivatives',
        'removing_original',
        'finalizing',
      ].includes(job.execution.phase)
    )
      return pending();
    const owner = { userId: claim.work.subject.ownerUserId, tenantId: claim.work.subject.tenantId };
    const file = await mongoose.models.File.findOne({
      ...managedFileScope(owner),
      file_id: claim.work.subject.fileId,
    })
      .select(
        '+retentionCleanup +retentionRevocationId +retentionActivity +derivedRetention +derivedOrigin +retainedDerivativeBytes +retainedDerivativeReservations +text +documentStructure +managedRetrieval +retrievalCreation',
      )
      .session(session)
      .maxTimeMS(1000)
      .lean<FileRow>();
    if (
      !file ||
      !file.uploadOperationId ||
      !file.deletionRequestedAt ||
      file.deletionCompletedAt ||
      file.retentionRevocationId !== claim.work.revocationId ||
      !Number.isSafeInteger(file.retentionRevision) ||
      file.retentionRevision! < 0
    )
      return pending();
    const deadline = currentFileDeadline(file);
    if (deadline.migrationEpoch !== null) return pending('migration_pending');
    if (deadline.deadlineGeneration !== claim.work.deadlineGeneration) return pending();
    const row = await store.Operation.findOne({
      _id: file.uploadOperationId,
      tenantId: owner.tenantId,
      userId: owner.userId,
    })
      .session(session)
      .maxTimeMS(1000)
      .lean<StoredUpload>();
    if (
      !row ||
      row.fileId !== file.file_id ||
      row.acceptedAt == null ||
      file.retentionAcceptedAt?.getTime() !== row.acceptedAt ||
      row.cleanupCustody?.request
    )
      return pending();
    if (row.original?.source !== uploadOriginalSource(row))
      return pending('source_strategy_unavailable');
    if (!bindingOf(row)) return pending();
    if (
      file.retentionCleanup?.lifecycle?.contentPrepared !== true &&
      (file.storageKey !== row.original.storageKey ||
        file.source !== row.original.source ||
        file.bytes !== row.original.bytes)
    )
      return pending();
    const counter = await store.Counter.findById('global')
      .session(session)
      .maxTimeMS(1000)
      .lean<CounterRow>();
    if (!counter || !(counter.value as GlobalState).reconciled) return pending();
    const global = counter.value as GlobalState;
    if (global.migrationEpoch) return pending('migration_pending');
    return { row, file, job, counter, global };
  }
  async function save(
    row: StoredUpload,
    counter: CounterRow,
    global: GlobalState,
    session: ClientSession,
  ) {
    global.revision++;
    const changed = await store.Counter.updateOne(
      { _id: 'global', revision: counter.revision },
      { $inc: { revision: 1 }, $set: { value: global } },
      { session },
    );
    if (changed.matchedCount !== 1) throw Error('UPLOAD_FILE_CLEANUP_COUNTER_LOST');
    await store.save(row, session);
  }
  return {
    async observeAcceptedFileCleanup(input, session) {
      sessionOnly(session);
      const { fileId, deadlineAt, signal } = input;
      const owner = { userId: input.owner.userId, tenantId: input.owner.tenantId ?? null };
      if (
        !validId(fileId) ||
        !Number.isSafeInteger(deadlineAt) ||
        !signal ||
        typeof signal.addEventListener !== 'function'
      )
        throw Error('UPLOAD_FILE_CLEANUP_OBSERVATION');
      const scope = managedFileScope(owner);
      const until = performance.now() + Math.max(0, deadlineAt - Date.now());
      const remaining = () => {
        const ms = Math.floor(Math.min(deadlineAt - Date.now(), until - performance.now()));
        if (signal.aborted || ms <= 0) throw Error('UPLOAD_FILE_CLEANUP_UNAVAILABLE');
        return Math.min(1000, ms);
      };
      const files = await mongoose.models.File.find({ ...scope, file_id: fileId })
        .select(
          '+retentionCleanup +retentionRevocationId +retentionActivity +derivedRetention +retainedDerivativeBytes +text +documentStructure +managedRetrieval +retrievalCreation',
        )
        .limit(2)
        .session(session)
        .maxTimeMS(remaining())
        .setOptions({ signal })
        .lean<FileRow[]>();
      remaining();
      if (files.length !== 1) throw Error('UPLOAD_FILE_CLEANUP_IDENTITY');
      const file = files[0];
      if (!validId(file.uploadOperationId)) throw Error('UPLOAD_FILE_CLEANUP_IDENTITY');
      const row = await store.Operation.findOne({
        _id: file.uploadOperationId,
        tenantId: owner.tenantId ?? null,
        userId: owner.userId,
        fileId,
      })
        .session(session)
        .maxTimeMS(remaining())
        .setOptions({ signal })
        .lean<StoredUpload>();
      remaining();
      if (
        !row ||
        file.retentionAcceptedAt?.getTime() !== row.acceptedAt ||
        row.cleanupCustody?.request ||
        !row.original ||
        !bindingOf(row)
      )
        throw Error('UPLOAD_FILE_CLEANUP_IDENTITY');
      const p = file.retentionCleanup,
        l = p?.lifecycle,
        s = l?.storage;
      if (row.writeBinding?.version === 2)
        return observeNasFileCleanup(mongoose, row, file, session);
      if (
        p &&
        (p.schema !== 1 ||
          p.revocationId !== file.retentionRevocationId ||
          !validId(p.jobId) ||
          !validId(p.executionId) ||
          typeof p.capture?.complete !== 'boolean' ||
          typeof p.capture.recoveryUnresolved !== 'boolean' ||
          Buffer.byteLength(JSON.stringify(p), 'utf8') > 32768)
      )
        throw Error('UPLOAD_FILE_CLEANUP_CUSTODY');
      if (
        l &&
        (typeof l.contentPrepared !== 'boolean' ||
          !same(l.upload, bindingOf(row)) ||
          !['pending', 'complete'].includes(l.derivatives?.retrieval) ||
          !['pending', 'complete'].includes(l.derivatives?.checkpoints) ||
          !['pending', 'complete'].includes(l.derivatives?.messages))
      )
        throw Error('UPLOAD_FILE_CLEANUP_CUSTODY');
      if (
        l?.contentPrepared !== true &&
        (file.storageKey !== row.original?.storageKey ||
          file.source !== row.original.source ||
          file.bytes !== row.original.bytes)
      )
        throw Error('UPLOAD_FILE_CLEANUP_CUSTODY');
      if (
        s &&
        (!['binding', 'observing', 'terminal', 'committed', 'consumed'].includes(s.state) ||
          !isStorageDeletionRequest(s.request) ||
          s.request.obligationId !== undefined ||
          s.request.generation !== String(row.attemptGeneration) ||
          s.request.acceptedObjectSHA256 !== l!.upload.acceptedObjectSHA256 ||
          (s.state !== 'binding' &&
            (!isStorageDeletionBinding(s.binding) ||
              !Object.entries(s.request).every(
                ([k, v]) => s.binding[k as keyof typeof s.binding] === v,
              ))))
      )
        throw Error('UPLOAD_FILE_CLEANUP_CUSTODY');
      if (
        s &&
        ['terminal', 'committed', 'consumed'].includes(s.state) &&
        !retainedStorage(row, file)
      )
        throw Error('UPLOAD_FILE_CLEANUP_CUSTODY');
      const ack = row.cleanupCustody?.acceptedFileAck;
      if (!ack) {
        if (file.deletionCompletedAt || s?.state === 'committed' || s?.state === 'consumed')
          throw Error('UPLOAD_FILE_CLEANUP_ACK');
        return { state: 'pending' };
      }
      validateUploadCleanupCustody(row);
      const storage = retainedStorage(row, file);
      if (
        !preparedFile(row, file) ||
        !storage ||
        storage.state === 'terminal' ||
        ack.revocationId !== p!.revocationId ||
        ack.receiptSHA256 !== storage.receiptSHA256 ||
        !same(ack, storage.uploadAck)
      )
        throw Error('UPLOAD_FILE_CLEANUP_ACK');
      const targets = mongoose.models.FileCleanupTarget;
      if (!targets) throw Error('UPLOAD_FILE_CLEANUP_UNAVAILABLE');
      const target = await targets
        .exists({
          tenantId: row.tenantId,
          ownerUserId: row.userId,
          fileId,
          revocationId: p!.revocationId,
          state: { $in: ['pending', 'unknown'] },
        })
        .session(session)
        .maxTimeMS(remaining())
        .setOptions({ signal });
      remaining();
      const descendant = await mongoose.models.File.exists({
        ...scope,
        'derivedOrigin.ancestors.subject.operationId': fileId,
        deletionCompletedAt: null,
      })
        .session(session)
        .maxTimeMS(remaining())
        .setOptions({ signal });
      remaining();
      if (target || descendant) throw Error('UPLOAD_FILE_CLEANUP_ACCOUNTING');
      return { state: 'acknowledged', ack: { ...ack } };
    },
    async fenceAcceptedFileCleanup(input, session) {
      const current = await load(input, session);
      if ('state' in current) return current;
      const { row, file, counter, global } = current;
      // Legacy accepted rows also reserve the existing bounded ACK headroom before File effects.
      assertUploadCleanupCapacity(
        { ...row, cleanupCustody: row.cleanupCustody ?? { version: 1 } },
        mongoose.mongo.BSON.calculateObjectSize,
      );
      const retained = file.retentionCleanup?.lifecycle?.upload;
      if (retained) {
        const binding = bindingOf(row);
        return binding && ['deleted', 'expired'].includes(row.state) && same(binding, retained)
          ? { state: 'bound', binding }
          : pending();
      }
      if (!['deleted', 'expired'].includes(row.state)) {
        if (row.generation >= Number.MAX_SAFE_INTEGER) return pending();
        transitions.terminal(row, global, 'deleted', 'cancelled');
        await save(row, counter, global, session);
      }
      const binding = bindingOf(row);
      return binding ? { state: 'bound', binding } : pending();
    },
    async acknowledgeAcceptedFileCleanup(input, session) {
      const current = await load(input, session);
      if ('state' in current) return current;
      const { row, file, job, counter, global } = current;
      if (row.writeBinding?.version === 2) {
        const observed = await observeNasFileCleanup(mongoose, row, file, session);
        return observed.state === 'pending' ? pending() : observed;
      }
      const progress = file.retentionCleanup;
      if (
        !progress ||
        progress.jobId !== job._id ||
        progress.executionId !== job.execution.id ||
        !preparedFile(row, file)
      )
        return pending();
      const storage = retainedStorage(row, file);
      if (!storage) return pending();
      if (!row.worker || !positive(row.workerGeneration) || !hasUploadActorClosure(row))
        return pending('actor_pending');
      const targets = mongoose.models.FileCleanupTarget;
      if (!targets) return pending();
      if (
        await targets
          .exists({
            tenantId: row.tenantId,
            ownerUserId: row.userId,
            fileId: row.fileId,
            revocationId: progress.revocationId,
            state: { $in: ['pending', 'unknown'] },
          })
          .session(session)
          .maxTimeMS(1000)
      )
        return pending();
      if (
        await mongoose.models.File.exists({
          ...managedFileScope({ userId: row.userId, tenantId: row.tenantId }),
          'derivedOrigin.ancestors.subject.operationId': row.fileId,
          deletionCompletedAt: null,
        })
          .session(session)
          .maxTimeMS(1000)
      )
        return pending();
      const previous = row.cleanupCustody?.acceptedFileAck;
      if (previous) {
        validateUploadCleanupCustody(row);
        return previous.revocationId === progress.revocationId &&
          previous.receiptSHA256 === storage.receiptSHA256
          ? { state: 'acknowledged', ack: { ...previous } }
          : pending();
      }
      if (storage.state !== 'terminal') return pending();
      const ack: FileUploadCleanupAcknowledgment = {
        reference: randomUUID(),
        operationId: row._id,
        cleanupGeneration: row.generation,
        attemptGeneration: row.attemptGeneration!,
        revocationId: progress.revocationId,
        receiptSHA256: storage.receiptSHA256,
      };
      row.cleanupCustody ??= { version: 1 };
      row.cleanupCustody.acceptedFileAck = ack;
      transitions.applyCleanup(
        row,
        {
          operationId: row._id,
          generation: row.workerGeneration,
          writerStopped: true,
          localCopiesAbsent: true,
          originalAbsent: true,
          textAndHistoryRemoved: true,
        },
        global,
      );
      validateUploadCleanupCustody(row);
      await save(row, counter, global, session);
      return { state: 'acknowledged', ack: { ...ack } };
    },
  };
}
