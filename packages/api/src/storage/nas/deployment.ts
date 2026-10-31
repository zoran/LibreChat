/** Bootstrap NAS adapters from typed private AppConfig and mounted local inputs, without network I/O. */
import { createHash } from 'node:crypto';
import { managedUploadsConfigSchema } from 'librechat-data-provider';
import type { ManagedUploadsConfig, NasS3Backend } from 'librechat-data-provider';
import type { UploadNasMethods } from '@librechat/data-schemas';
import type { NasTransportTrust } from './client';
import type { NasS3HealthProbe } from './health';
import type { NasStoragePort } from './storage';
import { readNasLocalFile, parseNasCredentials } from './files';
import { createNasS3HealthProbe } from './health';
import { createNasS3Storage } from './storage';
import { createNasS3Client } from './client';

export type NasStorageDeployment = Readonly<{
  storage: NasStoragePort;
  backend: NasS3Backend;
  configuration: ManagedUploadsConfig;
  healthProbe(owner: string): NasS3HealthProbe;
  close(): void;
}>;

/** Namespace identity excludes rotated credentials, certificate pins and transport timeout tuning. */
export function nasStorageBackend(configuration: ManagedUploadsConfig['storage']): NasS3Backend {
  const parsed = managedUploadsConfigSchema.shape.storage.safeParse(configuration);
  if (!parsed.success) throw new Error('NAS storage configuration unavailable');
  const c = parsed.data;
  const protocol = 'acknowledged-only-v1';
  return Object.freeze({
    kind: 'nas-s3',
    uid: c.uid,
    protocol,
    configurationSha256: createHash('sha256')
      .update(
        JSON.stringify([
          'nas-s3-namespace-v1',
          'nas-s3',
          protocol,
          c.uid,
          new URL(c.endpoint).origin,
          c.region,
          c.bucket,
        ]),
      )
      .digest('hex'),
  });
}

/** Absence is selected by composition; an invalid or missing present configuration never falls back. */
export async function createNasStorageDeployment(options: {
  configuration: ManagedUploadsConfig;
  repository: UploadNasMethods;
  signal: AbortSignal;
  assertWriteSafe?: () => void;
}): Promise<NasStorageDeployment> {
  let client: ReturnType<typeof createNasS3Client> | undefined;
  try {
    const parsed = managedUploadsConfigSchema.safeParse(options.configuration);
    if (!parsed.success) throw new Error('NAS storage configuration unavailable');
    const configuration = parsed.data;
    const input = configuration.storage;
    const secret = await readNasLocalFile(input.credentialsFile, {
      secret: true,
      signal: options.signal,
    });
    let credentials: ReturnType<typeof parseNasCredentials>;
    try {
      credentials = parseNasCredentials(secret);
    } finally {
      secret.fill(0);
    }
    let trust: NasTransportTrust;
    if (input.trust.mode === 'exact-certificate') {
      const certificate = await readNasLocalFile(input.trust.certificateFile, {
        secret: false,
        signal: options.signal,
      });
      try {
        trust = {
          mode: 'exact-certificate',
          certificatePem: new TextDecoder('utf-8', { fatal: true }).decode(certificate),
          sha256: input.trust.sha256,
        };
      } finally {
        certificate.fill(0);
      }
    } else {
      const certificate = input.trust.caFile
        ? await readNasLocalFile(input.trust.caFile, { secret: false, signal: options.signal })
        : undefined;
      try {
        trust = {
          mode: 'ca-hostname',
          ...(certificate
            ? { caPem: new TextDecoder('utf-8', { fatal: true }).decode(certificate) }
            : {}),
        };
      } finally {
        certificate?.fill(0);
      }
    }
    options.signal.throwIfAborted();
    const backend = nasStorageBackend(input);
    client = createNasS3Client({
      backend,
      endpoint: input.endpoint,
      region: input.region,
      bucket: input.bucket,
      credentials,
      trust,
      requestTimeoutMs: input.requestTimeoutMs,
    });
    const storage = createNasS3Storage({
      client,
      repository: options.repository,
      assertWriteSafe: options.assertWriteSafe,
    });
    const originalClient = client;
    return Object.freeze({
      storage,
      backend,
      configuration,
      healthProbe: (owner: string) => createNasS3HealthProbe(originalClient, owner),
      close: () => originalClient.destroy(),
    });
  } catch {
    try {
      client?.destroy();
    } catch {
      /* no raw transport error or submitted value escapes */
    }
    throw new Error('NAS storage configuration unavailable');
  }
}
