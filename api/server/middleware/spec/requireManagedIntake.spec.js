const express = require('express');
const request = require('supertest');

const MOCKS = '../../routes/__test-utils__/convos-route-mocks';
let mockMode = 'transition';
const mockWrite = jest.fn((_req, res) => res.status(201).json({ saved: true }));
const mockRead = jest.fn((_req, res) => res.json({ items: [] }));
const mockSync = jest.fn();
const mockMulter = jest.fn();
const mockImport = jest.fn();

jest.mock('@librechat/api', () =>
  require(MOCKS).api({
    getAuthMode: () => mockMode,
    createAdminSkillsSyncAccess: () => {
      const allow = (_req, _res, next) => next();
      return {
        attachBaseSkillSyncConfig: allow,
        requireReadSkills: allow,
        attachCredentialReadAccess: allow,
        requireSyncRunCapability: allow,
        requirePlatformManageSkills: allow,
      };
    },
    createAdminSkillsSyncHandlers: () => ({
      getSyncStatus: mockRead,
      runSync: mockWrite,
      setCredential: mockWrite,
      deleteCredential: mockWrite,
    }),
    createContentFilter: () => (_req, _res, next) => next(),
    generateCheckAccess: () => (_req, _res, next) => next(),
    restoreTenantContextFromReq: (_req, _res, next) => next(),
    createImportHandler:
      () =>
      (...args) =>
        mockWrite(...args),
    createSkillUploadHandler:
      () =>
      (...args) =>
        mockWrite(...args),
    createSkillManagementHandlers: ({ beforeList }) => ({
      list: async (req, res) => {
        await beforeList(req);
        return mockRead(req, res);
      },
      get: mockRead,
      update: mockWrite,
      listFiles: mockRead,
      getFile: mockRead,
      updateFile: mockWrite,
    }),
    mapAgentManagementError: () => ({ status: 404, body: { error: {} } }),
  }),
);
jest.mock('@librechat/data-schemas', () => ({
  ...require(MOCKS).dataSchemas(),
  SystemCapabilities: { ACCESS_ADMIN: 'ACCESS_ADMIN' },
}));
jest.mock('~/models', () => require(MOCKS).sharedModels());
jest.mock('~/server/services/Config', () => require(MOCKS).appConfig());
jest.mock('~/server/middleware/requireJwtAuth', () => require(MOCKS).requireJwtAuth());
jest.mock('~/server/middleware', () => ({
  ...require(MOCKS).middlewarePassthrough(),
  requireJwtAuth: (_req, _res, next) => next(),
  checkBan: (_req, _res, next) => next(),
  uaParser: (_req, _res, next) => next(),
  canAccessSkillResource: () => (_req, _res, next) => next(),
  createFileLimiters: () => ({
    fileUploadIpLimiter: (_req, _res, next) => next(),
    fileUploadUserLimiter: (_req, _res, next) => next(),
  }),
  createFileUsageLimiter: () => (_req, _res, next) => next(),
}));
jest.mock('~/server/utils/import/fork', () => require(MOCKS).forkUtils());
jest.mock('~/server/utils/import', () => ({
  importConversations: (...args) => mockImport(...args),
}));
jest.mock('~/cache/getLogStores', () => require(MOCKS).logStores());
jest.mock('~/server/routes/files/multer', () => ({
  createStorage: () => require('multer').memoryStorage(),
  importFileFilter: (_req, _file, callback) => callback(null, true),
  createMulterInstance: async () =>
    require('multer')({ storage: require('multer').memoryStorage() }),
}));
// Observe the real Multer parser; neither multipart parsing nor the intake gate is replaced.
jest.mock('multer', () => {
  const actual = jest.requireActual('multer');
  const observed = (options) => {
    const upload = actual(options);
    const single = upload.single.bind(upload);
    upload.single = (field) => {
      const parse = single(field);
      return (req, res, next) => {
        mockMulter();
        return parse(req, res, next);
      };
    };
    return upload;
  };
  return Object.assign(observed, actual);
});
jest.mock('~/server/services/Endpoints/azureAssistants', () => require(MOCKS).assistantEndpoint());
jest.mock('~/server/services/Endpoints/assistants', () => require(MOCKS).assistantEndpoint());
jest.mock('~/server/services/Endpoints/agents/subagentThreadStore', () =>
  require(MOCKS).subagentThreadStore(),
);
jest.mock('~/server/services/Endpoints/agents/backgroundCompletion', () => ({
  pendingBackgroundToolCompletions: { list: jest.fn() },
}));
jest.mock('~/server/services/PermissionService', () => ({
  grantPermission: jest.fn(),
  checkPermission: jest.fn(),
}));
jest.mock('~/server/services/Files/strategies', () => ({ getStrategyFunctions: jest.fn() }));
jest.mock('~/server/utils/getFileStrategy', () => ({ getFileStrategy: jest.fn() }));
jest.mock('~/server/middleware/limiters/uploadLimiters', () => ({
  createFileLimiters: () => ({
    fileUploadIpLimiter: (_req, _res, next) => next(),
    fileUploadUserLimiter: (_req, _res, next) => next(),
  }),
}));
jest.mock('~/server/middleware/config/app', () => (_req, _res, next) => next());
jest.mock('~/server/services/Skills/sync', () => ({
  maybeRunGitHubSkillSyncForRequest: (...args) => mockSync(...args),
}));
jest.mock('~/server/services/Skills/handlers', () => ({
  getSkillsHandlers: () => ({
    list: mockRead,
    get: mockRead,
    listFiles: mockRead,
    downloadFile: mockRead,
    create: mockWrite,
    patch: mockWrite,
    delete: mockWrite,
    deleteFile: mockWrite,
  }),
}));
jest.mock('~/server/middleware/roles/capabilities', () => ({
  hasCapability: jest.fn(),
  requireCapability: () => (_req, _res, next) => next(),
}));
jest.mock('~/server/services/Endpoints/agents/skillDeps', () => ({
  getSkillDbMethods: () => ({}),
  getSkillManagementFileSaver: () => jest.fn(),
}));
jest.mock('~/server/routes/agents/middleware', () => ({
  requireAgentManagementAuth: (_req, _res, next) => next(),
}));
jest.mock('~/server/utils/files', () => ({ getContentDisposition: jest.fn() }));
jest.mock('~/server/routes/assistants/v1', () => ({ avatar: (_req, res) => mockWrite(_req, res) }));
jest.mock('~/server/routes/agents/v1', () => ({ avatar: (_req, res) => mockWrite(_req, res) }));
jest.mock('~/server/routes/files/files', () => {
  const router = require('express').Router();
  router.post('/usage', (...args) => mockRead(...args));
  router.post('/', (...args) => mockWrite(...args));
  return router;
});
jest.mock('~/server/routes/files/images', () => (_req, res) => mockWrite(_req, res));
jest.mock('~/server/routes/files/avatar', () => (_req, res) => mockWrite(_req, res));
jest.mock('~/server/routes/files/speech', () => (_req, res) => mockWrite(_req, res));

const writes = [
  ['post', '/api/admin/skills/sync/run', null],
  ['post', '/api/convos/import', 'import.json'],
  ['post', '/api/skills/import', 'skill.md'],
  ['post', '/api/skills', null],
  ['patch', '/api/skills/skill-id', null],
  ['post', '/api/skills/skill-id/files', 'script.txt'],
  ['post', '/api/skills/skill-id/files/nested/script.txt', 'script.txt'],
  ['patch', '/api/agents/v1/skills/skill-id', null],
  ['put', '/api/agents/v1/skills/skill-id/files/nested/script.txt', null],
  ['post', '/api/files', 'file.txt'],
  ['post', '/api/files/images', 'image.png'],
  ['post', '/api/files/speech/stt', null],
  ['post', '/api/files/speech/tts', null],
];

function send(app, method, path, filename) {
  const call = request(app)[method](path);
  return filename
    ? call.attach('file', Buffer.from('{}'), filename)
    : call.send({ content: 'file content' });
}

function expectDenied(response) {
  expect(response.status).toBe(403);
  expect(response.body).toEqual({ code: 'managed_upload_required' });
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers.connection).toBe('close');
  expect(mockMulter).not.toHaveBeenCalled();
  expect(mockWrite).not.toHaveBeenCalled();
  expect(mockImport).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMode = 'transition';
});

describe('actual route ingress', () => {
  let app;
  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 'user', role: 'USER' };
      req.config = {};
      next();
    });
    app.use('/api/convos', require('../../routes/convos'));
    app.use('/api/skills', require('../../routes/skills'));
    app.use('/api/agents/v1/skills', require('../../routes/agents/skills'));
    app.use('/api/admin/skills', require('../../routes/admin/skills'));
    app.use('/api/files', await require('../../routes/files').initialize());
  });

  test.each(
    writes.flatMap(([method, path, filename]) => [
      [method, path, filename],
      [method, `${path.toUpperCase()}/?x=1`, filename],
    ]),
  )('Cortex blocks %s %s before Multer or the write sink', async (method, path, filename) => {
    expect.assertions(7);
    expectDenied(await send(app, method, path, filename));
  });

  test.each(writes)('default retains %s %s', async (method, path, filename) => {
    mockMode = 'default';
    expect((await send(app, method, path, filename)).status).toBe(201);
    expect(mockWrite.mock.calls.length + mockImport.mock.calls.length).toBe(1);
    if (filename) expect(mockMulter).toHaveBeenCalledTimes(1);
  });

  test.each(['/api/skills', '/api/agents/v1/skills'])(
    'Cortex lists %s without request-scoped sync',
    async (path) => {
      await request(app).get(path).expect(200);
      expect(mockRead).toHaveBeenCalledTimes(1);
      expect(mockSync).not.toHaveBeenCalled();
    },
  );

  test.each(['/api/skills', '/api/agents/v1/skills'])(
    'default lists %s with request-scoped sync',
    async (path) => {
      mockMode = 'default';
      await request(app).get(path).expect(200);
      expect(mockSync).toHaveBeenCalledTimes(1);
    },
  );

  test.each(['/api/files/usage', '/api/files/UsAgE/'])(
    'preserves the metadata-only exemption %s',
    async (path) => {
      await request(app).post(path).send({ file_id: 'file-id' }).expect(200);
      expect(mockMulter).not.toHaveBeenCalled();
    },
  );

  test('preserves an ordinary owned conversation read', async () => {
    require('~/models').getConvo.mockResolvedValueOnce({ conversationId: 'chat' });
    const response = await request(app).get('/api/convos/chat');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ conversationId: 'chat' });
  });

  test.each(['/api/files/usage/extra', '/api/files/usage-extra'])(
    'does not widen the metadata exemption to %s',
    async (path) => {
      expect.assertions(7);
      expectDenied(await request(app).post(path).send({ content: 'file content' }));
    },
  );

  test('email_code closes the same unmanaged ingress', async () => {
    mockMode = 'email_code';
    expect.assertions(7);
    expectDenied(
      await request(app).patch('/api/agents/v1/skills/id').send({ content: 'file content' }),
    );
  });
});

describe('pre-parser entry guard', () => {
  let app;
  const parserReached = jest.fn();
  beforeAll(() => {
    app = express();
    app.use(require('../requireManagedIntake').createManagedIntakeIngress());
    app.use((_req, _res, next) => {
      parserReached();
      next();
    });
    app.use(express.json({ limit: '8b' }));
    app.use(express.urlencoded({ extended: false, limit: '8b' }));
    app.use('/api/admin/skills', require('../../routes/admin/skills'));
    app.use((_req, res) => res.sendStatus(204));
  });

  test.each(
    writes.flatMap(([method, path]) => [
      [method, path],
      [method, `${path.toUpperCase()}/?x=1`],
    ]),
  )(
    'rejects %s %s before global parsers including case/trailing-slash variants',
    async (method, path) => {
      expectDenied(
        await request(app)
          [method](path)
          .set('Content-Type', 'application/json')
          .send('{malformed payload'),
      );
      expect(parserReached).not.toHaveBeenCalled();
    },
  );

  test('rejects urlencoded content before its parser', async () => {
    expectDenied(await request(app).patch('/api/skills/id').type('form').send('content=oversize'));
    expect(parserReached).not.toHaveBeenCalled();
  });

  test('default still reaches the existing parser and its size limit', async () => {
    mockMode = 'default';
    await request(app).post('/api/skills').send({ content: 'oversize' }).expect(413);
    expect(parserReached).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['post', '/api/files/UsAgE/'],
    ['get', '/api/skills'],
    ['delete', '/api/skills/id'],
    ['post', '/api/convos/update'],
    ['post', '/api/agents/chat'],
    ['post', '/api/uploads/id/body'],
  ])('leaves unrelated or managed %s %s to its owner', async (method, path) => {
    await request(app)[method](path).expect(204);
    expect(parserReached).toHaveBeenCalledTimes(1);
  });
});
