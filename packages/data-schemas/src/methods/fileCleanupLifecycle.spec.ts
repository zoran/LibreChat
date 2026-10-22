/** Actual File/HK persistence tests. Upload ACK/physical producer composition remains separate. */
import mongoose from 'mongoose';
import { randomUUID, createHash } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { canonicalStorageDeletionReceipt } from 'librechat-data-provider';
import type { FileCleanupDerivativeOwners, AcceptedFileCleanupOwner } from './fileCleanupLifecycle';
import type { FileCleanupProgress, FileCleanupProgressResult } from '../types/fileCleanup';
import type { JobClaim, JobPhase } from '../types/housekeeping';
import {
  createFileCleanupLifecycleMethods,
  assertFileStorageHeadroom,
} from './fileCleanupLifecycle';
import { createFileCleanupProgressMethods } from './fileCleanupProgress';
import { initialFileRetentionActivity } from './fileActivityTransition';
import { createHousekeepingStore } from './housekeepingStore';
import fileSchema from '../schema/file';
const observed = (r: FileCleanupProgressResult) => {
  if (r.state !== 'progress') throw Error(JSON.stringify(r));
  return r;
};
const signal = new AbortController().signal;
describe('File lifecycle persistence kernel', () => {
  let mongo: MongoMemoryReplSet,
    store: ReturnType<typeof createHousekeepingStore>,
    life: ReturnType<typeof createFileCleanupLifecycleMethods>,
    claim: JobClaim;
  const File = mongoose.model('File', fileSchema);
  const user = new mongoose.Types.ObjectId().toString();
  const unavailable = jest.fn(async (): Promise<never> => {
    throw Error('Actual producer not admitted in kernel fixture');
  });
  const upload: AcceptedFileCleanupOwner = {
    observeAcceptedFileCleanup: unavailable,
    fenceAcceptedFileCleanup: unavailable,
    acknowledgeAcceptedFileCleanup: unavailable,
  };
  let custody: FileCleanupProgress;
  const request = {
    protocol: 1 as const,
    requestId: randomUUID(),
    generation: '3',
    authorityBindingSHA256: 'a'.repeat(64),
    acceptedObjectSHA256: 'b'.repeat(64),
  };
  const binding = { ...request, bucket: 'originals', key: 'managed/3/original' };
  const tx = async <T>(fn: (s: mongoose.ClientSession) => Promise<T>) => {
    const s = await mongoose.startSession();
    try {
      return await s.withTransaction(() => fn(s));
    } finally {
      await s.endSession();
    }
  };
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(mongo.getUri());
    store = createHousekeepingStore(mongoose);
    await store.initialize();
    await File.init();
    life = createFileCleanupLifecycleMethods(
      mongoose,
      store,
      upload,
      { settleFileSourceDeletionInSession: unavailable },
      {
        purgeRetrieval: unavailable,
        purgeCheckpoints: unavailable,
        redactFileSourceContent: unavailable,
      } as FileCleanupDerivativeOwners,
    );
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });
  beforeEach(async () => {
    unavailable.mockClear();
    await File.deleteMany({});
    await store.model.deleteMany({});
    const revocationId = randomUUID();
    await File.create({
      user,
      tenantId: 'tenant',
      file_id: 'file',
      uploadOperationId: 'file',
      bytes: 1,
      filename: 'file',
      filepath: 'private',
      type: 'text/plain',
      expiredAt: new Date(1000),
      retentionRevision: 0,
      retentionRevocationId: revocationId,
      deletionRequestedAt: new Date(2000),
      retentionActivity: initialFileRetentionActivity(new Date(1000), new Date(0), 'complete'),
    });
    await tx((s) =>
      store.project(
        {
          handler: 'file.cleanup',
          subject: { tenantId: 'tenant', ownerUserId: user, fileId: 'file' },
          revocationId,
          deadlineGeneration: 0,
        },
        new Date(0),
        s,
      ),
    );
    claim = (await store.claimNext('file.cleanup', {
      podUid: 'pod',
      incarnation: 'boot',
      source: 'source',
      hostId: 'host',
    }))!;
    const phases: JobPhase[] = [
      'awaiting_deadline',
      'revoked',
      'capturing_generations',
      'settling_generations',
      'purging_derivatives',
      'removing_original',
    ];
    for (let i = 1; i < phases.length; i++)
      await tx((s) =>
        store.advance(
          claim,
          { revision: claim.progressRevision + i - 1, phase: phases[i - 1] },
          { phase: phases[i], code: 'progress' },
          s,
        ),
      );
    custody = {
      schema: 1,
      revocationId,
      jobId: claim.jobId,
      executionId: claim.executionId,
      capture: { complete: true, cursor: null, recoveryUnresolved: false },
      generationReceiptRef: 'generation:fixture',
      lifecycle: {
        upload: {
          tenantId: 'tenant',
          userId: user,
          fileId: 'file',
          operationId: 'file',
          cleanupGeneration: 7,
          attemptGeneration: 3,
          workerGeneration: 2,
          worker: { hostId: 'host', instanceId: 'worker' },
          promotion: null,
          originalKey: binding.key,
          originalSource: 's3',
          originalBytes: 1,
          acceptedObjectSHA256: request.acceptedObjectSHA256,
        },
        derivatives: {
          retrieval: 'complete',
          checkpoints: 'complete',
          messages: 'complete',
          messageCursor: null,
        },
        storage: { state: 'observing', request, binding, obligationId: null, lastState: null },
        contentPrepared: false,
        completionRef: null,
      },
    };
    await File.collection.updateOne({ file_id: 'file' }, { $set: { retentionCleanup: custody } });
  });
  it('namespace absence retains the original/accounting obligation', async () => {
    const before = observed(
      await createFileCleanupProgressMethods(mongoose, store).readCapture(claim, signal),
    );
    const after = observed(
      await life.recordStorage(
        claim,
        before.expected,
        { ...binding, state: 'namespace_absent', obligationId: 'obligation' },
        signal,
      ),
    );
    expect(after.progress.lifecycle?.storage).toMatchObject({
      state: 'observing',
      lastState: 'namespace_absent',
      obligationId: 'obligation',
    });
    expect(unavailable).not.toHaveBeenCalled();
  });
  it('rejects a terminal receipt for another original before any File update', async () => {
    const before = observed(
      await createFileCleanupProgressMethods(mongoose, store).readCapture(claim, signal),
    );
    expect(
      await life.recordStorage(
        claim,
        before.expected,
        {
          ...binding,
          key: 'other',
          state: 'durable_delete_complete',
          obligationId: 'obligation',
          aggregateRevision: '1',
          proofSHA256: 'c'.repeat(64),
        },
        signal,
      ),
    ).toEqual({ state: 'pending', reason: 'invalid_receipt' });
    expect(
      observed(await createFileCleanupProgressMethods(mongoose, store).readCapture(claim, signal))
        .progress,
    ).toEqual(before.progress);
  });
  it('persists the full canonical envelope before any accounting or consumption', async () => {
    const before = observed(
      await createFileCleanupProgressMethods(mongoose, store).readCapture(claim, signal),
    );
    const receipt = {
      ...binding,
      state: 'durable_delete_complete' as const,
      obligationId: 'obligation',
      aggregateRevision: '1',
      proofSHA256: 'c'.repeat(64),
    };
    const after = observed(await life.recordStorage(claim, before.expected, receipt, signal));
    expect(after.progress.lifecycle?.storage).toMatchObject({
      state: 'terminal',
      receipt,
      receiptSHA256: createHash('sha256')
        .update(canonicalStorageDeletionReceipt(receipt))
        .digest('hex'),
    });
    expect(unavailable).not.toHaveBeenCalled();
    expect(after.progress.lifecycle?.contentPrepared).toBe(false);
  });
  it('rejects stale result CAS and never overwrites a known obligation with unknown', async () => {
    const before = observed(
      await createFileCleanupProgressMethods(mongoose, store).readCapture(claim, signal),
    );
    const after = observed(
      await life.recordStorage(
        claim,
        before.expected,
        { ...binding, state: 'pending', obligationId: 'obligation' },
        signal,
      ),
    );
    expect(
      await life.recordStorage(claim, before.expected, { ...binding, state: 'unknown' }, signal),
    ).toEqual({ state: 'lost' });
    expect(
      await life.recordStorage(claim, after.expected, { ...binding, state: 'unknown' }, signal),
    ).toEqual({ state: 'pending', reason: 'invalid_receipt' });
    expect(
      observed(await createFileCleanupProgressMethods(mongoose, store).readCapture(claim, signal))
        .progress.lifecycle?.storage,
    ).toMatchObject({ obligationId: 'obligation' });
  });
  it('cannot authorize effects using File-only custody when the real Upload producer is unavailable', async () => {
    expect(await life.observe(claim, signal)).toEqual({ state: 'unknown' });
    expect(unavailable).toHaveBeenCalledTimes(1);
  });
  it('persists one request before binding and accepts canonical equality across object key order', async () => {
    custody.lifecycle!.storage = null;
    await File.collection.updateOne({ file_id: 'file' }, { $set: { retentionCleanup: custody } });
    await (
      store.model.collection as unknown as mongoose.mongo.Collection<
        import('../models/housekeepingJob').HousekeepingJobRecord
      >
    ).updateOne({ _id: claim.jobId }, { $set: { 'execution.phase': 'purging_derivatives' } });
    const prepared = observed(await life.prepareStorage(claim, signal));
    const storage = prepared.progress.lifecycle!.storage!;
    expect(storage.state).toBe('binding');
    const exact = { key: binding.key, bucket: binding.bucket, ...storage.request };
    const bound = observed(await life.bindStorage(claim, prepared.expected, exact, signal));
    const result = observed(
      await life.recordStorage(
        claim,
        bound.expected,
        { ...exact, state: 'pending', obligationId: 'bound' },
        signal,
      ),
    );
    expect(result.progress.lifecycle?.storage).toMatchObject({
      state: 'observing',
      request: storage.request,
      obligationId: 'bound',
    });
    expect(unavailable).not.toHaveBeenCalled();
  });
  it('committed terminal receipt survives an unknown Mongo reply without another identity', async () => {
    const before = observed(
      await createFileCleanupProgressMethods(mongoose, store).readCapture(claim, signal),
    );
    const start = mongoose.startSession.bind(mongoose);
    jest.spyOn(mongoose, 'startSession').mockImplementationOnce(async (...args) => {
      const session = await start(...args);
      const run = session.withTransaction.bind(session);
      session.withTransaction = async (...transactionArgs) => {
        await run(...transactionArgs);
        throw new Error('committed reply lost');
      };
      return session;
    });
    const receipt = {
      ...binding,
      state: 'durable_delete_complete' as const,
      obligationId: 'obligation',
      aggregateRevision: '2',
      proofSHA256: 'c'.repeat(64),
    };
    expect(await life.recordStorage(claim, before.expected, receipt, signal)).toEqual({
      state: 'unknown',
    });
    const after = observed(
      await createFileCleanupProgressMethods(mongoose, store).readCapture(claim, signal),
    );
    expect(after.progress.lifecycle?.storage).toMatchObject({
      state: 'terminal',
      request,
      receipt,
    });
    expect(unavailable).not.toHaveBeenCalled();
  });
  it('current server lease expiry rejects result custody', async () => {
    const before = observed(
      await createFileCleanupProgressMethods(mongoose, store).readCapture(claim, signal),
    );
    await (
      store.model.collection as unknown as mongoose.mongo.Collection<
        import('../models/housekeepingJob').HousekeepingJobRecord
      >
    ).updateOne({ _id: claim.jobId }, { $set: { 'claim.leaseUntil': new Date(0) } });
    expect(
      await life.recordStorage(
        claim,
        before.expected,
        { ...binding, state: 'pending', obligationId: 'obligation' },
        signal,
      ),
    ).toEqual({ state: 'lost' });
  });
  it('proves terminal headroom before effects and rejects oversized retained state', () => {
    expect(() => assertFileStorageHeadroom(custody, binding)).not.toThrow();
    custody.lifecycle!.upload.originalKey = 'x'.repeat(32000);
    expect(() => assertFileStorageHeadroom(custody, binding)).toThrow();
  });
  it('keeps private lifecycle custody out of generic File serialization', async () => {
    const file = await File.findOne({ file_id: 'file' }).select('+retentionCleanup');
    expect(file!.toObject()).not.toHaveProperty('retentionCleanup');
    expect(file!.toJSON()).not.toHaveProperty('retentionCleanup');
  });
  it('joined generation initialization preserves lifecycle when advancing revoked', async () => {
    await (
      store.model.collection as unknown as mongoose.mongo.Collection<
        import('../models/housekeepingJob').HousekeepingJobRecord
      >
    ).updateOne({ _id: claim.jobId }, { $set: { 'execution.phase': 'revoked' } });
    custody.capture.complete = false;
    custody.generationReceiptRef = null;
    await File.collection.updateOne({ file_id: 'file' }, { $set: { retentionCleanup: custody } });
    const targets = createFileCleanupProgressMethods(mongoose, store);
    await targets.initialize();
    const after = observed(await targets.beginCapture(claim, signal));
    expect(after.expected.phase).toBe('capturing_generations');
    expect(after.progress.lifecycle).toEqual(custody.lifecycle);
  });
  it('retries the other retained target after the first target remains unresolved', async () => {
    const targets = createFileCleanupProgressMethods(mongoose, store);
    await targets.initialize();
    await mongoose.models.FileCleanupTarget.deleteMany({});
    custody.capture.complete = false;
    custody.generationReceiptRef = null;
    await File.collection.updateOne({ file_id: 'file' }, { $set: { retentionCleanup: custody } });
    await (
      store.model.collection as unknown as mongoose.mongo.Collection<
        import('../models/housekeepingJob').HousekeepingJobRecord
      >
    ).updateOne({ _id: claim.jobId }, { $set: { 'execution.phase': 'capturing_generations' } });
    const before = observed(await targets.readCapture(claim, signal));
    const scope = {
      userId: user,
      tenantId: 'tenant',
      revocationId: custody.revocationId,
      sourceFileIds: ['file'],
    };
    observed(
      await targets.recordCapturePage(
        claim,
        before.expected,
        {
          targets: [
            {
              schema: 1,
              scope,
              streamId: 'first',
              createdAt: 100,
              providerExecutionId: 'actor-first',
            },
            {
              schema: 1,
              scope,
              streamId: 'second',
              createdAt: 101,
              providerExecutionId: 'actor-second',
            },
          ],
          complete: true,
        },
        signal,
      ),
    );
    await mongoose.models.FileCleanupTarget.updateMany({}, { $set: { updatedAt: new Date(0) } });
    const page = await targets.readPendingTargets(claim, signal);
    if (page.state !== 'progress') throw Error(JSON.stringify(page));
    const first = page.targets[0];
    observed(
      await targets.recordGenerationResult(
        claim,
        page.expected,
        first.id,
        { state: 'unknown', reason: 'actor_pending' },
        signal,
      ),
    );
    const next = await targets.readPendingTargets(claim, signal);
    if (next.state !== 'progress') throw Error(JSON.stringify(next));
    expect(next.targets[0].id).not.toBe(first.id);
    expect(next.targets).toHaveLength(2);
    expect(await mongoose.models.FileCleanupTarget.findById(first.id).lean()).toMatchObject({
      state: 'unknown',
      evidence: null,
    });
  });
});
