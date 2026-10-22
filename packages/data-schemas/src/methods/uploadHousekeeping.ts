/** Upload-owned per-operation cleanup. Housekeeping owns claims; File owns accepted expiry. */
import type { UploadCleanupProof } from 'librechat-data-provider';
import type { ClientSession, Model, mongo } from 'mongoose';
import type {
  UploadManagementContext,
  UploadCleanupClaim,
  UploadCleanupPreparation,
} from './uploadManagementTypes';
import type {
  DiscoveryPage,
  HousekeepingCoverage,
  JobClaim,
  StepOutcome,
} from '../types/housekeeping';
import type { CounterRow, GlobalState, StoredUpload } from './uploadManagementStore';
import type { UploadHousekeepingProjection } from './uploadHousekeepingProjection';
import type { HousekeepingJobRecord } from '../models/housekeepingJob';
import type { HousekeepingStore } from './housekeepingStore';
import { principalFilter, storedUploadPrincipal } from './uploadManagementStore';
import { uploadTimeoutTransition } from './uploadManagementCleanup';
import { ownershipFilter } from './housekeepingStore';

export type { UploadHousekeepingProjection } from './uploadHousekeepingProjection';

export interface UploadHousekeepingMethods {
  coverageUploadHousekeeping(
    signal: AbortSignal,
    session: ClientSession,
  ): Promise<HousekeepingCoverage>;
  discoverUploadHousekeeping(cursor: string | null): Promise<DiscoveryPage>;
  prepareHousekeepingCleanup(claim: JobClaim): Promise<UploadCleanupPreparation>;
  confirmHousekeepingCleanup(claim: JobClaim, proof: UploadCleanupProof): Promise<StepOutcome>;
}
const PAGE = 32;
const QUERY_MS = 3_000;
const unknownCoverage = (): HousekeepingCoverage => ({
  expected: null,
  observed: 0,
  recoveryHistory: 'unknown',
});

/** One observed Upload scope, never a complete inventory or lifetime recovery attestation. */
export async function readUploadHousekeepingCoverage(
  mongoose: typeof import('mongoose'),
  signal: AbortSignal,
  session: ClientSession,
): Promise<HousekeepingCoverage> {
  if (signal.aborted || !session.snapshotEnabled || session.hasEnded) return unknownCoverage();
  const Counter = mongoose.models.UploadCounter as Model<CounterRow> | undefined;
  if (!Counter || Counter.db.readyState !== 1) return unknownCoverage();
  try {
    const collection = Counter.collection as unknown as mongo.Collection<CounterRow>;
    const row = await collection.findOne(
      { _id: 'global' },
      {
        session,
        signal,
        projection: {
          revision: 1,
          'value.storeId': 1,
          'value.migration': 1,
          'value.migrationEpoch': 1,
        },
        maxTimeMS: QUERY_MS,
        timeoutMS: QUERY_MS,
      },
    );
    const value = row?.value as Partial<GlobalState> | undefined;
    if (
      signal.aborted ||
      session.hasEnded ||
      !row ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 0 ||
      typeof value?.storeId !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.storeId) ||
      value.migration !== undefined ||
      value.migrationEpoch !== undefined
    )
      return unknownCoverage();
    return { expected: null, observed: 1, recoveryHistory: 'unknown' };
  } catch {
    return unknownCoverage();
  }
}

const projection = [
  '_id',
  'tenantId',
  'userId',
  'scope',
  'revision',
  'state',
  'generation',
  'attemptGeneration',
  'workerGeneration',
  'createdAt',
  'acceptedAt',
  'expiresAt',
  'processingQueuedAt',
  'leaseExpiresAt',
  'slot',
  'cleanupPending',
  'stagingHeld',
  'originalBytes',
  'textBytes',
  'recordBytes',
  'fileId',
  'worker',
  'writerStopped',
  'actorSettlement',
  'originalRemoved',
  'textRemoved',
].join(' ');
const waiting = (): StepOutcome => ({ state: 'pending', code: 'owner_pending' });
const outcome = (value: StepOutcome): UploadCleanupPreparation => ({
  state: 'outcome',
  outcome: value,
});

function snapshotClaim(input: JobClaim): UploadCleanupClaim {
  const claim = structuredClone(input);
  if (claim.work?.handler !== 'upload.cleanup') throw Error('UPLOAD_HOUSEKEEPING_INVALID');
  const work = claim.work;
  if (
    typeof work.operationId !== 'string' ||
    !/^[a-zA-Z0-9-]{1,128}$/.test(work.operationId) ||
    !Number.isSafeInteger(work.cleanupGeneration) ||
    work.cleanupGeneration < 0 ||
    (work.attemptGeneration !== null &&
      (!Number.isSafeInteger(work.attemptGeneration) || work.attemptGeneration < 1)) ||
    typeof work.subject?.ownerUserId !== 'string' ||
    !work.subject.ownerUserId ||
    (work.subject.tenantId !== null &&
      (typeof work.subject.tenantId !== 'string' || !work.subject.tenantId))
  )
    throw Error('UPLOAD_HOUSEKEEPING_INVALID');
  ownershipFilter(claim); // The sole owner validates the stable token and worker identity.
  return claim as UploadCleanupClaim;
}

/** No fallback projector: composition must supply the real same-session job owner. */
export function createUploadHousekeepingMethods(
  context: UploadManagementContext,
  jobs: Pick<HousekeepingStore, 'model' | 'advance' | 'invalidate'>,
  projectUploadHousekeeping: UploadHousekeepingProjection,
): UploadHousekeepingMethods {
  if (typeof projectUploadHousekeeping !== 'function')
    throw Error('UPLOAD_HOUSEKEEPING_JOIN_REQUIRED');
  const { mongoose, store, cleanupTask } = context;
  const jobCollection = jobs.model.collection as unknown as mongo.Collection<HousekeepingJobRecord>;
  async function transaction<T>(run: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await mongoose.startSession();
    try {
      return (await session.withTransaction(() => run(session), {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority', wtimeout: 2_000 },
        maxCommitTimeMS: 2_000,
        timeoutMS: 3_000,
      })) as T;
    } finally {
      await session.endSession();
    }
  }
  async function owned(claim: UploadCleanupClaim, session: ClientSession) {
    const job = await jobCollection.findOne(
      {
        ...ownershipFilter(claim),
        handler: 'upload.cleanup',
        work: claim.work,
        'execution.id': claim.executionId,
      },
      { session, maxTimeMS: QUERY_MS },
    );
    if (!job) return { state: 'lost' as const };
    const principal = storedUploadPrincipal({
      tenantId: claim.work.subject.tenantId,
      userId: claim.work.subject.ownerUserId,
    });
    const row = await store.Operation.findOne({
      _id: claim.work.operationId,
      ...principalFilter(principal),
    })
      .session(session)
      .maxTimeMS(QUERY_MS)
      .lean<StoredUpload>();
    if (!row) return { state: 'unknown' as const };
    if (
      row.generation !== claim.work.cleanupGeneration ||
      (row.attemptGeneration ?? null) !== claim.work.attemptGeneration
    ) {
      if (job.execution.phase !== 'awaiting_owner_transition' || job.execution.receiptRef !== null)
        return { state: 'unknown' as const };
      await jobs.invalidate(job._id, job.progressRevision, session);
      await projectUploadHousekeeping(null, row, session);
      return { state: 'lost' as const };
    }
    return { state: 'owned' as const, row, job };
  }
  async function advance(
    claim: UploadCleanupClaim,
    job: HousekeepingJobRecord,
    phase: HousekeepingJobRecord['execution']['phase'],
    session: ClientSession,
  ) {
    const ok = await jobs.advance(
      claim,
      { revision: job.progressRevision, phase: job.execution.phase },
      { phase, code: 'progress' },
      session,
    );
    if (!ok) throw Error('UPLOAD_HOUSEKEEPING_CAS_LOST');
    job.progressRevision++;
    job.execution.phase = phase;
  }
  async function touch(row: StoredUpload, session: ClientSession) {
    const result = await store.Operation.updateOne(
      { _id: row._id, revision: row.revision },
      { $inc: { revision: 1 } },
      { session, maxTimeMS: QUERY_MS },
    );
    if (result.modifiedCount !== 1) throw Error('UPLOAD_HOUSEKEEPING_CAS_LOST');
    row.revision++;
  }
  async function transition(claim: UploadCleanupClaim): Promise<UploadCleanupPreparation> {
    return store.transaction(async (session, global) => {
      const observed = await owned(claim, session);
      if (observed.state !== 'owned') return outcome({ state: observed.state });
      const { row } = observed;
      const code = uploadTimeoutTransition(row, Date.now());
      if (!code) return outcome(waiting());
      const previous = structuredClone(row);
      context.terminal(row, global, 'failed', code);
      await store.save(row, session);
      await projectUploadHousekeeping(previous, row, session);
      // Projection fences the old token; only a freshly acquired claim may continue.
      return outcome({ state: 'lost' });
    });
  }
  return {
    coverageUploadHousekeeping: (signal, session) =>
      readUploadHousekeepingCoverage(mongoose, signal, session),
    async discoverUploadHousekeeping(cursor) {
      if (cursor !== null && (typeof cursor !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(cursor)))
        throw Error('UPLOAD_HOUSEKEEPING_INVALID');
      const rows = await store.Operation.find(cursor ? { _id: { $gt: cursor } } : {})
        .select(projection)
        .sort({ _id: 1 })
        .limit(PAGE)
        .maxTimeMS(QUERY_MS)
        .lean<StoredUpload[]>();
      const deadline = Date.now() + QUERY_MS;
      let scanned = 0;
      let next = cursor;
      for (const selected of rows) {
        if (Date.now() >= deadline) break;
        await transaction(async (session) => {
          const current = await store.Operation.findById(selected._id)
            .select(projection)
            .session(session)
            .maxTimeMS(QUERY_MS)
            .lean<StoredUpload>();
          if (current && (await projectUploadHousekeeping(null, current, session)))
            await touch(current, session);
        });
        scanned++;
        next = selected._id;
      }
      // A full page never certifies coverage. Empty is only this pass's boundary, not lifetime totals.
      return { cursor: rows.length === 0 ? null : next, scanned, complete: rows.length === 0 };
    },
    async prepareHousekeepingCleanup(input) {
      const claim = snapshotClaim(input);
      const observed = await transaction(async (session) => {
        const result = await owned(claim, session);
        if (result.state !== 'owned') return outcome({ state: result.state });
        const { row, job } = result;
        if (await projectUploadHousekeeping(null, row, session)) {
          await touch(row, session);
          return outcome({ state: 'lost' });
        }
        if (uploadTimeoutTransition(row, Date.now())) return { transition: true } as const;
        // Accepted expiry, deletion, record retirement and future obligations stay with their owner.
        // Missing physical/retirement receipts cannot be replaced by today's local staging completion.
        if (
          row.acceptedAt != null ||
          row.fileId ||
          (!row.cleanupPending && !row.cleanupCustody?.request)
        )
          return outcome(waiting());
        const task = cleanupTask(row);
        if (['waiting', 'transferring', 'processing'].includes(row.state))
          return outcome(waiting());
        if (job.execution.phase === 'awaiting_owner_transition')
          await advance(claim, job, 'awaiting_actor', session);
        // Only storage fencing/reconciliation is admitted before the actual actor closures.
        if (row.attemptGeneration == null) return outcome(waiting());
        await touch(row, session); // Serialize effect admission against every concurrent owner transition.
        return { state: 'ready' as const, task };
      });
      return 'transition' in observed ? transition(claim) : observed;
    },
    async confirmHousekeepingCleanup(input, inputProof) {
      const claim = snapshotClaim(input);
      const proof = structuredClone(inputProof);
      if (
        proof.operationId !== claim.work.operationId ||
        !Number.isSafeInteger(proof.generation) ||
        proof.generation < 0 ||
        [
          proof.writerStopped,
          proof.localCopiesAbsent,
          proof.originalAbsent,
          proof.textAndHistoryRemoved,
        ].some((value) => typeof value !== 'boolean')
      )
        throw Error('UPLOAD_HOUSEKEEPING_INVALID');
      // Preflight prevents an unrelated/missing/waiting claim from taking the quota transaction.
      const preflight = await transaction(async (session) => owned(claim, session));
      if (preflight.state !== 'owned') return { state: preflight.state };
      if (preflight.row.acceptedAt != null || preflight.row.fileId) return waiting();
      return store.transaction(async (session, global) => {
        const current = await owned(claim, session);
        if (current.state !== 'owned') return { state: current.state };
        const { row, job } = current;
        const task = cleanupTask(row);
        if (
          row.acceptedAt != null ||
          row.fileId ||
          ['waiting', 'transferring', 'processing'].includes(row.state) ||
          proof.generation !== task.generation ||
          task.writerStopped !== true ||
          task.localCopiesAbsent !== true ||
          proof.writerStopped !== true ||
          proof.localCopiesAbsent !== true ||
          job.execution.phase !== 'removing_unaccepted_original'
        )
          return waiting();
        const previous = structuredClone(row);
        context.applyCleanup(row, proof, global);
        await store.save(row, session);
        await projectUploadHousekeeping(previous, row, session);
        // A successful refresh may already have fenced this token in store.save.
        const after = await owned(claim, session);
        if (after.state !== 'owned') return { state: after.state };
        await advance(
          claim,
          after.job,
          proof.originalAbsent ? 'confirming' : job.execution.phase,
          session,
        );
        // Namespace absence is not the stronger physical receipt or a safe retirement receipt.
        return {
          state: 'pending',
          code: proof.originalAbsent ? 'owner_pending' : 'external_pending',
        };
      });
    },
  };
}
