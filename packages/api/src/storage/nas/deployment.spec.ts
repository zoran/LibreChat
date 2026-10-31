/** Actual local bootstrap and client/adapter brand, no socket/credential owner or remote database. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { managedUploadsConfigSchema } from 'librechat-data-provider';
import type { ManagedUploadsConfig } from 'librechat-data-provider';
import type { UploadNasMethods } from '@librechat/data-schemas';
import { createNasStorageDeployment, nasStorageBackend } from './deployment';
import { getNasS3StorageCapture } from './storage';
let root: string;
const deployments: Awaited<ReturnType<typeof createNasStorageDeployment>>[] = [];
beforeEach(async () => {
  if (!process.env.NAS_TEST_TMPDIR) throw Error('Owned temp directory required');
  root = await mkdtemp(path.join(process.env.NAS_TEST_TMPDIR, 'nas-deployment-'));
});
afterEach(async () => {
  deployments.splice(0).forEach((d) => d.close());
  if (root) await rm(root, { recursive: true });
});
async function configuration() {
  const credentialsFile = path.join(root, 'runtime-secret.json');
  await writeFile(
    credentialsFile,
    JSON.stringify({
      schema: 1,
      accessKeyId: 'SYNTHETIC_KEY',
      secretAccessKey: 'SYNTHETIC_SECRET',
    }),
    { mode: 0o600 },
  );
  return {
    storage: {
      kind: 'nas-s3',
      uid: 'synthetic-nas',
      endpoint: 'https://nas.invalid:9443',
      bucket: 'cortex-files',
      credentialsFile,
      trust: { mode: 'ca-hostname' },
    },
    health: { requiredHosts: ['cpu2', 'cpu3', 'cpu4', 'cpu5'] },
  };
}
const repository = {
  readNasOriginalWrite: jest.fn(),
  dispatchNasOriginalWrite: jest.fn(),
  dispatchNasCleanup: jest.fn(),
  observeNasCleanup: jest.fn(),
  consumeNasCleanup: jest.fn(),
} satisfies UploadNasMethods;
it('uses the real closed schema/defaults and actual factory brand without any repository or network operation', async () => {
  const input = await configuration();
  const deployment = await createNasStorageDeployment({
    configuration: input as ManagedUploadsConfig,
    repository,
    signal: new AbortController().signal,
  });
  deployments.push(deployment);
  expect(deployment.configuration).toEqual(managedUploadsConfigSchema.parse(input));
  expect(deployment.configuration.storage.region).toBe('us-east-1');
  expect(deployment.configuration.storage.requestTimeoutMs).toBe(10000);
  expect(getNasS3StorageCapture(deployment.storage)?.backend).toEqual(deployment.backend);
  expect(typeof deployment.healthProbe('cpu2')).toBe('function');
  for (const method of Object.values(repository)) expect(method).not.toHaveBeenCalled();
  expect(JSON.stringify(deployment)).not.toContain('SYNTHETIC_SECRET');
  deployment.close();
  deployment.close();
  expect(getNasS3StorageCapture(deployment.storage)).toBeUndefined();
});
it('excludes rotation/timeouts from namespace but binds canonical endpoint, region, bucket, UID and fixed protocol', async () => {
  const cfg = managedUploadsConfigSchema.parse(await configuration());
  const first = nasStorageBackend(cfg.storage);
  expect(first.configurationSha256).toBe(
    createHash('sha256')
      .update(
        JSON.stringify([
          'nas-s3-namespace-v1',
          'nas-s3',
          'acknowledged-only-v1',
          cfg.storage.uid,
          new URL(cfg.storage.endpoint).origin,
          cfg.storage.region,
          cfg.storage.bucket,
        ]),
      )
      .digest('hex'),
  );
  for (const storage of [
    { ...cfg.storage, credentialsFile: '/different/credentials' },
    { ...cfg.storage, requestTimeoutMs: 20000 },
    { ...cfg.storage, trust: { mode: 'ca-hostname' as const, caFile: '/rotated/ca' } },
    { ...cfg.storage, endpoint: cfg.storage.endpoint + '/' },
  ])
    expect(nasStorageBackend(storage)).toEqual(first);
  for (const storage of [
    { ...cfg.storage, uid: 'other' },
    { ...cfg.storage, endpoint: 'https://other.invalid' },
    { ...cfg.storage, region: 'other' },
    { ...cfg.storage, bucket: 'other-bucket' },
  ])
    expect(nasStorageBackend(storage).configurationSha256).not.toBe(first.configurationSha256);
});
it.each([
  'invalid-config',
  'missing-private-file',
  'invalid-secret',
  'invalid-utf8-certificate',
  'invalid-certificate',
  'abort',
])('fails %s with one generic error and no private submitted values', async (variant) => {
  const cfg = managedUploadsConfigSchema.parse(await configuration());
  const c = new AbortController();
  if (variant === 'invalid-config')
    cfg.storage.endpoint = 'https://SYNTHETIC_PRIVATE_USER:secret@nas.invalid/';
  if (variant === 'missing-private-file') cfg.storage.credentialsFile = path.join(root, 'missing');
  if (variant === 'invalid-secret')
    await writeFile(cfg.storage.credentialsFile, 'SYNTHETIC_PRIVATE_CONTENT');
  if (variant === 'invalid-utf8-certificate' || variant === 'invalid-certificate') {
    const caFile = path.join(root, 'certificate.pem');
    await writeFile(
      caFile,
      variant === 'invalid-utf8-certificate' ? Buffer.from([0xff]) : 'SYNTHETIC_PRIVATE_CERT',
    );
    cfg.storage.trust =
      variant === 'invalid-utf8-certificate'
        ? { mode: 'ca-hostname', caFile }
        : { mode: 'exact-certificate', certificateFile: caFile, sha256: 'a'.repeat(64) };
  }
  if (variant === 'abort') c.abort(new Error('SYNTHETIC_PRIVATE_ABORT ' + root));
  const failure = await createNasStorageDeployment({
    configuration: cfg,
    repository,
    signal: c.signal,
  }).then(
    (d) => {
      deployments.push(d);
      return null;
    },
    (e) => e,
  );
  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).toBe('NAS storage configuration unavailable');
  expect(failure.cause).toBeUndefined();
  expect(failure.message).not.toContain(root);
});
