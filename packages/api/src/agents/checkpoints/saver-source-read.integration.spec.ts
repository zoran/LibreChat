/** Real Mongo raw-read boundary; source markers are synthetic rejection fixtures, never approvals. */
import mongoose from 'mongoose';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import { MongoDBSaver } from '@langchain/langgraph-checkpoint-mongodb';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { CheckpointTuple, CheckpointListOptions } from '@langchain/langgraph-checkpoint';
import { checkpointTestEnvironment } from './__tests__/helpers/mongo';
import {
  OwnedMongoSaver,
  LIBRECHAT_CHECKPOINT_OWNER_KEY,
  LIBRECHAT_LEGACY_CHECKPOINT_KEY,
} from './saver';

const owner = `lcg:v2:${'a'.repeat(64)}:`;
const metadata = { source: 'input' as const, step: -1, parents: {} };
const base: RunnableConfig = { configurable: { thread_id: 'synthetic-thread', checkpoint_ns: '' } };
const owned: RunnableConfig = {
  configurable: { ...base.configurable, [LIBRECHAT_CHECKPOINT_OWNER_KEY]: owner },
};
const collections = {
  checkpointCollectionName: 'source_read_checkpoints',
  checkpointWritesCollectionName: 'source_read_writes',
};
let mongo: MongoMemoryServer | undefined;
let scratch: string | undefined;
let saver: OwnedMongoSaver;

async function collect(rows: AsyncIterable<CheckpointTuple>): Promise<CheckpointTuple[]> {
  const result: CheckpointTuple[] = [];
  for await (const row of rows) result.push(row);
  return result;
}

beforeAll(async () => {
  const environment = checkpointTestEnvironment();
  scratch = await mkdtemp(join(environment.scratchRoot, 'checkpoint-source-read-'));
  await mkdir(join(scratch, 'mongo'), { mode: 0o700 });
  mongo = await MongoMemoryServer.create({
    binary: environment.binary,
    instance: {
      dbPath: join(scratch, 'mongo'),
      args: ['--nounixsocket'],
      storageEngine: 'wiredTiger',
    },
  });
  await mongoose.connect(mongo.getUri('checkpoint_source_read'));
}, 60000);
beforeEach(() => {
  saver = new OwnedMongoSaver({
    ...collections,
    dbName: mongoose.connection.db!.databaseName,
    client: mongoose.connection.getClient() as unknown as ConstructorParameters<
      typeof OwnedMongoSaver
    >[0]['client'],
  });
});
afterEach(async () => {
  jest.restoreAllMocks();
  await mongoose.connection.dropDatabase();
});
afterAll(async () => {
  try {
    await mongoose.disconnect();
  } finally {
    try {
      await mongo?.stop();
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  }
});

it('rejects source metadata on the checkpoint before decoding even a source-free pending write', async () => {
  const config = await saver.put(owned, emptyCheckpoint(), metadata);
  await saver.putWrites(config, [['events', ['synthetic pending']]], 'task');
  await mongoose.connection
    .db!.collection(collections.checkpointCollectionName)
    .updateOne(
      { checkpoint_id: config.configurable!.checkpoint_id },
      { $set: { lc_source_binding: null } },
    );
  const loads = jest.spyOn(saver.serde, 'loadsTyped');
  let rejected = false;
  try {
    await saver.getTuple(config);
  } catch {
    rejected = true;
  }
  expect(loads).not.toHaveBeenCalled();
  expect(rejected).toBe(true);
});

const modes = [
  'owned-get',
  'owned-list',
  'legacy-get',
  'unowned-get',
  'unowned-list',
  'unscoped-list',
] as const;
const markers = [
  'lc_source_binding',
  'lc_source_file_ids',
  'lc_source_expires_at',
  'lc_retained_allocations',
];
const cases = modes.flatMap((mode) =>
  markers.flatMap((marker) =>
    ['checkpoint', 'pending'].flatMap((location) =>
      [null, 'malformed'].map((value) => ({ mode, marker, location, value })),
    ),
  ),
);

it.each(cases)(
  'rejects $mode $location $marker=$value before any decode',
  async ({ mode, marker, location, value }) => {
    const input = mode.startsWith('owned') ? owned : base;
    let config = await saver.put(input, emptyCheckpoint(), metadata);
    await saver.putWrites(config, [['events', ['synthetic pending']]], 'task');
    if (mode === 'legacy-get')
      config = {
        configurable: {
          ...config.configurable,
          [LIBRECHAT_CHECKPOINT_OWNER_KEY]: owner,
          [LIBRECHAT_LEGACY_CHECKPOINT_KEY]: config.configurable!.checkpoint_id,
        },
      };
    const collection =
      location === 'checkpoint'
        ? collections.checkpointCollectionName
        : collections.checkpointWritesCollectionName;
    await mongoose.connection
      .db!.collection(collection)
      .updateOne(
        { checkpoint_id: config.configurable!.checkpoint_id },
        { $set: { [marker]: value } },
      );
    const loads = jest.spyOn(saver.serde, 'loadsTyped');
    const read = mode.endsWith('get')
      ? saver.getTuple(config)
      : collect(saver.list(mode === 'unscoped-list' ? {} : config));
    await expect(read).rejects.toThrow(
      'Source-bound checkpoint reads require source authorization',
    );
    expect(loads).not.toHaveBeenCalled();
  },
);

it('checks a losing legacy pending slot before preferring the owned duplicate', async () => {
  const legacy = await saver.put(base, emptyCheckpoint(), metadata);
  await saver.putWrites(legacy, [['events', ['legacy pending']]], 'same-task');
  const config: RunnableConfig = {
    configurable: {
      ...legacy.configurable,
      [LIBRECHAT_CHECKPOINT_OWNER_KEY]: owner,
      [LIBRECHAT_LEGACY_CHECKPOINT_KEY]: legacy.configurable!.checkpoint_id,
    },
  };
  const ownedWrite = { configurable: { ...config.configurable } };
  delete ownedWrite.configurable[LIBRECHAT_LEGACY_CHECKPOINT_KEY];
  await saver.putWrites(ownedWrite, [['events', ['owned pending']]], 'same-task');
  expect(
    await mongoose.connection
      .db!.collection(collections.checkpointWritesCollectionName)
      .countDocuments({}),
  ).toBe(2);
  await mongoose.connection
    .db!.collection(collections.checkpointWritesCollectionName)
    .updateOne({ lc_owner: { $exists: false } }, { $set: { lc_retained_allocations: [] } });
  const loads = jest.spyOn(saver.serde, 'loadsTyped');
  await expect(saver.getTuple(config)).rejects.toThrow('Source-bound checkpoint');
  expect(loads).not.toHaveBeenCalled();
});

it('treats an explicitly stored undefined marker as presence after BSON normalization', async () => {
  const config = await saver.put(base, emptyCheckpoint(), metadata);
  await mongoose.connection
    .db!.collection(collections.checkpointCollectionName)
    .updateOne(
      { checkpoint_id: config.configurable!.checkpoint_id },
      { $set: { lc_source_binding: undefined } },
    );
  const row = await mongoose.connection
    .db!.collection(collections.checkpointCollectionName)
    .findOne({});
  expect(Object.prototype.hasOwnProperty.call(row, 'lc_source_binding')).toBe(true);
  const loads = jest.spyOn(saver.serde, 'loadsTyped');
  await expect(saver.getTuple(config)).rejects.toThrow('Source-bound checkpoint');
  expect(loads).not.toHaveBeenCalled();
});

it('preserves explicit legacy get fallback and owned slot preference without opening list fallback', async () => {
  const legacy = await saver.put(base, emptyCheckpoint(), metadata);
  await saver.putWrites(legacy, [['events', ['legacy pending']]], 'same-task');
  const config: RunnableConfig = {
    configurable: {
      ...legacy.configurable,
      [LIBRECHAT_CHECKPOINT_OWNER_KEY]: owner,
      [LIBRECHAT_LEGACY_CHECKPOINT_KEY]: legacy.configurable!.checkpoint_id,
    },
  };
  const ownedWrite = { configurable: { ...config.configurable } };
  delete ownedWrite.configurable[LIBRECHAT_LEGACY_CHECKPOINT_KEY];
  await saver.putWrites(ownedWrite, [['events', ['owned pending']]], 'same-task');
  expect(
    await mongoose.connection
      .db!.collection(collections.checkpointWritesCollectionName)
      .countDocuments({}),
  ).toBe(2);
  expect((await saver.getTuple(config))?.pendingWrites).toEqual([
    ['same-task', 'events', ['owned pending']],
  ]);
  expect(await collect(saver.list(config))).toEqual([]);
  await mongoose.connection
    .db!.collection(collections.checkpointCollectionName)
    .updateOne(
      { checkpoint_id: config.configurable!.checkpoint_id },
      { $set: { lc_source_binding: null } },
    );
  const loads = jest.spyOn(saver.serde, 'loadsTyped');
  expect(await collect(saver.list(config))).toEqual([]);
  expect(loads).not.toHaveBeenCalled();
});

function nativeSaver(): MongoDBSaver {
  return new MongoDBSaver({
    ...collections,
    dbName: mongoose.connection.db!.databaseName,
    client: mongoose.connection.getClient() as unknown as ConstructorParameters<
      typeof MongoDBSaver
    >[0]['client'],
  });
}

it('matches installed native get/list/filter/before/limit/parent/pending semantics for source-free data', async () => {
  const first = await saver.put(base, { ...emptyCheckpoint(), id: '001' }, metadata);
  const second = await saver.put(
    first,
    { ...emptyCheckpoint(), id: '002' },
    { ...metadata, step: 0 },
  );
  await saver.putWrites(second, [['events', { answer: 42 }]], 'task');
  await saver.put(
    { configurable: { ...base.configurable, checkpoint_ns: 'child' } },
    { ...emptyCheckpoint(), id: '003' },
    metadata,
  );
  await saver.put(
    { configurable: { thread_id: 'another-thread', checkpoint_ns: '' } },
    { ...emptyCheckpoint(), id: '004' },
    metadata,
  );
  const native = nativeSaver();
  for (const config of [
    {},
    base,
    first,
    second,
    { configurable: { thread_id: 'synthetic-thread', checkpoint_id: '' } },
    { configurable: { thread_id: 'synthetic-thread', checkpoint_ns: 'child' } },
  ]) {
    expect(await saver.getTuple(config)).toEqual(await native.getTuple(config));
  }
  const listing: Array<[RunnableConfig, CheckpointListOptions | undefined]> = [
    [{}, undefined],
    [{ configurable: { thread_id: '' } }, undefined],
    [{ configurable: { checkpoint_ns: '' } }, undefined],
    [{ configurable: { thread_id: 'synthetic-thread' } }, undefined],
    [base, { before: second, limit: 1 }],
    [{}, { filter: { step: -1 }, limit: 2 }],
    [{}, { limit: 0 }],
    [{}, { filter: { source: 'input', missing: null } }],
  ];
  for (const [config, options] of listing)
    expect(await collect(saver.list(config, options))).toEqual(
      await collect(native.list(config, options)),
    );
});

it('preserves the native empty parent distinction and retains unowned duplicate pending slots', async () => {
  const config = await saver.put(
    { configurable: { ...base.configurable, checkpoint_id: '' } },
    emptyCheckpoint(),
    metadata,
  );
  await saver.putWrites(config, [['events', 'first']], 'task');
  const collection = mongoose.connection.db!.collection(collections.checkpointWritesCollectionName);
  const row = await collection.findOne({});
  const { _id, ...duplicate } = row!;
  await collection.insertOne(duplicate);
  const native = nativeSaver();
  expect(await saver.getTuple(config)).toEqual(await native.getTuple(config));
  expect((await saver.getTuple(config))?.pendingWrites).toHaveLength(2);
  expect(await collect(saver.list(config))).toEqual(await collect(native.list(config)));
});

it('keeps unrelated pending rows outside the selected raw tuple and skips decoding when get has no thread', async () => {
  const config = await saver.put(base, emptyCheckpoint(), metadata);
  await mongoose.connection.db!.collection(collections.checkpointWritesCollectionName).insertOne({
    thread_id: 'different-thread',
    checkpoint_ns: '',
    checkpoint_id: config.configurable!.checkpoint_id,
    lc_source_binding: null,
  });
  expect((await saver.getTuple(config))?.pendingWrites).toEqual([]);
  const loads = jest.spyOn(saver.serde, 'loadsTyped');
  expect(await saver.getTuple({ configurable: { checkpoint_ns: null } })).toBeUndefined();
  expect(loads).not.toHaveBeenCalled();
});

it.each([
  { configurable: { thread_id: null } },
  { configurable: { thread_id: 'synthetic-thread', checkpoint_ns: null } },
  { configurable: { thread_id: 'synthetic-thread', checkpoint_id: 3 } },
])('preserves native invalid get identity rejection: %j', async (config) => {
  await expect(saver.getTuple(config)).rejects.toThrow();
  await expect(nativeSaver().getTuple(config)).rejects.toThrow();
});

it.each([
  { filter: { value: { nested: true } } },
  { before: { configurable: { checkpoint_id: null } } },
  { before: { configurable: { checkpoint_id: 3 } } },
])('preserves native invalid listing rejection: %j', async (options) => {
  await expect(collect(saver.list({}, options))).rejects.toThrow();
  await expect(collect(nativeSaver().list({}, options))).rejects.toThrow();
});
