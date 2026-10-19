const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  getAuthMode: () => 'transition',
}));
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  runAsSystem: (work) => work(),
}));
jest.mock('~/server/utils/files', () => ({ getContentDisposition: () => 'unused' }));

const { createManagedS3Storage, managedOriginalKey } = jest.requireActual('@librechat/api');
const { uploadDerivedExpiresAt } = require('librechat-data-provider');
const { createWorkspaceOriginalReader } = require('./original');
const { createManagedSourceResolver } = jest.requireActual('@librechat/api');

const epoch = Date.parse('2026-10-17T10:00:00Z');
const policy = 'c'.repeat(64);
const snapshot = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));
const user = {
  userId: '000000000000000000000001',
  tenantId: 'tenant-a',
  authentication: 'verified-email',
};

function fixture(options = {}) {
  const bytes = options.bytes ?? Buffer.from('Synthetischer privater Workspace-Entwurf.\n');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const origin = {
    version: 1,
    binding: { purpose: 'workspace-draft', sourceId: 'workspace-a', sourceRevision: 0 },
    directSourceFileIds: [],
    ancestors: [],
  };
  const file = {
    file_id: 'derived-file',
    uploadOperationId: 'derived-file',
    user: user.userId,
    tenantId: user.tenantId,
    type: 'text/plain',
    bytes: bytes.length,
    source: 's3',
    storageKey: managedOriginalKey({ ...user, operationId: 'derived-file', generation: 1 }),
    filepath: '/api/files/managed/derived-file',
    status: 'ready',
    retentionAcceptedAt: new Date(epoch),
    expiredAt: new Date(uploadDerivedExpiresAt(epoch, origin)),
    securityApproval: {
      version: 1,
      decision: 'approved',
      policySha256: policy,
      checkedAt: new Date(epoch).toISOString(),
      scannerVersion: 'synthetic-scanner/v1',
      coverage: { complete: true, pages: 1, parts: 1 },
      subject: {
        userId: user.userId,
        tenantId: user.tenantId,
        operationId: 'derived-file',
        transferGeneration: 1,
        mediaType: 'text/plain',
        bytes: bytes.length,
        sha256,
      },
    },
    derivedOrigin: origin,
  };
  const operation = {
    version: 1,
    id: file.file_id,
    revision: 7,
    fileId: file.file_id,
    scope: { kind: 'personal' },
    state: 'ready',
    mediaType: file.type,
    actualBytes: file.bytes,
    acceptedAt: file.retentionAcceptedAt.toISOString(),
    expiresAt: file.expiredAt.toISOString(),
    canUseInComposer: false,
    cleanupPending: false,
  };
  const receipt = {
    outcome: 'durable',
    source: 's3',
    bytes: bytes.length,
    storageKey: file.storageKey,
    filepath: file.filepath,
    versionId: 'original-version-1',
    integrity: {
      version: 1,
      algorithm: 'sha256',
      sha256,
      chunkBytes: 262144,
      chunkSha256: [sha256],
    },
  };
  const task = {
    operationId: file.file_id,
    generation: 2,
    attemptGeneration: 1,
    principal: { ...user },
    fileId: file.file_id,
    state: 'ready',
    original: receipt,
  };
  const req = Object.assign(new EventEmitter(), {
    method: 'GET',
    headers: { origin: 'https://cortex.invalid', authorization: 'Bearer synthetic-token' },
    body: { fileId: 'foreign', storageKey: 'foreign', sourceRevision: 999 },
    query: { url: 'https://forbidden.invalid' },
  });
  const state = { wall: epoch + 1, monotonic: 0, principal: { ...user }, revoked: false };
  const getVersionFile = jest.fn(async () => {
    if (state.revoked)
      throw Object.assign(new Error('private source details'), { code: 'not_found' });
    return snapshot(file);
  });
  const client = { send: jest.fn(async () => ({ Body: Readable.from([bytes]) })) };
  const storage = createManagedS3Storage({ client, bucket: 'synthetic-private-bucket' });
  const runtime = {
    allowedOrigins: ['https://cortex.invalid'],
    principal: jest.fn(async () => state.principal),
    management: { get: jest.fn(async () => snapshot(operation)) },
    repository: { cleanupForFile: jest.fn(async () => snapshot(task)) },
    storage,
  };
  // Use the production source authorizer for this authorization-only consumer.
  runtime.sources = createManagedSourceResolver({
    allowedOrigins: runtime.allowedOrigins,
    principal: (req) => runtime.principal(req),
  });
  state.runtime = runtime;
  const reader = createWorkspaceOriginalReader({
    getRuntime: () => state.runtime,
    getDocumentWorkspaceVersionFile: getVersionFile,
    now: () => state.wall,
    monotonic: () => state.monotonic,
    securityPolicySha256: policy,
    ...options.reader,
  });
  return {
    bytes,
    file,
    operation,
    receipt,
    task,
    req,
    state,
    client,
    runtime,
    getVersionFile,
    read: () => reader.read(req, 'workspace-a', 1),
    reader,
  };
}

describe('private Workspace original reader', () => {
  test('finishes the native File fence after the composing route guard has awaited', async () => {
    let f;
    let calls = 0;
    f = fixture({
      reader: {
        authorize: async () => {
          calls++;
          if (calls === 3) f.state.revoked = true;
          return { ...user };
        },
      },
    });
    await expect(f.read()).rejects.toMatchObject({ code: 'not_found' });
    expect(calls).toBe(3);
    expect(f.getVersionFile).toHaveBeenCalledTimes(2);
    expect(f.client.send).toHaveBeenCalledTimes(1);
  });

  test('returns the complete verified original using the stored revision, not caller file locators', async () => {
    const f = fixture();
    f.client.send.mockImplementation(async () => ({
      Body: Readable.from([f.bytes.subarray(0, 9), f.bytes.subarray(9)]),
    }));
    const result = await f.read();
    expect(result).toEqual({ bytes: f.bytes, mediaType: 'text/plain' });
    expect(Object.keys(result)).toEqual(['bytes', 'mediaType']);
    expect(f.getVersionFile).toHaveBeenCalledTimes(2);
    expect(f.getVersionFile).toHaveBeenNthCalledWith(
      1,
      { userId: user.userId, tenantId: user.tenantId },
      'workspace-a',
      1,
    );
    expect(f.runtime.management.get).toHaveBeenCalledWith(user, 'derived-file');
    expect(f.client.send.mock.calls[0][0].input).toEqual({
      Bucket: 'synthetic-private-bucket',
      Key: f.receipt.storageKey,
      VersionId: f.receipt.versionId,
    });
    expect(f.req.listenerCount('aborted')).toBe(0);
  });

  test.each([
    ['foreign owner', (f) => (f.file.user = '000000000000000000000002')],
    ['foreign tenant', (f) => (f.file.tenantId = 'tenant-b')],
    ['wrong workspace', (f) => (f.file.derivedOrigin.binding.sourceId = 'workspace-b')],
    ['wrong revision', (f) => (f.file.derivedOrigin.binding.sourceRevision = 1)],
    ['wrong purpose', (f) => (f.file.derivedOrigin.binding.purpose = 'agent-output')],
    ['missing origin', (f) => delete f.file.derivedOrigin],
    ['wrong policy', (f) => (f.file.securityApproval.policySha256 = 'd'.repeat(64))],
    ['wrong security subject', (f) => (f.file.securityApproval.subject.transferGeneration = 2)],
    ['missing integrity', (f) => delete f.receipt.integrity],
    ['wrong storage receipt owner', (f) => (f.task.principal.userId = 'another-user')],
    ['wrong storage receipt authentication', (f) => (f.task.principal.authentication = 'guest')],
    ['unknown storage outcome', (f) => (f.receipt.outcome = 'unknown')],
    ['foreign storage key', (f) => (f.receipt.storageKey += '-wrong')],
    [
      'both locators in a foreign namespace',
      (f) => {
        f.file.storageKey = f.receipt.storageKey = managedOriginalKey({
          ...user,
          userId: 'another-user',
          operationId: 'derived-file',
          generation: 1,
        });
      },
    ],
    ['wrong receipt path', (f) => (f.receipt.filepath = '/private/foreign')],
    ['changed upload bytes', (f) => f.operation.actualBytes++],
    ['changed upload media type', (f) => (f.operation.mediaType = 'application/pdf')],
    ['ordinary Composer file', (f) => (f.operation.canUseInComposer = true)],
    ['pending cleanup', (f) => (f.operation.cleanupPending = true)],
    ['revoked upload', (f) => (f.operation.state = 'expired')],
    ['non-ready File', (f) => (f.file.status = 'processing')],
    ['retention tampering', (f) => (f.file.expiredAt = new Date(epoch + 50_000))],
    ['expired File', (f) => (f.state.wall = f.file.expiredAt.getTime())],
    ['oversized original', (f) => (f.file.bytes = 65_537)],
    ['invalid Origin', (f) => (f.req.headers.origin = 'https://foreign.invalid')],
    ['invalid principal', (f) => (f.state.principal = null)],
  ])('blocks %s before storage access', async (_label, mutate) => {
    const f = fixture();
    mutate(f);
    await expect(f.read()).rejects.toThrow();
    expect(f.client.send).not.toHaveBeenCalled();
    expect(f.req.listenerCount('aborted')).toBe(0);
  });

  test('supports same-origin GET and the exact maximum document size', async () => {
    const f = fixture({ bytes: Buffer.alloc(65_536, 'x') });
    delete f.req.headers.origin;
    f.req.headers['sec-fetch-site'] = 'same-origin';
    await expect(f.read()).resolves.toEqual({ bytes: f.bytes, mediaType: 'text/plain' });
  });

  test.each([
    ['wrong digest', (bytes) => Buffer.alloc(bytes.length, 'x')],
    ['truncated original', (bytes) => bytes.subarray(0, bytes.length - 1)],
    ['trailing bytes', (bytes) => Buffer.concat([bytes, Buffer.from('extra')])],
  ])('uses the real storage integrity owner to reject %s', async (_label, corrupt) => {
    const f = fixture();
    const body = Readable.from([corrupt(f.bytes)]);
    f.client.send.mockResolvedValue({ Body: body });
    await expect(f.read()).rejects.toMatchObject({ code: 'unavailable', message: 'unavailable' });
    expect(body.destroyed).toBe(true);
    expect(f.getVersionFile).toHaveBeenCalledTimes(1);
    expect(f.req.listenerCount('aborted')).toBe(0);
  });

  test.each([
    ['source revoked', (f) => (f.state.revoked = true)],
    ['account revoked', (f) => (f.state.principal = null)],
    ['principal switched', (f) => (f.state.principal = { ...user, userId: 'another-user' })],
    ['tenant switched', (f) => (f.state.principal = { ...user, tenantId: 'tenant-b' })],
    ['expiry reached', (f) => (f.state.wall = f.file.expiredAt.getTime())],
    ['runtime retired', (f) => (f.state.runtime = { ...f.runtime })],
    ['receipt version changed', (f) => (f.receipt.versionId = 'original-version-2')],
    ['upload revision changed', (f) => f.operation.revision++],
    ['File changed', (f) => (f.file.type = 'text/csv')],
    ['deadline elapsed', (f) => (f.state.monotonic = 30_000)],
    ['client aborted', (f) => f.req.emit('aborted')],
  ])('withholds the entire original when %s during the read', async (_label, mutate) => {
    const f = fixture();
    let body;
    f.client.send.mockImplementation(async () => {
      body = Readable.from(
        (async function* () {
          yield f.bytes.subarray(0, 7);
          mutate(f);
          yield f.bytes.subarray(7);
        })(),
      );
      return { Body: body };
    });
    await expect(f.read()).rejects.toThrow();
    expect(body.destroyed).toBe(true);
    expect(f.req.listenerCount('aborted')).toBe(0);
  });

  test('aborts a stalled actual S3 body at the deadline and settles stream ownership', async () => {
    const f = fixture({ reader: { deadlineMs: 20 } });
    const body = new Readable({ read() {} });
    f.client.send.mockResolvedValue({ Body: body });
    await expect(f.read()).rejects.toMatchObject({ code: 'unavailable' });
    expect(body.destroyed).toBe(true);
    expect(body.closed).toBe(true);
    expect(f.req.listenerCount('aborted')).toBe(0);
    expect(f.client.send.mock.calls[0][1].abortSignal.aborted).toBe(true);
  });

  test('never exposes private storage errors', async () => {
    const f = fixture();
    f.client.send.mockRejectedValue(new Error('s3://private-bucket/owner-secret/body.txt'));
    await expect(f.read()).rejects.toMatchObject({ code: 'unavailable', message: 'unavailable' });
  });

  test.each([
    ['source revoked', (f) => (f.state.revoked = true)],
    ['principal revoked', (f) => (f.state.principal = null)],
    ['principal switched', (f) => (f.state.principal = { ...user, tenantId: 'tenant-b' })],
  ])('withholds bytes when %s during the final receipt lookup', async (_label, mutate) => {
    const f = fixture();
    f.runtime.repository.cleanupForFile
      .mockImplementationOnce(async () => snapshot(f.task))
      .mockImplementationOnce(async () => {
        mutate(f);
        return snapshot(f.task);
      });
    await expect(f.read()).rejects.toThrow();
    expect(f.client.send).toHaveBeenCalledTimes(1);
    expect(f.req.listenerCount('aborted')).toBe(0);
  });

  test('settles the deadline and request listener when runtime lookup fails', async () => {
    const f = fixture({
      reader: {
        getRuntime: () => {
          throw new Error('private runtime details');
        },
      },
    });
    await expect(f.read()).rejects.toMatchObject({ code: 'unavailable', message: 'unavailable' });
    expect(f.req.listenerCount('aborted')).toBe(0);
  });

  test.each([
    ['../workspace-a', 1],
    ['workspace-a', 0],
    ['workspace-a', 1.5],
    ['workspace-a', '1'],
  ])('rejects invalid stored revision lookup %s/%s before authorization', async (id, revision) => {
    const f = fixture();
    await expect(f.reader.read(f.req, id, revision)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(f.runtime.principal).not.toHaveBeenCalled();
    expect(f.client.send).not.toHaveBeenCalled();
  });
});
