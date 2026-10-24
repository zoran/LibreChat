/** Real HTTP route and Mongo CAS; fixtures replace only external authentication/configuration. */
const express = require('express');
const mongoose = require('mongoose');
const request = require('supertest');
const { v4: uuid } = require('uuid');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const {
  createModels,
  createMethods,
  createUploadManagementRepository,
  tenantStorage,
  runAsSystem,
} = require('@librechat/data-schemas');

jest.mock('~/models', () => ({}));
jest.mock('~/server/services/Config', () => ({ getAppConfig: async () => ({}) }));
// No provisional child thread exists in this fixture; the native Mongo conversation guard runs.
jest.mock('~/server/services/Endpoints/agents/subagentThreadStore', () => ({
  isThreadActiveForOwner: () => false,
}));
jest.mock('~/server/middleware', () => {
  const next = (_req, _res, done) => done();
  return {
    requireJwtAuth: next,
    validateMessageReq: next,
    configMiddleware: next,
    canReadActiveJobConversation: () => false,
    createMessageRequestValidation: () => ({ valid: true }),
    prepareMessageRequestValidation: next,
    sendValidationResponse: (_res, result) => result,
  };
});

const db = require('~/models');
Object.assign(mongoose.models, createModels(mongoose));
const methods = createMethods(mongoose);
Object.assign(db, methods);
const router = require('../messages');
const owner = { userId: new mongoose.Types.ObjectId().toString(), tenantId: 'artifact-cas' };
const run = (callback) => tenantStorage.run({ tenantId: owner.tenantId }, callback);
const artifact = (text = 'ORIGINAL') =>
  [
    ':::artifact{identifier="a" type="text/markdown" title="Example"}',
    '```md',
    text,
    '```',
    ':::',
  ].join('\n');
const raw = async (messageId) => mongoose.models.Message.findOne({ messageId }).lean();
const post = (app, messageId, updated, extra = {}) =>
  request(app)
    .post(`/api/messages/artifact/${messageId}`)
    .send({
      index: 0,
      original: 'ORIGINAL',
      updated,
      ...extra,
    });
function application(principal = owner) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: principal.userId, tenantId: principal.tenantId };
    req.config = { interfaceConfig: {} };
    tenantStorage.run({ tenantId: principal.tenantId }, next);
  });
  app.use('/api/messages', router);
  return app;
}
async function seed(options = {}) {
  const message = {
    messageId: uuid(),
    conversationId: uuid(),
    text: artifact(),
    isCreatedByUser: false,
  };
  await methods.saveMessage(owner, message, options);
  return raw(message.messageId);
}

describe('artifact HTTP compare-and-set against real native Mongo methods', () => {
  let mongo;
  const app = application();
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongo.getUri());
    await mongoose.models.Message.createIndexes();
    await mongoose.models.File.init();
  });
  beforeEach(async () => {
    db.getMessage = methods.getMessage;
    await runAsSystem(() =>
      mongoose.models.User.create({
        _id: owner.userId,
        tenantId: owner.tenantId,
        email: 'artifact-cas@example.test',
        emailVerified: true,
      }),
    );
    await createUploadManagementRepository(mongoose, {
      enabled: true,
      reconciled: true,
    }).initialize();
  });
  afterEach(async () => {
    db.getMessage = methods.getMessage;
    await runAsSystem(async () => {
      await mongoose.models.User.deleteMany({});
      await mongoose.models.Message.deleteMany({});
      await mongoose.models.File.deleteMany({});
    });
    await mongoose.models.UploadCounter.deleteMany({});
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });

  it.each([false, true])(
    'commits exactly one of two same-read requests (explicit client version: %s)',
    async (versioned) => {
      const row = await run(seed);
      const observed = [];
      let release;
      const bothRead = new Promise((resolve) => (release = resolve));
      const timer = setTimeout(() => release(), 5000);
      db.getMessage = async (query) => {
        const value = await methods.getMessage(query);
        observed.push(value.__v ?? null);
        if (observed.length === 2) release();
        await bothRead;
        return value;
      };
      let responses;
      try {
        const extra = versioned ? { expectedVersion: row.__v ?? null } : {};
        responses = await Promise.all([
          post(app, row.messageId, 'FIRST', extra),
          post(app, row.messageId, 'SECOND', extra),
        ]);
      } finally {
        clearTimeout(timer);
      }
      expect(observed).toEqual([row.__v ?? null, row.__v ?? null]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      const success = responses.find((response) => response.status === 200);
      const conflict = responses.find((response) => response.status === 409);
      expect(conflict.body.code).toBe('MESSAGE_VERSION_CONFLICT');
      const stored = await run(async () => raw(row.messageId));
      expect(stored.__v).toBe((row.__v ?? 0) + 1);
      expect(success.body.__v).toBe(stored.__v);
      expect(success.body.text).toBe(stored.text);
      expect(stored.text).toBe(artifact(responses[0].status === 200 ? 'FIRST' : 'SECOND'));
      expect(await run(async () => mongoose.models.Message.countDocuments({}))).toBe(1);
    },
  );

  it('rejects an explicitly stale version and stale original without altering the winning row', async () => {
    const row = await run(seed);
    const first = await post(app, row.messageId, 'WINNER', { expectedVersion: row.__v ?? null });
    expect(first.status).toBe(200);
    const before = await run(async () => raw(row.messageId));
    for (const extra of [{ expectedVersion: row.__v ?? null }, {}]) {
      const response = await post(app, row.messageId, 'STALE', extra);
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('MESSAGE_VERSION_CONFLICT');
    }
    expect(await run(async () => raw(row.messageId))).toEqual(before);
  });

  it.each(['owner', 'tenant', 'missing'])(
    'does not expose or create a %s-inaccessible artifact',
    async (reason) => {
      const row = await run(seed);
      const principal = {
        ...owner,
        ...(reason === 'owner' && { userId: new mongoose.Types.ObjectId().toString() }),
        ...(reason === 'tenant' && { tenantId: 'foreign-tenant' }),
      };
      const target = reason === 'missing' ? uuid() : row.messageId;
      const response = await post(application(principal), target, 'ATTACK');
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('ORIGINAL');
      expect(await run(async () => raw(row.messageId))).toEqual(row);
      expect(await run(async () => mongoose.models.Message.countDocuments({}))).toBe(1);
    },
  );

  it('cannot restore artifact content after the actual source-retention owner revokes its source', async () => {
    const { row, sourceFileIds } = await run(async () => {
      const fileId = uuid();
      const acceptedAt = new Date();
      const sourceExpiresAt = new Date(acceptedAt.getTime() + 60000);
      await methods.createFile(
        {
          user: owner.userId,
          tenantId: owner.tenantId,
          file_id: fileId,
          filename: 'source.txt',
          filepath: '/fixture/source',
          type: 'text/plain',
          bytes: 11,
          text: 'source text',
          retainedDerivativeBytes: 0,
        },
        undefined,
        { retention: { acceptedAt, expiredAt: sourceExpiresAt } },
      );
      const sourceRetention = { sourceFileIds: [fileId], sourceExpiresAt };
      const saved = await seed({ sourceRetention });
      await methods.revokeFileSources(owner, [fileId]);
      return { row: saved, sourceFileIds: [fileId] };
    });
    const before = await run(async () => raw(row.messageId));
    expect(sourceFileIds).toHaveLength(1);
    const response = await post(app, row.messageId, 'RESTORED');
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(JSON.stringify(response.body)).not.toContain('ORIGINAL');
    expect(await run(async () => raw(row.messageId))).toEqual(before);
  });
});
