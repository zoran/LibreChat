/** managed.spec.ts proves NAS identities never enter the legacy managed-S3 protocol. */
import { S3Client } from '@aws-sdk/client-s3';
import type { NasUploadWriteBinding } from 'librechat-data-provider';
import { createManagedS3Storage } from './managed';

jest.mock('~/files', () => ({ deleteRagFile: jest.fn() }));
jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
it('rejects NAS v2 before legacy status or read dispatch', async () => {
  const handle = jest.fn(async () => {
    throw new Error('Unexpected inert SDK dispatch');
  });
  const client = new S3Client({
    region: 'us-east-1',
    endpoint: 'https://inert.invalid',
    credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' },
    requestHandler: { handle },
    maxAttempts: 1,
  });
  const storage = createManagedS3Storage({ client, bucket: 'private-files' });
  const principal = {
    authentication: 'verified-email' as const,
    tenantId: 'tenant',
    userId: 'owner',
  };
  const backend = {
    kind: 'nas-s3' as const,
    protocol: 'acknowledged-only-v1' as const,
    uid: 'private-backend',
    configurationSha256: 'a'.repeat(64),
  };
  const integrity = {
    version: 1 as const,
    algorithm: 'sha256' as const,
    sha256: 'b'.repeat(64),
    chunkBytes: 262144 as const,
    chunkSha256: ['b'.repeat(64)],
  };
  const binding: NasUploadWriteBinding = {
    version: 2,
    backend,
    bucket: 'private-files',
    key: 'originals/opaque-server-key',
    operationId: 'op',
    generation: '2',
    bytes: 5,
    wholeSHA256: integrity.sha256,
    mediaType: 'text/plain',
    originalDeadline: '2099-01-01T00:00:00.000Z',
  };
  try {
    await expect(
      storage.observeOriginal({
        principal,
        binding,
        integrity,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    expect(() =>
      storage.read({
        principal,
        operationId: 'op',
        original: {
          outcome: 'durable',
          source: 's3',
          storageKey: 't/tenant/managed-uploads/owner/op.2__original',
          bytes: 5,
          filepath: '/api/files/managed/op',
          backend,
          integrity,
        },
        signal: new AbortController().signal,
      }),
    ).toThrow();
    expect(handle).not.toHaveBeenCalled();
  } finally {
    client.destroy();
  }
});
