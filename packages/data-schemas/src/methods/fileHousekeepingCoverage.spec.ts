/** Real Mongo data-owner evidence. The native producer below is explicitly a fixture, not native proof. */
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { FILE_HOUSEKEEPING_COVERAGE_CONTRACT } from 'librechat-data-provider';
import type {
  FileCoverageRun,
  FileCoverageAction,
  FileCoverageResult,
} from 'librechat-data-provider';
import type { FileInventoryRequest } from 'librechat-data-provider';
import type {
  FileCoverageNativeProducer,
  FileCoverageNativeHold,
} from './fileHousekeepingCoverage';
import type { HousekeepingJobRecord } from '~/models/housekeepingJob';
import type { CounterRow } from './uploadManagementStore';
import type { IMongoFile } from '~/types/file';
import {
  createFileHousekeepingCoverageMethods,
  inspectFileHousekeepingInventory,
} from './fileHousekeepingCoverage';
import { createFileHousekeepingDiscoveryMethods } from './fileHousekeepingDiscovery';
import { initialFileRetentionActivity } from './fileActivityTransition';
import { projectFileHousekeeping } from './fileHousekeepingProjection';
import { importFileRetryFloor } from './housekeepingProjection';
import { createHousekeepingStore } from './housekeepingStore';
import { createUploadStore } from './uploadManagementStore';
import { createFileMethods } from './file';
import fileSchema from '../schema/file';

const barrier = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
describe('File coverage existing-owner census', () => {
  let mongo: MongoMemoryReplSet;
  const File = mongoose.model('File', fileSchema);
  const user = new mongoose.Types.ObjectId();
  let upload: ReturnType<typeof createUploadStore>;
  let jobs: ReturnType<typeof createHousekeepingStore>;
  let coverage: ReturnType<typeof createFileHousekeepingCoverageMethods>;
  let request: FileCoverageRun;
  let guard: (hold: FileCoverageNativeHold) => Promise<void>;
  let held = false;
  const signal = new AbortController().signal;
  const worker = {
    podUid: 'pod-a',
    incarnation: 'incarnation-a',
    source: 'source-a',
    hostId: 'cpu-2',
  };
  const nativeFixture: FileCoverageNativeProducer = {
    async withCurrentQuiescence(_action, _signal, callback) {
      held = true;
      const hold = {
        binding: request.native,
        source: request.source,
        assertCurrent: async () => guard(hold),
      };
      try {
        return await callback(hold);
      } finally {
        held = false;
      }
    },
  };
  function fixture(n: number, deadline = new Date(1000)) {
    return {
      _id: new mongoose.Types.ObjectId(n.toString(16).padStart(24, '0')),
      user,
      tenantId: 'tenant-a',
      file_id: `file-${n}`,
      filename: 'file',
      filepath: '/private/file',
      type: 'text/plain',
      bytes: 1,
      expiredAt: deadline,
      retentionRevision: 0,
      retentionActivity: initialFileRetentionActivity(deadline, new Date(0), 'complete'),
    };
  }
  async function transaction<T>(work: (session: mongoose.ClientSession) => Promise<T>) {
    const session = await mongoose.startSession();
    try {
      return await session.withTransaction(() => work(session));
    } finally {
      await session.endSession();
    }
  }
  async function ready(): Promise<Extract<FileCoverageResult, { outcome: 'progress' }>> {
    let result = await coverage.execute({ action: 'begin', run: request }, signal);
    for (let n = 0; n < 20 && result.outcome === 'progress' && result.lane !== 'ready'; n++)
      result = await coverage.execute(
        { action: 'advance', run: request, expectedCheckpoint: result.checkpoint },
        signal,
      );
    expect(result).toMatchObject({ outcome: 'progress', lane: 'ready' });
    return result as Extract<FileCoverageResult, { outcome: 'progress' }>;
  }
  async function seal() {
    const progress = await ready();
    return coverage.execute(
      { action: 'verify-seal', run: request, expectedCheckpoint: progress.checkpoint },
      signal,
    );
  }
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      replSet: { count: 1, args: ['--setParameter', 'enableTestCommands=1'] },
    });
    await mongoose.connect(mongo.getUri(), {
      retryWrites: false,
      monitorCommands: true,
      appName: 'housekeeping-file-coverage-test',
    });
    upload = createUploadStore(mongoose, {});
    jobs = createHousekeepingStore(mongoose);
    await Promise.all([File.init(), upload.initialize(), jobs.initialize()]);
  });
  beforeEach(async () => {
    await Promise.all([
      File.deleteMany({}),
      jobs.model.deleteMany({}),
      upload.Counter.deleteMany({}),
      upload.Operation.deleteMany({}),
    ]);
    await upload.initialize();
    guard = async () => undefined;
    const row = await upload.Counter.findById('global').lean();
    request = {
      version: 1,
      requestId: randomUUID(),
      storeId: (row!.value as { storeId: string }).storeId,
      generation: 1,
      originalDeadline: new Date(Date.now() + 60000).toISOString(),
      contract: FILE_HOUSEKEEPING_COVERAGE_CONTRACT,
      source: {
        sourceRevision: 'a'.repeat(40),
        imageDigest: `sha256:${'b'.repeat(64)}`,
        manifestSha256: 'c'.repeat(64),
      },
      native: {
        invocationId: 'fixture-invocation',
        invocationGeneration: 1,
        originalRequestSha256: 'd'.repeat(64),
        namespaceUid: randomUUID(),
        mongoReplicaSet: 'testset',
        mongoDatabase: 'test',
        writerCohortSha256: 'e'.repeat(64),
        oldTimerDrainSha256: 'f'.repeat(64),
      },
    };
    coverage = createFileHousekeepingCoverageMethods(upload, nativeFixture);
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });

  it('refuses production mutation without an actual native producer and rejects a caller grant', async () => {
    const unavailable = createFileHousekeepingCoverageMethods(upload);
    const before = await upload.Counter.findById('global').lean();
    for (const action of ['begin', 'advance', 'verify-seal'] as const) {
      const value =
        action === 'begin'
          ? { action, run: request }
          : { action, run: request, expectedCheckpoint: 0 };
      expect(await unavailable.execute(value, signal)).toEqual({
        outcome: 'refused',
        code: 'native_unavailable',
      });
    }
    expect(
      await coverage.execute(
        { action: 'begin', run: request, complete: true } as unknown as FileCoverageAction,
        signal,
      ),
    ).toEqual({ outcome: 'refused', code: 'invalid_input' });
    expect(await upload.Counter.findById('global').lean()).toEqual(before);
  });

  it('rejects an adapter result without execution of the original held callback', async () => {
    const invalid: FileCoverageNativeProducer = {
      async withCurrentQuiescence<T>(): Promise<T> {
        return { outcome: 'sealed', receipt: 'caller fiction' } as T;
      },
    };
    const before = await upload.Counter.findById('global').lean();
    expect(
      await createFileHousekeepingCoverageMethods(upload, invalid).execute(
        { action: 'begin', run: request },
        signal,
      ),
    ).toEqual({ outcome: 'refused', code: 'native_changed' });
    expect(await upload.Counter.findById('global').lean()).toEqual(before);
  });

  it('joins original session closure after a broken native adapter returns before its callback', async () => {
    const closing = barrier(),
      releaseClose = barrier(),
      released = barrier();
    const client = mongoose.connection.getClient(),
      start = client.startSession.bind(client);
    let originalSession: mongoose.ClientSession | undefined;
    jest.spyOn(client, 'startSession').mockImplementationOnce((...args) => {
      const session = start(...args);
      originalSession = session;
      const close = session.endSession.bind(session);
      session.endSession = async (...options) => {
        closing.release();
        await releaseClose.promise;
        await close(...options);
      };
      return session;
    });
    const detached: FileCoverageNativeProducer = {
      async withCurrentQuiescence<T>(
        _action: FileCoverageAction,
        _signal: AbortSignal,
        callback: (hold: FileCoverageNativeHold) => Promise<T>,
      ): Promise<T> {
        void callback({
          binding: request.native,
          source: request.source,
          assertCurrent: async () => undefined,
        }).catch(() => undefined);
        await closing.promise;
        released.release();
        return { outcome: 'progress' } as T;
      },
    };
    let ended = false;
    const executing = createFileHousekeepingCoverageMethods(upload, detached)
      .execute({ action: 'begin', run: request }, signal)
      .finally(() => {
        ended = true;
      });
    await released.promise;
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(ended).toBe(false);
    } finally {
      releaseClose.release();
    }
    expect(await executing).toEqual({ outcome: 'unknown', code: 'unknown_commit' });
    expect(originalSession?.hasEnded).toBe(true);
    expect((await upload.Counter.findById('global').lean())!.value).toMatchObject({
      fileHousekeepingCoverage: { phase: 'preparing', generation: 1 },
    });
  });

  it('keeps the census checkpoint and job projection unchanged after a concurrent File revocation wins', async () => {
    const file = fixture(1);
    await File.create(file);
    await coverage.execute({ action: 'begin', run: request }, signal);
    const entered = barrier(),
      proceed = barrier();
    const update = File.collection.updateOne.bind(File.collection);
    jest.spyOn(File.collection, 'updateOne').mockImplementationOnce(async (...args) => {
      entered.release();
      await proceed.promise;
      return update(...args);
    });
    const advancing = coverage.execute(
      { action: 'advance', run: request, expectedCheckpoint: 0 },
      signal,
    );
    await entered.promise;
    const revocationId = randomUUID();
    try {
      await update(
        { _id: file._id },
        {
          $inc: { retentionRevision: 1 },
          $set: { deletionRequestedAt: new Date(), retentionRevocationId: revocationId },
        },
      );
    } finally {
      proceed.release();
    }
    expect((await advancing).outcome).not.toBe('progress');
    expect(await jobs.model.countDocuments()).toBe(0);
    expect(
      (await File.findById(file._id).select('+retentionRevocationId').lean())
        ?.retentionRevocationId,
    ).toBe(revocationId);
    expect((await upload.Counter.findById('global').lean())!.value).toMatchObject({
      migration: { checkpoint: 0, cursor: null },
      fileHousekeepingCoverage: { phase: 'preparing' },
    });
  });

  it('creates retained File and jobs atomically and rolls back an actual Mongo projection failure', async () => {
    const methods = createFileMethods(mongoose);
    const acceptedAt = new Date(Date.now() - 1000),
      expiredAt = new Date(Date.now() + 86400000);
    const injected = {
      retentionCleanup: { forged: true },
      'retentionCleanup.forged': true,
    } as unknown as Partial<IMongoFile>;
    const make = (file_id: string) =>
      methods.createFile(
        {
          ...injected,
          user,
          tenantId: 'tenant-a',
          file_id,
          filename: 'file',
          filepath: '/private/file',
          type: 'text/plain',
          bytes: 1,
        },
        true,
        { retention: { acceptedAt, expiredAt } },
      );
    await make('atomic-file');
    expect(await File.collection.findOne({ file_id: 'atomic-file' })).not.toHaveProperty(
      'retentionCleanup',
    );
    await methods.updateFile({ ...injected, file_id: 'atomic-file' });
    expect(await File.collection.findOne({ file_id: 'atomic-file' })).not.toHaveProperty(
      'retentionCleanup',
    );
    expect(await jobs.model.countDocuments()).toBe(3);
    const before = await upload.Counter.findById('global').lean();
    await mongoose.connection.db!.command({
      collMod: jobs.model.collection.name,
      validator: { _id: { $exists: false } },
      validationLevel: 'strict',
    });
    try {
      await expect(make('failed-file')).rejects.toThrow();
    } finally {
      await mongoose.connection.db!.command({ collMod: jobs.model.collection.name, validator: {} });
    }
    expect(await File.countDocuments({ file_id: 'failed-file' })).toBe(0);
    expect(await jobs.model.countDocuments()).toBe(3);
    await expect(
      methods.updateFile({
        file_id: 'atomic-file',
        expiredAt: new Date(expiredAt.getTime() - 1000),
      }),
    ).rejects.toThrow();
    expect(await upload.Counter.findById('global').lean()).toEqual(before);
  });

  it('censuses standalone Files in32-row indexed pages without an UploadOperation population', async () => {
    await File.insertMany(Array.from({ length: 33 }, (_, n) => fixture(n + 1)));
    expect(await upload.Operation.countDocuments()).toBe(0);
    const first = await coverage.execute({ action: 'begin', run: request }, signal);
    expect(first).toMatchObject({ outcome: 'progress', checkpoint: 0 });
    const page = await coverage.execute(
      { action: 'advance', run: request, expectedCheckpoint: 0 },
      signal,
    );
    expect(page).toMatchObject({
      outcome: 'progress',
      lane: 'files',
      population: { filesSeen: 32, retainedFiles: 32 },
    });
    expect(await jobs.model.countDocuments()).toBe(96);
    const result = await seal();
    expect(result).toMatchObject({
      outcome: 'sealed',
      receipt: {
        population: { filesSeen: 33, fileJobsSeen: 99, unclassifiedFiles: 0, unclassifiedJobs: 0 },
      },
    });
    expect(held).toBe(false);
  });

  it('does not certify generic legacy policies, unknown retries, frozen Files or orphan obligations', async () => {
    const legacy = fixture(1),
      unknown = fixture(2),
      frozen = fixture(3),
      completed = fixture(4);
    await File.collection.insertMany([
      { ...legacy, retentionActivity: undefined },
      { ...unknown, deletionAttempts: 2 },
      {
        ...frozen,
        retentionActivity: { ...frozen.retentionActivity, migrationEpoch: 'held-old-migration' },
      },
      { ...completed, deletionCompletedAt: new Date(), retentionRevocationId: randomUUID() },
    ]);
    await transaction((session) =>
      jobs.project(
        {
          handler: 'file.cleanup',
          subject: { tenantId: 'tenant-a', ownerUserId: String(user), fileId: 'absent' },
          deadlineGeneration: 0,
          revocationId: null,
        },
        new Date(0),
        session,
      ),
    );
    const before = await File.collection.find({}).toArray();
    const progress = await ready();
    expect(progress.population).toMatchObject({
      filesSeen: 4,
      unclassifiedFiles: 4,
      fileJobsSeen: 1,
      unclassifiedJobs: 1,
    });
    expect(
      await coverage.execute(
        { action: 'verify-seal', run: request, expectedCheckpoint: progress.checkpoint },
        signal,
      ),
    ).toEqual({ outcome: 'refused', code: 'unclassified' });
    expect(await File.collection.find({}).toArray()).toEqual(before);
  });

  // A managed identity cannot be excluded merely because its retained history is incomplete.
  it('refuses coverage for a managed orphan without retained metadata', async () => {
    const orphan = {
      _id: new mongoose.Types.ObjectId(),
      user,
      tenantId: 'tenant-a',
      file_id: 'orphan-upload',
      uploadOperationId: 'orphan-upload',
      retentionRevision: 0,
    };
    await File.collection.insertOne(orphan);
    const before = await File.collection.findOne({ _id: orphan._id });
    expect(await upload.Operation.countDocuments()).toBe(0);
    const progress = await ready();
    expect(
      await coverage.execute(
        { action: 'verify-seal', run: request, expectedCheckpoint: progress.checkpoint },
        signal,
      ),
    ).toEqual({ outcome: 'refused', code: 'unclassified' });
    expect(progress.population).toMatchObject({
      filesSeen: 1,
      retainedFiles: 0,
      excludedFiles: 0,
      unclassifiedFiles: 1,
    });
    expect(await File.collection.findOne({ _id: orphan._id })).toEqual(before);
    expect(await jobs.model.countDocuments()).toBe(0);
  });

  it('imports only actual standalone history/retry evidence and preserves a later repository floor', async () => {
    const floor = new Date(Date.now() + 30 * 86400000);
    const file = {
      ...fixture(1),
      retentionActivity: undefined,
      retentionAcceptedAt: new Date(0),
      deletionAttempts: 10,
      deletionRetryAt: floor,
    };
    await File.collection.insertOne(file);
    await ready();
    const row = await jobs.model.findOne({ handler: 'file.cleanup' }).lean();
    expect(row).toMatchObject({ retryNotBefore: floor, nextAttemptAt: floor, attempts: 0 });
    const actual = await File.collection.findOne({ _id: file._id });
    expect(actual?.retentionActivity).toMatchObject({
      historyConfidence: 'since-tracking',
      readCount: 0,
      processingCount: 0,
      baselineDeadlineAt: file.expiredAt,
    });
    const later = new Date(floor.getTime() + 10000);
    await (
      jobs.model.collection as unknown as mongoose.mongo.Collection<HousekeepingJobRecord>
    ).updateOne({ _id: row!._id }, { $set: { retryNotBefore: later, nextAttemptAt: later } });
    const work = row!.work;
    if (work.handler !== 'file.cleanup') throw new Error('fixture');
    expect(
      await transaction((session) => importFileRetryFloor(jobs.model, work, floor, session)),
    ).toBe(true);
    expect((await jobs.model.findById(row!._id).lean())!.retryNotBefore).toEqual(later);
  });

  // A complete census must reject runnable legacy schedules earlier than their retained authority.
  it.each([
    ['queued', 'due'],
    ['waiting', 'due'],
    ['queued', 'retry'],
    ['waiting', 'retry'],
  ] as const)(
    'refuses %s scheduling before its %s floor without rewriting jobs',
    async (state, bound) => {
      const floor = new Date(Date.now() + 3600000);
      await File.create({
        ...fixture(1, bound === 'due' ? floor : new Date(1000)),
        ...(bound === 'retry' ? { deletionRetryAt: floor } : {}),
      });
      const progress = await ready();
      const row = (await jobs.model.findOne({ handler: 'file.cleanup' }).lean())!;
      const collection = jobs.model
        .collection as unknown as mongoose.mongo.Collection<HousekeepingJobRecord>;
      await collection.updateOne({ _id: row._id }, { $set: { state, nextAttemptAt: new Date(0) } });
      const before = await jobs.model.find({}).sort({ _id: 1 }).lean();
      const action = {
        action: 'verify-seal' as const,
        run: request,
        expectedCheckpoint: progress.checkpoint,
      };
      expect(await coverage.execute(action, signal)).toEqual({
        outcome: 'refused',
        code: 'unclassified',
      });
      expect(await jobs.model.find({}).sort({ _id: 1 }).lean()).toEqual(before);
      await collection.updateOne({ _id: row._id }, { $set: { nextAttemptAt: floor } });
      expect(await coverage.execute(action, signal)).toMatchObject({ outcome: 'sealed' });
    },
  );

  it('fences an unstarted claim but never reconstructs an attempted missing retry floor', async () => {
    await File.create(fixture(1));
    await transaction((session) =>
      projectFileHousekeeping(mongoose, null, fixture(1) as unknown as IMongoFile, session),
    );
    const claimed = (await jobs.claimNext('file.cleanup', worker))!;
    const row = (await jobs.model.findById(claimed.jobId).lean())!;
    if (row.work.handler !== 'file.cleanup') throw new Error('fixture');
    const floor = new Date(Date.now() + 100000);
    expect(
      await transaction((session) =>
        importFileRetryFloor(
          jobs.model,
          row.work as Extract<typeof row.work, { handler: 'file.cleanup' }>,
          floor,
          session,
        ),
      ),
    ).toBe(true);
    expect(await jobs.renew(claimed)).toBeNull();
    expect((await jobs.model.findById(row._id).lean())!.execution).toEqual(row.execution);
    await (
      jobs.model.collection as unknown as mongoose.mongo.Collection<HousekeepingJobRecord>
    ).updateOne({ _id: row._id }, { $unset: { retryNotBefore: 1 } });
    const before = await jobs.model.findById(row._id).lean();
    expect(
      await transaction((session) =>
        importFileRetryFloor(
          jobs.model,
          row.work as Extract<typeof row.work, { handler: 'file.cleanup' }>,
          floor,
          session,
        ),
      ),
    ).toBe(false);
    expect(await jobs.model.findById(row._id).lean()).toEqual(before);
  });

  it('rejects retry import after concurrent claim/arming without replacing the original execution receipt', async () => {
    await File.create(fixture(1));
    await transaction((session) =>
      projectFileHousekeeping(mongoose, null, fixture(1) as unknown as IMongoFile, session),
    );
    const row = (await jobs.model.findOne({ handler: 'file.cleanup' }).lean())!;
    if (row.work.handler !== 'file.cleanup') throw new Error('fixture');
    const entered = barrier(),
      proceed = barrier();
    const original = jobs.model.collection.findOne.bind(jobs.model.collection);
    jest.spyOn(jobs.model.collection, 'findOne').mockImplementationOnce(async (...args) => {
      const found = await original(...args);
      entered.release();
      await proceed.promise;
      return found;
    });
    const importing = transaction((session) =>
      importFileRetryFloor(
        jobs.model,
        row.work as Extract<typeof row.work, { handler: 'file.cleanup' }>,
        new Date(Date.now() + 100000),
        session,
      ),
    );
    await entered.promise;
    let before;
    try {
      const claim = (await jobs.claimNext('file.cleanup', worker))!;
      await transaction((session) =>
        jobs.advance(
          claim,
          { revision: claim.progressRevision, phase: 'awaiting_deadline' },
          { phase: 'revoked', code: 'progress', receiptRef: 'original-effect-receipt' },
          session,
        ),
      );
      before = await jobs.model.findById(row._id).lean();
    } finally {
      proceed.release();
    }
    // Mongo may retry the transaction callback; either the CAS conflict or the observed started
    // phase refuses the import. The original effect and receipt remain exact.
    await expect(importing).resolves.toBe(false);
    expect(await jobs.model.findById(row._id).lean()).toEqual(before);
  });

  it('keeps older counts partial after a later seal and invalidates later snapshots monotonically', async () => {
    await File.create(fixture(1));
    const progress = await ready();
    const discovery = createFileHousekeepingDiscoveryMethods(mongoose);
    const old = await mongoose.startSession({ snapshot: true, causalConsistency: false });
    const sealed = await mongoose.startSession({ snapshot: true, causalConsistency: false });
    try {
      expect(await jobs.model.collection.countDocuments({}, { session: old })).toBe(3);
      const result = await coverage.execute(
        { action: 'verify-seal', run: request, expectedCheckpoint: progress.checkpoint },
        signal,
      );
      expect(result.outcome).toBe('sealed');
      expect(await discovery.coverage('file.cleanup', signal, old)).toMatchObject({
        expected: null,
        observed: 1,
      });
      expect(await discovery.coverage('file.cleanup', signal, sealed)).toMatchObject({
        expected: 1,
        observed: 1,
      });
      expect(
        await coverage.execute(
          {
            action: 'invalidate',
            version: 1,
            requestId: randomUUID(),
            storeId: request.storeId,
            expectedGeneration: 1,
            originalDeadline: request.originalDeadline,
            reason: 'writer_admission',
          },
          signal,
        ),
      ).toMatchObject({ outcome: 'invalidated', generation: 2 });
      expect(await discovery.coverage('file.cleanup', signal, sealed)).toMatchObject({
        expected: 1,
        observed: 1,
      });
      const fresh = await mongoose.startSession({ snapshot: true, causalConsistency: false });
      try {
        expect(await discovery.coverage('file.cleanup', signal, fresh)).toMatchObject({
          expected: null,
          observed: 1,
        });
      } finally {
        await fresh.endSession();
      }
      expect(
        await coverage.execute(
          { action: 'verify-seal', run: request, expectedCheckpoint: progress.checkpoint },
          signal,
        ),
      ).toMatchObject({ outcome: 'refused', code: 'generation_conflict' });
    } finally {
      await old.endSession();
      await sealed.endSession();
    }
  });

  it('rejects seal after an actual concurrent invalidation between verification and commit', async () => {
    await File.create(fixture(1));
    const progress = await ready();
    let guards = 0;
    guard = async () => {
      if (++guards === 2)
        await (
          upload.Counter.collection as unknown as mongoose.mongo.Collection<CounterRow>
        ).updateOne(
          { _id: 'global' },
          {
            $inc: { revision: 1 },
            $set: {
              'value.fileHousekeepingCoverage': {
                version: 1,
                phase: 'invalid',
                generation: 2,
                requestSha256: 'a'.repeat(64),
                reason: 'source_changed',
              },
            },
          },
        );
    };
    expect(
      await coverage.execute(
        { action: 'verify-seal', run: request, expectedCheckpoint: progress.checkpoint },
        signal,
      ),
    ).toEqual({ outcome: 'refused', code: 'generation_conflict' });
    expect((await upload.Counter.findById('global').lean())!.value).toMatchObject({
      fileHousekeepingCoverage: { phase: 'invalid', generation: 2 },
    });
  });

  it('reconciles an actually committed seal after loss of its original acknowledgement', async () => {
    await File.create(fixture(1));
    const progress = await ready();
    const client = mongoose.connection.getClient(),
      original = client.startSession.bind(client);
    const sessions: mongoose.ClientSession[] = [];
    let lost = false;
    const spy = jest.spyOn(client, 'startSession').mockImplementation((...args) => {
      const session = original(...args);
      sessions.push(session);
      const commit = session.commitTransaction.bind(session);
      session.commitTransaction = async (...options) => {
        await commit(...options);
        if (!lost) {
          lost = true;
          throw new mongoose.mongo.MongoNetworkError('fixture lost committed acknowledgement');
        }
      };
      return session;
    });
    const result = await coverage.execute(
      { action: 'verify-seal', run: request, expectedCheckpoint: progress.checkpoint },
      signal,
    );
    spy.mockRestore();
    expect(result).toEqual({ outcome: 'unknown', code: 'unknown_commit' });
    expect(sessions.every((session) => session.hasEnded)).toBe(true);
    expect(held).toBe(false);
    expect(
      await coverage.execute(
        {
          action: 'inspect',
          version: 1,
          storeId: request.storeId,
          generation: 1,
          runSha256: progress.runSha256,
        },
        signal,
      ),
    ).toMatchObject({
      outcome: 'observed',
      phase: 'sealed',
      receipt: { generation: 1, runSha256: progress.runSha256 },
    });
  });

  it('settles an actual blocked database read within its original finite budget and never reports complete', async () => {
    await mongoose.connection.db!.admin().command({
      configureFailPoint: 'failCommand',
      mode: 'alwaysOn',
      data: {
        failCommands: ['find'],
        appName: 'housekeeping-file-coverage-test',
        blockConnection: true,
        blockTimeMS: 5000,
      },
    });
    const started = performance.now();
    let result;
    let elapsed = 0;
    try {
      result = await coverage.execute({ action: 'begin', run: request }, signal);
      elapsed = performance.now() - started;
    } finally {
      await mongoose.connection
        .db!.admin()
        .command({ configureFailPoint: 'failCommand', mode: 'off' });
    }
    expect(['refused', 'unknown']).toContain(result!.outcome);
    expect(elapsed).toBeLessThan(3800);
    expect(held).toBe(false);
    expect((await upload.Counter.findById('global').lean())!.value).not.toHaveProperty(
      'fileHousekeepingCoverage',
    );
  });
  function inventoryRequest(database = 'test'): FileInventoryRequest {
    return {
      action: 'inventory',
      version: 1,
      requestId: randomUUID(),
      source: request.source,
      target: {
        namespaceUid: request.native.namespaceUid,
        mongoReplicaSet: 'testset',
        mongoDatabase: database,
      },
      originalDeadline: new Date(Date.now() + 60_000).toISOString(),
      lookAheadMs: 30_000,
    };
  }

  test('inventory observes an empty uninitialized database without creating a store or indexes', async () => {
    const observer = new mongoose.Mongoose();
    await observer.connect(mongo.getUri('inventory-empty'), {
      autoCreate: false,
      autoIndex: false,
      monitorCommands: true,
    });
    const commands: string[] = [];
    observer.connection
      .getClient()
      .on('commandStarted', (event) => commands.push(event.commandName));
    try {
      const result = await inspectFileHousekeepingInventory(
        observer,
        inventoryRequest('inventory-empty'),
        signal,
      );
      expect(result).toMatchObject({
        outcome: 'inventoried',
        diagnosticOnly: true,
        collectionPresent: false,
        counts: { totalFiles: 0, inheritedDeadline: 0, expiresAtScalarDate: 0 },
        intervalAssurance: 'unknown',
      });
      if (result.outcome !== 'inventoried') throw new Error('inventory unavailable');
      expect(result.snapshot.seconds).toBeGreaterThan(0);
      expect(Date.parse(result.serverTime.through)).toBeGreaterThanOrEqual(
        Date.parse(result.serverTime.from),
      );
      expect(await observer.connection.db!.listCollections().toArray()).toEqual([]);
      expect(
        commands.some((command) =>
          [
            'insert',
            'update',
            'delete',
            'create',
            'createIndexes',
            'collMod',
            'findAndModify',
          ].includes(command),
        ),
      ).toBe(false);
    } finally {
      await observer.disconnect();
    }
  });

  test('inventory counts raw cohorts and actual TTL horizon without exposing row data', async () => {
    const now = new Date();
    const secret = 'test-private-filename-owner-content';
    await File.collection.insertMany(
      [
        {
          filename: secret,
          user: user,
          tenantId: secret,
          text: secret,
          expiredAt: new Date(now.getTime() - 1000),
        },
        { uploadOperationId: secret, expiredAt: new Date(now.getTime() + 60_000) },
        { retentionAcceptedAt: now, expiredAt: new Date(now.getTime() + 60_000) },
        { expiresAt: new Date(now.getTime() - 3600_000 + 10_000) },
        { expiresAt: new Date(now.getTime() + 60_000) },
        { expiredAt: 'invalid', deletionRequestedAt: now },
      ].map((row) => ({ ...row, file_id: randomUUID() })) as never[],
    );
    const before = await upload.Counter.findById('global').lean();
    const result = await inspectFileHousekeepingInventory(mongoose, inventoryRequest(), signal);
    expect(result).toMatchObject({
      outcome: 'inventoried',
      diagnosticOnly: true,
      catalogStable: true,
      counts: {
        totalFiles: 6,
        managedMarker: 1,
        standaloneMarker: 1,
        inheritedDeadline: 1,
        otherFiles: 3,
        pastDueInheritedDeadline: 1,
        malformedExpiredAt: 1,
        deletionOrRetryMarkers: 1,
        expiresAtScalarDate: 2,
      },
      ttl: {
        semantics: 'supported-scalar',
        eligibleAtObservation: 0,
        becomingEligibleByHorizon: 1,
        afterHorizon: 1,
      },
      intervalAssurance: 'unknown',
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(user.toString());
    expect(await upload.Counter.findById('global').lean()).toEqual(before);
    expect(await File.collection.countDocuments()).toBe(6);
  });

  test('inventory reports unsupported TTL index and date arrays as unknown without printing index values', async () => {
    const index = 'private-index-value';
    await File.collection.createIndex(
      { otherExpiry: 1 },
      { name: index, expireAfterSeconds: 3600, partialFilterExpression: { context: index } },
    );
    try {
      await File.collection.insertOne({ expiresAt: [new Date()], context: index } as never);
      const result = await inspectFileHousekeepingInventory(mongoose, inventoryRequest(), signal);
      expect(result).toMatchObject({
        outcome: 'inventoried',
        ttl: { semantics: 'unknown', eligibleAtObservation: null, becomingEligibleByHorizon: null },
        counts: { expiresAtArray: 1 },
        intervalAssurance: 'unknown',
      });
      expect(JSON.stringify(result)).not.toContain(index);
    } finally {
      await File.collection.dropIndex(index);
    }
  });

  test('inventory downgrades actual index DDL between its bracketing observations', async () => {
    const db = mongoose.connection.db!;
    const original = db.listCollections.bind(db);
    let calls = 0;
    const spy = jest.spyOn(db, 'listCollections').mockImplementation((...args) => {
      const cursor = original(...args);
      if (++calls === 2) {
        const toArray = cursor.toArray.bind(cursor);
        cursor.toArray = async () => {
          await File.collection.createIndex({ context: 1 }, { name: 'inventory-ddl-fixture' });
          return await toArray();
        };
      }
      return cursor;
    });
    try {
      const result = await inspectFileHousekeepingInventory(mongoose, inventoryRequest(), signal);
      expect(result).toMatchObject({
        outcome: 'inventoried',
        catalogStable: false,
        ttl: { semantics: 'unknown', eligibleAtObservation: null },
        intervalAssurance: 'unknown',
      });
    } finally {
      spy.mockRestore();
      await File.collection.dropIndex('inventory-ddl-fixture');
    }
  });

  test('inventory joins its original snapshot session after cancellation during session close', async () => {
    const client = mongoose.connection.getClient();
    const original = client.startSession.bind(client);
    const entered = barrier(),
      release = barrier();
    const abort = new AbortController();
    let session: mongoose.ClientSession | undefined;
    const spy = jest.spyOn(client, 'startSession').mockImplementationOnce((...args) => {
      session = original(...args);
      const end = session.endSession.bind(session);
      session.endSession = async (...options) => {
        entered.release();
        await release.promise;
        return await end(...options);
      };
      return session;
    });
    const pending = inspectFileHousekeepingInventory(mongoose, inventoryRequest(), abort.signal);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    try {
      await entered.promise;
      abort.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false);
      expect(session?.hasEnded).toBe(false);
    } finally {
      release.release();
      spy.mockRestore();
    }
    expect(await pending).toEqual({ outcome: 'refused', code: 'deadline' });
    expect(session?.hasEnded).toBe(true);
  });

  test('inventory settles an actual blocked aggregation within its original finite budget', async () => {
    const db = mongoose.connection.db!;
    await db.admin().command({
      configureFailPoint: 'failCommand',
      mode: 'alwaysOn',
      data: {
        failCommands: ['aggregate'],
        appName: 'housekeeping-file-coverage-test',
        blockConnection: true,
        blockTimeMS: 5000,
      },
    });
    const started = performance.now();
    try {
      const result = await inspectFileHousekeepingInventory(
        mongoose,
        {
          ...inventoryRequest(),
          originalDeadline: new Date(Date.now() + 800).toISOString(),
        },
        signal,
      );
      expect(result.outcome).toBe('refused');
      expect(performance.now() - started).toBeLessThan(2000);
    } finally {
      await db.admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
    }
  });
  test.each(['none', 'expiresAt'])(
    'inventory reports actual collection-level TTL as unknown with %s field TTL',
    async (indexKind) => {
      const database = 'inventory-clustered-' + indexKind;
      const observer = new mongoose.Mongoose();
      await observer.connect(mongo.getUri(database), { autoCreate: false, autoIndex: false });
      try {
        const db = observer.connection.db!;
        const files = await db.createCollection('files', {
          clusteredIndex: { key: { _id: 1 }, unique: true },
          expireAfterSeconds: 3600,
        });
        await files.insertOne({
          _id: new Date(),
          filename: 'private-clustered-file',
          expiresAt: new Date(Date.now() + 60_000),
        } as never);
        if (indexKind === 'expiresAt')
          await files.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 3600 });
        const metadata = await db.listCollections({ name: 'files' }, { nameOnly: false }).toArray();
        expect(metadata[0].options).toMatchObject({
          clusteredIndex: { key: { _id: 1 }, unique: true },
          expireAfterSeconds: 3600,
        });
        const indexes = await files.listIndexes().toArray();
        expect(
          indexes.filter((index) =>
            Object.prototype.hasOwnProperty.call(index, 'expireAfterSeconds'),
          ),
        ).toHaveLength(indexKind === 'none' ? 1 : 2);
        expect(indexes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              clustered: true,
              key: { _id: 1 },
              expireAfterSeconds: 3600,
            }),
          ]),
        );
        const result = await inspectFileHousekeepingInventory(
          observer,
          inventoryRequest(database),
          signal,
        );
        expect(result).toMatchObject({
          outcome: 'inventoried',
          counts: { totalFiles: 1 },
          ttl: {
            semantics: 'unknown',
            eligibleAtObservation: null,
            becomingEligibleByHorizon: null,
            afterHorizon: null,
          },
          intervalAssurance: 'unknown',
        });
        expect(JSON.stringify(result)).not.toContain('private-clustered-file');
      } finally {
        await observer.disconnect();
      }
    },
  );
});
