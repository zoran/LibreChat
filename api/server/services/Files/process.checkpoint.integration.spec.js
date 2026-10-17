/**
 * Built-API deletion composition with real Mongo/File accounting and generation drain.
 * Existing retained originals, lineage and opaque checkpoint rows are synthetic fixtures;
 * only physical byte deletion is simulated. No positive upload, source writer or model runs.
 */
const mongoose = require('mongoose');
const { createHash } = require('node:crypto');
const { join, resolve, isAbsolute } = require('node:path');
const { mkdir, mkdtemp, rm, realpath } = require('node:fs/promises');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const schemas = require('@librechat/data-schemas');
const api = require('@librechat/api');
const { FileSources, readUploadDerivedOrigin } = require('librechat-data-provider');

// These adapters belong to unrelated upload/provider paths. None may be invoked here.
jest.mock('~/server/services/Files/images', () => ({}));
jest.mock('~/server/controllers/assistants/v2', () => ({}));
jest.mock('~/server/controllers/assistants/helpers', () => ({}));
jest.mock('~/server/services/Tools/credentials', () => ({}));
jest.mock('~/server/services/Config', () => ({}));
jest.mock('~/server/utils/getFileStrategy', () => ({}));
jest.mock('~/server/utils', () => ({}));
jest.mock('~/server/services/Files/Audio/STTService', () => ({}));
// Legacy retained originals have no active Upload operation or Upload runtime.
jest.mock('~/server/services/Uploads', () => ({ getUploadRuntime: () => undefined }));
jest.mock('~/server/services/Files/strategies', () => ({ getStrategyFunctions: jest.fn() }));
// Preserve the real File, Message and Agent methods while excluding unrelated app composition.
jest.mock('~/models', () => require('@librechat/data-schemas').createMethods(require('mongoose')));

const db = require('~/models');
const { getStrategyFunctions } = require('./strategies');
const { processDeleteRequest } = require('./process');
const { GenerationJobManager: manager } = api;
const owner = { userId: '111111111111111111111111', tenantId: 'checkpoint-composition' };
const foreign = { ...owner, userId: '222222222222222222222222' };
const targets = ['root', 'child', 'leaf'];
const cfg = {
  type: 'mongo',
  checkpointCollectionName: 'files_composition_checkpoints',
  checkpointWritesCollectionName: 'files_composition_writes',
};
const collections = [cfg.checkpointWritesCollectionName, cfg.checkpointCollectionName];
const run = (action) => schemas.tenantStorage.run({ tenantId: owner.tenantId }, action);
const rawFile = (fileId) => mongoose.models.File.collection.findOne({ file_id: fileId });
let mongo;
let scratch;
let store;
let provider;
let promises;
let gates;
let events;
let removedOriginals;

function barrier() {
  let release;
  const promise = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  const gate = { promise, release };
  gates.push(gate);
  return gate;
}

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Composition stage did not settle')), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function track(promise) {
  promises.push(promise);
  void promise.catch(() => undefined);
  return promise;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function origin(ids, direct, expiresAt) {
  const result = readUploadDerivedOrigin({
    version: 1,
    binding: { purpose: 'workspace-draft', sourceId: 'synthetic-workspace', sourceRevision: 0 },
    directSourceFileIds: [direct],
    ancestors: ids.map((fileId) => ({
      subject: {
        ...owner,
        operationId: fileId,
        transferGeneration: 1,
        mediaType: 'text/plain',
        bytes: 1,
        sha256: 'a'.repeat(64),
      },
      policySha256: 'b'.repeat(64),
      expiresAt,
    })),
  });
  expect(result).not.toBeNull();
  return result;
}

async function seedCheckpoint(name, fileId, scope, expiresAt) {
  const prefix = api.checkpointOwnerNamespacePrefix(scope.userId, scope.tenantId);
  const value = {
    version: 1,
    owner: scope,
    files: [{ fileId, approvalSha256: 'a'.repeat(64), expiresAt }],
    messages: [],
    expiresAt,
  };
  const binding = schemas.snapshotCheckpointSourceBinding(scope, {
    ...value,
    bindingSha256: createHash('sha256').update(canonical(value)).digest('hex'),
  });
  const collection = mongoose.connection.db.collection(name);
  const _id = new mongoose.Types.ObjectId();
  await collection.insertOne({
    _id,
    thread_id: `${prefix}thread-${fileId}`,
    checkpoint_ns: `${prefix}scope`,
    checkpoint_id: 'synthetic-checkpoint',
    lc_owner: prefix,
    checkpoint: Buffer.alloc(64, 7),
    value: Buffer.from('synthetic opaque pending write'),
    lc_source_binding: binding,
    lc_source_file_ids: [fileId],
    lc_source_expires_at: new Date(expiresAt),
    lc_retained_allocations: [{ fileId, bytes: 1 }],
  });
  const [size] = await collection
    .aggregate([{ $match: { _id } }, { $project: { bytes: { $bsonSize: '$$ROOT' } } }])
    .toArray();
  await collection.updateOne({ _id }, { $set: { 'lc_retained_allocations.0.bytes': size.bytes } });
  await mongoose.models.File.collection.updateOne(
    { file_id: fileId },
    { $inc: { retainedDerivativeBytes: size.bytes } },
  );
  await mongoose.models.UploadCounter.collection.updateOne(
    { _id: 'global' },
    { $inc: { 'value.textBytes': size.bytes, 'value.baseline.textBytes': size.bytes } },
  );
  return { _id, name, fileId, bytes: size.bytes, snapshot: await collection.findOne({ _id }) };
}

async function seedFixture({ holdPhysical = false } = {}) {
  const expires = Date.now() + 3600000;
  for (const fileId of [...targets, 'unrelated', 'foreign']) {
    const scope = fileId === 'foreign' ? foreign : owner;
    await db.createFile(
      {
        file_id: fileId,
        user: new mongoose.Types.ObjectId(scope.userId),
        tenantId: scope.tenantId,
        filename: `synthetic-${fileId}.txt`,
        filepath: `/synthetic/${fileId}`,
        bytes: 1,
        type: 'text/plain',
        source: FileSources.local,
      },
      true,
      { retention: { acceptedAt: new Date(Date.now() - 1000), expiredAt: new Date(expires) } },
    );
  }
  for (const [fileId, ancestors, direct] of [
    ['child', ['root'], 'root'],
    ['leaf', ['root', 'child'], 'child'],
  ]) {
    await mongoose.models.File.collection.updateOne(
      { file_id: fileId },
      { $set: { derivedOrigin: origin(ancestors, direct, expires) } },
    );
  }
  const rows = [];
  for (const fileId of [...targets, 'unrelated', 'foreign']) {
    for (const name of collections) {
      rows.push(
        await seedCheckpoint(
          name,
          fileId,
          fileId === 'foreign' ? foreign : owner,
          new Date(expires).toISOString(),
        ),
      );
    }
  }
  // Legacy message copy has no refund receipt; deletion must still redact its body.
  await mongoose.models.Message.collection.insertOne({
    messageId: 'synthetic-source-message',
    conversationId: 'synthetic-conversation',
    user: owner.userId,
    tenantId: owner.tenantId,
    text: 'synthetic retained source excerpt',
    sourceFileIds: ['root'],
    sourceExpiresAt: new Date(expires),
    __v: 0,
  });
  const originalSentinels = await Promise.all(['unrelated', 'foreign'].map(rawFile));
  const physicalStarted = barrier();
  const physicalGate = barrier();
  if (!holdPhysical) physicalGate.release();
  getStrategyFunctions.mockImplementation((source) => {
    expect(source).toBe(FileSources.local);
    return {
      deleteFile: async (_req, file) => {
        events.push(`physical:${file.file_id}`);
        physicalStarted.release();
        await physicalGate.promise;
        removedOriginals.add(file.file_id);
      },
    };
  });
  const prepare = db.prepareFileSourceDeletion;
  const finalize = db.finalizeFileSourceDeletion;
  const prepareSpy = jest
    .spyOn(db, 'prepareFileSourceDeletion')
    .mockImplementation(async (...args) => {
      for (const row of rows.filter((entry) => targets.includes(entry.fileId))) {
        expect(
          await mongoose.connection.db.collection(row.name).findOne({ _id: row._id }),
        ).toBeNull();
      }
      return prepare(...args);
    });
  const finalizeSpy = jest
    .spyOn(db, 'finalizeFileSourceDeletion')
    .mockImplementation(async (...args) => {
      const result = await finalize(...args);
      events.push(...result.completedFileIds.map((id) => `finalize:${id}`));
      return result;
    });
  const job = await manager.createJob('source-stream', owner.userId, 'source-conversation', {
    trustedTenantId: owner.tenantId,
  });
  await manager.createJob('unrelated-stream', owner.userId, 'unrelated-conversation', {
    trustedTenantId: owner.tenantId,
  });
  expect(
    await manager.bindSourceRetention(job.streamId, job.createdAt, {
      sourceFileIds: ['root'],
      sourceExpiresAt: new Date(expires),
    }),
  ).toBe(true);
  const executionId = job.metadata.providerExecutionId;
  expect(await manager.beginProviderExecution(job.streamId, job.createdAt, executionId)).toBe(true);
  const aborted = barrier();
  job.abortController.signal.addEventListener('abort', aborted.release, { once: true });
  provider = { streamId: job.streamId, epoch: job.createdAt, executionId };
  const req = {
    user: { id: owner.userId, tenantId: owner.tenantId },
    config: { fileStrategy: 'local', endpoints: { agents: { checkpointer: cfg } } },
  };
  return {
    rows,
    req,
    root: await rawFile('root'),
    physicalStarted,
    physicalGate,
    aborted,
    prepareSpy,
    finalizeSpy,
    originalSentinels,
  };
}

async function drainProvider() {
  return manager.markProviderExecutionDrained(
    provider.streamId,
    provider.epoch,
    provider.executionId,
  );
}

async function charged() {
  return (await mongoose.models.UploadCounter.collection.findOne({ _id: 'global' })).value
    .textBytes;
}

async function assertCompleted(fixture) {
  for (const row of fixture.rows) {
    const current = await mongoose.connection.db.collection(row.name).findOne({ _id: row._id });
    if (targets.includes(row.fileId)) expect(current).toBeNull();
    else expect(current).toEqual(row.snapshot);
  }
  for (const fileId of targets) {
    expect(await rawFile(fileId)).toMatchObject({
      deletionCompletedAt: expect.any(Date),
      retainedDerivativeBytes: 0,
    });
  }
  expect(await Promise.all(['unrelated', 'foreign'].map(rawFile))).toEqual(
    fixture.originalSentinels,
  );
  const retained = fixture.rows
    .filter((row) => !targets.includes(row.fileId))
    .reduce((bytes, row) => bytes + row.bytes, 0);
  expect(await charged()).toBe(retained);
  expect((await store.getJob('source-stream')).sourceRetentionPurged).toBe(true);
  expect((await store.getJob('source-stream')).providerDrained).toBe(true);
  expect((await store.getJob('unrelated-stream')).status).toBe('running');
  expect(events.filter((event) => event.startsWith('finalize:'))).toEqual([
    'finalize:leaf',
    'finalize:child',
    'finalize:root',
  ]);
}

beforeAll(async () => {
  if (
    typeof api.purgeFileSourceCheckpoints !== 'function' ||
    typeof schemas.snapshotCheckpointSourceBinding !== 'function' ||
    (await realpath(require.resolve('@librechat/api'))) !==
      (await realpath(resolve(__dirname, '../../../../packages/api/dist/index.cjs')))
  ) {
    throw new Error('The actual workspace API and schema checkpoint exports must be built');
  }
  const hosted = process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true';
  const scratchRoot =
    process.env.UPLOAD_TEST_TMPDIR ?? (hosted ? process.env.RUNNER_TEMP : undefined);
  const systemBinary = process.env.MONGOMS_SYSTEM_BINARY;
  if (!scratchRoot || !isAbsolute(scratchRoot)) throw new Error('Explicit test scratch required');
  if (
    systemBinary
      ? !isAbsolute(systemBinary) || process.env.MONGOMS_RUNTIME_DOWNLOAD !== 'false'
      : !hosted
  ) {
    throw new Error('Installed Mongo binary and disabled local downloads required');
  }
  scratch = await mkdtemp(join(scratchRoot, 'files-checkpoint-composition-'));
  await mkdir(join(scratch, 'mongo'), { mode: 0o700 });
  mongo = await MongoMemoryReplSet.create({
    binary: { version: '7.0.43', ...(systemBinary ? { systemBinary } : {}) },
    instanceOpts: [{ dbPath: join(scratch, 'mongo'), args: ['--nounixsocket'] }],
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });
  await mongoose.connect(mongo.getUri('files_checkpoint_composition'));
  schemas.createModels(mongoose);
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}, 60000);

beforeEach(async () => {
  gates = [];
  promises = [];
  provider = undefined;
  events = [];
  removedOriginals = new Set();
  // Only this isolated fixture counter admits the real initial replay reservation.
  // No application feature flag or positive checkpoint writer is enabled.
  await schemas
    .createUploadManagementRepository(mongoose, { enabled: true, reconciled: true })
    .initialize();
  store = new api.InMemoryJobStore({ ttlAfterComplete: 60000 });
  manager.configure({
    jobStore: store,
    eventTransport: new api.InMemoryEventTransport(),
    cleanupOnComplete: false,
  });
  manager.configureSourceReplay({
    quota: {
      reserveFileSourceCopies: db.reserveFileSourceCopies,
      releaseFileSourceCopies: db.releaseFileSourceCopies,
    },
  });
});

afterEach(async () => {
  for (const gate of gates ?? []) gate.release();
  try {
    if (provider) await run(drainProvider);
    await bounded(Promise.allSettled(promises ?? []));
  } finally {
    await manager.destroy();
    jest.restoreAllMocks();
    const existing = (await mongoose.connection.db?.collections()) ?? [];
    await Promise.all(existing.map((collection) => collection.deleteMany({})));
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

test('awaits native provider drain, purges actual copies, then finalizes the real descendant closure once', async () =>
  run(async () => {
    const fixture = await seedFixture({ holdPhysical: true });
    let settled = false;
    const deletion = track(processDeleteRequest({ req: fixture.req, files: [fixture.root] }));
    void deletion.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await bounded(fixture.aborted.promise);
    expect(settled).toBe(false);
    expect(fixture.prepareSpy).not.toHaveBeenCalled();
    expect(fixture.finalizeSpy).not.toHaveBeenCalled();
    expect(removedOriginals.size).toBe(0);
    for (const row of fixture.rows) {
      expect(await mongoose.connection.db.collection(row.name).findOne({ _id: row._id })).toEqual(
        row.snapshot,
      );
    }
    for (const fileId of targets) {
      const row = await rawFile(fileId);
      expect(row.deletionRequestedAt).toBeInstanceOf(Date);
      expect(row.deletionCompletedAt).toBeFalsy();
    }
    expect(await drainProvider()).toBe(true);
    await bounded(fixture.physicalStarted.promise);
    expect(settled).toBe(false);
    expect(fixture.prepareSpy).not.toHaveBeenCalled();
    for (const row of fixture.rows.filter((entry) => targets.includes(entry.fileId))) {
      expect(
        await mongoose.connection.db.collection(row.name).findOne({ _id: row._id }),
      ).toBeNull();
    }
    fixture.physicalGate.release();
    expect(await bounded(deletion)).toEqual({
      deletedFileIds: ['leaf', 'child', 'root'],
      failedFileIds: [],
    });
    await assertCompleted(fixture);
    const balance = await charged();
    expect(await processDeleteRequest({ req: fixture.req, files: [fixture.root] })).toEqual({
      deletedFileIds: ['root'],
      failedFileIds: [],
    });
    expect(await charged()).toBe(balance);
  }));

test('holds real File finalization on invalid checkpoint liability and reconciles an explicit retry', async () =>
  run(async () => {
    const fixture = await seedFixture();
    const invalid = fixture.rows.find(
      (row) => row.fileId === 'leaf' && row.name === cfg.checkpointCollectionName,
    );
    const collection = mongoose.connection.db.collection(invalid.name);
    await collection.updateOne(
      { _id: invalid._id },
      { $inc: { 'lc_retained_allocations.0.bytes': 1 } },
    );
    const deletion = track(processDeleteRequest({ req: fixture.req, files: [fixture.root] }));
    await bounded(fixture.aborted.promise);
    expect(await drainProvider()).toBe(true);
    const first = await bounded(deletion);
    expect(first.deletedFileIds).toEqual([]);
    expect(first.failedFileIds.sort()).toEqual([...targets].sort());
    expect(fixture.prepareSpy).not.toHaveBeenCalled();
    expect(fixture.finalizeSpy).not.toHaveBeenCalled();
    expect([...removedOriginals].sort()).toEqual([...targets].sort());
    for (const fileId of targets) {
      const file = await rawFile(fileId);
      expect(file.deletionCompletedAt).toBeFalsy();
      if (fileId !== 'root') expect(file.derivedOrigin).toBeDefined();
      const liability = fixture.rows
        .filter((row) => row.fileId === fileId)
        .reduce((sum, row) => sum + row.bytes, 0);
      expect(file.retainedDerivativeBytes).toBeGreaterThanOrEqual(liability);
    }
    for (const row of fixture.rows) {
      expect(
        await mongoose.connection.db.collection(row.name).countDocuments({ _id: row._id }),
      ).toBe(1);
    }
    const message = await mongoose.models.Message.collection.findOne({
      messageId: 'synthetic-source-message',
    });
    expect(message.sourceContentRemovedAt).toBeInstanceOf(Date);
    expect(message.text).not.toContain('synthetic retained source excerpt');
    await collection.updateOne(
      { _id: invalid._id },
      { $set: { 'lc_retained_allocations.0.bytes': invalid.bytes } },
    );
    expect(await processDeleteRequest({ req: fixture.req, files: [fixture.root] })).toEqual({
      deletedFileIds: ['leaf', 'child', 'root'],
      failedFileIds: [],
    });
    await assertCompleted(fixture);
  }));
