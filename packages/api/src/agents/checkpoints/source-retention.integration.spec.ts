/** Synthetic retained rows and real Mongo/File quota transactions; no source producer or model. */
import mongoose from 'mongoose';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createModels,
  createUploadManagementRepository,
  tenantStorage,
} from '@librechat/data-schemas';
import type { CheckpointSourceBinding } from '@librechat/data-schemas';
import type { Document } from 'mongodb';
import {
  __resetCheckpointerForTests,
  deleteAgentEventCheckpointReference,
  deleteAgentEventCheckpointReferences,
  deleteAgentCheckpoint,
  deleteOwnedActorCheckpointScope,
  deleteOwnedAgentCheckpoints,
  purgeFileSourceCheckpoints,
} from '../checkpointer';
import { CHECKPOINT_STORAGE_COLLECTION, checkpointStorageKey } from './storage';
import { checkpointOwnerNamespacePrefix } from '../../stream/checkpoints';
import { checkpointTestEnvironment } from './__tests__/helpers/mongo';
import { purgeCheckpointRows } from './source-retention';

const owner = { userId: new mongoose.Types.ObjectId().toHexString(), tenantId: 'source-purge' };
const prefix = checkpointOwnerNamespacePrefix(owner.userId, owner.tenantId);
const cfg = {
  type: 'mongo' as const,
  checkpointCollectionName: 'purge_cp',
  checkpointWritesCollectionName: 'purge_writes',
};
const names = [cfg.checkpointWritesCollectionName, cfg.checkpointCollectionName];
const run = <T>(action: () => Promise<T>) =>
  tenantStorage.run({ tenantId: owner.tenantId }, action);
const exact = {
  thread_id: `${prefix}thread`,
  checkpoint_ns: `${prefix}scope`,
  checkpoint_id: 'checkpoint',
};
let mongo: MongoMemoryReplSet | undefined;
let scratch: string | undefined;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function binding(fileId: string): CheckpointSourceBinding {
  const expiresAt = '2025-01-01T00:00:00.000Z';
  const value = {
    version: 2 as const,
    owner,
    files: [{ fileId, bindingSha256: 'a'.repeat(64), expiresAt }],
    messages: [],
    expiresAt,
  };
  return { ...value, bindingSha256: createHash('sha256').update(canonical(value)).digest('hex') };
}
async function row(name: string, fileId = 'source', overrides: Document = {}): Promise<number> {
  const db = mongoose.connection.db!;
  const source = binding(fileId);
  const id = new mongoose.Types.ObjectId();
  await db.collection(name).insertOne({
    _id: id,
    ...exact,
    lc_owner: prefix,
    checkpoint: Buffer.alloc(1024, 7),
    value: Buffer.from('synthetic opaque pending'),
    lc_source_binding: source,
    lc_source_file_ids: [fileId],
    lc_source_expires_at: new Date(source.expiresAt),
    lc_retained_allocations: [{ fileId, bytes: 1 }],
    ...overrides,
  });
  const [size] = await db
    .collection(name)
    .aggregate<{ bytes: number }>([
      { $match: { _id: id } },
      { $project: { bytes: { $bsonSize: '$$ROOT' } } },
    ])
    .toArray();
  await db
    .collection(name)
    .updateOne({ _id: id }, { $set: { 'lc_retained_allocations.0.bytes': size.bytes } });
  await mongoose.models.File.collection.updateOne(
    { file_id: fileId },
    {
      $setOnInsert: {
        file_id: fileId,
        user: new mongoose.Types.ObjectId(owner.userId),
        tenantId: owner.tenantId,
        retentionAcceptedAt: new Date('2024-12-01'),
        expiredAt: new Date(source.expiresAt),
        deletionRequestedAt: new Date('2025-01-02'),
      },
      $inc: { retainedDerivativeBytes: size.bytes },
    },
    { upsert: true },
  );
  await mongoose.models.UploadCounter.collection.updateOne(
    { _id: 'global' as never },
    {
      $inc: { 'value.textBytes': size.bytes, 'value.baseline.textBytes': size.bytes },
    },
  );
  return size.bytes;
}
async function charged(): Promise<number> {
  return (await mongoose.models.UploadCounter.collection.findOne({ _id: 'global' as never }))!.value
    .textBytes;
}
async function unrelatedRows(count: number): Promise<number> {
  const bytes = await row(names[0], 'unrelated');
  const collection = mongoose.connection.db!.collection(names[0]);
  const template = (await collection.findOne({ lc_source_file_ids: 'unrelated' }))!;
  // ObjectIds have a fixed BSON size, so these real stored copies retain the same receipt.
  await collection.insertMany(
    Array.from({ length: count - 1 }, () => ({
      ...template,
      _id: new mongoose.Types.ObjectId(),
    })),
  );
  const additional = bytes * (count - 1);
  await mongoose.models.File.collection.updateOne(
    { file_id: 'unrelated' },
    { $inc: { retainedDerivativeBytes: additional } },
  );
  await mongoose.models.UploadCounter.collection.updateOne(
    { _id: 'global' as never },
    { $inc: { 'value.textBytes': additional, 'value.baseline.textBytes': additional } },
  );
  return bytes * count;
}
async function counts(): Promise<number[]> {
  return Promise.all(
    names.map((name) => mongoose.connection.db!.collection(name).countDocuments()),
  );
}
beforeAll(async () => {
  const environment = checkpointTestEnvironment();
  scratch = await mkdtemp(join(environment.scratchRoot, 'checkpoint-source-purge-'));
  await mkdir(join(scratch, 'mongo'), { mode: 0o700 });
  mongo = await MongoMemoryReplSet.create({
    binary: environment.binary,
    instanceOpts: [{ dbPath: join(scratch, 'mongo'), args: ['--nounixsocket'] }],
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  await mongoose.connect(mongo.getUri('checkpoint_source_purge'));
  createModels(mongoose);
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}, 60000);
beforeEach(async () => {
  __resetCheckpointerForTests();
  await createUploadManagementRepository(mongoose, {
    enabled: false,
    reconciled: true,
  }).initialize();
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

it('atomically releases both actual BSON liabilities once, including expired/revoked files without a live User', async () =>
  run(async () => {
    const bytes = (await row(names[0])) + (await row(names[1]));
    expect(await charged()).toBe(bytes);
    expect(await mongoose.models.User.countDocuments()).toBe(0);
    await purgeCheckpointRows(cfg, exact);
    expect(await counts()).toEqual([0, 0]);
    expect(await charged()).toBe(0);
    expect(
      (await mongoose.models.File.collection.findOne({ file_id: 'source' }))!
        .retainedDerivativeBytes,
    ).toBe(0);
    await purgeCheckpointRows(cfg, exact);
    expect(await charged()).toBe(0);
  }));

it('rolls back the quota refund and first deletion when the second collection fails, then replays once', async () =>
  run(async () => {
    const bytes = (await row(names[0])) + (await row(names[1]));
    const original = mongoose.mongo.Collection.prototype.deleteMany;
    const deletion = jest
      .spyOn(mongoose.mongo.Collection.prototype, 'deleteMany')
      .mockImplementation(function (
        this: InstanceType<typeof mongoose.mongo.Collection>,
        filter,
        options,
      ) {
        if (this.collectionName === names[1] && options?.session)
          return Promise.reject(new Error('synthetic interrupted delete'));
        return original.call(this, filter, options);
      });
    await expect(purgeCheckpointRows(cfg, exact)).rejects.toThrow('synthetic interrupted delete');
    expect(await counts()).toEqual([1, 1]);
    expect(await charged()).toBe(bytes);
    deletion.mockRestore();
    await purgeCheckpointRows(cfg, exact);
    expect(await counts()).toEqual([0, 0]);
    expect(await charged()).toBe(0);
  }));

const malformed: Array<[string, Document]> = [
  ['partial', { $unset: { lc_source_binding: '' } }],
  ['null marker', { $set: { lc_source_binding: null } }],
  ['foreign owner', { $set: { lc_owner: `${prefix}foreign` } }],
  ['foreign physical thread', { $set: { thread_id: 'foreign' } }],
  ['source IDs', { $set: { lc_source_file_ids: ['other'] } }],
  ['string expiry', { $set: { lc_source_expires_at: '2025-01-01' } }],
  ['later expiry', { $set: { lc_source_expires_at: new Date('2030-01-01') } }],
  ['native TTL', { $set: { upserted_at: null } }],
  ['wrong receipt', { $inc: { 'lc_retained_allocations.0.bytes': 1 } }],
  ['wrong allocation file', { $set: { 'lc_retained_allocations.0.fileId': 'other' } }],
  ['unknown allocation field', { $set: { 'lc_retained_allocations.0.extra': true } }],
  ['oversized metadata', { $set: { lc_source_binding: 'x'.repeat(70000) } }],
];
it.each(malformed)(
  'holds %s without any refund or payload deserialization',
  async (_label, update) =>
    run(async () => {
      const bytes = (await row(names[0])) + (await row(names[1]));
      await mongoose.connection.db!.collection(names[1]).updateOne({}, update);
      await expect(purgeCheckpointRows(cfg, {})).rejects.toThrow();
      expect(await counts()).toEqual([1, 1]);
      expect(await charged()).toBe(bytes);
    }),
);

it.each(['missing file', 'insufficient file balance', 'unreconciled counter'])(
  'rolls back %s',
  async (kind) =>
    run(async () => {
      const bytes = (await row(names[0])) + (await row(names[1]));
      if (kind === 'missing file') await mongoose.models.File.collection.deleteMany({});
      if (kind === 'insufficient file balance')
        await mongoose.models.File.collection.updateOne(
          {},
          { $set: { retainedDerivativeBytes: 0 } },
        );
      if (kind === 'unreconciled counter')
        await mongoose.models.UploadCounter.collection.updateOne(
          { _id: 'global' as never },
          { $set: { 'value.reconciled': false } },
        );
      await expect(purgeCheckpointRows(cfg, exact)).rejects.toThrow();
      expect(await counts()).toEqual([1, 1]);
      expect(await charged()).toBe(bytes);
    }),
);

const deletions: Array<[string, () => Promise<unknown>]> = [
  [
    'exact reference',
    () =>
      deleteAgentEventCheckpointReference(
        {
          threadId: exact.thread_id,
          checkpointNs: exact.checkpoint_ns,
          checkpointId: exact.checkpoint_id,
        },
        cfg,
        prefix,
      ),
  ],
  [
    'reference batch',
    () =>
      deleteAgentEventCheckpointReferences(
        [
          {
            threadId: exact.thread_id,
            checkpointNs: exact.checkpoint_ns,
            checkpointId: exact.checkpoint_id,
          },
        ],
        prefix,
        cfg,
      ),
  ],
  [
    'captured generation',
    () =>
      deleteAgentCheckpoint(
        exact.thread_id,
        cfg,
        {
          threadId: exact.thread_id,
          checkpointNamespace: exact.checkpoint_ns,
          checkpointIds: [exact.checkpoint_id],
        },
        { throwOnError: true },
      ),
  ],
  [
    'namespace generation',
    () =>
      deleteAgentCheckpoint(exact.thread_id, cfg, undefined, {
        throwOnError: true,
        checkpointNamespace: exact.checkpoint_ns,
      }),
  ],
  ['owned actor', () => deleteOwnedActorCheckpointScope('thread', 'scope', prefix, cfg)],
  [
    'owner cleanup',
    () => deleteOwnedAgentCheckpoints(owner.userId, owner.tenantId, ['thread'], cfg),
  ],
];
it.each(deletions)('routes %s through the same real refund transaction', async (_label, action) =>
  run(async () => {
    await row(names[0]);
    await row(names[1]);
    for (const name of names)
      await mongoose.connection
        .db!.collection(name)
        .insertOne({ ...exact, thread_id: 'foreign', lc_owner: 'foreign' });
    await action();
    expect(await counts()).toEqual([1, 1]);
    expect(await charged()).toBe(0);
  }),
);

it('keeps owner/tenant neighbors and legacy source-free rows under the caller scope', async () =>
  run(async () => {
    const bytes = await row(names[0]);
    await purgeCheckpointRows(cfg, { lc_owner: 'foreign' });
    expect(await charged()).toBe(bytes);
    await deleteAgentCheckpoint(exact.thread_id, cfg, undefined, { throwOnError: true });
    expect(await charged()).toBe(bytes);
    await deleteOwnedAgentCheckpoints(owner.userId, 'foreign-tenant', undefined, cfg);
    expect(await charged()).toBe(bytes);
  }));

it('uses metadata-only projections for large opaque payloads and bounds each returned batch', async () =>
  run(async () => {
    await row(names[0], 'large', { checkpoint: Buffer.alloc(4 * 1024 * 1024) });
    const aggregate = jest.spyOn(mongoose.mongo.Collection.prototype, 'aggregate');
    await purgeCheckpointRows(cfg, exact);
    const reads = aggregate.mock.calls.filter(
      (args) => args[1]?.session && args[0]?.some((step) => step.$project?.meta),
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const [pipeline] of reads) {
      expect(JSON.stringify(pipeline)).toContain('$bsonSize');
      expect(pipeline!.find((step) => step.$project?.meta)?.$project.meta).not.toHaveProperty(
        'checkpoint',
      );
      expect(pipeline!.find((step) => step.$project?.meta)?.$project.meta).not.toHaveProperty(
        'value',
      );
    }
    expect(await charged()).toBe(0);
  }));

it('purges only requested file copies across registered stores and retains unrelated sources', async () =>
  run(async () => {
    const other = {
      ...cfg,
      checkpointCollectionName: 'old_cp',
      checkpointWritesCollectionName: 'old_writes',
    };
    await mongoose.connection.db!.collection(CHECKPOINT_STORAGE_COLLECTION).insertOne({
      _id: `${prefix}${checkpointStorageKey(other)}` as never,
      owner: prefix,
      storage: other,
    });
    await row(names[0], 'target');
    const retained = await row(names[1], 'unrelated');
    await row(other.checkpointCollectionName, 'target');
    await purgeFileSourceCheckpoints(owner, ['target'], cfg);
    expect(await counts()).toEqual([0, 1]);
    expect(await mongoose.connection.db!.collection('old_cp').countDocuments()).toBe(0);
    expect(await charged()).toBe(retained);
    await purgeFileSourceCheckpoints(owner, ['target'], cfg);
    expect(await charged()).toBe(retained);
  }));

it('holds file finalization on partial marked owner inventory, even without a matching file ID', async () =>
  run(async () => {
    await mongoose.connection
      .db!.collection(names[0])
      .insertOne({ ...exact, lc_owner: prefix, lc_source_binding: null });
    await expect(purgeFileSourceCheckpoints(owner, ['target'], cfg)).rejects.toThrow();
    expect(await counts()).toEqual([1, 0]);
  }));

it('reaches a requested source after 1024 unrelated copies and confirms absence on replay', async () =>
  run(async () => {
    const retained = await unrelatedRows(1024);
    const removed = await row(names[0], 'target');
    expect(await charged()).toBe(retained + removed);
    await purgeFileSourceCheckpoints(owner, ['target'], cfg);
    expect(await counts()).toEqual([1024, 0]);
    expect(
      await mongoose.connection.db!.collection(names[0]).countDocuments({
        lc_source_file_ids: 'target',
      }),
    ).toBe(0);
    expect(await charged()).toBe(retained);
    expect(
      (await mongoose.models.File.collection.findOne({ file_id: 'unrelated' }))!
        .retainedDerivativeBytes,
    ).toBe(retained);
    expect(
      (await mongoose.models.File.collection.findOne({ file_id: 'target' }))!
        .retainedDerivativeBytes,
    ).toBe(0);
    await purgeFileSourceCheckpoints(owner, ['target'], cfg);
    expect(await counts()).toEqual([1024, 0]);
    expect(await charged()).toBe(retained);
  }));

it('holds malformed custody after a large valid unrelated inventory without refunding it', async () =>
  run(async () => {
    const retained = await unrelatedRows(1024);
    const removed = await row(names[0], 'target');
    await mongoose.connection.db!.collection(names[0]).insertOne({
      ...exact,
      lc_owner: prefix,
      lc_source_binding: null,
    });
    await expect(purgeFileSourceCheckpoints(owner, ['target'], cfg)).rejects.toThrow();
    expect(await counts()).toEqual([1026, 0]);
    expect(await charged()).toBe(retained + removed);
  }));

it('holds the next batch when the monotonic cleanup deadline expires', async () =>
  run(async () => {
    const retained = await unrelatedRows(17);
    const removed = await row(names[0], 'target');
    const actualNow = performance.now.bind(performance);
    let elapsed = 0;
    const clock = jest.spyOn(performance, 'now').mockImplementation(() => actualNow() + elapsed);
    const commit = mongoose.mongo.ClientSession.prototype.commitTransaction;
    const committed = jest
      .spyOn(mongoose.mongo.ClientSession.prototype, 'commitTransaction')
      .mockImplementation(async function (this: mongoose.ClientSession) {
        await commit.call(this);
        elapsed = 10001;
      });
    await expect(purgeFileSourceCheckpoints(owner, ['target'], cfg)).rejects.toThrow();
    expect(committed).toHaveBeenCalledTimes(1);
    clock.mockRestore();
    committed.mockRestore();
    expect(await counts()).toEqual([18, 0]);
    expect(await charged()).toBe(retained + removed);
    await purgeFileSourceCheckpoints(owner, ['target'], cfg);
    expect(await counts()).toEqual([17, 0]);
    expect(await charged()).toBe(retained);
  }));

it('does not skip a requested row when an earlier retained neighbor disappears between batches', async () =>
  run(async () => {
    for (let i = 0; i < 16; i++) await row(names[0], `neighbor-${i}`);
    await row(names[0], 'target');
    const first = await mongoose.connection
      .db!.collection(names[0])
      .findOne({}, { sort: { _id: 1 } });
    const commit = mongoose.mongo.ClientSession.prototype.commitTransaction;
    let firstBatch = true;
    jest
      .spyOn(mongoose.mongo.ClientSession.prototype, 'commitTransaction')
      .mockImplementation(async function (this: mongoose.ClientSession) {
        await commit.call(this);
        if (firstBatch) {
          firstBatch = false;
          await mongoose.connection.db!.collection(names[0]).deleteOne({ _id: first!._id });
        }
      });
    await purgeFileSourceCheckpoints(owner, ['target'], cfg);
    expect(
      await mongoose.connection
        .db!.collection(names[0])
        .countDocuments({ lc_source_file_ids: 'target' }),
    ).toBe(0);
    expect(await mongoose.connection.db!.collection(names[0]).countDocuments()).toBe(15);
  }));

it('holds an unknown marked BSON identity instead of skipping it in the cursor', async () =>
  run(async () => {
    await mongoose.connection.db!.collection(names[0]).insertOne({
      _id: 'non-native' as never,
      ...exact,
      lc_owner: prefix,
      lc_source_binding: null,
    });
    await expect(purgeFileSourceCheckpoints(owner, ['target'], cfg)).rejects.toThrow();
    expect(await counts()).toEqual([1, 0]);
  }));

it('holds an unknown commit outcome and reconciles actual row absence on explicit replay', async () =>
  run(async () => {
    await row(names[0]);
    await row(names[1]);
    const commit = mongoose.mongo.ClientSession.prototype.commitTransaction;
    let committed = 0;
    const spy = jest
      .spyOn(mongoose.mongo.ClientSession.prototype, 'commitTransaction')
      .mockImplementation(async function (this: mongoose.ClientSession) {
        await commit.call(this);
        committed++;
        throw Object.assign(new Error('synthetic lost acknowledgement'), {
          hasErrorLabel: (label: string) => label === 'UnknownTransactionCommitResult',
        });
      });
    await expect(purgeCheckpointRows(cfg, exact)).rejects.toThrow();
    expect(committed).toBe(1);
    expect(await counts()).toEqual([0, 0]);
    expect(await charged()).toBe(0);
    spy.mockRestore();
    await purgeCheckpointRows(cfg, exact);
    expect(await charged()).toBe(0);
  }));
