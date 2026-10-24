/** Finite all-File census at the existing migration owner; native authority is an executable port. */
import { performance } from 'node:perf_hooks';
import { FILE_HOUSEKEEPING_COVERAGE_CONTRACT, canonicalManagedJson } from 'librechat-data-provider';
import type {
  FileCoverageAction,
  FileCoverageCatalog,
  FileCoverageRun,
  FileCoverageNativeBinding,
  FileCoverageSource,
  FileCoverageReceipt,
  FileCoverageResult,
  FileCoverageInvalidateReason,
} from 'librechat-data-provider';
import type { ClientSession, mongo } from 'mongoose';
import type { UploadStore, GlobalState, CounterRow } from './uploadManagementStore';
import {
  isFileCoverageInteger as integer,
  isFileCoverageIdentifier as id,
  fileCoverageDigest as digest,
  sameFileCoverageData as same,
  isFileCoverageSource as source,
  isFileCoverageNativeBinding as native,
  isFileCoverageAction as action,
  readFileCoverageReceipt,
} from './fileHousekeepingCoverageContract';
import { BUDGET, RESERVE, CoverageError, fail, censusValue } from './fileHousekeepingCoverageData';
import { observeFileHousekeepingInventory } from './fileHousekeepingInventory';
export { inspectFileHousekeepingInventory } from './fileHousekeepingInventory';
import { createFileCoverageProjectionChecks } from './fileHousekeepingProjectionCoverage';
import { createFileHistorySource } from './fileHousekeepingHistorySource';
import {
  createFileHistoryState,
  advanceFileHistory,
  assertHistorySource,
  FileHistoryError,
} from './fileHousekeepingHistory';
import type {
  FileHistoryMigrationState,
  FileHistoryNativePort,
  MongoHistoryScope,
} from './fileHousekeepingHistory';
import { readHistoryStorageBinding } from './fileHousekeepingHistoryContract';
import {
  conservedMongoAccounting,
  sealablePhysicalAccounting,
} from './fileHousekeepingHistoryAccounting';

/** Authenticated by the actual guarded native owner, never issued from serialized claims here. */
export interface FileCoverageNativeHold {
  readonly binding: FileCoverageNativeBinding;
  readonly source: FileCoverageSource;
  readonly history?: FileHistoryNativePort;
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
export type FileCoverageMigrationState = FileHistoryMigrationState;
export interface FileHousekeepingCoverageMethods {
  execute(action: FileCoverageAction, signal: AbortSignal): Promise<FileCoverageResult>;
}

export function createFileHousekeepingCoverageMethods(
  store: UploadStore,
  nativeProducer?: FileCoverageNativeProducer,
): FileHousekeepingCoverageMethods {
  const { mongoose, Counter } = store;
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
  const historySource = createFileHistorySource(store, options);
  const { jobKnown, fileKnown } = createFileCoverageProjectionChecks(store, options);
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
    if (state.blocked)
      return {
        outcome: 'incomplete',
        generation: state.run.generation,
        runSha256: state.runSha256,
        checkpoint: state.checkpoint,
        history: state.history,
      };
    return {
      outcome: 'progress',
      generation: state.run.generation,
      runSha256: state.runSha256,
      checkpoint: state.checkpoint,
      lane: state.phase,
      population: state.population,
      history: state.history,
    };
  }
  async function transaction<T>(
    end: number,
    signal: AbortSignal,
    hold: FileCoverageNativeHold,
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
            await hold.assertCurrent(signal);
            if (!integer(row.value.revision + 1)) fail('capacity');
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
      await hold.assertCurrent(signal);
      return result as T;
    } catch (error) {
      if (error instanceof CoverageError || error instanceof FileHistoryError) throw error;
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
      if (
        state.blocked ||
        state.history.lane !== 'ready' ||
        !sealablePhysicalAccounting(state.history) ||
        state.population.unclassifiedFiles ||
        state.population.unclassifiedJobs
      )
        fail('unclassified');
      // mongodb6.20 pins this actual server timestamp (sessions.ts1158-1163); its public
      // declaration omits the internal field. Never substitute operationTime or Date.now().
      const time = (session as ClientSession & { snapshotTime?: mongo.Timestamp }).snapshotTime;
      if (!time) fail('unavailable');
      return {
        population: state.population as FileCoverageReceipt['population'],
        filesSha256: state.filesSha256,
        jobsSha256: state.jobsSha256,
        projectionSha256: digest([state.filesSha256, state.jobsSha256, state.history.foldSha256]),
        history: state.history,
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
      return transaction(end, signal, hold, async (row) => {
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
    if (!hold.history) fail('native_unavailable');
    const historyPort = hold.history;
    const catalogSession = mongoose.connection.getClient().startSession();
    let scopes: MongoHistoryScope[];
    try {
      scopes = await historySource.scopes(request.storeId, catalogSession, end, signal);
    } finally {
      await catalogSession.endSession();
    }
    await hold.assertCurrent(signal);
    const advance = (
      row: GlobalCounter,
      session: ClientSession,
      state: FileCoverageMigrationState,
      inputSha256: string,
    ) =>
      advanceFileHistory(state, row.value as unknown as Record<string, unknown>, inputSha256, {
        native: historyPort,
        signal,
        assertCurrent: (signal) => hold.assertCurrent(signal),
        observe: (scope, cursor, repair) =>
          historySource.observe(
            scope,
            cursor,
            repair,
            session,
            end,
            signal,
            (file) => fileKnown(file, session, end, signal),
            (job) => jobKnown(job, session, end, signal),
            new Date(state.repairObservedAt),
          ),
      });
    if (input.action === 'begin')
      return transaction(end, signal, hold, async (row, session) => {
        if (row.value.storeId !== request.storeId) fail('store_changed');
        const old = row.value.fileHousekeepingCoverage;
        if (
          old?.generation === request.generation &&
          old.phase === 'preparing' &&
          old.runSha256 === runSha256
        ) {
          const state = current(row.value, request);
          assertHistorySource(state, scopes);
          const binding = readHistoryStorageBinding(await historyPort.bind(runSha256, signal));
          if (!binding) fail('native_changed');
          if (!same(binding, state.binding)) await advance(row, session, state, digest(input));
          return progress(state);
        }
        if ((old?.generation ?? 0) + 1 !== request.generation) fail('generation_conflict');
        if (row.value.migration || row.value.migrationEpoch) fail('migration_conflict');
        const binding = readHistoryStorageBinding(await historyPort.bind(runSha256, signal));
        if (!binding || binding.round !== 0) fail('native_changed');
        const state = createFileHistoryState(request, scopes, binding);
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
      return transaction(end, signal, hold, async (row, session) => {
        const state = current(row.value, request);
        assertHistorySource(state, scopes);
        const inputSha256 = digest(input);
        if (state.checkpoint !== input.expectedCheckpoint) {
          const last = state.history.lastPage;
          if (
            last &&
            last.inputSha256 === inputSha256 &&
            last.checkpointBefore === input.expectedCheckpoint &&
            last.checkpointAfter === state.checkpoint
          )
            return progress(state);
          fail('checkpoint_conflict');
        }
        await advance(row, session, state, inputSha256);
        return progress(state);
      });
    const finalBinding = readHistoryStorageBinding(await historyPort.bind(runSha256, signal));
    if (!finalBinding) fail('native_changed');
    const candidate = await verify(request, input.expectedCheckpoint, end, signal);
    await hold.assertCurrent(signal);
    return transaction(end, signal, hold, async (row, session) => {
      const state = current(row.value, request);
      if (state.checkpoint !== input.expectedCheckpoint || state.phase !== 'ready')
        fail('checkpoint_conflict');
      assertHistorySource(state, scopes);
      if (!same(finalBinding, state.binding)) fail('native_changed');
      if (
        !conservedMongoAccounting(
          row.value as unknown as Record<string, unknown>,
          state.mongo.accounting,
          state.mongo.queueCount,
        )
      )
        fail('source_changed');
      if (
        state.blocked ||
        !same(state.history, candidate.history) ||
        !sealablePhysicalAccounting(state.history)
      )
        fail('source_changed');
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
          const currentHold: FileCoverageNativeHold = {
            binding: hold.binding,
            source: hold.source,
            history: hold.history,
            async assertCurrent(currentSignal) {
              try {
                await hold.assertCurrent(currentSignal);
              } catch {
                fail('native_changed');
              }
            },
          };
          owned.operation = perform(input, abort.signal, currentHold).finally(() => {
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
        const code =
          error instanceof CoverageError || error instanceof FileHistoryError
            ? error.code
            : 'unavailable';
        return { outcome: code === 'unknown_commit' ? 'unknown' : 'refused', code };
      }
    },
  };
}
