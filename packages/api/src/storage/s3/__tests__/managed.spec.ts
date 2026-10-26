import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';
import type { HttpRequest } from '@smithy/types';
import { createManagedS3Client, getManagedS3ClientCapture } from '../managedClient';
import { createManagedS3Storage, managedOriginalKey } from '../managed';
import { getManagedS3Provider } from '../managed';

jest.mock('~/files', () => ({ deleteRagFile: jest.fn() }));
jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const lease = {
  tenantId: 'tenant',
  userId: 'user',
  operationId: 'operation',
  generation: 2,
  kind: 'transfer' as const,
  hostId: 'host',
  instanceId: 'instance',
  expiresAt: '2099-01-01T00:00:00Z',
};
const originalDeadline = new Date(Date.now() + 300000).toISOString();
const expectedKey = 't/tenant/managed-uploads/user/operation.2__original';
const signal = () => new AbortController().signal;
const BLOCK = 262144;
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const manifest = (value: Buffer) => ({
  version: 1 as const,
  algorithm: 'sha256' as const,
  sha256: sha(value),
  chunkBytes: BLOCK as 262144,
  chunkSha256: Array.from({ length: Math.ceil(value.length / BLOCK) }, (_, index) =>
    sha(value.subarray(index * BLOCK, (index + 1) * BLOCK)),
  ),
});

describe('managed S3 adapter preserves lifecycle and uncertainty', () => {
  function fixture(send: jest.Mock) {
    const observations = jest.fn();
    const serviceObservations = jest.fn();
    const storage = createManagedS3Storage({
      client: { send } as unknown as S3Client,
      bucket: 'isolated',
      urlForKey: async (key) => `https://private.invalid/isolated/${key}?signed=test`,
      observeBackend: observations,
      observeBackendService: serviceObservations,
    });
    return { storage, observations, serviceObservations };
  }
  const put = (body = 'hello') => ({
    bindWrite: jest.fn(async (input) => ({ version: 1 as const, ...input, originalDeadline })),
    lease,
    filename: '../../display.txt',
    mediaType: 'text/plain',
    bytes: 5,
    body: Readable.from([Buffer.from(body)]),
    integrity: manifest(Buffer.from('hello')),
    signal: signal(),
  });

  it('signs every managed write metadata field through the actual SDK without network', async () => {
    const headers: Record<string, string>[] = [];
    const client = new S3Client({
      region: 'us-east-1',
      endpoint: 'https://fixture.invalid',
      forcePathStyle: true,
      maxAttempts: 1,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      credentials: { accessKeyId: 'fixture-access', secretAccessKey: 'fixture-secret' },
      requestHandler: {
        handle: async (request: {
          headers: Record<string, string>;
          body: AsyncIterable<Uint8Array>;
        }) => {
          headers.push(request.headers);
          for await (const _ of request.body) {
            /* actual SDK stream, inert transport */
          }
          return {
            response: {
              statusCode: 200,
              headers: { etag: 'fixture-etag' },
              body: Readable.from([]),
            },
          };
        },
      },
    });
    const storage = createManagedS3Storage({
      client,
      bucket: 'isolated',
      urlForKey: async () => '/fixture',
    });
    await expect(storage.put(put())).resolves.toMatchObject({ outcome: 'durable' });
    expect(headers).toHaveLength(1);
    const signed = headers[0].authorization.match(/SignedHeaders=([^,]+)/)?.[1].split(';');
    for (const name of [
      'operation',
      'generation',
      'cortex-upload-bytes',
      'cortex-upload-sha256',
      'cortex-upload-deadline',
    ])
      expect(signed).toContain(`x-amz-meta-${name}`);
    expect(headers[0]['x-amz-meta-cortex-upload-deadline']).toBe(originalDeadline);
    expect(headers[0]['if-none-match']).toBe('*');
    expect(signed).toContain('content-type');
    expect(signed).toContain('if-none-match');
    client.destroy();
  });
  it('awaits the existing fenced binding owner before any SDK dispatch', async () => {
    const send = jest.fn(async (command) => {
      for await (const _ of command.input.Body) {
        /* consume */
      }
      return {};
    });
    const input = put();
    let complete!: (value: unknown) => void;
    input.bindWrite = jest.fn(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    ) as unknown as typeof input.bindWrite;
    const pending = fixture(send).storage.put(input);
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    expect(input.bindWrite).toHaveBeenCalledWith({
      bucket: 'isolated',
      key: expectedKey,
      operationId: 'operation',
      generation: '2',
      bytes: 5,
      wholeSHA256: sha(Buffer.from('hello')),
      mediaType: 'text/plain',
    });
    complete({ version: 1, ...input.bindWrite.mock.calls[0][0], originalDeadline });
    await expect(pending).resolves.toMatchObject({ outcome: 'durable' });
  });
  it.each(['missing-owner', 'expired', 'changed-key', 'changed-sha', 'noncanonical-deadline'])(
    'never dispatches an invalid persisted write binding: %s',
    async (kind) => {
      const send = jest.fn();
      const input = put();
      if (kind === 'missing-owner') input.bindWrite = undefined as never;
      else
        input.bindWrite = jest.fn(async (proposal) => ({
          version: 1,
          ...proposal,
          ...(kind === 'changed-key' ? { key: 'foreign' } : {}),
          ...(kind === 'changed-sha' ? { wholeSHA256: 'f'.repeat(64) } : {}),
          originalDeadline:
            (
              {
                expired: '2000-01-01T00:00:00.000Z',
                'noncanonical-deadline': '2099-01-01T00:05:00Z',
              } as Record<string, string>
            )[kind] ?? '2099-01-01T00:05:00.000Z',
        })) as typeof input.bindWrite;
      await expect(fixture(send).storage.put(input)).rejects.toThrow();
      expect(send).not.toHaveBeenCalled();
    },
  );
  it('uses existing tenant/user canonical key with a server-only basename', () => {
    expect(managedOriginalKey(lease)).toBe(expectedKey);
    expect(() => managedOriginalKey({ ...lease, userId: '../escape' })).toThrow();
  });
  it('preserves canonical email bytes and uses only the existing explicit guest key namespace', async () => {
    expect(managedOriginalKey(lease)).toBe(expectedKey);
    const guest = { ...lease, tenantId: null };
    const key = 'managed-uploads/user/operation.2__original';
    expect(managedOriginalKey(guest)).toBe(key);
    expect(() => managedOriginalKey({ ...guest, tenantId: undefined } as never)).toThrow();
    const send = jest.fn(async (command) => {
      expect(command.input.Key).toBe(key);
      if (command instanceof PutObjectCommand) {
        const body = command.input.Body;
        if (!(body instanceof Readable)) throw new Error('Expected managed original stream');
        for await (const _chunk of body) {
          /* real stream consumed */
        }
        return {};
      }
      if (command instanceof GetObjectCommand)
        return { Body: Readable.from([Buffer.from('hello')]) };
      throw new Error('Unexpected command');
    });
    const { storage } = fixture(send);
    const original = await storage.put({ ...put(), lease: guest });
    expect(original.outcome).toBe('durable');
    const received = [];
    for await (const chunk of storage.read({ original, signal: signal() })) received.push(chunk);
    expect(Buffer.concat(received).toString()).toBe('hello');
  });

  it('returns durable receipt only after exact bytes finish and passes abort to SDK', async () => {
    const send = jest.fn(async (command, options) => {
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect(options.abortSignal).toBeInstanceOf(AbortSignal);
      expect(command.input.Key).toBe(expectedKey);
      expect(command.input.ContentLength).toBe(5);
      expect(command.input.IfNoneMatch).toBe('*');
      expect(command.input.Metadata).toEqual({
        operation: 'operation',
        generation: '2',
        'cortex-upload-bytes': '5',
        'cortex-upload-sha256': sha(Buffer.from('hello')),
        'cortex-upload-deadline': originalDeadline,
      });
      for await (const _ of command.input.Body) {
        /* consume actual streaming input */
      }
      return { ETag: 'etag', VersionId: 'version' };
    });
    const { storage, observations } = fixture(send);
    await expect(storage.put(put())).resolves.toMatchObject({
      outcome: 'durable',
      storageKey: expectedKey,
      bytes: 5,
      versionId: 'version',
      integrity: manifest(Buffer.from('hello')),
    });
    expect(observations).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'put', outcome: 'durable' }),
    );
    expect(Object.keys(observations.mock.calls[0][0]).sort()).toEqual([
      'durationSeconds',
      'observedAtMs',
      'operation',
      'outcome',
    ]);
  });
  it('keeps timeout and abort-after-dispatch outcomes unknown even after body consumption', async () => {
    const send = jest.fn(async (command) => {
      for await (const _ of command.input.Body) {
        /* may already be committed remotely */
      }
      throw Object.assign(new Error('private endpoint credentials must not leak'), {
        name: 'AbortError',
      });
    });
    await expect(fixture(send).storage.put(put())).resolves.toMatchObject({
      outcome: 'unknown',
      storageKey: expectedKey,
    });
  });
  it.each(['four', 'longer'])('does not call a size-mismatched body durable: %s', async (body) => {
    const send = jest.fn(async (command) => {
      for await (const _ of command.input.Body) {
        /* Consume the entire source before acknowledging. */
      }
      return {};
    });
    await expect(fixture(send).storage.put(put(body))).resolves.toMatchObject({
      outcome: 'unknown',
    });
  });
  it('reads the immutable recorded key/version with exact byte verification', async () => {
    const send = jest.fn(async (command) => {
      expect(command).toBeInstanceOf(GetObjectCommand);
      expect(command.input).toMatchObject({ Key: expectedKey, VersionId: 'v1' });
      return { Body: Readable.from([Buffer.from('hello')]) };
    });
    const values: Buffer[] = [];
    for await (const chunk of fixture(send).storage.read({
      original: {
        source: 's3',
        storageKey: expectedKey,
        filepath: 'https://expired.invalid',
        outcome: 'durable',
        bytes: 5,
        versionId: 'v1',
        integrity: manifest(Buffer.from('hello')),
      },
      signal: signal(),
    }))
      values.push(Buffer.from(chunk));
    expect(Buffer.concat(values).toString()).toBe('hello');
  });
  it('does not treat a delete marker or unsupported version enumeration as absence', async () => {
    const send = jest.fn(async (command) => {
      if (command instanceof DeleteObjectCommand) return { DeleteMarker: true };
      throw new Error('unsupported');
    });
    await expect(fixture(send).storage.remove({ ...lease, signal: signal() })).resolves.toBe(
      'unknown',
    );
  });
  it('observes GetObject service response before any delayed body consumption', async () => {
    const body = new Readable({ read() {} });
    const { storage, observations, serviceObservations } = fixture(
      jest.fn(async () => ({ Body: body })),
    );
    const reader = storage
      .read({
        original: {
          source: 's3',
          storageKey: expectedKey,
          filepath: 'private',
          outcome: 'durable',
          bytes: 5,
          integrity: manifest(Buffer.from('hello')),
        },
        signal: signal(),
      })
      [Symbol.asyncIterator]();
    const first = reader.next();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(serviceObservations).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'success' }),
    );
    expect(observations).not.toHaveBeenCalled();
    body.push(Buffer.from('hello'));
    body.push(null);
    await first;
    await reader.next();
    expect(observations).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'read', outcome: 'durable' }),
    );
  });
  it('removes recorded versions and confirms physical absence before release', async () => {
    let lists = 0;
    const send = jest.fn(async (command) => {
      if (command instanceof ListObjectVersionsCommand)
        return lists++ === 0
          ? {
              Versions: [{ Key: expectedKey, VersionId: 'v1' }],
              DeleteMarkers: [{ Key: expectedKey, VersionId: 'marker' }],
            }
          : {};
      if (command instanceof HeadObjectCommand)
        throw Object.assign(new Error('missing'), { name: 'NotFound' });
      return {};
    });
    await expect(fixture(send).storage.remove({ ...lease, signal: signal() })).resolves.toBe(
      'absent',
    );
    const deletes = send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof DeleteObjectCommand);
    expect(deletes.map((command) => command.input.VersionId)).toEqual([undefined, 'v1', 'marker']);
  });

  it('never acknowledges equal-size staging alteration and closes both request streams', async () => {
    let sdkBody!: Readable;
    const send = jest.fn(async (command) => {
      sdkBody = command.input.Body;
      for await (const _ of sdkBody) {
        /* original must be verified before yielding */
      }
      return { ETag: 'not-an-integrity-proof' };
    });
    const input = put('jello');
    await expect(fixture(send).storage.put(input)).resolves.toMatchObject({
      outcome: 'unknown',
      storageKey: expectedKey,
    });
    expect(input.body.destroyed).toBe(true);
    expect(sdkBody.destroyed).toBe(true);
  });

  it('does not mark a premature SDK acknowledgement durable before verified source EOF', async () => {
    const input = put();
    const send = jest.fn(async () => ({ ETag: 'premature' }));
    await expect(fixture(send).storage.put(input)).resolves.toMatchObject({ outcome: 'unknown' });
    expect(input.body.destroyed).toBe(true);
  });

  it('snapshots the required manifest before async URL lookup and exposes only that original identity', async () => {
    const input = put();
    const original = manifest(Buffer.from('hello'));
    let release!: () => void;
    const url = new Promise<string>((resolve) => {
      release = () => resolve('/private');
    });
    const send = jest.fn(async (command) => {
      for await (const _ of command.input.Body) {
        /* Consume the entire source before acknowledging. */
      }
      return { ETag: 'ack' };
    });
    const storage = createManagedS3Storage({
      client: { send } as unknown as S3Client,
      bucket: 'isolated',
      urlForKey: () => url,
    });
    const pending = storage.put(input);
    input.integrity.sha256 = '0'.repeat(64);
    input.integrity.chunkSha256[0] = '0'.repeat(64);
    release();
    const receipt = await pending;
    expect(receipt.outcome).toBe('durable');
    expect(receipt.integrity).toEqual(original);
    expect(receipt.integrity).not.toBe(input.integrity);
    expect(receipt.integrity?.chunkSha256).not.toBe(input.integrity.chunkSha256);
  });

  it.each([undefined, { version: 1 }, { ...manifest(Buffer.from('hello')), chunkSha256: [] }])(
    'rejects missing or malformed read identity before invoking S3',
    async (integrity) => {
      const send = jest.fn(async () => ({ Body: Readable.from([Buffer.from('hello')]) }));
      const { storage } = fixture(send);
      await expect(
        (async () => {
          for await (const _ of storage.read({
            original: {
              source: 's3',
              storageKey: expectedKey,
              filepath: 'private',
              outcome: 'durable',
              bytes: 5,
              integrity: integrity as never,
            },
            signal: signal(),
          })) {
            /* Consume to surface validation failures. */
          }
        })(),
      ).rejects.toThrow();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('rejects missing PUT identity before URL resolution or S3 dispatch', async () => {
    const send = jest.fn(),
      urlForKey = jest.fn(async () => '/private');
    const storage = createManagedS3Storage({
      client: { send } as unknown as S3Client,
      bucket: 'isolated',
      urlForKey,
    });
    const input = put();
    await expect(storage.put({ ...input, integrity: undefined as never })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
    expect(urlForKey).not.toHaveBeenCalled();
    input.body.destroy();
  });

  it('closes a changed GET body without yielding any invalid content', async () => {
    const body = Readable.from([Buffer.from('jello')]);
    const { storage, observations } = fixture(jest.fn(async () => ({ Body: body })));
    const chunks: Uint8Array[] = [];
    await expect(
      (async () => {
        for await (const value of storage.read({
          original: {
            source: 's3',
            storageKey: expectedKey,
            filepath: 'private',
            outcome: 'durable',
            bytes: 5,
            integrity: manifest(Buffer.from('hello')),
          },
          signal: signal(),
        }))
          chunks.push(value);
      })(),
    ).rejects.toThrow();
    expect(chunks).toEqual([]);
    expect(body.destroyed).toBe(true);
    expect(observations).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'read', outcome: 'error' }),
    );
  });

  it('snapshots GET identity and locator before the first asynchronous operation', async () => {
    const original = {
      source: 's3',
      storageKey: expectedKey,
      filepath: 'private',
      outcome: 'durable' as const,
      bytes: 5,
      versionId: 'original-version',
      integrity: manifest(Buffer.from('hello')),
    };
    const send = jest.fn(async (command) => {
      expect(command.input).toMatchObject({ Key: expectedKey, VersionId: 'original-version' });
      return { Body: Readable.from([Buffer.from('hello')]) };
    });
    const reading = fixture(send).storage.read({ original, signal: signal() });
    original.storageKey = 'changed';
    original.versionId = 'changed';
    original.bytes = 9;
    original.integrity.sha256 = '0'.repeat(64);
    original.integrity.chunkSha256[0] = '0'.repeat(64);
    const received: Buffer[] = [];
    for await (const block of reading) received.push(Buffer.from(block));
    expect(Buffer.concat(received)).toEqual(Buffer.from('hello'));
  });

  it('aborts an idle GET body and joins its stream closure', async () => {
    const body = new Readable({ read() {} });
    const controller = new AbortController();
    const { storage } = fixture(jest.fn(async () => ({ Body: body })));
    const reader = storage
      .read({
        original: {
          source: 's3',
          storageKey: expectedKey,
          filepath: 'private',
          outcome: 'durable',
          bytes: 5,
          integrity: manifest(Buffer.from('hello')),
        },
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();
    const first = reader.next();
    // Handle an early rejection before the abort trigger; assert the original promise after it.
    void first.catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    // Ensure the RED version cannot leave a pending fixture stream after its assertion fails.
    const closedAtAbort = body.destroyed;
    body.destroy(new Error('Synthetic abort'));
    await expect(first).rejects.toThrow();
    expect(closedAtAbort).toBe(true);
  });
});

describe('managed client owned construction', () => {
  const env = {
    AWS_REGION: 'test-region',
    AWS_BUCKET_NAME: 'isolated',
    AWS_ENDPOINT_URL: 'https://storage.invalid',
    AWS_FORCE_PATH_STYLE: 'true',
    AWS_ACCESS_KEY_ID: 'test-only-key',
    AWS_SECRET_ACCESS_KEY: 'test-only-secret',
  };
  it('constructs independent actual clients with explicit snapshotted credentials', async () => {
    const input = { ...env };
    const first = createManagedS3Client(input);
    const second = createManagedS3Client(env);
    input.AWS_ACCESS_KEY_ID = 'changed-after-construction';
    try {
      expect(first).toBeInstanceOf(S3Client);
      expect(second).not.toBe(first);
      expect(await first.config.credentials()).toMatchObject({
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      });
      expect(await first.config.region()).toBe(env.AWS_REGION);
      expect(await first.config.endpoint!()).toMatchObject({
        protocol: 'https:',
        hostname: 'storage.invalid',
        path: '/',
      });
      expect(first.config.forcePathStyle).toBe(true);
      expect(await first.config.requestChecksumCalculation()).toBe('WHEN_REQUIRED');
      first.destroy();
      expect(await second.config.credentials()).toMatchObject({
        accessKeyId: env.AWS_ACCESS_KEY_ID,
      });
    } finally {
      first.destroy();
      second.destroy();
    }
  });
  it.each([
    { AWS_ACCESS_KEY_ID: undefined },
    { AWS_SECRET_ACCESS_KEY: undefined },
    { AWS_REGION: '' },
    { AWS_BUCKET_NAME: '' },
    { AWS_FORCE_PATH_STYLE: 'false' },
    { AWS_ENDPOINT_URL: 'http://storage.invalid' },
    { AWS_ENDPOINT_URL: 'https://user:pass@storage.invalid' },
    { AWS_ENDPOINT_URL: 'https://storage.invalid/path' },
    { AWS_ENDPOINT_URL: 'https://storage.invalid/?query=yes' },
    { AWS_ENDPOINT_URL: 'https://storage.invalid/#fragment' },
  ])('rejects unavailable managed authority before construction: %j', (override) => {
    expect(() => createManagedS3Client({ ...env, ...override })).toThrow(
      'Managed storage configuration unavailable',
    );
  });
  it('binds observations to actual clients and command adapters, with immutable values and no foreign adoption', () => {
    const input = { ...env };
    const first = createManagedS3Client(input);
    const second = createManagedS3Client(input);
    const foreign = new S3Client({ region: env.AWS_REGION });
    try {
      const storage = createManagedS3Storage({ client: first, bucket: env.AWS_BUCKET_NAME });
      const replacement = createManagedS3Storage({ client: first, bucket: env.AWS_BUCKET_NAME });
      const original = getManagedS3Provider(storage, null);
      const replaced = getManagedS3Provider(replacement, null);
      if (original.state !== 'captured' || replaced.state !== 'captured')
        throw new Error('Missing actual capture');
      expect(original.client.instanceId).toBe(replaced.client.instanceId);
      expect(original.commands.instanceId).not.toBe(replaced.commands.instanceId);
      expect(getManagedS3ClientCapture(first)?.instanceId).not.toBe(
        getManagedS3ClientCapture(second)?.instanceId,
      );
      expect(original.backend).toBeNull();
      expect(Object.isFrozen(original.commands)).toBe(true);
      input.AWS_BUCKET_NAME = 'different';
      input.AWS_REGION = 'different';
      input.AWS_ENDPOINT_URL = 'https://different.example.test';
      expect(getManagedS3Provider(storage, null)).toEqual(original);
      expect(JSON.stringify(original)).not.toMatch(/test-only-key|test-only-secret|credentials/i);
      expect(getManagedS3Provider(storage, undefined)).toEqual({ state: 'unavailable' });
      expect(getManagedS3ClientCapture(foreign)).toBeUndefined();
      expect(
        getManagedS3Provider(
          createManagedS3Storage({ client: foreign, bucket: env.AWS_BUCKET_NAME }),
          null,
        ),
      ).toEqual({ state: 'unavailable' });
      first.destroy();
      expect(getManagedS3Provider(storage, null)).toEqual({ state: 'unavailable' });
      expect(getManagedS3Provider(replacement, null)).toEqual({ state: 'unavailable' });
      expect(getManagedS3ClientCapture(second)).toBeDefined();
    } finally {
      first.destroy();
      second.destroy();
      foreign.destroy();
    }
  });

  it('invalidates managed custody before the actual handler destroy and keeps a failed teardown unavailable', () => {
    const client = createManagedS3Client(env);
    const handler = client.config.requestHandler;
    const failure = new Error('fixture teardown failed');
    const destroy = jest.spyOn(handler, 'destroy').mockImplementation(() => {
      expect(getManagedS3ClientCapture(client)).toBeUndefined();
      throw failure;
    });
    try {
      expect(() => client.destroy()).toThrow(failure);
      expect(getManagedS3ClientCapture(client)).toBeUndefined();
    } finally {
      destroy.mockRestore();
      client.destroy();
    }
  });
});

describe('managed original bound status through actual AWS SDK', () => {
  const binding = (expired = true) => ({
    version: 1 as const,
    bucket: 'isolated',
    key: expectedKey,
    operationId: 'operation',
    generation: '2',
    bytes: 5,
    wholeSHA256: sha(Buffer.from('hello')),
    mediaType: 'text/plain',
    originalDeadline: new Date(Date.now() + (expired ? -60000 : 300000)).toISOString(),
  });
  const status = (b: ReturnType<typeof binding>, state = 'published') => ({
    protocol: 1,
    bucket: b.bucket,
    key: b.key,
    generation: b.generation,
    uploadRequestId: b.operationId,
    declaredBytes: String(b.bytes),
    contentSHA256: b.wholeSHA256,
    mediaType: b.mediaType,
    originalDeadline: b.originalDeadline,
    state,
    ...(state === 'published'
      ? {
          metadataSHA256: 'a'.repeat(64),
          inventoryRevision: '2',
          inventorySHA256: 'b'.repeat(64),
          etag: 'c'.repeat(32),
        }
      : {}),
  });
  const canonical = (v: object) => JSON.stringify(v, Object.keys(v).sort());
  type InertReply = {
    response: { statusCode: number; headers: Record<string, string>; body: Readable };
  };
  function fixture(handle: (request: HttpRequest) => Promise<InertReply>) {
    const client = new S3Client({
      region: 'us-east-1',
      endpoint: 'https://fixture.invalid',
      forcePathStyle: true,
      maxAttempts: 1,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      credentials: { accessKeyId: 'fixture-access', secretAccessKey: 'fixture-secret' },
      requestHandler: { handle },
    });
    return {
      client,
      storage: createManagedS3Storage({
        client,
        bucket: 'isolated',
        urlForKey: async () => '/fixture',
      }),
    };
  }
  it('reads the expired immutable binding with exact signed GET fields and no new PUT/HEAD', async () => {
    const b = binding();
    const requests: HttpRequest[] = [];
    const f = fixture(async (request) => {
      requests.push(request);
      return {
        response: {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: Readable.from([canonical(status(b))]),
        },
      };
    });
    await expect(
      f.storage.observeOriginal({
        binding: b,
        integrity: manifest(Buffer.from('hello')),
        signal: signal(),
      }),
    ).resolves.toMatchObject({ outcome: 'durable', etag: '"' + 'c'.repeat(32) + '"' });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('GET');
    expect(requests[0].query).toEqual({ 'cortex-upload': '1' });
    expect(requests[0].body).toBeUndefined();
    const signed =
      requests[0].headers.authorization.match(/SignedHeaders=([^,]+)/)?.[1].split(';') ?? [];
    for (const field of [
      'content-type',
      'x-amz-meta-operation',
      'x-amz-meta-generation',
      'x-amz-meta-cortex-upload-bytes',
      'x-amz-meta-cortex-upload-sha256',
      'x-amz-meta-cortex-upload-deadline',
    ])
      expect(signed).toContain(field);
    expect(requests[0].headers['x-amz-meta-cortex-upload-deadline']).toBe(b.originalDeadline);
    f.client.destroy();
  });
  it.each([
    'unknown',
    'open',
    'sealed',
    '404',
    'mismatch',
    'extra',
    'no-proof',
    'oversize',
  ] as const)('preserves custody for %s status', async (mode) => {
    const b = binding();
    const value: Record<string, unknown> = status(
      b,
      ['unknown', 'open', 'sealed'].includes(mode) ? mode : 'published',
    );
    if (mode === 'mismatch') value.contentSHA256 = 'f'.repeat(64);
    if (mode === 'extra') value.surprise = true;
    if (mode === 'no-proof') delete value.metadataSHA256;
    const responseBody = Readable.from([
      mode === 'oversize' ? 'x'.repeat(16385) : canonical(value),
    ]);
    const f = fixture(async () => ({
      response: {
        statusCode: mode === '404' ? 404 : 200,
        headers: { 'content-type': 'application/json' },
        body: responseBody,
      },
    }));
    await expect(
      f.storage.observeOriginal({
        binding: b,
        integrity: manifest(Buffer.from('hello')),
        signal: signal(),
      }),
    ).resolves.toMatchObject({ outcome: 'unknown' });
    expect(responseBody.destroyed).toBe(true);
    f.client.destroy();
  });
  it('resolves a lost PUT acknowledgement through the same bound status without a second PUT', async () => {
    const b = binding(false);
    const methods: string[] = [];
    const f = fixture(async (request) => {
      methods.push(request.method);
      if (request.method === 'PUT') {
        for await (const _ of request.body) {
          /* Consume verified bytes before the deliberately lost acknowledgement. */
        }
        throw new Error('lost acknowledgement');
      }
      return {
        response: {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: Readable.from([canonical(status(b))]),
        },
      };
    });
    const bindWrite = jest.fn(async () => b);
    await expect(
      f.storage.put({
        bindWrite,
        lease,
        filename: 'display.txt',
        mediaType: 'text/plain',
        bytes: 5,
        integrity: manifest(Buffer.from('hello')),
        body: Readable.from([Buffer.from('hello')]),
        signal: signal(),
      }),
    ).resolves.toMatchObject({ outcome: 'durable' });
    expect(methods).toEqual(['PUT', 'GET']);
    expect(bindWrite).toHaveBeenCalledTimes(1);
    f.client.destroy();
  });
});
