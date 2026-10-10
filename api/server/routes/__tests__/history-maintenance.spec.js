jest.mock('~/server/utils/import/importBatchBuilder', () => ({
  createImportBatchBuilder: jest.fn(),
}));
const express = require('express');
const request = require('supertest');

const MOCKS = '../__test-utils__/convos-route-mocks';
jest.mock('~/server/services/Config/app', () => ({ getAppConfig: jest.fn() }));
const { generationJobManager } = require(MOCKS);

const priorLimitMessageIp = process.env.LIMIT_MESSAGE_IP;
const priorLimitMessageUser = process.env.LIMIT_MESSAGE_USER;
process.env.LIMIT_MESSAGE_IP = 'true';
process.env.LIMIT_MESSAGE_USER = 'true';

jest.mock('@librechat/agents', () => require(MOCKS).agents());
jest.mock('@librechat/api', () =>
  require(MOCKS).api({
    ...jest.requireActual('../../../../packages/api/src/conversations/history'),
    ...jest.requireActual('../../../../packages/api/src/conversations/historyHttp'),
    createContentFilter: jest.fn((options) => (req, res, next) => {
      const extracted = [...options.extract(req)];
      if (JSON.stringify(extracted).includes('BLOCK-CONTROL')) {
        return res.status(400).json({ error: 'content_filter_block' });
      }
      next();
    }),
    extractStoredMessageContent: jest.fn((input) => [input]),
    inspectContent: jest.fn(() => null),
    extractConversationTitleContent: jest.fn(() => []),
    contentFilterBlockResponse: jest.fn(),
    isContentFilterError: jest.fn((error) => error?.code === 'content_filter_block'),
  }),
);
jest.mock('@librechat/data-schemas', () => require(MOCKS).dataSchemas());
jest.mock('librechat-data-provider', () => require(MOCKS).dataProvider());
jest.mock('~/models', () => require(MOCKS).sharedModels());
jest.mock('~/server/middleware/requireJwtAuth', () => require(MOCKS).requireJwtAuth());
jest.mock('~/server/middleware', () => require(MOCKS).middlewarePassthrough());
jest.mock('~/server/utils/import/fork', () => require(MOCKS).forkUtils());
jest.mock('~/server/utils/import', () => require(MOCKS).importUtils());
jest.mock('~/cache/getLogStores', () => require(MOCKS).logStores());
jest.mock('~/server/routes/files/multer', () => ({
  ...require(MOCKS).multerSetup(),
  createStorage: () => require(MOCKS).multerSetup().storage,
}));
jest.mock('multer', () => require(MOCKS).multerLib());
jest.mock('~/server/services/Endpoints/azureAssistants', () => require(MOCKS).assistantEndpoint());
jest.mock('~/server/services/Endpoints/assistants', () => require(MOCKS).assistantEndpoint());
jest.mock('~/server/services/Endpoints/agents/subagentThreadStore', () =>
  require(MOCKS).subagentThreadStore(),
);
jest.mock('~/server/services/Endpoints/agents/backgroundCompletion', () => ({
  pendingBackgroundToolCompletions: { list: jest.fn() },
}));

describe('actual conversation HTTP maintenance boundaries', () => {
  let app, owner;
  const db = require('~/models');
  const api = require('@librechat/api');
  beforeEach(() => {
    jest.clearAllMocks();
    generationJobManager.getCleanupJob.mockResolvedValue(null);
    generationJobManager.getCleanupBlockingJobIdsForUser.mockResolvedValue([]);
    generationJobManager.getCleanupBlockingJobIdsForConversations.mockResolvedValue([]);
    owner = api.createHistoryMutationOwner();
    app = express();
    app.locals.historyMaintenance = owner;
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 'test-user-123' };
      next();
    });
    app.use('/api/convos', require('../convos'));
  });
  afterAll(() => {
    if (priorLimitMessageIp == null) delete process.env.LIMIT_MESSAGE_IP;
    else process.env.LIMIT_MESSAGE_IP = priorLimitMessageIp;
    if (priorLimitMessageUser == null) delete process.env.LIMIT_MESSAGE_USER;
    else process.env.LIMIT_MESSAGE_USER = priorLimitMessageUser;
  });
  it('rejects pin before persistence when admission is closed', async () => {
    owner.pauseAdmissions('a');
    const response = await request(app)
      .post('/api/convos/pin')
      .send({ arg: { conversationId: 'c', pinned: true } });
    expect(response.status).toBe(503);
    expect(db.setConvoPinned).not.toHaveBeenCalled();
  });
  it('retains a pin already admitted before maintenance through its actual write', async () => {
    let save;
    let started;
    const accepted = new Promise((resolve) => {
      started = resolve;
    });
    db.setConvoPinned.mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => {
        save = resolve;
      });
    });
    const response = request(app)
      .post('/api/convos/pin')
      .send({ arg: { conversationId: 'c', pinned: true } })
      .then((r) => r);
    await accepted;
    owner.pauseAdmissions('a');
    expect((await owner.getMaintenanceCensus('a')).pendingWrites).toBe(1);
    save({ conversationId: 'c', pinned: true });
    expect((await response).status).toBe(200);
    expect(await owner.getMaintenanceCensus('a')).toMatchObject({
      complete: true,
      pendingWrites: 0,
      queuedContinuations: 0,
    });
  });
  it('does not turn the legacy fulfilled saveConvo error into a successful census', async () => {
    db.saveConvo.mockResolvedValueOnce({ message: 'Error saving conversation' });
    const response = await request(app)
      .post('/api/convos/archive')
      .send({ arg: { conversationId: 'c', isArchived: true } });
    expect(response.status).toBe(200);
    owner.pauseAdmissions('a');
    expect((await owner.getMaintenanceCensus('a')).complete).toBe(false);
    expect(owner.resumeAdmissions('a')).toBe(false);
  });
  it('joins detached shared-link ACL cleanup after the delete-all HTTP response', async () => {
    let complete;
    const acl = new Promise((resolve) => {
      complete = resolve;
    });
    db.deleteConvos.mockResolvedValue({
      acknowledged: true,
      deletedCount: 0,
      conversationIds: [],
      messages: { acknowledged: true, deletedCount: 0 },
    });
    db.deleteMessages.mockResolvedValue({ acknowledged: true, deletedCount: 0 });
    db.deleteToolCalls.mockResolvedValue({ acknowledged: true, deletedCount: 0 });
    api.deleteAllSharedLinksWithCleanup.mockImplementationOnce(async (_user, observe) => {
      observe(acl);
      return { deletedCount: 0 };
    });
    const response = await request(app).delete('/api/convos/all');
    expect(response.status).toBe(201);
    owner.pauseAdmissions('a');
    expect((await owner.getMaintenanceCensus('a')).pendingWrites).toBe(1);
    complete({ acknowledged: true, deletedCount: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(await owner.getMaintenanceCensus('a')).toMatchObject({
      pendingWrites: 0,
      complete: true,
    });
  });
});
