/** Real HTTP consumer, initializer, input owner, native admission, saver and SDK. */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHash, randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const chatModels = require('@langchain/core/language_models/chat_models');
const agentMessages = require('@librechat/agents/langchain/messages');
const agents = require('@librechat/agents');
const schemas = require('@librechat/data-schemas');
const { BaseChatModel } = chatModels;
const { AIMessage } = agentMessages;
const { Run } = agents;
const {
  createGenerationAdmissionMethods,
  createUploadManagementRepository,
  tenantStorage,
  logger,
} = schemas;
const dataProvider = require('librechat-data-provider');
const { Constants } = dataProvider;
let GenerationJobManager;
let InMemoryJobStore;
let InMemoryEventTransport;
let DurableMongoSaver;
let createPrivateTextIngress;
let createManagedSourceResolver;
let MANAGED_SOURCE_FILE_FIELDS;
let consumerApi;
const mockConsumerApis = new WeakMap();

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
// Replace only deployment bootstrap. All source reads and lifecycle decisions use real owners.
jest.mock('~/server/services/Uploads', () => ({
  ...jest.requireActual('~/server/services/Uploads'),
  getManagedContextSources: (req) => {
    const api = mockConsumerApis.get(req);
    if (!api) throw new Error('Request has no fixture consumer owner');
    return api.bindManagedContextSources(req, mockManagedResolver, true);
  },
}));

// Register real models before constructing their method consumers, as application startup does.
const models = require('~/db/models');
const { User, File, Message } = models;
const db = require('~/models');

// Share native database, tenant and SDK identities; each isolated consumer below
// still loads the actual API module and all of its owner-local closures together.
for (const [id, value] of [
  ['mongoose', mongoose],
  ['@librechat/data-schemas', schemas],
  ['librechat-data-provider', dataProvider],
  ['@librechat/agents', agents],
  ['@langchain/core/language_models/chat_models', chatModels],
  ['@librechat/agents/langchain/messages', agentMessages],
  ['~/db/models', models],
  ['~/models', db],
]) {
  jest.setMock(id, value);
}
let controller;
let initializeClient;
let AgentClient;
let createCheckpointRunHost;

const owner = { userId: new mongoose.Types.ObjectId().toHexString(), tenantId: 'consumer-proof' };
const fileId = 'a8c4a219-e94c-41ee-b6df-544753859021';
const policy = 'c'.repeat(64);
const names = ['consumer_checkpoints', 'consumer_checkpoint_writes'];
let mongo;
let modelCalls;
let providerInputs;
let methods;
let generationDone;
let consumerOwners;
let requests;
let gates;
let mockManagedResolver;
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

function bootstrapConsumer(boot = 'boot') {
  jest.isolateModules(() => {
    consumerApi = require('@librechat/api');
    ({
      GenerationJobManager,
      InMemoryJobStore,
      InMemoryEventTransport,
      DurableMongoSaver,
      createPrivateTextIngress,
      createManagedSourceResolver,
      MANAGED_SOURCE_FILE_FIELDS,
    } = consumerApi);
    controller = require('../request');
    ({ initializeClient } = require('~/server/services/Endpoints/agents/initialize'));
    AgentClient = require('../client');
    ({ createCheckpointRunHost } = require('~/server/services/Agents/checkpointRun'));
  });
  const manager = GenerationJobManager;
  const store = new InMemoryJobStore();
  const transport = new InMemoryEventTransport();
  const fixture = {
    manager,
    store,
    transport,
    held: false,
    quiescent: false,
    originals: [],
    generationStarted: false,
    generationDone: deferred(),
  };
  consumerOwners.push(fixture);
  generationDone = fixture.generationDone;
  manager.configure({ jobStore: store, eventTransport: transport, cleanupOnComplete: false });
  manager.configureSourceReplay({
    quota: {
      reserveFileSourceCopies: db.reserveFileSourceCopies,
      releaseFileSourceCopies: db.releaseFileSourceCopies,
    },
  });
  manager.configureGenerationAdmission({
    required: true,
    methods,
    ownerInstanceId: 'consumer-proof',
    processBootId: boot,
  });
  const originalBegin = manager.beginProviderExecution.bind(manager);
  jest.spyOn(manager, 'beginProviderExecution').mockImplementation(async (...args) => {
    const acknowledged = await originalBegin(...args);
    fixture.generationStarted ||= acknowledged;
    return acknowledged;
  });
  const originalSettle = manager.settleGenerationExecution.bind(manager);
  jest.spyOn(manager, 'settleGenerationExecution').mockImplementation((...args) => {
    const original = originalSettle(...args);
    fixture.originals.push(original);
    original.then(fixture.generationDone.release, fixture.generationDone.release);
    return original;
  });
}

function preserveHeldPreparation(manager = GenerationJobManager) {
  const fixture = consumerOwners.find((entry) => entry.manager === manager);
  expect(fixture).toBeDefined();
  const custody = manager['durableAdmission'].getLocalCustody();
  expect(custody.pending).toBe(0);
  expect(custody.unresolved).toBeGreaterThan(0);
  fixture.held = true;
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
  mockConsumerApis.set(req, consumerApi);
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
  req.method = 'POST';
  req.headers = {
    'x-librechat-generation-protocol': '2',
    origin: 'https://consumer.fixture.invalid',
  };
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
  requests = [];
  gates = [];
  consumerOwners = [];
  methods = createGenerationAdmissionMethods(mongoose);
  bootstrapConsumer();
  modelCalls = 0;
  providerInputs = [];
  db.saveMessage.mockClear();
  process.env.UPLOAD_SECURITY_POLICY_SHA256 = policy;
  process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = 'true';
  const uploads = createUploadManagementRepository(mongoose, {
    enabled: true,
    reconciled: true,
    securityPolicySha256: policy,
    baseline: { originalBytes: 0, objectBytes: 0, textBytes: 0, recordBytes: 0, bundles: 0 },
  });
  await uploads.initialize();
  await User.create({
    _id: owner.userId,
    tenantId: owner.tenantId,
    name: 'Synthetic owner',
    email: 'consumer@example.invalid',
    provider: 'local',
    role: 'USER',
  });
  const now = Date.now();
  const principal = { ...owner, authentication: 'verified-email' };
  const worker = { hostId: 'consumer-fixture', instanceId: 'consumer-fixture' };
  const bytes = Buffer.from('original');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  // Real native upload lifecycle with an explicit synthetic scanner receipt, not OCR qualification.
  await uploads.reserve(
    principal,
    {
      operationId: fileId,
      idempotencyKey: randomUUID(),
      mediaType: 'text/plain',
      declaredBytes: bytes.length,
      fingerprint: JSON.stringify([{ kind: 'personal' }, 'text/plain', bytes.length]),
    },
    now,
  );
  const transfer = await uploads.claim({
    kind: 'transfer',
    principal,
    operationId: fileId,
    worker,
    now,
  });
  const execution = {
    version: 2,
    custody: { kind: 'none' },
    attemptId: `${fileId}.${transfer.generation}`,
    instanceId: randomUUID(),
    executionId: randomUUID(),
    expiresAt: new Date(now + 60000).toISOString(),
  };
  await uploads.bindSecurityExecution(transfer, execution, now);
  await uploads.settleSecurityExecution(
    transfer,
    {
      execution,
      writerStopped: true,
      transientDataRemoved: true,
    },
    now,
  );
  await uploads.accept(
    principal,
    transfer,
    {
      outcome: 'durable',
      bytes: bytes.length,
      source: 's3',
      filepath: `/api/files/managed/${fileId}`,
      storageKey: `t/${owner.tenantId}/managed-uploads/${owner.userId}/${fileId}.${transfer.generation}__original`,
      integrity: {
        version: 1,
        algorithm: 'sha256',
        sha256,
        chunkBytes: 262144,
        chunkSha256: [sha256],
      },
    },
    {
      version: 1,
      decision: 'approved',
      policySha256: policy,
      subject: {
        ...owner,
        operationId: fileId,
        transferGeneration: transfer.generation,
        mediaType: 'text/plain',
        bytes: bytes.length,
        sha256,
      },
      scannerVersion: 'explicit-synthetic/v1',
      checkedAt: new Date(now).toISOString(),
      coverage: { complete: true, pages: 1, parts: 1 },
    },
    { filename: 'synthetic.txt' },
    now,
  );
  await uploads.confirmCleanup(
    {
      operationId: fileId,
      generation: transfer.generation,
      writerStopped: true,
      localCopiesAbsent: true,
      originalAbsent: false,
      textAndHistoryRemoved: false,
    },
    now,
  );
  const processing = await uploads.claim({ kind: 'processing', worker, now });
  await uploads.bindProcessingExecution(
    processing,
    {
      attemptId: `${fileId}.${processing.generation}`,
      instanceId: 'fixture-parser',
      expiresAt: new Date(now + 60000).toISOString(),
    },
    now,
  );
  const text = 'The synthetic document says hello.';
  await uploads.publish(
    processing,
    {
      text,
      writerStopped: true,
      structure: {
        version: 1,
        source: { sha256, bytes: bytes.length, mediaType: 'text/plain' },
        extractor: { name: 'explicit-synthetic', version: '1' },
        pages: [],
        elements: [
          { id: 'e1', kind: 'paragraph', start: 0, end: text.length, page: null, parentId: null },
        ],
        quality: { status: 'complete', warnings: [] },
      },
    },
    now,
  );
  mockManagedResolver = createManagedSourceResolver({
    allowedOrigins: ['https://consumer.fixture.invalid'],
    principal: async () => principal,
    operation: (user, id) => uploads.get(user, id, Date.now()),
    file: async (user, id, includeText) =>
      (
        await db.getFiles(
          {
            tenantId: user.tenantId,
            user: user.userId,
            file_id: id,
            uploadOperationId: id,
          },
          null,
          `${MANAGED_SOURCE_FILE_FIELDS}${includeText ? ' text +documentStructure +securityApproval' : ''}`,
          1,
        )
      )[0] ?? null,
    original: (user, id) => uploads.cleanupForFile(user, id),
    policySha256: () => policy,
    storage: {
      read: () => {
        throw new Error('Original download is not normal text context');
      },
    },
  });
  // Fixture providers are local; an accidental transport path must fail before external I/O.
  jest.spyOn(globalThis, 'fetch').mockImplementation(() => {
    throw new Error('External transport is forbidden in this fixture');
  });
});

afterEach(async () => {
  const failures = [];
  const collect = (results) => {
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
  };
  const fixtures = consumerOwners.splice(0).reverse();
  let databaseQuiescent = false;
  try {
    collect(await Promise.allSettled(gates.map((gate) => Promise.resolve().then(gate.release))));
    collect(await Promise.allSettled(requests));
    collect(
      await Promise.allSettled(
        fixtures.map(async (fixture) => {
          const { manager, store, transport } = fixture;
          const results = [];
          if (fixture.generationStarted) {
            results.push(...(await Promise.allSettled([fixture.generationDone.promise])));
          }
          results.push(...(await Promise.allSettled(fixture.originals)));
          results.push(
            ...(await Promise.allSettled(
              [...manager['openProviderExecutions'].values()].flatMap((entry) =>
                [entry.drain, entry.settlement].filter((original) => original !== undefined),
              ),
            )),
          );
          const custody = manager['durableAdmission'].getLocalCustody();
          results.push(
            ...(await Promise.allSettled([
              (async () => {
                assert.strictEqual(custody.pending, 0);
                if (fixture.held) {
                  assert.ok(
                    (typeof custody.unresolved === 'number' ||
                      typeof custody.unresolved === 'bigint') &&
                      custody.unresolved > 0,
                    'Retained fixture must keep unresolved native custody',
                  );
                  assert.strictEqual(
                    (await manager.getGenerationAdmissionCensus()).pendingWrites,
                    0,
                  );
                  // Physical fixture disposal does not settle this retained durable hold.
                } else {
                  await manager.destroy({ settlementBudgetMs: 1000 });
                }
              })(),
            ])),
          );
          // Join the real shutdown original and subscribers even when a drain assertion failed.
          // Never clear retained maps or turn an unconfirmed drain into positive evidence.
          results.push(...(await Promise.allSettled([manager['shutdownSettlement']])));
          results.push(
            ...(await Promise.allSettled([
              Promise.resolve().then(() => manager.prepareForShutdown()),
            ])),
          );
          results.push(...(await Promise.allSettled([manager['drainSubscriberCleanups']()])));
          results.push(
            ...(await Promise.allSettled([
              (async () => {
                assert.strictEqual(manager['durableAdmission'].getLocalCustody().pending, 0);
                assert.strictEqual((await manager.getGenerationAdmissionCensus()).pendingWrites, 0);
                fixture.quiescent = true;
              })(),
            ])),
          );
          results.push(
            ...(await Promise.allSettled([
              store.destroy(),
              Promise.resolve().then(() => transport.destroy()),
            ])),
          );
          const rejected = results.filter((result) => result.status === 'rejected');
          if (rejected.length) {
            throw Object.assign(
              new Error(rejected.map((result) => String(result.reason)).join('\n')),
              { errors: rejected.map((result) => result.reason) },
            );
          }
        }),
      ),
    );
    databaseQuiescent = fixtures.every((fixture) => fixture.quiescent);
  } finally {
    collect(await Promise.allSettled([Promise.resolve().then(() => jest.restoreAllMocks())]));
    // Reset synthetic data only after captured originals are quiescent; it never makes drain pass.
    if (databaseQuiescent) {
      // Keep initialized indexes while clearing model and native checkpoint documents.
      collect(
        await Promise.allSettled([
          mongoose.connection.db.collections().then(async (collections) => {
            collect(
              await Promise.allSettled(collections.map((collection) => collection.deleteMany({}))),
            );
          }),
        ]),
      );
    }
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  if (failures.length) {
    throw Object.assign(
      new Error('Request fixture disposal failed:\n' + failures.map(String).join('\n')),
      { errors: failures },
    );
  }
});
afterAll(async () => {
  const disconnected = await Promise.allSettled([mongoose.disconnect()]);
  const stopped = await Promise.allSettled([mongo?.stop()]);
  const failures = [...disconnected, ...stopped].filter((result) => result.status === 'rejected');
  if (failures.length) {
    throw Object.assign(new Error(failures.map((result) => String(result.reason)).join('\n')), {
      errors: failures.map((result) => result.reason),
    });
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
      const sourceRead = jest.spyOn(mockManagedResolver, 'resolve');
      const sourceRevalidation = jest.spyOn(mockManagedResolver, 'revalidate');
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
      expect(sourceRead).toHaveBeenCalledTimes(mode === 'plain' ? 1 : 0);
      expect(sourceRevalidation).toHaveBeenCalledTimes(mode === 'plain' ? 1 : 0);
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

it('rejects a source revoked during preparation before capture, checkpoint or model', async () =>
  tenantStorage.run({ tenantId: owner.tenantId }, async () => {
    const revalidate = mockManagedResolver.revalidate;
    const sourceRevalidation = jest
      .spyOn(mockManagedResolver, 'revalidate')
      .mockImplementation(async (...args) => {
        await File.updateOne({ file_id: fileId }, { $set: { deletionRequestedAt: new Date() } });
        return revalidate(...args);
      });
    const capture = jest.spyOn(db, 'captureCheckpointSources');
    const res = response();
    await submit(request(), res);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(sourceRevalidation).toHaveBeenCalledTimes(1);
    expect(capture).not.toHaveBeenCalled();
    expect(GenerationJobManager.beginProviderExecution).not.toHaveBeenCalled();
    expect(await mongoose.connection.db.collection(names[0]).countDocuments()).toBe(0);
    expect(await Message.countDocuments()).toBe(0);
    expect(modelCalls).toBe(0);
    expect((await readAdmission()).value).toMatchObject({ active: true, state: 'preparing' });
    preserveHeldPreparation();
  }));

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
      const predecessor = GenerationJobManager;
      preserveHeldPreparation(predecessor);
      predecessor.prepareForShutdown();
      bootstrapConsumer('replacement-boot');
      expect(GenerationJobManager).not.toBe(predecessor);
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
      expect((await readAdmission()).value).toMatchObject({ active: true, state: 'preparing' });
      preserveHeldPreparation();
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
