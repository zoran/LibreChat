/** Real Upload/File/HK transactions. Native storage/scanner and already-complete derivative custody are explicit fixtures. */
import mongoose from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { UPLOAD_AV_RECORD_BYTES, canonicalStorageDeletionReceipt } from 'librechat-data-provider';
import type { UploadLease } from 'librechat-data-provider';
import type { StoredUpload, CounterRow, GlobalState } from './uploadManagementStore';
import type { FileCleanupProgressResult } from '../types/fileCleanup';
import type { JobClaim } from '../types/housekeeping';
import type { IMongoFile } from '../types/file';
import {
  uploadSecurityFixture,
  bindUploadOriginalFixture,
  uploadSecuritySettlementFixture,
} from './uploadManagement.security.fixture';
import {
  prepareNonemptyFileCleanup,
  proveLiteralActorClosure,
} from './__tests__/helpers/fileUploadCleanup';
import {
  createUploadFileCleanupOwner,
  validateUploadFileCleanupMigration,
} from './uploadFileCleanup';
import { createFileCleanupLifecycleMethods } from './fileCleanupLifecycle';
import { createFileCleanupProgressMethods } from './fileCleanupProgress';
import { validateUploadCleanupCustody } from './uploadCleanupReceipts';
import { createUploadManagementRepository } from './uploadManagement';
import { readFileCleanupSnapshot } from './fileCleanupAuthority';
import { createHousekeepingStore } from './housekeepingStore';
import { createFileRetentionMethods } from './fileRetention';
import { tenantStorage } from '../config/tenantContext';
import { createModels } from '../models';

const observed = (result: FileCleanupProgressResult) => {
  if (result.state !== 'progress') throw Error(JSON.stringify(result));
  return result;
};
const signal = new AbortController().signal;
const unavailable = async (): Promise<never> => {
  throw Error('External derivative producer is outside this owner-join fixture');
};

describe('accepted File to Upload accounting owner join', () => {
  let mongo: MongoMemoryReplSet;
  const db = mongoose,
    other = new mongoose.Mongoose();
  const user = {
    tenantId: 'tenant',
    userId: new mongoose.Types.ObjectId().toString(),
    authentication: 'verified-email' as const,
  };
  const worker = { hostId: 'host', instanceId: 'writer' };
  const policy = 'c'.repeat(64);
  let repository: ReturnType<typeof createUploadManagementRepository>;
  let owner: ReturnType<typeof createUploadFileCleanupOwner>;
  let retention: ReturnType<typeof createFileRetentionMethods>;
  let jobs: ReturnType<typeof createHousekeepingStore>;
  let generation: ReturnType<typeof createFileCleanupProgressMethods>;
  let lifecycle: ReturnType<typeof createFileCleanupLifecycleMethods>;
  let claim: JobClaim, lease: UploadLease, now: number;
  const tx = async <T>(fn: (s: mongoose.ClientSession) => Promise<T>) => {
    const s = await db.startSession();
    try {
      return await s.withTransaction(() => fn(s));
    } finally {
      await s.endSession();
    }
  };
  const row = () => db.models.UploadOperation.findById('original').lean<StoredUpload>();
  const file = () =>
    db.models.File.findOne({ file_id: 'original', tenantId: user.tenantId, user: user.userId })
      .select('+retentionCleanup +retentionRevocationId +retainedDerivativeBytes +text')
      .lean<IMongoFile>();
  const totals = async () =>
    (await db.models.UploadCounter.findById('global').lean<CounterRow>())!.value as GlobalState;
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await Promise.all([
      db.connect(mongo.getUri('file-upload-ack')),
      other.connect(mongo.getUri('file-upload-ack')),
    ]);
    createModels(db);
    await db.models.File.init();
  });
  afterAll(async () => {
    await Promise.all([db.disconnect(), other.disconnect()]);
    await mongo?.stop();
  });
  beforeEach(async () => {
    now = Date.now();
    for (const name of [
      'User',
      'File',
      'Message',
      'UploadOperation',
      'UploadCounter',
      'HousekeepingJob',
      'FileCleanupTarget',
    ])
      if (db.models[name]) await db.models[name].deleteMany({});
    await db.models.User.create({
      _id: user.userId,
      tenantId: user.tenantId,
      email: 'ack@example.test',
      emailVerified: true,
    });
    repository = createUploadManagementRepository(db, {
      enabled: true,
      reconciled: true,
      securityPolicySha256: policy,
      baseline: { originalBytes: 0, objectBytes: 0, textBytes: 0, recordBytes: 0, bundles: 0 },
    });
    await repository.initialize();
    jobs = createHousekeepingStore(db);
    await jobs.initialize();
    owner = createUploadFileCleanupOwner(db);
    retention = createFileRetentionMethods(db, { securityPolicySha256: policy });
    generation = createFileCleanupProgressMethods(db, jobs);
    await generation.initialize();
    lifecycle = createFileCleanupLifecycleMethods(db, jobs, owner, retention, {
      purgeRetrieval: unavailable,
      purgeCheckpoints: unavailable,
      redactFileSourceContent: unavailable,
    });
    await repository.reserve(
      user,
      {
        operationId: 'original',
        idempotencyKey: randomUUID(),
        mediaType: 'text/plain',
        declaredBytes: 8,
        fingerprint: JSON.stringify([{ kind: 'personal' }, 'text/plain', 8]),
      },
      now,
    );
    lease = (await repository.claim({
      kind: 'transfer',
      principal: user,
      operationId: 'original',
      worker,
      now,
    }))!;
    const receipt = {
      outcome: 'durable' as const,
      source: 's3',
      bytes: 8,
      filepath: '/api/files/download/original',
      storageKey: `t/${user.tenantId}/managed-uploads/${user.userId}/original.${lease.generation}__original`,
      integrity: {
        version: 1 as const,
        algorithm: 'sha256' as const,
        sha256: 'a'.repeat(64),
        chunkBytes: 262144 as const,
        chunkSha256: ['b'.repeat(64)],
      },
    };
    const security = uploadSecurityFixture(
      uploadSecurityFixture({
        decision: 'approved' as const,
        policySha256: policy,
        subject: {
          tenantId: user.tenantId,
          userId: user.userId,
          operationId: 'original',
          transferGeneration: lease.generation,
          mediaType: 'text/plain',
          bytes: 8,
          sha256: receipt.integrity.sha256,
        },
        scannerVersion: 'explicit-fixture',
        checkedAt: new Date(now).toISOString(),
        coverage: { complete: true as const, pages: 1, parts: 1 },
      }).approval,
      {
        custody: { kind: 'none' as const },
        attemptId: `original.${lease.generation}`,
        instanceId: randomUUID(),
        executionId: randomUUID(),
        expiresAt: new Date(now + 60000).toISOString(),
      },
    );
    const execution = security.execution;
    await repository.bindSecurityExecution(lease, execution, now);
    await repository.settleSecurityExecution(
      lease,
      uploadSecuritySettlementFixture(execution, {
        writerStopped: true,
        transientDataRemoved: true,
      }),
      now,
    );

    const approval = uploadSecurityFixture({
      decision: 'approved' as const,
      policySha256: policy,
      subject: {
        tenantId: user.tenantId,
        userId: user.userId,
        operationId: 'original',
        transferGeneration: lease.generation,
        mediaType: 'text/plain',
        bytes: 8,
        sha256: receipt.integrity.sha256,
      },
      scannerVersion: 'explicit-fixture',
      checkedAt: new Date(now).toISOString(),
      coverage: { complete: true as const, pages: 1, parts: 1 },
    }).approval;
    // Actual promotion custody, independently settled from the Intake writer.
    const app = { hostId: 'app-host', instanceId: 'app-writer' },
      promotionId = randomUUID();
    await repository.preparePromotion(
      {
        version: 1,
        promotionId,
        lease,
        worker: app,
        approval,
        integrity: receipt.integrity,
        metadata: { filename: 'file.txt' },
      },
      now,
    );
    await repository.beginPromotion(lease, promotionId, app, now);
    await repository.settlePromotion(
      {
        operationId: 'original',
        transferGeneration: lease.generation,
        promotionId,
        worker: app,
        writerStopped: true,
        receipt,
      },
      now,
    );
    await bindUploadOriginalFixture(repository, lease, receipt, approval, now);
    await repository.accept(user, lease, receipt, approval, { filename: 'file.txt' }, now);
    await repository.confirmCleanup(
      {
        operationId: 'original',
        generation: lease.generation,
        writerStopped: true,
        localCopiesAbsent: true,
        originalAbsent: false,
        textAndHistoryRemoved: false,
      },
      now,
    );
    await tx((s) => retention.revokeManagedUpload(user, 'original', now + 1, s));
    claim = (await jobs.claimNext('file.cleanup', {
      podUid: 'pod',
      incarnation: 'boot',
      source: 'source',
      hostId: 'host',
    }))!;
    if (!claim) throw Error('Expected actual revoked File claim');
    await tx((s) =>
      jobs.advance(
        claim,
        { revision: claim.progressRevision, phase: 'awaiting_deadline' },
        { phase: 'revoked', code: 'progress' },
        s,
      ),
    );
  });
  async function bound() {
    return observed(await lifecycle.begin(claim, signal));
  }
  async function prepared(
    nonempty = false,
    beforeMessage?: Parameters<typeof prepareNonemptyFileCleanup>[0]['beforeMessage'],
  ) {
    await bound();
    let step = observed(await generation.beginCapture(claim, signal));
    expect(step.expected.phase).toBe('capturing_generations');
    expect(step.progress.capture).toEqual({
      cursor: null,
      complete: false,
      recoveryUnresolved: false,
    });
    if (nonempty) {
      const composed = await prepareNonemptyFileCleanup({
        db,
        user,
        now,
        claim,
        signal,
        owner,
        retention,
        jobs,
        generation,
        step,
        beforeMessage,
      });
      step = composed.step;
      lifecycle = composed.lifecycle;
    } else {
      step = observed(
        await generation.recordCapturePage(
          claim,
          step.expected,
          { targets: [], complete: true },
          signal,
        ),
      );
      step = observed(await generation.finishGenerationStage(claim, step.expected, signal));
      // This fixture starts at already-committed derivative owner custody. No derivative call is stubbed successful.
      await db.models.File.collection.updateOne(
        {
          file_id: 'original',
          tenantId: user.tenantId,
          user: new mongoose.Types.ObjectId(user.userId),
        },
        {
          $set: {
            'retentionCleanup.lifecycle.derivatives': {
              retrieval: 'complete',
              checkpoints: 'complete',
              messages: 'complete',
              messageCursor: null,
            },
          },
        },
      );
    }
    step = observed(await lifecycle.prepareStorage(claim, signal));
    const storage = step.progress.lifecycle!.storage!;
    if (storage.state !== 'binding')
      throw Error('Expected persisted request before storage binding');
    return observed(
      await lifecycle.bindStorage(
        claim,
        step.expected,
        {
          ...storage.request,
          bucket: 'originals',
          key: step.progress.lifecycle!.upload.originalKey,
        },
        signal,
      ),
    );
  }
  async function terminal(nonempty = false) {
    const step = await prepared(nonempty);
    const storage = step.progress.lifecycle!.storage!;
    if (storage.state !== 'observing') throw Error('Expected bound storage');
    return observed(
      await lifecycle.recordStorage(
        claim,
        step.expected,
        {
          ...storage.binding,
          state: 'durable_delete_complete',
          obligationId: 'native-fixture',
          aggregateRevision: '1',
          proofSHA256: 'e'.repeat(64),
        },
        signal,
      ),
    );
  }
  it('commits actual File preparation, exact Upload ACK and accounting once before consumption, retaining the charged tombstone', async () => {
    const before = await totals();
    const original = (await row())!.original;
    expect(tenantStorage.getStore()).toBeUndefined();
    await terminal(true);
    expect(tenantStorage.getStore()).toBeUndefined();
    const committed = observed(await lifecycle.commitConsumption(claim, signal));
    const storage = committed.progress.lifecycle!.storage!;
    if (storage.state !== 'committed') throw Error('Expected committed consumption intent');
    expect(storage.uploadAck).toEqual((await row())!.cleanupCustody!.acceptedFileAck);
    expect(storage.receiptSHA256).toBe(
      createHash('sha256').update(canonicalStorageDeletionReceipt(storage.receipt)).digest('hex'),
    );
    expect(await row()).toMatchObject({
      original,
      originalBytes: 0,
      textBytes: 0,
      originalRemoved: true,
      textRemoved: true,
      cleanupPending: false,
      recordBytes: UPLOAD_AV_RECORD_BYTES,
    });
    expect(await totals()).toMatchObject({
      originalBytes: before.originalBytes - 8,
      objectBytes: before.objectBytes - 8,
      recordBytes: before.recordBytes,
      bundles: before.bundles,
    });
    const once = await totals();
    const again = await tx((s) => owner.acknowledgeAcceptedFileCleanup({ claim }, s));
    expect(again).toEqual({ state: 'acknowledged', ack: storage.uploadAck });
    expect(await totals()).toEqual(once);
    await tx(async (s) => validateUploadFileCleanupMigration(db, (await row())!, s));
    const observedCommitted = observed(await lifecycle.observe(claim, signal));
    const consumed = observed(
      await lifecycle.recordConsumption(
        claim,
        observedCommitted.expected,
        {
          state: 'recorded',
          obligationId: storage.receipt.obligationId,
          receiptSHA256: storage.receiptSHA256,
          consumerCommitId: storage.consumerCommitId,
        },
        signal,
      ),
    );
    expect(consumed.progress.lifecycle!.storage!.state).toBe('consumed');
    expect(await tx((s) => owner.acknowledgeAcceptedFileCleanup({ claim }, s))).toEqual(again);
    observed(await lifecycle.finalize(claim, signal));
    expect((await file())!.deletionCompletedAt).toBeInstanceOf(Date);
    expect(await totals()).toEqual(once);
    await tx(async (s) => validateUploadFileCleanupMigration(db, (await row())!, s));
    const options = { deadlineAt: Date.now() + 5000, signal };
    const completion = await lifecycle.observeCompletion(user, ['original'], options);
    expect(completion).toEqual([
      { fileId: 'original', state: 'complete', completionRef: expect.any(String) },
    ]);
    expect(await jobs.model.findById(claim.jobId).lean()).toMatchObject({
      state: 'settled',
      claim: null,
      execution: { phase: 'complete' },
    });
    const savedFile = await db.models.File.collection.findOne({ file_id: 'original' });
    const savedUpload = await db.models.UploadOperation.collection.findOne({
      _id: 'original' as never,
    });
    for (const change of [
      { $set: { 'retentionCleanup.capture.complete': 'true' } },
      { $set: { 'retentionCleanup.lifecycle.contentPrepared': 1 } },
      { $set: { uploadOperationId: 'absent' } },
      { $unset: { retentionCleanup: '' } },
    ]) {
      await db.models.File.collection.updateOne({ _id: savedFile!._id }, change);
      expect(
        await lifecycle.observeCompletion(user, ['original'], {
          deadlineAt: Date.now() + 5000,
          signal,
        }),
      ).toEqual([{ fileId: 'original', state: 'unknown' }]);
      await db.models.File.collection.replaceOne({ _id: savedFile!._id }, savedFile!);
    }
    await db.models.UploadOperation.collection.updateOne(
      { _id: 'original' as never },
      { $unset: { 'cleanupCustody.acceptedFileAck': '' } },
    );
    expect(
      await lifecycle.observeCompletion(user, ['original'], {
        deadlineAt: Date.now() + 5000,
        signal,
      }),
    ).toEqual([{ fileId: 'original', state: 'unknown' }]);
    await db.models.UploadOperation.collection.replaceOne(
      { _id: 'original' as never },
      savedUpload!,
    );
    await jobs.model.updateOne({ _id: claim.jobId }, { $set: { 'execution.receiptRef': 'wrong' } });
    expect(
      await lifecycle.observeCompletion(user, ['original'], {
        deadlineAt: Date.now() + 5000,
        signal,
      }),
    ).toEqual([{ fileId: 'original', state: 'unknown' }]);
  });
  it('keeps matching ambient tenant scope and restores it after actual Message cleanup', async () => {
    const previous = tenantStorage.getStore();
    const ambient = { tenantId: user.tenantId, userId: 'request-user', requestId: 'message-scope' };
    await tenantStorage.run(ambient, async () => {
      await terminal(true);
      expect(tenantStorage.getStore()).toBe(ambient);
    });
    expect(tenantStorage.getStore()).toBe(previous);
  });
  it('rejects foreign ambient tenant before Message, cursor or accounting mutation', async () => {
    await prepared(true, async (actualLifecycle) => {
      const snapshot = async () =>
        Promise.all([
          db.models.Message.collection.find({}).toArray(),
          db.models.File.collection.find({}).toArray(),
          db.models.UploadOperation.collection.find({}).toArray(),
          db.models.UploadCounter.collection.find({}).toArray(),
          jobs.model.collection.find({}).toArray(),
        ]);
      const before = await snapshot();
      const previous = tenantStorage.getStore();
      const foreign = { tenantId: 'foreign-tenant', userId: user.userId };
      await tenantStorage.run(foreign, async () => {
        expect(await actualLifecycle.purgeDerivatives(claim, signal)).toEqual({ state: 'unknown' });
        expect(tenantStorage.getStore()).toBe(foreign);
      });
      expect(tenantStorage.getStore()).toBe(previous);
      expect(await snapshot()).toEqual(before);
    });
  });
  it('repeated fences preserve original attempt, worker, promotion and cleanup generation beyond revoked', async () => {
    const first = await bound();
    const binding = first.progress.lifecycle!.upload;
    const once = await totals();
    await generation.beginCapture(claim, signal);
    expect(await tx((s) => owner.fenceAcceptedFileCleanup({ claim }, s))).toEqual({
      state: 'bound',
      binding,
    });
    expect(binding.attemptGeneration).toBe(lease.generation);
    expect(binding.cleanupGeneration).toBe(lease.generation + 1);
    expect(binding.promotion!.worker).toEqual({ hostId: 'app-host', instanceId: 'app-writer' });
    expect(await totals()).toEqual(once);
  });
  it('requires the exact live claim and an active session on the owner connection', async () => {
    await bound();
    const s = await db.startSession();
    try {
      await expect(owner.fenceAcceptedFileCleanup({ claim }, s)).rejects.toThrow('SESSION');
    } finally {
      await s.endSession();
    }
    const foreign = await other.startSession();
    foreign.startTransaction();
    try {
      await expect(owner.fenceAcceptedFileCleanup({ claim }, foreign)).rejects.toThrow('SESSION');
    } finally {
      await foreign.abortTransaction();
      await foreign.endSession();
    }
    expect(
      await tx((s) =>
        owner.fenceAcceptedFileCleanup({ claim: { ...claim, fence: claim.fence + 1 } }, s),
      ),
    ).toEqual({ state: 'lost' });
  });
  it('does not refund namespace absence or an unprepared terminal receipt', async () => {
    const step = await prepared(),
      storage = step.progress.lifecycle!.storage!;
    if (storage.state !== 'observing') throw Error('storage');
    observed(
      await lifecycle.recordStorage(
        claim,
        step.expected,
        { ...storage.binding, state: 'namespace_absent', obligationId: 'native-fixture' },
        signal,
      ),
    );
    const before = await totals();
    expect(await tx((s) => owner.acknowledgeAcceptedFileCleanup({ claim }, s))).toEqual({
      state: 'pending',
      reason: 'owner_pending',
    });
    expect(await totals()).toEqual(before);
    expect((await row())!.originalBytes).toBe(8);
  });
  it('rolls back File preparation and ACK if the caller transaction fails', async () => {
    await terminal();
    const beforeRow = await row(),
      before = await totals(),
      beforeFile = await file();
    await expect(
      tx(async (s) => {
        expect(await retention.settleFileSourceDeletionInSession(user, 'original', false, s)).toBe(
          true,
        );
        await db.models.File.updateOne(
          { file_id: 'original', tenantId: user.tenantId, user: user.userId },
          { $set: { 'retentionCleanup.lifecycle.contentPrepared': true } },
          { session: s },
        );
        expect((await owner.acknowledgeAcceptedFileCleanup({ claim }, s)).state).toBe(
          'acknowledged',
        );
        throw Error('Abort actual owner transaction');
      }),
    ).rejects.toThrow('Abort actual owner transaction');
    expect(await totals()).toEqual(before);
    expect(await row()).toEqual(beforeRow);
    expect(await file()).toEqual(beforeFile);
  });
  it('requires literal persisted actor stop proof before ACK and accounting release', async () => {
    await terminal();
    await expect(
      proveLiteralActorClosure({ db, claim, signal, lifecycle }),
    ).resolves.toBeUndefined();
  });
  it.each(['actor', 'security', 'promotion'] as const)(
    'keeps accounting charged while %s custody is unfinished',
    async (kind) => {
      await terminal();
      const before = await totals();
      let update: mongoose.mongo.UpdateFilter<StoredUpload>;
      if (kind === 'actor')
        update = {
          $set: { writerStopped: false, stagingHeld: true },
          $unset: { actorSettlement: '' },
        };
      else if (kind === 'security') update = { $unset: { securitySettlement: '' } };
      else update = { $set: { 'promotion.writerStopped': false, 'promotion.state': 'writing' } };
      await db.connection
        .db!.collection<StoredUpload>(db.models.UploadOperation.collection.name)
        .updateOne({ _id: 'original' }, update);
      expect(await lifecycle.commitConsumption(claim, signal)).toMatchObject({ state: 'pending' });
      expect((await row())!.originalBytes).toBe(8);
      expect((await row())!.cleanupCustody?.acceptedFileAck).toBeUndefined();
      expect(await totals()).toEqual(before);
      expect((await file())!.retentionCleanup!.lifecycle!.contentPrepared).toBe(false);
    },
  );
  it.each(['capture', 'derivative', 'target', 'descendant', 'receipt'] as const)(
    'requires actual %s custody before accounting',
    async (kind) => {
      await terminal();
      const before = await totals();
      if (kind === 'capture')
        await db.models.File.updateOne(
          { file_id: 'original' },
          { $set: { 'retentionCleanup.capture.recoveryUnresolved': true } },
        );
      if (kind === 'derivative')
        await db.models.File.updateOne(
          { file_id: 'original' },
          { $set: { 'retentionCleanup.lifecycle.derivatives.checkpoints': 'pending' } },
        );
      if (kind === 'receipt')
        await db.models.File.updateOne(
          { file_id: 'original' },
          { $set: { 'retentionCleanup.lifecycle.storage.receiptSHA256': '0'.repeat(64) } },
        );
      if (kind === 'target')
        await (
          db.models.FileCleanupTarget.collection as unknown as mongoose.mongo.Collection<
            mongoose.mongo.Document & { _id: string }
          >
        ).insertOne({
          _id: 'unsettled',
          tenantId: user.tenantId,
          ownerUserId: user.userId,
          fileId: 'original',
          revocationId: claim.work.handler === 'file.cleanup' ? claim.work.revocationId : null,
          state: 'unknown',
        });
      if (kind === 'descendant')
        await db.models.File.collection.insertOne({
          file_id: 'child',
          user: new mongoose.Types.ObjectId(user.userId),
          tenantId: user.tenantId,
          derivedOrigin: { ancestors: [{ subject: { operationId: 'original' } }] },
          deletionCompletedAt: null,
        });
      expect(await lifecycle.commitConsumption(claim, signal)).toMatchObject({ state: 'pending' });
      expect(await totals()).toEqual(before);
      expect((await row())!.cleanupCustody?.acceptedFileAck).toBeUndefined();
    },
  );
  it('rejects a changed immutable File key before binding', async () => {
    await db.models.File.updateOne(
      { file_id: 'original' },
      { $set: { storageKey: 'another-original' } },
    );
    const before = await row();
    expect(await lifecycle.begin(claim, signal)).toMatchObject({ state: 'pending' });
    expect(await row()).toEqual(before);
  });
  it('reserves Upload ACK headroom on every fence before any further File effect', async () => {
    await bound();
    const source = { ...(await row())!, filename: '' };
    // Independent maximum legal ACK specimen: full BSON, including both numeric encodings.
    const future = {
      ...source,
      revision: Number.MAX_SAFE_INTEGER,
      generation: Number.MAX_SAFE_INTEGER,
      originalRemoved: true,
      textRemoved: true,
      cleanupCustody: {
        version: 1,
        acceptedFileAck: {
          reference: 'a'.repeat(128),
          operationId: source._id,
          cleanupGeneration: Number.MAX_SAFE_INTEGER,
          attemptGeneration: source.attemptGeneration!,
          revocationId: 'a'.repeat(128),
          receiptSHA256: 'a'.repeat(64),
        },
        ...(source.promotion
          ? {
              promotionLocal: {
                promotionId: source.promotion.promotionId,
                generation: source.attemptGeneration!,
                worker: source.promotion.worker,
              },
            }
          : {}),
      },
    };
    const room = source.recordBytes - mongoose.mongo.BSON.calculateObjectSize(future);
    expect(room).toBeGreaterThan(20000);
    source.filename = 'x'.repeat(room + 1);
    expect(mongoose.mongo.BSON.calculateObjectSize(source)).toBeLessThan(source.recordBytes);
    await db.connection
      .db!.collection<StoredUpload>(db.models.UploadOperation.collection.name)
      .updateOne({ _id: 'original' }, { $set: { filename: source.filename } });
    await expect(tx((s) => owner.fenceAcceptedFileCleanup({ claim }, s))).rejects.toMatchObject({
      code: 'capacity_exceeded',
    });
    expect((await row())!.cleanupCustody?.acceptedFileAck).toBeUndefined();
    await db.models.UploadOperation.updateOne(
      { _id: 'original' },
      { $set: { filename: 'x'.repeat(room) } },
    );
    await expect(tx((s) => owner.fenceAcceptedFileCleanup({ claim }, s))).resolves.toMatchObject({
      state: 'bound',
    });
  });
  it('the actual migration exporter preserves the ACK and verifies its File custody', async () => {
    await terminal();
    observed(await lifecycle.commitConsumption(claim, signal));
    const ack = (await row())!.cleanupCustody!.acceptedFileAck;
    const page = await repository.exportSnapshot({ epoch: 'ack-migration' });
    const record = page.records.find((record) => record.type === 'operation');
    expect((record!.value as StoredUpload).cleanupCustody!.acceptedFileAck).toEqual(ack);
    expect((await file())!.retentionCleanup!.lifecycle!.storage).toMatchObject({
      state: 'committed',
      uploadAck: ack,
    });
  });
  it('checks actual ACK custody and invalidates coverage atomically at import and the final barrier', async () => {
    await terminal();
    observed(await lifecycle.commitConsumption(claim, signal));
    const ack = (await row())!.cleanupCustody!.acceptedFileAck!;
    const prepareCoverage = async (connection: typeof mongoose, generation: number) => {
      await connection.models.UploadCounter.updateOne(
        { _id: 'global' },
        {
          $set: {
            'value.fileHousekeepingCoverage': {
              version: 1,
              phase: 'preparing',
              generation,
              runSha256: 'a'.repeat(64),
            },
          },
        },
      );
    };
    await prepareCoverage(db, 3);
    const page = await repository.exportSnapshot({ epoch: 'ack-coverage-migration' });
    expect((await totals()).fileHousekeepingCoverage).toMatchObject({
      phase: 'invalid',
      generation: 4,
    });
    const receipt = await repository.completeExport(page.epoch);
    const frozenFile = await db.models.File.collection.findOne({ file_id: 'original' });
    if (!frozenFile) throw Error('Expected actual exported File custody');
    const replacement = new mongoose.Mongoose();
    try {
      await replacement.connect(mongo.getUri('file-upload-ack-replacement'));
      createModels(replacement);
      await replacement.models.File.init();
      const target = createUploadManagementRepository(replacement, {
        enabled: false,
        reconciled: false,
        securityPolicySha256: policy,
      });
      await target.initialize();
      await replacement.models.File.collection.insertOne(frozenFile);
      await prepareCoverage(replacement, 8);
      const globalBefore =
        await replacement.models.UploadCounter.findById('global').lean<CounterRow>();
      const alterAck = async (receiptSHA256: string) =>
        replacement.models.File.updateOne(
          { file_id: 'original' },
          { $set: { 'retentionCleanup.lifecycle.storage.uploadAck.receiptSHA256': receiptSHA256 } },
        );
      await alterAck('0'.repeat(64));
      await expect(target.importSnapshot(page)).rejects.toMatchObject({
        code: 'migration_conflict',
      });
      expect(await replacement.models.UploadCounter.findById('global').lean()).toEqual(
        globalBefore,
      );
      expect(await replacement.models.UploadOperation.findById('original').lean()).toBeNull();
      await alterAck(ack.receiptSHA256);
      await target.importSnapshot(page);
      const imported = (await replacement.models.UploadCounter.findById(
        'global',
      ).lean<CounterRow>())!.value as GlobalState;
      expect(imported.fileHousekeepingCoverage).toMatchObject({ phase: 'invalid', generation: 9 });
      await alterAck('0'.repeat(64));
      const complete = {
        receipt,
        baseline: (await totals()).baseline,
        lifecycleReconciled: true as const,
      };
      await expect(target.completeImport(complete)).rejects.toMatchObject({
        code: 'migration_conflict',
      });
      const blocked = (await replacement.models.UploadCounter.findById(
        'global',
      ).lean<CounterRow>())!.value as GlobalState;
      expect(blocked.enabled).toBe(false);
      const retained = await replacement.models.File.findOne({ file_id: 'original' })
        .select('+retentionActivity')
        .lean<IMongoFile>();
      expect(retained?.retentionActivity?.migrationEpoch).toBe(page.epoch);
      expect(
        (await replacement.models.UploadOperation.findById('original').lean<StoredUpload>())!
          .cleanupCustody?.acceptedFileAck,
      ).toEqual(ack);
      await alterAck(ack.receiptSHA256);
      await target.completeImport(complete);
      expect(
        (
          (await replacement.models.UploadCounter.findById('global').lean<CounterRow>())!
            .value as GlobalState
        ).enabled,
      ).toBe(true);
      expect(
        (await replacement.models.UploadOperation.findById('original').lean<StoredUpload>())!
          .cleanupCustody?.acceptedFileAck,
      ).toEqual(ack);
    } finally {
      await replacement.disconnect();
    }
  });
  it('migration requires the same retained File receipt and rejects an oversized ACK', async () => {
    await terminal();
    observed(await lifecycle.commitConsumption(claim, signal));
    const current = (await row())!;
    validateUploadCleanupCustody(current);
    const oversized = structuredClone(current);
    oversized.cleanupCustody!.acceptedFileAck!.reference = 'x'.repeat(129);
    expect(() => validateUploadCleanupCustody(oversized)).toThrow();
    await db.models.File.updateOne(
      { file_id: 'original' },
      { $set: { 'retentionCleanup.lifecycle.storage.uploadAck.receiptSHA256': '0'.repeat(64) } },
    );
    await expect(
      tx((s) => validateUploadFileCleanupMigration(db, current, s)),
    ).rejects.toMatchObject({ code: 'migration_conflict' });
  });
  it('distinguishes coherent pending, missing identity, original abort and expired deadline', async () => {
    const options = { deadlineAt: Date.now() + 5000, signal };
    expect(await lifecycle.observeCompletion(user, ['original'], options)).toEqual([
      { fileId: 'original', state: 'pending' },
    ]);
    expect(await lifecycle.observeCompletion(user, ['absent'], options)).toEqual([
      { fileId: 'absent', state: 'unknown' },
    ]);
    const abort = new AbortController();
    abort.abort();
    expect(
      await lifecycle.observeCompletion(user, ['original'], {
        deadlineAt: Date.now() + 5000,
        signal: abort.signal,
      }),
    ).toEqual([{ fileId: 'original', state: 'unknown' }]);
    expect(
      await lifecycle.observeCompletion(user, ['original'], { deadlineAt: Date.now() - 1, signal }),
    ).toEqual([{ fileId: 'original', state: 'unknown' }]);
    await db.models.UploadOperation.collection.deleteOne({ _id: 'original' as never });
    expect(await lifecycle.observeCompletion(user, ['original'], options)).toEqual([
      { fileId: 'original', state: 'unknown' },
    ]);
  });
  it('joins the original snapshot operation before returning an abort result', async () => {
    const abort = new AbortController();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => {
        release = r;
      }),
      started = new Promise<void>((r) => {
        entered = r;
      });
    let settled = false;
    const reading = readFileCleanupSnapshot(
      db,
      { deadlineAt: Date.now() + 5000, signal: abort.signal },
      async (session) => {
        await db.models.File.findOne({ file_id: 'original' }).session(session).lean();
        entered();
        await gate;
        return true;
      },
    );
    void reading.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await started;
    abort.abort();
    await new Promise<void>((r) => setImmediate(r));
    expect(settled).toBe(false);
    release();
    await expect(reading).rejects.toThrow('FILE_COMPLETION_UNAVAILABLE');
    expect(settled).toBe(true);
  });
});
