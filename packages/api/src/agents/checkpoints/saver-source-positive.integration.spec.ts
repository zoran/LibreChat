/** Private source-reader authorization with real native writes, transactions and Mongo. */
import mongoose from 'mongoose';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { emptyCheckpoint, ERROR } from '@langchain/langgraph-checkpoint';
import {
  createModels,
  createMethods,
  createUploadManagementRepository,
  createCheckpointSourceMethods,
  createGenerationAdmissionMethods,
  tenantStorage,
} from '@librechat/data-schemas';
import type { CheckpointSourceBinding, GenerationAdmissionInput } from '@librechat/data-schemas';
import {
  createCheckpointNamespace,
  checkpointOwnerNamespacePrefix,
} from '../../stream/checkpoints';
import { checkpointTestEnvironment } from './__tests__/helpers/mongo';
import { createCheckpointSourceRecovery } from '../checkpointer';
import { purgeCheckpointRows } from './source-retention';
import { DurableMongoSaver } from './durable';
import { OwnedMongoSaver } from './saver';

let mongo: MongoMemoryReplSet | undefined;
let scratch: string;
const metadata = { source: 'input' as const, step: -1, parents: {} };
const names = ['source_positive_checkpoints', 'source_positive_pending'];
function ordinary() {
  return new OwnedMongoSaver({
    client: mongoose.connection.getClient() as unknown as ConstructorParameters<
      typeof OwnedMongoSaver
    >[0]['client'],
    dbName: mongoose.connection.db!.databaseName,
    checkpointCollectionName: names[0],
    checkpointWritesCollectionName: names[1],
    ttl: 3600,
  });
}
beforeAll(async () => {
  const environment = checkpointTestEnvironment();
  scratch = await mkdtemp(join(environment.scratchRoot, 'source-positive-'));
  await mkdir(join(scratch, 'mongo'));
  mongo = await MongoMemoryReplSet.create({
    binary: environment.binary,
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' },
    instanceOpts: [{ dbPath: join(scratch, 'mongo'), args: ['--nounixsocket'] }],
  });
  await mongoose.connect(mongo.getUri('source_positive'));
  createModels(mongoose);
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}, 60000);
const owner = { userId: new mongoose.Types.ObjectId().toHexString(), tenantId: 'source-positive' };
const scope = {
  ...owner,
  threadId: 'thread',
  checkpointNamespace: createCheckpointNamespace(owner.userId, owner.tenantId),
};
const policy = 'c'.repeat(64);
const savedPolicy = process.env.UPLOAD_SECURITY_POLICY_SHA256;
const savedManaged = process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED;
const run = <T>(action: () => Promise<T>) =>
  tenantStorage.run({ tenantId: owner.tenantId }, action);
beforeEach(async () => {
  process.env.UPLOAD_SECURITY_POLICY_SHA256 = policy;
  process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = 'true';
  await createUploadManagementRepository(mongoose, {
    enabled: true,
    reconciled: true,
  }).initialize();
  await mongoose.models.User.create({
    _id: owner.userId,
    tenantId: owner.tenantId,
    name: 'Synthetic owner',
    email: 'source@example.invalid',
    provider: 'local',
  });
});
afterEach(async () => {
  jest.restoreAllMocks();
  await mongoose.connection.dropDatabase();
  for (const [key, value] of [
    ['UPLOAD_SECURITY_POLICY_SHA256', savedPolicy],
    ['CORTEX_UPLOAD_MANAGEMENT_ENABLED', savedManaged],
  ]) {
    if (value === undefined) delete process.env[key!];
    else process.env[key!] = value;
  }
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
async function prepare(ttl = 3600, withMessage = false) {
  const now = Date.now();
  const fileId = '82c60bee-5296-4d5b-8abe-f09a6f3380d7';
  // Actual File/User/source fences; security receipt and original storage are explicit fixtures.
  await mongoose.models.File.collection.insertOne({
    file_id: fileId,
    uploadOperationId: fileId,
    user: new mongoose.Types.ObjectId(owner.userId),
    tenantId: owner.tenantId,
    status: 'ready',
    source: 's3',
    type: 'text/plain',
    bytes: 8,
    storageKey: `t/${owner.tenantId}/managed-uploads/${owner.userId}/${fileId}.1__original`,
    retentionAcceptedAt: new Date(now),
    expiredAt: new Date(now + 60000),
    retainedDerivativeBytes: 0,
    securityApproval: {
      version: 1,
      decision: 'approved',
      policySha256: policy,
      subject: {
        ...owner,
        operationId: fileId,
        transferGeneration: 1,
        mediaType: 'text/plain',
        bytes: 8,
        sha256: 'a'.repeat(64),
      },
      scannerVersion: 'explicit-synthetic/v1',
      checkedAt: new Date(now).toISOString(),
      coverage: { complete: true, pages: 1, parts: 1 },
    },
  });
  const messageId = 'b697a5d1-292d-424f-8be2-8a000606b9b7';
  const messageConversationId = 'b044d3bf-cb47-4484-91e8-d9c2f9a5a513';
  const references = [];
  if (withMessage) {
    const messages = createMethods(mongoose);
    const retention = await messages.resolveFileRetentionContext(owner, {
      fileIds: [fileId],
      historyMessageIds: [],
    });
    await messages.saveMessage(
      owner,
      {
        messageId,
        conversationId: messageConversationId,
        isCreatedByUser: false,
        text: 'Referenced source body',
      },
      { sourceRetention: retention },
    );
    const row = await mongoose.models.Message.collection.findOne({ messageId });
    references.push({
      conversationId: messageConversationId,
      messageId,
      expectedVersion: row!.__v ?? null,
    });
  }
  const session = await mongoose.startSession();
  let binding: CheckpointSourceBinding;
  try {
    session.startTransaction();
    ({ binding } = await createCheckpointSourceMethods(mongoose).captureCheckpointSources(
      owner,
      { fileIds: [fileId], messages: references },
      session,
    ));
    await session.commitTransaction();
  } finally {
    await session.endSession();
  }
  const admission: GenerationAdmissionInput = {
    tenantId: owner.tenantId,
    principalId: owner.userId,
    clientRequestId: 'request',
    conversationId: scope.threadId,
    requestFingerprint: 'a'.repeat(64),
    protocol: '1',
    ownerInstanceId: 'owner',
    processBootId: 'boot',
    generationEpoch: 1,
    segmentId: 'segment',
    continuation: {
      version: 1,
      mode: 'checkpoint-only-v1',
      runId: 'run',
      threadId: scope.threadId,
      checkpointNamespace: scope.checkpointNamespace,
      graphFingerprint: 'b'.repeat(64),
      policyFingerprint: 'c'.repeat(64),
      sourceBindingSha256: binding!.bindingSha256,
    },
  };
  const methods = createGenerationAdmissionMethods(mongoose);
  expect((await methods.acquireGenerationAdmission(admission)).ok).toBe(true);
  expect((await methods.dispatchGenerationAdmission(admission)).ok).toBe(true);
  const options = {
    scope,
    admission,
    sourceBinding: binding!,
    client: mongoose.connection.getClient() as unknown as ConstructorParameters<
      typeof DurableMongoSaver
    >[0]['client'],
    dbName: mongoose.connection.db!.databaseName,
    checkpointCollectionName: names[0],
    checkpointWritesCollectionName: names[1],
    ttl,
  };
  return {
    saver: new DurableMongoSaver(options),
    options,
    methods,
    admission,
    binding: binding!,
    fileId,
    messageId,
  };
}
const config = { configurable: { thread_id: scope.threadId, checkpoint_ns: '' } };

it('roundtrips actual source checkpoint and pending rows only after an acknowledged read commit', async () =>
  run(async () => {
    const { saver, methods, admission } = await prepare();
    const checkpoint = emptyCheckpoint();
    checkpoint.channel_values = { messages: ['source payload'] };
    const saved = await saver.put(config, checkpoint, metadata);
    await saver.putWrites(
      saved,
      [
        ['events', 'pending'],
        [ERROR, 'mixed error'],
      ],
      'task',
    );
    const charge = await mongoose.models.UploadCounter.collection.findOne({
      _id: 'global' as never,
    });
    const before = await methods.getGenerationAdmission(admission);
    const decode = jest.spyOn(saver.serde, 'loadsTyped');
    const tuple = await saver.getTuple(saved);
    expect(tuple?.checkpoint).toEqual(checkpoint);
    expect(tuple?.pendingWrites).toEqual([
      ['task', 'events', 'pending'],
      ['task', ERROR, 'mixed error'],
    ]);
    expect(tuple?.config.configurable?.checkpoint_ns).toBe('');
    expect(decode).toHaveBeenCalledTimes(4);
    expect(
      await mongoose.models.UploadCounter.collection.findOne({ _id: 'global' as never }),
    ).toEqual(charge);
    const after = await methods.getGenerationAdmission(admission);
    expect(after.ok && before.ok && after.value!.checkpointWriteRevision).toBe(
      before.ok ? before.value!.checkpointWriteRevision + 1 : -1,
    );
  }));

async function stored(ttl = 3600, withMessage = false) {
  const fixture = await prepare(ttl, withMessage);
  const checkpoint = emptyCheckpoint();
  const saved = await fixture.saver.put(config, checkpoint, metadata);
  await fixture.saver.putWrites(saved, [['events', 'pending']], 'task');
  return { ...fixture, checkpoint, saved };
}

it.each(['revoked', 'deleted-user', 'policy', 'replacement', 'not-dispatching'])(
  'denies current %s authority before any Serde',
  async (change) =>
    run(async () => {
      const { saver, saved, fileId } = await stored();
      const decode = jest.spyOn(saver.serde, 'loadsTyped');
      if (change === 'revoked')
        await mongoose.models.File.collection.updateOne(
          { file_id: fileId },
          { $set: { deletionRequestedAt: new Date() } },
        );
      if (change === 'deleted-user')
        await mongoose.models.User.collection.deleteOne({
          _id: new mongoose.Types.ObjectId(owner.userId),
        });
      if (change === 'policy') process.env.UPLOAD_SECURITY_POLICY_SHA256 = 'f'.repeat(64);
      if (change === 'replacement')
        await mongoose.models.GenerationAdmission.collection.updateOne(
          { clientRequestId: 'request' },
          { $set: { segmentId: 'other' } },
        );
      if (change === 'not-dispatching')
        await mongoose.models.GenerationAdmission.collection.updateOne(
          { clientRequestId: 'request' },
          { $set: { state: 'admitted' } },
        );
      await expect(saver.getTuple(saved)).rejects.toThrow();
      expect(decode).not.toHaveBeenCalled();
    }),
);

it('fences actual saved Message witnesses before and after content mutation', async () =>
  run(async () => {
    const { saver, saved, messageId } = await stored(3600, true);
    expect((await saver.get(saved))?.id).toBe(saved.configurable?.checkpoint_id);
    const decode = jest.spyOn(saver.serde, 'loadsTyped');
    await mongoose.models.Message.collection.updateOne(
      { messageId },
      { $set: { text: 'Changed after capture' } },
    );
    await expect(saver.getTuple(saved)).rejects.toThrow();
    expect(decode).not.toHaveBeenCalled();
  }));

const markers = [
  'lc_source_binding',
  'lc_source_file_ids',
  'lc_source_expires_at',
  'lc_retained_allocations',
];
it.each(
  markers.flatMap((field) =>
    [0, 1].flatMap((collection) =>
      ['missing', 'null'].map((change) => ({ field, collection, change })),
    ),
  ),
)(
  'rejects $change $field on raw collection $collection before Serde',
  async ({ field, collection, change }) =>
    run(async () => {
      const { saver, saved } = await stored();
      await mongoose.connection
        .db!.collection(names[collection])
        .updateOne(
          {},
          change === 'missing' ? { $unset: { [field]: '' } } : { $set: { [field]: null } },
        );
      const decode = jest.spyOn(saver.serde, 'loadsTyped');
      await expect(saver.getTuple(saved)).rejects.toThrow();
      expect(decode).not.toHaveBeenCalled();
    }),
);

it.each(['ordinary', 'foreign-owner', 'wrong-binding', 'wrong-receipt', 'duplicate'])(
  'rejects a mixed or inconsistent pending row: %s',
  async (change) =>
    run(async () => {
      const { saver, saved } = await stored();
      const collection = mongoose.connection.db!.collection(names[1]);
      if (change === 'ordinary')
        await collection.updateOne(
          {},
          { $unset: Object.fromEntries(markers.map((field) => [field, ''])) },
        );
      if (change === 'foreign-owner')
        await collection.updateOne({}, { $set: { lc_owner: 'foreign' } });
      if (change === 'wrong-binding')
        await collection.updateOne(
          {},
          { $set: { 'lc_source_binding.bindingSha256': 'f'.repeat(64) } },
        );
      if (change === 'wrong-receipt')
        await collection.updateOne({}, { $inc: { 'lc_retained_allocations.0.bytes': 1 } });
      if (change === 'duplicate') {
        await collection.dropIndex('lc_pending_slot_unique');
        const row = await collection.findOne({});
        const { _id, ...copy } = row!;
        await collection.insertOne(copy);
      }
      const decode = jest.spyOn(saver.serde, 'loadsTyped');
      await expect(saver.getTuple(saved)).rejects.toThrow();
      expect(decode).not.toHaveBeenCalled();
    }),
);

it('keeps default Owned readers negative even with caller-supplied source fields', async () =>
  run(async () => {
    const { saved, binding } = await stored();
    const raw = await mongoose.connection.db!.collection(names[0]).findOne({});
    const plain = ordinary();
    const decode = jest.spyOn(plain.serde, 'loadsTyped');
    await expect(
      plain.getTuple({
        configurable: {
          checkpoint_id: saved.configurable!.checkpoint_id,
          thread_id: raw!.thread_id,
          checkpoint_ns: raw!.checkpoint_ns,
          sourceBinding: binding,
        },
      }),
    ).rejects.toThrow();
    expect(decode).not.toHaveBeenCalled();
  }));

it('rejects aggregate BSON overflow and pending-row excess without decoding or truncation', async () =>
  run(async () => {
    const { options, saved } = await stored();
    const db = mongoose.connection.db!;
    const [checkpoint] = await db
      .collection(names[0])
      .aggregate([{ $project: { bytes: { $bsonSize: '$$ROOT' } } }])
      .toArray();
    const [pending] = await db
      .collection(names[1])
      .aggregate([{ $project: { bytes: { $bsonSize: '$$ROOT' } } }])
      .toArray();
    const budgeted = new DurableMongoSaver({
      ...options,
      hardLimitBytes: checkpoint.bytes + pending.bytes - 1,
    });
    const budgetDecode = jest.spyOn(budgeted.serde, 'loadsTyped');
    await expect(budgeted.getTuple(saved)).rejects.toThrow();
    expect(budgetDecode).not.toHaveBeenCalled();
    const row = await db.collection(names[1]).findOne({});
    const { _id, ...copy } = row!;
    // Synthetic excess fixture after a real write: the actual Mongo selector must reject the complete set.
    await db
      .collection(names[1])
      .insertMany(Array.from({ length: 1024 }, (_, index) => ({ ...copy, idx: index + 1 })));
    const reader = new DurableMongoSaver(options);
    const decode = jest.spyOn(reader.serde, 'loadsTyped');
    await expect(reader.getTuple(saved)).rejects.toThrow();
    expect(decode).not.toHaveBeenCalled();
  }));

it.each(['string', 'document'])(
  'bounds malformed %s pending identifiers inside Mongo before metadata transfer',
  async (kind) =>
    run(async () => {
      const { options, saved } = await stored();
      const db = mongoose.connection.db!;
      let budget = 0;
      for (const name of names) {
        const rows = await db
          .collection(name)
          .aggregate([{ $project: { _id: 0, bytes: { $bsonSize: '$$ROOT' } } }])
          .toArray();
        budget += rows.reduce((total, row) => total + row.bytes, 0);
      }
      const row = await db.collection(names[1]).findOne({});
      const large = 'x'.repeat(256 * 1024);
      // Malformed historical data following a real writer-produced tuple. Its identifier
      // alone exceeds the instance budget; the metadata response must remain bounded.
      await db.collection(names[1]).insertOne({
        ...row,
        _id: (kind === 'string' ? large : { malformed: large }) as never,
        idx: row!.idx + 1,
      });
      const actualSizes = await db
        .collection(names[1])
        .aggregate([{ $project: { _id: 0, bytes: { $bsonSize: '$$ROOT' } } }])
        .toArray();
      expect(Math.max(...actualSizes.map((size) => size.bytes))).toBeGreaterThan(budget);

      const observed: mongoose.mongo.Document[][] = [];
      const aggregate = mongoose.mongo.Collection.prototype.aggregate;
      jest.spyOn(mongoose.mongo.Collection.prototype, 'aggregate').mockImplementation(function (
        this: InstanceType<typeof mongoose.mongo.Collection>,
        pipeline,
        aggregateOptions,
      ) {
        const cursor = aggregate.call(this, pipeline, aggregateOptions);
        if (this.collectionName === names[1] && aggregateOptions?.session) {
          const toArray = cursor.toArray.bind(cursor);
          jest.spyOn(cursor, 'toArray').mockImplementation(async () => {
            const result = await toArray();
            observed.push(result);
            return result;
          });
        }
        return cursor;
      });
      const find = jest.spyOn(mongoose.mongo.Collection.prototype, 'find');
      const reader = new DurableMongoSaver({ ...options, hardLimitBytes: budget });
      const decode = jest.spyOn(reader.serde, 'loadsTyped');
      await expect(reader.getTuple(saved)).rejects.toThrow();
      expect(decode).not.toHaveBeenCalled();
      expect(
        find.mock.contexts.filter((collection) => collection.collectionName === names[1]),
      ).toHaveLength(0);
      expect(observed).toHaveLength(1);
      expect(observed[0]).toHaveLength(2);
      expect(Buffer.byteLength(JSON.stringify(observed[0]))).toBeLessThan(256);
      expect(observed[0].map((size) => size.bytes).sort((a, b) => a - b)).toEqual(
        actualSizes.map((size) => size.bytes).sort((a, b) => a - b),
      );
      expect(observed[0].filter((size) => size._id === null)).toHaveLength(1);
      expect(
        observed[0].filter((size) => size._id instanceof mongoose.mongo.ObjectId),
      ).toHaveLength(1);
    }),
);

it('returns the complete tuple exactly at its BSON budget', async () =>
  run(async () => {
    const { options, saved } = await stored();
    let bytes = 0;
    for (const name of names) {
      const rows = await mongoose.connection
        .db!.collection(name)
        .aggregate([{ $project: { bytes: { $bsonSize: '$$ROOT' } } }])
        .toArray();
      bytes += rows.reduce((total, row) => total + row.bytes, 0);
    }
    const reader = new DurableMongoSaver({ ...options, hardLimitBytes: bytes });
    expect((await reader.getTuple(saved))?.pendingWrites).toHaveLength(1);
  }));

it('does not decode an unknown committed read and holds subsequent database work', async () =>
  run(async () => {
    const { saver, saved } = await stored();
    const decode = jest.spyOn(saver.serde, 'loadsTyped');
    const original = mongoose.mongo.ClientSession.prototype.commitTransaction;
    const commit = jest
      .spyOn(mongoose.mongo.ClientSession.prototype, 'commitTransaction')
      .mockImplementationOnce(async function (this: mongoose.ClientSession, ...args) {
        await original.apply(this, args);
        const error = new mongoose.mongo.MongoServerError({
          message: 'synthetic unknown acknowledgment',
        });
        error.addErrorLabel('UnknownTransactionCommitResult');
        throw error;
      });
    await expect(saver.getTuple(saved)).rejects.toThrow();
    await expect(saver.getTuple(saved)).rejects.toThrow('held');
    expect(decode).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
  }));

it('retries only raw transaction work after a known abort, decoding the acknowledged result once', async () =>
  run(async () => {
    const { saver, saved } = await stored();
    const original = mongoose.mongo.Collection.prototype.aggregate;
    let failed = false;
    jest.spyOn(mongoose.mongo.Collection.prototype, 'aggregate').mockImplementation(function (
      this: InstanceType<typeof mongoose.mongo.Collection>,
      pipeline,
      options,
    ) {
      if (this.collectionName === names[0] && options?.session && !failed) {
        failed = true;
        const error = new mongoose.mongo.MongoServerError({
          message: 'synthetic known abort',
          code: 112,
        });
        error.addErrorLabel('TransientTransactionError');
        throw error;
      }
      return original.call(this, pipeline, options);
    });
    const decode = jest.spyOn(saver.serde, 'loadsTyped');
    expect((await saver.getTuple(saved))?.pendingWrites).toHaveLength(1);
    expect(failed).toBe(true);
    expect(decode).toHaveBeenCalledTimes(3);
  }));

it.each(['before-read', 'after-commit', 'during-serde', 'final-return'])(
  'does not return expired raw content at %s',
  async (stage) =>
    run(async () => {
      const { saver, saved } = await stored(1);
      const row = await mongoose.connection.db!.collection(names[0]).findOne({});
      const expire = () =>
        jest.spyOn(Date, 'now').mockReturnValue(row!.lc_source_expires_at.getTime() + 1);
      if (stage === 'before-read') expire();
      if (stage === 'after-commit') {
        const original = mongoose.mongo.ClientSession.prototype.commitTransaction;
        jest
          .spyOn(mongoose.mongo.ClientSession.prototype, 'commitTransaction')
          .mockImplementationOnce(async function (this: mongoose.ClientSession, ...args) {
            await original.apply(this, args);
            expire();
          });
      }
      const originalDecode = saver.serde.loadsTyped.bind(saver.serde);
      let calls = 0;
      const decode = jest.spyOn(saver.serde, 'loadsTyped').mockImplementation(async (...args) => {
        const value = await originalDecode(...args);
        calls++;
        if ((stage === 'during-serde' && calls === 1) || (stage === 'final-return' && calls === 3))
          expire();
        return value;
      });
      await expect(saver.getTuple(saved)).rejects.toThrow();
      expect(decode).toHaveBeenCalledTimes({ 'during-serde': 1, 'final-return': 3 }[stage] ?? 0);
    }),
);

it('reauthorizes list next() after every yield and preserves keyset/filter/limit', async () =>
  run(async () => {
    const { saver, fileId } = await prepare();
    for (const id of ['001', '002', '003'])
      await saver.put(config, { ...emptyCheckpoint(), id }, { ...metadata, step: Number(id) });
    const limited = [];
    for await (const tuple of saver.list(config, {
      before: { configurable: { ...config.configurable, checkpoint_id: '003' } },
      limit: 1,
      filter: { step: 2 },
    }))
      limited.push(tuple.checkpoint.id);
    expect(limited).toEqual(['002']);
    const iterator = saver.list(config);
    expect((await iterator.next()).value?.checkpoint.id).toBe('003');
    const decode = jest.spyOn(saver.serde, 'loadsTyped');
    await mongoose.models.File.collection.updateOne(
      { file_id: fileId },
      { $set: { deletionRequestedAt: new Date() } },
    );
    await expect(iterator.next()).rejects.toThrow();
    expect(decode).not.toHaveBeenCalled();
  }));

it('preserves parent/subgraph/get paths and fences a no-row result', async () =>
  run(async () => {
    const { saver, methods, admission } = await prepare();
    const subgraph = { configurable: { ...config.configurable, checkpoint_ns: 'graph:child' } };
    const parent = await saver.put(
      subgraph,
      { ...emptyCheckpoint(), id: 'parent', channel_values: { events: ['seed'] } },
      metadata,
    );
    await saver.putWrites(parent, [['events', 'delta']], 'parent-task');
    const child = await saver.put(parent, { ...emptyCheckpoint(), id: 'child' }, metadata);
    const tuple = await saver.getTuple(child);
    expect(tuple?.parentConfig?.configurable?.checkpoint_ns).toBe('graph:child');
    expect((await saver.get(tuple!.parentConfig!))?.id).toBe('parent');
    expect(await saver.getDeltaChannelHistory({ config: child, channels: ['events'] })).toEqual({
      events: { seed: ['seed'], writes: [['parent-task', 'events', 'delta']] },
    });
    const before = await methods.getGenerationAdmission(admission);
    expect(
      await saver.getTuple({ configurable: { ...config.configurable, checkpoint_id: 'absent' } }),
    ).toBeUndefined();
    const after = await methods.getGenerationAdmission(admission);
    expect(after.ok && after.value!.checkpointWriteRevision).toBe(
      before.ok ? before.value!.checkpointWriteRevision + 1 : -1,
    );
  }));

it('orders source reads and writes on one database FIFO and does not decode before acknowledgment', async () =>
  run(async () => {
    const { saver } = await prepare();
    const saved = await saver.put(config, emptyCheckpoint(), metadata);
    const original = mongoose.mongo.ClientSession.prototype.commitTransaction;
    let signal!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest
      .spyOn(mongoose.mongo.ClientSession.prototype, 'commitTransaction')
      .mockImplementationOnce(async function (this: mongoose.ClientSession, ...args) {
        signal();
        await gate;
        return original.apply(this, args);
      });
    const decode = jest.spyOn(saver.serde, 'loadsTyped');
    const first = saver.getTuple(saved);
    await started;
    let indexesReady!: () => void;
    const admitted = new Promise<void>((resolve) => {
      indexesReady = resolve;
    });
    const originalIndexes = mongoose.mongo.Collection.prototype.indexes;
    jest.spyOn(mongoose.mongo.Collection.prototype, 'indexes').mockImplementation(async function (
      this: InstanceType<typeof mongoose.mongo.Collection>,
      ...args
    ) {
      const indexes = await originalIndexes.apply(this, args);
      if (this.collectionName === names[1]) indexesReady();
      return indexes;
    });
    const write = saver.putWrites(saved, [['events', 'queued']], 'task');
    await admitted;
    await new Promise((resolve) => setImmediate(resolve));
    const second = saver.getTuple(saved);
    expect(decode).not.toHaveBeenCalled();
    release();
    const [early, , late] = await Promise.all([first, write, second]);
    expect(early?.pendingWrites).toEqual([]);
    expect(late?.pendingWrites).toEqual([['task', 'events', 'queued']]);
  }));

it('invalidates an old recovery CAS and refuses the displaced admission after a read', async () =>
  run(async () => {
    const { saver, saved, methods, admission } = await stored();
    const prior = await methods.getGenerationAdmission(admission);
    if (!prior.ok || !prior.value) throw new Error('Fixture admission missing');
    const evidence = {
      checkpointWriteRevision: prior.value.checkpointWriteRevision,
      terminationEvidenceSha256: 'a'.repeat(64),
      effectsEvidenceSha256: 'b'.repeat(64),
    };
    const successor = {
      ownerInstanceId: 'successor',
      processBootId: 'successor-boot',
      segmentId: 'successor-segment',
    };
    await saver.getTuple(saved);
    const recoverSources = jest.fn(
      createCheckpointSourceRecovery({
        type: 'mongo',
        checkpointCollectionName: names[0],
        checkpointWritesCollectionName: names[1],
      }),
    );
    expect(
      await methods.recoverGenerationAdmission(admission, evidence, successor, recoverSources),
    ).toMatchObject({
      ok: false,
    });
    expect(recoverSources).not.toHaveBeenCalled();
    expect(
      await methods.recoverGenerationAdmission(
        admission,
        { ...evidence, checkpointWriteRevision: evidence.checkpointWriteRevision + 1 },
        successor,
        createCheckpointSourceRecovery({
          type: 'mongo',
          checkpointCollectionName: names[0],
          checkpointWritesCollectionName: names[1],
        }),
      ),
    ).toMatchObject({ ok: true });
    const decode = jest.spyOn(saver.serde, 'loadsTyped');
    await expect(saver.getTuple(saved)).rejects.toThrow();
    expect(decode).not.toHaveBeenCalled();
  }));

it('uses actual writer receipts for cleanup after positive reads without charging another copy', async () =>
  run(async () => {
    const { saver, saved } = await stored();
    await saver.getTuple(saved);
    await purgeCheckpointRows(
      { checkpointCollectionName: names[0], checkpointWritesCollectionName: names[1] },
      { lc_owner: checkpointOwnerNamespacePrefix(owner.userId, owner.tenantId) },
    );
    for (const name of names)
      expect(await mongoose.connection.db!.collection(name).countDocuments()).toBe(0);
    const counter = await mongoose.models.UploadCounter.collection.findOne({
      _id: 'global' as never,
    });
    expect(counter!.value.textBytes).toBe(0);
  }));

it('conflicts with File revocation after the source snapshot without decoding an aborted attempt', async () =>
  run(async () => {
    const { saver, saved, fileId } = await stored();
    const original = mongoose.mongo.Collection.prototype.updateMany;
    let raced = false;
    jest
      .spyOn(mongoose.mongo.Collection.prototype, 'updateMany')
      .mockImplementation(async function (
        this: InstanceType<typeof mongoose.mongo.Collection>,
        filter,
        update,
        options,
      ) {
        if (
          this.collectionName === mongoose.models.File.collection.collectionName &&
          options?.session &&
          !raced
        ) {
          raced = true;
          await mongoose.models.File.collection.updateOne(
            { file_id: fileId },
            { $set: { deletionRequestedAt: new Date() } },
          );
        }
        return original.call(this, filter, update, options);
      });
    const decode = jest.spyOn(saver.serde, 'loadsTyped');
    await expect(saver.getTuple(saved)).rejects.toThrow();
    expect(raced).toBe(true);
    expect(decode).not.toHaveBeenCalled();
  }));

it('decodes actual special pending-slot updates alongside ordinary pending rows', async () =>
  run(async () => {
    const { saver, saved } = await stored();
    await saver.putWrites(saved, [[ERROR, 'first']], 'special');
    await saver.putWrites(saved, [[ERROR, 'second']], 'special');
    const tuple = await saver.getTuple(saved);
    expect(tuple?.pendingWrites).toHaveLength(2);
    expect(tuple?.pendingWrites).toEqual(
      expect.arrayContaining([
        ['task', 'events', 'pending'],
        ['special', ERROR, 'second'],
      ]),
    );
  }));

async function recoverStored(fixture: Awaited<ReturnType<typeof stored>>, segmentId = 'restarted') {
  const current = await fixture.methods.getGenerationAdmission(fixture.admission);
  if (!current.ok || !current.value) throw new Error('Missing native admission');
  return fixture.methods.recoverGenerationAdmission(
    fixture.admission,
    {
      checkpointWriteRevision: current.value.checkpointWriteRevision,
      terminationEvidenceSha256: 'd'.repeat(64),
      effectsEvidenceSha256: 'e'.repeat(64),
    },
    { ownerInstanceId: 'new-owner', processBootId: 'new-boot', segmentId },
    createCheckpointSourceRecovery({
      type: 'mongo',
      ttl: 3600,
      checkpointCollectionName: names[0],
      checkpointWritesCollectionName: names[1],
    }),
  );
}

it('bootstraps source recovery metadata and exact latest root without Serde or revision drift', async () =>
  run(async () => {
    const fixture = await stored(3600, true);
    const before = await fixture.methods.getGenerationAdmission(fixture.admission);
    const decode = jest.spyOn(fixture.saver.serde, 'loadsTyped');
    const result = await recoverStored(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Recovery held');
    expect(result.value.source?.sourceBinding).toEqual(fixture.binding);
    expect(result.value.source?.checkpoint).toEqual({
      threadId: scope.threadId,
      checkpointId: fixture.checkpoint.id,
      checkpointNs: '',
    });
    expect(result.value.admission.state).toBe('admitted');
    expect(result.value.admission.checkpointWriteRevision).toBe(
      before.ok && before.value!.checkpointWriteRevision,
    );
    expect(Object.isFrozen(result.value.source?.sourceBinding)).toBe(true);
    expect(decode).not.toHaveBeenCalled();
  }));

it.each([
  'absent',
  'partial',
  'foreign-owner',
  'binding-mismatch',
  'expired-row',
  'oversized-metadata',
  'oversized-row',
  'bad-id',
  'newest-ordinary',
  'nested-only',
  'duplicate',
  'revoked-file',
  'disabled-principal',
  'changed-message',
])('holds bootstrap recovery for %s without admitting or touching sources', async (change) =>
  run(async () => {
    const fixture = await stored(3600, true);
    const collection = mongoose.connection.db!.collection(names[0]);
    const row = (await collection.findOne({}))!;
    if (change === 'absent') await collection.deleteMany({});
    else if (change === 'newest-ordinary') {
      const next: typeof row = {
        ...row,
        _id: new mongoose.Types.ObjectId(),
        checkpoint_id: 'zz-newest',
      };
      for (const key of [
        'lc_source_binding',
        'lc_source_file_ids',
        'lc_source_expires_at',
        'lc_retained_allocations',
      ])
        delete next[key];
      await collection.insertOne(next);
    } else if (change === 'duplicate') {
      await collection.dropIndex('lc_checkpoint_slot_unique');
      await collection.insertOne({ ...row, _id: new mongoose.Types.ObjectId() });
    } else if (change === 'revoked-file')
      await mongoose.models.File.collection.updateOne(
        { file_id: fixture.fileId },
        { $set: { deletionRequestedAt: new Date() } },
      );
    else if (change === 'disabled-principal')
      await mongoose.models.User.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(owner.userId) },
        { $set: { authDisabled: true } },
      );
    else if (change === 'changed-message')
      await mongoose.models.Message.collection.updateOne(
        { messageId: fixture.messageId },
        { $set: { text: 'changed source' } },
      );
    else {
      if (change === 'partial') delete row.lc_source_file_ids;
      if (change === 'foreign-owner') row.lc_owner = 'foreign';
      if (change === 'binding-mismatch') row.lc_source_binding.bindingSha256 = 'a'.repeat(64);
      if (change === 'expired-row') row.lc_source_expires_at = new Date(Date.now() - 1);
      if (change === 'oversized-metadata') row.lc_source_file_ids = ['x'.repeat(65537)];
      if (change === 'oversized-row')
        row.checkpoint = new mongoose.mongo.Binary(Buffer.alloc(16 * 1024 * 1024 - 65536));
      if (change === 'bad-id') row.checkpoint_id = { invalid: true };
      if (change === 'nested-only') row.checkpoint_ns += '|nested';
      await collection.replaceOne({ _id: row._id }, row);
    }
    const before = await fixture.methods.getGenerationAdmission(fixture.admission);
    const fileBefore = await mongoose.models.File.collection.findOne({ file_id: fixture.fileId });
    const principalBefore = await mongoose.models.User.collection.findOne({
      _id: new mongoose.Types.ObjectId(owner.userId),
    });
    const messageBefore = await mongoose.models.Message.collection.findOne({
      messageId: fixture.messageId,
    });
    const decode = jest.spyOn(fixture.saver.serde, 'loadsTyped');
    expect(await recoverStored(fixture)).toEqual({ ok: false, error: { code: 'HELD' } });
    expect(await fixture.methods.getGenerationAdmission(fixture.admission)).toEqual(before);
    expect(await mongoose.models.File.collection.findOne({ file_id: fixture.fileId })).toEqual(
      fileBefore,
    );
    expect(
      await mongoose.models.User.collection.findOne({
        _id: new mongoose.Types.ObjectId(owner.userId),
      }),
    ).toEqual(principalBefore);
    expect(
      await mongoose.models.Message.collection.findOne({ messageId: fixture.messageId }),
    ).toEqual(messageBefore);
    expect(decode).not.toHaveBeenCalled();
  }),
);

it('admits one metadata recovery winner without permitting the losing source callback', async () =>
  run(async () => {
    const fixture = await stored();
    const outcomes = await Promise.all([recoverStored(fixture, 'a'), recoverStored(fixture, 'b')]);
    expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
    const after = await fixture.methods.getGenerationAdmission(fixture.admission);
    expect(after.ok && after.value?.recoveries).toHaveLength(1);
  }));

it.each(['commit-ack', 'session-close', 'expiry-after-commit', 'abort-ack'])(
  'withholds source recovery receipt after %s uncertainty',
  async (failure) =>
    run(async () => {
      const fixture = await stored();
      const proto = mongoose.mongo.ClientSession.prototype;
      if (failure === 'session-close') {
        const original = proto.endSession;
        let failed = false;
        jest.spyOn(proto, 'endSession').mockImplementation(async function (
          this: typeof proto,
          ...args
        ) {
          await original.apply(this, args);
          if (this.explicit && !failed) {
            failed = true;
            throw new Error('Synthetic session close failure');
          }
        });
      } else if (failure === 'abort-ack') {
        await mongoose.connection.db!.collection(names[0]).deleteMany({});
        const original = proto.abortTransaction;
        jest.spyOn(proto, 'abortTransaction').mockImplementationOnce(async function (
          this: typeof proto,
          ...args
        ) {
          await original.apply(this, args);
          throw new Error('Synthetic lost abort acknowledgment');
        });
      } else {
        const original = proto.commitTransaction;
        jest.spyOn(proto, 'commitTransaction').mockImplementationOnce(async function (
          this: typeof proto,
          ...args
        ) {
          await original.apply(this, args);
          if (failure === 'expiry-after-commit')
            jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 120000);
          else throw new Error('Synthetic lost commit acknowledgment');
        });
      }
      expect(await recoverStored(fixture)).toEqual({
        ok: false,
        error: { code: 'OUTCOME_UNKNOWN' },
      });
      const row = await fixture.methods.getGenerationAdmission(fixture.admission);
      expect(row.ok && row.value).toMatchObject({
        state: failure === 'abort-ack' ? 'dispatching' : 'admitted',
      });
    }),
);
