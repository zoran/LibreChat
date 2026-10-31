/** storageAuthority.spec.ts uses real binding/receipt validators; only repository rows are fixtures. */
import type { UploadCleanupTask, NasUploadWriteBinding } from 'librechat-data-provider';
import { resolveFileStorageAuthority } from './storageAuthority';

function fixture() {
  const backend = {
    kind: 'nas-s3' as const,
    protocol: 'acknowledged-only-v1' as const,
    uid: 'private-backend',
    configurationSha256: 'a'.repeat(64),
  };
  const writeBinding: NasUploadWriteBinding = {
    version: 2,
    backend,
    bucket: 'private-files',
    key: 'originals/opaque-server-key',
    operationId: 'file-a',
    generation: '2',
    bytes: 5,
    wholeSHA256: 'b'.repeat(64),
    mediaType: 'text/plain',
    originalDeadline: '2099-01-01T00:00:00.000Z',
  };
  const task: UploadCleanupTask = {
    operationId: 'file-a',
    fileId: 'file-a',
    generation: 3,
    attemptGeneration: 2,
    state: 'ready',
    principal: {
      authentication: 'verified-email',
      tenantId: 'resource-tenant',
      userId: 'resource-owner',
    },
    writeBinding,
    writerStopped: true,
    localCopiesAbsent: true,
    original: {
      outcome: 'durable',
      source: 'nas-s3',
      backend,
      bytes: 5,
      storageKey: writeBinding.key,
      filepath: '/api/files/managed/file-a',
      integrity: {
        version: 1,
        algorithm: 'sha256',
        sha256: 'b'.repeat(64),
        chunkBytes: 262144,
        chunkSha256: ['b'.repeat(64)],
      },
    },
  };
  const file = {
    operationId: 'file-a',
    source: 'nas-s3',
    storageKey: writeBinding.key,
    bytes: 5,
    mediaType: 'text/plain',
  };
  return { task, file, writeBinding };
}

it('takes immutable owner authority from the existing row, independently of an acting reader', () => {
  const f = fixture(),
    authority = resolveFileStorageAuthority(f.task, f.file);
  expect(authority).toEqual({ principal: f.task.principal, operationId: 'file-a' });
  expect(authority?.principal.userId).toBe('resource-owner');
  expect(authority?.principal).not.toBe(f.task.principal);
  expect(Object.isFrozen(authority?.principal)).toBe(true);
  f.task.principal.userId = 'changed-after-load';
  expect(authority?.principal.userId).toBe('resource-owner');
});

it.each([
  'missing-binding',
  'wrong-key',
  'wrong-operation',
  'wrong-generation',
  'wrong-hash',
  'wrong-backend',
  'wrong-source',
  'versioned',
  'malformed-binding',
])('rejects NAS original authority with %s', (kind) => {
  const f = fixture();
  if (kind === 'missing-binding') delete f.task.writeBinding;
  if (kind === 'wrong-key') f.file.storageKey = 'originals/another';
  if (kind === 'wrong-operation') f.file.operationId = 'another';
  if (kind === 'wrong-generation') f.task.attemptGeneration = 4;
  if (kind === 'wrong-hash')
    f.task.writeBinding = { ...f.writeBinding, wholeSHA256: 'c'.repeat(64) };
  if (kind === 'wrong-backend' && f.task.original)
    f.task.original.backend = { ...f.writeBinding.backend, uid: 'foreign' };
  if (kind === 'wrong-source') f.file.source = 's3';
  if (kind === 'versioned' && f.task.original) f.task.original.versionId = 'unexpected-version';
  if (kind === 'malformed-binding') f.task.writeBinding = { ...f.writeBinding, generation: '02' };
  expect(resolveFileStorageAuthority(f.task, f.file)).toBeUndefined();
});
