/** Normal upload storage composition; backend, AV policy and client trust are server inputs only. */
import { isAbsolute } from 'node:path';
import type { ManagedUploadsConfig, UploadWorker } from 'librechat-data-provider';
import type { AppConfig, UploadNasMethods } from '@librechat/data-schemas';
import type { S3Client } from '@aws-sdk/client-s3';
import type { NasStorageDeployment } from '../../storage/nas/deployment';
import type { UploadStorageComposition } from '../../storage/uploads';
import type { UploadSecurityPort, StoragePort } from '../contract';
import type { UploadPlatformRuntime } from '../platform/runtime';
import { loadNasAntivirusClientPolicy } from '../antivirusAdmissionPolicy';
import { createNasStorageDeployment } from '../../storage/nas/deployment';
import { createNasAntivirusAdmissionGuard } from '../antivirusAdmission';
import { createHttpUploadSecurityPort } from '../security/transport';
import { createManagedS3Storage } from '../../storage/s3/managed';
import { composeUploadStorage } from '../../storage/uploads';
import { readNasLocalFile } from '../../storage/nas/files';

/** Existing process bootstrap snapshots environment; requests never supply this object. */
export type UploadServerEnvironment = Readonly<Record<string, string | undefined>>;

export async function createManagedUploadSecurityClient(options: {
  env: UploadServerEnvironment;
  signal?: AbortSignal;
}): Promise<UploadSecurityPort> {
  const { env } = options;
  const endpoint = env.UPLOAD_SECURITY_ENDPOINT;
  const policySha256 = env.UPLOAD_SECURITY_POLICY_SHA256;
  const allowedHosts = (env.UPLOAD_SECURITY_ALLOWED_HOSTS ?? '').split(',').filter(Boolean);
  const paths = ['CA', 'CERT', 'KEY'].map((name) => env[`UPLOAD_SECURITY_TLS_${name}_FILE`]);
  if (
    !endpoint ||
    !policySha256 ||
    !/^[a-f0-9]{64}$/.test(policySha256) ||
    !allowedHosts.length ||
    paths.some((value) => !value || !isAbsolute(value))
  )
    throw new Error('Upload security configuration unavailable');
  try {
    const reads = await Promise.allSettled(
      paths.map(async (file, index) => {
        if (!file) throw new Error('Missing TLS material');
        return readNasLocalFile(file, {
          secret: index === 2,
          signal: options.signal ?? new AbortController().signal,
        });
      }),
    );
    if (reads.some((read) => read.status === 'rejected')) {
      for (const read of reads) if (read.status === 'fulfilled') read.value.fill(0);
      throw new Error('Invalid TLS material');
    }
    const values = reads.map((read) => {
      if (read.status !== 'fulfilled') throw new Error('Invalid TLS material');
      return read.value;
    });
    return createHttpUploadSecurityPort({
      endpoint,
      allowedHosts,
      policySha256,
      tls: { ca: values[0], cert: values[1], key: values[2] },
    });
  } catch {
    throw new Error('Upload security configuration unavailable');
  }
}

/** Existing backend keeps its original commands and observers for retained operations. */
export function createLegacyUploadStorage(options: {
  client: S3Client;
  bucket: string | undefined;
  platform(): Pick<UploadPlatformRuntime, 'metrics'> | undefined;
}): StoragePort {
  if (!options.bucket) throw new Error('Missing managed storage bucket');
  return createManagedS3Storage({
    client: options.client,
    bucket: options.bucket,
    urlForKey: async (key) => {
      const match = /\/([a-zA-Z0-9-]+)\.[1-9][0-9]*__original$/.exec(key);
      if (!match) throw new Error('Invalid managed original locator');
      return `/api/files/managed/${match[1]}`;
    },
    observeBackend: (observation) => options.platform()?.metrics?.observeBackend(observation),
    observeBackendService: (observation) =>
      options.platform()?.metrics?.observeBackendService(observation),
  });
}

/** Only the base AppConfig owner selects deployment storage; user overrides do not participate. */
export async function selectManagedUploadConfiguration(
  getAppConfig: () => Promise<Pick<AppConfig, 'managedUploads'>>,
): Promise<ManagedUploadsConfig | undefined> {
  return (await getAppConfig()).managedUploads;
}

export function createNasAntivirusAdmission(options: {
  configuration: ManagedUploadsConfig;
  security: Pick<UploadSecurityPort, 'policySha256'>;
  env: UploadServerEnvironment;
}): ReturnType<typeof createNasAntivirusAdmissionGuard> {
  const sha256 = options.env.DOCUMENT_SECURITY_AV_CLIENT_POLICY_SHA256;
  if (!sha256) throw new Error('NAS antivirus policy unavailable');
  const policy = loadNasAntivirusClientPolicy({
    sha256,
    signatureMaxAgeMs: options.configuration.antivirus?.signatureMaxAgeMs ?? 86400000,
  });
  return createNasAntivirusAdmissionGuard({
    policy,
    securityPolicySha256: options.security.policySha256,
  });
}

export type NormalUploadStorage = UploadStorageComposition &
  Readonly<{
    nasStorage: UploadStorageComposition['nasCleanup'];
    platform: UploadPlatformRuntime;
    close(): void;
  }>;
export interface NormalUploadStorageOptions {
  configuration?: ManagedUploadsConfig;
  repository: UploadNasMethods;
  worker: UploadWorker;
  stagingRoot: string;
  managedStorage: StoragePort;
  signal: AbortSignal;
  createUploadPlatform(options: {
    repository: UploadNasMethods;
    worker: UploadWorker;
    stagingRoot: string;
    nas?: NasStorageDeployment;
    signal?: AbortSignal;
  }): Promise<UploadPlatformRuntime>;
}

/** One owner supplies status and the final pre-dispatch gate; selected NAS never falls back. */
export async function createNormalUploadStorage(
  options: NormalUploadStorageOptions,
): Promise<NormalUploadStorage> {
  let nas: NasStorageDeployment | undefined, platform: UploadPlatformRuntime | undefined;
  try {
    if (options.configuration !== undefined) {
      nas = await createNasStorageDeployment({
        configuration: options.configuration,
        repository: options.repository,
        signal: options.signal,
        assertWriteSafe() {
          if (!platform?.storageAvailability) throw new Error('NAS storage unavailable');
          platform.storageAvailability.assertSafe();
        },
      });
    }
    platform = await options.createUploadPlatform({
      repository: options.repository,
      worker: options.worker,
      stagingRoot: options.stagingRoot,
      ...(nas ? { nas } : {}),
      signal: options.signal,
    });
    if (nas && !platform.storageAvailability) throw new Error('NAS storage health unavailable');
    const selected: UploadStorageComposition = nas
      ? composeUploadStorage({ managedStorage: options.managedStorage, nasStorage: nas.storage })
      : { storage: options.managedStorage, managedCleanup: options.managedStorage };
    return { ...selected, nasStorage: selected.nasCleanup, platform, close: () => nas?.close() };
  } catch (error) {
    await Promise.allSettled([
      Promise.resolve().then(() => platform?.close()),
      Promise.resolve().then(() => nas?.close()),
    ]);
    throw error;
  }
}

/** Housekeeping can read and retire originals but deliberately receives no new-write authority. */
export async function createHousekeepingUploadStorage(options: {
  configuration?: ManagedUploadsConfig;
  repository: UploadNasMethods;
  managedStorage: StoragePort;
  signal: AbortSignal;
}): Promise<UploadStorageComposition & { close(): void }> {
  const nas =
    options.configuration === undefined
      ? undefined
      : await createNasStorageDeployment({
          configuration: options.configuration,
          repository: options.repository,
          signal: options.signal,
        });
  try {
    const selected = nas
      ? composeUploadStorage({ managedStorage: options.managedStorage, nasStorage: nas.storage })
      : { storage: options.managedStorage, managedCleanup: options.managedStorage };
    return { ...selected, close: () => nas?.close() };
  } catch (error) {
    nas?.close();
    throw error;
  }
}
