/** Actual NAS adapter/repository composition; only persistence and S3 transport are inert ports. */
import { mongo } from 'mongoose';
import { Readable } from 'node:stream';
import { mockClient } from 'aws-sdk-client-mock';
import { sdkStreamMixin } from '@smithy/util-stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type {
  UploadCleanupTask,
  UploadLease,
  UploadPrincipal,
  UploadSecurityApproval,
} from 'librechat-data-provider';
import type { UploadNasMethods } from '@librechat/data-schemas';
import type { UploadManagementContext } from '../../../../data-schemas/src/methods/uploadManagementContext';
import type { StoredUpload } from '../../../../data-schemas/src/methods/uploadManagementState';
import { createUploadCleanupTransitions } from '../../../../data-schemas/src/methods/uploadManagementCleanup';
import { validateNasUploadState } from '../../../../data-schemas/src/methods/uploadManagementNasState';
import { createUploadNasMethods } from '../../../../data-schemas/src/methods/uploadManagementNas';
import { createNasS3Storage, getNasS3StorageCapture, isNasStoragePort } from './storage';
import { resolveFileStorageAuthority } from '../../files/storageAuthority';
import { createOriginalIntegrity } from '../../uploads/storage/integrity';
import { createNasS3Client } from './client';

const payload = Buffer.from('hello');
const identity = createOriginalIntegrity(payload.length);
identity.update(payload);
const integrity = identity.finish();
const principal: UploadPrincipal = {
  authentication: 'verified-email',
  tenantId: 'tenant',
  userId: 'user',
};
const policy = 'c'.repeat(64);
const backend = {
  kind: 'nas-s3' as const,
  uid: 'nas-1',
  configurationSha256: 'b'.repeat(64),
  protocol: 'acknowledged-only-v1' as const,
};
const clients: ReturnType<typeof createNasS3Client>[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
});

function fixture(av = true) {
  const now = Date.now();
  const lease: UploadLease = {
    tenantId: 'tenant',
    userId: 'user',
    operationId: 'operation',
    generation: 2,
    kind: 'transfer',
    hostId: 'host',
    instanceId: 'instance',
    expiresAt: new Date(now + 45000).toISOString(),
  };
  // Synthetic AV process boundary only; current production readers validate every field.
  // This is not an assertion that a real engine ran or approved a document.
  const subject = {
    tenantId: 'tenant',
    userId: 'user',
    operationId: 'operation',
    transferGeneration: 2,
    mediaType: 'text/plain',
    bytes: payload.length,
    sha256: integrity.sha256,
  };
  const antivirus = {
    version: 1 as const,
    slot: 'fixture-av',
    podUid: 'fixture-pod',
    runtimeImage: 'fixture/av@sha256:' + 'd'.repeat(64),
    sourceRevision: 'e'.repeat(40),
    engineArtifactSha256: 'f'.repeat(64),
    profileSha256: 'a'.repeat(64),
    signatureManifestSha256: 'b'.repeat(64),
    signatureVerificationSha256: 'c'.repeat(64),
    dailyDatabaseVersion: 1,
    dailyPublishedAt: new Date(now - 10000).toISOString(),
    original: {
      id: '33333333-3333-4333-8333-333333333333',
      pid: 1234,
      startTicks: '5678',
      bootId: '44444444-4444-4444-8444-444444444444',
      configurationSha256: 'd'.repeat(64),
    },
    subject,
    expiresAt: new Date(now + 60000).toISOString(),
  };
  const execution = {
    version: 3 as const,
    antivirus,
    custody: { kind: 'none' as const },
    attemptId: 'operation.2',
    instanceId: '11111111-1111-4111-8111-111111111111',
    executionId: '22222222-2222-4222-8222-222222222222',
    expiresAt: new Date(now + 60000).toISOString(),
  };
  const approval: UploadSecurityApproval = {
    version: 2,
    antivirus: {
      custody: antivirus,
      engineVersion: 'fixture-1',
      readyObservedAt: new Date(now - 1000).toISOString(),
      cleanAt: new Date(now).toISOString(),
    },
    decision: 'approved',
    policySha256: policy,
    subject: {
      tenantId: 'tenant',
      userId: 'user',
      operationId: 'operation',
      transferGeneration: 2,
      mediaType: 'text/plain',
      bytes: payload.length,
      sha256: integrity.sha256,
    },
    scannerVersion: 'inert-fixture',
    checkedAt: new Date(now).toISOString(),
    coverage: { complete: true, pages: 1, parts: 1 },
  };
  let stored = {
    _id: 'operation',
    tenantId: 'tenant',
    userId: 'user',
    generation: 2,
    attemptGeneration: 2,
    workerGeneration: 2,
    slot: 'transfer',
    state: 'transferring',
    worker: { hostId: 'host', instanceId: 'instance' },
    leaseExpiresAt: now + 45000,
    declaredBytes: payload.length,
    mediaType: 'text/plain',
    securityExecution: execution,
    securitySettlement: {
      execution,
      writerStopped: true,
      transientDataRemoved: true,
      antivirusReceipt: {
        custody: antivirus,
        state: 'retired',
        originalProcessJoined: true,
        ownedTransientDataRemoved: true,
      },
    },
    writerStopped: true,
    stagingHeld: false,
    cleanupPending: true,
    originalBytes: payload.length,
    textBytes: 0,
    recordBytes: 32768,
    pendingBytes: payload.length,
    revision: 1,
    cleanupCustody: { version: 1 },
  } as StoredUpload;
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const query = (read: () => unknown) => {
    const q = {
      session: () => q,
      maxTimeMS: () => q,
      lean: async () => copy(read()),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(copy(read())).then(resolve),
    };
    return q;
  };
  let lock = Promise.resolve();
  const global = {
    reconciled: true,
    originalBytes: payload.length,
    objectBytes: payload.length,
    textBytes: 0,
    revision: 1,
  };
  const store = {
    Operation: {
      findById: () => query(() => stored),
      findOne: (where: Record<string, unknown>) =>
        query(() =>
          where._id === stored._id &&
          where.tenantId === stored.tenantId &&
          where.userId === stored.userId
            ? stored
            : null,
        ),
    },
    save: jest.fn(async (row: StoredUpload) => {
      validateNasUploadState(row);
      stored = copy(row);
    }),
    transaction: async <T>(
      run: (session: unknown, counters: unknown) => Promise<T>,
    ): Promise<T> => {
      const previous = lock;
      let release!: () => void;
      lock = new Promise<void>((r) => {
        release = r;
      });
      await previous;
      try {
        return await run({ fixture: true }, global);
      } finally {
        release();
      }
    },
    releaseQueue: jest.fn(),
  };
  // The facade replaces only Mongo persistence, as in the repository's own NAS contract suite.
  const context = {
    store,
    securityPolicySha256: policy,
    ...(av ? { nasAntivirusAdmission: () => true } : {}),
    mongoose: { mongo, models: { File: { exists: () => query(() => null) } } },
  } as unknown as UploadManagementContext;
  const transitions = createUploadCleanupTransitions(store as never);
  context.applyCleanup = transitions.applyCleanup;
  const actual = createUploadNasMethods(context);
  // Jest's native structuredClone returns foreign-realm DTOs. Normalize only the
  // authentic producer's returned own-data snapshot; never change its observer capabilities.
  // Native production runs these modules in one realm; all validation/transactions remain real.
  const repository: UploadNasMethods = {
    ...actual,
    dispatchNasOriginalWrite(lease, input, integrity, approval, at, dispatch) {
      return actual.dispatchNasOriginalWrite(
        lease,
        input,
        integrity,
        approval,
        at,
        (binding, observer) => dispatch(copy(binding), observer),
      );
    },
    dispatchNasCleanup(principal, id, dispatch, claim) {
      return actual.dispatchNasCleanup(
        principal,
        id,
        (binding, observer) => dispatch(copy(binding), observer),
        claim,
      );
    },
    observeNasCleanup(principal, id, observe) {
      return actual.observeNasCleanup(principal, id, (binding) => observe(copy(binding)));
    },
  };
  const client = createNasS3Client({
    backend,
    bucket: 'cortex-files',
    region: 'test',
    endpoint: 'https://nas.invalid:9443',
    credentials: { accessKeyId: 'synthetic-access', secretAccessKey: 'synthetic-secret' },
    trust: { mode: 'ca-hostname' },
    requestTimeoutMs: 1000,
  });
  clients.push(client);
  const transport = mockClient(client);
  const events: string[] = [];
  transport.on(PutObjectCommand).callsFake(async (input) => {
    events.push('PUT');
    expect(input.IfMatch).toBeUndefined();
    expect(input.IfNoneMatch).toBeUndefined();
    expect(input.Key).toBe(stored.writeBinding!.key);
    if (!(input.Body instanceof Readable)) throw new Error('Expected actual adapter stream');
    const chunks: Buffer[] = [];
    for await (const chunk of input.Body) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(payload);
    return { $metadata: { httpStatusCode: 200, requestId: 'original' }, ETag: 'opaque' };
  });
  transport.on(GetObjectCommand).callsFake(async () => {
    events.push('GET');
    expect(stored.originalWrite?.state).toBe('acknowledged');
    return {
      $metadata: { httpStatusCode: 200 },
      ContentLength: payload.length,
      Body: sdkStreamMixin(Readable.from([payload])),
    };
  });
  transport.on(DeleteObjectCommand).resolves({ $metadata: { httpStatusCode: 204 } });
  transport
    .on(HeadObjectCommand)
    .rejects(Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } }));
  // Availability itself is qualified by its owner; this fixture isolates original-storage custody.
  const adapter = createNasS3Storage({ client, repository, assertWriteSafe: () => undefined });
  const input = () => ({
    bindWrite: jest.fn(),
    lease,
    filename: 'private.txt',
    mediaType: 'text/plain',
    bytes: payload.length,
    integrity,
    securityApproval: approval,
    body: Readable.from([payload]),
    signal: new AbortController().signal,
  });
  return {
    adapter,
    repository,
    transport,
    events,
    input,
    row: () => stored,
    client,
    cancel: () => transitions.terminal(stored, global as never, 'cancelled', 'cancelled'),
  };
}

it('uses the actual repository original once, persists ACK before real full-byte verification, and returns a private receipt', async () => {
  const f = fixture();
  const input = f.input();
  const result = await f.adapter.put(input);
  expect(result.outcome).toBe('durable');
  expect(result.backend).toEqual(backend);
  const accepted: UploadCleanupTask = {
    operationId: input.lease.operationId,
    fileId: input.lease.operationId,
    generation: input.lease.generation + 1,
    attemptGeneration: input.lease.generation,
    state: 'ready',
    principal,
    original: result,
    writeBinding: f.row().writeBinding,
    writerStopped: true,
    localCopiesAbsent: true,
  };
  expect(
    resolveFileStorageAuthority(accepted, {
      operationId: input.lease.operationId,
      source: result.source,
      storageKey: result.storageKey!,
      bytes: result.bytes,
      mediaType: input.mediaType,
    }),
  ).toEqual({ principal, operationId: input.lease.operationId });
  expect(result.filepath).toBe(`/api/files/managed/${input.lease.operationId}`);
  expect(result.versionId).toBeUndefined();
  expect(f.row().originalWrite?.state).toBe('verified');
  expect(f.events).toEqual(['PUT', 'GET']);
  expect(f.transport.commandCalls(PutObjectCommand)).toHaveLength(1);
  expect(input.bindWrite).not.toHaveBeenCalled();
  expect(input.body.destroyed).toBe(true);
});

it('does not replay an already-dispatched original', async () => {
  const f = fixture();
  await f.adapter.put(f.input());
  const key = f.row().writeBinding!.key;
  await f.adapter.put(f.input());
  expect(f.transport.commandCalls(PutObjectCommand)).toHaveLength(1);
  expect(f.row().writeBinding!.key).toBe(key);
});

it('retains authentic ACK but refuses publication after corrupt GET content', async () => {
  const f = fixture();
  f.transport.on(GetObjectCommand).resolves({
    $metadata: { httpStatusCode: 200 },
    ContentLength: payload.length,
    Body: sdkStreamMixin(Readable.from([Buffer.from('wrong')])),
  });
  expect((await f.adapter.put(f.input())).outcome).toBe('unknown');
  expect(f.row().originalWrite?.state).toBe('acknowledged');
  expect(f.row().originalWrite?.response?.status).toBe(200);
});

it.each(['version-1', ''])(
  'retains unexpected version %p without verification or automatic cleanup',
  async (versionId) => {
    const f = fixture();
    f.transport.on(PutObjectCommand).callsFake(async (input) => {
      if (!(input.Body instanceof Readable)) throw new Error('stream');
      for await (const _ of input.Body) {
        /* Actual body completes. */
      }
      return { $metadata: { httpStatusCode: 200 }, VersionId: versionId };
    });
    expect((await f.adapter.put(f.input())).outcome).toBe('unknown');
    expect(f.row().originalWrite?.response?.versionId).toBe(versionId);
    expect(f.transport.commandCalls(GetObjectCommand)).toHaveLength(0);
    f.cancel();
    expect(
      (
        await f.adapter.cleanupOriginal({
          principal,
          operationId: 'operation',
          signal: new AbortController().signal,
          deadlineAtMs: Date.now() + 10000,
        })
      ).state,
    ).toBe('pending');
    expect(f.transport.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  },
);

it('keeps a lost PUT acknowledgement pending and never treats HEAD404 as original closure', async () => {
  const f = fixture();
  f.transport.on(PutObjectCommand).rejects(new Error('response lost'));
  expect((await f.adapter.put(f.input())).outcome).toBe('unknown');
  expect(f.row().originalWrite?.state).toBe('unknown');
  expect(f.transport.commandCalls(PutObjectCommand)).toHaveLength(1);
  f.cancel();
  expect(
    (
      await f.adapter.cleanupOriginal({
        principal,
        operationId: 'operation',
        signal: new AbortController().signal,
        deadlineAtMs: Date.now() + 10000,
      })
    ).state,
  ).toBe('pending');
  expect(f.transport.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  expect(f.transport.commandCalls(HeadObjectCommand)).toHaveLength(0);
});

it('records genuine no-send only when browser cancellation precedes SDK dispatch', async () => {
  const f = fixture();
  const input = f.input();
  const cancelled = new AbortController();
  cancelled.abort();
  input.signal = cancelled.signal;
  expect((await f.adapter.put(input)).outcome).toBe('unknown');
  expect(f.row().originalWrite?.state).toBe('not-dispatched');
  expect(f.transport.commandCalls(PutObjectCommand)).toHaveLength(0);
  expect(input.body.destroyed).toBe(true);
});

it('preserves the original ACK and deadline through cancellation after dispatch', async () => {
  const f = fixture();
  const controller = new AbortController();
  let finish!: () => void;
  let sent!: () => void;
  const entered = new Promise<void>((r) => {
    sent = r;
  });
  const release = new Promise<void>((r) => {
    finish = r;
  });
  f.transport.on(PutObjectCommand).callsFake(async (input) => {
    if (!(input.Body instanceof Readable)) throw new Error('stream');
    for await (const _ of input.Body) {
      /* join actual stream */
    }
    sent();
    await release;
    return { $metadata: { httpStatusCode: 200 }, ETag: 'opaque' };
  });
  const input = f.input();
  input.signal = controller.signal;
  const original = f.adapter.put(input);
  await entered;
  const deadline = f.row().writeBinding!.originalDeadline;
  controller.abort();
  f.cancel();
  finish();
  await original;
  expect(f.row().writeBinding!.originalDeadline).toBe(deadline);
  expect(f.row().originalWrite?.response?.status).toBe(200);
  expect(f.transport.commandCalls(PutObjectCommand)).toHaveLength(1);
});

it('requires AV repository authority before dispatch', async () => {
  const f = fixture(false);
  await expect(f.adapter.put(f.input())).rejects.toBeDefined();
  expect(f.transport.commandCalls(PutObjectCommand)).toHaveLength(0);
});

it('requires owned verified receipt and current backend for private reads', async () => {
  const f = fixture();
  const original = await f.adapter.put(f.input());
  f.transport.on(GetObjectCommand).resolves({
    $metadata: { httpStatusCode: 200 },
    ContentLength: payload.length,
    Body: sdkStreamMixin(Readable.from([payload])),
  });
  const parts: Uint8Array[] = [];
  for await (const part of f.adapter.read({
    principal,
    operationId: 'operation',
    original,
    signal: new AbortController().signal,
  }))
    parts.push(part);
  expect(Buffer.concat(parts)).toEqual(payload);
  for (const change of [{ storageKey: 'foreign' }, { backend: { ...backend, uid: 'foreign' } }]) {
    const read = f.adapter.read({
      principal,
      operationId: 'operation',
      original: { ...original, ...change },
      signal: new AbortController().signal,
    });
    await expect(read[Symbol.asyncIterator]().next()).rejects.toBeDefined();
  }
  const noAuthority = f.adapter.read({
    principal: { ...principal, userId: 'foreign' },
    operationId: 'operation',
    original,
    signal: new AbortController().signal,
  });
  await expect(noAuthority[Symbol.asyncIterator]().next()).rejects.toBeDefined();
});

it('deletes only after terminal writers, persists DELETE ACK before absence, then consumes via the real repository', async () => {
  const f = fixture();
  await f.adapter.put(f.input());
  f.cancel();
  f.transport.on(HeadObjectCommand).callsFake(async () => {
    expect(f.row().cleanupCustody?.nas?.state).toBe('deleted');
    throw Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } });
  });
  const result = await f.adapter.cleanupOriginal({
    principal,
    operationId: 'operation',
    signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 10000,
  });
  expect(result.state).toBe('complete');
  expect(f.row().cleanupCustody?.nas?.state).toBe('consumed');
  expect(f.transport.commandCalls(DeleteObjectCommand)).toHaveLength(1);
});

it('never repeats DELETE after a lost acknowledgement, even when a later HEAD could say404', async () => {
  const f = fixture();
  await f.adapter.put(f.input());
  f.cancel();
  f.transport.on(DeleteObjectCommand).rejects(new Error('lost'));
  const input = {
    principal,
    operationId: 'operation',
    signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 10000,
  };
  expect((await f.adapter.cleanupOriginal(input)).state).toBe('pending');
  expect((await f.adapter.cleanupOriginal(input)).state).toBe('pending');
  expect(f.transport.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  expect(f.transport.commandCalls(HeadObjectCommand)).toHaveLength(0);
});

it('reconciles known DELETE ACK using HEAD only, without a second DELETE', async () => {
  const f = fixture();
  await f.adapter.put(f.input());
  f.cancel();
  f.transport.on(HeadObjectCommand).resolves({ $metadata: { httpStatusCode: 200 } });
  const input = {
    principal,
    operationId: 'operation',
    signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 10000,
  };
  expect((await f.adapter.cleanupOriginal(input)).state).toBe('pending');
  expect(f.row().cleanupCustody?.nas?.state).toBe('deleted');
  f.transport
    .on(HeadObjectCommand)
    .rejects(Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } }));
  expect((await f.adapter.cleanupOriginal(input)).state).toBe('complete');
  expect(f.transport.commandCalls(DeleteObjectCommand)).toHaveLength(1);
});

it('keeps accepted File cleanup pending without a real JobClaim and never uses legacy deletion ports', async () => {
  const f = fixture();
  const original = await f.adapter.put(f.input());
  f.cancel();
  f.row().fileId = 'file';
  f.row().acceptedAt = Date.now();
  f.row().original = original;
  expect(
    (
      await f.adapter.cleanupOriginal({
        principal,
        operationId: 'operation',
        signal: new AbortController().signal,
        deadlineAtMs: Date.now() + 10000,
      })
    ).state,
  ).toBe('pending');
  expect(f.transport.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  expect(
    await f.adapter.remove({
      operationId: 'operation',
      generation: 2,
      tenantId: 'tenant',
      userId: 'user',
      signal: new AbortController().signal,
    }),
  ).toBe('unknown');
});

it('recognizes only the factory capture, not a copied kind property or disposed client', () => {
  const f = fixture();
  expect(isNasStoragePort(f.adapter)).toBe(true);
  expect(getNasS3StorageCapture(f.adapter)?.backend).toEqual(backend);
  expect(isNasStoragePort({ ...f.adapter })).toBe(false);
  f.client.destroy();
  expect(isNasStoragePort(f.adapter)).toBe(false);
});
