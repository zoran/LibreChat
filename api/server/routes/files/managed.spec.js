const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');

jest.mock('@librechat/api', () => ({ getAuthMode: () => 'transition' }));
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  runAsSystem: (work) => work(),
}));
jest.mock('~/server/utils/files', () => ({
  getContentDisposition: (name) => `attachment; filename="${name}"`,
}));

const { createManagedFileHandlers } = require('./managed');
// Exercise the public built storage owner used by the application. Primary must
// rebuild @librechat/api before GREEN; no replacement integrity implementation.
const { createManagedS3Storage } = jest.requireActual('@librechat/api');

const user = { tenantId: 'tenant-a', userId: 'user-a', authentication: 'verified-email' };
const epoch = Date.parse('2026-10-13T00:00:00Z');
const integrityChunkBytes = 256 * 1024;

function integrityFor(original) {
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const chunkSha256 = [];
  for (let offset = 0; offset < original.length; offset += integrityChunkBytes) {
    chunkSha256.push(digest(original.subarray(offset, offset + integrityChunkBytes)));
  }
  return {
    version: 1,
    algorithm: 'sha256',
    sha256: digest(original),
    chunkBytes: integrityChunkBytes,
    chunkSha256,
  };
}

function expectOriginalBytes(actual, expected) {
  // A semantic RED must not dump hundreds of thousands of byte values.
  expect(actual.length).toBe(expected.length);
  expect(actual.equals(expected)).toBe(true);
}

function response() {
  const res = Object.assign(new EventEmitter(), {
    headers: {},
    chunks: [],
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    statusCode: 200,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    removeHeader(name) {
      delete this.headers[name.toLowerCase()];
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      this.headersSent = true;
      this.writableEnded = true;
      return this;
    },
    write(chunk) {
      this.headersSent = true;
      this.chunks.push(Buffer.from(chunk));
      return true;
    },
    end() {
      this.writableEnded = true;
    },
    destroy() {
      this.destroyed = true;
      this.emit('close');
    },
  });
  return res;
}

function fixture(options = {}) {
  let wall = epoch;
  let clock = 0;
  const operation = {
    id: 'operation',
    fileId: 'operation',
    scope: { kind: 'personal' },
    state: 'ready',
    canUseInComposer: true,
    actualBytes: 5,
    expiresAt: new Date(epoch + 60_000).toISOString(),
  };
  const file = {
    file_id: 'operation',
    uploadOperationId: 'operation',
    tenantId: user.tenantId,
    user: user.userId,
    filename: 'document.txt',
    type: 'text/plain',
    bytes: 5,
    source: 's3',
    status: 'ready',
    embedded: true,
    llmDeliveryPath: 'text',
    retentionAcceptedAt: new Date(epoch - 1_000),
    expiredAt: new Date(epoch + 60_000),
    storageKey: 't/tenant-a/managed-uploads/user-a/operation.1__original',
    text: 'useful text',
  };
  const receipt = {
    outcome: 'durable',
    source: 's3',
    bytes: 5,
    storageKey: file.storageKey,
    filepath: '/api/files/managed/operation',
  };
  const task = {
    operationId: 'operation',
    fileId: 'operation',
    state: 'ready',
    principal: user,
    original: receipt,
  };
  const owner = {
    allowedOrigins: Object.freeze(['https://cortex.example']),
    principal: jest.fn(async () => user),
    management: {
      get: jest.fn(async () => ({ ...operation })),
      list: jest.fn(async () => [{ ...operation }]),
    },
    repository: { cleanupForFile: jest.fn(async () => task) },
    storage: {
      read: jest.fn(async function* () {
        yield Buffer.from('hello');
      }),
    },
  };
  const getFiles = jest.fn(async () => [file]);
  const getRuntime = jest.fn(() => owner);
  const req = Object.assign(new EventEmitter(), {
    method: 'GET',
    headers: { 'sec-fetch-site': 'same-origin' },
    params: { id: 'operation', file_id: 'operation', userId: 'untrusted-path-owner' },
    query: {},
    user: { id: user.userId, provider: 'email_code' },
  });
  const res = response();
  const handlers = createManagedFileHandlers({
    getRuntime,
    getFiles,
    now: () => wall,
    monotonic: () => clock,
    ...options,
  });
  return {
    owner,
    operation,
    file,
    receipt,
    task,
    getFiles,
    getRuntime,
    req,
    res,
    handlers,
    setWall: (value) => {
      wall = value;
    },
    setClock: (value) => {
      clock = value;
    },
    setBytes(value) {
      file.bytes = value;
      operation.actualBytes = value;
      receipt.bytes = value;
    },
  };
}

function storedOriginal(f, original, returned = original) {
  f.setBytes(original.length);
  Object.assign(f.receipt, {
    integrity: integrityFor(original),
    versionId: 'recorded-version',
    etag: 'unchanged-etag',
  });
  const body =
    returned instanceof Readable
      ? returned
      : Readable.from(
          [
            returned.subarray(0, 17),
            returned.subarray(17, integrityChunkBytes + 9),
            returned.subarray(integrityChunkBytes + 9),
          ],
          { highWaterMark: 1 },
        );
  const send = jest.fn(async (_command, _options) => ({
    Body: body,
    ContentLength: original.length,
    ETag: f.receipt.etag,
  }));
  f.owner.storage = createManagedS3Storage({ client: { send }, bucket: 'isolated' });
  return { body, send };
}

function structuredFixture() {
  const f = fixture();
  f.receipt.integrity = integrityFor(Buffer.from('hello'));
  f.task.attemptGeneration = 1;
  const source = { sha256: f.receipt.integrity.sha256, bytes: 5, mediaType: 'text/plain' };
  f.file.securityApproval = {
    version: 1,
    decision: 'approved',
    policySha256: 'a'.repeat(64),
    subject: {
      ...source,
      tenantId: user.tenantId,
      userId: user.userId,
      operationId: 'operation',
      transferGeneration: 1,
    },
    scannerVersion: 'test/1',
    checkedAt: new Date(epoch - 1000).toISOString(),
    coverage: { complete: true, pages: 1, parts: 1 },
  };
  f.file.documentStructure = {
    version: 1,
    source,
    extractor: { name: 'librechat-managed', version: '1' },
    pages: [],
    elements: [
      {
        id: 'e1',
        kind: 'paragraph',
        start: 0,
        end: f.file.text.length,
        page: null,
        parentId: null,
      },
    ],
    quality: { status: 'complete', warnings: [] },
  };
  return f;
}

describe('authorized managed source preview', () => {
  const previousPolicy = process.env.UPLOAD_SECURITY_POLICY_SHA256;
  beforeAll(() => {
    process.env.UPLOAD_SECURITY_POLICY_SHA256 = 'a'.repeat(64);
  });
  afterAll(() => {
    if (previousPolicy === undefined) delete process.env.UPLOAD_SECURITY_POLICY_SHA256;
    else process.env.UPLOAD_SECURITY_POLICY_SHA256 = previousPolicy;
  });
  it('returns validated original-bound structure only from the explicit private preview projection', async () => {
    const f = structuredFixture();
    await f.handlers.preview(f.req, f.res);
    expect(f.res.body).toEqual({
      file_id: 'operation',
      status: 'ready',
      text: f.file.text,
      textFormat: 'text',
      documentStructure: f.file.documentStructure,
    });
    expect(f.res.body.documentStructure).not.toBe(f.file.documentStructure);
    expect(f.getFiles.mock.calls[0][2].split(' ').slice(-4)).toEqual([
      'text',
      'textFormat',
      '+documentStructure',
      '+securityApproval',
    ]);
    expect(f.owner.repository.cleanupForFile).toHaveBeenCalledWith(user, 'operation');
    expect(f.owner.principal).toHaveBeenCalledTimes(2);
    expect(f.owner.management.get).toHaveBeenCalledTimes(2);
    expect(f.res.headers['cache-control']).toBe('private, no-store');
    expect(f.res.body).not.toHaveProperty('securityApproval');
    expect(f.owner.storage.read).not.toHaveBeenCalled();
  });
  test.each([
    [
      'malformed',
      (f) => {
        f.file.documentStructure = null;
      },
    ],
    [
      'present undefined',
      (f) => {
        f.file.documentStructure = undefined;
      },
    ],
    [
      'out-of-range element',
      (f) => {
        f.file.documentStructure.elements[0].end = 999;
      },
    ],
    [
      'source hash',
      (f) => {
        f.file.documentStructure.source.sha256 = '0'.repeat(64);
      },
    ],
    [
      'source bytes',
      (f) => {
        f.file.documentStructure.source.bytes = 6;
      },
    ],
    [
      'File MIME',
      (f) => {
        f.file.type = 'application/pdf';
      },
    ],
    [
      'missing original integrity',
      (f) => {
        delete f.receipt.integrity;
      },
    ],
    [
      'missing approval',
      (f) => {
        delete f.file.securityApproval;
      },
    ],
    [
      'foreign approval',
      (f) => {
        f.file.securityApproval.subject.userId = 'other';
      },
    ],
    [
      'stale transfer',
      (f) => {
        f.task.attemptGeneration = 2;
      },
    ],
    [
      'stale policy',
      (f) => {
        f.file.securityApproval.policySha256 = 'b'.repeat(64);
      },
    ],
    [
      'future approval',
      (f) => {
        f.file.securityApproval.checkedAt = new Date(epoch + 1).toISOString();
      },
    ],
    [
      'original binding',
      (f) => {
        f.receipt.storageKey = 'foreign-original';
      },
    ],
    [
      'foreign File',
      (f) => {
        f.file.user = 'other';
      },
    ],
    [
      'revoked File',
      (f) => {
        f.getFiles.mockResolvedValue([]);
      },
    ],
  ])('fails closed for %s without exposing private contents', async (_name, change) => {
    const f = structuredFixture();
    change(f);
    await f.handlers.preview(f.req, f.res);
    expect(f.res.statusCode).toBe(404);
    expect(f.res.body).toEqual({ code: 'not_found' });
    expect(f.res.headers['cache-control']).toBe('private, no-store');
    expect(f.owner.storage.read).not.toHaveBeenCalled();
  });
  test.each(['principal', 'operation'])(
    'revalidates final %s before disclosing sources',
    async (stage) => {
      const f = structuredFixture();
      if (stage === 'principal')
        f.owner.principal
          .mockResolvedValueOnce(user)
          .mockRejectedValueOnce(Object.assign(new Error('revoked'), { code: 'unauthorized' }));
      else
        f.owner.management.get
          .mockResolvedValueOnce({ ...f.operation })
          .mockResolvedValueOnce({ ...f.operation, canUseInComposer: false });
      await f.handlers.preview(f.req, f.res);
      expect(f.res.statusCode).toBe(stage === 'principal' ? 401 : 404);
      expect(Object.keys(f.res.body)).toEqual(['code']);
    },
  );
  it('keeps a detached valid representation while the final native revalidation awaits', async () => {
    const f = structuredFixture();
    const expected = JSON.parse(JSON.stringify(f.file.documentStructure));
    f.owner.principal.mockResolvedValueOnce(user).mockImplementationOnce(async () => {
      f.file.documentStructure.elements[0].end = 999;
      f.file.text = 'changed';
      return user;
    });
    await f.handlers.preview(f.req, f.res);
    expect(f.res.body.documentStructure).toEqual(expected);
    expect(f.res.body.text).toBe('useful text');
  });
  test.each(['list', 'download', 'downloadURL'])(
    'keeps private fields out of %s projections and metadata',
    async (method) => {
      const f = structuredFixture();
      await f.handlers[method](f.req, f.res);
      expect(f.getFiles.mock.calls[0][2]).not.toMatch(/documentStructure|securityApproval/);
      const publicValue =
        method === 'download'
          ? JSON.parse(decodeURIComponent(f.res.headers['x-file-metadata']))
          : f.res.body;
      expect(JSON.stringify(publicValue)).not.toMatch(
        /documentStructure|securityApproval|scannerVersion|sha256/,
      );
    },
  );
});

describe('managed personal File consumers', () => {
  it('requires explicit guest File ownership on download, including each revalidation', async () => {
    const f = fixture();
    const guest = { authentication: 'guest', tenantId: null, userId: user.userId };
    f.owner.principal.mockResolvedValue(guest);
    f.file.tenantId = null;
    f.task.principal = guest;
    await f.handlers.download(f.req, f.res);
    expect(Buffer.concat(f.res.chunks).toString()).toBe('hello');
    const missing = fixture();
    missing.owner.principal.mockResolvedValue(guest);
    delete missing.file.tenantId;
    await missing.handlers.download(missing.req, missing.res);
    expect(missing.res.statusCode).toBe(404);
    expect(missing.owner.storage.read).not.toHaveBeenCalled();
    const cross = fixture();
    cross.owner.principal.mockResolvedValue(guest);
    cross.file.tenantId = null;
    cross.file.user = 'other';
    await cross.handlers.download(cross.req, cross.res);
    expect(cross.res.statusCode).toBe(404);
  });

  it('streams the actual versioned original through explicit owner queries and safe metadata', async () => {
    const f = fixture();
    await f.handlers.download(f.req, f.res);
    expect(Buffer.concat(f.res.chunks).toString()).toBe('hello');
    expect(f.res.writableEnded).toBe(true);
    expect(f.getFiles).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-a',
        user: 'user-a',
        file_id: 'operation',
        uploadOperationId: 'operation',
      },
      null,
      expect.any(String),
      1,
    );
    expect(f.owner.repository.cleanupForFile).toHaveBeenCalledWith(user, 'operation');
    expect(f.owner.storage.read).toHaveBeenCalledWith({
      original: f.receipt,
      signal: expect.any(AbortSignal),
    });
    expect(f.owner.principal).toHaveBeenCalledTimes(2);
    expect(f.res.headers['content-length']).toBe(5);
    expect(f.res.headers['cache-control']).toBe('private, no-store');
    const metadata = JSON.parse(decodeURIComponent(f.res.headers['x-file-metadata']));
    expect(metadata.filepath).toBe('/api/files/managed/operation');
    for (const key of ['storageKey', 'tenantId', 'user', 'text', 'uploadOperationId'])
      expect(metadata).not.toHaveProperty(key);
  });

  test.each([
    ['foreign user', { ...user, userId: 'user-b' }],
    ['foreign tenant', { ...user, tenantId: 'tenant-b' }],
    ['guest', { ...user, authentication: 'guest' }],
  ])('denies %s without reading an original', async (_label, principal) => {
    const f = fixture();
    f.owner.principal.mockResolvedValue(principal);
    await f.handlers.download(f.req, f.res);
    expect([401, 404]).toContain(f.res.statusCode);
    expect(f.owner.storage.read).not.toHaveBeenCalled();
    expect(f.res.chunks).toEqual([]);
  });

  test.each([
    [
      'expired operation',
      (f) => {
        f.operation.expiresAt = new Date(epoch).toISOString();
      },
    ],
    [
      'workspace',
      (f) => {
        f.operation.scope = { kind: 'workspace', workspaceId: 'workspace' };
      },
    ],
    [
      'not ready',
      (f) => {
        f.operation.canUseInComposer = false;
      },
    ],
    [
      'revoked File',
      (f) => {
        f.file.deletionRequestedAt = new Date(epoch);
      },
    ],
    [
      'expired File',
      (f) => {
        f.file.expiredAt = new Date(epoch);
      },
    ],
    [
      'wrong operation binding',
      (f) => {
        f.file.uploadOperationId = 'different';
      },
    ],
    [
      'wrong original binding',
      (f) => {
        f.receipt.storageKey = 'private-foreign-key';
      },
    ],
    [
      'missing runtime',
      (f) => {
        f.getRuntime.mockReturnValue(undefined);
      },
    ],
  ])('denies %s before storage access', async (_label, change) => {
    const f = fixture();
    change(f);
    await f.handlers.download(f.req, f.res);
    expect(f.res.statusCode).toBe(404);
    expect(f.owner.storage.read).not.toHaveBeenCalled();
  });

  test.each([{ origin: 'https://foreign.example' }, {}, { 'sec-fetch-site': 'cross-site' }])(
    'rejects an untrusted GET browser context %j',
    async (headers) => {
      const f = fixture();
      f.req.headers = headers;
      await f.handlers.download(f.req, f.res);
      expect(f.res.statusCode).toBe(404);
      expect(f.owner.principal).not.toHaveBeenCalled();
    },
  );

  it('accepts an explicit configured Origin and rejects range before any lookup', async () => {
    const f = fixture();
    f.req.headers = { origin: 'https://cortex.example' };
    await f.handlers.download(f.req, f.res);
    expect(f.res.statusCode).toBe(200);
    const ranged = fixture();
    ranged.req.headers.range = 'bytes=0-1';
    await ranged.handlers.download(ranged.req, ranged.res);
    expect(ranged.res.statusCode).toBe(400);
    expect(ranged.owner.principal).not.toHaveBeenCalled();
  });

  it('rechecks a revoked grant after storage starts but before the first disclosed byte', async () => {
    const f = fixture();
    f.owner.principal
      .mockResolvedValueOnce(user)
      .mockRejectedValueOnce(Object.assign(new Error('revoked'), { code: 'unauthorized' }));
    await f.handlers.download(f.req, f.res);
    expect(f.res.statusCode).toBe(401);
    expect(f.res.chunks).toEqual([]);
  });

  it('caps writes at 64KiB without querying the database for every slice', async () => {
    const f = fixture();
    f.setBytes(3 * 64 * 1024);
    f.owner.storage.read.mockImplementation(async function* () {
      yield Buffer.alloc(f.file.bytes);
    });
    await f.handlers.download(f.req, f.res);
    expect(f.res.chunks.map((chunk) => chunk.length)).toEqual([64 * 1024, 64 * 1024, 64 * 1024]);
    expect(f.owner.management.get).toHaveBeenCalledTimes(2);
    expect(f.getFiles).toHaveBeenCalledTimes(1);
  });

  it('stops before further bytes at the next monotonic revocation check', async () => {
    const f = fixture();
    let joined = false;
    f.owner.storage.read.mockImplementation(async function* () {
      try {
        yield Buffer.from('he');
        f.setClock(1_001);
        f.operation.canUseInComposer = false;
        yield Buffer.from('llo');
      } finally {
        joined = true;
      }
    });
    await f.handlers.download(f.req, f.res);
    expect(Buffer.concat(f.res.chunks).toString()).toBe('he');
    expect(f.res.destroyed).toBe(true);
    expect(joined).toBe(true);
  });

  it('checks local expiry on every chunk without waiting for the revalidation interval', async () => {
    const f = fixture();
    f.owner.storage.read.mockImplementation(async function* () {
      yield Buffer.from('he');
      f.setWall(epoch + 60_000);
      yield Buffer.from('llo');
    });
    await f.handlers.download(f.req, f.res);
    expect(Buffer.concat(f.res.chunks).toString()).toBe('he');
    expect(f.res.destroyed).toBe(true);
  });

  it('does not pull another storage chunk until response backpressure clears', async () => {
    const f = fixture();
    let pulls = 0;
    let entered;
    const blocked = new Promise((resolve) => {
      entered = resolve;
    });
    f.owner.storage.read.mockImplementation(async function* () {
      pulls++;
      yield Buffer.from('he');
      pulls++;
      yield Buffer.from('llo');
    });
    const write = f.res.write.bind(f.res);
    f.res.write = jest.fn((chunk) => {
      write(chunk);
      if (pulls === 1) {
        entered();
        return false;
      }
      return true;
    });
    const pending = f.handlers.download(f.req, f.res);
    await blocked;
    expect(pulls).toBe(1);
    f.res.emit('drain');
    await pending;
    expect(pulls).toBe(2);
    expect(f.res.writableEnded).toBe(true);
  });

  it('aborts storage and joins its iterator on browser disconnect', async () => {
    const f = fixture();
    let joined = false;
    f.owner.storage.read.mockImplementation(async function* ({ signal }) {
      try {
        yield Buffer.from('he');
        if (!signal.aborted)
          await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        signal.throwIfAborted();
      } finally {
        joined = true;
      }
    });
    const write = f.res.write.bind(f.res);
    f.res.write = (chunk) => {
      write(chunk);
      f.res.destroy();
      return true;
    };
    await f.handlers.download(f.req, f.res);
    expect(joined).toBe(true);
    expect(f.owner.storage.read.mock.calls[0][0].signal.aborted).toBe(true);
    expect(f.res.chunks).toHaveLength(1);
  });

  it('ends a stalled read at the bounded deadline and aborts its storage signal', async () => {
    jest.useFakeTimers();
    try {
      const f = fixture({ deadlineMs: 25 });
      let entered;
      const reading = new Promise((resolve) => {
        entered = resolve;
      });
      f.owner.storage.read.mockImplementation(async function* ({ signal }) {
        entered();
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        signal.throwIfAborted();
        yield Buffer.alloc(0);
      });
      const pending = f.handlers.download(f.req, f.res);
      await reading;
      await jest.advanceTimersByTimeAsync(25);
      await pending;
      expect(f.res.statusCode).toBe(503);
      expect(f.res.chunks).toEqual([]);
      expect(f.owner.storage.read.mock.calls[0][0].signal.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses excess bytes before disclosure and marks a short response incomplete', async () => {
    const excess = fixture();
    excess.owner.storage.read.mockImplementation(async function* () {
      yield Buffer.from('longer');
    });
    await excess.handlers.download(excess.req, excess.res);
    expect(excess.res.chunks).toEqual([]);
    expect(excess.res.statusCode).toBe(404);
    const short = fixture();
    short.owner.storage.read.mockImplementation(async function* () {
      yield Buffer.from('four');
    });
    await short.handlers.download(short.req, short.res);
    expect(short.res.destroyed).toBe(true);
    expect(short.res.writableEnded).toBe(false);
  });

  it('returns finite501 for direct URLs and useful text from the authenticated preview', async () => {
    const f = fixture();
    await f.handlers.downloadURL(f.req, f.res);
    expect(f.res.statusCode).toBe(501);
    expect(f.res.body).toEqual({ code: 'authenticated_download_required' });
    expect(f.owner.storage.read).not.toHaveBeenCalled();
    const p = fixture();
    await p.handlers.preview(p.req, p.res);
    expect(p.res.body).toEqual({
      file_id: 'operation',
      status: 'ready',
      text: 'useful text',
      textFormat: 'text',
    });
  });

  it('lists only current personal files without private metadata or URL refresh', async () => {
    const f = fixture();
    f.req.query.limit = '9000';
    f.getFiles.mockResolvedValue([
      f.file,
      { ...f.file, user: 'other' },
      { ...f.file, deletionRequestedAt: new Date(epoch) },
    ]);
    await f.handlers.list(f.req, f.res);
    expect(f.res.body).toHaveLength(1);
    expect(f.res.body[0]).not.toHaveProperty('storageKey');
    expect(f.getFiles).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: user.tenantId, user: user.userId }),
      null,
      expect.any(String),
      100,
    );
  });

  it('keeps guest file bootstrap empty without issuing an authentication failure', async () => {
    const f = fixture();
    f.req.user.provider = 'browser';
    await f.handlers.list(f.req, f.res);
    expect(f.res.body).toEqual([]);
    expect(f.res.statusCode).toBe(200);
    expect(f.owner.principal).not.toHaveBeenCalled();
    expect(f.getFiles).not.toHaveBeenCalled();
  });
});

describe('managed download with the actual original-integrity storage owner', () => {
  it('completes an intact version and exposes no private integrity manifest', async () => {
    const f = fixture();
    const original = Buffer.concat([
      Buffer.alloc(integrityChunkBytes, 65),
      Buffer.from('intact final text'),
    ]);
    const { body, send } = storedOriginal(f, original);
    await f.handlers.download(f.req, f.res);
    expectOriginalBytes(Buffer.concat(f.res.chunks), original);
    expect(f.res.statusCode).toBe(200);
    expect(f.res.writableEnded).toBe(true);
    expect(f.res.destroyed).toBe(false);
    expect(f.res.chunks.every((chunk) => chunk.length <= 64 * 1024)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].input).toMatchObject({
      Key: f.receipt.storageKey,
      VersionId: 'recorded-version',
    });
    expect(JSON.parse(decodeURIComponent(f.res.headers['x-file-metadata']))).not.toHaveProperty(
      'integrity',
    );
    expect(body.destroyed).toBe(true);
  });

  test.each([
    ['first block', 7, 0],
    ['later block', integrityChunkBytes + 7, integrityChunkBytes],
    ['final block', 2 * integrityChunkBytes + 7, 2 * integrityChunkBytes],
  ])(
    'never completes an equal-length mutated %s and discloses only the verified prefix',
    async (_label, offset, verifiedBytes) => {
      const f = fixture();
      const original = Buffer.alloc(2 * integrityChunkBytes + 23, 65);
      const returned = Buffer.from(original);
      returned[offset] ^= 1;
      const { body, send } = storedOriginal(f, original, returned);
      await f.handlers.download(f.req, f.res);
      expect(send).toHaveBeenCalledTimes(1);
      expectOriginalBytes(Buffer.concat(f.res.chunks), original.subarray(0, verifiedBytes));
      if (verifiedBytes === 0) {
        expect(f.res.statusCode).toBe(503);
        expect(f.res.body).toEqual({ code: 'unavailable' });
        expect(f.res.headers).not.toHaveProperty('content-length');
        expect(f.res.headers).not.toHaveProperty('x-file-metadata');
      } else {
        expect(f.res.destroyed).toBe(true);
        expect(f.res.writableEnded).toBe(false);
        expect(Buffer.concat(f.res.chunks).length).toBeLessThan(f.res.headers['content-length']);
      }
      expect(body.destroyed).toBe(true);
      expect(send.mock.calls[0][1].abortSignal.aborted).toBe(true);
    },
  );

  it('withholds the final block when its block hash matches but the whole digest differs', async () => {
    const f = fixture();
    const original = Buffer.alloc(integrityChunkBytes + 23, 65);
    const { body } = storedOriginal(f, original);
    f.receipt.integrity.sha256 = '0'.repeat(64);
    await f.handlers.download(f.req, f.res);
    expectOriginalBytes(Buffer.concat(f.res.chunks), original.subarray(0, integrityChunkBytes));
    expect(f.res.destroyed).toBe(true);
    expect(f.res.writableEnded).toBe(false);
    expect(body.destroyed).toBe(true);
  });

  it('withholds the final bytes until actual EOF even after every expected byte has arrived', async () => {
    const f = fixture();
    const original = Buffer.alloc(integrityChunkBytes + 23, 65);
    const body = new Readable({ read() {}, highWaterMark: 1 });
    storedOriginal(f, original, body);
    const pending = f.handlers.download(f.req, f.res);
    body.push(original);
    let beforeEOF;
    try {
      // All fixture lookups/SDK acknowledgement are already resolved promises;
      // let their microtasks and stream reads settle while EOF remains withheld.
      await new Promise((resolve) => setImmediate(resolve));
      beforeEOF = { bytes: Buffer.concat(f.res.chunks), ended: f.res.writableEnded };
    } finally {
      body.push(null);
      await pending;
    }
    expect(beforeEOF.ended).toBe(false);
    expectOriginalBytes(beforeEOF.bytes, original.subarray(0, integrityChunkBytes));
    expectOriginalBytes(Buffer.concat(f.res.chunks), original);
    expect(f.res.writableEnded).toBe(true);
    expect(body.destroyed).toBe(true);
  });

  it('preserves response backpressure and joins storage when the browser disconnects mid-block', async () => {
    const f = fixture();
    const original = Buffer.alloc(2 * integrityChunkBytes + 23, 65);
    const { body, send } = storedOriginal(f, original);
    const closed = new Promise((resolve) => body.once('close', resolve));
    let entered;
    const blocked = new Promise((resolve) => {
      entered = resolve;
    });
    const write = f.res.write.bind(f.res);
    f.res.write = jest.fn((chunk) => {
      write(chunk);
      entered();
      return false;
    });
    const pending = f.handlers.download(f.req, f.res);
    let storageClosed;
    try {
      await Promise.race([
        blocked,
        pending.then(() => {
          throw new Error('Download ended before response backpressure');
        }),
      ]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(f.res.chunks).toHaveLength(1);
      expectOriginalBytes(Buffer.concat(f.res.chunks), original.subarray(0, 64 * 1024));
      expect(f.res.writableEnded).toBe(false);
    } finally {
      f.res.destroy();
      await pending;
      storageClosed = body.destroyed;
      // Keep an assertion failure finite without disguising an owner leak.
      if (!body.destroyed) body.destroy();
      await closed;
    }
    expect(send.mock.calls[0][1].abortSignal.aborted).toBe(true);
    expect(storageClosed).toBe(true);
    expect(f.res.chunks).toHaveLength(1);
  });

  test.each(['revoked', 'expired'])(
    'revalidates %s access within a verified block before further disclosure',
    async (reason) => {
      const f = fixture();
      const original = Buffer.alloc(integrityChunkBytes + 23, 65);
      const { body, send } = storedOriginal(f, original);
      const write = f.res.write.bind(f.res);
      f.res.write = (chunk) => {
        const ready = write(chunk);
        if (reason === 'revoked') {
          f.setClock(1_001);
          f.operation.canUseInComposer = false;
        } else f.setWall(epoch + 60_000);
        return ready;
      };
      await f.handlers.download(f.req, f.res);
      expectOriginalBytes(Buffer.concat(f.res.chunks), original.subarray(0, 64 * 1024));
      expect(f.res.destroyed).toBe(true);
      expect(f.res.writableEnded).toBe(false);
      expect(f.owner.management.get).toHaveBeenCalledTimes(reason === 'revoked' ? 3 : 2);
      expect(send.mock.calls[0][1].abortSignal.aborted).toBe(true);
      expect(body.destroyed).toBe(true);
    },
  );
});
