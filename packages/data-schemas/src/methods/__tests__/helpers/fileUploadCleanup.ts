/** Nonempty actual owner composition. Transport/actor effects are fixtures; retrieval inventory is empty. */
/* eslint-disable @typescript-eslint/no-require-imports -- Test-only deferred CJS API owner imports, matching the existing cross-package integration suites. */
import mongoose from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalManagedJson } from 'librechat-data-provider';
import { tenantStorage as publicTenantStorage } from '@librechat/data-schemas';
import type { StoredUpload, CounterRow, GlobalState } from '../../uploadManagementStore';
import type { createFileCleanupProgressMethods } from '../../fileCleanupProgress';
import type { FileCleanupProgressResult } from '../../../types/fileCleanup';
import type { createUploadFileCleanupOwner } from '../../uploadFileCleanup';
import type { createHousekeepingStore } from '../../housekeepingStore';
import type { createFileRetentionMethods } from '../../fileRetention';
import type { JobClaim } from '../../../types/housekeeping';
import type { IMongoFile } from '../../../types/file';
import { createFileCleanupLifecycleMethods } from '../../fileCleanupLifecycle';
import { tenantStorage, getTenantId } from '../../../config/tenantContext';
import { managedFileRetrievalDeletionSettled } from '../../fileRetrieval';
import { currentTenantScope } from '../../../tenant/policy';
import { createMessageMethods } from '../../message';
const observed = (result: FileCleanupProgressResult) => {
  if (result.state !== 'progress') throw Error(JSON.stringify(result));
  return result;
};
export async function prepareNonemptyFileCleanup(input: {
  fileId?: string;
  db: typeof mongoose;
  user: { userId: string; tenantId: string };
  now: number;
  claim: JobClaim;
  signal: AbortSignal;
  owner: ReturnType<typeof createUploadFileCleanupOwner>;
  retention: ReturnType<typeof createFileRetentionMethods>;
  jobs: ReturnType<typeof createHousekeepingStore>;
  generation: ReturnType<typeof createFileCleanupProgressMethods>;
  step: Extract<FileCleanupProgressResult, { state: 'progress' }>;
  beforeMessage?: (
    lifecycle: ReturnType<typeof createFileCleanupLifecycleMethods>,
  ) => Promise<void>;
}): Promise<{
  step: Extract<FileCleanupProgressResult, { state: 'progress' }>;
  lifecycle: ReturnType<typeof createFileCleanupLifecycleMethods>;
}> {
  const {
    db,
    user,
    now,
    claim,
    signal,
    owner,
    retention,
    jobs,
    generation,
    fileId = 'original',
  } = input;
  let step = input.step;
  const errors: unknown[] = [];
  const trace = (stage: string, state: string, detail?: unknown) =>
    process.stderr.write(JSON.stringify({ fileUploadStage: { stage, state, detail } }) + '\n');
  async function actualCall<T>(stage: string, action: () => Promise<T>): Promise<T> {
    trace(stage, 'started');
    try {
      const result = await action();
      trace(stage, 'returned');
      return result;
    } catch (error) {
      errors.push(error);
      trace(
        stage,
        'threw',
        error instanceof Error
          ? { name: error.name, message: error.message, stack: error.stack }
          : String(error),
      );
      throw error;
    }
  }
  const { InMemoryJobStore } = require('@librechat/api');
  const {
    createSourceReplayIntent,
  } = require('../../../../../api/src/stream/internal/sourceBudget');
  const { createGenerationCleanupPort } = require('../../../../../api/src/stream/sourceCleanup');
  const {
    purgeCheckpointRows,
  } = require('../../../../../api/src/agents/checkpoints/source-retention');
  const { checkpointOwnerNamespacePrefix } = require('../../../../../api/src/stream/checkpoints');
  const source = new InMemoryJobStore();
  const job = await source.createJob('retained-generation', user.userId, undefined, user.tenantId, {
    providerExecutionId: 'provider-fixture',
  });
  const intent = createSourceReplayIntent(job, [fileId], Date.now() + 60000);
  await source.prepareSourceReplay(intent);
  await source.commitSourceReplay(intent);
  const port = createGenerationCleanupPort({
    store: source,
    transport: {
      emitAbortConfirmed: async () => true,
      purgeSourceRetention: async () => undefined,
      hasProviderDrain: async () => false,
    },
  });
  try {
    const scope = {
      userId: user.userId,
      tenantId: user.tenantId,
      revocationId: step.progress.revocationId,
      sourceFileIds: [fileId],
    };
    let page = await port.capture(scope);
    expect(page.targets).toHaveLength(1);
    const captured = page.targets[0];
    for (let i = 0; i < 4; i++) {
      step = observed(await generation.recordCapturePage(claim, step.expected, page, signal));
      trace('generation.capture', 'persisted', {
        phase: step.expected.phase,
        capture: step.progress.capture,
      });
      if (page.complete) break;
      page = await port.capture(scope, page.cursor);
    }
    expect(step.progress.capture.complete).toBe(true);
    expect((await port.reconcile(captured)).state).toBe('pending');
    await source.updateJob(
      job.streamId,
      { status: 'aborted', providerDrained: true },
      job.createdAt,
    );
    const actual = await source.getJob(job.streamId);
    expect(
      await source.recordSourceActorSettlement({
        schema: 1,
        streamId: job.streamId,
        createdAt: job.createdAt,
        providerExecutionId: 'provider-fixture',
        sourceRetentionRevokedAt: actual.sourceRetentionRevokedAt,
        sourceFileIds: [fileId],
        localCopiesAbsent: true,
      }),
    ).toBe(true);
    expect((await port.reconcile(captured)).state).toBe('pending');
    expect(await source.acknowledgeSourceReplayRelease(intent)).toBe(true);
    const target = await generation.readPendingTargets(claim, signal);
    expect(target.state).toBe('progress');
    if (target.state !== 'progress') throw Error('actual target missing');
    const receipt = await port.reconcile(target.targets[0].target);
    expect(receipt.state).toBe('settled');
    step = observed(
      await generation.recordGenerationResult(
        claim,
        target.expected,
        target.targets[0].id,
        receipt,
        signal,
      ),
    );
  } finally {
    await port.close();
  }
  step = observed(await generation.finishGenerationStage(claim, step.expected, signal));
  trace('generation.finish', 'persisted', {
    phase: step.expected.phase,
    receipt: step.progress.generationReceiptRef,
  });
  const prefix = checkpointOwnerNamespacePrefix(user.userId, user.tenantId);
  const binding = {
    version: 2,
    owner: { userId: user.userId, tenantId: user.tenantId },
    files: [
      {
        fileId: fileId,
        bindingSha256: 'a'.repeat(64),
        expiresAt: new Date(now + 60000).toISOString(),
      },
    ],
    messages: [],
    expiresAt: new Date(now + 60000).toISOString(),
  };
  const checkpoint = db.connection.db!.collection('cohesive_checkpoints');
  await checkpoint.deleteMany({});
  const cp = {
    _id: new mongoose.Types.ObjectId(),
    thread_id: prefix + 'thread',
    checkpoint_ns: prefix + 'scope',
    lc_owner: prefix,
    checkpoint: Buffer.from('retained checkpoint body'),
    lc_source_file_ids: [fileId],
    lc_source_binding: {
      ...binding,
      bindingSha256: createHash('sha256').update(canonicalManagedJson(binding)).digest('hex'),
    },
    lc_source_expires_at: new Date(now + 60000),
    lc_retained_allocations: [{ fileId: fileId, bytes: 1 }],
  };
  cp.lc_retained_allocations[0].bytes = mongoose.mongo.BSON.calculateObjectSize(cp);
  await checkpoint.insertOne(cp);
  await db.models.File.updateOne(
    { file_id: fileId, tenantId: user.tenantId, user: user.userId },
    { $inc: { retainedDerivativeBytes: cp.lc_retained_allocations[0].bytes } },
  );
  await db.models.UploadCounter.updateOne(
    { _id: 'global' as never },
    {
      $inc: {
        'value.textBytes': cp.lc_retained_allocations[0].bytes,
        'value.baseline.textBytes': cp.lc_retained_allocations[0].bytes,
      },
    },
  );
  await db.models.Message.create({
    sender: 'Assistant',
    isCreatedByUser: false,
    messageId: randomUUID(),
    conversationId: 'retained',
    user: user.userId,
    tenantId: user.tenantId,
    __v: 0,
    text: 'retained generated answer',
    sourceFileIds: [fileId],
    sourceExpiresAt: new Date(now + 60000),
    files: [{ file_id: fileId }],
  });
  const messages = createMessageMethods(db).redactFileSourceContent;
  const lifecycle = createFileCleanupLifecycleMethods(db, jobs, owner, retention, {
    purgeRetrieval: async () =>
      actualCall('derivative.retrieval', async () => {
        const current = await db.models.File.findOne({
          file_id: fileId,
          tenantId: user.tenantId,
          user: user.userId,
        })
          .select('+retrievalCreation +managedRetrieval')
          .lean<IMongoFile>();
        if (!current || !managedFileRetrievalDeletionSettled(current))
          throw Error('nonempty retrieval requires actual transport');
      }),
    purgeCheckpoints: async () =>
      actualCall('derivative.checkpoints', async () => {
        const [stored] = await checkpoint
          .aggregate([
            { $match: { _id: cp._id } },
            {
              $project: {
                _id: 0,
                bytes: { $bsonSize: '$$ROOT' },
                allocation: '$lc_retained_allocations',
                owner: '$lc_owner',
                binding: '$lc_source_binding',
              },
            },
          ])
          .toArray();
        trace('derivative.checkpoints', 'stored-input', stored);
        return purgeCheckpointRows(
          {
            checkpointCollectionName: 'cohesive_checkpoints',
            checkpointWritesCollectionName: 'cohesive_writes',
          },
          { lc_owner: prefix },
          { sourceFileIds: [fileId] },
        );
      }),
    redactFileSourceContent: new Proxy(messages, {
      apply(target, thisArg, args) {
        return actualCall('derivative.messages', async () => {
          const context = tenantStorage.getStore();
          trace('derivative.messages', 'tenant-context', {
            canonicalModule: require.resolve('../../../config/tenantContext'),
            policyModule: require.resolve('../../../tenant/policy'),
            publicIdentityMatches: publicTenantStorage === tenantStorage,
            context,
            policyScope: currentTenantScope(),
          });
          expect(publicTenantStorage).toBe(tenantStorage);
          expect(getTenantId()).toBe(user.tenantId);
          expect(currentTenantScope()).toEqual({ kind: 'scoped', tenantId: user.tenantId });
          expect(context?.userId).toBe(user.userId);
          return await Reflect.apply(target, thisArg, args);
        });
      },
    }),
  });
  let checkedMessage = false;
  for (let i = 0; i < 8; i++) {
    const derivative = step.progress.lifecycle!.derivatives;
    if (
      !checkedMessage &&
      derivative.retrieval === 'complete' &&
      derivative.checkpoints === 'complete'
    ) {
      checkedMessage = true;
      await input.beforeMessage?.(lifecycle);
    }
    trace('lifecycle.purgeDerivatives', 'calling', {
      iteration: i,
      phase: step.expected.phase,
      derivatives: step.progress.lifecycle!.derivatives,
    });
    const result = await lifecycle.purgeDerivatives(claim, signal);
    trace(
      'lifecycle.purgeDerivatives',
      'returned',
      result.state === 'progress'
        ? {
            state: result.state,
            phase: result.expected.phase,
            derivatives: result.progress.lifecycle!.derivatives,
          }
        : result,
    );
    if (result.state !== 'progress' && errors.length) throw errors[errors.length - 1];
    step = observed(result);
    if (step.progress.lifecycle!.derivatives.messages === 'complete') break;
  }
  expect(await checkpoint.countDocuments()).toBe(0);
  expect(
    await db.models.Message.findOne({
      conversationId: 'retained',
      tenantId: user.tenantId,
      user: user.userId,
    }).lean(),
  ).toMatchObject({
    text: '',
    content: [],
  });
  expect(
    (await db.models.File.findOne({ file_id: fileId })
      .select('+retainedDerivativeBytes')
      .lean<IMongoFile>())!.retainedDerivativeBytes,
  ).toBe(0);

  return { step, lifecycle };
}

/** Persisted Mixed actor history must fail closed before File preparation or any accounting debit. */
export async function proveLiteralActorClosure(input: {
  db: typeof mongoose;
  claim: JobClaim;
  signal: AbortSignal;
  lifecycle: ReturnType<typeof createFileCleanupLifecycleMethods>;
}): Promise<void> {
  const { db, claim, signal, lifecycle } = input;
  const read = () => db.models.UploadOperation.findById('original').lean<StoredUpload>();
  const readFile = () =>
    db.models.File.findOne({ file_id: 'original' })
      .select('+retentionCleanup +retentionRevocationId +retainedDerivativeBytes +text')
      .lean<IMongoFile>();
  const totals = async () =>
    (await db.models.UploadCounter.findById('global').lean<CounterRow>())!.value as GlobalState;
  const stored = (await read())!;
  for (const stopped of ['false', 'true', 1, false]) {
    await db.models.UploadOperation.updateOne(
      { _id: 'original' as never },
      {
        $set: {
          writerStopped: false,
          stagingHeld: true,
          actorSettlement: {
            generation: stored.workerGeneration,
            worker: stored.worker,
            writerStopped: stopped,
            localCopiesAbsent: true,
          },
        },
      },
    );
    const beforeRow = await read(),
      beforeTotals = await totals();
    expect(beforeRow!.actorSettlement!.writerStopped).toBe(stopped);
    const beforeFile = await readFile();
    const beforeJob = await db.models.HousekeepingJob.findById(claim.jobId).lean();
    expect(await lifecycle.commitConsumption(claim, signal)).toMatchObject({ state: 'pending' });
    expect(await read()).toEqual(beforeRow);
    expect(await totals()).toEqual(beforeTotals);
    expect(await readFile()).toEqual(beforeFile);
    expect(await db.models.HousekeepingJob.findById(claim.jobId).lean()).toEqual(beforeJob);
    expect((await read())!.cleanupCustody?.acceptedFileAck).toBeUndefined();
  }
  await db.models.UploadOperation.updateOne(
    { _id: 'original' as never },
    { $set: { 'actorSettlement.writerStopped': true } },
  );
  const before = await totals();
  const committed = observed(await lifecycle.commitConsumption(claim, signal));
  expect(committed.progress.lifecycle!.storage!.state).toBe('committed');
  expect(await read()).toMatchObject({
    writerStopped: true,
    stagingHeld: false,
    originalBytes: 0,
    textBytes: 0,
  });
  expect((await read())!.cleanupCustody?.acceptedFileAck).toBeDefined();
  expect(await totals()).toMatchObject({
    originalBytes: before.originalBytes - stored.originalBytes,
    objectBytes: before.objectBytes - stored.originalBytes,
    recordBytes: before.recordBytes,
    bundles: before.bundles,
  });
  const once = await totals();
  observed(await lifecycle.commitConsumption(claim, signal));
  expect(await totals()).toEqual(once);
}
