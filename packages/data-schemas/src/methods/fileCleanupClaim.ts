/** File-owned claim entry only; generation, storage and final deletion retain their own proof gates. */
import type { ClientSession, Model, mongo } from 'mongoose';
import type { HousekeepingJobRecord } from '../models/housekeepingJob';
import type { JobClaim, StepOutcome } from '../types/housekeeping';
import type { createFileRetentionMethods } from './fileRetention';
import type { HousekeepingStore } from './housekeepingStore';
import type { IMongoFile } from '../types/file';
import {
  currentFileDeadline,
  managedFileScope,
  FileSourceUnavailableError,
} from './fileSourceAuthority';
import { ownershipFilter } from './housekeepingStore';

type FileRevocationMethods = Pick<
  ReturnType<typeof createFileRetentionMethods>,
  'revokeExpiredManagedUpload'
>;
export interface FileCleanupClaimMethods {
  /** Observes/enters claimed revocation. Progress is never external-effect or completion authority. */
  enter(claim: JobClaim, signal: AbortSignal): Promise<StepOutcome>;
}

const QUERY_MS = 1000;
const TRANSACTION_MS = 5000;
class ClaimLost extends Error {}
class OwnerPending extends Error {}
class Cancelled extends Error {}

/** Internal database composition; the returned methods expose no model, session or storage locator. */
export function createFileCleanupClaimMethods(
  mongoose: typeof import('mongoose'),
  store: HousekeepingStore,
  fileOwner: FileRevocationMethods,
): FileCleanupClaimMethods {
  if (
    store.model !== mongoose.models.HousekeepingJob ||
    !mongoose.models.File ||
    typeof fileOwner.revokeExpiredManagedUpload !== 'function'
  )
    throw new Error('FILE_CLEANUP_CLAIM_CONFIGURATION');
  const File = mongoose.models.File as Model<IMongoFile>;
  const jobs = store.model.collection as unknown as mongo.Collection<HousekeepingJobRecord>;

  async function transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await mongoose.startSession();
    try {
      return (await session.withTransaction(() => work(session), {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority', wtimeout: TRANSACTION_MS },
        maxCommitTimeMS: QUERY_MS,
        timeoutMS: TRANSACTION_MS,
      })) as T;
    } finally {
      await session.endSession();
    }
  }
  const checkSignal = (signal: AbortSignal) => {
    if (signal.aborted) throw new Cancelled();
  };

  async function enter(claim: JobClaim, signal: AbortSignal): Promise<StepOutcome> {
    if (claim.work.handler !== 'file.cleanup') throw new Error('FILE_CLEANUP_CLAIM_HANDLER');
    const work = claim.work;
    if (signal.aborted) return { state: 'pending', code: 'owner_pending' };
    try {
      return await transaction(async (session): Promise<StepOutcome> => {
        checkSignal(signal);
        const row = await jobs
          .aggregate<
            HousekeepingJobRecord & { ownerNow: Date }
          >([{ $match: { ...ownershipFilter(claim), handler: 'file.cleanup', work, 'execution.id': claim.executionId } }, { $addFields: { ownerNow: '$$NOW' } }], { session, maxTimeMS: QUERY_MS })
          .next();
        if (!row) throw new ClaimLost();
        const owner = { userId: work.subject.ownerUserId, tenantId: work.subject.tenantId };
        const scope = managedFileScope(owner);
        const file = await File.findOne({ ...scope, file_id: work.subject.fileId })
          .select(
            'user tenantId file_id uploadOperationId retentionAcceptedAt expiredAt retentionRevision deletionRequestedAt deletionCompletedAt +retentionActivity +derivedRetention +derivedOrigin +retentionRevocationId',
          )
          .session(session)
          .maxTimeMS(QUERY_MS)
          .lean<IMongoFile>();
        // Missing/completed metadata is not a physical deletion receipt.
        if (!file || file.deletionCompletedAt != null) throw new OwnerPending();
        const deadline = currentFileDeadline(file);
        if (
          deadline.deadlineGeneration !== work.deadlineGeneration ||
          deadline.migrationEpoch !== null ||
          !Number.isSafeInteger(file.retentionRevision) ||
          file.retentionRevision! < 0 ||
          file.retentionRevision! >= Number.MAX_SAFE_INTEGER
        )
          throw new OwnerPending();
        checkSignal(signal);
        if (work.revocationId === null) {
          if (
            row.execution.phase !== 'awaiting_deadline' ||
            file.deletionRequestedAt != null ||
            file.retentionRevocationId != null ||
            file.uploadOperationId !== work.subject.fileId ||
            deadline.deadlineAt.getTime() > row.ownerNow.getTime()
          )
            throw new OwnerPending();
          // Recheck the live ownership predicate at the actual write. The producer then observes
          // this fresh revision and intentionally fences the same claim through refreshDue.
          if (
            !(await store.advance(
              claim,
              { revision: row.progressRevision, phase: row.execution.phase },
              { phase: 'awaiting_deadline', code: 'progress' },
              session,
            ))
          )
            throw new ClaimLost();
          if (
            !(await fileOwner.revokeExpiredManagedUpload(
              owner,
              work.subject.fileId,
              deadline.deadlineAt.getTime(),
              row.ownerNow.getTime(),
              session,
            ))
          )
            throw new OwnerPending();
          const refreshed = await jobs.findOne(
            { _id: claim.jobId, 'execution.id': claim.executionId },
            { session, maxTimeMS: QUERY_MS },
          );
          const revoked = await File.findOne({ ...scope, file_id: work.subject.fileId })
            .select('deletionRequestedAt +retentionRevocationId')
            .session(session)
            .maxTimeMS(QUERY_MS)
            .lean<IMongoFile>();
          if (
            !refreshed ||
            refreshed.work.handler !== 'file.cleanup' ||
            !revoked?.deletionRequestedAt ||
            !revoked.retentionRevocationId ||
            refreshed.work.revocationId !== revoked.retentionRevocationId ||
            refreshed.state !== 'queued' ||
            refreshed.claim !== null ||
            refreshed.execution.phase !== 'awaiting_deadline' ||
            refreshed.fence <= claim.fence ||
            refreshed.progressRevision <= row.progressRevision + 1
          )
            throw new OwnerPending();
          checkSignal(signal);
          // This is a successful owner handoff, not a failed mutation. Reacquire this exact
          // execution with its new work/claim; never continue under the deliberately fenced token.
          return { state: 'lost' };
        }
        if (file.retentionRevocationId !== work.revocationId || !file.deletionRequestedAt)
          throw new OwnerPending();
        if (row.execution.phase !== 'awaiting_deadline') {
          // Observation only. The later lifecycle owner validates its own targets and receipts.
          return { state: 'progress', receiptRef: row.execution.receiptRef };
        }
        const touched = await File.updateOne(
          {
            ...scope,
            file_id: work.subject.fileId,
            retentionRevision: file.retentionRevision,
            retentionRevocationId: work.revocationId,
            deletionRequestedAt: file.deletionRequestedAt,
            deletionCompletedAt: null,
            expiredAt: deadline.deadlineAt,
            [`${deadline.kind === 'original' ? 'retentionActivity' : 'derivedRetention'}.deadlineGeneration`]:
              work.deadlineGeneration,
            'retentionActivity.migrationEpoch': { $exists: false },
            'derivedRetention.migrationEpoch': { $exists: false },
          },
          { $inc: { retentionRevision: 1 } },
          { session, timestamps: false, upsert: false, maxTimeMS: QUERY_MS },
        );
        if (!touched.acknowledged || touched.matchedCount !== 1) throw new OwnerPending();
        if (
          !(await store.advance(
            claim,
            { revision: row.progressRevision, phase: row.execution.phase },
            { phase: 'revoked', code: 'progress' },
            session,
          ))
        )
          throw new ClaimLost();
        checkSignal(signal);
        return { state: 'progress', receiptRef: row.execution.receiptRef };
      });
    } catch (error) {
      if (error instanceof ClaimLost) return { state: 'lost' };
      if (error instanceof Cancelled) return { state: 'pending', code: 'owner_pending' };
      if (error instanceof OwnerPending || error instanceof FileSourceUnavailableError)
        return { state: 'retry', code: 'owner_pending' };
      // A rejected/unknown commit is not rollback proof and never authorizes another effect.
      return { state: 'unknown' };
    }
  }
  return { enter };
}
