/** Real Mongo/LangGraph conformance. Fresh saver instances are not an OS-process-loss claim. */
import mongoose from 'mongoose';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { emptyCheckpoint, ERROR } from '@langchain/langgraph-checkpoint';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { CheckpointTuple } from '@langchain/langgraph-checkpoint';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { DurableAgentCheckpointScope } from './durable';
import {
  getDurableAgentCheckpointer,
  LIBRECHAT_CHECKPOINT_NAMESPACE_KEY,
  LIBRECHAT_CHECKPOINT_OWNER_KEY,
  LIBRECHAT_LEGACY_CHECKPOINT_KEY,
  __resetCheckpointerForTests,
} from '../checkpointer';
import {
  checkpointStorageConfigs,
  inspectInitialCheckpointPopulation,
  LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY,
} from './storage';
import {
  checkpointOwnerNamespacePrefix,
  createCheckpointNamespace,
} from '../../stream/checkpoints';
import { checkpointTestEnvironment } from './__tests__/helpers/mongo';
import { resolveCheckpointerConfig } from './config';
import { openCheckpointDeletion } from './deletion';
import { DurableMongoSaver } from './durable';

const cfg = {
  type: 'mongo' as const,
  ttl: 3600,
  checkpointCollectionName: 'durable_checkpoints',
  checkpointWritesCollectionName: 'durable_writes',
};
const metadata = { source: 'input' as const, step: -1, parents: {} };
const scope = (userId = 'owner', tenantId = 'tenant'): DurableAgentCheckpointScope => ({
  userId,
  tenantId,
  threadId: 'shared-thread',
  checkpointNamespace: createCheckpointNamespace(userId, tenantId),
});
const config = (target: DurableAgentCheckpointScope, checkpoint_ns = ''): RunnableConfig => ({
  configurable: { thread_id: target.threadId, checkpoint_ns },
});
const State = Annotation.Root({
  events: Annotation<string[]>({
    reducer: (left, right) => [...left, ...right],
    default: () => [],
  }),
});
async function collect(rows: AsyncIterable<CheckpointTuple>): Promise<CheckpointTuple[]> {
  const result: CheckpointTuple[] = [];
  for await (const row of rows) result.push(row);
  return result;
}

let mongo: MongoMemoryServer | undefined;
let scratch: string | undefined;
beforeAll(async () => {
  const environment = checkpointTestEnvironment();
  scratch = await mkdtemp(join(environment.scratchRoot, 'durable-checkpoints-'));
  const dbPath = join(scratch, 'mongo');
  await mkdir(dbPath, { mode: 0o700 });
  mongo = await MongoMemoryServer.create({
    binary: environment.binary,
    instance: { dbPath, args: ['--nounixsocket'], storageEngine: 'wiredTiger' },
  });
  await mongoose.connect(mongo.getUri('driver_default'), { dbName: 'durable_test' });
}, 60_000);
afterEach(async () => {
  jest.restoreAllMocks();
  __resetCheckpointerForTests();
  if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
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

it('persists A before B starts and resumes after failure using a fresh saver and real parent chain', async () => {
  const target = scope();
  const runConfig = { ...config(target), durability: 'sync' as const };
  let aCalls = 0;
  let bCalls = 0;
  let fail = true;
  const build = (saver: DurableMongoSaver) =>
    new StateGraph(State)
      .addNode('a', () => {
        aCalls++;
        return { events: ['A'] };
      })
      .addNode('b', async () => {
        bCalls++;
        expect((await saver.getTuple(config(target)))?.checkpoint.channel_values.events).toEqual([
          'A',
        ]);
        if (fail) throw new Error('Synthetic B failure');
        return { events: ['B'] };
      })
      .addEdge(START, 'a')
      .addEdge('a', 'b')
      .addEdge('b', END)
      .compile({ checkpointer: saver });
  const first = await getDurableAgentCheckpointer(target, cfg);
  await expect(build(first).invoke({ events: [] }, runConfig)).rejects.toThrow(
    'Synthetic B failure',
  );
  const failed = await first.getTuple(config(target));
  expect(failed?.pendingWrites?.some(([, channel]) => channel === ERROR)).toBe(true);
  const history = await collect(first.list(config(target)));
  expect(history.length).toBeGreaterThanOrEqual(3);
  expect(failed?.parentConfig).toBeDefined();
  expect(failed!.parentConfig!.configurable).not.toHaveProperty(LIBRECHAT_LEGACY_CHECKPOINT_KEY);
  const parent = await first.getTuple(failed!.parentConfig!);
  expect(parent?.checkpoint.id).toBe(failed!.parentConfig!.configurable!.checkpoint_id);
  expect(await collect(first.list(config(target), { before: failed!.config }))).toEqual(
    history.slice(1),
  );
  const fresh = await getDurableAgentCheckpointer({ ...target }, cfg);
  expect(fresh).not.toBe(first);
  fail = false;
  expect(await build(fresh).invoke(null, runConfig)).toMatchObject({ events: ['A', 'B'] });
  expect(aCalls).toBe(1);
  expect(bCalls).toBe(2);
  expect((await fresh.getTuple(config(target)))?.checkpoint.channel_values.events).toEqual([
    'A',
    'B',
  ]);
});

it('reuses a successful pending sibling after another sibling fails and the saver is replaced', async () => {
  const target = scope();
  let aCalls = 0;
  let bCalls = 0;
  let fail = true;
  const build = (saver: DurableMongoSaver) =>
    new StateGraph(State)
      .addNode('a', () => {
        aCalls++;
        return { events: ['A'] };
      })
      .addNode('b', () => {
        bCalls++;
        if (fail) throw new Error('Synthetic sibling failure');
        return { events: ['B'] };
      })
      .addEdge(START, 'a')
      .addEdge(START, 'b')
      .addEdge('a', END)
      .addEdge('b', END)
      .compile({ checkpointer: saver });
  const first = await getDurableAgentCheckpointer(target, cfg);
  const runConfig = { ...config(target), durability: 'sync' as const };
  await expect(build(first).invoke({ events: [] }, runConfig)).rejects.toThrow(
    'Synthetic sibling failure',
  );
  const interrupted = await first.getTuple(config(target));
  expect(interrupted?.pendingWrites).toEqual(
    expect.arrayContaining([expect.arrayContaining(['events', ['A']])]),
  );
  const fresh = await getDurableAgentCheckpointer(target, cfg);
  expect(fresh).not.toBe(first);
  fail = false;
  const resumed = await build(fresh).invoke(null, runConfig);
  expect(resumed.events.slice().sort()).toEqual(['A', 'B']);
  expect(aCalls).toBe(1);
  expect(bCalls).toBe(2);
});

it('preserves legitimate subgraph namespaces while isolating another owner, tenant and generation', async () => {
  const target = scope();
  const saver = await getDurableAgentCheckpointer(target, cfg);
  const child = new StateGraph(State)
    .addNode('child_step', () => ({ events: ['child'] }))
    .addEdge(START, 'child_step')
    .addEdge('child_step', END)
    .compile();
  const graph = new StateGraph(State)
    .addNode('nested', child)
    .addEdge(START, 'nested')
    .addEdge('nested', END)
    .compile({ checkpointer: saver });
  expect(
    await graph.invoke({ events: [] }, { ...config(target), durability: 'sync' }),
  ).toMatchObject({ events: ['child'] });
  const rows = await mongoose.connection
    .db!.collection(cfg.checkpointCollectionName)
    .find()
    .toArray();
  expect(rows.some((row) => row.checkpoint_ns.includes(`${target.checkpointNamespace}|`))).toBe(
    true,
  );
  for (const foreign of [scope('other'), scope('owner', 'other-tenant'), scope()]) {
    const isolated = await getDurableAgentCheckpointer(foreign, cfg);
    expect(await isolated.getTuple(config(foreign))).toBeUndefined();
    expect(await collect(isolated.list(config(foreign)))).toEqual([]);
    await isolated.put(config(foreign), emptyCheckpoint(), metadata);
  }
  expect((await saver.getTuple(config(target)))?.checkpoint.channel_values.events).toEqual([
    'child',
  ]);
});

it.each([
  ['thread_id', 'foreign-thread'],
  [LIBRECHAT_CHECKPOINT_OWNER_KEY, checkpointOwnerNamespacePrefix('foreign', 'tenant')],
  [LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY, checkpointOwnerNamespacePrefix('foreign', 'tenant')],
  [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY, createCheckpointNamespace('owner', 'tenant')],
  [LIBRECHAT_LEGACY_CHECKPOINT_KEY, 'legacy-id'],
])('rejects conflicting %s in every operation and in a list boundary', async (key, value) => {
  const target = scope();
  const saver = await getDurableAgentCheckpointer(target, cfg);
  const valid = await saver.put(config(target), emptyCheckpoint(), metadata);
  const invalid = { configurable: { ...valid.configurable, [key]: value } };
  await expect(saver.getTuple(invalid)).rejects.toThrow();
  await expect(saver.put(invalid, emptyCheckpoint(), metadata)).rejects.toThrow();
  await expect(saver.putWrites(invalid, [['events', ['forged']]], 'forged-task')).rejects.toThrow();
  await expect(collect(saver.list(invalid))).rejects.toThrow();
  await expect(collect(saver.list(config(target), { before: invalid }))).rejects.toThrow();
  expect(
    await mongoose.connection.db!.collection(cfg.checkpointCollectionName).countDocuments(),
  ).toBe(1);
  expect(
    await mongoose.connection.db!.collection(cfg.checkpointWritesCollectionName).countDocuments(),
  ).toBe(0);
});

it('captures the scope before awaits, refuses malformed owners and closes unrestricted deleteThread', async () => {
  const input = scope();
  const target = { ...input };
  const pending = getDurableAgentCheckpointer(input, cfg);
  input.userId = 'foreign';
  input.threadId = 'foreign';
  input.checkpointNamespace = createCheckpointNamespace('foreign', 'tenant');
  const saver = await pending;
  await saver.put(config(target), emptyCheckpoint(), metadata);
  await expect(saver.getTuple(config(input))).rejects.toThrow();
  await expect(saver.deleteThread(target.threadId)).rejects.toThrow();
  expect(await saver.getTuple(config(target))).toBeDefined();
  for (const invalid of [
    { ...target, userId: '' },
    { ...target, threadId: '' },
    { ...target, tenantId: 'foreign' },
    { ...target, checkpointNamespace: '' },
    { ...target, checkpointNamespace: createCheckpointNamespace('foreign', 'tenant') },
  ])
    await expect(getDurableAgentCheckpointer(invalid, cfg)).rejects.toThrow();
});

it('fails closed for memory configuration, unavailable Mongo and a real required-index conflict', async () => {
  await expect(getDurableAgentCheckpointer(scope(), { type: 'memory' })).rejects.toThrow();
  await mongoose.disconnect();
  try {
    await expect(getDurableAgentCheckpointer(scope(), cfg)).rejects.toThrow();
  } finally {
    await mongoose.connect(mongo!.getUri('driver_default'), { dbName: 'durable_test' });
  }
  await mongoose.connection
    .db!.collection(cfg.checkpointCollectionName)
    .createIndex({ upserted_at: 1 }, { expireAfterSeconds: 1 });
  await expect(getDurableAgentCheckpointer(scope(), cfg)).rejects.toThrow();
  expect(
    await mongoose.connection.db!.collection(cfg.checkpointCollectionName).countDocuments(),
  ).toBe(0);
});

it('uses the selected DB, real TTL indexes and native storage inventory/deletion across collection changes', async () => {
  const target = scope();
  const foreign = scope('other');
  const saver = await getDurableAgentCheckpointer(target, cfg);
  const other = await getDurableAgentCheckpointer(foreign, cfg);
  const first = await saver.put(config(target), emptyCheckpoint(), metadata);
  await saver.putWrites(first, [['events', ['retained']]], 'task');
  await other.put(config(foreign), emptyCheckpoint(), metadata);
  const db = mongoose.connection.db!;
  expect(
    await mongoose.connection
      .getClient()
      .db('driver_default')
      .collection(cfg.checkpointCollectionName)
      .countDocuments(),
  ).toBe(0);
  for (const name of [cfg.checkpointCollectionName, cfg.checkpointWritesCollectionName]) {
    const indexes = await db.collection(name).indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: { upserted_at: 1 }, expireAfterSeconds: cfg.ttl }),
      ]),
    );
    expect((await db.collection(name).findOne())!.upserted_at).toBeInstanceOf(Date);
  }
  expect(
    await checkpointStorageConfigs(target.userId, target.tenantId, { type: 'memory' }),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        checkpointCollectionName: cfg.checkpointCollectionName,
        checkpointWritesCollectionName: cfg.checkpointWritesCollectionName,
      }),
    ]),
  );
  const census = () =>
    inspectInitialCheckpointPopulation({
      originalDeadline: new Date(Date.now() + 5000).toISOString(),
      targetBindingSha256: 'a'.repeat(64),
      currentConfig: resolveCheckpointerConfig(cfg),
    });
  expect(await census()).toMatchObject({ complete: false, saturatedCounts: { recoveryCopies: 1 } });
  const deletion = await openCheckpointDeletion(target.userId, target.tenantId, target.threadId, {
    type: 'memory',
  });
  await deletion.remember([target.threadId]);
  await deletion.cleanup();
  await deletion.acknowledge();
  expect(await saver.getTuple(config(target))).toBeUndefined();
  expect(await other.getTuple(config(foreign))).toBeDefined();
  expect(await db.collection(cfg.checkpointWritesCollectionName).countDocuments()).toBe(0);
  const otherDeletion = await openCheckpointDeletion(
    foreign.userId,
    foreign.tenantId,
    foreign.threadId,
    cfg,
  );
  await otherDeletion.remember([foreign.threadId]);
  await otherDeletion.cleanup();
  await otherDeletion.acknowledge();
  expect(await census()).toMatchObject({ complete: true, saturatedCounts: { recoveryCopies: 0 } });
});

it('enforces the serialized checkpoint and pending-write size boundary before Mongo payload writes', async () => {
  const target = scope();
  await getDurableAgentCheckpointer(target, cfg);
  const saver = new DurableMongoSaver({
    client: mongoose.connection.getClient() as unknown as ConstructorParameters<
      typeof DurableMongoSaver
    >[0]['client'],
    dbName: mongoose.connection.db!.databaseName,
    checkpointCollectionName: cfg.checkpointCollectionName,
    checkpointWritesCollectionName: cfg.checkpointWritesCollectionName,
    scope: target,
    hardLimitBytes: 1024,
    warnBytes: 512,
  });
  const checkpoint = emptyCheckpoint();
  checkpoint.channel_values = { oversized: 'x'.repeat(4096) };
  await expect(saver.put(config(target), checkpoint, metadata)).rejects.toThrow();
  await expect(
    saver.putWrites(
      { configurable: { ...config(target).configurable, checkpoint_id: checkpoint.id } },
      [['events', 'x'.repeat(4096)]],
      'large-task',
    ),
  ).rejects.toThrow();
  expect(
    await mongoose.connection.db!.collection(cfg.checkpointCollectionName).countDocuments(),
  ).toBe(0);
  expect(
    await mongoose.connection.db!.collection(cfg.checkpointWritesCollectionName).countDocuments(),
  ).toBe(0);
});
