/** Shared finite File/job guards. Persistence and effects retain their existing owners. */
import type { ClientSession, Model, mongo } from 'mongoose';
import type {
  FileCleanupProgress,
  FileCleanupCapture,
  FileCleanupExpectation,
  FileCleanupResult,
} from '../types/fileCleanup';
import type { HousekeepingJobRecord } from '../models/housekeepingJob';
import type { JobClaim, JobPhase } from '../types/housekeeping';
import type { HousekeepingStore } from './housekeepingStore';
import type { IMongoFile } from '../types/file';
import {
  managedFileScope,
  currentFileDeadline,
  FileSourceUnavailableError,
} from './fileSourceAuthority';
import { ownershipFilter } from './housekeepingStore';
export const FILE_CLEANUP_QUERY_MS = 1000;
const QUERY_MS = FILE_CLEANUP_QUERY_MS;
const TRANSACTION_MS = 5000;
export class FileCleanupLost extends Error {}
export class FileCleanupPending extends Error {}
const Lost = FileCleanupLost;
const Pending = FileCleanupPending;
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;
const cursorValid = (value: unknown) =>
  value === null ||
  (typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 128);
export type FileCleanupRow = IMongoFile & { retentionCleanup?: FileCleanupProgress };
export type FileCleanupContext = { file: FileCleanupRow; job: HousekeepingJobRecord };
type FileRow = FileCleanupRow;
type Context = FileCleanupContext;
/** Total custody bound also applies when existing target methods rewrite the subdocument. */
export function assertFileCleanupCustody(value: FileCleanupProgress): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 32768)
    throw new Pending('custody_overflow');
}
export interface FileCleanupAuthority {
  File: Model<FileCleanupRow>;
  transaction<T>(
    signal: AbortSignal,
    action: (session: ClientSession) => Promise<T>,
  ): Promise<FileCleanupResult<T>>;
  targetScope(claim: JobClaim): {
    tenantId: string | null;
    ownerUserId: string;
    fileId: string;
    revocationId: string;
  };
  progress(context: FileCleanupContext): FileCleanupProgress;
  observation(context: FileCleanupContext): FileCleanupCapture;
  load(
    claim: JobClaim,
    session: ClientSession,
    expected?: FileCleanupExpectation,
  ): Promise<FileCleanupContext>;
  save(
    claim: JobClaim,
    context: FileCleanupContext,
    value: FileCleanupProgress,
    phase: JobPhase,
    session: ClientSession,
  ): Promise<FileCleanupCapture>;
  checkSignal(signal: AbortSignal): void;
}
export function assertFileCleanupProgress(context: FileCleanupContext): FileCleanupProgress {
  const value = context.file.retentionCleanup;
  if (
    !value ||
    value.schema !== 1 ||
    value.revocationId !== context.file.retentionRevocationId ||
    value.jobId !== context.job._id ||
    value.executionId !== context.job.execution.id ||
    !cursorValid(value.capture?.cursor) ||
    typeof value.capture.complete !== 'boolean' ||
    typeof value.capture.recoveryUnresolved !== 'boolean' ||
    !(value.generationReceiptRef === null || id(value.generationReceiptRef))
  )
    throw new Pending('owner_pending');
  assertFileCleanupCustody(value);
  return value;
}
export function createFileCleanupAuthority(
  mongoose: typeof import('mongoose'),
  store: HousekeepingStore,
): FileCleanupAuthority {
  if (store.model !== mongoose.models.HousekeepingJob || !mongoose.models.File)
    throw Error('FILE_CLEANUP_AUTHORITY_CONFIGURATION');
  const File = mongoose.models.File as Model<FileRow>;
  const jobs = store.model.collection as unknown as mongo.Collection<HousekeepingJobRecord>;
  const checkSignal = (signal: AbortSignal) => {
    if (signal.aborted) throw new Pending('owner_pending');
  };
  async function transaction<T>(
    signal: AbortSignal,
    action: (session: ClientSession) => Promise<T>,
  ): Promise<FileCleanupResult<T>> {
    if (signal.aborted) return { state: 'pending', reason: 'owner_pending' };
    const session = await mongoose.startSession();
    try {
      const value = await session.withTransaction(
        async () => {
          checkSignal(signal);
          const result = await action(session);
          checkSignal(signal);
          return result;
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority', wtimeout: TRANSACTION_MS },
          maxCommitTimeMS: QUERY_MS,
          timeoutMS: TRANSACTION_MS,
        },
      );
      return { state: 'progress', ...value } as FileCleanupResult<T>;
    } catch (error) {
      if (error instanceof Lost) return { state: 'lost' };
      if (error instanceof Pending) return { state: 'pending', reason: error.message };
      if (error instanceof FileSourceUnavailableError)
        return { state: 'pending', reason: 'owner_pending' };
      // An unknown commit must be reobserved, never treated as an uncommitted page/effect.
      return { state: 'unknown' };
    } finally {
      // Await the actual operations and session closure even when cancellation arrives.
      await session.endSession();
    }
  }
  function targetScope(claim: JobClaim) {
    if (claim.work.handler !== 'file.cleanup' || !claim.work.revocationId)
      throw new Pending('owner_pending');
    return {
      tenantId: claim.work.subject.tenantId,
      ownerUserId: claim.work.subject.ownerUserId,
      fileId: claim.work.subject.fileId,
      revocationId: claim.work.revocationId,
    };
  }
  const progress = assertFileCleanupProgress;
  function observation(context: Context): FileCleanupCapture {
    const value = progress(context);
    return {
      expected: {
        fileRevision: context.file.retentionRevision!,
        jobRevision: context.job.progressRevision,
        phase: context.job.execution.phase,
        cursor: value.capture.cursor,
      },
      progress: value,
    };
  }
  async function load(
    claim: JobClaim,
    session: ClientSession,
    expected?: FileCleanupExpectation,
  ): Promise<Context> {
    const scope = targetScope(claim);
    const job = await jobs.findOne(
      {
        ...ownershipFilter(claim),
        handler: 'file.cleanup',
        work: claim.work,
        'execution.id': claim.executionId,
      },
      { session, maxTimeMS: QUERY_MS },
    );
    if (!job) throw new Lost();
    const file = await File.findOne({
      ...managedFileScope({ userId: scope.ownerUserId, tenantId: scope.tenantId }),
      file_id: scope.fileId,
    })
      .select(
        'user tenantId file_id uploadOperationId retentionRevision expiredAt deletionRequestedAt deletionCompletedAt retentionAcceptedAt +retentionActivity +derivedRetention +derivedOrigin +retentionRevocationId +retentionCleanup +managedRetrieval +retrievalCreation',
      )
      .session(session)
      .maxTimeMS(QUERY_MS)
      .lean<FileRow>();
    if (
      !file ||
      file.deletionCompletedAt != null ||
      !file.deletionRequestedAt ||
      file.retentionRevocationId !== scope.revocationId ||
      !Number.isSafeInteger(file.retentionRevision) ||
      file.retentionRevision! < 0 ||
      file.retentionRevision! >= Number.MAX_SAFE_INTEGER
    )
      throw new Pending('owner_pending');
    const deadline = currentFileDeadline(file);
    if (
      claim.work.handler !== 'file.cleanup' ||
      deadline.migrationEpoch !== null ||
      deadline.deadlineGeneration !== claim.work.deadlineGeneration
    )
      throw new Pending('owner_pending');
    const context = { file, job };
    if (expected) {
      const current = observation(context).expected;
      if (
        current.fileRevision !== expected.fileRevision ||
        current.jobRevision !== expected.jobRevision ||
        current.phase !== expected.phase ||
        current.cursor !== expected.cursor
      )
        throw new Lost();
    }
    return context;
  }
  async function save(
    claim: JobClaim,
    context: Context,
    value: FileCleanupProgress,
    phase: JobPhase,
    session: ClientSession,
  ): Promise<FileCleanupCapture> {
    assertFileCleanupCustody(value);
    const scope = targetScope(claim);
    const deadline = currentFileDeadline(context.file);
    const touched = await File.updateOne(
      {
        ...managedFileScope({ userId: scope.ownerUserId, tenantId: scope.tenantId }),
        file_id: scope.fileId,
        retentionRevision: context.file.retentionRevision,
        retentionRevocationId: scope.revocationId,
        deletionRequestedAt: context.file.deletionRequestedAt,
        deletionCompletedAt: null,
        expiredAt: deadline.deadlineAt,
        [`${deadline.kind === 'original' ? 'retentionActivity' : 'derivedRetention'}.deadlineGeneration`]:
          deadline.deadlineGeneration,
        'retentionActivity.migrationEpoch': { $exists: false },
        'derivedRetention.migrationEpoch': { $exists: false },
      },
      { $set: { retentionCleanup: value }, $inc: { retentionRevision: 1 } },
      { session, timestamps: false, upsert: false, maxTimeMS: QUERY_MS },
    );
    if (!touched.acknowledged || touched.matchedCount !== 1) throw new Lost();
    if (
      !(await store.advance(
        claim,
        { revision: context.job.progressRevision, phase: context.job.execution.phase },
        phase === 'complete'
          ? { phase, state: 'settled', code: 'settled', receiptRef: value.lifecycle?.completionRef }
          : { phase, code: 'progress' },
        session,
      ))
    )
      throw new Lost();
    context.file.retentionCleanup = value;
    context.file.retentionRevision!++;
    context.job.progressRevision++;
    context.job.execution.phase = phase;
    return observation(context);
  }
  return { File, transaction, targetScope, progress, observation, load, save, checkSignal };
}

/** Internal completion reads await the original operations in one bounded owner snapshot. */
export async function readFileCleanupSnapshot<T>(
  mongoose: typeof import('mongoose'),
  options: Readonly<{ deadlineAt: number; signal: AbortSignal }>,
  read: (session: ClientSession, remaining: () => number, deadlineAt: number) => Promise<T>,
): Promise<T> {
  const { deadlineAt, signal } = options;
  if (!Number.isSafeInteger(deadlineAt) || !signal || typeof signal.addEventListener !== 'function')
    throw new TypeError('FILE_COMPLETION_INPUT');
  const budget = Math.min(TRANSACTION_MS, deadlineAt - Date.now());
  const until = performance.now() + budget;
  const endAt = Math.min(deadlineAt, Date.now() + budget);
  const remaining = () => {
    const ms = Math.floor(Math.min(until - performance.now(), endAt - Date.now()));
    if (signal.aborted || ms <= 0) throw Error('FILE_COMPLETION_UNAVAILABLE');
    return Math.min(QUERY_MS, ms);
  };
  remaining();
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(
      async () => {
        remaining();
        const value = await read(session, remaining, endAt);
        remaining();
        return value;
      },
      {
        readConcern: { level: 'snapshot' },
        readPreference: 'primary',
        writeConcern: { w: 'majority', wtimeout: budget },
        maxCommitTimeMS: remaining(),
        timeoutMS: budget,
      },
    );
  } finally {
    await session.endSession();
  }
}
