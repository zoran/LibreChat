/** Real snapshot/coverage reads through the production read-only composition. */
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { CounterRow } from './uploadManagementStore';
import { housekeepingShape } from '../../../data-provider/src/status-housekeeping';
import { createUploadManagementRepository } from './uploadManagement';
import { readUploadHousekeepingCoverage } from './uploadHousekeeping';
import { createHousekeepingStatusReader } from './housekeepingStatus';
import { createHousekeepingStore } from './housekeepingStore';
import { createUploadStore } from './uploadManagementStore';
import fileSchema from '../schema/file';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('read-only Housekeeping Status composition', () => {
  let mongo: MongoMemoryReplSet;
  let jobs: ReturnType<typeof createHousekeepingStore>;
  let uploads: ReturnType<typeof createUploadStore>;
  let repository: ReturnType<typeof createUploadManagementRepository>;
  const File = mongoose.model('File', fileSchema);
  const read = createHousekeepingStatusReader(mongoose);
  const signal = new AbortController().signal;
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongo.getUri(), { retryWrites: false, monitorCommands: true });
    jobs = createHousekeepingStore(mongoose);
    uploads = createUploadStore(mongoose, {});
    await Promise.all([File.init(), jobs.initialize(), uploads.initialize()]);
    repository = createUploadManagementRepository(mongoose, {});
    await mongoose.models.FileReadReceipt.init();
  });
  beforeEach(async () => {
    await jobs.model.deleteMany({});
    await uploads.initialize();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    mongoose.deleteModel(/.*/);
    await mongo?.stop();
  });
  async function schedule(id: string) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(() =>
        jobs.project(
          {
            handler: 'file.warning',
            subject: { tenantId: null, ownerUserId: 'owner', fileId: id },
            deadlineGeneration: 1,
            offsetDays: 7,
          },
          new Date(1000),
          session,
        ),
      );
    } finally {
      await session.endSession();
    }
  }
  function holdCoverage() {
    const entered = barrier();
    const proceed = barrier();
    const collection = uploads.Counter
      .collection as unknown as mongoose.mongo.Collection<CounterRow>;
    const original = collection.findOne.bind(collection);
    jest.spyOn(collection, 'findOne').mockImplementationOnce(async (filter, options) => {
      entered.release();
      await proceed.promise;
      return original(filter, options);
    });
    return { entered, proceed };
  }

  it('constructs without I/O and never creates missing models during a read', async () => {
    const isolated = new mongoose.Mongoose();
    const model = jest.spyOn(isolated, 'model');
    const start = jest.spyOn(isolated.connection, 'startSession');
    const reader = createHousekeepingStatusReader(isolated);
    expect(model).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    const result = await reader(signal);
    expect(result.observation.state).toBe('unavailable');
    expect(result.handlers.every((row) => row.quality === 'unknown')).toBe(true);
    expect(model).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(Object.keys(isolated.models)).toEqual([]);
  });

  it('reads one real global aggregate with actual partial File coverage and no writes', async () => {
    await schedule('a');
    await schedule('b');
    const commands: string[] = [];
    const capture = (event: mongoose.mongo.CommandStartedEvent) => {
      commands.push(event.commandName);
    };
    const client = mongoose.connection.getClient();
    client.on('commandStarted', capture);
    let domain;
    try {
      domain = await read(signal);
    } finally {
      client.off('commandStarted', capture);
    }
    expect(commands.filter((name) => name === 'aggregate')).toHaveLength(1);
    expect(
      commands.filter((name) =>
        ['insert', 'update', 'delete', 'create', 'createIndexes', 'findAndModify'].includes(name),
      ),
    ).toEqual([]);
    expect(domain.observation).toMatchObject({ state: 'fresh', reason: 'partial_coverage' });
    expect(domain.observation.evidence[0].sourceId).toBe('application-housekeeping');
    expect(domain.handlers[0]).toMatchObject({
      quality: 'partial',
      coverage: { expected: null, observed: 1 },
      values: { pendingCount: 2, recoveredClaimsCount: null, lastRecoveryAt: null },
    });
    expect(domain.handlers[2]).toMatchObject({
      quality: 'partial',
      coverage: { expected: null, observed: 1 },
      values: { pendingCount: 0, recoveredClaimsCount: null, lastRecoveryAt: null },
    });
    expect(housekeepingShape.shape.domain.parse(domain)).toEqual(domain);
  });

  it('does not turn missing owner coverage or empty jobs into complete zero totals', async () => {
    await uploads.Counter.deleteOne({ _id: 'global' });
    const result = await read(signal);
    expect(result.observation.state).toBe('unavailable');
    for (const handler of result.handlers) {
      expect(handler.quality).toBe('unknown');
      expect(Object.values(handler.values).every((value) => value === null)).toBe(true);
    }
  });

  it('keeps later owner creation and jobs outside the original count snapshot', async () => {
    await uploads.Counter.deleteOne({ _id: 'global' });
    const { entered, proceed } = holdCoverage();
    const earlier = read(signal);
    await entered.promise;
    try {
      await uploads.initialize();
      await schedule('later');
    } finally {
      proceed.release();
    }
    expect((await earlier).handlers[0].values.pendingCount).toBeNull();
    const later = await read(signal);
    expect(later.handlers[0]).toMatchObject({ quality: 'partial', values: { pendingCount: 1 } });
  });

  it('awaits original coverage and session closure after abort', async () => {
    const { entered, proceed } = holdCoverage();
    const start = jest.spyOn(mongoose.connection, 'startSession');
    const controller = new AbortController();
    let settled = false;
    const pending = read(controller.signal).then((value) => {
      settled = true;
      return value;
    });
    await entered.promise;
    const session = await start.mock.results[0].value;
    const close = jest.spyOn(session, 'endSession');
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(close).not.toHaveBeenCalled();
    proceed.release();
    expect((await pending).observation.state).toBe('unknown');
    expect(close).toHaveBeenCalledTimes(1);
    expect(session.hasEnded).toBe(true);
  });

  it('does not start a database snapshot for an already aborted read', async () => {
    const start = jest.spyOn(mongoose.connection, 'startSession');
    const controller = new AbortController();
    controller.abort();
    const result = await read(controller.signal);
    expect(result.observation.state).toBe('unknown');
    expect(start).not.toHaveBeenCalled();
  });

  it('exposes one bound Upload coverage owner with a finite read and no completeness from flags', async () => {
    const coverage = repository.coverageUploadHousekeeping;
    const before = await uploads.Counter.findById('global').lean<CounterRow>();
    const session = await mongoose.startSession({ snapshot: true, causalConsistency: false });
    const collection = uploads.Counter
      .collection as unknown as mongoose.mongo.Collection<CounterRow>;
    const commands: string[] = [];
    const capture = (event: mongoose.mongo.CommandStartedEvent) => commands.push(event.commandName);
    const client = mongoose.connection.getClient();
    try {
      await uploads.Counter.updateOne(
        { _id: 'global' },
        {
          $set: {
            'value.enabled': true,
            'value.reconciled': true,
            'value.completedImport': { receipt: 'not-a-coverage-proof' },
            'value.activationProof': { admission: 'initial-empty' },
          },
        },
      );
      await uploads.Counter.findById('global').session(session).lean();
      const query = jest.spyOn(collection, 'findOne');
      client.on('commandStarted', capture);
      expect(await coverage(signal, session)).toEqual({
        expected: null,
        observed: 1,
        recoveryHistory: 'unknown',
      });
      expect(query).toHaveBeenCalledWith(
        { _id: 'global' },
        expect.objectContaining({
          session,
          signal,
          maxTimeMS: 3000,
          timeoutMS: 3000,
        }),
      );
      expect(commands).toEqual(['find']);
      expect(session.hasEnded).toBe(false);
    } finally {
      client.off('commandStarted', capture);
      await session.endSession();
      if (before) await uploads.Counter.replaceOne({ _id: 'global' }, before);
    }
  });

  it('keeps malformed, migrating and missing Upload scopes unknown without creating models', async () => {
    const before = await uploads.Counter.findById('global').lean<CounterRow>();
    if (!before) throw Error('Missing initialized owner');
    const expected = { expected: null, observed: 0, recoveryHistory: 'unknown' };
    const patches = [
      { revision: -1 },
      { 'value.storeId': 'not-a-store' },
      { 'value.storeId': null },
      { 'value.migration': {} },
      { 'value.migrationEpoch': 'import-in-progress' },
    ];
    try {
      for (const patch of patches) {
        await uploads.Counter.replaceOne({ _id: 'global' }, before);
        await uploads.Counter.updateOne({ _id: 'global' }, { $set: patch });
        const session = await mongoose.startSession({ snapshot: true, causalConsistency: false });
        try {
          expect(await readUploadHousekeepingCoverage(mongoose, signal, session)).toEqual(expected);
        } finally {
          await session.endSession();
        }
      }
      await uploads.Counter.deleteOne({ _id: 'global' });
      const session = await mongoose.startSession({ snapshot: true, causalConsistency: false });
      try {
        expect(await readUploadHousekeepingCoverage(mongoose, signal, session)).toEqual(expected);
        const isolated = new mongoose.Mongoose();
        const create = jest.spyOn(isolated, 'model');
        expect(await readUploadHousekeepingCoverage(isolated, signal, session)).toEqual(expected);
        expect(create).not.toHaveBeenCalled();
        expect(Object.keys(isolated.models)).toEqual([]);
      } finally {
        await session.endSession();
      }
      expect(await readUploadHousekeepingCoverage(mongoose, signal, session)).toEqual(expected);
      const ordinary = await mongoose.startSession();
      try {
        expect(await readUploadHousekeepingCoverage(mongoose, signal, ordinary)).toEqual(expected);
      } finally {
        await ordinary.endSession();
      }
    } finally {
      await uploads.Counter.replaceOne({ _id: 'global' }, before, { upsert: true });
    }
  });

  it('keeps Upload coverage in the original Status snapshot across a later migration', async () => {
    const { entered, proceed } = holdCoverage();
    const earlier = read(signal);
    await entered.promise;
    try {
      await uploads.Counter.updateOne(
        { _id: 'global' },
        { $set: { 'value.migrationEpoch': 'later' } },
      );
      proceed.release();
      expect((await earlier).handlers[2]).toMatchObject({
        quality: 'partial',
        coverage: { expected: null, observed: 1 },
      });
      const later = await read(signal);
      expect(later.handlers[2].quality).toBe('unknown');
      expect(Object.values(later.handlers[2].values).every((value) => value === null)).toBe(true);
    } finally {
      proceed.release();
      await earlier;
      await uploads.Counter.updateOne(
        { _id: 'global' },
        { $unset: { 'value.migrationEpoch': '' } },
      );
    }
  });

  it('retains the original Upload read after cancellation and leaves session closure to its caller', async () => {
    const repository = createUploadManagementRepository(mongoose, {});
    const controller = new AbortController();
    const session = await mongoose.startSession({ snapshot: true, causalConsistency: false });
    const { entered, proceed } = holdCoverage();
    let settled = false;
    const pending = repository
      .coverageUploadHousekeeping(controller.signal, session)
      .then((value) => {
        settled = true;
        return value;
      });
    await entered.promise;
    try {
      controller.abort();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(session.hasEnded).toBe(false);
      proceed.release();
      expect(await pending).toEqual({ expected: null, observed: 0, recoveryHistory: 'unknown' });
      expect(session.hasEnded).toBe(false);
    } finally {
      proceed.release();
      await pending;
      await session.endSession();
    }
  });
});
