/** Actual authenticated Files-router composition; identity issuer and storage are fixtures. */
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
  SystemCapabilities: {},
  runAsSystem: (work) => work(),
}));
let mockMode = 'default';
let mockRuntime;
const mockOwner = { userId: '0123456789abcdef01234567', tenantId: 'library-tenant' };
jest.mock('@librechat/api', () => ({
  createManagedFileHandlers: jest.requireActual('@librechat/api').createManagedFileHandlers,
  getAuthMode: () => mockMode,
  restoreTenantContextFromReq: (_req, _res, next) => next(),
}));
jest.mock('~/server/services/Uploads', () => ({ getUploadRuntime: () => mockRuntime }));
jest.mock('~/models', () => ({
  getFileLibraryPage: jest.fn(),
  updateFileLibrary: jest.fn(),
}));
jest.mock('~/server/services/Files/process', () => ({
  filterFile: jest.fn(),
  processFileUpload: jest.fn(),
  processDeleteRequest: jest.fn(),
  processAgentFileUpload: jest.fn(),
}));
jest.mock('~/server/services/Files/strategies', () => ({ getStrategyFunctions: jest.fn() }));
jest.mock('~/server/controllers/assistants/helpers', () => ({ getOpenAIClient: jest.fn() }));
jest.mock('~/server/middleware/roles/capabilities', () => ({ hasCapability: jest.fn() }));
jest.mock('~/server/services/PermissionService', () => ({ checkPermission: jest.fn() }));
jest.mock('~/server/services/Files', () => ({ hasAccessToFilesViaAgent: jest.fn() }));
jest.mock('~/cache', () => ({ getLogStores: jest.fn() }));
jest.mock('~/server/middleware', () => {
  const pass = (_req, _res, next) => next();
  return {
    requireJwtAuth(req, res, next) {
      if (req.headers.authorization !== 'Bearer library-fixture')
        return res.status(401).json({ code: 'unauthorized' });
      req.user = { id: mockOwner.userId, tenantId: mockOwner.tenantId, provider: 'email_code' };
      next();
    },
    configMiddleware: pass,
    checkBan: pass,
    uaParser: pass,
    createFileLimiters: () => ({ fileUploadIpLimiter: pass, fileUploadUserLimiter: pass }),
    createFileUsageLimiter: () => pass,
  };
});
jest.mock('~/server/routes/assistants/v1', () => ({ avatar: require('express').Router() }));
jest.mock('~/server/routes/agents/v1', () => ({ avatar: require('express').Router() }));
jest.mock('./multer', () => ({
  createMulterInstance: async () => ({ single: () => (_req, _res, next) => next() }),
}));
jest.mock('./images', () => require('express').Router());
jest.mock('./avatar', () => require('express').Router());
jest.mock('./speech', () => require('express').Router());

const express = require('express');
const request = require('supertest');
const methods = require('~/models');
const { initialize } = require('./index');
const { createManagedSourceResolver } = jest.requireActual('@librechat/api');

describe('File library HTTP adapter', () => {
  const origin = 'https://library.example.test';
  const metadata = { tags: [], archivedAt: null, revision: 0 };
  const cursor = 'fedcba987654321001234567';
  let app;
  let file;
  let operation;

  const get = (query = '') =>
    request(app)
      .get(`/api/files/library${query}`)
      .set('Authorization', 'Bearer library-fixture')
      .set('Origin', origin);
  const patch = (body, id = 'file-one') =>
    request(app)
      .patch(`/api/files/${id}/library`)
      .set('Authorization', 'Bearer library-fixture')
      .set('Origin', origin)
      .send(body);

  beforeEach(async () => {
    jest.clearAllMocks();
    mockMode = 'default';
    file = {
      file_id: 'file-one',
      filename: 'notes.txt',
      type: 'text/plain',
      bytes: 12,
      filepath: 'https://storage.invalid/private?signature=secret',
      source: 's3',
      embedded: true,
      object: 'file',
      usage: 0,
      user: mockOwner.userId,
      library: metadata,
      storageKey: 'private/key',
      securityApproval: { private: true },
      text: 'private document content',
      documentStructure: { private: true },
      tenantId: mockOwner.tenantId,
      uploadOperationId: 'file-one',
    };
    operation = {
      id: file.file_id,
      fileId: file.file_id,
      scope: { kind: 'personal' },
      state: 'ready',
      canUseInComposer: true,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    mockRuntime = {
      allowedOrigins: [origin],
      principal: jest.fn().mockResolvedValue({ ...mockOwner, authentication: 'verified-email' }),
      management: { get: jest.fn().mockImplementation(async () => operation) },
    };
    // Use the production source authorizer for this authorization-only consumer.
    mockRuntime.sources = createManagedSourceResolver({
      allowedOrigins: mockRuntime.allowedOrigins,
      principal: (req) => mockRuntime.principal(req),
    });
    methods.getFileLibraryPage.mockResolvedValue({ files: [file], nextCursor: cursor });
    methods.updateFileLibrary.mockResolvedValue({
      kind: 'updated',
      library: { tags: ['Project'], archivedAt: null, revision: 1 },
    });
    app = express();
    app.use(express.json());
    app.use('/api/files', await initialize());
  });

  it('requires the existing router authentication before either handler', async () => {
    expect((await request(app).get('/api/files/library')).status).toBe(401);
    expect((await request(app).patch('/api/files/file-one/library').send({})).status).toBe(401);
    expect(methods.getFileLibraryPage).not.toHaveBeenCalled();
    expect(methods.updateFileLibrary).not.toHaveBeenCalled();
  });

  it('binds owner on the server and returns only canonical public fields and a download route', async () => {
    const response = await get('?limit=2&search=%20notes%20&archive=all');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(methods.getFileLibraryPage).toHaveBeenCalledWith(mockOwner, {
      limit: 2,
      search: 'notes',
      archive: 'all',
    });
    expect(response.body).toEqual({
      files: [
        {
          file_id: 'file-one',
          filename: 'notes.txt',
          type: 'text/plain',
          bytes: 12,
          filepath: `/api/files/download/${mockOwner.userId}/file-one`,
          source: 's3',
          user: mockOwner.userId,
          embedded: true,
          object: 'file',
          usage: 0,
          library: metadata,
        },
      ],
      nextCursor: cursor,
    });
  });

  it.each([
    '?tenantId=foreign',
    '?userId=foreign',
    '?limit=51',
    '?limit=1&limit=2',
    '?limit=1e1',
    '?cursor=bad',
    '?archive=deleted',
    '?search[x]=value',
    '?projectId=foreign',
  ])('rejects malformed or caller-owned query %s without storage access', async (query) => {
    const response = await get(query);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ code: 'invalid_request' });
    expect(response.headers['cache-control']).toContain('no-store');
    expect(methods.getFileLibraryPage).not.toHaveBeenCalled();
  });

  it('passes bounded collection/cursor filters through the same contract', async () => {
    const response = await get(`?cursor=${cursor}&projectId=${cursor}&tag=Work&type=text%2Fplain`);
    expect(response.status).toBe(200);
    expect(methods.getFileLibraryPage).toHaveBeenCalledWith(mockOwner, {
      limit: 25,
      archive: 'active',
      cursor,
      projectId: cursor,
      tag: 'Work',
      type: 'text/plain',
    });
  });

  it('returns only revisioned organization metadata from the CAS owner', async () => {
    const response = await patch({ expectedRevision: 0, tags: [' Project ', 'project'] });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ tags: ['Project'], archivedAt: null, revision: 1 });
    expect(methods.updateFileLibrary).toHaveBeenCalledWith(mockOwner, 'file-one', {
      expectedRevision: 0,
      tags: ['Project'],
    });
  });

  it.each([
    { tags: [] },
    { expectedRevision: 0 },
    { expectedRevision: -1, archived: true },
    { expectedRevision: 0, archived: 'true' },
    { expectedRevision: 0, tags: [''] },
    { expectedRevision: 0, archived: true, tenantId: 'foreign' },
    { expectedRevision: 0, archived: true, expiredAt: '2099-01-01' },
    { expectedRevision: 0, archived: true, text: 'new bytes' },
  ])('rejects invalid metadata without mutation: %j', async (body) => {
    const response = await patch(body);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ code: 'invalid_request' });
    expect(methods.updateFileLibrary).not.toHaveBeenCalled();
  });

  it.each([
    ['conflict', 409, 'revision_conflict'],
    ['unavailable', 404, 'not_found'],
  ])('maps %s safely', async (kind, status, code) => {
    methods.updateFileLibrary.mockResolvedValue({ kind });
    const response = await patch({ expectedRevision: 0, archived: true });
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ code });
  });

  it('sanitizes unknown storage failures', async () => {
    methods.getFileLibraryPage.mockRejectedValue(
      new Error('mongodb://secret/path private payload'),
    );
    const response = await get();
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ code: 'unavailable' });
  });

  describe('current managed approval', () => {
    beforeEach(() => {
      mockMode = 'email_code';
    });

    it('uses current operation authority and a canonical managed download', async () => {
      const response = await get();
      expect(response.status).toBe(200);
      expect(response.body.files[0].filepath).toBe('/api/files/managed/file-one');
      expect(mockRuntime.management.get).toHaveBeenCalledWith(
        { ...mockOwner, authentication: 'verified-email' },
        'file-one',
      );
      expect(mockRuntime.principal).toHaveBeenCalledTimes(3);
    });

    it.each(['missing', 'failed', 'expired', 'wrong-file', 'not-approved'])(
      'hides %s operations while preserving the bounded cursor',
      async (state) => {
        if (state === 'missing')
          mockRuntime.management.get.mockRejectedValue(
            Object.assign(new Error(), { code: 'not_found' }),
          );
        if (state === 'failed') operation.state = 'failed';
        if (state === 'expired') operation.expiresAt = new Date(0).toISOString();
        if (state === 'wrong-file') operation.fileId = 'foreign';
        if (state === 'not-approved') operation.canUseInComposer = false;
        const response = await get();
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ files: [], nextCursor: cursor });
        expect((await patch({ expectedRevision: 0, archived: true })).status).toBe(404);
        expect(methods.updateFileLibrary).not.toHaveBeenCalled();
      },
    );

    it('denies cross-tenant/current-principal mismatch before storage', async () => {
      mockRuntime.principal.mockResolvedValue({
        ...mockOwner,
        tenantId: 'foreign',
        authentication: 'verified-email',
      });
      expect((await get()).status).toBe(404);
      expect(methods.getFileLibraryPage).not.toHaveBeenCalled();
      expect((await patch({ expectedRevision: 0, archived: true })).status).toBe(404);
      expect(methods.updateFileLibrary).not.toHaveBeenCalled();
    });

    it('rechecks operation approval after mutation before reporting success', async () => {
      mockRuntime.management.get
        .mockResolvedValueOnce(operation)
        .mockResolvedValueOnce({ ...operation, state: 'deleting' });
      expect((await patch({ expectedRevision: 0, archived: true })).status).toBe(404);
      expect(methods.updateFileLibrary).toHaveBeenCalledTimes(1);
    });

    it('rejects revoked sessions after storage and unknown operation failures', async () => {
      mockRuntime.principal
        .mockResolvedValueOnce({ ...mockOwner, authentication: 'verified-email' })
        .mockRejectedValueOnce(
          Object.assign(new Error('private session'), { code: 'unauthorized' }),
        );
      expect((await get()).status).toBe(401);
      mockRuntime.principal.mockResolvedValue({ ...mockOwner, authentication: 'verified-email' });
      mockRuntime.management.get.mockRejectedValue(new Error('private repository failure'));
      const response = await get();
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ code: 'unavailable' });
    });

    it('preserves Origin and legacy byte-ingress restrictions while permitting metadata PATCH', async () => {
      const foreign = await request(app)
        .patch('/api/files/file-one/library')
        .set('Authorization', 'Bearer library-fixture')
        .set('Origin', 'https://foreign.invalid')
        .send({ expectedRevision: 0, archived: true });
      expect(foreign.status).toBe(404);
      expect(methods.updateFileLibrary).not.toHaveBeenCalled();
      expect((await patch({ expectedRevision: 0, archived: true })).status).toBe(200);
      const upload = await request(app)
        .post('/api/files')
        .set('Authorization', 'Bearer library-fixture')
        .send({});
      expect(upload.status).toBe(403);
      expect(upload.body).toEqual({ code: 'managed_upload_required' });
    });
  });
});
