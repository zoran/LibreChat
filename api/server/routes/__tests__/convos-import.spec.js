const { PassThrough } = require('stream');
const { EventEmitter } = require('events');
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const MOCKS = '../__test-utils__/convos-route-mocks';
let mockLimit = 512;
let mockRealImport = false;
let mockUploadDirectory;
jest.mock('@librechat/agents', () => require(MOCKS).agents());
jest.mock('@librechat/api', () =>
  require(MOCKS).api({
    resolveImportMaxFileSize: () => mockLimit,
    createContentFilter: () => (_req, _res, next) => next(),
    extractStoredMessageContent: () => [],
    extractConversationTitleContent: () => [],
    isContentFilterError: () => false,
    restoreTenantContextFromReq: jest.requireActual(
      '../../../../packages/api/src/middleware/tenant.ts',
    ).restoreTenantContextFromReq,
  }),
);
jest.mock('@librechat/data-schemas', () => {
  const actual = jest.requireActual(
    '../../../../packages/data-schemas/src/config/tenantContext.ts',
  );
  return {
    ...require(MOCKS).dataSchemas(),
    tenantStorage: actual.tenantStorage,
    SYSTEM_TENANT_ID: actual.SYSTEM_TENANT_ID,
    getUserId: actual.getUserId,
    getRequestId: actual.getRequestId,
    getTenantId: actual.getTenantId,
  };
});
jest.mock('librechat-data-provider', () => require(MOCKS).dataProvider());
jest.mock('~/models', () => require(MOCKS).sharedModels());
jest.mock('~/server/services/Config', () => require(MOCKS).appConfig());
jest.mock('~/server/middleware/requireJwtAuth', () => require(MOCKS).requireJwtAuth());
jest.mock('~/server/middleware/requireManagedIntake', () => ({
  requireManagedIntake: (_req, _res, next) => next(),
}));
jest.mock('~/server/middleware', () => require(MOCKS).middlewarePassthrough());
jest.mock('~/server/utils/import/fork', () => require(MOCKS).forkUtils());
jest.mock('~/server/utils/import', () => ({
  importConversations: mockRealImport
    ? jest.fn(jest.requireActual('~/server/utils/import/importConversations'))
    : jest.fn(),
}));
jest.mock('~/server/utils/import/importers', () => ({
  getImporter: jest.fn(() => async () => {}),
}));
jest.mock('~/server/utils/import/importBatchBuilder', () => ({
  createImportBatchBuilder: jest.fn(),
}));
jest.mock('~/cache/getLogStores', () => require(MOCKS).logStores());
jest.mock('~/server/routes/files/multer', () => ({
  createStorage: () =>
    mockUploadDirectory
      ? require('multer').diskStorage({ destination: mockUploadDirectory })
      : require('multer').memoryStorage(),
  importFileFilter: (_req, _file, done) => done(null, true),
}));
jest.mock('~/server/services/Endpoints/azureAssistants', () => require(MOCKS).assistantEndpoint());
jest.mock('~/server/services/Endpoints/assistants', () => require(MOCKS).assistantEndpoint());
jest.mock('~/server/services/Endpoints/agents/subagentThreadStore', () =>
  require(MOCKS).subagentThreadStore(),
);
jest.mock('~/server/services/Endpoints/agents/backgroundCompletion', () => ({
  pendingBackgroundToolCompletions: { list: jest.fn() },
}));

const tick = () => new Promise((resolve) => setImmediate(resolve));
const tempDirectories = [];
afterEach(async () => {
  jest.restoreAllMocks();
  mockUploadDirectory = undefined;
  mockRealImport = false;
  delete process.env.TENANT_ISOLATION_STRICT;
  delete process.env.LIMIT_MESSAGE_IP;
  delete process.env.LIMIT_MESSAGE_USER;
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function diskUploads() {
  mockUploadDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'history-route-cleanup-'));
  tempDirectories.push(mockUploadDirectory);
  return mockUploadDirectory;
}

function fixture(limit = 512, options = {}) {
  mockLimit = limit;
  mockRealImport = options.realImport === true;
  let router, owner, importer, middleware, schemas, getImporter;
  jest.isolateModules(() => {
    router = require('../convos');
    owner = require('~/server/services/HistoryMaintenance').historyMaintenance;
    importer = require('~/server/utils/import').importConversations;
    if (!mockRealImport) importer.mockResolvedValue(undefined);
    middleware = require('~/server/middleware');
    schemas = require('@librechat/data-schemas');
    getImporter = require('~/server/utils/import/importers').getImporter;
  });
  const req = Object.assign(new PassThrough(), {
    method: 'POST',
    url: options.url ?? '/import',
    body: options.body,
    files: options.files,
    query: {},
    user: { id: 'owner', role: 'USER' },
    headers: {
      'content-type': 'multipart/form-data; boundary=real-history-import',
      'transfer-encoding': 'chunked',
      'x-request-id': 'import-request',
    },
  });
  let completeResponse;
  const response = new Promise((resolve) => {
    completeResponse = resolve;
  });
  const res = Object.assign(new EventEmitter(), {
    status(code) {
      this.statusCode = code;
      return this;
    },
    set() {
      return this;
    },
    json(body) {
      this.body = body;
      return this.end();
    },
    send(body) {
      this.body = body;
      return this.end();
    },
    end() {
      this.writableEnded = true;
      this.emit('finish');
      completeResponse(this);
      return this;
    },
  });
  router.handle(req, res, (error) => {
    if (error) res.status(400).json({ error: error.message });
  });
  const prefix =
    '--real-history-import\r\nContent-Disposition: form-data; name="file"; filename="import.json"\r\nContent-Type: application/json\r\n\r\n';
  const send = (bytes) =>
    req.end(
      Buffer.concat([Buffer.from(prefix), bytes, Buffer.from('\r\n--real-history-import--\r\n')]),
    );
  return { req, res, response, owner, importer, prefix, send, middleware, schemas, getImporter };
}

describe('actual conversation import route in process', () => {
  it.each([
    { ip: false, user: false },
    { ip: true, user: false },
    { ip: false, user: true },
    { ip: true, user: true },
  ])('executes every configured control limiter ip=$ip user=$user', async ({ ip, user }) => {
    process.env.LIMIT_MESSAGE_IP = String(ip);
    process.env.LIMIT_MESSAGE_USER = String(user);
    const f = fixture(512, {
      url: '/parent/subagents/thread/control',
      body: { taskId: 'task', invocationId: 'invocation', action: 'cancel' },
    });
    expect((await f.response).statusCode).toBe(200);
    expect(f.middleware.messageIpLimiter).toHaveBeenCalledTimes(ip ? 1 : 0);
    expect(f.middleware.messageUserLimiter).toHaveBeenCalledTimes(user ? 1 : 0);
    if (ip && user) {
      expect(f.middleware.messageIpLimiter.mock.invocationCallOrder[0]).toBeLessThan(
        f.middleware.messageUserLimiter.mock.invocationCallOrder[0],
      );
    }
    await tick();
    expect(f.owner.pauseAdmissions('control-limiters')).toBe(true);
    expect(await f.owner.getMaintenanceCensus('control-limiters')).toMatchObject({
      pendingWrites: 0,
      queuedContinuations: 0,
      complete: true,
    });
  });

  it.each([
    { cleanupFails: false, importFails: false },
    { cleanupFails: true, importFails: false },
    { cleanupFails: true, importFails: true },
  ])(
    'retains the real import final unlink cleanupFails=$cleanupFails importFails=$importFails',
    async ({ cleanupFails, importFails }) => {
      await diskUploads();
      const f = fixture(512, { realImport: true });
      const importError = new Error('original import failure');
      if (importFails)
        f.getImporter.mockReturnValueOnce(async () => {
          throw importError;
        });
      const cleanupError = new Error('final unlink failure');
      const originalUnlink = fs.unlink.bind(fs);
      let entered, finish;
      const started = new Promise((resolve) => {
        entered = resolve;
      });
      const unlink = jest.spyOn(fs, 'unlink').mockImplementationOnce((filepath) => {
        entered();
        return new Promise((resolve, reject) => {
          finish = () =>
            cleanupFails ? reject(cleanupError) : originalUnlink(filepath).then(resolve, reject);
        });
      });
      f.send(Buffer.from('{}'));
      await started;
      f.res.emit('close');
      expect(f.owner.pauseAdmissions('real-import-cleanup')).toBe(true);
      let drained = false;
      const drain = f.owner.drain().then(
        () => {
          drained = true;
          return undefined;
        },
        (error) => {
          drained = true;
          return error;
        },
      );
      try {
        await tick();
        expect(drained).toBe(false);
        expect(
          (await f.owner.getMaintenanceCensus('real-import-cleanup')).pendingWrites,
        ).toBeGreaterThan(0);
      } finally {
        finish();
      }
      expect((await f.response).statusCode).toBe(importFails ? 500 : 201);
      const drainError = await drain;
      expect(drainError?.message).toBe(cleanupFails ? 'HISTORY_SETTLEMENT_UNCONFIRMED' : undefined);
      expect(await f.owner.getMaintenanceCensus('real-import-cleanup')).toMatchObject({
        pendingWrites: 0,
        complete: !cleanupFails,
      });
      expect(unlink).toHaveBeenCalledTimes(1);
      expect(f.getImporter).toHaveBeenCalledTimes(1);
      if (importFails)
        expect(f.schemas.logger.error).toHaveBeenCalledWith('Error processing file', importError);
    },
  );

  it('retains every real tenant cleanup sibling after peer close and marks a rejected unlink unknown', async () => {
    const directory = await diskUploads();
    const sibling = path.join(directory, 'sibling.json');
    await fs.writeFile(sibling, '{}');
    process.env.TENANT_ISOLATION_STRICT = 'true';
    const f = fixture(512, { files: [{ path: sibling }, { path: sibling }] });
    const originalUnlink = fs.unlink.bind(fs);
    let entered, finish;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const contexts = [];
    const unlink = jest.spyOn(fs, 'unlink').mockImplementation((filepath) => {
      contexts.push({ userId: f.schemas.getUserId(), requestId: f.schemas.getRequestId() });
      if (filepath !== sibling) return Promise.reject(new Error('rejected upload unlink failed'));
      entered();
      return new Promise((resolve, reject) => {
        finish = () => originalUnlink(filepath).then(resolve, reject);
      });
    });
    f.send(Buffer.from('{}'));
    await started;
    f.res.emit('close');
    expect(f.owner.pauseAdmissions('tenant-cleanup')).toBe(true);
    let drained = false;
    const drain = f.owner.drain().then(
      () => {
        drained = true;
        return undefined;
      },
      (error) => {
        drained = true;
        return error;
      },
    );
    try {
      await tick();
      expect(drained).toBe(false);
      expect(f.res.statusCode).toBeUndefined();
      expect((await f.owner.getMaintenanceCensus('tenant-cleanup')).pendingWrites).toBeGreaterThan(
        0,
      );
      expect(unlink).toHaveBeenCalledTimes(2);
      expect(contexts).toEqual(Array(2).fill({ userId: 'owner', requestId: 'import-request' }));
    } finally {
      finish();
    }
    expect((await f.response).statusCode).toBe(403);
    expect((await drain).message).toBe('HISTORY_SETTLEMENT_UNCONFIRMED');
    expect(f.importer).not.toHaveBeenCalled();
    expect(await f.owner.getMaintenanceCensus('tenant-cleanup')).toMatchObject({
      pendingWrites: 0,
      complete: false,
    });
  });

  it.each([
    { limit: 1024, bytes: 1536, status: 413 },
    { limit: 4096, bytes: 64, status: 201 },
    { limit: 512, bytes: 513, status: 413 },
    { limit: 512, bytes: 511, status: 201 },
  ])(
    'preserves the real Multer $bytes-byte boundary and HTTP $status',
    async ({ limit, bytes, status }) => {
      const f = fixture(limit);
      f.send(Buffer.alloc(bytes, 'a'));
      expect((await f.response).statusCode).toBe(status);
      await tick();
      expect(f.importer).toHaveBeenCalledTimes(status === 201 ? 1 : 0);
      expect(f.owner.pauseAdmissions('import-boundary')).toBe(true);
      expect(await f.owner.getMaintenanceCensus('import-boundary')).toMatchObject({
        queuedContinuations: 0,
        pendingWrites: 0,
        complete: true,
      });
    },
  );

  it('retains the original Multer completion after response closure', async () => {
    const f = fixture();
    f.req.write(f.prefix + '{}');
    await tick();
    f.res.emit('close');
    expect(f.owner.pauseAdmissions('import-stream')).toBe(true);
    expect((await f.owner.getMaintenanceCensus('import-stream')).pendingWrites).toBeGreaterThan(0);
    f.req.end('\r\n--real-history-import--\r\n');
    expect((await f.response).statusCode).toBe(201);
    await tick();
    expect(f.importer).toHaveBeenCalledTimes(1);
    expect(await f.owner.getMaintenanceCensus('import-stream')).toMatchObject({
      pendingWrites: 0,
      complete: true,
    });
  });

  it('retains the actual importer original through disconnect and shutdown', async () => {
    const f = fixture();
    let complete;
    f.importer.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    f.send(Buffer.from('{}'));
    await tick();
    expect(f.importer).toHaveBeenCalledTimes(1);
    f.req.emit('aborted');
    f.res.emit('close');
    expect(f.owner.pauseAdmissions('import-write')).toBe(true);
    let settled = false;
    const drain = f.owner.drain().then(() => {
      settled = true;
    });
    try {
      await tick();
      expect(settled).toBe(false);
      expect(await f.owner.getMaintenanceCensus('import-write')).toMatchObject({
        pendingWrites: 1,
      });
    } finally {
      complete();
    }
    await drain;
    expect((await f.response).statusCode).toBe(201);
    expect(settled).toBe(true);
  });
});
