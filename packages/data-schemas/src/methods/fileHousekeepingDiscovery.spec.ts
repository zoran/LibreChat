/** Actual Mongo repair/CAS races, pinned status reads and finite cancellation settlement. */
import mongoose from 'mongoose';
import { performance } from 'node:perf_hooks';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { HousekeepingWork } from '../types/housekeeping';
import {
  initialFileRetentionActivity,
  advanceFileRetentionActivity,
} from './fileActivityTransition';
import { createFileHousekeepingDiscoveryMethods } from './fileHousekeepingDiscovery';
import { createHousekeepingStore } from './housekeepingStore';
import { createHousekeepingRepository } from './housekeeping';
import { createUploadStore } from './uploadManagementStore';
import fileSchema from '../schema/file';

const barrier = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

describe('File housekeeping discovery', () => {
  let mongo: MongoMemoryReplSet;
  let store: ReturnType<typeof createHousekeepingStore>;
  let upload: ReturnType<typeof createUploadStore>;
  let discovery: ReturnType<typeof createFileHousekeepingDiscoveryMethods>;
  const File = mongoose.model('File', fileSchema);
  const user = new mongoose.Types.ObjectId();
  const signal = new AbortController().signal;
  const worker = { podUid: 'pod-a', incarnation: 'boot-a', source: 'source-a', hostId: 'cpu-2' };

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
  async function transaction<T>(action: (session: mongoose.ClientSession) => Promise<T>) {
    const session = await mongoose.startSession();
    try {
      return await session.withTransaction(() => action(session));
    } finally {
      await session.endSession();
    }
  }
  const failpoint = (mode: 'alwaysOn' | 'off', commands: string[] = []) =>
    mongoose.connection.db!.admin().command({
      configureFailPoint: 'failCommand',
      mode,
      ...(mode === 'alwaysOn'
        ? {
            data: {
              failCommands: commands,
              appName: 'housekeeping-file-discovery-test',
              blockConnection: true,
              blockTimeMS: 5000,
            },
          }
        : {}),
    });

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      replSet: { count: 1, args: ['--setParameter', 'enableTestCommands=1'] },
    });
    await mongoose.connect(mongo.getUri(), {
      retryWrites: false,
      monitorCommands: true,
      appName: 'housekeeping-file-discovery-test',
    });
    store = createHousekeepingStore(mongoose);
    upload = createUploadStore(mongoose, {});
    discovery = createFileHousekeepingDiscoveryMethods(mongoose);
    await Promise.all([File.init(), store.initialize(), upload.initialize()]);
  });
  beforeEach(async () => {
    await Promise.all([File.deleteMany({}), store.model.deleteMany({})]);
    await upload.initialize();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });

  it('walks the _id index in pages of 32 and projects real owner obligations without quota writes', async () => {
    await File.insertMany(Array.from({ length: 33 }, (_, n) => fixture(n + 1)));
    const before = await upload.Counter.findById('global').lean();
    const first = await discovery.discover('file.warning', null);
    expect(first).toEqual({ cursor: fixture(32)._id.toString(), scanned: 32, complete: false });
    expect(await store.model.countDocuments()).toBe(96);
    const second = await discovery.discover('file.cleanup', first.cursor);
    expect(second).toEqual({ cursor: null, scanned: 1, complete: true });
    expect(await store.model.countDocuments()).toBe(99);
    const explanation = await File.collection
      .find({ _id: { $gt: fixture(32)._id } }, { hint: '_id_', sort: { _id: 1 }, limit: 32 })
      .explain('executionStats');
    expect(JSON.stringify(explanation.queryPlanner.winningPlan)).toContain('IXSCAN');
    expect(explanation.executionStats.totalKeysExamined).toBe(1);
    expect(await upload.Counter.findById('global').lean()).toEqual(before);
    await expect(discovery.discover('file.cleanup', 'not-a-cursor')).rejects.toThrow('cursor');
  });

  it('passes frozen and unclassified legacy rows without inventing namespace or activity history', async () => {
    const frozen = fixture(1);
    await File.create({
      ...frozen,
      retentionActivity: { ...frozen.retentionActivity, migrationEpoch: 'migration-held' },
    });
    const missingTenant = fixture(2);
    const legacy = fixture(3);
    await File.collection.insertMany([
      { ...missingTenant, tenantId: undefined },
      { ...legacy, retentionActivity: undefined, retentionRevision: undefined },
    ]);
    await File.collection.updateOne({ _id: missingTenant._id }, { $unset: { tenantId: 1 } });
    await File.create(fixture(4));
    const before = await File.collection.find({ _id: { $lt: fixture(4)._id } }).toArray();
    expect(await discovery.discover('file.cleanup', null)).toEqual({
      cursor: null,
      scanned: 4,
      complete: true,
    });
    expect(await store.model.countDocuments()).toBe(3);
    expect(await File.collection.find({ _id: { $lt: fixture(4)._id } }).toArray()).toEqual(before);
    const session = await mongoose.startSession({ snapshot: true, causalConsistency: false });
    try {
      expect(await discovery.coverage('file.cleanup', signal, session)).toEqual({
        expected: null,
        observed: 1,
        recoveryHistory: 'unknown',
      });
      expect(session.hasEnded).toBe(false);
      expect(session.inTransaction()).toBe(false);
    } finally {
      await session.endSession();
    }
  });

  it('rejects a stale File CAS after a real activity commit and preserves earlier armed evidence', async () => {
    const initial = fixture(1, new Date(Date.now() + 3 * 86400000));
    await File.create(initial);
    await discovery.discover('file.warning', null);
    const claimed = (await store.claimNext('file.warning', worker))!;
    expect(claimed).not.toBeNull();
    await transaction(async (session) => {
      expect(
        await store.advance(
          claimed,
          { revision: claimed.progressRevision, phase: 'scheduled' },
          { phase: 'prepared', code: 'progress' },
          session,
        ),
      ).toBe(true);
      expect(
        await store.advance(
          claimed,
          { revision: claimed.progressRevision + 1, phase: 'prepared' },
          { phase: 'armed', code: 'progress', receiptRef: 'mail-submission-original' },
          session,
        ),
      ).toBe(true);
    });
    const oldJob = await store.model.findById(claimed.jobId).lean();
    const entered = barrier();
    const proceed = barrier();
    const original = File.collection.updateOne.bind(File.collection);
    jest.spyOn(File.collection, 'updateOne').mockImplementationOnce(async (...args) => {
      entered.release();
      await proceed.promise;
      return original(...args);
    });
    const repairing = discovery.discover('file.cleanup', null);
    await entered.promise;
    try {
      const next = advanceFileRetentionActivity(
        initial.retentionActivity,
        initial.expiredAt,
        'read',
        Date.now(),
        Date.now(),
      );
      await original(
        { _id: initial._id, retentionRevision: 1 },
        {
          $set: { expiredAt: next.expiredAt, retentionActivity: next.activity },
          $inc: { retentionRevision: 1 },
        },
      );
    } finally {
      proceed.release();
    }
    expect(await repairing).toEqual({
      cursor: initial._id.toString(),
      scanned: 1,
      complete: false,
    });
    expect(await store.model.findById(claimed.jobId).lean()).toEqual(oldJob);
    expect(await discovery.discover('file.cleanup', null)).toEqual({
      cursor: null,
      scanned: 1,
      complete: true,
    });
    expect(await store.model.countDocuments({ 'work.deadlineGeneration': 1 })).toBe(3);
    expect(await store.model.findById(claimed.jobId).lean()).toEqual(oldJob);
  });

  it('rolls back an unclassified retry floor without stranding later valid File obligations', async () => {
    const initial = fixture(1);
    await File.create(initial);
    await File.create(fixture(2));
    const work: HousekeepingWork = {
      handler: 'file.warning',
      subject: { tenantId: 'tenant-a', ownerUserId: String(user), fileId: initial.file_id },
      deadlineGeneration: 0,
      offsetDays: 7,
    };
    const id = await transaction((session) => store.project(work, new Date(999), session));
    await store.model.updateOne(
      { _id: id },
      {
        $set: { attempts: 1, nextAttemptAt: new Date(2099999999999) },
        $unset: { retryNotBefore: 1 },
      },
    );
    const before = await store.model.findById(id).lean();
    expect(await discovery.discover('file.warning', null)).toEqual({
      cursor: fixture(2)._id.toString(),
      scanned: 2,
      complete: false,
    });
    expect(await store.model.findById(id).lean()).toEqual(before);
    expect(await store.model.countDocuments()).toBe(4);
    expect((await File.findById(initial._id).lean())?.retentionRevision).toBe(0);
    expect((await File.findById(fixture(2)._id).lean())?.retentionRevision).toBe(1);
  });

  it('reads actual owner coverage in the count snapshot and never makes empty EOF complete coverage', async () => {
    expect(await discovery.discover('file.warning', null)).toEqual({
      cursor: null,
      scanned: 0,
      complete: true,
    });
    await upload.Counter.deleteOne({ _id: 'global' });
    const entered = barrier();
    const proceed = barrier();
    let held = false;
    const repository = createHousekeepingRepository(
      store,
      {
        discover: (handler, cursor) => discovery.discover(handler as 'file.warning', cursor),
        async coverage(handler, cancellation, session) {
          if (!held && handler === 'file.warning') {
            held = true;
            entered.release();
            await proceed.promise;
          }
          if (handler === 'upload.cleanup')
            return { expected: null, observed: 0, recoveryHistory: 'unknown' };
          return discovery.coverage(handler, cancellation, session);
        },
      },
      { sourceId: 'file-discovery-test' },
    );
    const earlier = repository.readStatus(signal);
    await entered.promise;
    try {
      await upload.initialize();
      await File.create(fixture(1));
      await discovery.discover('file.warning', null);
    } finally {
      proceed.release();
    }
    const old = (await earlier).handlers.find((entry) => entry.handler === 'file.warning')!;
    expect(old).toMatchObject({ quality: 'unknown', coverage: { expected: null, observed: 0 } });
    expect(old.values.pendingCount).toBeNull();
    const later = (await repository.readStatus(signal)).handlers.find(
      (entry) => entry.handler === 'file.warning',
    )!;
    expect(later).toMatchObject({
      quality: 'partial',
      coverage: { expected: null, observed: 1 },
      values: { pendingCount: 2, recoveredClaimsCount: null, lastRecoveryAt: null },
    });
    await File.deleteMany({});
    await store.model.deleteMany({});
    const empty = (await repository.readStatus(signal)).handlers.find(
      (entry) => entry.handler === 'file.warning',
    )!;
    expect(empty).toMatchObject({ quality: 'partial', values: { pendingCount: 0 } });
  });

  it('bounds stalled projection and abort together by one awaited three-second page budget', async () => {
    await File.insertMany([fixture(1), fixture(2)]);
    const sessions: mongoose.ClientSession[] = [];
    const client = mongoose.connection.getClient();
    const start = client.startSession.bind(client);
    jest.spyOn(client, 'startSession').mockImplementation((options) => {
      const session = start(options);
      if (!options) sessions.push(session);
      return session;
    });
    await failpoint('alwaysOn', ['update', 'abortTransaction']);
    const began = performance.now();
    let elapsed = 0;
    try {
      expect(await discovery.discover('file.cleanup', null)).toEqual({
        cursor: null,
        scanned: 0,
        complete: false,
      });
      elapsed = performance.now() - began;
      expect(elapsed).toBeGreaterThan(2500);
      expect(elapsed).toBeLessThan(3700);
      expect(sessions.length).toBe(1);
      expect(sessions.every((session) => session.hasEnded && !session.inTransaction())).toBe(true);
    } finally {
      await failpoint('off');
    }
    expect(await store.model.countDocuments()).toBe(0);
    expect((await File.findById(fixture(1)._id).lean())?.retentionRevision).toBe(0);
    console.info(
      JSON.stringify({
        case: 'one-total-query-budget',
        elapsedMs: Math.round(elapsed),
        sessionsEnded: sessions.length,
      }),
    );
  });

  it('awaits cancelled Mongo coverage and leaves the supplied snapshot session with its caller', async () => {
    const session = await mongoose.startSession({ snapshot: true, causalConsistency: false });
    const cancellation = new AbortController();
    const started = barrier();
    const settled = barrier();
    const release = barrier();
    const client = mongoose.connection.getClient();
    const commandStarted = (event: mongoose.mongo.CommandStartedEvent) => {
      if (event.commandName === 'find') started.release();
    };
    const original = upload.Counter.collection.findOne.bind(upload.Counter.collection);
    jest.spyOn(upload.Counter.collection, 'findOne').mockImplementationOnce(async (...args) => {
      try {
        return await original(...args);
      } finally {
        settled.release();
        await release.promise;
      }
    });
    await failpoint('alwaysOn', ['find']);
    client.on('commandStarted', commandStarted);
    let completed = false;
    const reading = discovery
      .coverage('file.cleanup', cancellation.signal, session)
      .then((value) => {
        completed = true;
        return value;
      });
    try {
      await started.promise;
      cancellation.abort();
      await settled.promise;
      expect(completed).toBe(false);
      release.release();
      expect(await reading).toEqual({ expected: null, observed: 0, recoveryHistory: 'unknown' });
      expect(session.hasEnded).toBe(false);
      expect(session.inTransaction()).toBe(false);
    } finally {
      release.release();
      await reading;
      client.off('commandStarted', commandStarted);
      await failpoint('off');
      await session.endSession();
    }
  });
});
