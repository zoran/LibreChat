/**
 * GET /files is intentionally covered as wiring only. The list policy lives in
 * packages/api and has its behavioral coverage in files/list.spec.ts.
 */

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
  SystemCapabilities: {},
  runAsSystem: (work) => work(),
}));

const mockHandleFileListRequest = jest.fn();
const mockRefreshS3FileUrls = jest.fn();
let mockAuthMode = 'default';
let mockUploadRuntime;
jest.mock('@librechat/api', () => ({
  getAuthMode: () => mockAuthMode,
  buildDeleteFilesResponse: (result, message) => ({ ...result, message }),
  handleFileListRequest: (...args) => mockHandleFileListRequest(...args),
  refreshS3FileUrls: (...args) => mockRefreshS3FileUrls(...args),
  resolveUploadErrorMessage: jest.fn(),
  verifyAgentUploadPermission: jest.fn(),
}));
jest.mock('~/server/services/Uploads', () => ({ getUploadRuntime: () => mockUploadRuntime }));

jest.mock('~/models', () => ({
  findFileById: jest.fn(),
  getFiles: jest.fn(),
  updateFile: jest.fn(),
  getAgents: jest.fn().mockResolvedValue([]),
  batchUpdateFiles: jest.fn(),
}));

jest.mock('~/server/services/Files/process', () => ({
  filterFile: jest.fn(),
  processFileUpload: jest.fn(),
  processDeleteRequest: jest.fn().mockResolvedValue({ deletedFileIds: [], failedFileIds: [] }),
  processAgentFileUpload: jest.fn(),
}));

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({})),
}));

jest.mock('~/server/controllers/assistants/helpers', () => ({
  getOpenAIClient: jest.fn(),
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  hasCapability: jest.fn(() => (_req, _res, next) => next()),
}));

jest.mock('~/server/services/PermissionService', () => ({
  checkPermission: jest.fn(() => (_req, _res, next) => next()),
  getEffectivePermissions: jest.fn().mockResolvedValue(0),
}));

jest.mock('~/server/services/Files', () => ({
  hasAccessToFilesViaAgent: jest.fn(),
}));

const mockGetLogStores = jest.fn();
jest.mock('~/cache', () => ({
  getLogStores: (...args) => mockGetLogStores(...args),
}));

const express = require('express');
const request = require('supertest');
const { FileSources } = require('librechat-data-provider');
const filesRouter = require('./files');

function buildApp(
  config = { fileStrategy: FileSources.local, fileListLimit: 100 },
  user = { id: 'user-123', role: 'user' },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    req.config = config;
    next();
  });
  app.use('/files', filesRouter);
  return app;
}

describe('GET /files wiring', () => {
  beforeEach(() => {
    mockHandleFileListRequest.mockReset();
    mockGetLogStores.mockReset();
  });

  it('sends the list returned by the shared policy and threads request configuration', async () => {
    const files = [{ file_id: 'f1' }];
    mockHandleFileListRequest.mockResolvedValue(files);
    const config = { fileStrategy: FileSources.s3, fileListLimit: 250 };

    const res = await request(buildApp(config)).get('/files?limit=12');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(files);
    expect(mockHandleFileListRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-123',
        rawLimit: '12',
        fileStrategy: FileSources.s3,
        maxLimit: 250,
      }),
    );
    expect(mockHandleFileListRequest.mock.calls[0][0].dependencies).toEqual(
      expect.objectContaining({
        getFiles: expect.any(Function),
        batchUpdateFiles: expect.any(Function),
        refreshS3FileUrls: expect.any(Function),
        getLogStores: expect.any(Function),
        logger: expect.any(Object),
      }),
    );
  });

  it('keeps the route error response when the shared policy rejects', async () => {
    mockHandleFileListRequest.mockRejectedValue(new Error('database unavailable'));

    const res = await request(buildApp()).get('/files');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      message: 'Error in request',
      error: 'database unavailable',
    });
  });
});

describe('Cortex managed File route wiring', () => {
  const db = require('~/models');
  const { processDeleteRequest } = require('~/server/services/Files/process');
  const principal = { tenantId: 'tenant', userId: 'user-123', authentication: 'verified-email' };
  const user = {
    id: principal.userId,
    tenantId: principal.tenantId,
    provider: 'email_code',
    role: 'USER',
  };
  let file;
  let app;
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthMode = 'transition';
    file = {
      file_id: 'operation',
      uploadOperationId: 'operation',
      tenantId: principal.tenantId,
      user: principal.userId,
      filename: 'document.txt',
      bytes: 5,
      source: 's3',
      type: 'text/plain',
      embedded: true,
      status: 'ready',
      retentionAcceptedAt: new Date(),
      expiredAt: new Date(Date.now() + 60_000),
      storageKey: 'private-key',
      text: 'useful text',
    };
    const operation = {
      id: file.file_id,
      fileId: file.file_id,
      state: 'ready',
      scope: { kind: 'personal' },
      canUseInComposer: true,
      actualBytes: 5,
      expiresAt: file.expiredAt.toISOString(),
    };
    db.getFiles.mockResolvedValue([file]);
    mockUploadRuntime = {
      allowedOrigins: ['https://cortex.example'],
      principal: jest.fn(async () => principal),
      management: { get: jest.fn(async () => operation), list: jest.fn(async () => [operation]) },
      repository: {
        cleanupForFile: jest.fn(async () => ({
          operationId: file.file_id,
          fileId: file.file_id,
          state: 'ready',
          principal,
          original: { outcome: 'durable', source: 's3', bytes: 5, storageKey: file.storageKey },
        })),
      },
      storage: {
        read: jest.fn(async function* () {
          yield Buffer.from('hello');
        }),
      },
    };
    app = buildApp(undefined, user);
  });
  afterEach(() => {
    mockAuthMode = 'default';
    mockUploadRuntime = undefined;
  });

  test.each(['/files/managed/operation', '/files/download/foreign-path-user/operation'])(
    'serves %s through the authenticated original owner',
    async (url) => {
      const res = await request(app).get(url).set('Sec-Fetch-Site', 'same-origin');
      expect(res.status).toBe(200);
      expect(res.body.toString()).toBe('hello');
      expect(db.getFiles).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: principal.tenantId, user: principal.userId }),
        null,
        expect.any(String),
        1,
      );
      expect(db.getAgents).not.toHaveBeenCalled();
      expect(res.headers['x-file-metadata']).not.toContain('private-key');
    },
  );

  it('uses finite direct-URL fallback and the managed preview without legacy lazy mutation', async () => {
    const direct = await request(app)
      .get('/files/download-url/user-123/operation')
      .set('Sec-Fetch-Site', 'same-origin');
    expect(direct.status).toBe(501);
    expect(direct.body).toEqual({ code: 'authenticated_download_required' });
    const preview = await request(app)
      .get('/files/operation/preview')
      .set('Sec-Fetch-Site', 'same-origin');
    expect(preview.body).toEqual({
      file_id: 'operation',
      status: 'ready',
      text: 'useful text',
      textFormat: 'text',
    });
    expect(db.updateFile).not.toHaveBeenCalled();
    expect(db.findFileById).not.toHaveBeenCalled();
  });

  it('denies unqualified code-service output before any provider or File lookup', async () => {
    const { getStrategyFunctions } = require('~/server/services/Files/strategies');
    const res = await request(app).get('/files/code/download/session/output');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 'not_found' });
    expect(getStrategyFunctions).not.toHaveBeenCalled();
    expect(db.getFiles).not.toHaveBeenCalled();
  });

  it('resolves deletion under the current tenant/user and passes only stored Files to the lifecycle', async () => {
    processDeleteRequest.mockResolvedValueOnce({
      deletedFileIds: ['operation'],
      failedFileIds: [],
    });
    const res = await request(app)
      .delete('/files')
      .set('Origin', 'https://cortex.example')
      .send({
        files: [
          {
            file_id: 'operation',
            filepath: 'https://foreign.example/key',
            storageKey: 'browser-key',
          },
        ],
      });
    expect(res.status).toBe(200);
    expect(db.getFiles).toHaveBeenCalledWith({
      file_id: { $in: ['operation'] },
      tenantId: 'tenant',
      user: 'user-123',
    });
    expect(processDeleteRequest).toHaveBeenCalledWith({ req: expect.any(Object), files: [file] });
  });

  test.each([
    {},
    { files: Array.from({ length: 11 }, (_, i) => ({ file_id: `file-${i}` })) },
    { files: [{ file_id: 'operation' }], agent_id: 'agent' },
    { files: [{ file_id: 'operation' }], assistant_id: 'assistant' },
  ])('rejects out-of-contract deletion before lookup: %j', async (body) => {
    const res = await request(app)
      .delete('/files')
      .set('Origin', 'https://cortex.example')
      .send(body);
    expect(res.status).toBe(400);
    expect(db.getFiles).not.toHaveBeenCalled();
    expect(processDeleteRequest).not.toHaveBeenCalled();
  });

  it('does not leak or mutate a foreign File returned by an inconsistent lookup', async () => {
    file.tenantId = 'foreign';
    const res = await request(app)
      .delete('/files')
      .set('Origin', 'https://cortex.example')
      .send({ files: [{ file_id: 'operation' }] });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 'not_found' });
    expect(processDeleteRequest).not.toHaveBeenCalled();
  });
});
