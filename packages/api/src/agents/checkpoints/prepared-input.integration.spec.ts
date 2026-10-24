/** Actual preparation/admission/source/saver/SDK boundaries; only the model is deterministic. */
import mongoose from 'mongoose';
import { v4 as uuid } from 'uuid';
import { Run, registerProvider } from '@librechat/agents';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, AIMessage } from '@librechat/agents/langchain/messages';
import {
  createModels,
  createGenerationAdmissionMethods,
  createCheckpointSourceMethods,
  createUploadManagementRepository,
  tenantStorage,
} from '@librechat/data-schemas';
import type { UploadLease, UploadPrincipal } from 'librechat-data-provider';
import type { CheckpointSourceBinding } from '@librechat/data-schemas';
import {
  createModelBoundInputInspector,
  createModelBoundChatModelCallback,
} from '~/middleware/modelBoundContent';
import {
  LIBRECHAT_CHECKPOINT_NAMESPACE_KEY,
  LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY,
} from '../checkpointer';
import { createCheckpointNamespace, checkpointOwnerNamespacePrefix } from '~/stream/checkpoints';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';
import { generationRequestBinding } from '~/stream/generationAdmission';
import { checkpointTestEnvironment } from './__tests__/helpers/mongo';
import { createRun } from '../run';

type Options = Parameters<typeof createRun>[0];
const owner = { userId: new mongoose.Types.ObjectId().toHexString(), tenantId: 'prepared-input' };
const threadId = 'prepared-conversation';
const fileId = '82c60bee-5296-4d5b-8abe-f09a6f3380d7';
const policy = 'c'.repeat(64);
const names = ['prepared_input_checkpoints', 'prepared_input_pending'];
let mongo: MongoMemoryReplSet;
let modelCalls = 0;
type ManagerFixture = {
  manager: GenerationJobManagerClass;
  store: InMemoryJobStore;
  transport: InMemoryEventTransport;
  releaseInput?: () => void;
  settled?: Promise<void>;
};
const managers: ManagerFixture[] = [];
const previous = {
  policy: process.env.UPLOAD_SECURITY_POLICY_SHA256,
  managed: process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED,
};
class LocalModel extends BaseChatModel {
  _llmType() {
    return 'prepared-input-proof';
  }

  async _generate() {
    modelCalls++;
    if ((await mongoose.connection.db!.collection(names[0]).countDocuments()) === 0)
      throw new Error('Provider reached before the first actual checkpoint');
    return { generations: [{ text: 'local answer', message: new AIMessage('local answer') }] };
  }
}
registerProvider({ provider: 'prepared-input-proof', model: LocalModel, family: 'generic' });

/** Actual Upload/File lifecycle; scanner and original-storage receipts are explicit fixtures. */
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
      declaredBytes: 8,
      fingerprint: JSON.stringify([{ kind: 'personal' }, 'text/plain', 8]),
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
      bytes: 8,
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
        bytes: 8,
        sha256: 'a'.repeat(64),
      },
      scannerVersion: 'explicit-synthetic/v1',
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
      text: 'document',
      writerStopped: true,
      structure: {
        version: 1,
        source: { sha256: 'a'.repeat(64), bytes: 8, mediaType: 'text/plain' },
        extractor: { name: 'fixture', version: '1' },
        pages: [],
        elements: [{ id: 'e1', kind: 'paragraph', start: 0, end: 8, page: null, parentId: null }],
        quality: { status: 'complete', warnings: [] },
      },
    },
    at,
  );
  await settleLocalCopies(processing);
}

beforeAll(async () => {
  const environment = checkpointTestEnvironment();
  mongo = await MongoMemoryReplSet.create({
    binary: environment.binary,
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' },
  });
  await mongoose.connect(mongo.getUri('prepared_input'));
  createModels(mongoose);
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}, 60000);
beforeEach(async () => {
  modelCalls = 0;
  process.env.UPLOAD_SECURITY_POLICY_SHA256 = policy;
  process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = 'true';
  await mongoose.models.User.create({
    _id: owner.userId,
    tenantId: owner.tenantId,
    name: 'Synthetic owner',
    email: 'source@example.invalid',
    provider: 'local',
  });
  await tenantStorage.run({ tenantId: owner.tenantId }, () => managedSource(fileId, Date.now()));
});
afterEach(async () => {
  const fixtures = managers.splice(0);
  const failures: unknown[] = [];
  const recordFailures = (results: PromiseSettledResult<unknown>[]) => {
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
  };
  try {
    recordFailures(
      await Promise.allSettled(
        fixtures.map(async (fixture) => {
          fixture.releaseInput?.();
          await fixture.settled;
        }),
      ),
    );
    const destroyed = await Promise.allSettled(
      fixtures.map(({ manager }) => manager.destroy({ settlementBudgetMs: 5_000 })),
    );
    recordFailures(destroyed);
    // Failed manager settlement stays failed. After joining original SDK work, close only
    // this test's in-memory resources; physical cleanup is not a positive drain receipt.
    recordFailures(
      await Promise.allSettled(
        fixtures.flatMap(({ store, transport }, index) =>
          destroyed[index].status === 'rejected'
            ? [store.destroy(), Promise.resolve().then(() => transport.destroy())]
            : [],
        ),
      ),
    );
  } finally {
    try {
      const collections = await mongoose.connection.db!.collections();
      recordFailures(
        await Promise.allSettled(collections.map((collection) => collection.deleteMany({}))),
      );
    } catch (error) {
      failures.push(error);
    } finally {
      for (const [key, value] of [
        ['UPLOAD_SECURITY_POLICY_SHA256', previous.policy],
        ['CORTEX_UPLOAD_MANAGEMENT_ENABLED', previous.managed],
      ]) {
        if (value === undefined) delete process.env[key!];
        else process.env[key!] = value;
      }
    }
  }
  if (failures.length)
    throw Object.assign(
      new Error(['Prepared-input fixture cleanup failed', ...failures.map(String)].join('\n')),
      { errors: failures },
    );
});
afterAll(async () => {
  const failures: unknown[] = [];
  try {
    await mongoose.disconnect();
  } catch (error) {
    failures.push(error);
  }
  try {
    await mongo?.stop();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw Object.assign(
      new Error(['Prepared-input Mongo cleanup failed', ...failures.map(String)].join('\n')),
      { errors: failures },
    );
});

it.each(['allow', 'initial-deny', 'final-deny', 'outside-source'] as const)(
  'assembles a new unsaved request through preparation and real checkpoints: %s',
  async (mode) =>
    tenantStorage.run({ tenantId: owner.tenantId }, async () => {
      expect(
        (Run as typeof Run & { checkpointInputInspectionVersion?: number })
          .checkpointInputInspectionVersion,
      ).toBe(1);
      const methods = createGenerationAdmissionMethods(mongoose);
      const fixture: ManagerFixture = {
        manager: new GenerationJobManagerClass({ cleanupOnComplete: false }),
        store: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
        transport: new InMemoryEventTransport(),
      };
      managers.push(fixture);
      const { manager, store, transport } = fixture;
      manager.configure({ jobStore: store, eventTransport: transport, cleanupOnComplete: false });
      manager.initialize();
      manager.configureGenerationAdmission({
        required: true,
        methods,
        ownerInstanceId: 'prepared-pod',
        processBootId: 'boot',
      });
      const request = generationRequestBinding('request', {
        text: 'safe current input',
        fileIds: [fileId],
      })!;
      const claim = await manager.claimGeneration(
        owner.userId,
        'request',
        threadId,
        threadId,
        2,
        request,
      );
      const namespace = createCheckpointNamespace(owner.userId, owner.tenantId);
      let sourceBinding!: CheckpointSourceBinding;
      const preparation = await manager.prepareCheckpointGeneration(
        owner.userId,
        threadId,
        request,
        claim.existing!.claimToken!,
        async () => {
          expect(await manager.getJobStore().getJob(threadId)).toBeNull();
          const session = await mongoose.startSession();
          try {
            session.startTransaction();
            ({ binding: sourceBinding } = await createCheckpointSourceMethods(
              mongoose,
            ).captureCheckpointSources(owner, { fileIds: [fileId], messages: [] }, session));
            await session.commitTransaction();
          } finally {
            await session.endSession();
          }
          return {
            version: 1,
            mode: 'checkpoint-only-v1',
            runId: 'prepared-run',
            threadId,
            checkpointNamespace: namespace,
            graphFingerprint: 'a'.repeat(64),
            policyFingerprint: policy,
            sourceBindingSha256: sourceBinding.bindingSha256,
          };
        },
      );
      const job = await manager.createJob(threadId, owner.userId, threadId, {
        generationAdmission: request,
        generationPreparation: preparation,
        checkpointContinuation: preparation.continuation,
        idempotencyClientRequestId: 'request',
        idempotencyClaimToken: claim.existing!.claimToken,
        trustedTenantId: owner.tenantId,
      });
      expect(
        await manager.beginProviderExecution(
          threadId,
          job.createdAt,
          job.metadata.providerExecutionId!,
        ),
      ).toBe(true);
      const admitted = await methods.getGenerationAdmission({
        tenantId: owner.tenantId,
        principalId: owner.userId,
        clientRequestId: 'request',
      });
      if (!admitted.ok || !admitted.value) throw new Error('Expected actual native admission');
      const admission = admitted.value;
      const inspect = createModelBoundInputInspector({
        storedMessages: [
          { messageId: 'new-current', text: 'safe current input', isCreatedByUser: true },
          { messageId: 'foreign-current', text: 'extra', isCreatedByUser: true },
        ],
        fileIdsBySourceMessageId: new Map([
          ['new-current', [fileId]],
          ['foreign-current', ['uncaptured-file']],
        ]),
      });
      const allowed = jest.fn();
      const finalInspector = createModelBoundChatModelCallback(
        {
          ...(mode === 'final-deny'
            ? {
                filters: {
                  messages: {
                    pii: {
                      fields: ['text'],
                      starterPatterns: [],
                      customPatterns: [
                        { id: 'late', label: 'late policy', regex: 'safe current input' },
                      ],
                    },
                  },
                },
              }
            : {}),
        },
        { onContentAllowed: allowed },
      );
      let entered!: () => void;
      let release!: () => void;
      const inspecting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      fixture.releaseInput = release;
      const messages = [new HumanMessage({ id: 'new-current', content: 'safe current input' })];
      if (mode === 'outside-source')
        messages.push(new HumanMessage({ id: 'foreign-current', content: 'extra' }));
      const pending = (async () => {
        const run = await createRun({
          runId: 'prepared-run',
          conversationId: threadId,
          user: { id: owner.userId, tenantId: owner.tenantId } as Options['user'],
          tenantId: owner.tenantId,
          agents: [
            {
              id: 'agent',
              name: 'Local proof',
              description: null,
              avatar: null,
              created_at: 0,
              provider: 'prepared-input-proof',
              endpoint: 'prepared-input-proof',
              model: 'local',
              model_parameters: {
                model: 'local',
                temperature: null,
                maxContextTokens: null,
                max_context_tokens: null,
                max_output_tokens: null,
                top_p: null,
                frequency_penalty: null,
                presence_penalty: null,
              },
              tools: [],
            },
          ] as Options['agents'],
          signal: job.abortController.signal,
          centralTraceExportEnabled: false,
          streaming: false,
          streamUsage: false,
          durableCheckpointScope: { ...owner, threadId, checkpointNamespace: namespace },
          durableCheckpointAdmission: admission,
          durableCheckpointSourceBinding: sourceBinding,
          modelCallbacks: [finalInspector],
          appConfig: {
            endpoints: {
              agents: {
                checkpointer: {
                  type: 'mongo',
                  ttl: 3600,
                  checkpointCollectionName: names[0],
                  checkpointWritesCollectionName: names[1],
                },
              },
            },
          } as Options['appConfig'],
          inspectCheckpointInput: async ({ messages }) => {
            const projected = inspect(messages);
            if (
              projected.fileIds.some(
                (id) => !sourceBinding.files.some((file) => file.fileId === id),
              )
            )
              throw new Error('Uncaptured source');
            if (mode === 'initial-deny') throw new Error('Initial input denied');
            expect(await mongoose.connection.db!.collection(names[0]).countDocuments()).toBe(0);
            expect(await mongoose.connection.db!.collection(names[1]).countDocuments()).toBe(0);
            expect(await mongoose.models.Message.countDocuments()).toBe(0);
            expect(allowed).not.toHaveBeenCalled();
            entered();
            await barrier;
          },
        });
        return run.processStream(
          { messages },
          {
            version: 'v2',
            configurable: {
              thread_id: threadId,
              checkpoint_ns: '',
              [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: namespace,
              [LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY]: checkpointOwnerNamespacePrefix(
                owner.userId,
                owner.tenantId,
              ),
            },
          },
        );
      })();
      // Observe the original SDK result without replacing the rejection asserted below.
      // Only after it finishes may the real manager record and settle its exact provider.
      fixture.settled = pending
        .then(
          () => undefined,
          (error: unknown) =>
            (error instanceof Error ? error.message : String(error)) || 'SDK execution failed',
        )
        .then(async (error) => {
          expect(await manager.completeJob(threadId, error, job.createdAt)).toBe(true);
          expect(
            await manager.settleGenerationExecution(
              threadId,
              job.createdAt,
              job.metadata.providerExecutionId!,
            ),
          ).toBe(true);
        });
      // Teardown retains and reports this exact failure even if an earlier assertion fails.
      void fixture.settled.catch(() => undefined);
      if (mode === 'initial-deny' || mode === 'outside-source') {
        await expect(pending).rejects.toThrow();
        expect(await mongoose.connection.db!.collection(names[0]).countDocuments()).toBe(0);
        expect(await mongoose.connection.db!.collection(names[1]).countDocuments()).toBe(0);
      } else {
        await Promise.race([
          inspecting,
          pending.then(() => {
            throw new Error('Inspector not reached');
          }),
        ]);
        messages[0].content = 'late caller mutation';
        release();
        if (mode === 'final-deny') await expect(pending).rejects.toThrow();
        else {
          await pending;
          expect(modelCalls).toBe(1);
        }
      }
      if (mode !== 'allow') {
        expect(modelCalls).toBe(0);
        expect(allowed).not.toHaveBeenCalled();
      }
      // No checkpoint inspection path is allowed to initiate the ordinary/private user-message write.
      expect(await mongoose.models.Message.countDocuments()).toBe(0);
      await fixture.settled;
    }),
  30000,
);
