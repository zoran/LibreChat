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
import { createManagedS3Storage, managedOriginalKey } from '../managed';

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
    lease,
    filename: '../../display.txt',
    mediaType: 'text/plain',
    bytes: 5,
    body: Readable.from([Buffer.from(body)]),
    integrity: manifest(Buffer.from('hello')),
    signal: signal(),
  });

  it('uses existing tenant/user canonical key with a server-only basename', () => {
    expect(managedOriginalKey(lease)).toBe(expectedKey);
    expect(() => managedOriginalKey({ ...lease, userId: '../escape' })).toThrow();
  });
  it('returns durable receipt only after exact bytes finish and passes abort to SDK', async () => {
    const send = jest.fn(async (command, options) => {
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect(options.abortSignal).toBeInstanceOf(AbortSignal);
      expect(command.input.Key).toBe(expectedKey);
      expect(command.input.ContentLength).toBe(5);
      expect(command.input.IfNoneMatch).toBe('*');
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
    const rejected = await expect(first).rejects.toThrow();
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    // Ensure the RED version cannot leave a pending fixture stream after its assertion fails.
    const closedAtAbort = body.destroyed;
    body.destroy(new Error('Synthetic abort'));
    await rejected;
    expect(closedAtAbort).toBe(true);
  });
});
