/** Finite all-File census at the existing migration owner; native authority is an executable port. */
import { performance } from 'node:perf_hooks';
import {
  FILE_HOUSEKEEPING_COVERAGE_CONTRACT,
  FILE_HOUSEKEEPING_INVENTORY_CONTRACT,
  canonicalManagedJson,
} from 'librechat-data-provider';
import type {
  FileCoverageAction,
  FileCoverageCatalog,
  FileCoverageRun,
  FileCoverageNativeBinding,
  FileCoverageSource,
  FileCoverageReceipt,
  FileCoveragePopulation,
  FileCoverageResult,
  FileCoverageFailureCode,
  FileCoverageInvalidateReason,
  FileInventoryRequest,
  FileInventoryCounts,
  FileInventoryResult,
} from 'librechat-data-provider';
import type { ClientSession, mongo, Mongoose } from 'mongoose';
import type { UploadStore, GlobalState, CounterRow } from './uploadManagementStore';
import type { HousekeepingJobRecord } from '~/models/housekeepingJob';
import type { IMongoFile } from '~/types/file';
import {
  isFileCoverageInteger as integer,
  isFileCoverageHash as hash,
  isFileCoverageIdentifier as id,
  fileCoverageDigest as digest,
  sameFileCoverageData as same,
  isFileCoverageSource as source,
  isFileCoverageNativeBinding as native,
  isFileCoverageAction as action,
  isFileCoveragePopulation as population,
  readFileCoverageReceipt,
  isFileInventoryRequest,
} from './fileHousekeepingCoverageContract';
import { classifyFileCoverage, prepareStandaloneFileCoverage } from './fileRetentionMigration';
import { housekeepingWorkIdentity, assertWork } from './housekeepingProjection';
import { fileHousekeepingObligations } from './fileHousekeepingProjection';
import { createHousekeepingStore } from './housekeepingStore';
import { currentFileDeadline } from './fileSourceAuthority';

/** Authenticated by the actual guarded native owner, never issued from serialized claims here. */
export interface FileCoverageNativeHold {
  readonly binding: FileCoverageNativeBinding;
  readonly source: FileCoverageSource;
  assertCurrent(signal: AbortSignal): Promise<void>;
}
export interface FileCoverageNativeProducer {
  /** Hold actual invocation/writer/timer exclusion through use, commit and original client closure.
   * No production adapter is supplied here. A fixture adapter proves only database behavior. */
  withCurrentQuiescence<T>(
    action: Exclude<FileCoverageAction, { action: 'inspect' }>,
    signal: AbortSignal,
    use: (hold: FileCoverageNativeHold) => Promise<T>,
  ): Promise<T>;
}
export type FileCoverageState =
  | {
      version: 1;
      generation: number;
      phase: 'invalid';
      requestSha256: string;
      reason: FileCoverageInvalidateReason;
    }
  | { version: 1; generation: number; phase: 'preparing'; runSha256: string }
  | {
      version: 1;
      generation: number;
      phase: 'sealed';
      runSha256: string;
      receipt: FileCoverageReceipt;
    };
export type FileCoverageMigrationState = {
  role: 'file-coverage';
  epoch: string;
  phase: 'files' | 'jobs' | 'ready';
  run: FileCoverageRun;
  runSha256: string;
  checkpoint: number;
  cursor: string | null;
  population: FileCoveragePopulation;
  filesSha256: string;
  jobsSha256: string;
};
export interface FileHousekeepingCoverageMethods {
  execute(action: FileCoverageAction, signal: AbortSignal): Promise<FileCoverageResult>;
}

const PAGE = 32,
  BUDGET = 3000,
  RESERVE = 150;
class CoverageError extends Error {
  constructor(readonly code: FileCoverageFailureCode) {
    super(code);
  }
}
function fail(code: FileCoverageFailureCode): never {
  throw new CoverageError(code);
}
const empty = (): FileCoveragePopulation => ({
  filesSeen: 0,
  retainedFiles: 0,
  excludedFiles: 0,
  fileJobsSeen: 0,
  unclassifiedFiles: 0,
  unclassifiedJobs: 0,
});
const initial = (lane: string): string => digest(['file-coverage-v1', lane]);
// BSON field names such as _id are data, not provider schema keys. Typed arrays preserve their
// exact sorted spelling without weakening the existing canonical serializer's schema-key rules.
function censusValue(value: unknown): unknown {
  if (Array.isArray(value)) return ['array', value.map(censusValue)];
  if (value && typeof value === 'object')
    return [
      'object',
      Object.entries(value)
        .sort(([a], [b]) => {
          if (a === b) return 0;
          return a < b ? -1 : 1;
        })
        .map(([key, item]) => [key, censusValue(item)]),
    ];
  return value;
}
const leaf = (before: string, row: unknown): string =>
  digest([before, censusValue(JSON.parse(JSON.stringify(row)))]);
const fields = Object.fromEntries(
  [
    '_id',
    'user',
    'tenantId',
    'file_id',
    'expiredAt',
    'expiresAt',
    'retentionAcceptedAt',
    'retentionRevision',
    'retentionActivity',
    'derivedRetention',
    'derivedOrigin',
    'retentionRevocationId',
    'deletionRequestedAt',
    'deletionCompletedAt',
    'deletionRetryAt',
    'deletionAttempts',
    'uploadOperationId',
  ].map((key) => [key, 1]),
);

export function createFileHousekeepingCoverageMethods(
  store: UploadStore,
  nativeProducer?: FileCoverageNativeProducer,
): FileHousekeepingCoverageMethods {
  const { mongoose, Counter } = store;
  const File = mongoose.models.File;
  const jobs = createHousekeepingStore(mongoose);
  const files = File.collection as unknown as mongo.Collection<IMongoFile>;
  const collection = jobs.model.collection as unknown as mongo.Collection<HousekeepingJobRecord>;
  type GlobalCounter = Omit<CounterRow, 'value'> & { value: GlobalState };
  const counters = Counter.collection as unknown as mongo.Collection<GlobalCounter>;
  function options(session: ClientSession, end: number, signal: AbortSignal) {
    if (signal.aborted || performance.now() >= end - RESERVE) fail('deadline');
    const ms = Math.max(1, Math.floor(end - performance.now() - RESERVE));
    return {
      session,
      signal,
      ...(session.inTransaction() ? {} : { timeoutMS: ms }),
      maxTimeMS: ms,
    };
  }
  async function owner(session: ClientSession, end: number, signal: AbortSignal) {
    const row = await counters.findOne(
      { _id: 'global' },
      {
        ...options(session, end, signal),
        readPreference: 'primary',
      },
    );
    if (!row || !integer(row.revision) || !row.value || typeof row.value.storeId !== 'string')
      fail('unavailable');
    return row;
  }
  /** Actual primary catalog, bracketed with the same original read/session custody.
   * Equal observations do not supply writer/controller or historical-operation exclusion. */
  async function inspectCatalog(session: ClientSession, end: number, signal: AbortSignal) {
    const db = mongoose.connection.db;
    if (!db) fail('unavailable');
    const readOptions = () => ({
      ...options(session, end, signal),
      readPreference: 'primary' as const,
    });
    const cursor = db.listCollections({ name: 'files' }, readOptions());
    let collections: mongo.CollectionInfo[];
    try {
      collections = await cursor.toArray();
    } finally {
      await cursor.close();
    }
    const info = collections[0],
      uuid = info?.info?.uuid;
    if (
      collections.length !== 1 ||
      info.type !== 'collection' ||
      Object.keys(info.options ?? {}).length !== 0 ||
      uuid?._bsontype !== 'Binary' ||
      uuid.sub_type !== 4 ||
      uuid.buffer.byteLength !== 16
    )
      fail('unavailable');
    const indexCursor = db.collection('files').listIndexes(readOptions());
    let indexes: mongo.Document[];
    try {
      indexes = await indexCursor.toArray();
    } finally {
      await indexCursor.close();
    }
    if (indexes.length > 64) fail('capacity');
    indexes.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (
      indexes.some((index) => !id(index.name)) ||
      new Set(indexes.map((index) => index.name)).size !== indexes.length
    )
      fail('unavailable');
    const ttl = indexes.filter((index) =>
      Object.prototype.hasOwnProperty.call(index, 'expireAfterSeconds'),
    );
    if (ttl.length > 16) fail('capacity');
    const metadataDigest = (value: unknown) =>
      digest(censusValue(JSON.parse(JSON.stringify(value))));
    const catalog: FileCoverageCatalog = {
      collectionUuid: uuid.toUUID().toHexString(),
      fileTtlIndexes: ttl.map((index) => ({
        name: index.name as string,
        indexSha256: metadataDigest(index),
      })),
    };
    return { catalog, metadataSha256: metadataDigest([collections, indexes]) };
  }
  function current(global: GlobalState, request: FileCoverageRun): FileCoverageMigrationState {
    const state = global.migration;
    if (global.storeId !== request.storeId) fail('store_changed');
    if (
      global.fileHousekeepingCoverage?.generation !== request.generation ||
      global.fileHousekeepingCoverage.phase !== 'preparing' ||
      global.fileHousekeepingCoverage.runSha256 !== digest(request)
    )
      fail('generation_conflict');
    if (!state || state.role !== 'file-coverage' || state.runSha256 !== digest(request))
      fail('migration_conflict');
    return state;
  }
  function progress(state: FileCoverageMigrationState): FileCoverageResult {
    return {
      outcome: 'progress',
      generation: state.run.generation,
      runSha256: state.runSha256,
      checkpoint: state.checkpoint,
      lane: state.phase,
      population: state.population,
    };
  }
  async function jobKnown(
    row: HousekeepingJobRecord,
    session: ClientSession,
    end: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      assertWork(row.work);
      if (
        row.version !== 1 ||
        row.handler !== row.work.handler ||
        row._id !== housekeepingWorkIdentity(row.work).id ||
        row.identityHash !== row._id ||
        !integer(row.progressRevision) ||
        !integer(row.fence) ||
        !integer(row.attempts) ||
        !integer(row.recoveries) ||
        row.claim !== null ||
        ![row.dueAt, row.nextAttemptAt].every(
          (value) => value instanceof Date && Number.isFinite(value.getTime()),
        ) ||
        !(
          row.retryNotBefore === null ||
          (row.retryNotBefore instanceof Date && Number.isFinite(row.retryNotBefore.getTime()))
        ) ||
        !['queued', 'waiting', 'settled', 'superseded', 'missed'].includes(row.state) ||
        !row.execution ||
        !id(row.execution.id) ||
        ['armed', 'unknown'].includes(row.execution.phase)
      )
        return false;
      // Certification must not hide a runnable schedule that bypasses its retained lower bounds.
      if (
        ['queued', 'waiting'].includes(row.state) &&
        (row.nextAttemptAt < row.dueAt ||
          (row.retryNotBefore instanceof Date && row.nextAttemptAt < row.retryNotBefore))
      )
        return false;
      if (row.handler === 'upload.cleanup') return true;
      const work = row.work;
      if (
        work.handler === 'upload.cleanup' ||
        row.subjectId !== work.subject.fileId ||
        row.generation !== work.deadlineGeneration
      )
        return false;
      const file = await files.findOne(
        {
          file_id: work.subject.fileId,
          user: new mongoose.Types.ObjectId(work.subject.ownerUserId),
          tenantId: { $eq: work.subject.tenantId, $exists: true },
        } as unknown as mongo.Filter<IMongoFile>,
        { ...options(session, end, signal), projection: fields },
      );
      if (
        !file ||
        classifyFileCoverage(file) !== 'retained' ||
        work.deadlineGeneration > currentFileDeadline(file).deadlineGeneration
      )
        return false;
      if (
        row.handler === 'file.cleanup' &&
        file.deletionRetryAt instanceof Date &&
        (!(row.retryNotBefore instanceof Date) || row.retryNotBefore < file.deletionRetryAt)
      )
        return false;
      return true;
    } catch (error) {
      if (error instanceof CoverageError) throw error;
      return false;
    }
  }
  async function fileKnown(
    file: IMongoFile,
    session: ClientSession,
    end: number,
    signal: AbortSignal,
  ): Promise<'excluded' | 'retained' | 'unknown'> {
    const kind = classifyFileCoverage(file);
    if (kind !== 'retained') return kind;
    for (const item of fileHousekeepingObligations(file)) {
      const row = await collection.findOne(
        { _id: housekeepingWorkIdentity(item.work).id },
        options(session, end, signal),
      );
      if (
        !row ||
        !(await jobKnown(row, session, end, signal)) ||
        !same(row.work, item.work) ||
        row.dueAt.getTime() !== item.dueAt.getTime()
      )
        return 'unknown';
    }
    return 'retained';
  }
  async function page(
    state: FileCoverageMigrationState,
    session: ClientSession,
    end: number,
    signal: AbortSignal,
    repair: boolean,
  ): Promise<void> {
    const count = { ...state.population };
    if (state.phase === 'files') {
      const rows = await files
        .find(state.cursor ? { _id: { $gt: new mongoose.Types.ObjectId(state.cursor) } } : {}, {
          ...options(session, end, signal),
          projection: fields,
          hint: '_id_',
          sort: { _id: 1 },
          limit: PAGE,
          batchSize: PAGE,
        })
        .toArray();
      for (const file of rows) {
        if (!(file._id instanceof mongoose.Types.ObjectId)) fail('unclassified');
        const kind = repair
          ? await prepareStandaloneFileCoverage(mongoose, file, new Date(), session)
          : await fileKnown(file, session, end, signal);
        count.filesSeen++;
        if (kind === 'retained') count.retainedFiles++;
        else if (kind === 'excluded') count.excludedFiles++;
        else count.unclassifiedFiles++;
        state.filesSha256 = leaf(state.filesSha256, file);
        state.cursor = String(file._id);
      }
      if (rows.length < PAGE) {
        state.phase = 'jobs';
        state.cursor = null;
      }
    } else if (state.phase === 'jobs') {
      const rows = await collection
        .find(state.cursor ? { _id: { $gt: state.cursor } } : {}, {
          ...options(session, end, signal),
          hint: '_id_',
          sort: { _id: 1 },
          limit: PAGE,
          batchSize: PAGE,
        })
        .toArray();
      for (const row of rows) {
        if (typeof row._id !== 'string' || !hash(row._id)) fail('unclassified');
        if (row.handler !== 'upload.cleanup' || row.work?.handler !== 'upload.cleanup') {
          count.fileJobsSeen++;
          if (!(await jobKnown(row, session, end, signal))) count.unclassifiedJobs++;
          state.jobsSha256 = leaf(state.jobsSha256, row);
        }
        state.cursor = row._id;
      }
      if (rows.length < PAGE) {
        state.phase = 'ready';
        state.cursor = null;
      }
    }
    if (!population(count)) fail('capacity');
    state.population = count;
    state.checkpoint++;
    if (!integer(state.checkpoint)) fail('capacity');
  }
  async function transaction<T>(
    end: number,
    signal: AbortSignal,
    work: (row: GlobalCounter, session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const session = mongoose.connection.getClient().startSession();
    let failure: unknown,
      attempted = false;
    try {
      const result = await session.withTransaction(
        async () => {
          try {
            const row = await owner(session, end, signal),
              revision = row.revision;
            attempted = true;
            const value = await work(row, session);
            row.value.revision++;
            const saved = await counters.updateOne(
              { _id: 'global', revision },
              { $set: { value: row.value }, $inc: { revision: 1 } },
              options(session, end, signal),
            );
            if (saved.matchedCount !== 1) fail('generation_conflict');
            return value;
          } catch (error) {
            failure = error;
            // Abort inside this original callback using the same remaining budget. Returning from
            // an aborted transaction prevents the driver's default refreshed abort/retry budget.
            try {
              await session.abortTransaction({
                timeoutMS: Math.max(1, Math.floor(end - performance.now())),
              });
            } catch {
              failure = new CoverageError('unknown_commit');
            }
            return undefined;
          }
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority', wtimeout: 1000 },
          maxCommitTimeMS: 1000,
          timeoutMS: Math.max(1, Math.floor(end - performance.now() - RESERVE)),
        },
      );
      if (failure) throw failure;
      return result as T;
    } catch (error) {
      if (error instanceof CoverageError) throw error;
      fail(attempted ? 'unknown_commit' : 'unavailable');
    } finally {
      await session.endSession();
    }
  }
  async function verify(
    request: FileCoverageRun,
    checkpoint: number,
    end: number,
    signal: AbortSignal,
  ) {
    const session = mongoose.connection.getClient().startSession({
      snapshot: true,
      causalConsistency: false,
      defaultTimeoutMS: Math.max(1, Math.floor(end - performance.now())),
    });
    try {
      const row = await owner(session, end, signal),
        state = current(row.value, request);
      if (state.checkpoint !== checkpoint || state.phase !== 'ready') fail('checkpoint_conflict');
      const census: FileCoverageMigrationState = {
        ...state,
        phase: 'files',
        cursor: null,
        checkpoint: 0,
        population: empty(),
        filesSha256: initial('files'),
        jobsSha256: initial('jobs'),
      };
      while (census.phase !== 'ready') await page(census, session, end, signal, false);
      if (census.population.unclassifiedFiles || census.population.unclassifiedJobs)
        fail('unclassified');
      // mongodb6.20 pins this actual server timestamp (sessions.ts1158-1163); its public
      // declaration omits the internal field. Never substitute operationTime or Date.now().
      const time = (session as ClientSession & { snapshotTime?: mongo.Timestamp }).snapshotTime;
      if (!time) fail('unavailable');
      return {
        population: census.population as FileCoverageReceipt['population'],
        filesSha256: census.filesSha256,
        jobsSha256: census.jobsSha256,
        projectionSha256: digest([census.filesSha256, census.jobsSha256]),
        snapshot: {
          seconds: time.getHighBitsUnsigned(),
          increment: time.getLowBitsUnsigned(),
          observedAt: new Date(time.getHighBitsUnsigned() * 1000).toISOString(),
        },
      };
    } finally {
      await session.endSession();
    }
  }
  async function perform(
    input: Exclude<FileCoverageAction, { action: 'inspect' }>,
    signal: AbortSignal,
    hold: FileCoverageNativeHold,
  ): Promise<FileCoverageResult> {
    await hold.assertCurrent(signal);
    if (!native(hold.binding) || !source(hold.source)) fail('native_changed');
    const deadline =
      input.action === 'invalidate' ? input.originalDeadline : input.run.originalDeadline;
    if (signal.aborted || Date.parse(deadline) <= Date.now()) fail('deadline');
    const end = performance.now() + Math.min(BUDGET, Date.parse(deadline) - Date.now());
    if (input.action === 'invalidate')
      return transaction(end, signal, async (row) => {
        if (row.value.storeId !== input.storeId) fail('store_changed');
        const old = row.value.fileHousekeepingCoverage,
          requestSha256 = digest(input);
        if (old?.phase === 'invalid' && old.requestSha256 === requestSha256)
          return { outcome: 'invalidated', generation: old.generation, requestSha256 };
        if (
          (old?.generation ?? 0) !== input.expectedGeneration ||
          !integer(input.expectedGeneration + 1)
        )
          fail('generation_conflict');
        const generation = input.expectedGeneration + 1;
        row.value.fileHousekeepingCoverage = {
          version: 1,
          phase: 'invalid',
          generation,
          requestSha256,
          reason: input.reason,
        };
        if (row.value.migration?.role === 'file-coverage') {
          delete row.value.migration;
          delete row.value.migrationEpoch;
        }
        return { outcome: 'invalidated', generation, requestSha256 };
      });
    const request = input.run,
      runSha256 = digest(request);
    if (!same(request.native, hold.binding) || !same(request.source, hold.source))
      fail('native_changed');
    if (input.action === 'prepare-ttl') {
      // This observation runs inside the SAME executable native hold, before native DDL.
      // Neither its counts nor its selector can discharge other original-work obligations.
      const session = mongoose.connection.getClient().startSession();
      try {
        const row = await owner(session, end, signal);
        if (row.value.storeId !== request.storeId) fail('store_changed');
        if ((row.value.fileHousekeepingCoverage?.generation ?? 0) + 1 !== request.generation)
          fail('generation_conflict');
        if (row.value.migration || row.value.migrationEpoch) fail('migration_conflict');
      } finally {
        try {
          await session.endSession();
        } catch {
          fail('unknown_commit');
        }
      }
      const observation = await observeFileHousekeepingInventory(
        mongoose,
        {
          action: 'inventory',
          version: 1,
          requestId: request.requestId,
          source: request.source,
          target: {
            namespaceUid: request.native.namespaceUid,
            mongoReplicaSet: request.native.mongoReplicaSet,
            mongoDatabase: request.native.mongoDatabase,
          },
          originalDeadline: request.originalDeadline,
          lookAheadMs: 0,
        },
        signal,
        input,
      );
      if (observation.outcome !== 'inventoried') fail(observation.code);
      await hold.assertCurrent(signal);
      const { counts } = observation;
      if (
        counts.totalFiles !== counts.expiresAtAbsentOrNull ||
        counts.expiresAtScalarDate !== 0 ||
        counts.expiresAtArray !== 0 ||
        counts.expiresAtOther !== 0
      )
        fail('unclassified');
      if (
        !observation.catalogStable ||
        !observation.primaryStable ||
        observation.ttl.semantics !== 'supported-scalar'
      )
        fail('unavailable');
      return {
        outcome: 'prepared',
        storeId: request.storeId,
        generation: request.generation,
        runSha256,
        collectionUuid: input.collectionUuid,
        indexName: input.indexName,
        indexSha256: input.indexSha256,
        snapshot: observation.snapshot,
        population: {
          totalFiles: counts.totalFiles,
          expiresAtAbsentOrNull: counts.expiresAtAbsentOrNull,
          expiresAtScalarDate: counts.expiresAtScalarDate,
          expiresAtArray: counts.expiresAtArray,
          expiresAtOther: counts.expiresAtOther,
        },
      };
    }
    if (input.action === 'begin')
      return transaction(end, signal, async (row) => {
        if (row.value.storeId !== request.storeId) fail('store_changed');
        const old = row.value.fileHousekeepingCoverage;
        if (
          old?.generation === request.generation &&
          old.phase === 'preparing' &&
          old.runSha256 === runSha256
        )
          return progress(current(row.value, request));
        if ((old?.generation ?? 0) + 1 !== request.generation) fail('generation_conflict');
        if (row.value.migration || row.value.migrationEpoch) fail('migration_conflict');
        const state: FileCoverageMigrationState = {
          role: 'file-coverage',
          epoch: request.requestId,
          run: request,
          runSha256,
          phase: 'files',
          checkpoint: 0,
          cursor: null,
          population: empty(),
          filesSha256: initial('files'),
          jobsSha256: initial('jobs'),
        };
        row.value.migration = state;
        row.value.migrationEpoch = request.requestId;
        row.value.fileHousekeepingCoverage = {
          version: 1,
          phase: 'preparing',
          generation: request.generation,
          runSha256,
        };
        return progress(state);
      });
    if (input.action === 'advance')
      return transaction(end, signal, async (row, session) => {
        const state = current(row.value, request);
        if (state.checkpoint !== input.expectedCheckpoint) fail('checkpoint_conflict');
        if (state.phase !== 'ready') await page(state, session, end, signal, true);
        return progress(state);
      });
    const candidate = await verify(request, input.expectedCheckpoint, end, signal);
    await hold.assertCurrent(signal);
    return transaction(end, signal, async (row, session) => {
      const state = current(row.value, request);
      if (state.checkpoint !== input.expectedCheckpoint || state.phase !== 'ready')
        fail('checkpoint_conflict');
      const [clock] = await counters
        .aggregate<{
          now: Date;
        }>(
          [{ $match: { _id: 'global' } }, { $project: { now: '$$NOW' } }],
          options(session, end, signal),
        )
        .toArray();
      if (!clock?.now) fail('unavailable');
      const body = {
        version: 1 as const,
        storeId: request.storeId,
        generation: request.generation,
        runSha256,
        contract: FILE_HOUSEKEEPING_COVERAGE_CONTRACT,
        source: request.source,
        native: request.native,
        ...candidate,
        sealedAt: clock.now.toISOString(),
      };
      const receipt: FileCoverageReceipt = { ...body, receiptSha256: digest(body) };
      row.value.fileHousekeepingCoverage = {
        version: 1,
        phase: 'sealed',
        generation: request.generation,
        runSha256,
        receipt,
      };
      delete row.value.migration;
      delete row.value.migrationEpoch;
      return { outcome: 'sealed', receipt };
    });
  }
  async function guarded(
    input: Exclude<FileCoverageAction, { action: 'inspect' }>,
    signal: AbortSignal,
  ): Promise<FileCoverageResult> {
    if (!nativeProducer) fail('native_unavailable');
    const abort = new AbortController();
    const relay = () => abort.abort(signal.reason);
    if (signal.aborted) relay();
    else signal.addEventListener('abort', relay, { once: true });
    const owned: { operation?: Promise<FileCoverageResult>; ended: boolean } = { ended: false };
    let accepting = true,
      producerError: unknown;
    try {
      try {
        await nativeProducer.withCurrentQuiescence(input, abort.signal, (hold) => {
          if (!accepting || owned.operation) fail('native_changed');
          owned.operation = perform(input, abort.signal, hold).finally(() => {
            owned.ended = true;
          });
          return owned.operation;
        });
      } catch (error) {
        producerError = error;
      } finally {
        accepting = false;
      }
      if (!owned.operation) fail('native_changed');
      if (!owned.ended) {
        // A broken adapter cannot detach original DB work. Cancel and join it, including close;
        // an early native release is uncertain even if the database eventually reports success.
        abort.abort();
        try {
          await owned.operation;
        } catch {
          /* Original rejection is now joined. */
        }
        fail('unknown_commit');
      }
      const result = await owned.operation;
      if (producerError) fail('unknown_commit');
      return result;
    } finally {
      signal.removeEventListener('abort', relay);
    }
  }
  return {
    async execute(input, signal) {
      try {
        if (!action(input) || Buffer.byteLength(canonicalManagedJson(input)) > 16384)
          fail('invalid_input');
        if (input.action === 'inspect') {
          const end = performance.now() + BUDGET;
          const session = mongoose.connection.getClient().startSession();
          let result: Extract<FileCoverageResult, { outcome: 'observed' }>;
          try {
            const row = await owner(session, end, signal);
            if (row.value.storeId !== input.storeId) fail('store_changed');
            const first = await inspectCatalog(session, end, signal);
            const state = row.value.fileHousekeepingCoverage;
            if (
              state &&
              (!integer(state.generation) ||
                !['invalid', 'preparing', 'sealed'].includes(state.phase))
            )
              fail('unavailable');
            const receipt =
              state?.phase === 'sealed' &&
              state.generation === input.generation &&
              state.runSha256 === input.runSha256
                ? readFileCoverageReceipt(state.receipt, input.storeId)
                : null;
            if (
              receipt &&
              (receipt.generation !== input.generation || receipt.runSha256 !== input.runSha256)
            )
              fail('unavailable');
            const last = await inspectCatalog(session, end, signal);
            const current = await owner(session, end, signal);
            if (current.value.storeId !== input.storeId) fail('store_changed');
            if (!same(current.value.fileHousekeepingCoverage ?? null, state ?? null))
              fail('generation_conflict');
            if (first.metadataSha256 !== last.metadataSha256) fail('unavailable');
            result = {
              outcome: 'observed',
              generation: state?.generation ?? null,
              phase: state?.phase ?? 'absent',
              receipt,
              catalog: last.catalog,
            };
          } finally {
            await session.endSession();
          }
          if (signal.aborted || performance.now() >= end) fail('deadline');
          return result;
        }
        return await guarded(input, signal);
      } catch (error) {
        const code = error instanceof CoverageError ? error.code : 'unavailable';
        return { outcome: code === 'unknown_commit' ? 'unknown' : 'refused', code };
      }
    },
  };
}

/** Fixed raw snapshot observation, deliberately independent of UploadStore and its Counter.
 * Neither a zero count nor matching bracketing metadata establishes a held interval.
 * The caller retains the original client until this operation and session have settled.
 */
export async function inspectFileHousekeepingInventory(
  mongoose: Pick<Mongoose, 'connection'>,
  request: FileInventoryRequest,
  signal: AbortSignal,
): Promise<FileInventoryResult> {
  return observeFileHousekeepingInventory(mongoose, request, signal);
}

/** Shared raw observation; a preparation selector is supplied only by the guarded owner above. */
async function observeFileHousekeepingInventory(
  mongoose: Pick<Mongoose, 'connection'>,
  request: FileInventoryRequest,
  signal: AbortSignal,
  selector?: Extract<FileCoverageAction, { action: 'prepare-ttl' }>,
): Promise<FileInventoryResult> {
  if (!isFileInventoryRequest(request)) return { outcome: 'refused', code: 'invalid_input' };
  const remainingDeadline = Date.parse(request.originalDeadline) - Date.now();
  if (remainingDeadline <= 0 || signal.aborted) return { outcome: 'refused', code: 'deadline' };
  // A preparation inherits A's original deadline; its local observation is still bounded by BUDGET.
  if (!selector && remainingDeadline > 300_000)
    return { outcome: 'refused', code: 'invalid_input' };
  const end = performance.now() + Math.min(BUDGET, remainingDeadline);
  let session: ClientSession | undefined;
  let result: FileInventoryResult = { outcome: 'refused', code: 'unavailable' };
  try {
    const db = mongoose.connection.db;
    if (!db || db.databaseName !== request.target.mongoDatabase) fail('unavailable');
    const options = () => {
      if (signal.aborted || performance.now() >= end - RESERVE) fail('deadline');
      const ms = Math.max(1, Math.floor(end - performance.now() - RESERVE));
      return { maxTimeMS: ms, timeoutMS: ms, signal, readPreference: 'primary' as const };
    };
    const metadataDigest = (value: unknown) =>
      digest(censusValue(JSON.parse(JSON.stringify(value))));
    async function server() {
      const hello = await db!.command({ hello: 1, maxTimeMS: options().maxTimeMS }, options());
      if (
        hello.isWritablePrimary !== true ||
        hello.setName !== request.target.mongoReplicaSet ||
        !(hello.localTime instanceof Date) ||
        !Number.isFinite(hello.localTime.getTime()) ||
        typeof hello.me !== 'string' ||
        !hello.electionId ||
        !hello.topologyVersion?.processId
      )
        fail('unavailable');
      return {
        time: hello.localTime as Date,
        identity: metadataDigest([
          hello.me,
          hello.setName,
          hello.electionId,
          hello.topologyVersion.processId,
        ]),
      };
    }
    async function catalog() {
      const cursor = db!.listCollections({ name: 'files' }, options());
      let collections: mongo.CollectionInfo[];
      try {
        collections = await cursor.toArray();
      } finally {
        try {
          await cursor.close();
        } catch {
          fail(selector ? 'unknown_commit' : 'unavailable');
        }
      }
      if (collections.length > 1 || (collections[0] && collections[0].type !== 'collection'))
        fail('unavailable');
      let indexes: mongo.Document[] = [];
      if (collections.length) {
        const cursor = db!.collection('files').listIndexes(options());
        try {
          indexes = await cursor.toArray();
        } finally {
          try {
            await cursor.close();
          } catch {
            fail(selector ? 'unknown_commit' : 'unavailable');
          }
        }
      }
      if (indexes.length > 64) fail('capacity');
      if (selector) {
        const info = collections[0];
        const uuid = info?.info?.uuid;
        if (
          collections.length !== 1 ||
          Object.keys(info.options ?? {}).length !== 0 ||
          uuid?._bsontype !== 'Binary' ||
          uuid.sub_type !== 4 ||
          uuid.buffer.byteLength !== 16 ||
          uuid.toUUID().toHexString() !== selector.collectionUuid
        )
          fail('unavailable');
        const ttl = indexes.filter((index) =>
          Object.prototype.hasOwnProperty.call(index, 'expireAfterSeconds'),
        );
        if (
          ttl.length !== 1 ||
          ttl[0].name !== selector.indexName ||
          metadataDigest(ttl[0]) !== selector.indexSha256
        )
          fail('unavailable');
      }
      indexes.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return {
        present: collections.length === 1,
        collectionSha256: metadataDigest(collections),
        indexSha256: metadataDigest(indexes),
        indexes,
      };
    }
    const before = await server();
    const first = await catalog();
    const ttlIndexes = first.indexes.filter((index) =>
      Object.prototype.hasOwnProperty.call(index, 'expireAfterSeconds'),
    );
    if (ttlIndexes.length > 16) fail('capacity');
    const ttl = ttlIndexes.map((index) => {
      const seconds = index.expireAfterSeconds;
      const supported =
        Object.keys(index).every((key) =>
          ['v', 'key', 'name', 'expireAfterSeconds', 'background'].includes(key),
        ) &&
        index.v === 2 &&
        typeof index.name === 'string' &&
        (index.background === undefined || typeof index.background === 'boolean') &&
        index.key &&
        Object.keys(index.key).length === 1 &&
        index.key.expiresAt === 1 &&
        integer(seconds) &&
        seconds <= 2147483647;
      return {
        specSha256: metadataDigest(index),
        kind: supported ? ('expiresAt' as const) : ('unsupported' as const),
        expireAfterSeconds: supported ? (seconds as number) : null,
      };
    });
    const horizon = new Date(before.time.getTime() + request.lookAheadMs);
    const ttlSeconds =
      ttl.length === 1 && ttl[0].kind === 'expiresAt' ? ttl[0].expireAfterSeconds! : 0;
    const due = new Date(before.time.getTime() - ttlSeconds * 1000);
    const dueByHorizon = new Date(horizon.getTime() - ttlSeconds * 1000);
    const type = (field: string) => ({ $type: '$' + field });
    const absent = (field: string) => ({ $in: [type(field), ['missing', 'null']] });
    const present = (field: string) => ({ $not: [absent(field)] });
    const isType = (field: string, value: string) => ({ $eq: [type(field), value] });
    const managed = present('uploadOperationId');
    const standalone = { $and: [absent('uploadOperationId'), present('retentionAcceptedAt')] };
    const inherited = {
      $and: [
        absent('uploadOperationId'),
        absent('retentionAcceptedAt'),
        isType('expiredAt', 'date'),
      ],
    };
    const validString = (field: string, regex: string) => ({
      $cond: [isType(field, 'string'), { $regexMatch: { input: '$' + field, regex } }, false],
    });
    const identity = {
      $and: [
        validString('file_id', '^[A-Za-z0-9_.:-]{1,256}$'),
        { $or: [isType('user', 'objectId'), validString('user', '^[a-f0-9]{24}$')] },
        {
          $or: [
            isType('tenantId', 'null'),
            {
              $and: [
                validString('tenantId', '^[A-Za-z0-9_.-]{1,128}$'),
                { $ne: ['$tenantId', '__SYSTEM__'] },
              ],
            },
          ],
        },
      ],
    };
    const conditions: Record<keyof FileInventoryCounts, unknown> = {
      totalFiles: true,
      managedMarker: managed,
      standaloneMarker: standalone,
      inheritedDeadline: inherited,
      otherFiles: { $not: [{ $or: [managed, standalone, inherited] }] },
      pastDueInheritedDeadline: { $and: [inherited, { $lte: ['$expiredAt', before.time] }] },
      malformedExpiredAt: { $and: [present('expiredAt'), { $not: [isType('expiredAt', 'date')] }] },
      deletionOrRetryMarkers: {
        $or: [
          'deletionRequestedAt',
          'deletionCompletedAt',
          'deletionRetryAt',
          'deletionAttempts',
        ].map(present),
      },
      missingOrMalformedIdentity: { $not: [identity] },
      expiresAtAbsentOrNull: absent('expiresAt'),
      expiresAtScalarDate: isType('expiresAt', 'date'),
      expiresAtArray: isType('expiresAt', 'array'),
      expiresAtOther: {
        $not: [
          { $or: [absent('expiresAt'), isType('expiresAt', 'date'), isType('expiresAt', 'array')] },
        ],
      },
    };
    const privateConditions = {
      ttlDue: { $and: [isType('expiresAt', 'date'), { $lte: ['$expiresAt', due] }] },
      ttlBecomingDue: {
        $and: [
          isType('expiresAt', 'date'),
          { $gt: ['$expiresAt', due] },
          { $lte: ['$expiresAt', dueByHorizon] },
        ],
      },
      ttlAfter: { $and: [isType('expiresAt', 'date'), { $gt: ['$expiresAt', dueByHorizon] }] },
    };
    const keys = Object.keys(conditions) as (keyof FileInventoryCounts)[];
    const group = Object.fromEntries(
      Object.entries({ ...conditions, ...privateConditions }).map(([key, condition]) => [
        key,
        { $sum: { $cond: [condition, 1, 0] } },
      ]),
    );
    session = mongoose.connection
      .getClient()
      .startSession({ snapshot: true, causalConsistency: false });
    const cursor = db
      .collection('files')
      .aggregate([{ $group: { _id: null, ...group } }, { $project: { _id: 0 } }], {
        ...options(),
        session,
        allowDiskUse: false,
      });
    let rows: mongo.Document[];
    try {
      rows = await cursor.toArray();
    } finally {
      try {
        await cursor.close();
      } catch {
        fail(selector ? 'unknown_commit' : 'unavailable');
      }
    }
    if (rows.length > 1) fail('unavailable');
    const row = rows[0] ?? Object.fromEntries(Object.keys(group).map((key) => [key, 0]));
    if (!Object.keys(group).every((key) => integer(row[key]))) fail('capacity');
    const counts = Object.fromEntries(keys.map((key) => [key, row[key]])) as FileInventoryCounts;
    const snapshot = (session as ClientSession & { snapshotTime?: mongo.Timestamp }).snapshotTime;
    if (!snapshot) fail('unavailable');
    const last = await catalog();
    const after = await server();
    const catalogStable =
      first.collectionSha256 === last.collectionSha256 && first.indexSha256 === last.indexSha256;
    const primaryStable = before.identity === after.identity && after.time >= before.time;
    const supported =
      catalogStable &&
      primaryStable &&
      ttl.length === 1 &&
      ttl[0].kind === 'expiresAt' &&
      counts.expiresAtArray === 0 &&
      counts.expiresAtOther === 0;
    const absentTTL = catalogStable && primaryStable && ttl.length === 0;
    options();
    let semantics: 'absent' | 'supported-scalar' | 'unknown' = 'unknown';
    if (absentTTL) semantics = 'absent';
    else if (supported) semantics = 'supported-scalar';
    const unclassifiedCount = absentTTL ? 0 : null;
    result = {
      outcome: 'inventoried',
      version: 1,
      diagnosticOnly: true,
      contract: FILE_HOUSEKEEPING_INVENTORY_CONTRACT,
      requestSha256: digest(request),
      collectionPresent: first.present,
      collectionSha256: first.collectionSha256,
      indexSha256: first.indexSha256,
      catalogStable,
      primaryStable,
      intervalAssurance: 'unknown',
      serverTime: {
        from: before.time.toISOString(),
        through: after.time.toISOString(),
        horizon: horizon.toISOString(),
      },
      snapshot: {
        seconds: snapshot.getHighBitsUnsigned(),
        increment: snapshot.getLowBitsUnsigned(),
      },
      counts,
      ttl: {
        semantics,
        indexes: ttl,
        eligibleAtObservation: supported ? row.ttlDue : unclassifiedCount,
        becomingEligibleByHorizon: supported ? row.ttlBecomingDue : unclassifiedCount,
        afterHorizon: supported ? row.ttlAfter : unclassifiedCount,
      },
    };
  } catch (error) {
    if (selector && (!(error instanceof CoverageError) || error.code === 'unknown_commit'))
      fail('unknown_commit');
    const code =
      error instanceof CoverageError &&
      ['invalid_input', 'deadline', 'capacity'].includes(error.code)
        ? (error.code as 'invalid_input' | 'deadline' | 'capacity')
        : 'unavailable';
    result = { outcome: 'refused', code };
  } finally {
    // Never race or detach original session settlement, even after input/output loss.
    try {
      await session?.endSession();
    } catch {
      if (selector) fail('unknown_commit');
      result = { outcome: 'refused', code: 'unavailable' };
    }
  }
  if (signal.aborted || performance.now() >= end) return { outcome: 'refused', code: 'deadline' };
  return result;
}
