import mongoose from 'mongoose';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { emptyCheckpoint, ERROR } from '@langchain/langgraph-checkpoint';
import { createGenerationAdmissionMethods } from '@librechat/data-schemas';
import type { GenerationAdmissionInput } from '@librechat/data-schemas';
import { checkpointTestEnvironment } from './__tests__/helpers/mongo';
import { createCheckpointNamespace } from '../../stream/checkpoints';
import { CHECKPOINT_STORAGE_COLLECTION } from './storage';
import { DurableMongoSaver } from './durable';

const scope = {
  userId: 'owner',
  tenantId: 'tenant',
  threadId: 'thread',
  checkpointNamespace: createCheckpointNamespace('owner', 'tenant'),
};
const input: GenerationAdmissionInput = {
  tenantId: 'tenant',
  principalId: 'owner',
  clientRequestId: 'request',
  conversationId: 'thread',
  requestFingerprint: 'a'.repeat(64),
  protocol: '1',
  ownerInstanceId: 'pod-a',
  processBootId: 'incarnation-a',
  generationEpoch: 1,
  segmentId: 'segment-a',
  continuation: {
    version: 1,
    runId: 'run',
    threadId: scope.threadId,
    checkpointNamespace: scope.checkpointNamespace,
    graphFingerprint: 'b'.repeat(64),
    policyFingerprint: 'c'.repeat(64),
    mode: 'checkpoint-only-v1',
  },
};
const config = { configurable: { thread_id: scope.threadId, checkpoint_ns: '' } };
const metadata = { source: 'input' as const, step: -1, parents: {} };
let mongo: MongoMemoryReplSet | undefined;
let scratch: string;
let methods: ReturnType<typeof createGenerationAdmissionMethods>;

function saver(admission: GenerationAdmissionInput = input): DurableMongoSaver {
  return new DurableMongoSaver({
    scope,
    admission,
    client: mongoose.connection.getClient() as unknown as ConstructorParameters<
      typeof DurableMongoSaver
    >[0]['client'],
    dbName: mongoose.connection.db!.databaseName,
    checkpointCollectionName: 'fenced_checkpoints',
    checkpointWritesCollectionName: 'fenced_writes',
  });
}

async function admitted(): Promise<void> {
  const acquired = await methods.acquireGenerationAdmission(input);
  expect(acquired.ok && acquired.value.acquired).toBe(true);
  expect((await methods.dispatchGenerationAdmission(input)).ok).toBe(true);
}

async function record() {
  const result = await methods.getGenerationAdmission(input);
  if (!result.ok || !result.value) throw new Error('Missing fixture admission');
  return result.value;
}

async function recover() {
  const current = await record();
  const result = await methods.recoverGenerationAdmission(
    input,
    {
      checkpointWriteRevision: current.checkpointWriteRevision!,
      terminationEvidenceSha256: 'd'.repeat(64),
      effectsEvidenceSha256: 'e'.repeat(64),
    },
    { ownerInstanceId: 'pod-b', processBootId: 'incarnation-b', segmentId: 'segment-b' },
  );
  if (!result.ok) throw new Error('Fixture recovery CAS did not win');
  return result.value;
}

beforeAll(async () => {
  const environment = checkpointTestEnvironment();
  scratch = await mkdtemp(join(environment.scratchRoot, 'checkpoint-fence-'));
  await mkdir(join(scratch, 'mongo'));
  mongo = await MongoMemoryReplSet.create({
    binary: environment.binary,
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' },
    instanceOpts: [{ dbPath: join(scratch, 'mongo'), args: ['--nounixsocket'] }],
  });
  await mongoose.connect(mongo.getUri(), { dbName: 'fenced_saver', retryWrites: false });
}, 60_000);

beforeEach(async () => {
  methods = createGenerationAdmissionMethods(mongoose);
  await methods.ensureGenerationAdmissionIndexes();
});
afterEach(async () => {
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

it('rejects a stale writer before any checkpoint, pending write or storage inventory is created', async () => {
  // An actual durable row already belongs to another incarnation. No method is mocked.
  await mongoose.connection.db!.collection('generationadmissions').insertOne({
    ...input,
    ownerInstanceId: 'pod-b',
    processBootId: 'incarnation-b',
    segmentId: 'segment-b',
    state: 'dispatching',
    active: true,
    createdAt: new Date().toISOString(),
    dispatchedAt: new Date().toISOString(),
    checkpointWriteRevision: 0,
  });
  const stale = saver();
  await expect(stale.put(config, emptyCheckpoint(), metadata)).rejects.toThrow();
  await expect(
    stale.putWrites(
      { configurable: { ...config.configurable, checkpoint_id: 'checkpoint' } },
      [[ERROR, 'stale result']],
      'task',
    ),
  ).rejects.toThrow();
  for (const name of ['fenced_checkpoints', 'fenced_writes', CHECKPOINT_STORAGE_COLLECTION]) {
    expect(await mongoose.connection.db!.collection(name).countDocuments()).toBe(0);
  }
});

it('fences old normal and special writes while preserving the winner, history and native parent chain', async () => {
  await admitted();
  const old = saver();
  const first = emptyCheckpoint();
  const firstConfig = await old.put(config, first, metadata);
  await old.putWrites(firstConfig, [['events', ['A']]], 'task-a');
  await old.putWrites(firstConfig, [[ERROR, 'original failure']], 'task-b');
  expect((await record()).checkpointWriteRevision).toBe(3);
  const nextAdmission = await recover();
  expect(nextAdmission.state).toBe('admitted');
  const before = await old.getTuple(firstConfig);
  await expect(old.put(config, emptyCheckpoint(), metadata)).rejects.toThrow();
  await expect(old.putWrites(firstConfig, [['events', ['late']]], 'task-c')).rejects.toThrow();
  await expect(old.putWrites(firstConfig, [[ERROR, 'overwritten']], 'task-b')).rejects.toThrow();
  expect(await old.getTuple(firstConfig)).toEqual(before);
  expect((await methods.dispatchGenerationAdmission(nextAdmission)).ok).toBe(true);
  const current = saver(nextAdmission);
  const second = emptyCheckpoint();
  await current.put(firstConfig, second, { ...metadata, source: 'loop', step: 0 });
  const after = await current.getTuple(config);
  expect(after?.checkpoint.id).toBe(second.id);
  expect(after?.parentConfig?.configurable?.checkpoint_id).toBe(first.id);
  expect((await current.getTuple(firstConfig))?.pendingWrites).toEqual(before?.pendingWrites);
  expect((await record()).checkpointWriteRevision).toBe(4);
});

it('rechecks ownership after delayed serialization instead of committing an old segment', async () => {
  await admitted();
  const old = saver();
  const checkpoint = emptyCheckpoint();
  const original = old.serde.dumpsTyped.bind(old.serde);
  let release!: () => void;
  let reached!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  old.serde.dumpsTyped = async (value) => {
    if (value && typeof value === 'object' && 'id' in value && value.id === checkpoint.id) {
      reached();
      await blocked;
    }
    return original(value);
  };
  const pending = old.put(config, checkpoint, metadata);
  const observed = pending.then(
    () => ({ ok: true }),
    (error: unknown) => ({ ok: false, error }),
  );
  try {
    await waiting;
    await recover();
  } finally {
    release();
  }
  expect(await observed).toMatchObject({ ok: false, error: expect.any(Error) });
  expect((await record()).checkpointWriteRevision).toBe(0);
  expect(await old.getTuple(config)).toBeUndefined();
  expect(
    await mongoose.connection.db!.collection(CHECKPOINT_STORAGE_COLLECTION).countDocuments(),
  ).toBe(0);
});

it('rolls back admission revision and storage inventory when the real checkpoint write fails', async () => {
  await admitted();
  await mongoose.connection.db!.createCollection('fenced_checkpoints', {
    validator: { required_for_test: { $exists: true } },
  });
  await expect(saver().put(config, emptyCheckpoint(), metadata)).rejects.toThrow();
  expect((await record()).checkpointWriteRevision).toBe(0);
  for (const name of ['fenced_checkpoints', CHECKPOINT_STORAGE_COLLECTION]) {
    expect(await mongoose.connection.db!.collection(name).countDocuments()).toBe(0);
  }
});

it('persists a burst of concurrent pending writes under the same admission without losing tasks', async () => {
  await admitted();
  const current = saver();
  const stored = await current.put(config, emptyCheckpoint(), metadata);
  const results = await Promise.allSettled(
    Array.from({ length: 16 }, (_, index) =>
      current.putWrites(stored, [['events', [`result-${index}`]]], `task-${index}`),
    ),
  );
  expect(results.map((result) => result.status)).toEqual(Array(16).fill('fulfilled'));
  expect((await record()).checkpointWriteRevision).toBe(17);
  const tuple = await current.getTuple(stored);
  expect(tuple?.pendingWrites).toHaveLength(16);
  expect(new Set(tuple?.pendingWrites?.map(([task]) => task)).size).toBe(16);
});

it('holds subsequent writes from a saver whose transaction failed', async () => {
  await admitted();
  await mongoose.connection.db!.createCollection('fenced_checkpoints', {
    validator: { required_for_test: { $exists: true } },
  });
  const current = saver();
  await expect(current.put(config, emptyCheckpoint(), metadata)).rejects.toThrow();
  await mongoose.connection.db!.command({ collMod: 'fenced_checkpoints', validator: {} });
  await expect(current.put(config, emptyCheckpoint(), metadata)).rejects.toThrow();
  expect((await record()).checkpointWriteRevision).toBe(0);
  expect(await current.getTuple(config)).toBeUndefined();
});

it.each([
  { principalId: 'other' },
  { tenantId: 'other' },
  { conversationId: 'other' },
  { continuation: { ...input.continuation!, threadId: 'other' } },
  {
    continuation: {
      ...input.continuation!,
      checkpointNamespace: createCheckpointNamespace('owner', 'tenant'),
    },
  },
])('rejects a checkpoint admission with a foreign scope: %j', (changes) => {
  expect(() => saver({ ...input, ...changes })).toThrow();
});

it('snapshots the admission before caller mutation and binds it to the selected Mongo client', async () => {
  await admitted();
  const mutable = { ...input, continuation: { ...input.continuation! } };
  const bound = saver(mutable);
  mutable.segmentId = 'changed';
  mutable.continuation.runId = 'changed';
  const stored = await bound.put(config, emptyCheckpoint(), metadata);
  expect(await bound.getTuple(stored)).toBeDefined();
  const otherClient = new mongoose.mongo.MongoClient(mongo!.getUri());
  try {
    expect(
      () =>
        new DurableMongoSaver({
          scope,
          admission: input,
          client: otherClient as unknown as ConstructorParameters<
            typeof DurableMongoSaver
          >[0]['client'],
          dbName: mongoose.connection.db!.databaseName,
        }),
    ).toThrow('Mongo connection');
  } finally {
    await otherClient.close();
  }
});
