/** Upload custody of opaque storage receipts; no native inventory or physical deletion authority. */
import { createHash, randomUUID } from 'crypto';
import {
  canonicalStorageDeletionReceipt,
  isStorageDeletionBinding,
  isStorageDeletionRequest,
  isStorageDeletionResult,
  isStorageDeletionConsumptionResult,
  UPLOAD_RECORD_BYTES,
} from 'librechat-data-provider';
import type {
  StorageDeletionBinding,
  StorageDeletionRequest,
  StorageDeletionResult,
  StorageDeletionTerminalReceipt,
  StorageDeletionConsumptionResult,
  UploadWorker,
} from 'librechat-data-provider';
import type { ClientSession, mongo } from 'mongoose';
import type { StoredUpload, GlobalState } from './uploadManagementStore';
import type { UploadManagementContext } from './uploadManagementContext';
import type { HousekeepingJobRecord } from '../models/housekeepingJob';
import type { HousekeepingStore } from './housekeepingStore';
import type { JobClaim } from '../types/housekeeping';
import {
  principalFilter,
  storedUploadPrincipal,
  uploadDigest,
  reject,
} from './uploadManagementStore';
import { uploadOriginalKey, assertUploadCleanupCapacity } from './uploadManagementState';
import { hasCompleteUploadSecurityExecution } from './uploadManagement.security';
import { ownershipFilter } from './housekeepingStore';

export type { UploadCleanupCustody } from './uploadManagementState';
export { assertUploadCleanupCapacity, UPLOAD_CLEANUP_HEADROOM } from './uploadManagementState';

export type UploadCleanupStorageAuthority = {
  operationId: string;
  principal: { tenantId: string | null; userId: string };
  generation: number;
  attemptGeneration: number;
  claim?: JobClaim;
};
export type UploadCleanupStoragePreparation =
  | { state: 'binding'; request: StorageDeletionRequest }
  | { state: 'observe'; request: StorageDeletionRequest; binding: StorageDeletionBinding }
  | {
      state: 'consume';
      request: StorageDeletionRequest;
      binding: StorageDeletionBinding;
      receipt: StorageDeletionTerminalReceipt;
      consumerCommitId: string;
    }
  | { state: 'complete'; receiptRef: string }
  | { state: 'pending' | 'lost' };
export interface UploadCleanupReceiptMethods {
  prepareCleanupStorage(
    authority: UploadCleanupStorageAuthority,
    binding?: StorageDeletionBinding,
  ): Promise<UploadCleanupStoragePreparation>;
  recordCleanupStorage(
    authority: UploadCleanupStorageAuthority,
    observation:
      | { result: StorageDeletionResult }
      | { consumption: StorageDeletionConsumptionResult },
  ): Promise<UploadCleanupStoragePreparation>;
}
const terminal = new Set(['failed', 'cancelled', 'deleted', 'expired']);
const authorityDigest = (row: StoredUpload, cleanupGeneration: number): string =>
  uploadDigest([
    'upload-unaccepted-cleanup-authority-v1',
    row.tenantId,
    row.userId,
    row._id,
    row.attemptGeneration,
    cleanupGeneration,
    uploadOriginalKey(row),
  ]);
const objectDigest = (row: StoredUpload): string =>
  uploadDigest([
    row.original ? 'upload-original-receipt-binding-v1' : 'upload-unaccepted-attempt-binding-v1',
    {
      tenantId: row.tenantId,
      userId: row.userId,
      operationId: row._id,
      attemptGeneration: row.attemptGeneration,
      key: uploadOriginalKey(row),
    },
    row.original ?? { acceptedReceipt: false },
  ]);
const receiptDigest = (receipt: StorageDeletionTerminalReceipt): string =>
  createHash('sha256').update(canonicalStorageDeletionReceipt(receipt)).digest('hex');
const sameWorker = (a?: UploadWorker, b?: UploadWorker): boolean =>
  !!a && !!b && a.hostId === b.hostId && a.instanceId === b.instanceId;

export function hasUploadStorageCompletion(row: StoredUpload): boolean {
  const custody = row.cleanupCustody;
  return (
    !!custody?.binding &&
    !!custody.receipt &&
    isStorageDeletionResult(custody.receipt, custody.binding, custody.obligationId) &&
    custody.receipt.state === 'durable_delete_complete' &&
    custody.receiptSHA256 === receiptDigest(custody.receipt) &&
    custody.binding.generation === String(row.attemptGeneration)
  );
}
export function hasUploadPromotionClosure(row: StoredUpload): boolean {
  if (!row.promotion || row.promotion.writerStopped) return true;
  const local = row.cleanupCustody?.promotionLocal;
  return (
    hasUploadStorageCompletion(row) &&
    !!local &&
    local.promotionId === row.promotion.promotionId &&
    local.generation === row.attemptGeneration &&
    sameWorker(local.worker, row.promotion.worker)
  );
}
export function hasUploadActorClosure(row: StoredUpload): boolean {
  const actor = row.actorSettlement;
  const exactActor =
    !!actor &&
    actor.generation === (row.workerGeneration ?? row.generation) &&
    sameWorker(actor.worker, row.worker);
  const local = exactActor && actor.localWriterStopped === true;
  const stopped =
    row.writerStopped === true ||
    (!!actor &&
      actor.generation === (row.workerGeneration ?? row.generation) &&
      sameWorker(actor.worker, row.worker) &&
      (actor.writerStopped === true || (local && hasUploadStorageCompletion(row))));
  return (
    stopped &&
    (row.stagingHeld === false || (exactActor && actor.localCopiesAbsent === true)) &&
    ((!row.securityExecution && !row.promotion) || hasCompleteUploadSecurityExecution(row)) &&
    hasUploadPromotionClosure(row)
  );
}
/** A compact retained ACK; only the File-owner join may create it after its actual custody checks. */
export function hasUploadAcceptedFileAck(row: StoredUpload): boolean {
  const ack = row.cleanupCustody?.acceptedFileAck;
  return (
    !!ack &&
    Object.keys(ack).length === 6 &&
    typeof ack.reference === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(ack.reference) &&
    ack.operationId === row._id &&
    ack.attemptGeneration === row.attemptGeneration &&
    ack.cleanupGeneration === row.generation &&
    typeof ack.revocationId === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(ack.revocationId) &&
    typeof ack.receiptSHA256 === 'string' &&
    /^[a-f0-9]{64}$/.test(ack.receiptSHA256) &&
    row.acceptedAt != null &&
    row.fileId === row._id &&
    row.original?.outcome === 'durable' &&
    ['deleted', 'expired'].includes(row.state)
  );
}
/** Migration preserves original unknown history; a boolean cannot synthesize a new receipt. */
export function validateUploadCleanupCustody(row: StoredUpload): void {
  const c = row.cleanupCustody;
  if (c === undefined) return;
  const keys = [
    'version',
    'request',
    'cleanupGeneration',
    'binding',
    'obligationId',
    'receipt',
    'receiptSHA256',
    'consumerCommitId',
    'consumed',
    'retiredAt',
    'promotionLocal',
    'acceptedFileAck',
  ];
  if (!c || Array.isArray(c) || c.version !== 1 || Object.keys(c).some((k) => !keys.includes(k)))
    reject('migration_conflict');
  if (
    c.request !== undefined &&
    (!isStorageDeletionRequest(c.request) ||
      c.request.obligationId !== undefined ||
      c.request.generation !== String(row.attemptGeneration) ||
      !Number.isSafeInteger(c.cleanupGeneration) ||
      c.cleanupGeneration! < 0 ||
      c.cleanupGeneration! > row.generation ||
      c.request.authorityBindingSHA256 !== authorityDigest(row, c.cleanupGeneration!) ||
      c.request.acceptedObjectSHA256 !== objectDigest(row))
  )
    reject('migration_conflict');
  if (c.cleanupGeneration !== undefined && !c.request) reject('migration_conflict');
  if (
    c.acceptedFileAck !== undefined &&
    (!hasUploadAcceptedFileAck(row) ||
      c.request ||
      c.receipt ||
      c.binding ||
      c.consumerCommitId ||
      c.consumed ||
      c.retiredAt ||
      row.originalBytes ||
      row.textBytes ||
      row.originalRemoved !== true ||
      row.textRemoved !== true ||
      row.cleanupPending !== false ||
      row.slot ||
      row.stagingHeld ||
      !hasUploadActorClosure(row) ||
      row.recordBytes !== UPLOAD_RECORD_BYTES)
  )
    reject('migration_conflict');

  if (
    c.binding !== undefined &&
    (!c.request ||
      !isStorageDeletionBinding(c.binding) ||
      c.binding.key !== uploadOriginalKey(row) ||
      !Object.entries(c.request).every(
        ([key, value]) => c.binding![key as keyof StorageDeletionBinding] === value,
      ))
  )
    reject('migration_conflict');
  if (
    c.obligationId !== undefined &&
    (!c.binding || !isStorageDeletionRequest({ ...c.request, obligationId: c.obligationId }))
  )
    reject('migration_conflict');
  if (c.receipt !== undefined && !hasUploadStorageCompletion(row)) reject('migration_conflict');
  if (c.receiptSHA256 !== undefined && (!c.receipt || c.receiptSHA256 !== receiptDigest(c.receipt)))
    reject('migration_conflict');
  if (
    c.consumerCommitId !== undefined &&
    (!c.receipt ||
      typeof c.consumerCommitId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(c.consumerCommitId) ||
      !hasUploadActorClosure(row))
  )
    reject('migration_conflict');
  if (
    c.consumed !== undefined &&
    (!c.receipt ||
      !c.consumerCommitId ||
      !isStorageDeletionConsumptionResult(c.consumed, {
        obligationId: c.receipt.obligationId,
        receiptSHA256: c.receiptSHA256!,
        consumerCommitId: c.consumerCommitId,
      }) ||
      c.consumed.state !== 'recorded')
  )
    reject('migration_conflict');
  if (
    c.retiredAt !== undefined &&
    (!Number.isSafeInteger(c.retiredAt) ||
      c.retiredAt < 0 ||
      !c.consumed ||
      row.cleanupPending ||
      row.originalBytes ||
      row.textBytes ||
      row.stagingHeld ||
      row.slot ||
      row.recordBytes !== UPLOAD_RECORD_BYTES)
  )
    reject('migration_conflict');
  if (
    c.promotionLocal !== undefined &&
    (!c.promotionLocal ||
      !row.promotion ||
      Object.keys(c.promotionLocal).some(
        (key) => !['promotionId', 'generation', 'worker'].includes(key),
      ) ||
      !c.promotionLocal.worker ||
      Object.keys(c.promotionLocal.worker).some((key) => !['hostId', 'instanceId'].includes(key)) ||
      c.promotionLocal.promotionId !== row.promotion.promotionId ||
      c.promotionLocal.generation !== row.attemptGeneration ||
      !sameWorker(c.promotionLocal.worker, row.promotion.worker))
  )
    reject('migration_conflict');
}

export function createUploadCleanupReceiptMethods(
  context: UploadManagementContext,
  jobs: Pick<HousekeepingStore, 'model' | 'advance'>,
): UploadCleanupReceiptMethods {
  const { store, mongoose } = context;
  const collection = jobs.model.collection as unknown as mongo.Collection<HousekeepingJobRecord>;
  async function read(input: UploadCleanupStorageAuthority, session: ClientSession) {
    const authority = structuredClone(input);
    const principal = storedUploadPrincipal({
      tenantId: authority.principal.tenantId,
      userId: authority.principal.userId,
    });
    if (
      !/^[a-zA-Z0-9-]{1,128}$/.test(authority.operationId) ||
      !Number.isSafeInteger(authority.attemptGeneration) ||
      authority.attemptGeneration < 1 ||
      !Number.isSafeInteger(authority.generation) ||
      authority.generation < 1
    )
      reject('invalid_request');
    let job: HousekeepingJobRecord | null = null;
    if (authority.claim) {
      const claim = authority.claim;
      if (
        claim.work.handler !== 'upload.cleanup' ||
        claim.work.operationId !== authority.operationId ||
        claim.work.subject.tenantId !== principal.tenantId ||
        claim.work.subject.ownerUserId !== principal.userId ||
        claim.work.attemptGeneration !== authority.attemptGeneration
      )
        reject('invalid_request');
      job = await collection.findOne(
        { ...ownershipFilter(claim), work: claim.work, 'execution.id': claim.executionId },
        { session, maxTimeMS: 3000 },
      );
      if (!job) return null;
    }
    const row = await store.Operation.findOne({
      _id: authority.operationId,
      ...principalFilter(principal),
    })
      .session(session)
      .maxTimeMS(3000)
      .lean<StoredUpload>();
    if (
      !row ||
      row.attemptGeneration !== authority.attemptGeneration ||
      (row.workerGeneration ?? row.generation) !== authority.generation ||
      (authority.claim?.work.handler === 'upload.cleanup' &&
        row.generation !== authority.claim.work.cleanupGeneration)
    )
      return null;
    if (row.acceptedAt != null || row.fileId || !terminal.has(row.state)) return null;
    validateUploadCleanupCustody(row);
    return { row, job, authority };
  }
  function prepared(row: StoredUpload): UploadCleanupStoragePreparation {
    const c = row.cleanupCustody!;
    if (c.retiredAt !== undefined) return { state: 'complete', receiptRef: c.receiptSHA256! };
    if (!c.binding) return { state: 'binding', request: structuredClone(c.request!) };
    const request = { ...c.request!, ...(c.obligationId ? { obligationId: c.obligationId } : {}) };
    if (c.consumerCommitId && c.receipt)
      return {
        state: 'consume',
        request,
        binding: structuredClone(c.binding),
        receipt: structuredClone(c.receipt),
        consumerCommitId: c.consumerCommitId,
      };
    return { state: 'observe', request, binding: structuredClone(c.binding) };
  }
  async function advanceCustody(
    claim: JobClaim | undefined,
    job: HousekeepingJobRecord | null,
    row: StoredUpload,
    session: ClientSession,
  ): Promise<void> {
    if (!claim || !job) return;
    const c = row.cleanupCustody!;
    const advance = async (
      phase: HousekeepingJobRecord['execution']['phase'],
      complete = false,
    ) => {
      if (
        !(await jobs.advance(
          claim,
          { revision: job.progressRevision, phase: job.execution.phase },
          {
            phase,
            ...(complete
              ? { state: 'settled' as const, code: 'settled' as const }
              : { code: 'progress' as const }),
            ...(c.consumerCommitId ? { receiptRef: c.receiptSHA256! } : {}),
          },
          session,
        ))
      )
        throw Error('UPLOAD_HOUSEKEEPING_CAS_LOST');
      job.progressRevision++;
      job.execution.phase = phase;
    };
    if (job.execution.phase === 'awaiting_owner_transition') await advance('awaiting_actor');
    // A persisted binding permits storage fencing while the exact local actors still close.
    if (c.binding && job.execution.phase === 'awaiting_actor')
      await advance('removing_unaccepted_original');
    if (c.consumerCommitId && job.execution.phase === 'removing_unaccepted_original')
      await advance('confirming');
    if (c.retiredAt !== undefined && job.execution.phase === 'confirming')
      await advance('complete', true);
  }
  async function plain<T>(run: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await mongoose.startSession();
    try {
      return (await session.withTransaction(() => run(session), {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority', wtimeout: 2000 },
        maxCommitTimeMS: 2000,
      })) as T;
    } finally {
      await session.endSession();
    }
  }
  return {
    async prepareCleanupStorage(input, suppliedBinding) {
      const binding = suppliedBinding === undefined ? undefined : structuredClone(suppliedBinding);
      return plain(async (session) => {
        const current = await read(input, session);
        if (!current) return { state: 'lost' };
        const { row, job, authority } = current;
        row.cleanupCustody ??= { version: 1 };
        const c = row.cleanupCustody;
        if (!c.request) {
          c.cleanupGeneration = row.generation;
          c.request = {
            protocol: 1,
            requestId: randomUUID(),
            generation: String(row.attemptGeneration),
            authorityBindingSHA256: authorityDigest(row, row.generation),
            acceptedObjectSHA256: objectDigest(row),
          };
        }
        if (binding) {
          if (
            !isStorageDeletionBinding(binding) ||
            binding.key !== uploadOriginalKey(row) ||
            !Object.entries(c.request).every(
              ([key, value]) => binding[key as keyof StorageDeletionBinding] === value,
            ) ||
            (c.binding && uploadDigest(c.binding) !== uploadDigest(binding))
          )
            reject('idempotency_conflict');
          c.binding = binding;
        }
        await advanceCustody(authority.claim, job, row, session);
        assertUploadCleanupCapacity(row, mongoose.mongo.BSON.calculateObjectSize);
        await store.save(row, session);
        return prepared(row);
      });
    },
    async recordCleanupStorage(input, value) {
      const observation = structuredClone(value);
      const observed = await plain<
        | { state: 'lost' }
        | {
            state: 'stored';
            prepared: UploadCleanupStoragePreparation;
            ready: boolean;
            needsAccounting: boolean;
          }
      >(async (session) => {
        const current = await read(input, session);
        if (!current) return { state: 'lost' };
        const { row } = current;
        const c = row.cleanupCustody;
        if (!c?.binding || !c.request) reject('not_ready');
        if ('result' in observation) {
          const result = observation.result;
          if (!isStorageDeletionResult(result, c.binding, c.obligationId))
            reject('invalid_request');
          if (result.obligationId) c.obligationId = result.obligationId;
          if (result.state === 'durable_delete_complete') {
            if (
              c.receipt &&
              canonicalStorageDeletionReceipt(c.receipt) !== canonicalStorageDeletionReceipt(result)
            )
              reject('idempotency_conflict');
            c.receipt = result;
            c.receiptSHA256 = receiptDigest(result);
          }
        } else {
          if (
            !c.receipt ||
            !c.consumerCommitId ||
            !isStorageDeletionConsumptionResult(observation.consumption, {
              obligationId: c.receipt.obligationId,
              receiptSHA256: c.receiptSHA256!,
              consumerCommitId: c.consumerCommitId,
            })
          )
            reject('invalid_request');
          if (observation.consumption.state === 'recorded') c.consumed = observation.consumption;
        }
        await store.save(row, session);
        return {
          state: 'stored',
          prepared: prepared(row),
          ready: hasUploadStorageCompletion(row) && hasUploadActorClosure(row),
          needsAccounting: !c.consumerCommitId,
        };
      });
      if (observed.state === 'lost') return observed;
      if (!observed.ready) return observed.prepared;
      const finish = async (
        session: ClientSession,
        global?: GlobalState,
      ): Promise<UploadCleanupStoragePreparation> => {
        const current = await read(input, session);
        if (!current) return { state: 'lost' };
        const { row, job, authority } = current;
        const c = row.cleanupCustody!;
        if (!hasUploadStorageCompletion(row) || !hasUploadActorClosure(row)) return prepared(row);
        if (!c.consumerCommitId) {
          if (!global) throw Error('UPLOAD_CLEANUP_ACCOUNTING_REQUIRED');
          if (
            !mongoose.models.File ||
            (await mongoose.models.File.exists({ file_id: row._id })
              .session(session)
              .maxTimeMS(3000))
          )
            return { state: 'pending' };
          context.applyCleanup(
            row,
            {
              operationId: row._id,
              generation: authority.generation,
              writerStopped: true,
              localCopiesAbsent: true,
              originalAbsent: true,
              textAndHistoryRemoved: true,
            },
            global,
          );
          c.consumerCommitId = randomUUID();
        }
        row.cleanupPending =
          !c.consumed || !!row.slot || !!row.originalBytes || !!row.textBytes || row.stagingHeld;
        if (!row.cleanupPending) {
          c.retiredAt ??= Date.now();
        }
        await advanceCustody(authority.claim, job, row, session);
        await store.save(row, session);
        return prepared(row);
      };
      return observed.needsAccounting
        ? store.transaction(finish)
        : plain((session) => finish(session));
    },
  };
}
