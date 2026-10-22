const express = require('express');
const request = require('supertest');

const hits = { uploadIp: 0, uploadUser: 0, usage: 0, multer: 0, admitted: 0, inspected: 0 };
const originalAuthMode = process.env.AUTH_MODE;

jest.mock('~/server/middleware', () => ({
  createFileLimiters: jest.fn(() => ({
    fileUploadIpLimiter: (req, res, next) => {
      hits.uploadIp++;
      next();
    },
    fileUploadUserLimiter: (req, res, next) => {
      hits.uploadUser++;
      next();
    },
  })),
  createFileUsageLimiter: jest.fn(() => (req, res, next) => {
    hits.usage++;
    next();
  }),
  configMiddleware: (req, res, next) => {
    req.config = { fileStrategy: 'local', paths: { uploads: '/tmp', images: '/tmp' } };
    next();
  },
  requireJwtAuth: (req, res, next) => {
    req.user = { id: 'user-1', role: 'USER' };
    next();
  },
  uaParser: (req, res, next) => next(),
  checkBan: (req, res, next) => next(),
}));

jest.mock('./multer', () => ({
  createMulterInstance: jest.fn(async () => ({
    single: jest.fn(() => (req, res, next) => {
      hits.multer++;
      next();
    }),
  })),
}));

const okRouter = (paths) => {
  const router = express.Router();
  for (const path of paths) {
    router.post(path, (req, res) => res.status(200).json({ ok: true }));
  }
  return router;
};

jest.mock('./files', () => {
  const express = require('express');
  const router = express.Router();
  const { createManagedFileHandlers, isCortexFileMode } = require('./managed');
  const managed = createManagedFileHandlers({
    getRuntime: () => ({
      sources: {
        authorize: async () => ({
          tenantId: 'tenant-a',
          userId: 'user-1',
          authentication: 'verified-email',
        }),
      },
      fileReads: {
        admitManagedFileRead: async (_principal, input) => {
          hits.admitted++;
          return {
            version: 1,
            readId: 'A'.repeat(43),
            ...input,
            admittedAt: new Date().toISOString(),
            notAfter: new Date(Date.now() + 120_000).toISOString(),
          };
        },
        inspectManagedFileRead: async () => {
          hits.inspected++;
          return { status: 'completed', completedAt: new Date().toISOString() };
        },
      },
    }),
  });
  router.get('/download-url/:userId/:file_id', (req, res) => {
    if (isCortexFileMode()) return managed.downloadURL(req, res);
    return res.json({ url: 'upstream-download' });
  });
  router.post('/', (req, res) => res.status(200).json({ ok: true }));
  router.post('/usage', (req, res) => res.status(200).json({ ok: true }));
  return router;
});

jest.mock('./images', () => okRouter(['/']));
jest.mock('./avatar', () => okRouter(['/']));
jest.mock('./speech', () => okRouter(['/stt']));

jest.mock('~/server/routes/agents/v1', () => ({
  avatar: okRouter(['/:agent_id/avatar/']),
}));
jest.mock('~/server/routes/assistants/v1', () => ({
  avatar: okRouter(['/:assistant_id/avatar/']),
}));

describe('file route limiter wiring', () => {
  let app;

  beforeAll(async () => {
    const { initialize } = require('./index');
    app = express();
    app.use(express.json());
    app.use('/api/files', await initialize());
  });

  beforeEach(() => {
    process.env.AUTH_MODE = 'default';
    hits.uploadIp = 0;
    hits.uploadUser = 0;
    hits.usage = 0;
    hits.multer = 0;
    hits.admitted = 0;
    hits.inspected = 0;
  });
  afterAll(() => {
    if (originalAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = originalAuthMode;
  });

  test.each([
    '/download-url/user-1/file-1',
    '/download-url/user-1/file-1/',
    '/DOWNLOAD-URL/user-1/file-1',
  ])('meters managed admission on the actual non-strict GET route %s', async (path) => {
    process.env.AUTH_MODE = 'transition';
    const response = await request(app).get(`/api/files${path}?read=1&representation=original`);
    expect(response.status).toBe(200);
    expect(hits.admitted).toBe(1);
    expect(hits.usage).toBe(1);
    expect(hits.uploadIp).toBe(0);
    expect(hits.uploadUser).toBe(0);
  });

  it('keeps same-identity inspection available without admitting or consuming fresh-admission quota', async () => {
    process.env.AUTH_MODE = 'email_code';
    const response = await request(app)
      .get('/api/files/download-url/user-1/file-1/?read=1&representation=preview')
      .set('X-Cortex-File-Read', 'A'.repeat(43));
    expect(response.status).toBe(204);
    expect(hits.inspected).toBe(1);
    expect(hits.admitted).toBe(0);
    expect(hits.usage).toBe(0);
  });

  it('cannot turn a malformed read header into an unmetered admission', async () => {
    process.env.AUTH_MODE = 'transition';
    const response = await request(app)
      .get('/api/files/download-url/user-1/file-1?read=1&representation=original')
      .set('X-Cortex-File-Read', 'invalid');
    expect(response.status).toBe(400);
    expect(hits.admitted).toBe(0);
    expect(hits.inspected).toBe(0);
    expect(hits.usage).toBe(0);
  });

  it('preserves default-mode preparation without managed admission quota', async () => {
    const response = await request(app).get(
      '/api/files/download-url/user-1/file-1?read=1&representation=original',
    );
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ url: 'upstream-download' });
    expect(hits.admitted).toBe(0);
    expect(hits.usage).toBe(0);
  });

  it('rejects implicit preparation HEAD before any receipt can be written', async () => {
    process.env.AUTH_MODE = 'transition';
    const response = await request(app).head(
      '/api/files/download-url/user-1/file-1/?read=1&representation=original',
    );
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('GET');
    expect(hits.admitted).toBe(0);
    expect(hits.inspected).toBe(0);
    expect(hits.uploadIp).toBe(0);
    expect(hits.uploadUser).toBe(0);
  });

  it('meters POST /usage with the usage limiter, never leaving it unlimited', async () => {
    const response = await request(app)
      .post('/api/files/usage')
      .send({ file_ids: ['f1'] });

    expect(response.status).toBe(200);
    expect(hits.usage).toBe(1);
  });

  it('keeps POST /usage off the upload quota', async () => {
    await request(app)
      .post('/api/files/usage')
      .send({ file_ids: ['f1'] });

    expect(hits.uploadIp).toBe(0);
    expect(hits.uploadUser).toBe(0);
  });

  /* Non-strict routing sends `/usage/` to the same handler, so an exact path
   * comparison would bill a trailing-slash client's heartbeats to the upload
   * quota and hand them file-upload violations. */
  it('routes a trailing-slash /usage/ through the usage limiter too', async () => {
    const response = await request(app)
      .post('/api/files/usage/')
      .send({ file_ids: ['f1'] });

    expect(response.status).toBe(200);
    expect(hits.usage).toBe(1);
    expect(hits.uploadIp).toBe(0);
    expect(hits.uploadUser).toBe(0);
  });

  it('still applies the upload limiters to real uploads', async () => {
    await request(app).post('/api/files').send({});

    expect(hits.uploadIp).toBe(1);
    expect(hits.uploadUser).toBe(1);
    expect(hits.usage).toBe(0);
  });

  it('leaves /speech exempt from both limiters', async () => {
    await request(app).post('/api/files/speech/stt').send({});

    expect(hits.uploadIp).toBe(0);
    expect(hits.uploadUser).toBe(0);
    expect(hits.usage).toBe(0);
  });

  test.each([
    '',
    '/images',
    '/images/avatar',
    '/images/agents/agent/avatar',
    '/images/assistants/assistant/avatar',
    '/speech/stt',
    '/speech/tts',
    '/speech/tts/manual',
  ])('rejects Cortex legacy POST %s before multipart parsing or provider work', async (path) => {
    process.env.AUTH_MODE = 'transition';
    const response = await request(app).post(`/api/files${path}`).send({});
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ code: 'managed_upload_required' });
    expect(hits.multer).toBe(0);
    expect(hits.uploadIp).toBe(0);
  });

  it('keeps metadata usage available in email-only mode without allowing another write route', async () => {
    process.env.AUTH_MODE = 'email_code';
    const response = await request(app)
      .post('/api/files/usage/')
      .send({ file_ids: ['file'] });
    expect(response.status).toBe(200);
    expect(hits.usage).toBe(1);
    expect(hits.multer).toBe(0);
    const other = await request(app).post('/api/files/future-upload').send({});
    expect(other.status).toBe(403);
  });
});
