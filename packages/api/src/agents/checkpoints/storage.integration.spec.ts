import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { emptyCheckpoint, INTERRUPT } from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { AggregationCursor, Collection } from 'mongodb';
import {
  getAgentCheckpointer,
  __resetCheckpointerForTests,
  LIBRECHAT_CHECKPOINT_OWNER_KEY,
  LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY,
} from '../checkpointer';
import {
  checkpointStorageConfigs,
  CHECKPOINT_STORAGE_COLLECTION,
  checkpointStorageKey,
  inspectCheckpointIndexPopulation,
} from './storage';
import {
  createCheckpointNamespace,
  checkpointOwnerNamespacePrefix,
} from '../../stream/checkpoints';
import { openCheckpointDeletion, createCheckpointDeletionReclaimer } from './deletion';
import { resolveCheckpointerConfig } from './config';

let server: MongoMemoryServer;
const cfg = {
  type: 'mongo' as const,
  checkpointCollectionName: 'old_cp',
  checkpointWritesCollectionName: 'old_writes',
};
beforeAll(async () => {
  server = await MongoMemoryServer.create({
    instance: { args: ['--setParameter', 'enableTestCommands=1'] },
  });
  await mongoose.connect(server.getUri());
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
afterEach(async () => {
  jest.restoreAllMocks();
  __resetCheckpointerForTests();
  await mongoose.connection.db!.dropDatabase();
});

describe('checkpoint index metadata inspection', () => {
  const options = () => ({
    originalDeadline: new Date(Date.now() + 60_000).toISOString(),
    targetBindingSha256: 'a'.repeat(64),
    currentConfig: resolveCheckpointerConfig(undefined),
    historicalStorageLineage: { evidenceSha256: 'b'.repeat(64), stores: [] },
  });
  const checkpointKey = { thread_id: 1, checkpoint_ns: 1, checkpoint_id: -1 } as const;

  test('settles a genuinely stalled native read and closes its cursor before the caller deadline', async () => {
    const db = mongoose.connection.db!;
    const collection = db.collection.bind(db);
    const cursors: AggregationCursor[] = [];
    let pending = 0;
    jest.spyOn(db, 'collection').mockImplementation((name, ...args) => {
      const result = collection(name, ...args);
      const aggregate = result.aggregate.bind(result);
      jest.spyOn(result, 'aggregate').mockImplementation((pipeline, opts) => {
        const cursor = aggregate(pipeline, opts);
        const toArray = cursor.toArray.bind(cursor);
        jest.spyOn(cursor, 'toArray').mockImplementation(async () => {
          pending++;
          try {
            return await toArray();
          } finally {
            pending--;
          }
        });
        cursors.push(cursor);
        return cursor;
      });
      return result;
    });
    await db.admin().command({
      configureFailPoint: 'failCommand',
      mode: { times: 1 },
      data: { failCommands: ['aggregate'], blockConnection: true, blockTimeMS: 1500 },
    });
    const started = Date.now();
    try {
      await expect(
        inspectCheckpointIndexPopulation({
          ...options(),
          originalDeadline: new Date(started + 600).toISOString(),
        }),
      ).rejects.toThrow('Initial checkpoint inventory is unavailable or incomplete');
      expect(Date.now() - started).toBeLessThan(600);
      expect(pending).toBe(0);
      expect(cursors).toHaveLength(1);
      expect(cursors.every((cursor) => cursor.closed)).toBe(true);
      await db.admin().command({
        waitForFailPoint: 'failCommand',
        timesEntered: 1,
        maxTimeMS: 1000,
      });
      expect(await db.admin().command({ ping: 1 })).toMatchObject({ ok: 1 });
    } finally {
      await db.admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
    }
  });

  test.each([true, undefined])(
    'qualifies Mongo index metadata only after building=%s finishes',
    async (building) => {
      const db = mongoose.connection.db!;
      const collection = db.collection.bind(db);
      jest.spyOn(db, 'collection').mockImplementation((name, ...args) => {
        const result = collection(name, ...args);
        const aggregate = result.aggregate.bind(result);
        jest.spyOn(result, 'aggregate').mockImplementation((pipeline = [], opts) => {
          if (!pipeline[0]?.$indexStats) return aggregate(pipeline, opts);
          const pending = name.endsWith('_writes');
          const key = pending
            ? { thread_id: 1, checkpoint_ns: 1, checkpoint_id: 1, task_id: 1, idx: 1 }
            : checkpointKey;
          const definition = {
            name: pending ? 'lc_pending_slot_unique' : 'lc_checkpoint_slot_unique',
            key,
            spec: { key, unique: true },
            ...(building === undefined ? {} : { building }),
          };
          // Mongo executes the actual inspector projection; only the indexStats source is controlled.
          return db.aggregate([{ $documents: [definition] }, ...pipeline.slice(1)], opts);
        });
        return result;
      });
      const result = await inspectCheckpointIndexPopulation(options());
      expect(result.complete).toBe(building !== true);
      for (const row of result.collections) {
        expect(row.indexStatus).toBe(building ? 'conflicting' : 'verified');
        expect(row.indexes[0]).toMatchObject({ building: building === true });
      }
    },
  );

  test('counts empty default stores without creating a collection or an index', async () => {
    const db = mongoose.connection.db!;
    const before = await db.listCollections().toArray();
    const result = await inspectCheckpointIndexPopulation(options());
    expect(result.collections).toHaveLength(2);
    for (const row of result.collections)
      expect(row).toMatchObject({
        rowCount: 0,
        malformedKeyRows: 0,
        duplicateGroups: 0,
        duplicateExcessRows: 0,
        indexes: [],
        indexStatus: 'missing',
      });
    expect(result.complete).toBe(false);
    expect(await db.listCollections().toArray()).toEqual(before);
  });

  test('qualifies exact physical indexes only with explicit historical lineage', async () => {
    // The actual saver owns the physical definitions; the inspector consumes its real output.
    await seed(
      { configurable: { thread_id: 'native-index-owner', checkpoint_ns: '' } },
      {
        type: 'mongo',
        checkpointCollectionName: options().currentConfig.checkpointCollectionName,
        checkpointWritesCollectionName: options().currentConfig.checkpointWritesCollectionName,
      },
    );
    expect(await inspectCheckpointIndexPopulation(options())).toMatchObject({ complete: true });
    expect(
      await inspectCheckpointIndexPopulation({ ...options(), historicalStorageLineage: undefined }),
    ).toMatchObject({ complete: false, historicalLineageSha256: null });
  });

  test('includes current, registered and historical stores and preserves duplicate payloads', async () => {
    const db = mongoose.connection.db!;
    const owner = checkpointOwnerNamespacePrefix('private-owner');
    const retained = {
      type: 'mongo' as const,
      checkpointCollectionName: 'retained_cp',
      checkpointWritesCollectionName: 'retained_writes',
    };
    await db.collection(CHECKPOINT_STORAGE_COLLECTION).insertOne({
      _id: `${owner}${checkpointStorageKey(retained)}`,
      owner,
      storage: retained,
    } as never);
    const payload = {
      thread_id: 'private-thread',
      checkpoint_ns: 'private-namespace',
      checkpoint_id: 'private-checkpoint',
      lc_owner: owner,
      checkpoint: Buffer.alloc(1024, 77),
    };
    await db.collection('retained_cp').insertMany([{ ...payload }, { ...payload }, { ...payload }]);
    const before = await db.collection('retained_cp').find().toArray();
    const input = options();
    const result = await inspectCheckpointIndexPopulation({
      ...input,
      currentConfig: resolveCheckpointerConfig(cfg),
      historicalStorageLineage: {
        ...input.historicalStorageLineage,
        stores: [
          {
            type: 'mongo',
            checkpointCollectionName: 'historical_cp',
            checkpointWritesCollectionName: 'historical_writes',
          },
        ],
      },
    });
    expect(result.collections).toHaveLength(8);
    expect(result.collections.find((row) => row.collection === 'retained_cp')).toMatchObject({
      rowCount: 3,
      malformedKeyRows: 0,
      duplicateGroups: 1,
      duplicateExcessRows: 2,
    });
    const wire = JSON.stringify(result);
    for (const secret of [owner, 'private-thread', 'private-namespace', 'private-checkpoint'])
      expect(wire).not.toContain(secret);
    expect(await db.collection('retained_cp').countDocuments()).toBe(3);
    expect(await db.collection('retained_cp').find().toArray()).toEqual(before);
    expect(result.complete).toBe(false);
  });

  test('counts malformed pending keys while preserving empty namespace and negative integral slots', async () => {
    const base = { thread_id: 'thread', checkpoint_ns: '', checkpoint_id: 'cp', task_id: 'task' };
    await mongoose.connection
      .db!.collection('agent_checkpoint_writes')
      .insertMany([
        { ...base, idx: -1 },
        { ...base, idx: -2 },
        { ...base, idx: 0 },
        { ...base, idx: 1.5 },
        { ...base, idx: '1' },
        { ...base, idx: null },
        { ...base, idx: 2, task_id: ['array'] },
        { ...base },
      ]);
    const result = await inspectCheckpointIndexPopulation(options());
    expect(result.collections.find((row) => row.role === 'pending')).toMatchObject({
      rowCount: 8,
      malformedKeyRows: 5,
      duplicateGroups: 1,
      duplicateExcessRows: 1,
    });
    expect(
      await mongoose.connection.db!.collection('agent_checkpoint_writes').countDocuments(),
    ).toBe(8);
  });

  test.each(['nonunique', 'sparse', 'partial', 'collation', 'key'] as const)(
    'reports a %s physical-index conflict without changing its definition',
    async (kind) => {
      const collection = mongoose.connection.db!.collection('agent_checkpoints');
      await collection.createIndex(kind === 'key' ? { thread_id: 1 } : checkpointKey, {
        name: 'lc_checkpoint_slot_unique',
        unique: kind !== 'nonunique',
        ...(kind === 'sparse' ? { sparse: true } : {}),
        ...(kind === 'partial'
          ? { partialFilterExpression: { thread_id: 'private-index-filter' } }
          : {}),
        ...(kind === 'collation' ? { collation: { locale: 'en', strength: 2 } } : {}),
      });
      const before = await collection.indexes();
      const result = await inspectCheckpointIndexPopulation(options());
      expect(result.collections.find((row) => row.role === 'checkpoint')?.indexStatus).toBe(
        'conflicting',
      );
      expect(result.complete).toBe(false);
      expect(JSON.stringify(result)).not.toContain('private-index-filter');
      expect(await collection.indexes()).toEqual(before);
    },
  );

  test('rejects oversized index definitions without returning their private filter contents', async () => {
    const collection = mongoose.connection.db!.collection('agent_checkpoints');
    await collection.createIndex(checkpointKey, {
      name: 'lc_checkpoint_slot_unique',
      unique: true,
      partialFilterExpression: { thread_id: { $in: ['private-filter-' + 'x'.repeat(5000)] } },
    });
    const before = await collection.indexes();
    await expect(inspectCheckpointIndexPopulation(options())).rejects.toThrow(
      'Initial checkpoint inventory is unavailable or incomplete',
    );
    expect(await collection.indexes()).toEqual(before);
  });

  test('refuses a truncated registry and an expired deadline without interpreting either as empty', async () => {
    const storage = {
      type: 'mongo' as const,
      checkpointCollectionName: 'retained_cp',
      checkpointWritesCollectionName: 'retained_writes',
    };
    await mongoose.connection.db!.collection(CHECKPOINT_STORAGE_COLLECTION).insertMany(
      Array.from({ length: 257 }, (_, i) => {
        const owner = `lcg:v2:${i.toString(16).padStart(64, '0')}:`;
        return { _id: `${owner}${checkpointStorageKey(storage)}`, owner, storage } as never;
      }),
    );
    await expect(inspectCheckpointIndexPopulation(options())).rejects.toThrow(/inventory/i);
    await expect(
      inspectCheckpointIndexPopulation({
        ...options(),
        originalDeadline: new Date(Date.now() - 1).toISOString(),
      }),
    ).rejects.toThrow(/inventory/i);
    expect(
      await mongoose.connection.db!.collection(CHECKPOINT_STORAGE_COLLECTION).countDocuments(),
    ).toBe(257);
  });
});

async function seed(config: RunnableConfig, storage = cfg) {
  const saver = (await getAgentCheckpointer(storage))!;
  const checkpoint = emptyCheckpoint();
  await saver.putWrites(
    { configurable: { ...config.configurable, checkpoint_id: checkpoint.id } },
    [[INTERRUPT, [{ value: 'approve', resumable: true }]]],
    'task',
  );
  await saver.put(config, checkpoint, { source: 'input', step: -1, parents: {} });
  return { saver, checkpoint };
}

test.each(['mongo', 'memory'] as const)(
  'the first deletion finds the original store after a switch to %s',
  async (type) => {
    const config = {
      configurable: {
        thread_id: 'thread',
        checkpoint_ns: createCheckpointNamespace('owner', 'tenant'),
      },
    };
    await seed(config);
    const intermediate = {
      ...cfg,
      checkpointCollectionName: 'intermediate_cp',
      checkpointWritesCollectionName: 'intermediate_writes',
    };
    await seed(config, intermediate);
    const changed = {
      type,
      checkpointCollectionName: 'new_cp',
      checkpointWritesCollectionName: 'new_writes',
    };
    const descriptors = await checkpointStorageConfigs('owner', 'tenant', changed);
    expect(descriptors).toEqual(
      expect.arrayContaining([
        expect.objectContaining(cfg),
        expect.objectContaining(intermediate),
        expect.objectContaining(changed),
      ]),
    );
    expect(await checkpointStorageConfigs('foreign', 'tenant', changed)).toEqual([
      expect.objectContaining(changed),
    ]);
    const deletion = await openCheckpointDeletion('owner', 'tenant', 'thread', changed);
    await deletion.remember(['thread']);
    await deletion.cleanup();
    await deletion.acknowledge();
    expect(await mongoose.connection.db!.collection('old_cp').countDocuments()).toBe(0);
    expect(await mongoose.connection.db!.collection('old_writes').countDocuments()).toBe(0);
    expect(await mongoose.connection.db!.collection('intermediate_cp').countDocuments()).toBe(0);
    expect(await mongoose.connection.db!.collection('intermediate_writes').countDocuments()).toBe(
      0,
    );
  },
);

test('concurrent generations share one write-ahead store descriptor', async () => {
  await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      seed({
        configurable: {
          thread_id: `thread-${index}`,
          checkpoint_ns: createCheckpointNamespace('owner', 'tenant'),
        },
      }),
    ),
  );
  const db = mongoose.connection.db!;
  expect(await db.collection(CHECKPOINT_STORAGE_COLLECTION).countDocuments()).toBe(1);
  expect(await db.collection('old_cp').countDocuments()).toBe(8);
  expect(await db.collection('old_writes').countDocuments()).toBe(8);
});

test('catalog failure prevents payload writes, and a later write restores a missing descriptor', async () => {
  const saver = (await getAgentCheckpointer(cfg))!;
  const checkpoint = emptyCheckpoint();
  const config = {
    configurable: {
      thread_id: 'thread',
      checkpoint_ns: createCheckpointNamespace('owner'),
      checkpoint_id: checkpoint.id,
    },
  };
  jest
    .spyOn(mongoose.mongo.Collection.prototype, 'updateOne')
    .mockRejectedValueOnce(new Error('catalog unavailable'));
  await expect(saver.putWrites(config, [[INTERRUPT, []]], 'task')).rejects.toThrow(
    'catalog unavailable',
  );
  expect(await mongoose.connection.db!.collection('old_writes').countDocuments()).toBe(0);
  jest.restoreAllMocks();
  await saver.putWrites(config, [[INTERRUPT, []]], 'task');
  await mongoose.connection.db!.collection(CHECKPOINT_STORAGE_COLLECTION).deleteMany({});
  await saver.putWrites(config, [[INTERRUPT, []]], 'task');
  expect(
    await mongoose.connection.db!.collection(CHECKPOINT_STORAGE_COLLECTION).countDocuments(),
  ).toBe(1);
});

test('upgraded legacy writes record storage without changing the legacy physical layout', async () => {
  await seed({
    configurable: {
      thread_id: 'legacy',
      checkpoint_ns: '',
      [LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY]: checkpointOwnerNamespacePrefix('owner', 'tenant'),
    },
  });
  expect(
    await mongoose.connection
      .db!.collection('old_cp')
      .findOne({ thread_id: 'legacy', checkpoint_ns: '' }),
  ).not.toBeNull();
  expect(await checkpointStorageConfigs('owner', 'tenant', { type: 'memory' })).toEqual(
    expect.arrayContaining([expect.objectContaining(cfg)]),
  );
});

test.each([false, true])(
  'background replay cleans failed deletion without client retry (actor=%s)',
  async (actor) => {
    const owner = checkpointOwnerNamespacePrefix('owner', 'tenant');
    const namespace = actor
      ? 'event-actor/invocation'
      : createCheckpointNamespace('owner', 'tenant');
    await seed({
      configurable: {
        thread_id: 'thread',
        checkpoint_ns: namespace,
        ...(actor ? { [LIBRECHAT_CHECKPOINT_OWNER_KEY]: owner } : {}),
      },
    });
    await mongoose.connection
      .db!.collection('conversations')
      .insertOne({ user: 'owner', conversationId: 'thread' });
    const deletion = await openCheckpointDeletion('owner', 'tenant', 'thread', { type: 'memory' });
    await deletion.remember(['thread']);
    await mongoose.connection.db!.collection('conversations').deleteMany({});
    jest
      .spyOn(mongoose.mongo.Collection.prototype, 'deleteMany')
      .mockRejectedValueOnce(new Error('delete unavailable'));
    await expect(deletion.cleanup()).rejects.toThrow('delete unavailable');
    jest.restoreAllMocks();
    const jobs = jest.fn().mockResolvedValue(['live-job']);
    const recover = createCheckpointDeletionReclaimer(jobs);
    expect(await recover(25)).toBe(0);
    expect(await mongoose.connection.db!.collection('old_writes').countDocuments()).toBeGreaterThan(
      0,
    );
    jobs.mockResolvedValue([]);
    for (let i = 0; i < 3; i++) await recover(25);
    expect(await mongoose.connection.db!.collection('old_cp').countDocuments()).toBe(0);
    expect(await mongoose.connection.db!.collection('old_writes').countDocuments()).toBe(0);
    expect(
      await mongoose.connection.db!.collection('agent_checkpoint_deletions').countDocuments(),
    ).toBe(0);
  },
);

test('background replay preserves a recreated conversation and never captures a replacement namespace', async () => {
  const original = createCheckpointNamespace('owner');
  await seed({ configurable: { thread_id: 'thread', checkpoint_ns: original } });
  const deletion = await openCheckpointDeletion('owner', undefined, 'thread', cfg);
  await deletion.remember(['thread']);
  const replacement = createCheckpointNamespace('owner');
  await seed({ configurable: { thread_id: 'thread', checkpoint_ns: replacement } });
  const db = mongoose.connection.db!;
  await db.collection('conversations').insertOne({ user: 'owner', conversationId: 'thread' });
  const recover = createCheckpointDeletionReclaimer(async () => []);
  await recover(25);
  expect(await db.collection('old_cp').countDocuments()).toBe(2);
  await db.collection('conversations').deleteMany({});
  for (let i = 0; i < 3; i++) await recover(25);
  expect(await db.collection('old_cp').distinct('checkpoint_ns')).toEqual([replacement]);
  expect(await db.collection('old_writes').distinct('checkpoint_ns')).toEqual([replacement]);
});

test('captures nested pending writes without a checkpoint and retains them across replay failures', async () => {
  const saver = (await getAgentCheckpointer(cfg))!;
  const namespace = `${createCheckpointNamespace('owner', 'tenant')}|nested:task`;
  await saver.putWrites(
    {
      configurable: { thread_id: 'child', checkpoint_ns: namespace, checkpoint_id: 'pending-only' },
    },
    [[INTERRUPT, []]],
    'task',
  );
  const db = mongoose.connection.db!;
  expect(await db.collection('old_cp').countDocuments()).toBe(0);
  const deletion = await openCheckpointDeletion('owner', 'tenant', 'root', { type: 'memory' });
  await deletion.remember(['child']);
  const recover = createCheckpointDeletionReclaimer(async () => []);
  const originalDelete = mongoose.mongo.Collection.prototype.deleteMany;
  jest.spyOn(mongoose.mongo.Collection.prototype, 'deleteMany').mockImplementation(function (
    this: Collection,
    ...args
  ) {
    if (this.collectionName === 'old_writes')
      return Promise.reject(new Error('payload unavailable'));
    return originalDelete.apply(this, args);
  });
  for (let pass = 0; pass < 2; pass++) {
    await expect(recover(25)).rejects.toThrow('reclamation failed');
    expect(await db.collection('old_writes').countDocuments()).toBe(1);
    expect(
      await db
        .collection('agent_checkpoint_deletions')
        .countDocuments({ checkpoint: { $exists: true } }),
    ).toBe(1);
  }
  jest.restoreAllMocks();
  for (let pass = 0; pass < 3; pass++) await recover(25);
  expect(await db.collection('old_writes').countDocuments()).toBe(0);
  expect(await db.collection('agent_checkpoint_deletions').countDocuments()).toBe(0);
});

test.each(['thread', undefined])(
  'final cleanup discovers a store registered during drain (root=%s)',
  async (root) => {
    const deletion = await openCheckpointDeletion('owner', undefined, root, { type: 'memory' });
    await deletion.remember(['thread']);
    await seed({
      configurable: { thread_id: 'thread', checkpoint_ns: createCheckpointNamespace('owner') },
    });
    await deletion.cleanup();
    await deletion.acknowledge();
    const db = mongoose.connection.db!;
    expect(await db.collection('old_cp').countDocuments()).toBe(0);
    expect(await db.collection('old_writes').countDocuments()).toBe(0);
    expect(await db.collection(CHECKPOINT_STORAGE_COLLECTION).countDocuments()).toBe(
      root == null ? 0 : 1,
    );
  },
);

test('each post-drain topology capture refreshes the catalog before conversation removal', async () => {
  const deletion = await openCheckpointDeletion('owner', undefined, 'thread', { type: 'memory' });
  await deletion.remember(['thread']);
  await seed({
    configurable: { thread_id: 'thread', checkpoint_ns: createCheckpointNamespace('owner') },
  });
  await deletion.remember(['thread']);
  const db = mongoose.connection.db!;
  expect(
    await db.collection('agent_checkpoint_deletions').countDocuments({
      checkpoint: { $exists: true },
      'storage.checkpointCollectionName': 'old_cp',
    }),
  ).toBe(1);
});

test.each([false, true])(
  'owner-wide cleanup journals orphan payload before deletion fails (actor=%s)',
  async (actor) => {
    await seed({
      configurable: {
        thread_id: 'orphan',
        checkpoint_ns: actor ? 'event-actor/orphan' : createCheckpointNamespace('owner', 'tenant'),
        ...(actor
          ? { [LIBRECHAT_CHECKPOINT_OWNER_KEY]: checkpointOwnerNamespacePrefix('owner', 'tenant') }
          : {}),
      },
    });
    const deletion = await openCheckpointDeletion('owner', 'tenant', undefined, { type: 'memory' });
    const originalDelete = mongoose.mongo.Collection.prototype.deleteMany;
    jest.spyOn(mongoose.mongo.Collection.prototype, 'deleteMany').mockImplementation(function (
      this: Collection,
      ...args
    ) {
      if (this.collectionName === 'old_cp') return Promise.reject(new Error('payload unavailable'));
      return originalDelete.apply(this, args);
    });
    await expect(deletion.cleanup()).rejects.toThrow('payload unavailable');
    const db = mongoose.connection.db!;
    expect(
      await db
        .collection('agent_checkpoint_deletions')
        .countDocuments({ checkpoint: { $exists: true }, threadId: 'orphan' }),
    ).toBe(1);
    expect(await db.collection(CHECKPOINT_STORAGE_COLLECTION).countDocuments()).toBe(1);
    jest.restoreAllMocks();
    const recover = createCheckpointDeletionReclaimer(async () => []);
    for (let pass = 0; pass < 3; pass++) await recover(25);
    expect(await db.collection('old_cp').countDocuments()).toBe(0);
    expect(await db.collection('old_writes').countDocuments()).toBe(0);
    expect(await db.collection('agent_checkpoint_deletions').countDocuments()).toBe(0);
    expect(await db.collection(CHECKPOINT_STORAGE_COLLECTION).countDocuments()).toBe(1);
  },
);

test('owner-wide acknowledgement retires only its stores and later writes register again', async () => {
  for (const [user, tenant] of [
    ['owner', 'tenant'],
    ['owner', undefined],
    ['owner', 'other-tenant'],
    ['foreign', 'tenant'],
  ]) {
    await seed({
      configurable: {
        thread_id: 'thread',
        checkpoint_ns: createCheckpointNamespace(user!, tenant),
      },
    });
  }
  const deletion = await openCheckpointDeletion('owner', 'tenant', undefined, { type: 'memory' });
  await deletion.cleanup();
  const db = mongoose.connection.db!;
  expect(await db.collection(CHECKPOINT_STORAGE_COLLECTION).countDocuments()).toBe(4);
  await deletion.acknowledge();
  expect(await db.collection(CHECKPOINT_STORAGE_COLLECTION).countDocuments()).toBe(2);
  expect(await db.collection('old_cp').countDocuments()).toBe(2);
  await seed({
    configurable: {
      thread_id: 'new-thread',
      checkpoint_ns: createCheckpointNamespace('owner', 'tenant'),
    },
  });
  expect(await db.collection(CHECKPOINT_STORAGE_COLLECTION).countDocuments()).toBe(3);
  expect(await db.collection('old_cp').countDocuments()).toBe(3);
});

test('failed or renewed journal acknowledgement preserves catalog discovery', async () => {
  await seed({
    configurable: { thread_id: 'thread', checkpoint_ns: createCheckpointNamespace('owner') },
  });
  const first = await openCheckpointDeletion('owner', undefined, undefined, cfg);
  await first.remember(['thread']);
  await first.cleanup();
  const db = mongoose.connection.db!;
  const originalDelete = mongoose.mongo.Collection.prototype.deleteMany;
  jest.spyOn(mongoose.mongo.Collection.prototype, 'deleteMany').mockImplementation(function (
    this: Collection,
    ...args
  ) {
    if (this.collectionName === 'agent_checkpoint_deletions')
      return Promise.reject(new Error('journal unavailable'));
    return originalDelete.apply(this, args);
  });
  await expect(first.acknowledge()).rejects.toThrow('journal unavailable');
  expect(await db.collection(CHECKPOINT_STORAGE_COLLECTION).countDocuments()).toBe(1);
  jest.restoreAllMocks();
  const renewed = await openCheckpointDeletion('owner', undefined, undefined, cfg);
  await renewed.remember(['thread']);
  await expect(first.acknowledge()).rejects.toThrow('intent is still pending');
  expect(await db.collection(CHECKPOINT_STORAGE_COLLECTION).countDocuments()).toBe(1);
  await renewed.cleanup();
  await renewed.acknowledge();
  expect(await db.collection(CHECKPOINT_STORAGE_COLLECTION).countDocuments()).toBe(0);
});

test('catalog retirement can be retried after the journal has already been acknowledged', async () => {
  await seed({
    configurable: { thread_id: 'thread', checkpoint_ns: createCheckpointNamespace('owner') },
  });
  const deletion = await openCheckpointDeletion('owner', undefined, undefined, cfg);
  await deletion.cleanup();
  const originalDelete = mongoose.mongo.Collection.prototype.deleteMany;
  jest.spyOn(mongoose.mongo.Collection.prototype, 'deleteMany').mockImplementation(function (
    this: Collection,
    ...args
  ) {
    if (this.collectionName === CHECKPOINT_STORAGE_COLLECTION)
      return Promise.reject(new Error('catalog unavailable'));
    return originalDelete.apply(this, args);
  });
  await expect(deletion.acknowledge()).rejects.toThrow('catalog unavailable');
  const db = mongoose.connection.db!;
  expect(await db.collection('agent_checkpoint_deletions').countDocuments()).toBe(0);
  expect(await db.collection(CHECKPOINT_STORAGE_COLLECTION).countDocuments()).toBe(1);
  jest.restoreAllMocks();
  const retry = await openCheckpointDeletion('owner', undefined, undefined, { type: 'memory' });
  await retry.cleanup();
  await retry.acknowledge();
  expect(await db.collection(CHECKPOINT_STORAGE_COLLECTION).countDocuments()).toBe(0);
});
