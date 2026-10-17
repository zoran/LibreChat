/** Route contract with real artifact parsing; DB/auth/policy boundaries are explicit fixtures. */
const express = require('express');
const request = require('supertest');

jest.mock('@librechat/agents', () => ({ sleep: jest.fn() }));
jest.mock('@librechat/api', () => ({
  prepareToolCallPreviews: jest.fn(() => (messages) => Promise.resolve(messages)),
  createToolCallPartHandler: jest.fn(() => (_req, res) => res.status(404).end()),
  rejectToolCallPreviewWrites: (_req, _res, next) => next(),
  withMessageToolCallPreviews: (_req, message) => message,
  createPrivateTextView: jest.fn(() => (_req, _res, next) => next()),
  stripPrivateMessageFields: jest.fn((message) => message),
  unescapeLaTeX: jest.fn((value) => value),
  createContentFilter: jest.fn(() => (_req, _res, next) => next()),
  assertStoredMessageMutationAllowed: jest.fn(),
  mergeUserSubmittedPaths: (...lists) => [...new Set(lists.flat().filter(Boolean))],
  isContentFilterError: jest.fn((error) => error?.code === 'CONTENT_FILTER'),
  CHILD_THREAD_READ_ONLY_ERROR: 'Child thread is view-only.',
  isSubagentThreadWriteBlocked: jest.fn().mockResolvedValue(false),
  requireFeedbackEnabled: (_req, _res, next) => next(),
  applyForcedRetention: jest.fn(),
}));
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('~/server/services/Config', () => ({ getAppConfig: jest.fn() }));
jest.mock('~/server/services/Endpoints/agents/subagentThreadStore', () => ({}));
jest.mock('~/models', () => ({
  getMessage: jest.fn(),
  saveMessage: jest.fn(),
  getMessages: jest.fn(),
  getConvo: jest.fn(),
  getFiles: jest.fn().mockResolvedValue([]),
}));
jest.mock('~/server/services/Artifacts/update', () => {
  const { findAllArtifacts, replaceArtifactContent } = jest.requireActual(
    '../../../../packages/data-provider/src/artifact-source',
  );
  return { findAllArtifacts, replaceArtifactContent };
});
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) =>
    req.user ? next() : res.status(401).json({ error: 'Unauthorized' }),
  validateMessageReq: (_req, _res, next) => next(),
  configMiddleware: (_req, _res, next) => next(),
  sendValidationResponse: jest.fn(),
  prepareMessageRequestValidation: jest.fn(),
}));

const db = require('~/models');
const { assertStoredMessageMutationAllowed, applyForcedRetention } = require('@librechat/api');
const artifact = (body) =>
  `:::artifact{identifier="example" type="text/markdown" title="Example"}\n\`\`\`md\n${body}\n\`\`\`\n:::`;
const body = { index: 0, original: 'ORIGINAL', updated: 'UPDATED' };
const conflict = {
  code: 'MESSAGE_VERSION_CONFLICT',
  error:
    'Die Nachricht wurde zwischenzeitlich geändert. Lade die aktuelle Fassung und prüfe deine Änderungen.',
};
let app;

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.headers.authorization === 'Bearer route-fixture')
      req.user = { id: 'owner', tenantId: 'tenant-a' };
    req.config = {};
    next();
  });
  app.use('/api/messages', require('../messages'));
});
beforeEach(() => {
  jest.clearAllMocks();
  db.getMessage.mockResolvedValue({
    messageId: 'message',
    conversationId: 'conversation',
    text: artifact('ORIGINAL'),
    __v: 7,
  });
  db.saveMessage.mockImplementation(async (_ctx, message) => ({ ...message, __v: 8 }));
});
const post = (value = body) =>
  request(app)
    .post('/api/messages/artifact/message')
    .set('Authorization', 'Bearer route-fixture')
    .send(value);

describe('artifact native version contract', () => {
  it.each([{}, { expectedVersion: 7 }, { __v: 900 }])(
    'always binds loaded version for request %j',
    async (extra) => {
      const response = await post({ ...body, ...extra });
      expect(response.status).toBe(200);
      expect(db.getMessage).toHaveBeenCalledWith({ user: 'owner', messageId: 'message' });
      expect(db.saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'owner' }),
        expect.objectContaining({ messageId: 'message', userSubmittedPaths: ['/text'] }),
        { context: 'POST /api/messages/artifact/:messageId', expectedVersion: 7 },
      );
      expect(db.saveMessage.mock.calls[0][1]).not.toHaveProperty('__v');
      expect(db.saveMessage.mock.calls[0][1]).not.toHaveProperty('expectedVersion');
      expect(response.body).toEqual({
        conversationId: 'conversation',
        text: artifact('UPDATED'),
        __v: 8,
      });
    },
  );

  it.each([{}, { expectedVersion: null }])(
    'binds an actually versionless legacy row with null for %j',
    async (extra) => {
      const message = {
        messageId: 'message',
        conversationId: 'conversation',
        text: artifact('ORIGINAL'),
      };
      db.getMessage.mockResolvedValue(message);
      db.saveMessage.mockResolvedValue({ ...message, text: artifact('UPDATED'), __v: 1 });
      expect((await post({ ...body, ...extra })).body.__v).toBe(1);
      expect(db.saveMessage.mock.calls[0][2].expectedVersion).toBeNull();
    },
  );

  it.each([null, 0, 6, 8])(
    'rejects mismatched expectedVersion %j before saving',
    async (expectedVersion) => {
      const response = await post({ ...body, expectedVersion });
      expect(response.status).toBe(409);
      expect(response.body).toEqual(conflict);
      expect(db.saveMessage).not.toHaveBeenCalled();
      expect(applyForcedRetention).not.toHaveBeenCalled();
    },
  );

  it.each([
    { index: -1 },
    { index: 0.5 },
    { index: Number.MAX_SAFE_INTEGER + 1 },
    { index: '0' },
    { original: null },
    { original: 1 },
    { updated: [] },
    { updated: {} },
    { expectedVersion: -1 },
    { expectedVersion: 0.5 },
    { expectedVersion: '7' },
    { expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects malformed parameters %j before loading document content', async (extra) => {
    expect((await post({ ...body, ...extra })).status).toBe(400);
    expect(db.getMessage).not.toHaveBeenCalled();
    expect(db.saveMessage).not.toHaveBeenCalled();
  });

  it('keeps invalid target indices separate from stale-original conflicts', async () => {
    expect((await post({ ...body, index: 1 })).status).toBe(400);
    const response = await post({ ...body, original: 'OLD PRIVATE DOCUMENT TEXT' });
    expect(response.status).toBe(409);
    expect(response.body).toEqual(conflict);
    expect(db.saveMessage).not.toHaveBeenCalled();
    expect(applyForcedRetention).not.toHaveBeenCalled();
  });

  it('maps an atomic DB conflict without retry, response content or retention restamping', async () => {
    db.saveMessage.mockRejectedValueOnce(
      Object.assign(new Error('private stored document'), { code: 'MESSAGE_VERSION_CONFLICT' }),
    );
    const response = await post();
    expect(response.status).toBe(409);
    expect(response.body).toEqual(conflict);
    expect(db.saveMessage).toHaveBeenCalledTimes(1);
    expect(applyForcedRetention).not.toHaveBeenCalled();
  });

  it('preserves exact content-part target selection and returns the saved revision', async () => {
    const first = artifact('ORIGINAL');
    const second = artifact('ORIGINAL');
    db.getMessage.mockResolvedValue({
      messageId: 'message',
      conversationId: 'conversation',
      text: artifact('TEXT FALLBACK'),
      content: [
        { type: 'text', text: first },
        { type: 'text', text: second },
      ],
      __v: 7,
    });
    db.saveMessage.mockImplementation(async (_ctx, message) => ({ ...message, __v: 13 }));
    const response = await post({ ...body, index: 1 });
    expect(response.status).toBe(200);
    expect(response.body.__v).toBe(13);
    expect(response.body.content).toEqual([
      { type: 'text', text: first },
      { type: 'text', text: artifact('UPDATED') },
    ]);
    expect(response.body.text).toBe(artifact('TEXT FALLBACK'));
    expect(db.saveMessage.mock.calls[0][1].userSubmittedPaths).toEqual(['/content/1/text']);
  });

  it('preserves native matching instead of matching outside the selected artifact', async () => {
    db.getMessage.mockResolvedValue({
      messageId: 'message',
      conversationId: 'conversation',
      text: `${artifact('OTHER')}\nORIGINAL`,
      __v: 7,
    });
    expect((await post()).status).toBe(409);
    expect(db.saveMessage).not.toHaveBeenCalled();
  });

  it('preserves the authentication and owner-not-found boundaries', async () => {
    expect((await request(app).post('/api/messages/artifact/message').send(body)).status).toBe(401);
    expect(db.getMessage).not.toHaveBeenCalled();
    db.getMessage.mockResolvedValue(null);
    expect((await post()).status).toBe(404);
    expect(db.saveMessage).not.toHaveBeenCalled();
  });

  it('preserves content-filter errors without converting them into version conflicts', async () => {
    const error = Object.assign(new Error('filtered'), {
      code: 'CONTENT_FILTER',
      statusCode: 422,
      body: { error: 'Rejected by policy' },
    });
    assertStoredMessageMutationAllowed.mockImplementationOnce(() => {
      throw error;
    });
    const response = await post();
    expect(response.status).toBe(422);
    expect(response.body).toEqual(error.body);
    expect(db.saveMessage).not.toHaveBeenCalled();
  });

  it('preserves existing retention failure handling and never returns a successful document', async () => {
    db.saveMessage.mockRejectedValueOnce(
      Object.assign(new Error('Document source unavailable'), {
        name: 'FileSourceUnavailableError',
      }),
    );
    const response = await post();
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
    expect(applyForcedRetention).not.toHaveBeenCalled();
  });
});
