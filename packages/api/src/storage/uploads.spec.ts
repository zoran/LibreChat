/** Real factory/capture routing; the external DB stops writes, never claims NAS acceptance. */
import { Readable } from 'node:stream';
import type {
  UploadPrincipal,
  UploadStorageReceipt,
  UploadSecurityApproval,
  NasUploadWriteBinding,
} from 'librechat-data-provider';
import type { UploadNasMethods } from '@librechat/data-schemas';
import type { StoragePort } from '../uploads/contract';
import type { NasStoragePort } from './nas';
import { createOriginalIntegrity } from '../uploads/storage/integrity';
import { createNasS3Storage, getNasS3StorageCapture } from './nas';
import { composeUploadStorage } from './uploads';
import { createNasS3Client } from './nas/client';
const signal = new AbortController().signal;
const principal: UploadPrincipal = {
  tenantId: 'tenant',
  userId: 'user',
  authentication: 'verified-email',
};
const backend = {
  kind: 'nas-s3' as const,
  uid: 'synthetic-nas',
  protocol: 'acknowledged-only-v1' as const,
  configurationSha256: 'a'.repeat(64),
};
const bytes = Buffer.from('hello');
const hash = createOriginalIntegrity(bytes.length);
hash.update(bytes);
const integrity = hash.finish();
const clients: ReturnType<typeof createNasS3Client>[] = [];
afterEach(() => clients.splice(0).forEach((c) => c.destroy()));
function fixture() {
  const managed = {
    put: jest.fn().mockResolvedValue({ source: 'managed-marker' }),
    observeOriginal: jest.fn().mockResolvedValue({ source: 'managed-marker' }),
    read: jest.fn(async function* () {
      yield Buffer.from('legacy');
    }),
    describeDeletion: jest.fn(),
    beginDeletion: jest.fn(),
    observeDeletion: jest.fn(),
    acknowledgeDeletionConsumed: jest.fn(),
    remove: jest.fn(),
  };
  const repository = {
    readNasOriginalWrite: jest.fn().mockResolvedValue(null),
    dispatchNasOriginalWrite: jest.fn().mockRejectedValue(new Error('external DB unavailable')),
    dispatchNasCleanup: jest.fn(),
    observeNasCleanup: jest.fn(),
    consumeNasCleanup: jest.fn(),
  } satisfies UploadNasMethods;
  const client = createNasS3Client({
    backend,
    endpoint: 'https://nas.invalid:9443',
    region: 'us-east-1',
    bucket: 'cortex-files',
    credentials: { accessKeyId: 'SYNTHETIC', secretAccessKey: 'SYNTHETIC' },
    trust: { mode: 'ca-hostname' },
    requestTimeoutMs: 1000,
  });
  clients.push(client);
  return {
    managed,
    repository,
    client,
    nas: createNasS3Storage({ client, repository, assertWriteSafe: () => undefined }),
  };
}
function original(nas = false): UploadStorageReceipt {
  return {
    source: nas ? 'nas-s3' : 's3',
    outcome: 'unknown',
    bytes: 5,
    storageKey: 'owned-key',
    filepath: 'owned-private',
    ...(nas ? { backend } : {}),
  };
}
function binding(): NasUploadWriteBinding {
  return {
    version: 2,
    backend,
    bucket: 'cortex-files',
    key: 'owned-key',
    operationId: 'operation',
    generation: '1',
    bytes: 5,
    wholeSHA256: integrity.sha256,
    mediaType: 'text/plain',
    originalDeadline: new Date(Date.now() + 10000).toISOString(),
  };
}
function putInput(): Parameters<StoragePort['put']>[0] {
  // This retained-shaped approval is not new-write authority. The real adapter forwards it to
  // the unavailable external repository, and no successful dispatch/AV outcome is asserted.
  const securityApproval: UploadSecurityApproval = {
    version: 1,
    decision: 'approved',
    policySha256: 'b'.repeat(64),
    subject: {
      tenantId: 'tenant',
      userId: 'user',
      operationId: 'operation',
      transferGeneration: 1,
      mediaType: 'text/plain',
      bytes: 5,
      sha256: integrity.sha256,
    },
    scannerVersion: 'routing-only',
    checkedAt: new Date().toISOString(),
    coverage: { complete: true, pages: 1, parts: 1 },
  };
  return {
    bindWrite: jest.fn(),
    lease: {
      tenantId: 'tenant',
      userId: 'user',
      operationId: 'operation',
      generation: 1,
      kind: 'transfer',
      hostId: 'host',
      instanceId: 'instance',
      expiresAt: new Date(Date.now() + 10000).toISOString(),
    },
    filename: 'fixture.txt',
    mediaType: 'text/plain',
    bytes: 5,
    integrity,
    body: Readable.from([bytes]),
    securityApproval,
    signal,
  };
}
it('selects legacy new-write storage only when no NAS deployment is present', async () => {
  const f = fixture();
  const composed = composeUploadStorage({ managedStorage: f.managed });
  const input = putInput();
  await composed.storage.put(input);
  expect(f.managed.put).toHaveBeenCalledWith(input);
  expect(composed.managedCleanup).toBe(f.managed);
  expect(composed.nasCleanup).toBeUndefined();
  expect(f.repository.dispatchNasOriginalWrite).not.toHaveBeenCalled();
});
it('selects the actual NAS adapter for new writes and exposes its separate branded cleanup owner', async () => {
  const f = fixture();
  const composed = composeUploadStorage({ managedStorage: f.managed, nasStorage: f.nas });
  expect(composed.nasCleanup).toBe(f.nas);
  expect(getNasS3StorageCapture(composed.nasCleanup!)).toBeDefined();
  expect(composed.managedCleanup).toBe(f.managed);
  await expect(composed.storage.put(putInput())).rejects.toThrow();
  expect(f.repository.dispatchNasOriginalWrite).toHaveBeenCalledTimes(1);
  expect(f.managed.put).not.toHaveBeenCalled();
});
it('keeps v1 observations and backendless retained originals on their legacy owner after NAS configuration', async () => {
  const f = fixture();
  const composed = composeUploadStorage({ managedStorage: f.managed, nasStorage: f.nas });
  const { version: _version, backend: _backend, ...fields } = binding();
  const old = { version: 1 as const, ...fields };
  await composed.storage.observeOriginal({ principal, binding: old, integrity, signal });
  expect(f.managed.observeOriginal).toHaveBeenCalledTimes(1);
  expect(f.repository.readNasOriginalWrite).not.toHaveBeenCalled();
  const input = { principal, operationId: 'operation', original: original(), signal };
  const chunks = [];
  for await (const chunk of composed.storage.read(input)) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toBe('legacy');
  expect(f.managed.read).toHaveBeenCalledWith(input);
});
it.each([
  'missing',
  'forged',
  'disposed',
  'foreign-uid',
  'foreign-digest',
  'foreign-protocol',
  'foreign-bucket',
])('never sends NAS-bound observations/reads to managed storage when %s', async (variant) => {
  const f = fixture();
  let nas: NasStoragePort | undefined = f.nas;
  let selected = binding();
  if (variant === 'missing') nas = undefined;
  if (variant === 'forged') nas = { ...f.nas };
  if (variant === 'disposed') f.client.destroy();
  if (variant === 'foreign-uid')
    selected = { ...selected, backend: { ...backend, uid: 'foreign' } };
  if (variant === 'foreign-digest')
    selected = { ...selected, backend: { ...backend, configurationSha256: 'f'.repeat(64) } };
  if (variant === 'foreign-protocol')
    selected = { ...selected, backend: { ...backend, protocol: 'foreign' as never } };
  if (variant === 'foreign-bucket') selected = { ...selected, bucket: 'foreign-bucket' };
  if (variant === 'forged' || variant === 'disposed') {
    expect(() => composeUploadStorage({ managedStorage: f.managed, nasStorage: nas })).toThrow(
      'NAS storage authority unavailable',
    );
    return;
  }
  const composed = composeUploadStorage({
    managedStorage: f.managed,
    ...(nas ? { nasStorage: nas } : {}),
  });
  await expect(
    Promise.resolve().then(() =>
      composed.storage.observeOriginal({ principal, binding: selected, integrity, signal }),
    ),
  ).rejects.toThrow();
  const receipt = { ...original(true), backend: selected.backend };
  await expect(
    (async () => {
      for await (const _chunk of composed.storage.read({
        principal,
        operationId: 'operation',
        original: receipt,
        signal,
      })) {
        /* No acceptance from a receipt shape. */
      }
    })(),
  ).rejects.toThrow();
  expect(f.managed.observeOriginal).not.toHaveBeenCalled();
  expect(f.managed.read).not.toHaveBeenCalled();
});
it('revokes the live capture on close and never falls back after construction', async () => {
  const f = fixture();
  const composed = composeUploadStorage({ managedStorage: f.managed, nasStorage: f.nas });
  f.client.destroy();
  await expect(Promise.resolve().then(() => composed.storage.put(putInput()))).rejects.toThrow(
    'NAS storage authority unavailable',
  );
  expect(f.managed.put).not.toHaveBeenCalled();
});
it('keeps legacy deletion protocol on its own port and never invents a NAS deletion receipt', async () => {
  const f = fixture();
  const composed = composeUploadStorage({ managedStorage: f.managed, nasStorage: f.nas });
  const input = {
    operationId: 'operation',
    generation: 1,
    tenantId: 'tenant',
    userId: 'user',
    signal,
  };
  await composed.storage.remove(input);
  expect(f.managed.remove).toHaveBeenCalledWith(input);
  expect(f.repository.dispatchNasCleanup).not.toHaveBeenCalled();
  expect(composed.nasCleanup).not.toBe(composed.storage);
  expect(composed.managedCleanup).toBe(f.managed);
});
