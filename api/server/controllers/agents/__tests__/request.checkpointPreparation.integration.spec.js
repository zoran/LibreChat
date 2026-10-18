/** Real HTTP consumer, initializer, input owner, native admission, saver and SDK. */
const { EventEmitter } = require('node:events');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { BaseChatModel } = require('@langchain/core/language_models/chat_models');
const { AIMessage } = require('@librechat/agents/langchain/messages');
const { Run } = require('@librechat/agents');
const {
  createGenerationAdmissionMethods,
  createUploadManagementRepository,
  tenantStorage,
  logger,
} = require('@librechat/data-schemas');
const {
  GenerationJobManager,
  InMemoryJobStore,
  InMemoryEventTransport,
  DurableMongoSaver,
  createPrivateTextIngress,
} = require('@librechat/api');
const { Constants } = require('librechat-data-provider');

// Model inventory is a deployment input; the selected local model never calls a provider.
jest.mock('~/server/controllers/ModelController', () => ({
  getModelsConfig: jest.fn().mockResolvedValue({ openAI: ['gpt-4o'] }),
}));
jest.mock('~/config', () => ({
  ...jest.requireActual('~/config'),
  getMCPManager: () => ({ getServerInstructions: () => undefined }),
}));
jest.mock('@librechat/agents/llm/openai', () => ({ ChatOpenAI: mockLocalModel }));
// Observe the existing failed-turn owner while every write still reaches its native implementation.
jest.mock('~/models', () => {
  const actual = jest.requireActual('~/models');
  return { ...actual, saveMessage: jest.fn((...args) => actual.saveMessage(...args)) };
});

const db = require('~/models');
const { User, File, Message } = require('~/db/models');
const controller = require('../request');
const { initializeClient } = require('~/server/services/Endpoints/agents/initialize');
const AgentClient = require('../client');
const { createCheckpointRunHost } = require('~/server/services/Agents/checkpointRun');

const owner = { userId: new mongoose.Types.ObjectId().toHexString(), tenantId: 'consumer-proof' };
const fileId = 'a8c4a219-e94c-41ee-b6df-544753859021';
const policy = 'c'.repeat(64);
const names = ['consumer_checkpoints', 'consumer_checkpoint_writes'];
let mongo;
let modelCalls;
let providerInputs;
let methods;
let pendingGeneration;
let settleGeneration;
let generationStarted;
let generationDone;
let requests;
let gates;
const previous = {
  UPLOAD_SECURITY_POLICY_SHA256: process.env.UPLOAD_SECURITY_POLICY_SHA256,
  CORTEX_UPLOAD_MANAGEMENT_ENABLED: process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED,
};

class mockLocalModel extends BaseChatModel {
  _llmType() {
    return 'checkpoint-consumer-proof';
  }
  async _generate(messages) {
    modelCalls++;
    providerInputs.push(messages);
    if ((await mongoose.connection.db.collection(names[0]).countDocuments()) === 0) {
      throw new Error('Provider invoked before the durable checkpoint');
    }
    return { generations: [{ text: 'local answer', message: new AIMessage('local answer') }] };
  }
}

function deferred() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function configureManager(boot = 'boot') {
  GenerationJobManager.configure({
    jobStore: new InMemoryJobStore(),
    eventTransport: new InMemoryEventTransport(),
    cleanupOnComplete: false,
  });
  GenerationJobManager.configureSourceReplay({
    quota: {
      reserveFileSourceCopies: db.reserveFileSourceCopies,
      releaseFileSourceCopies: db.releaseFileSourceCopies,
    },
  });
  GenerationJobManager.configureGenerationAdmission({
    required: true,
    methods,
    ownerInstanceId: 'consumer-proof',
    processBootId: boot,
    externalCensus: async () => ({ complete: true, queuedContinuations: 0, pendingWrites: 0 }),
  });
}

const readAdmission = async () => ({
  value: await mongoose.models.GenerationAdmission.findOne({
    tenantId: owner.tenantId,
    principalId: owner.userId,
    clientRequestId: 'consumer-request',
  }).lean(),
});

function submit(
  req,
  res,
  initialize = initializeClient,
  title = jest.fn(),
  host = createCheckpointRunHost(),
) {
  const task = controller(req, res, jest.fn(), initialize, title, host);
  requests.push(task);
  return task;
}

function response() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.set = jest.fn(() => res);
  res.status = jest.fn((status) => {
    res.statusCode = status;
    return res;
  });
  res.json = jest.fn((value) => {
    res.body = value;
    res.headersSent = true;
    return res;
  });
  res.write = jest.fn();
  res.end = jest.fn(() => {
    res.writableEnded = true;
  });
  return res;
}

function request(overrides = {}) {
  const req = new EventEmitter();
  req.user = { id: owner.userId, tenantId: owner.tenantId, role: 'USER', name: 'Synthetic owner' };
  req.headers = { 'x-librechat-generation-protocol': '2' };
  req.get = (name) => req.headers[name.toLowerCase()];
  req.path = '/';
  req.body = {
    text: 'Explain the attached synthetic document.',
    clientRequestId: 'consumer-request',
    conversationId: 'new',
    parentMessageId: Constants.NO_PARENT,
    files: [{ file_id: fileId }],
    endpointOption: {
      endpoint: 'agents',
      agent_id: 'agent_consumer',
      agent: Promise.resolve({
        id: 'agent_consumer',
        name: 'Consumer',
        provider: 'openAI',
        model: 'gpt-4o',
        model_parameters: { model: 'gpt-4o' },
        tools: [],
      }),
      model_parameters: { model: 'gpt-4o' },
    },
    ...overrides,
  };
  req.config = {
    endpoints: {
      agents: {
        allowedProviders: ['openAI'],
        capabilities: [],
        checkpointer: {
          type: 'mongo',
          checkpointCollectionName: names[0],
          checkpointWritesCollectionName: names[1],
        },
      },
    },
    fileConfig: {
      endpoints: {
        agents: { disabled: false },
        openAI: { disabled: false, supportedMimeTypes: ['text/plain'] },
      },
    },
  };
  return req;
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({
    binary: { systemBinary: process.env.MONGOMS_SYSTEM_BINARY, version: '7.0.43' },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' },
  });
  await mongoose.connect(mongo.getUri('consumer_proof'));
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
}, 60000);

beforeEach(async () => {
  modelCalls = 0;
  providerInputs = [];
  db.saveMessage.mockClear();
  process.env.UPLOAD_SECURITY_POLICY_SHA256 = policy;
  process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = 'true';
  await createUploadManagementRepository(mongoose, {
    enabled: true,
    reconciled: true,
  }).initialize();
  await User.create({
    _id: owner.userId,
    tenantId: owner.tenantId,
    name: 'Synthetic owner',
    email: 'consumer@example.invalid',
    provider: 'local',
    role: 'USER',
  });
  const now = Date.now();
  // Explicit synthetic approved original; this fixture does not qualify a scanner or OCR runtime.
  await File.collection.insertOne({
    file_id: fileId,
    uploadOperationId: fileId,
    user: new mongoose.Types.ObjectId(owner.userId),
    tenantId: owner.tenantId,
    status: 'ready',
    source: 's3',
    type: 'text/plain',
    bytes: 8,
    filename: 'synthetic.txt',
    text: 'The synthetic document says hello.',
    llmDeliveryPath: 'text',
    filepath: `/api/files/managed/${fileId}`,
    storageKey: `t/${owner.tenantId}/managed-uploads/${owner.userId}/${fileId}.1__original`,
    retentionAcceptedAt: new Date(now),
    expiredAt: new Date(now + 600000),
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
  methods = createGenerationAdmissionMethods(mongoose);
  configureManager();
  requests = [];
  gates = [];
  generationStarted = false;
  generationDone = deferred();
  settleGeneration = generationDone.release;
  const originalBegin = GenerationJobManager.beginProviderExecution.bind(GenerationJobManager);
  jest.spyOn(GenerationJobManager, 'beginProviderExecution').mockImplementation(async (...args) => {
    const acknowledged = await originalBegin(...args);
    generationStarted ||= acknowledged;
    return acknowledged;
  });
  // Fixture providers are local; an accidental transport path must fail before external I/O.
  jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('External transport is forbidden in this fixture');
  });
  pendingGeneration = undefined;
  const originalSettle = GenerationJobManager.settleGenerationExecution.bind(GenerationJobManager);
  jest.spyOn(GenerationJobManager, 'settleGenerationExecution').mockImplementation((...args) => {
    pendingGeneration = originalSettle(...args);
    pendingGeneration.then(
      () => settleGeneration?.(),
      () => settleGeneration?.(),
    );
    return pendingGeneration;
  });
});

afterEach(async () => {
  for (const gate of gates) gate.release();
  await Promise.allSettled(requests);
  if (generationStarted) await generationDone.promise;
  await pendingGeneration;
  await GenerationJobManager.destroy({ settlementBudgetMs: 1000 });
  jest.restoreAllMocks();
  await mongoose.connection.dropDatabase();
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
afterAll(async () => {
  try {
    await mongoose.disconnect();
  } finally {
    await mongo?.stop();
  }
});

it.each(['plain', 'private', 'history-quotes'])(
  'prepares a new %s turn once, then checkpoints before the actual model',
  async (mode) =>
    tenantStorage.run({ tenantId: owner.tenantId }, async () => {
      let privateConversation;
      const requestOverrides = {};
      if (mode !== 'plain') {
        const conversationId = '4ac4e8d0-9209-4793-bf11-bf568100efcd';
        const messageId = '9fc357dd-3cb7-4d11-970e-a730f62a8f61';
        const sourceRetention = await db.resolveFileRetentionContext(owner, {
          fileIds: [fileId],
          historyMessageIds: [],
        });
        await db.saveMessage(
          owner,
          {
            messageId,
            conversationId,
            parentMessageId: Constants.NO_PARENT,
            text: 'The synthetic document says hello.',
            sender: 'Consumer',
            isCreatedByUser: false,
            endpoint: 'agents',
            model: 'gpt-4o',
            user: owner.userId,
          },
          { sourceRetention },
        );
        expect(await Message.findOne({ messageId }).lean()).toMatchObject({
          sourceFileIds: [fileId],
          text: 'The synthetic document says hello.',
        });
        await mongoose.models.Conversation.create({
          conversationId,
          user: owner.userId,
          tenantId: owner.tenantId,
          title: 'Existing synthetic conversation',
          endpoint: 'agents',
        });
        let head = messageId;
        if (mode === 'history-quotes') {
          const quoteRetention = await db.resolveQuoteRetention(owner, [
            {
              text: 'The synthetic document says hello.',
              sourceRef: { messageId },
            },
          ]);
          head = '78a03c0a-ad83-4d8f-9299-8cfb174a19ec';
          await db.saveMessage(
            owner,
            {
              messageId: head,
              conversationId,
              parentMessageId: Constants.NO_PARENT,
              text: 'A retained quotation follows.',
              sender: 'Consumer',
              isCreatedByUser: false,
              endpoint: 'agents',
              model: 'gpt-4o',
              quotes: quoteRetention.quotes,
            },
            { quoteRetention, sourceRetention },
          );
        }
        Object.assign(requestOverrides, {
          text: mode === 'private' ? 'alice@example.com' : 'Explain this history.',
          conversationId,
          parentMessageId: head,
          files: [],
        });
        privateConversation = await mongoose.models.Conversation.findOne({ conversationId }).lean();
      }
      const req = request(requestOverrides);
      if (mode === 'private') {
        req.config.filters = {
          messages: {
            pii: {
              action: 'redact',
              fields: ['text'],
              starterPatterns: [],
              customPatterns: [
                { id: 'email', label: 'Email', regex: 'alice@example[.]com', category: 'email' },
              ],
            },
          },
        };
        const next = jest.fn();
        createPrivateTextIngress({
          getFilters: () => req.config.filters,
          getLegacyPii: () => undefined,
          getKey: () => 'ab'.repeat(32),
        })(req, response(), next);
        expect(next).toHaveBeenCalledTimes(1);
      }
      const res = response();
      const title = jest.fn();
      const errors = jest.spyOn(logger, 'error');
      const captureEntered = deferred();
      const captureRelease = deferred();
      gates.push(captureRelease);
      const capture = db.captureCheckpointSources;
      const captureSpy = jest
        .spyOn(db, 'captureCheckpointSources')
        .mockImplementation(async (...args) => {
          const result = await capture(...args);
          expect(result.binding.files.map((file) => file.fileId)).toEqual([fileId]);
          captureEntered.release();
          await captureRelease.promise;
          return result;
        });
      let inputInspected = false;
      const originalPrepare = AgentClient.prototype.prepareCheckpointMessage;
      const prepareSpy = jest
        .spyOn(AgentClient.prototype, 'prepareCheckpointMessage')
        .mockImplementation(async function (...args) {
          const result = await originalPrepare.apply(this, args);
          expect(result.projection.fileIds).toEqual(mode === 'plain' ? [fileId] : []);
          if (mode !== 'plain')
            expect(result.projection.sourceMessageIds).toContain(requestOverrides.parentMessageId);
          return {
            ...result,
            inspect: (messages) => {
              expect(Object.isFrozen(messages)).toBe(true);
              expect(modelCalls).toBe(0);
              const projection = result.inspect(messages);
              inputInspected = true;
              return projection;
            },
          };
        });
      const put = DurableMongoSaver.prototype.put;
      let firstCheckpoint = true;
      jest.spyOn(DurableMongoSaver.prototype, 'put').mockImplementation(async function (...args) {
        if (firstCheckpoint) {
          firstCheckpoint = false;
          expect(inputInspected).toBe(true);
          if (mode !== 'history-quotes')
            expect(await Message.countDocuments({ isCreatedByUser: true })).toBe(0);
          if (mode === 'private') {
            expect(
              await mongoose.models.Conversation.findOne({
                conversationId: req.body.conversationId,
              }).lean(),
            ).toEqual(privateConversation);
          }
        }
        return put.apply(this, args);
      });
      const pending = submit(req, res, initializeClient, title);
      await Promise.race([
        captureEntered.promise,
        pending.then(() => {
          throw new Error(
            JSON.stringify({ status: res.statusCode, body: res.body, errors: errors.mock.calls }),
          );
        }),
      ]);
      const held = await readAdmission();
      expect(held.value).toMatchObject({ state: 'preparing', active: true });
      expect(await GenerationJobManager.getJobStore().getJob(held.value.conversationId)).toBeNull();
      expect(await Message.countDocuments({ isCreatedByUser: true })).toBe(0);
      expect(await mongoose.connection.db.collection(names[0]).countDocuments()).toBe(0);
      expect(modelCalls).toBe(0);
      expect(res.headersSent).not.toBe(true);
      captureRelease.release();
      await pending;
      expect({ status: res.statusCode, body: res.body, errors: errors.mock.calls }).toEqual(
        expect.objectContaining({ status: 200 }),
      );
      await generationDone.promise;
      expect({ modelCalls, errors: errors.mock.calls }).toEqual(
        expect.objectContaining({ modelCalls: 1 }),
      );
      expect(JSON.stringify(providerInputs)).toContain('The synthetic document says hello.');
      expect(inputInspected).toBe(true);
      expect(firstCheckpoint).toBe(false);
      expect(title).not.toHaveBeenCalled();
      expect(prepareSpy).toHaveBeenCalledTimes(1);
      expect(captureSpy).toHaveBeenCalledTimes(1);
      expect(await Message.countDocuments({ user: owner.userId, isCreatedByUser: true })).toBe(1);
      if (mode === 'private') {
        const saved = await Message.findOne({ isCreatedByUser: true })
          .select('+privateText')
          .lean();
        expect(saved.privateText).toBeDefined();
        expect(JSON.stringify(saved)).not.toContain('alice@example.com');
        expect(JSON.stringify(providerInputs)).not.toContain('alice@example.com');
      }
      expect((await readAdmission()).value).toMatchObject({
        state: 'settled',
        continuation: { mode: 'checkpoint-only-v1' },
      });
      const retry = response();
      const retryRequest = request(requestOverrides);
      if (mode === 'private') {
        retryRequest.config.filters = req.config.filters;
        createPrivateTextIngress({
          getFilters: () => retryRequest.config.filters,
          getLegacyPii: () => undefined,
          getKey: () => 'ab'.repeat(32),
        })(retryRequest, retry, jest.fn());
      }
      await submit(retryRequest, retry, initializeClient, title);
      expect(retry.statusCode).toBe(200);
      expect(prepareSpy).toHaveBeenCalledTimes(1);
      expect(captureSpy).toHaveBeenCalledTimes(1);
      expect(modelCalls).toBe(1);
    }),
);

it.each(['begin', 'capture', 'complete'])(
  'holds lost %s acknowledgment through cleanup, grace retry and process replacement',
  async (stage) =>
    tenantStorage.run({ tenantId: owner.tenantId }, async () => {
      const initialize = jest.fn(initializeClient);
      const capture = db.captureCheckpointSources;
      const captureSpy = jest
        .spyOn(db, 'captureCheckpointSources')
        .mockImplementation(async (...args) => {
          const result = await capture(...args);
          if (stage === 'capture') {
            const session = args[2];
            const commit = session.commitTransaction.bind(session);
            session.commitTransaction = async (...commitArgs) => {
              await commit(...commitArgs);
              throw new Error('Injected lost source commit acknowledgment');
            };
          }
          return result;
        });
      if (stage !== 'capture') {
        const name =
          stage === 'begin' ? 'beginGenerationPreparation' : 'completeGenerationPreparation';
        const original = methods[name];
        jest.spyOn(methods, name).mockImplementationOnce(async (...args) => {
          expect(await original(...args)).toMatchObject({ ok: true });
          throw new Error('Injected lost native preparation acknowledgment');
        });
      }
      const res = response();
      await submit(request(), res, initialize);
      expect(res.statusCode).toBe(500);
      expect((await readAdmission()).value).toMatchObject({
        active: true,
        state: stage === 'complete' ? 'prepared' : 'preparing',
      });
      const expectedInitializations = stage === 'begin' ? 0 : 1;
      expect(initialize).toHaveBeenCalledTimes(expectedInitializations);
      expect(captureSpy).toHaveBeenCalledTimes(expectedInitializations);
      const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 6000);
      try {
        const retry = response();
        await submit(request(), retry, initialize);
        expect(retry.statusCode).toBe(503);
      } finally {
        clock.mockRestore();
      }
      await GenerationJobManager.destroy({ settlementBudgetMs: 1000 });
      configureManager('replacement-boot');
      const replacement = response();
      await submit(request(), replacement, initialize);
      expect(replacement.statusCode).toBe(503);
      expect(initialize).toHaveBeenCalledTimes(expectedInitializations);
      expect(captureSpy).toHaveBeenCalledTimes(expectedInitializations);
      expect(await Message.countDocuments()).toBe(0);
      expect(await mongoose.connection.db.collection(names[0]).countDocuments()).toBe(0);
      expect(modelCalls).toBe(0);
    }),
);

it.each(['tools', 'subagents', 'memory'])(
  'rejects unsupported %s before source capture or dispatch',
  async (capability) =>
    tenantStorage.run({ tenantId: owner.tenantId }, async () => {
      const req = request();
      const agent = await req.body.endpointOption.agent;
      if (capability === 'tools') agent.tools = ['execute_code'];
      if (capability === 'subagents') agent.subagents = { enabled: true };
      if (capability === 'memory')
        req.config.memory = {
          disabled: false,
          agent: { enabled: true, provider: 'openAI', model: 'gpt-4o' },
        };
      const capture = jest.spyOn(db, 'captureCheckpointSources');
      const res = response();
      await submit(req, res);
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(capture).not.toHaveBeenCalled();
      expect(GenerationJobManager.beginProviderExecution).not.toHaveBeenCalled();
      expect(modelCalls).toBe(0);
      expect(await Message.countDocuments()).toBe(0);
    }),
);

it('rejects RunStart mutation of submitted input before any checkpoint or model', async () =>
  tenantStorage.run({ tenantId: owner.tenantId }, async () => {
    const req = request();
    req.config.filters = {
      messages: {
        pii: {
          fields: ['text'],
          starterPatterns: [],
          customPatterns: [{ id: 'hook', label: 'Hook secret', regex: 'synthetic-HOOK-DENY' }],
        },
      },
    };
    const hook = jest.fn(async ({ messages }) => {
      messages[0].content = 'synthetic-HOOK-DENY';
      return {};
    });
    const create = Run.create.bind(Run);
    jest.spyOn(Run, 'create').mockImplementation(async (config) => {
      config.hooks.register('RunStart', { hooks: [hook] });
      return create(config);
    });
    const capture = jest.spyOn(db, 'captureCheckpointSources');
    const res = response();
    await submit(req, res);
    expect(res.statusCode).toBe(200);
    await generationDone.promise;
    expect(capture).toHaveBeenCalledTimes(1);
    expect(Run.create).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(providerInputs)).not.toContain('synthetic-HOOK-DENY');
    expect(await mongoose.connection.db.collection(names[0]).countDocuments()).toBe(0);
    expect(JSON.stringify(await Message.find({ isCreatedByUser: true }).lean())).not.toContain(
      'synthetic-HOOK-DENY',
    );
    expect(db.saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: owner.userId }),
      expect.objectContaining({
        text: 'Explain the attached synthetic document.',
        isCreatedByUser: true,
      }),
      expect.objectContaining({
        context: 'api/server/controllers/agents/request.js - failed turn',
      }),
    );
    expect(modelCalls).toBe(0);
  }));
