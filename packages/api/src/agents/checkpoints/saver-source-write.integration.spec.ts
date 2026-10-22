/** Private native source writes with real Mongo fences and quota; no public source activation. */
import mongoose from 'mongoose';
import { join } from 'node:path';
import { v4 as uuid } from 'uuid';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { emptyCheckpoint, ERROR } from '@langchain/langgraph-checkpoint';
import {
  createModels,
  createUploadManagementRepository,
  createCheckpointSourceMethods,
  createGenerationAdmissionMethods,
  tenantStorage,
} from '@librechat/data-schemas';
import type { CheckpointSourceBinding, GenerationAdmissionInput } from '@librechat/data-schemas';
import type { UploadLease, UploadPrincipal } from 'librechat-data-provider';
import {
  createCheckpointNamespace,
  checkpointOwnerNamespacePrefix,
} from '../../stream/checkpoints';
import { checkpointTestEnvironment } from './__tests__/helpers/mongo';
import { CHECKPOINT_STORAGE_COLLECTION } from './storage';
import { purgeCheckpointRows } from './source-retention';
import { DurableMongoSaver } from './durable';
import { OwnedMongoSaver } from './saver';

let mongo: MongoMemoryReplSet | undefined;
let scratch: string;
let sourceTextBytes = 0;
const metadata = { source: 'input' as const, step: -1, parents: {} };
const names = ['source_writer_checkpoints', 'source_writer_pending'];
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
  scratch = await mkdtemp(join(environment.scratchRoot, 'source-writer-'));
  await mkdir(join(scratch, 'mongo'));
  mongo = await MongoMemoryReplSet.create({
    binary: environment.binary,
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' },
    instanceOpts: [{ dbPath: join(scratch, 'mongo'), args: ['--nounixsocket'] }],
  });
  await mongoose.connect(mongo.getUri('source_writer'));
  createModels(mongoose);
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}, 60000);
const owner = { userId: new mongoose.Types.ObjectId().toHexString(), tenantId: 'source-writer' };
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
  sourceTextBytes = 0;
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
it('rejects an ordinary upsert collision with a source-marked physical checkpoint', async () => {
  const saver = ordinary();
  await saver.setup();
  const checkpoint = emptyCheckpoint();
  const key = { thread_id: 'thread', checkpoint_ns: '', checkpoint_id: checkpoint.id };
  await mongoose.connection
    .db!.collection(names[0])
    .insertOne({ ...key, lc_source_binding: null, checkpoint: 'preserve' });
  await expect(saver.put({ configurable: key }, checkpoint, metadata)).rejects.toThrow();
  const rows = await mongoose.connection.db!.collection(names[0]).find(key).toArray();
  expect(rows).toHaveLength(1);
  expect(rows[0].checkpoint).toBe('preserve');
  expect(rows[0]).not.toHaveProperty('upserted_at');
});

/** Managed fixtures retain the actual receipt and birth inventory from their owning lifecycle. */
async function managedSource(fileId: string, at: number) {
  const uploads = createUploadManagementRepository(mongoose, {
    enabled: true,
    reconciled: true,
    securityPolicySha256: policy,
  });
  await uploads.initialize();
  const principal: UploadPrincipal = {
    tenantId: owner.tenantId,
    userId: owner.userId,
    authentication: 'verified-email',
  };
  const worker = { hostId: 'fixture-host', instanceId: 'fixture-instance' };
  const reservation = await uploads.reserve(
    principal,
    {
      operationId: fileId,
      idempotencyKey: uuid(),
      mediaType: 'text/plain',
      declaredBytes: 6,
      fingerprint: JSON.stringify([{ kind: 'personal' }, 'text/plain', 6]),
    },
    at,
  );
  const transfer = await uploads.claim({
    kind: 'transfer',
    principal,
    operationId: reservation.id,
    worker,
    now: at,
  });
  if (!transfer) throw new Error('Managed fixture transfer was not admitted');
  const execution = {
    version: 2 as const,
    custody: { kind: 'none' as const },
    attemptId: `${fileId}.${transfer.generation}`,
    instanceId: uuid(),
    executionId: uuid(),
    expiresAt: new Date(at + 60000).toISOString(),
  };
  await uploads.bindSecurityExecution(transfer, execution, at);
  await uploads.settleSecurityExecution(
    transfer,
    { execution, writerStopped: true, transientDataRemoved: true },
    at,
  );
  await uploads.accept(
    principal,
    transfer,
    {
      outcome: 'durable',
      bytes: 6,
      source: 's3',
      filepath: `/api/files/download/${fileId}`,
      storageKey: `t/${owner.tenantId}/managed-uploads/${owner.userId}/${fileId}.${transfer.generation}__original`,
      integrity: {
        version: 1,
        algorithm: 'sha256',
        sha256: 'a'.repeat(64),
        chunkBytes: 262144,
        chunkSha256: ['b'.repeat(64)],
      },
    },
    {
      version: 1,
      decision: 'approved',
      policySha256: policy,
      subject: {
        userId: owner.userId,
        tenantId: owner.tenantId,
        operationId: fileId,
        transferGeneration: transfer.generation,
        mediaType: 'text/plain',
        bytes: 6,
        sha256: 'a'.repeat(64),
      },
      scannerVersion: 'fixture-v1',
      checkedAt: new Date(at).toISOString(),
      coverage: { complete: true, pages: 1, parts: 1 },
    },
    { filename: 'A.txt' },
    at,
  );
  const settleLocalCopies = (lease: UploadLease) =>
    uploads.confirmCleanup(
      {
        operationId: lease.operationId,
        generation: lease.generation,
        writerStopped: true,
        localCopiesAbsent: true,
        originalAbsent: false,
        textAndHistoryRemoved: false,
      },
      at,
    );
  await settleLocalCopies(transfer);
  const processing = await uploads.claim({ kind: 'processing', worker, now: at });
  if (!processing || processing.operationId !== fileId)
    throw new Error('Managed fixture processing was not admitted');
  await uploads.bindProcessingExecution(
    processing,
    {
      attemptId: `${fileId}.${processing.generation}`,
      instanceId: 'fixture-parser',
      expiresAt: new Date(at + 60000).toISOString(),
    },
    at,
  );
  await uploads.publish(
    processing,
    {
      text: 'secret',
      writerStopped: true,
      structure: {
        version: 1,
        source: { sha256: 'a'.repeat(64), bytes: 6, mediaType: 'text/plain' },
        extractor: { name: 'fixture', version: '1' },
        pages: [],
        elements: [{ id: 'e1', kind: 'paragraph', start: 0, end: 6, page: null, parentId: null }],
        quality: { status: 'complete', warnings: [] },
      },
    },
    at,
  );
  await settleLocalCopies(processing);
}

async function prepare(ttl = 3600) {
  const now = Date.now();
  const fileId = '82c60bee-5296-4d5b-8abe-f09a6f3380d7';
  await managedSource(fileId, now);
  sourceTextBytes = (await mongoose.models.UploadCounter.collection.findOne({
    _id: 'global' as never,
  }))!.value.textBytes;
  expect(sourceTextBytes).toBeGreaterThan(0);
  const session = await mongoose.startSession();
  let binding: CheckpointSourceBinding;
  try {
    session.startTransaction();
    ({ binding } = await createCheckpointSourceMethods(mongoose).captureCheckpointSources(
      owner,
      { fileIds: [fileId], messages: [] },
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
  };
}
const config = { configurable: { thread_id: scope.threadId, checkpoint_ns: '' } };
async function charged() {
  const total = (await mongoose.models.UploadCounter.collection.findOne({
    _id: 'global' as never,
  }))!.value.textBytes as number;
  expect(total).toBeGreaterThanOrEqual(sourceTextBytes);
  return total - sourceTextBytes;
}
async function bytes() {
  let sum = 0;
  for (const name of names) {
    const rows = await mongoose.connection
      .db!.collection(name)
      .aggregate([
        {
          $project: {
            bytes: { $bsonSize: '$$ROOT' },
            receipt: '$lc_retained_allocations',
            upserted_at: 1,
          },
        },
      ])
      .toArray();
    for (const row of rows) {
      expect(row).not.toHaveProperty('upserted_at');
      expect(row.receipt).toEqual([
        { fileId: '82c60bee-5296-4d5b-8abe-f09a6f3380d7', bytes: row.bytes },
      ]);
      sum += row.bytes;
    }
  }
  expect(await charged()).toBe(sum);
  const file = await mongoose.models.File.collection.findOne({
    file_id: '82c60bee-5296-4d5b-8abe-f09a6f3380d7',
  });
  expect(file?.retainedDerivativeBytes).toBe(sum);
  return sum;
}
it.each(['missing', 'malformed'] as const)(
  'holds an invalid prior recovery deadline: %s',
  async (kind) =>
    run(async () => {
      const { saver } = await prepare(60);
      const checkpoint = emptyCheckpoint();
      await saver.put(config, checkpoint, metadata);
      const rows = mongoose.connection.db!.collection(names[0]);
      await rows.updateOne(
        {},
        kind === 'missing'
          ? { $unset: { lc_source_expires_at: '' } }
          : { $set: { lc_source_expires_at: 'unknown' } },
      );
      const before = await rows.findOne({});
      const quota = await mongoose.models.UploadCounter.findById('global').lean();
      await expect(saver.put(config, checkpoint, metadata)).rejects.toThrow();
      expect(await rows.findOne({})).toEqual(before);
      expect(await mongoose.models.UploadCounter.findById('global').lean()).toEqual(quota);
    }),
);

it('keeps the original row recovery deadline when checkpoint and special pending slots are rewritten', async () =>
  run(async () => {
    const { saver, binding } = await prepare(60);
    const checkpoint = emptyCheckpoint();
    const saved = await saver.put(config, checkpoint, metadata);
    await saver.putWrites(saved, [[ERROR, 'original']], 'special');
    const db = mongoose.connection.db!;
    const before = await Promise.all(names.map((name) => db.collection(name).findOne({})));
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000);
    try {
      await saver.put(config, checkpoint, metadata);
      await saver.putWrites(saved, [[ERROR, 'changed']], 'special');
    } finally {
      clock.mockRestore();
    }
    const after = await Promise.all(names.map((name) => db.collection(name).findOne({})));
    for (let index = 0; index < names.length; index++) {
      expect(after[index]!.lc_source_expires_at).toEqual(before[index]!.lc_source_expires_at);
      expect(after[index]!.lc_source_binding).toEqual(binding);
    }
    await bytes();
  }));

it('charges full checkpoint and pending BSON, preserves slot modes, and refunds exact receipts', async () =>
  run(async () => {
    const { saver, binding } = await prepare();
    const checkpoint = emptyCheckpoint();
    checkpoint.channel_values = { messages: ['synthetic source'] };
    const saved = await saver.put(config, checkpoint, {
      ...metadata,
      parents: { ['search copy'.repeat(20)]: 'parent' },
    });
    const first = await bytes();
    await saver.put(config, checkpoint, metadata);
    expect(await bytes()).toBeLessThan(first);
    await saver.putWrites(
      saved,
      [
        ['events', 'first'],
        [ERROR, 'mixed first'],
      ],
      'mixed',
    );
    const initial = await bytes();
    await saver.putWrites(
      saved,
      [
        ['events', 'replacement'],
        [ERROR, 'mixed replacement'],
      ],
      'mixed',
    );
    expect(await bytes()).toBe(initial);
    await saver.putWrites(saved, [[ERROR, 'long'.repeat(100)]], 'special');
    const larger = await bytes();
    await saver.putWrites(saved, [[ERROR, 'small']], 'special');
    expect(await bytes()).toBeLessThan(larger);
    await saver.putWrites(saved, [], 'empty');
    await bytes();
    const cp = await mongoose.connection.db!.collection(names[0]).findOne({});
    expect(cp?.lc_source_binding).toEqual(binding);
    expect(cp?.lc_source_expires_at.getTime()).toBeLessThanOrEqual(Date.parse(binding.expiresAt));
    const beforeRead = await bytes();
    expect((await saver.getTuple(saved))?.checkpoint.id).toBe(checkpoint.id);
    expect(await bytes()).toBe(beforeRead);
    await purgeCheckpointRows(
      { checkpointCollectionName: names[0], checkpointWritesCollectionName: names[1] },
      { lc_owner: checkpointOwnerNamespacePrefix(owner.userId, owner.tenantId) },
    );
    expect(await bytes()).toBe(0);
  }));
it('retains full physical slot uniqueness and rejects existing duplicates without deletion', async () => {
  const db = mongoose.connection.db!;
  await db.collection(names[0]).insertMany([
    { thread_id: 'a', checkpoint_ns: '', checkpoint_id: 'dup' },
    { thread_id: 'a', checkpoint_ns: '', checkpoint_id: 'dup' },
  ]);
  await expect(ordinary().put(config, emptyCheckpoint(), metadata)).rejects.toThrow();
  expect(await db.collection(names[0]).countDocuments()).toBe(2);
});
it('holds ordinary owned and unowned writes against charged checkpoint and pending slots', async () =>
  run(async () => {
    const { saver } = await prepare();
    const cp = emptyCheckpoint();
    const saved = await saver.put(config, cp, metadata);
    await saver.putWrites(saved, [[ERROR, 'original']], 'task');
    const before = await bytes();
    const row = await mongoose.connection.db!.collection(names[0]).findOne({});
    const raw = {
      configurable: {
        thread_id: row!.thread_id,
        checkpoint_ns: row!.checkpoint_ns,
        checkpoint_id: cp.id,
      },
    };
    await expect(ordinary().put(raw, cp, metadata)).rejects.toThrow();
    await expect(ordinary().putWrites(raw, [[ERROR, 'bad']], 'task')).rejects.toThrow();
    const unbound = new DurableMongoSaver({ ...ordinaryOptions(), scope });
    await expect(unbound.put(config, cp, metadata)).rejects.toThrow();
    await expect(unbound.putWrites(saved, [[ERROR, 'bad']], 'task')).rejects.toThrow();
    expect(await bytes()).toBe(before);
  }));
function ordinaryOptions() {
  return {
    client: mongoose.connection.getClient() as unknown as ConstructorParameters<
      typeof DurableMongoSaver
    >[0]['client'],
    dbName: mongoose.connection.db!.databaseName,
    checkpointCollectionName: names[0],
    checkpointWritesCollectionName: names[1],
  };
}
it('rolls back every pending row, source touch, quota and generation revision after a later row fails', async () =>
  run(async () => {
    const { saver, methods, admission, fileId } = await prepare();
    await mongoose.connection.db!.createCollection(names[1], {
      validator: { channel: { $ne: 'fail' } },
    });
    const previous = await mongoose.models.File.collection.findOne({ file_id: fileId });
    await expect(
      saver.putWrites(
        { configurable: { ...config.configurable, checkpoint_id: 'cp' } },
        [
          ['ok', 'first'],
          ['fail', 'second'],
        ],
        'task',
      ),
    ).rejects.toThrow();
    expect(await bytes()).toBe(0);
    expect(await mongoose.models.File.collection.findOne({ file_id: fileId })).toEqual(previous);
    expect(
      await mongoose.connection.db!.collection(CHECKPOINT_STORAGE_COLLECTION).countDocuments(),
    ).toBe(0);
    expect(await methods.getGenerationAdmission(admission)).toMatchObject({
      ok: true,
      value: { checkpointWriteRevision: 0 },
    });
  }));
it('aborts quota exhaustion and holds the failed writer after capacity returns', async () =>
  run(async () => {
    const { saver, methods, admission } = await prepare();
    await mongoose.models.UploadCounter.collection.updateOne(
      { _id: 'global' as never },
      { $set: { 'value.textBytes': 16 * 1073741824 } },
    );
    await expect(saver.put(config, emptyCheckpoint(), metadata)).rejects.toThrow();
    await mongoose.models.UploadCounter.collection.updateOne(
      { _id: 'global' as never },
      { $set: { 'value.textBytes': sourceTextBytes } },
    );
    await expect(saver.put(config, emptyCheckpoint(), metadata)).rejects.toThrow();
    expect(await bytes()).toBe(0);
    expect(await methods.getGenerationAdmission(admission)).toMatchObject({
      ok: true,
      value: { checkpointWriteRevision: 0 },
    });
  }));
it.each(['revoked', 'deleted-user', 'policy', 'replacement'])(
  'rejects current source/admission failure: %s',
  async (change) =>
    run(async () => {
      const { saver, fileId, methods, admission } = await prepare();
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
        await mongoose.connection
          .db!.collection('generationadmissions')
          .updateOne({ clientRequestId: 'request' }, { $set: { segmentId: 'other' } });
      await expect(saver.put(config, emptyCheckpoint(), metadata)).rejects.toThrow();
      expect(await bytes()).toBe(0);
      if (change !== 'replacement')
        expect(await methods.getGenerationAdmission(admission)).toMatchObject({
          ok: true,
          value: { checkpointWriteRevision: 0 },
        });
    }),
);
it('rejects wrong binding, absent admission and missing digest, and snapshots caller binding before await', async () =>
  run(async () => {
    const { options } = await prepare();
    expect(() => new DurableMongoSaver({ ...options, admission: undefined })).toThrow();
    expect(() => new DurableMongoSaver({ ...options, sourceBinding: undefined })).toThrow();
    expect(
      () =>
        new DurableMongoSaver({
          ...options,
          admission: {
            ...options.admission,
            continuation: {
              ...options.admission.continuation!,
              sourceBindingSha256: 'f'.repeat(64),
            },
          },
        }),
    ).toThrow();
    const mutable = JSON.parse(JSON.stringify(options.sourceBinding));
    const saver = new DurableMongoSaver({ ...options, sourceBinding: mutable });
    mutable.files[0].fileId = 'foreign';
    await saver.put(config, emptyCheckpoint(), metadata);
    expect(await bytes()).toBeGreaterThan(0);
  }));
it('conflicts with a revoke after the transaction source snapshot, without retaining any row', async () =>
  run(async () => {
    const { saver, fileId } = await prepare();
    const original = mongoose.mongo.Collection.prototype.updateOne;
    let raced = false;
    jest.spyOn(mongoose.mongo.Collection.prototype, 'updateOne').mockImplementation(async function (
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
    await expect(saver.put(config, emptyCheckpoint(), metadata)).rejects.toThrow();
    expect(raced).toBe(true);
    expect(await bytes()).toBe(0);
  }));
it('aborts a row when its shortened native TTL expires during settlement', async () =>
  run(async () => {
    const { saver } = await prepare(1);
    const original = mongoose.mongo.Collection.prototype.updateOne;
    let delayed = false;
    jest.spyOn(mongoose.mongo.Collection.prototype, 'updateOne').mockImplementation(async function (
      this: InstanceType<typeof mongoose.mongo.Collection>,
      filter,
      update,
      options,
    ) {
      const result = await original.call(this, filter, update, options);
      if (
        this.collectionName === names[0] &&
        options?.session &&
        !delayed &&
        !Array.isArray(update) &&
        update.$set?.['lc_retained_allocations.0.bytes']
      ) {
        delayed = true;
        await new Promise((resolve) => setTimeout(resolve, 1100));
      }
      return result;
    });
    await expect(saver.put(config, emptyCheckpoint(), metadata)).rejects.toThrow();
    expect(delayed).toBe(true);
    expect(await bytes()).toBe(0);
  }));
it('holds an unknown committed write and preserves exactly one liability for reconciliation', async () =>
  run(async () => {
    const { saver } = await prepare();
    const original = mongoose.mongo.ClientSession.prototype.commitTransaction;
    jest
      .spyOn(mongoose.mongo.ClientSession.prototype, 'commitTransaction')
      .mockImplementation(async function (this: mongoose.ClientSession) {
        await original.call(this);
        throw Object.assign(new Error('synthetic unknown commit'), {
          errorLabels: ['UnknownTransactionCommitResult'],
        });
      });
    const cp = emptyCheckpoint();
    await expect(saver.put(config, cp, metadata)).rejects.toThrow();
    const total = await bytes();
    expect(total).toBeGreaterThan(0);
    await expect(saver.put(config, cp, metadata)).rejects.toThrow();
    expect(await bytes()).toBe(total);
  }));

it('settles concurrent pending tasks and repeated special slots without duplicate liabilities', async () =>
  run(async () => {
    const { saver, options } = await prepare();
    const cp = emptyCheckpoint();
    const saved = await saver.put(config, cp, metadata);
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        saver.putWrites(saved, [['events', `result-${index}`]], `task-${index}`),
      ),
    );
    await saver.putWrites(
      saved,
      [
        [ERROR, 'first'],
        [ERROR, 'last'],
      ],
      'special',
    );
    const rows = await mongoose.connection.db!.collection(names[1]).find({}).toArray();
    expect(rows).toHaveLength(9);
    const special = rows.find((row) => row.task_id === 'special')!;
    expect(await saver.serde.loadsTyped(special.type, special.value.value())).toBe('last');
    const total = await bytes();
    await new DurableMongoSaver(options).put(config, cp, metadata);
    expect(await bytes()).toBe(total);
  }));

it('races an ordinary insertion against source insertion without creating an uncharged duplicate', async () =>
  run(async () => {
    const { saver } = await prepare();
    const cp = emptyCheckpoint();
    const sourceFree = new DurableMongoSaver({ ...ordinaryOptions(), scope });
    const results = await Promise.allSettled([
      saver.put(config, cp, metadata),
      sourceFree.put(config, cp, metadata),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rows = await mongoose.connection.db!.collection(names[0]).find({}).toArray();
    expect(rows).toHaveLength(1);
    if (rows[0].lc_source_binding) expect(await bytes()).toBeGreaterThan(0);
    else {
      expect(await charged()).toBe(0);
      expect(rows[0]).not.toHaveProperty('lc_retained_allocations');
    }
  }));

it.each(['checkpoint_ns', 'checkpoint_id'])(
  'preserves native rejection of null configurable.%s on put',
  async (field) => {
    await expect(
      ordinary().put(
        { configurable: { thread_id: 'thread', [field]: null } },
        emptyCheckpoint(),
        metadata,
      ),
    ).rejects.toThrow();
    expect(await mongoose.connection.db!.collection(names[0]).countDocuments()).toBe(0);
  },
);

it('enforces the full stored row limit after serialization and rolls back its provisional receipt', async () =>
  run(async () => {
    const { options } = await prepare();
    const saver = new DurableMongoSaver({ ...options, hardLimitBytes: 512 });
    const original = mongoose.mongo.Collection.prototype.updateOne;
    let reached = false;
    jest.spyOn(mongoose.mongo.Collection.prototype, 'updateOne').mockImplementation(function (
      this: InstanceType<typeof mongoose.mongo.Collection>,
      filter,
      update,
      options,
    ) {
      if (this.collectionName === names[0] && options?.session) reached = true;
      return original.call(this, filter, update, options);
    });
    await expect(saver.put(config, emptyCheckpoint(), metadata)).rejects.toThrow();
    expect(reached).toBe(true);
    expect(await bytes()).toBe(0);
  }));

it('preserves ordinary native thread deletion and rejects charged rows without refund or deletion', async () =>
  run(async () => {
    const plain = ordinary();
    const config = await plain.put(
      { configurable: { thread_id: 'ordinary' } },
      emptyCheckpoint(),
      metadata,
    );
    await plain.putWrites(config, [['events', 'ordinary']], 'task');
    await plain.deleteThread('ordinary');
    for (const name of names)
      expect(await mongoose.connection.db!.collection(name).countDocuments()).toBe(0);
    const { saver } = await prepare();
    const saved = await saver.put(
      { configurable: { thread_id: scope.threadId } },
      emptyCheckpoint(),
      metadata,
    );
    await saver.putWrites(saved, [['events', 'source']], 'task');
    const total = await bytes();
    const row = await mongoose.connection.db!.collection(names[0]).findOne({});
    await expect(plain.deleteThread(row!.thread_id)).rejects.toThrow('quota-aware');
    await expect(saver.deleteThread(scope.threadId)).rejects.toThrow();
    expect(await bytes()).toBe(total);
  }));

it('never deletes a source marker appearing after the raw deletion precheck', async () => {
  const plain = ordinary();
  await plain.put({ configurable: { thread_id: 'race-delete' } }, emptyCheckpoint(), metadata);
  const original = mongoose.mongo.Collection.prototype.deleteMany;
  let raced = false;
  jest.spyOn(mongoose.mongo.Collection.prototype, 'deleteMany').mockImplementation(async function (
    this: InstanceType<typeof mongoose.mongo.Collection>,
    filter,
    options,
  ) {
    if (this.collectionName === names[0] && !raced) {
      raced = true;
      await mongoose.connection
        .db!.collection(names[0])
        .updateOne({ thread_id: 'race-delete' }, { $set: { lc_source_binding: null } });
    }
    return original.call(this, filter, options);
  });
  await expect(plain.deleteThread('race-delete')).rejects.toThrow('quota-aware');
  expect(raced).toBe(true);
  expect(
    await mongoose.connection.db!.collection(names[0]).countDocuments({ lc_source_binding: null }),
  ).toBe(1);
});

it('holds insert-only replay after the retained pending row expires without changing its liability', async () =>
  run(async () => {
    const { saver, methods, admission, fileId } = await prepare(1);
    const saved = { configurable: { ...config.configurable, checkpoint_id: 'pending' } };
    await saver.putWrites(saved, [['events', 'first']], 'task');
    const total = await bytes();
    const row = await mongoose.connection.db!.collection(names[1]).findOne({});
    const file = await mongoose.models.File.collection.findOne({ file_id: fileId });
    const generation = await methods.getGenerationAdmission(admission);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(saver.putWrites(saved, [['events', 'replacement']], 'task')).rejects.toThrow();
    expect(await bytes()).toBe(total);
    expect(await mongoose.connection.db!.collection(names[1]).findOne({})).toEqual(row);
    expect(await mongoose.models.File.collection.findOne({ file_id: fileId })).toEqual(file);
    expect(await methods.getGenerationAdmission(admission)).toEqual(generation);
  }));
