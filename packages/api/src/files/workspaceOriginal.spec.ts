/** Typed stream behavior with real S3 integrity/stream ownership and explicit synthetic authority ports. */
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  buildManagedFileReadBinding,
  readHistoricalUploadSecurityApproval,
} from 'librechat-data-provider';
import type {
  UploadDerivedOrigin,
  UploadPrincipal,
  UploadStorageReceipt,
  UploadSecurityApproval,
  UploadOperation,
  UploadCleanupTask,
} from 'librechat-data-provider';
import type { WorkspaceFileSource } from '@librechat/data-schemas';
import type { S3Client } from '@aws-sdk/client-s3';
import type {
  WorkspaceOriginalDependencies,
  WorkspaceOriginalOptions,
  WorkspaceOriginalRequest,
  WorkspaceOriginalRuntime,
} from './workspaceOriginal';
import { createManagedS3Storage, managedOriginalKey } from '../storage/s3/managed';
import { createWorkspaceOriginalReader } from './workspaceOriginal';
import { createManagedSourceResolver } from './managedSource';

const epoch = Date.parse('2026-10-17T10:00:00Z');
const policy = 'c'.repeat(64);
/** Synthetic accepted-row metadata only; no engine execution or AV readiness is claimed. */
function syntheticNasApproval(base: UploadSecurityApproval): UploadSecurityApproval {
  const checkedAt = base.checkedAt;
  return {
    ...base,
    version: 2,
    antivirus: {
      engineVersion: 'synthetic-1.4.6',
      readyObservedAt: checkedAt,
      cleanAt: checkedAt,
      custody: {
        version: 1,
        slot: 'synthetic-slot',
        podUid: 'synthetic-pod',
        runtimeImage: 'synthetic@sha256:' + 'd'.repeat(64),
        sourceRevision: 'e'.repeat(40),
        engineArtifactSha256: '1'.repeat(64),
        profileSha256: '2'.repeat(64),
        signatureManifestSha256: '3'.repeat(64),
        signatureVerificationSha256: '4'.repeat(64),
        dailyDatabaseVersion: 1,
        dailyPublishedAt: checkedAt,
        subject: { ...base.subject },
        expiresAt: new Date(Date.parse(checkedAt) + 60000).toISOString(),
        original: {
          id: '11111111-1111-4111-8111-111111111111',
          pid: 123,
          startTicks: '1',
          bootId: '22222222-2222-4222-8222-222222222222',
          configurationSha256: '5'.repeat(64),
        },
      },
    },
  };
}

const snapshot = <T>(value: T): T => (value == null ? value : JSON.parse(JSON.stringify(value)));
const user = {
  userId: '000000000000000000000001',
  tenantId: 'tenant-a',
  authentication: 'verified-email',
} satisfies UploadPrincipal;

function fixture(
  options: {
    bytes?: Buffer;
    parentBound?: boolean;
    reader?: WorkspaceOriginalOptions &
      Partial<Pick<WorkspaceOriginalDependencies, 'authorize' | 'getRuntime'>>;
  } = {},
) {
  const bytes = options.bytes ?? Buffer.from('Synthetischer privater Workspace-Entwurf.\n');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const origin = {
    version: 2,
    binding: { purpose: 'workspace-draft', sourceId: 'workspace-a', sourceRevision: 0 },
    directSourceFileIds: [] as string[],
    ancestors: [] as UploadDerivedOrigin['ancestors'],
  };
  const file = {
    file_id: 'derived-file',
    filename: 'Draft.txt',
    sourceBindingSha256: '',
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
    expiredAt: new Date(options.parentBound ? epoch + 10000 : epoch + 28 * 86400000),
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
    declaredBytes: bytes.length,
    createdAt: new Date(epoch).toISOString(),
    canRetryProcessing: false,
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
  const receipt: UploadStorageReceipt = {
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
    writerStopped: true,
    localCopiesAbsent: true,
    attemptGeneration: 1,
    principal: { ...user },
    fileId: file.file_id,
    state: 'ready',
    original: receipt,
  };
  if (options.parentBound) {
    origin.directSourceFileIds = ['parent-file'];
    origin.ancestors = [
      {
        subject: { ...file.securityApproval.subject, operationId: 'parent-file' },
        policySha256: policy,
        sourceBindingSha256: 'e'.repeat(64),
        expiresAt: file.expiredAt.getTime(),
      },
    ];
  }
  file.sourceBindingSha256 = buildManagedFileReadBinding(
    {
      owner: user,
      fileId: file.file_id,
      operationId: file.file_id,
      filename: file.filename,
      mediaType: file.type,
      source: file.source,
      bytes: file.bytes,
      storageKey: file.storageKey,
      transferGeneration: task.attemptGeneration,
      original: receipt,
      approval: file.securityApproval as UploadSecurityApproval,
      representation: 'original',
    },
    (value) => createHash('sha256').update(value).digest('hex'),
  );
  const req = Object.assign(new EventEmitter(), {
    method: 'GET',
    headers: {
      origin: 'https://cortex.invalid',
      authorization: 'Bearer synthetic-token',
    } as Record<string, string>,
    body: { fileId: 'foreign', storageKey: 'foreign', sourceRevision: 999 },
    query: { url: 'https://forbidden.invalid' },
  });
  const state = {
    wall: epoch + 1,
    monotonic: 0,
    principal: { ...user } as UploadPrincipal | null,
    revoked: false,
    currentDeadline: file.expiredAt.getTime(),
    runtime: null as WorkspaceOriginalRuntime | null,
  };
  const getVersionFile = jest.fn(async () => {
    // Projection validity is the injected native producer's authority, not stream-side arithmetic.
    if (state.revoked || file.expiredAt.getTime() !== state.currentDeadline)
      throw Object.assign(new Error('private source details'), { code: 'not_found' });
    return snapshot(file) as unknown as WorkspaceFileSource;
  });
  const client = {
    send: jest.fn(async (_command: unknown, _options?: { abortSignal?: AbortSignal }) => ({
      Body: Readable.from([bytes]),
    })),
  };
  const storage = createManagedS3Storage({
    client: client as unknown as S3Client,
    bucket: 'synthetic-private-bucket',
  });
  const runtime = {
    allowedOrigins: ['https://cortex.invalid'],
    principal: jest.fn(
      async (_req?: WorkspaceOriginalRequest) => state.principal as UploadPrincipal,
    ),
    management: {
      get: jest.fn(
        async (_principal: UploadPrincipal, _id: string) => snapshot(operation) as UploadOperation,
      ),
    },
    repository: {
      cleanupForFile: jest.fn(
        async (_principal: UploadPrincipal, _id: string) => snapshot(task) as UploadCleanupTask,
      ),
    },
    storage,
  };
  // Use the production source authorizer for this authorization-only consumer.
  const sources = createManagedSourceResolver({
    allowedOrigins: runtime.allowedOrigins,
    principal: (req) => runtime.principal(req as WorkspaceOriginalRequest),
    operation: async () => {
      throw new Error('Not a source-resolution fixture');
    },
    file: async () => {
      throw new Error('Not a source-resolution fixture');
    },
    original: async () => {
      throw new Error('Not a source-resolution fixture');
    },
    policySha256: () => policy,
    storage,
  });
  state.runtime = runtime;
  const reader = createWorkspaceOriginalReader(
    {
      getRuntime: options.reader?.getRuntime ?? (() => state.runtime),
      authorize: options.reader?.authorize ?? sources.authorize,
      getDocumentWorkspaceVersionFile: getVersionFile,
      runAsSystem: (work) => work(),
      policySha256: () => policy,
    },
    {
      now: () => state.wall,
      monotonic: () => state.monotonic,
      ...options.reader,
    },
  );
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
    read: () => reader.read(req as WorkspaceOriginalRequest, 'workspace-a', 1),
    reader,
  };
}

describe('private Workspace original reader', () => {
  test('allows current parent deadline and Upload revision changes before the original stream bound', async () => {
    const f = fixture({ parentBound: true });
    const identity = f.file.sourceBindingSha256;
    f.client.send.mockImplementation(async () => ({
      Body: Readable.from(
        (async function* () {
          yield f.bytes.subarray(0, 7);
          f.file.expiredAt = new Date(f.file.expiredAt.getTime() + 7 * 86400000);
          f.state.currentDeadline = f.file.expiredAt.getTime();
          f.operation.expiresAt = f.file.expiredAt.toISOString();
          f.operation.revision++;
          f.state.wall = epoch + 5000;
          yield f.bytes.subarray(7);
        })(),
      ),
    }));
    await expect(f.read()).resolves.toEqual({ bytes: f.bytes, mediaType: 'text/plain' });
    expect(f.file.sourceBindingSha256).toBe(identity);
    expect(f.req.listenerCount('aborted')).toBe(0);
  });

  test('never enlarges the initial stream source bound after a legitimate parent extension', async () => {
    const f = fixture({ parentBound: true });
    const originalBound = f.file.expiredAt.getTime();
    const body = Readable.from(
      (async function* () {
        yield f.bytes.subarray(0, 7);
        f.file.expiredAt = new Date(originalBound + 7 * 86400000);
        f.state.currentDeadline = f.file.expiredAt.getTime();
        f.operation.expiresAt = f.file.expiredAt.toISOString();
        f.operation.revision++;
        f.state.wall = originalBound;
        yield f.bytes.subarray(7);
      })(),
    );
    f.client.send.mockResolvedValue({ Body: body });
    await expect(f.read()).rejects.toMatchObject({ code: 'unavailable' });
    expect(body.destroyed).toBe(true);
    expect(body.closed).toBe(true);
    expect(f.req.listenerCount('aborted')).toBe(0);
  });

  test('allows an Upload revision-only change without changing the actual source identity', async () => {
    const f = fixture();
    f.runtime.repository.cleanupForFile.mockImplementation(async () => {
      f.operation.revision++;
      return snapshot(f.task) as UploadCleanupTask;
    });
    await expect(f.read()).resolves.toEqual({ bytes: f.bytes, mediaType: 'text/plain' });
  });

  test.each(['source binding', 'filename', 'parent binding', 'retired origin'] as const)(
    'withholds the entire original after a changed %s',
    async (change) => {
      const f = fixture({ parentBound: true });
      const body = Readable.from(
        (async function* () {
          yield f.bytes.subarray(0, 7);
          if (change === 'source binding') f.file.sourceBindingSha256 = 'f'.repeat(64);
          if (change === 'filename') f.file.filename = 'Another.txt';
          if (change === 'parent binding')
            f.file.derivedOrigin.ancestors[0].sourceBindingSha256 = 'f'.repeat(64);
          if (change === 'retired origin') f.file.derivedOrigin.version = 1;
          yield f.bytes.subarray(7);
        })(),
      );
      f.client.send.mockResolvedValue({ Body: body });
      await expect(f.read()).rejects.toThrow();
      expect(body.destroyed).toBe(true);
      expect(f.req.listenerCount('aborted')).toBe(0);
    },
  );

  test('finishes the native File fence after the composing route guard has awaited', async () => {
    let calls = 0;
    const f = fixture({
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
    expect((f.client.send.mock.calls[0][0] as { input: unknown }).input).toEqual({
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
    ['missing origin', (f) => Reflect.deleteProperty(f.file, 'derivedOrigin')],
    ['wrong policy', (f) => (f.file.securityApproval.policySha256 = 'd'.repeat(64))],
    ['wrong security subject', (f) => (f.file.securityApproval.subject.transferGeneration = 2)],
    ['missing integrity', (f) => delete f.receipt.integrity],
    ['wrong storage receipt owner', (f) => (f.task.principal.userId = 'another-user')],
    [
      'wrong storage receipt authentication',
      (f) => Reflect.set(f.task.principal, 'authentication', 'guest'),
    ],
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
  ] satisfies Array<[string, (f: ReturnType<typeof fixture>) => unknown]>)(
    'blocks %s before storage access',
    async (_label, mutate) => {
      const f = fixture();
      mutate(f);
      await expect(f.read()).rejects.toThrow();
      expect(f.client.send).not.toHaveBeenCalled();
      expect(f.req.listenerCount('aborted')).toBe(0);
    },
  );

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
  ] satisfies Array<[string, (bytes: Buffer) => Buffer]>)(
    'uses the real storage integrity owner to reject %s',
    async (_label, corrupt) => {
      const f = fixture();
      const body = Readable.from([corrupt(f.bytes)]);
      f.client.send.mockResolvedValue({ Body: body });
      await expect(f.read()).rejects.toMatchObject({ code: 'unavailable', message: 'unavailable' });
      expect(body!.destroyed).toBe(true);
      expect(f.getVersionFile).toHaveBeenCalledTimes(1);
      expect(f.req.listenerCount('aborted')).toBe(0);
    },
  );

  test.each([
    ['source revoked', (f) => (f.state.revoked = true)],
    ['account revoked', (f) => (f.state.principal = null)],
    ['principal switched', (f) => (f.state.principal = { ...user, userId: 'another-user' })],
    ['tenant switched', (f) => (f.state.principal = { ...user, tenantId: 'tenant-b' })],
    ['expiry reached', (f) => (f.state.wall = f.file.expiredAt.getTime())],
    ['runtime retired', (f) => (f.state.runtime = { ...f.runtime })],
    ['receipt version changed', (f) => (f.receipt.versionId = 'original-version-2')],
    ['File changed', (f) => (f.file.type = 'text/csv')],
    ['deadline elapsed', (f) => (f.state.monotonic = 30_000)],
    ['client aborted', (f) => f.req.emit('aborted')],
  ] satisfies Array<[string, (f: ReturnType<typeof fixture>) => unknown]>)(
    'withholds the entire original when %s during the read',
    async (_label, mutate) => {
      const f = fixture();
      let body: Readable | undefined;
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
      expect(body!.destroyed).toBe(true);
      expect(f.req.listenerCount('aborted')).toBe(0);
    },
  );

  test('aborts a stalled actual S3 body at the deadline and settles stream ownership', async () => {
    const f = fixture({ reader: { deadlineMs: 20 } });
    const body = new Readable({ read() {} });
    f.client.send.mockResolvedValue({ Body: body });
    await expect(f.read()).rejects.toMatchObject({ code: 'unavailable' });
    expect(body!.destroyed).toBe(true);
    expect(body.closed).toBe(true);
    expect(f.req.listenerCount('aborted')).toBe(0);
    expect(f.client.send.mock.calls[0][1]!.abortSignal!.aborted).toBe(true);
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
  ] satisfies Array<[string, (f: ReturnType<typeof fixture>) => unknown]>)(
    'withholds bytes when %s during the final receipt lookup',
    async (_label, mutate) => {
      const f = fixture();
      f.runtime.repository.cleanupForFile
        .mockImplementationOnce(async () => snapshot(f.task) as UploadCleanupTask)
        .mockImplementationOnce(async () => {
          mutate(f);
          return snapshot(f.task) as UploadCleanupTask;
        });
      await expect(f.read()).rejects.toThrow();
      expect(f.client.send).toHaveBeenCalledTimes(1);
      expect(f.req.listenerCount('aborted')).toBe(0);
    },
  );

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
    await expect(
      f.reader.read(f.req as WorkspaceOriginalRequest, id as string, revision as number),
    ).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(f.runtime.principal).not.toHaveBeenCalled();
    expect(f.client.send).not.toHaveBeenCalled();
  });
});

test('reads a NAS Workspace original only through its bound private owner and never falls back', async () => {
  const f = fixture();
  const backend = {
    kind: 'nas-s3' as const,
    protocol: 'acknowledged-only-v1' as const,
    uid: 'private-backend',
    configurationSha256: 'a'.repeat(64),
  };
  const accepted = readHistoricalUploadSecurityApproval(f.file.securityApproval);
  if (!accepted) throw new Error('Fixture approval unavailable');
  f.file.securityApproval = syntheticNasApproval(accepted);
  f.file.source = 'nas-s3';
  f.file.storageKey = 'originals/opaque-server-key';
  f.receipt.source = 'nas-s3';
  f.receipt.storageKey = f.file.storageKey;
  f.receipt.backend = backend;
  delete f.receipt.versionId;
  const writeBinding = {
    version: 2 as const,
    backend,
    bucket: 'private-files',
    key: f.file.storageKey,
    operationId: f.file.file_id,
    generation: '1',
    bytes: f.file.bytes,
    wholeSHA256: f.receipt.integrity!.sha256,
    mediaType: f.file.type,
    originalDeadline: '2099-01-01T00:00:00.000Z',
  };
  f.runtime.repository.cleanupForFile.mockImplementation(async () => ({
    ...snapshot(f.task),
    state: 'ready',
    writeBinding,
  }));
  const currentApproval = readHistoricalUploadSecurityApproval(f.file.securityApproval);
  if (!currentApproval) throw new Error('Invalid fixture approval');
  f.file.sourceBindingSha256 = buildManagedFileReadBinding(
    {
      owner: user,
      fileId: f.file.file_id,
      operationId: f.file.file_id,
      filename: f.file.filename,
      mediaType: f.file.type,
      source: f.file.source,
      bytes: f.file.bytes,
      storageKey: f.file.storageKey,
      transferGeneration: 1,
      original: f.receipt,
      approval: currentApproval,
      representation: 'original',
    },
    (value) => createHash('sha256').update(value).digest('hex'),
  );
  const reads: Array<Parameters<typeof f.runtime.storage.read>[0]> = [];
  f.runtime.storage.read = async function* (input) {
    reads.push(input);
    yield f.bytes;
  };
  await expect(f.read()).resolves.toEqual({ bytes: f.bytes, mediaType: 'text/plain' });
  expect(reads[0]).toMatchObject({
    principal: user,
    operationId: f.file.file_id,
    original: { backend },
  });
  expect(f.client.send).not.toHaveBeenCalled();
  f.runtime.storage.read = async function* () {
    yield await Promise.reject(new Error('NAS unavailable'));
  };
  await expect(f.read()).rejects.toMatchObject({ code: 'unavailable' });
  expect(f.client.send).not.toHaveBeenCalled();
});
