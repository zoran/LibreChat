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
  ...jest.requireActual('@librechat/api'),
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
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const {
  FileSources,
  buildManagedFileReadBinding,
  isManagedFileReadTicket,
} = require('librechat-data-provider');
const { createManagedSourceResolver, MANAGED_SOURCE_FILE_FIELDS } = require('@librechat/api');
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
  const readIds = { original: 'o'.repeat(43), preview: 'p'.repeat(43) };
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
          original: {
            outcome: 'durable',
            source: 's3',
            bytes: 5,
            storageKey: file.storageKey,
            filepath: '/api/files/managed/operation',
            integrity: {
              version: 1,
              algorithm: 'sha256',
              chunkBytes: 262144,
              sha256: createHash('sha256').update('hello').digest('hex'),
              chunkSha256: [createHash('sha256').update('hello').digest('hex')],
            },
          },
        })),
      },
      storage: {
        read: jest.fn(async function* () {
          yield Buffer.from('hello');
        }),
      },
    };
    const runtime = mockUploadRuntime;
    runtime.sources = createManagedSourceResolver({
      allowedOrigins: runtime.allowedOrigins,
      principal: runtime.principal,
      operation: (actor, id) => runtime.management.get(actor, id),
      file: async (actor, id, text) => {
        const files = await db.getFiles(
          { tenantId: actor.tenantId, user: actor.userId, file_id: id, uploadOperationId: id },
          null,
          `${MANAGED_SOURCE_FILE_FIELDS}${text ? ' text textFormat +documentStructure +securityApproval' : ''}`,
          1,
        );
        return files?.[0] ?? null;
      },
      original: (actor, id) => runtime.repository.cleanupForFile(actor, id),
      policySha256: () => undefined,
      storage: runtime.storage,
    });
    runtime.fileReadWorker = Object.freeze({
      hostId: 'fixture-http',
      instanceId: 'fixture-worker',
    });
    // HTTP wiring doubles the repository boundary; actual resolver, identity and receipt checks run.
    runtime.runFileOperation = jest.fn((work) => work());
    runtime.fileReads = {
      claimManagedFileRead: jest.fn(async (actor, reference, worker) => {
        assert.deepEqual(actor, principal);
        assert.equal(worker, runtime.fileReadWorker);
        assert.deepEqual(reference, {
          version: 1,
          readId: readIds[reference.representation],
          fileId: file.file_id,
          representation: reference.representation,
        });
        const ticket = {
          ...reference,
          admittedAt: file.retentionAcceptedAt.toISOString(),
          notAfter: file.expiredAt.toISOString(),
        };
        assert.equal(isManagedFileReadTicket(ticket), true);
        const task = await runtime.repository.cleanupForFile(actor, reference.fileId);
        const representation = reference.representation;
        return {
          ...ticket,
          sourceBindingSha256: buildManagedFileReadBinding(
            {
              owner: { tenantId: actor.tenantId, userId: actor.userId },
              fileId: file.file_id,
              operationId: file.uploadOperationId,
              filename: file.filename,
              mediaType: file.type,
              source: file.source,
              bytes: file.bytes,
              storageKey: file.storageKey,
              transferGeneration: null,
              original: task.original,
              approval: null,
              representation,
              ...(representation === 'preview'
                ? { preview: { text: file.text, structure: null } }
                : {}),
            },
            (value) => createHash('sha256').update(value, 'utf8').digest('hex'),
          ),
        };
      }),
      completeManagedFileRead: jest.fn(async (actor, claim, result) => {
        assert.deepEqual(actor, principal);
        assert.equal(claim.readId, readIds[result.representation]);
        assert.equal(result.sourceBindingSha256, claim.sourceBindingSha256);
        return { status: 'completed' };
      }),
      inspectManagedFileRead: jest.fn(),
      abandonManagedFileRead: jest.fn(async () => undefined),
    };
    app = buildApp(undefined, user);
  });
  afterEach(() => {
    mockAuthMode = 'default';
    mockUploadRuntime = undefined;
  });

  test.each(['/files/managed/operation', '/files/download/user-123/operation'])(
    'serves %s through the authenticated original owner',
    async (url) => {
      const res = await request(app)
        .get(url)
        .set('Sec-Fetch-Site', 'same-origin')
        .set('X-Cortex-File-Read', readIds.original);
      expect(res.status).toBe(200);
      expect(res.body.toString()).toBe('hello');
      expect(db.getFiles).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: principal.tenantId, user: principal.userId }),
        null,
        expect.any(String),
        1,
      );
      expect(db.getAgents).not.toHaveBeenCalled();
      expect(mockUploadRuntime.fileReads.completeManagedFileRead).toHaveBeenCalledWith(
        principal,
        expect.objectContaining({ readId: readIds.original }),
        expect.objectContaining({
          representation: 'original',
          verifiedBytes: 5,
          contentSha256: createHash('sha256').update('hello').digest('hex'),
        }),
      );
      expect(res.headers['x-file-metadata']).not.toContain('private-key');
    },
  );

  it('conceals a foreign download path before claiming a read or accessing content', async () => {
    const res = await request(app)
      .get('/files/download/foreign-path-user/operation')
      .set('Sec-Fetch-Site', 'same-origin')
      .set('X-Cortex-File-Read', readIds.original);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 'not_found' });
    expect(mockUploadRuntime.fileReads.claimManagedFileRead).not.toHaveBeenCalled();
    expect(mockUploadRuntime.storage.read).not.toHaveBeenCalled();
    expect(db.getFiles).not.toHaveBeenCalled();
    expect(res.headers['x-file-metadata']).toBeUndefined();
  });

  it('returns only ready status without a managed preview read ID', async () => {
    const res = await request(app)
      .get('/files/operation/preview')
      .set('Sec-Fetch-Site', 'same-origin');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ file_id: 'operation', status: 'ready' });
    expect(mockUploadRuntime.fileReads.claimManagedFileRead).not.toHaveBeenCalled();
    expect(mockUploadRuntime.storage.read).not.toHaveBeenCalled();
  });

  it('uses finite direct-URL fallback and the managed preview without legacy lazy mutation', async () => {
    const direct = await request(app)
      .get('/files/download-url/user-123/operation')
      .set('Sec-Fetch-Site', 'same-origin');
    expect(direct.status).toBe(501);
    expect(direct.body).toEqual({ code: 'authenticated_download_required' });
    const preview = await request(app)
      .get('/files/operation/preview')
      .set('Sec-Fetch-Site', 'same-origin')
      .set('X-Cortex-File-Read', readIds.preview);
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
