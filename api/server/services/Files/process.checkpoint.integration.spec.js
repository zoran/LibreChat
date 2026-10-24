/**
 * Built-API foreground/File/HK composition with real Mongo accounting and generation drain.
 * Upload custody uses actual repository transitions; scanner/parser/census evidence, historical
 * lineage and checkpoint rows are fixtures. The external storage port removes actual private
 * scratch bytes before issuing its fixture receipt. No live S3, scanner or model runs.
 */
const mongoose = require('mongoose');
const { createHash, randomUUID } = require('node:crypto');
const { join, resolve, isAbsolute } = require('node:path');
const { mkdir, mkdtemp, rm, realpath, readFile, writeFile, unlink } = require('node:fs/promises');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const schemas = require('@librechat/data-schemas');
const api = require('@librechat/api');
const housekeeping = require('@librechat/api/housekeeping');
const {
  createSourceReplayIntent,
} = require('../../../../packages/api/src/stream/internal/sourceBudget');
const {
  createGenerationCleanupPort,
} = require('../../../../packages/api/src/stream/sourceCleanup');
const {
  captureManagedRetrievalInventoryEvidence,
  issueManagedRetrievalInventory,
} = require('../../../../packages/data-schemas/src/methods/fileRetrieval');
const {
  readHistoricalUploadDerivedOrigin,
  canonicalStorageDeletionReceipt,
} = require('librechat-data-provider');

// These adapters belong to unrelated upload/provider paths. None may be invoked here.
jest.mock('~/server/services/Files/images', () => ({}));
jest.mock('~/server/controllers/assistants/v2', () => ({}));
jest.mock('~/server/controllers/assistants/helpers', () => ({}));
jest.mock('~/server/services/Tools/credentials', () => ({}));
jest.mock('~/server/services/Config', () => ({}));
jest.mock('~/server/utils/getFileStrategy', () => ({}));
jest.mock('~/server/utils', () => ({}));
jest.mock('~/server/services/Files/Audio/STTService', () => ({}));
// No live upload application is needed by foreground revocation or the File/HK owner.
jest.mock('~/server/services/Uploads', () => ({ getUploadRuntime: () => undefined }));
jest.mock('~/server/services/Files/strategies', () => ({ getStrategyFunctions: jest.fn() }));
// Preserve the real File, Message and Agent methods while excluding unrelated app composition.
jest.mock('~/models', () => {
  const schema = require('@librechat/data-schemas');
  const connection = require('mongoose');
  schema.createModels(connection);
  return schema.createMethods(connection);
});

const db = require('~/models');
const { getStrategyFunctions } = require('./strategies');
const { processDeleteRequest } = require('./process');
const { GenerationJobManager: manager } = api;
const owner = { userId: '111111111111111111111111', tenantId: 'checkpoint-composition' };
const foreign = { ...owner, userId: '222222222222222222222222' };
const targets = ['root', 'child', 'leaf'];
const policy = 'b'.repeat(64);
const originalBytes = Buffer.from('x');
const originalSHA256 = createHash('sha256').update(originalBytes).digest('hex');
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
let uploads;
let jobs;
let generations;
let transport;
let originals;
let originalDirectory;

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
  const result = readHistoricalUploadDerivedOrigin({
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
        sha256: originalSHA256,
      },
      policySha256: policy,
      expiresAt,
    })),
  });
  expect(result).not.toBeNull();
  return result;
}

async function seedCheckpoint(name, fileId, scope, expiresAt) {
  const prefix = api.checkpointOwnerNamespacePrefix(scope.userId, scope.tenantId);
  const value = {
    version: 2,
    owner: scope,
    files: [{ fileId, bindingSha256: 'a'.repeat(64), expiresAt }],
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

async function acceptOriginal(fileId, scope) {
  const principal = { ...scope, authentication: 'verified-email' };
  const now = Date.now();
  const worker = { hostId: 'checkpoint-host', instanceId: 'checkpoint-intake' };
  await uploads.reserve(
    principal,
    {
      operationId: fileId,
      idempotencyKey: randomUUID(),
      mediaType: 'text/plain',
      declaredBytes: originalBytes.length,
      fingerprint: JSON.stringify([{ kind: 'personal' }, 'text/plain', originalBytes.length]),
    },
    now,
  );
  const lease = await uploads.claim({
    kind: 'transfer',
    principal,
    operationId: fileId,
    worker,
    now,
  });
  expect(lease).not.toBeNull();
  const execution = {
    version: 2,
    custody: { kind: 'none' },
    attemptId: `${fileId}.${lease.generation}`,
    instanceId: randomUUID(),
    executionId: randomUUID(),
    expiresAt: new Date(now + 60000).toISOString(),
  };
  await uploads.bindSecurityExecution(lease, execution, now);
  await uploads.settleSecurityExecution(
    lease,
    { execution, writerStopped: true, transientDataRemoved: true },
    now,
  );
  const receipt = {
    outcome: 'durable',
    source: 's3',
    bytes: originalBytes.length,
    filepath: `/api/files/download/${fileId}`,
    storageKey: `t/${scope.tenantId}/managed-uploads/${scope.userId}/${fileId}.${lease.generation}__original`,
    integrity: {
      version: 1,
      algorithm: 'sha256',
      sha256: originalSHA256,
      chunkBytes: 262144,
      chunkSha256: [originalSHA256],
    },
  };
  const path = join(originalDirectory, fileId);
  await writeFile(path, originalBytes, { flag: 'wx', mode: 0o600 });
  originals.set(fileId, { scope, path, receipt, generation: lease.generation });
  const approval = {
    version: 1,
    decision: 'approved',
    policySha256: policy,
    subject: {
      ...scope,
      operationId: fileId,
      transferGeneration: lease.generation,
      mediaType: 'text/plain',
      bytes: originalBytes.length,
      sha256: originalSHA256,
    },
    scannerVersion: 'explicit-checkpoint-fixture',
    checkedAt: new Date(now).toISOString(),
    coverage: { complete: true, pages: 1, parts: 1 },
  };
  const promotionId = randomUUID();
  const app = { hostId: 'checkpoint-host', instanceId: 'checkpoint-promotion' };
  await uploads.preparePromotion(
    {
      version: 1,
      promotionId,
      lease,
      worker: app,
      approval,
      integrity: receipt.integrity,
      metadata: { filename: `synthetic-${fileId}.txt` },
    },
    now,
  );
  await uploads.beginPromotion(lease, promotionId, app, now);
  await uploads.settlePromotion(
    {
      operationId: fileId,
      transferGeneration: lease.generation,
      promotionId,
      worker: app,
      writerStopped: true,
      receipt,
    },
    now,
  );
  await uploads.accept(
    principal,
    lease,
    receipt,
    approval,
    { filename: `synthetic-${fileId}.txt` },
    now,
  );
  await uploads.confirmCleanup(
    {
      operationId: fileId,
      generation: lease.generation,
      writerStopped: true,
      localCopiesAbsent: true,
      originalAbsent: false,
      textAndHistoryRemoved: false,
    },
    now,
  );
  // Accepted originals still own a charged processing queue entry. Complete that same
  // owner's publication and transient cleanup before reserving another fixture original.
  const processingNow = Date.now();
  const processing = await uploads.claim({
    kind: 'processing',
    principal,
    operationId: fileId,
    worker: { hostId: 'checkpoint-host', instanceId: 'checkpoint-processing' },
    now: processingNow,
  });
  expect(processing).not.toBeNull();
  expect((await uploads.getProcessingInput(processing, processingNow)).original).toEqual(receipt);
  await uploads.bindProcessingExecution(
    processing,
    {
      attemptId: `${fileId}.${processing.generation}`,
      instanceId: 'explicit-checkpoint-parser-fixture',
      expiresAt: new Date(processingNow + 60000).toISOString(),
    },
    processingNow,
  );
  const text = (await readFile(path)).toString('utf8');
  const structure = {
    version: 1,
    source: { sha256: originalSHA256, bytes: originalBytes.length, mediaType: 'text/plain' },
    extractor: { name: 'checkpoint-fixture', version: '1' },
    pages: [],
    elements: [
      { id: 'e1', kind: 'paragraph', start: 0, end: text.length, page: null, parentId: null },
    ],
    quality: { status: 'complete', warnings: [] },
  };
  await uploads.publish(processing, { text, structure, writerStopped: true }, Date.now());
  await uploads.confirmCleanup(
    {
      operationId: fileId,
      generation: processing.generation,
      writerStopped: true,
      localCopiesAbsent: true,
      originalAbsent: false,
      textAndHistoryRemoved: false,
    },
    Date.now(),
  );
  const operation = await mongoose.models.UploadOperation.collection.findOne({ _id: fileId });
  expect(operation).toMatchObject({
    state: 'ready',
    queueCharged: false,
    stagingHeld: false,
    writerStopped: true,
    cleanupPending: false,
    textBytes: Buffer.byteLength(text) + Buffer.byteLength(JSON.stringify(structure)),
  });
  expect(await rawFile(fileId)).toMatchObject({
    status: 'ready',
    text,
    documentStructure: structure,
  });
}

function composeCleanup(rows, physicalStarted, physicalGate) {
  const retention = schemas.createFileRetentionMethods(mongoose, { securityPolicySha256: policy });
  const lifecycle = schemas.createFileCleanupLifecycleMethods(
    mongoose,
    jobs,
    schemas.createUploadFileCleanupOwner(mongoose),
    retention,
    {
      // This fixture's explicit historical census has zero retrieval obligations. The actual
      // File authority must prove that fact; no success stub or external transport is used.
      purgeRetrieval: (who, ids) => retention.assertFileSourceDeletionReady(who, ids),
      purgeCheckpoints: (who, ids) => api.purgeFileSourceCheckpoints(who, ids, cfg),
      redactFileSourceContent: schemas.createMessageMethods(mongoose).redactFileSourceContent,
    },
  );
  const prepareSpy = jest.spyOn(lifecycle, 'commitConsumption');
  const finalize = lifecycle.finalize;
  const finalizeSpy = jest
    .spyOn(lifecycle, 'finalize')
    .mockImplementation(async (claim, signal) => {
      const result = await finalize(claim, signal);
      if (result.state === 'progress' && result.expected.phase === 'complete')
        events.push(`finalize:${claim.work.subject.fileId}`);
      return result;
    });
  function original(input) {
    const value = originals.get(input.operationId);
    expect(value).toBeDefined();
    expect(input).toMatchObject({ ...value.scope, generation: value.generation });
    return value;
  }
  const storage = {
    describeDeletion(input) {
      const value = original(input);
      const { obligationId: _obligationId, ...request } = input.request;
      return { ...request, bucket: 'private-checkpoint-fixture', key: value.receipt.storageKey };
    },
    async beginDeletion(input) {
      const value = original(input);
      expect(input.binding).toEqual(storage.describeDeletion(input));
      input.signal.throwIfAborted();
      expect(input.deadlineAtMs).toBeGreaterThan(Date.now());
      expect(await readFile(value.path)).toEqual(originalBytes);
      for (const row of rows.filter((entry) => entry.fileId === input.operationId))
        expect(
          await mongoose.connection.db.collection(row.name).findOne({ _id: row._id }),
        ).toBeNull();
      expect(
        (await rawFile(input.operationId)).retentionCleanup.lifecycle.derivatives,
      ).toMatchObject({
        retrieval: 'complete',
        checkpoints: 'complete',
        messages: 'complete',
      });
      events.push(`physical:${input.operationId}`);
      physicalStarted.release();
      await physicalGate.promise;
      input.signal.throwIfAborted();
      expect(input.deadlineAtMs).toBeGreaterThan(Date.now());
      await unlink(value.path);
      await expect(readFile(value.path)).rejects.toMatchObject({ code: 'ENOENT' });
      removedOriginals.add(input.operationId);
      value.terminal = {
        ...input.binding,
        state: 'durable_delete_complete',
        obligationId: randomUUID(),
        aggregateRevision: '1',
        proofSHA256: createHash('sha256')
          .update(
            canonical({
              binding: input.binding,
              privateOriginalSHA256: originalSHA256,
              privateOriginalAbsent: true,
            }),
          )
          .digest('hex'),
      };
      return value.terminal;
    },
    async observeDeletion(input) {
      const value = original(input);
      expect(value.terminal).toBeDefined();
      expect(input.binding).toEqual(storage.describeDeletion(input));
      await expect(readFile(value.path)).rejects.toMatchObject({ code: 'ENOENT' });
      return value.terminal;
    },
    async acknowledgeDeletionConsumed(input) {
      const value = original(input);
      expect(input.receipt).toEqual(value.terminal);
      await expect(readFile(value.path)).rejects.toMatchObject({ code: 'ENOENT' });
      const result = {
        state: 'recorded',
        obligationId: input.receipt.obligationId,
        receiptSHA256: createHash('sha256')
          .update(canonicalStorageDeletionReceipt(input.receipt))
          .digest('hex'),
        consumerCommitId: input.consumerCommitId,
      };
      const receiptPath = `${value.path}.consumed`;
      await writeFile(receiptPath, canonical(result), { flag: 'wx', mode: 0o600 });
      expect(await readFile(receiptPath, 'utf8')).toBe(canonical(result));
      return result;
    },
  };
  const progress = schemas.createFileCleanupProgressMethods(mongoose, jobs);
  const cleanup = housekeeping.createFileCleanupPort({
    entry: schemas.createFileCleanupClaimMethods(mongoose, jobs, retention),
    targets: progress,
    lifecycle,
    generations,
    storage,
    storageBudgetMs: 10000,
  });
  const claims = new Map();
  return {
    prepareSpy,
    finalizeSpy,
    claims,
    async drive() {
      // The in-memory transport has no abort subscription. Drive the existing manager owner
      // and await its actual source actors before HK consumes their settlement receipts.
      await manager.cleanup();
      await Promise.all([...manager.sourceCleanupFlights]);
      await progress.initialize();
      if (!claims.size) {
        for (let index = 0; index < targets.length; index++) {
          const claim = await jobs.claimNext('file.cleanup', {
            podUid: 'checkpoint-pod',
            incarnation: 'checkpoint-boot',
            source: 'checkpoint-fixture',
            hostId: 'checkpoint-host',
          });
          expect(claim).not.toBeNull();
          expect(targets).toContain(claim.work.subject.fileId);
          expect(claims.has(claim.work.subject.fileId)).toBe(false);
          claims.set(claim.work.subject.fileId, claim);
        }
      }
      const signal = new AbortController().signal;
      for (const fileId of [...targets].reverse()) {
        if ((await rawFile(fileId)).deletionCompletedAt) continue;
        const claim = claims.get(fileId);
        let outcome;
        for (let step = 0; step < 32; step++) {
          outcome = await cleanup.step(claim, signal);
          if (outcome.state !== 'progress') break;
        }
        if (outcome.state !== 'settled') return { fileId, outcome };
        expect(await jobs.observe(claim.jobId, claim.executionId)).toMatchObject({
          state: 'settled',
          claim: null,
          execution: { phase: 'complete' },
        });
      }
      return { complete: true };
    },
  };
}

async function seedFixture({ holdPhysical = false } = {}) {
  originalDirectory = await mkdtemp(join(scratch, 'originals-'));
  for (const fileId of [...targets, 'unrelated', 'foreign']) {
    const scope = fileId === 'foreign' ? foreign : owner;
    await acceptOriginal(fileId, scope);
  }
  const acceptedFiles = await Promise.all(targets.map(rawFile));
  const expires = Math.min(...acceptedFiles.map((file) => file.expiredAt.getTime()));
  // Historical v1 lineage is cleanup-only. Establish the original fixture's already-revoked
  // premise through the real File owner, including its canonical identities and HK projection.
  expect(await db.revokeFileSources(owner, targets)).toEqual({
    revokedFileIds: [...targets].sort(),
  });
  const trackedSince = new Date();
  for (const [fileId, ancestors, direct] of [
    ['child', ['root'], 'root'],
    ['leaf', ['root', 'child'], 'child'],
  ]) {
    await mongoose.models.File.collection.updateOne(
      { file_id: fileId },
      {
        $set: {
          expiredAt: new Date(expires),
          derivedOrigin: origin(ancestors, direct, expires),
          derivedRetention: {
            version: 1,
            ownDeadlineAt: new Date(expires),
            capBasis: 'legacy-baseline',
            trackedSince,
            deadlineGeneration: acceptedFiles.find((file) => file.file_id === fileId)
              .retentionActivity.deadlineGeneration,
          },
        },
        $unset: { retentionActivity: '' },
      },
    );
  }
  const rows = [];
  for (const fileId of [...targets, 'unrelated', 'foreign']) {
    // Explicit historical census fixture: absence of an Upload runtime is no inventory proof.
    const file = await rawFile(fileId);
    const evidence = captureManagedRetrievalInventoryEvidence(file);
    const observedAt = Date.now();
    const backend = {
      backendIdentity: 'synthetic-retired-backend',
      owner: evidence.owner,
      fileId,
      evidenceSha256: evidence.evidenceSha256,
      observedAt,
      complete: true,
      obligations: [],
    };
    const inventoryReceiptSha256 = createHash('sha256').update(canonical(backend)).digest('hex');
    const inventory = issueManagedRetrievalInventory(
      file,
      {
        reconciliationId: 'synthetic-checkpoint-census',
        storeId: 'synthetic-retired-store',
        revision: 0,
        observedAt,
        owner: evidence.owner,
        fileId,
        evidenceSha256: evidence.evidenceSha256,
        backends: [{ ...backend, inventoryReceiptSha256 }],
      },
      {
        topologySha256: '1'.repeat(64),
        writers: [
          { writerId: 'synthetic-retired-writer', retirementReceiptSha256: '2'.repeat(64) },
        ],
        backends: [{ backendIdentity: backend.backendIdentity, inventoryReceiptSha256 }],
      },
    );
    await mongoose.models.File.collection.updateOne(
      { file_id: fileId },
      { $set: { managedRetrieval: inventory } },
    );
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
  const originalSentinelOperations = await mongoose.models.UploadOperation.collection
    .find({ _id: { $in: ['unrelated', 'foreign'] } })
    .toArray();
  expect(originalSentinelOperations).toHaveLength(2);
  const physicalStarted = barrier();
  const physicalGate = barrier();
  if (!holdPhysical) physicalGate.release();
  const cleanup = composeCleanup(rows, physicalStarted, physicalGate);
  const job = await manager.createJob('source-stream', owner.userId, 'source-conversation', {
    trustedTenantId: owner.tenantId,
  });
  await manager.createJob('unrelated-stream', owner.userId, 'unrelated-conversation', {
    trustedTenantId: owner.tenantId,
  });
  // Restore an existing charged replay obligation through its canonical store identity.
  // Cleanup must not perform new live source admission for these historical rows.
  const persistedJob = await store.getJob(job.streamId);
  expect(persistedJob).not.toBeNull();
  const retained = await store.prepareSourceReplay(
    createSourceReplayIntent(persistedJob, ['root'], expires),
  );
  const receiptBytes = 256; // Existing File reservation receipt charge, retained until File cleanup.
  await mongoose.models.File.collection.updateOne(
    { file_id: 'root' },
    {
      $inc: { retainedDerivativeBytes: retained.receipt.bytes + receiptBytes },
      $push: {
        retainedDerivativeReservations: {
          reservationId: retained.receipt.reservationId,
          bytes: retained.receipt.bytes,
          state: 'held',
        },
      },
    },
  );
  await mongoose.models.UploadCounter.collection.updateOne(
    { _id: 'global' },
    {
      $inc: {
        'value.textBytes': retained.receipt.bytes + receiptBytes,
        'value.baseline.textBytes': retained.receipt.bytes + receiptBytes,
      },
    },
  );
  expect(await store.commitSourceReplay(retained)).toBe(true);
  const executionId = job.metadata.providerExecutionId;
  expect(await manager.beginProviderExecution(job.streamId, job.createdAt, executionId)).toBe(true);
  const aborted = barrier();
  job.abortController.signal.addEventListener('abort', aborted.release, { once: true });
  provider = { streamId: job.streamId, epoch: job.createdAt, executionId };
  const req = {
    user: { id: owner.userId, tenantId: owner.tenantId },
    config: { fileStrategy: 's3', endpoints: { agents: { checkpointer: cfg } } },
  };
  return {
    rows,
    req,
    root: await rawFile('root'),
    physicalStarted,
    physicalGate,
    aborted,
    ...cleanup,
    originalSentinels,
    originalSentinelOperations,
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
  const sentinelTextBytes = fixture.originalSentinelOperations.reduce(
    (bytes, operation) => bytes + operation.textBytes,
    0,
  );
  expect(await charged()).toBe(retained + sentinelTextBytes);
  expect(
    await mongoose.models.UploadOperation.collection
      .find({ _id: { $in: ['unrelated', 'foreign'] } })
      .toArray(),
  ).toEqual(fixture.originalSentinelOperations);
  expect((await store.getJob('source-stream')).sourceRetentionPurged).toBe(true);
  expect((await store.getJob('source-stream')).providerDrained).toBe(true);
  expect((await store.getJob('unrelated-stream')).status).toBe('running');
  expect(events.filter((event) => event.startsWith('finalize:'))).toEqual([
    'finalize:leaf',
    'finalize:child',
    'finalize:root',
  ]);
  expect(getStrategyFunctions).not.toHaveBeenCalled();
  expect([...removedOriginals].sort()).toEqual([...targets].sort());
  const completed = await db.observeFileCleanupCompletion(owner, targets, {
    deadlineAt: Date.now() + 5000,
    signal: new AbortController().signal,
  });
  expect(completed.map((value) => ({ fileId: value.fileId, state: value.state }))).toEqual(
    expect.arrayContaining(targets.map((fileId) => ({ fileId, state: 'complete' }))),
  );
  expect(completed).toHaveLength(targets.length);
  for (const fileId of targets) {
    const operation = await mongoose.models.UploadOperation.collection.findOne({ _id: fileId });
    expect(operation).toMatchObject({
      originalBytes: 0,
      originalRemoved: true,
      cleanupPending: false,
    });
    expect(operation.cleanupCustody.acceptedFileAck).toBeDefined();
    await expect(readFile(originals.get(fileId).path)).rejects.toMatchObject({ code: 'ENOENT' });
  }
  for (const fileId of ['unrelated', 'foreign'])
    expect(await readFile(originals.get(fileId).path)).toEqual(originalBytes);
  const message = await mongoose.models.Message.collection.findOne({
    messageId: 'synthetic-source-message',
  });
  expect(message.sourceContentRemovedAt).toBeInstanceOf(Date);
  expect(message.text).not.toContain('synthetic retained source excerpt');
}

beforeAll(async () => {
  if (
    typeof api.purgeFileSourceCheckpoints !== 'function' ||
    typeof housekeeping.createFileCleanupPort !== 'function' ||
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
  originals = new Map();
  originalDirectory = undefined;
  // Only this isolated fixture counter restores the existing replay liability.
  // No application feature flag or positive checkpoint writer is enabled.
  uploads = schemas.createUploadManagementRepository(mongoose, {
    enabled: true,
    reconciled: true,
    securityPolicySha256: policy,
    baseline: { originalBytes: 0, objectBytes: 0, textBytes: 0, recordBytes: 0, bundles: 0 },
  });
  await uploads.initialize();
  jobs = schemas.createHousekeepingStore(mongoose);
  await jobs.initialize();
  for (const scope of [owner, foreign])
    await run(() =>
      mongoose.models.User.create({
        _id: scope.userId,
        tenantId: scope.tenantId,
        email: `${scope.userId}@checkpoint.test`,
        emailVerified: true,
      }),
    );
  store = new api.InMemoryJobStore({ ttlAfterComplete: 60000 });
  transport = new api.InMemoryEventTransport();
  manager.configure({
    jobStore: store,
    eventTransport: transport,
    cleanupOnComplete: false,
  });
  manager.configureSourceReplay({
    quota: {
      reserveFileSourceCopies: db.reserveFileSourceCopies,
      releaseFileSourceCopies: db.releaseFileSourceCopies,
    },
  });
  manager.initialize();
  generations = createGenerationCleanupPort({
    store,
    transport: {
      purgeSourceRetention: (...args) => transport.purgeSourceRetention(...args),
      hasProviderDrain: (...args) => transport.hasProviderDrain(...args),
      emitAbortConfirmed: async (streamId, expectedCreatedAt) =>
        api.isStopConfirmed(
          await manager.abortJob(streamId, { expectedCreatedAt, awaitProviderDrain: true }),
        ),
    },
  });
});

afterEach(async () => {
  for (const gate of gates ?? []) gate.release();
  try {
    if (provider) await run(drainProvider);
    await bounded(Promise.allSettled(promises ?? []));
  } finally {
    await generations?.close();
    await manager.destroy();
    jest.restoreAllMocks();
    const existing = (await mongoose.connection.db?.collections()) ?? [];
    await Promise.all(existing.map((collection) => collection.deleteMany({})));
    if (originalDirectory) await rm(originalDirectory, { recursive: true, force: true });
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

test('awaits native provider drain, reports pending, then observes actual HK descendant completion once', async () =>
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
    const pending = await bounded(deletion);
    expect(pending.deletedFileIds).toEqual([]);
    expect(pending.failedFileIds.sort()).toEqual([...targets].sort());
    expect(settled).toBe(true);
    expect(removedOriginals.size).toBe(0);
    const cleanup = track(fixture.drive());
    await bounded(fixture.physicalStarted.promise);
    expect(fixture.prepareSpy).not.toHaveBeenCalled();
    expect(fixture.finalizeSpy).not.toHaveBeenCalled();
    // HK owns each original and its copies. The first descendant's checkpoint transaction
    // commits before that original's physical deletion, while the original itself is held.
    for (const row of fixture.rows.filter((entry) => entry.fileId === 'leaf')) {
      expect(
        await mongoose.connection.db.collection(row.name).findOne({ _id: row._id }),
      ).toBeNull();
    }
    for (const fileId of targets) {
      expect((await rawFile(fileId)).deletionCompletedAt).toBeFalsy();
      expect(await readFile(originals.get(fileId).path)).toEqual(originalBytes);
    }
    fixture.physicalGate.release();
    expect(await bounded(cleanup)).toEqual({ complete: true });
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
    const held = await bounded(track(fixture.drive()));
    expect(held).toEqual({ fileId: 'leaf', outcome: { state: 'unknown' } });
    expect(fixture.prepareSpy).not.toHaveBeenCalled();
    expect(fixture.finalizeSpy).not.toHaveBeenCalled();
    expect(removedOriginals.size).toBe(0);
    expect((await rawFile('leaf')).retentionCleanup.lifecycle.derivatives).toMatchObject({
      retrieval: 'complete',
      checkpoints: 'pending',
      messages: 'pending',
    });
    for (const fileId of targets) {
      const file = await rawFile(fileId);
      expect(file.deletionCompletedAt).toBeFalsy();
      expect(await readFile(originals.get(fileId).path)).toEqual(originalBytes);
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
    expect(message.sourceContentRemovedAt).toBeFalsy();
    expect(message.text).toContain('synthetic retained source excerpt');
    await collection.updateOne(
      { _id: invalid._id },
      { $set: { 'lc_retained_allocations.0.bytes': invalid.bytes } },
    );
    expect(await bounded(track(fixture.drive()))).toEqual({ complete: true });
    expect(await processDeleteRequest({ req: fixture.req, files: [fixture.root] })).toEqual({
      deletedFileIds: ['root'],
      failedFileIds: [],
    });
    await assertCompleted(fixture);
  }));
