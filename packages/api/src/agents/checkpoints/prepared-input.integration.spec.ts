/** Actual preparation/admission/source/saver/SDK boundaries; only the model is deterministic. */
import mongoose from 'mongoose';
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
const managers: GenerationJobManagerClass[] = [];
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
  const now = Date.now();
  // Approved original storage is an explicit fixture, not an assertion of an active scanner.
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
});
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.destroy();
  await mongoose.connection.dropDatabase();
  for (const [key, value] of [
    ['UPLOAD_SECURITY_POLICY_SHA256', previous.policy],
    ['CORTEX_UPLOAD_MANAGEMENT_ENABLED', previous.managed],
  ]) {
    if (value === undefined) delete process.env[key!];
    else process.env[key!] = value;
  }
});
afterAll(async () => {
  try {
    await mongoose.disconnect();
  } finally {
    await mongo?.stop();
  }
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
      const manager = new GenerationJobManagerClass({ cleanupOnComplete: false });
      managers.push(manager);
      manager.configureGenerationAdmission({
        required: true,
        methods,
        ownerInstanceId: 'prepared-pod',
        processBootId: 'boot',
        externalCensus: async () => ({ complete: true, queuedContinuations: 0, pendingWrites: 0 }),
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
        durableCheckpointAdmission: admitted.value,
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
            projected.fileIds.some((id) => !sourceBinding.files.some((file) => file.fileId === id))
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
      const messages = [new HumanMessage({ id: 'new-current', content: 'safe current input' })];
      if (mode === 'outside-source')
        messages.push(new HumanMessage({ id: 'foreign-current', content: 'extra' }));
      const pending = run.processStream(
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
    }),
  30000,
);
