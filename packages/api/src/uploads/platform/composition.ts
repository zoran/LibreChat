/** Normal platform composition binds private deployment inputs to existing resource/health owners. */
import { readFile } from 'node:fs/promises';
import { readUploadStorageHealthBinding } from 'librechat-data-provider';
import type { UploadPlatformRuntime, UploadPlatformRuntimeOptions } from './runtime';
import type { UploadStorageAvailabilityOwner } from '../storageAvailability';
import type { NasStorageDeployment } from '../../storage/nas/deployment';
import type { UploadServerEnvironment } from '../composition/storage';
import type { UploadNfsReportClientOptions } from '../nfsReports';
import type { UploadBackendBinding } from './backend';
import { createUploadStorageAvailability } from '../storageAvailability';
import { createUploadNfsReportClient } from '../nfsReports';
import { readNasLocalFile } from '../../storage/nas/files';
import { createUploadPlatformRuntime } from './runtime';
import { parseUploadBackendBinding } from './backend';

export interface UploadPlatformConfigurationOptions
  extends Pick<UploadPlatformRuntimeOptions, 'repository' | 'worker' | 'stagingRoot'> {
  env: UploadServerEnvironment;
  nas?: NasStorageDeployment;
  signal?: AbortSignal;
}

/** Local deployment material must be a protected regular file, including secret subPath binds. */
async function material(path: string, secret: boolean, signal?: AbortSignal): Promise<Buffer> {
  return readNasLocalFile(path, { secret, signal: signal ?? new AbortController().signal });
}
async function json(path: string, signal?: AbortSignal): Promise<unknown> {
  const bytes = await material(path, false, signal);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    bytes.fill(0);
  }
}
/** Retain the existing legacy backend-file semantics; NAS private inputs use the stricter loader. */
async function legacyBindingFile(path: string): Promise<unknown> {
  const bytes = await readFile(path);
  if (bytes.length > 65536) throw new Error('Invalid upload platform configuration');
  return JSON.parse(bytes.toString('utf8'));
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function collectorConfiguration(value: unknown): UploadNfsReportClientOptions['collectors'] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error('Invalid upload collectors');
  return value.map((item: unknown) => {
    if (
      !record(item) ||
      typeof item.observer !== 'string' ||
      typeof item.url !== 'string' ||
      Object.keys(item).sort().join(',') !== 'observer,url'
    )
      throw new Error('Invalid upload collectors');
    return { observer: item.observer, url: item.url };
  });
}
function reports(value: unknown): UploadNfsReportClientOptions['expectedReports'] {
  if (!Array.isArray(value) || value.length !== 4) throw new Error('Invalid NFS reports');
  return value.map((item: unknown) => {
    if (
      !record(item) ||
      typeof item.hostId !== 'string' ||
      typeof item.configurationSha256 !== 'string' ||
      typeof item.backendBindingSha256 !== 'string' ||
      Object.keys(item).sort().join(',') !== 'backendBindingSha256,configurationSha256,hostId'
    )
      throw new Error('Invalid NFS reports');
    return {
      hostId: item.hostId,
      configurationSha256: item.configurationSha256,
      backendBindingSha256: item.backendBindingSha256,
    };
  });
}

/** Absence keeps the legacy owner; a selected NAS requires the authentic four-host private policy. */
export async function createUploadPlatformFromConfiguration(
  options: UploadPlatformConfigurationOptions,
): Promise<UploadPlatformRuntime> {
  const { env, nas, signal } = options;
  let expectedHosts: unknown, rawCollectors: unknown;
  try {
    expectedHosts = JSON.parse(env.CORTEX_UPLOAD_EXPECTED_HOSTS || 'null');
    rawCollectors = env.CORTEX_UPLOAD_RESOURCE_COLLECTORS
      ? JSON.parse(env.CORTEX_UPLOAD_RESOURCE_COLLECTORS)
      : undefined;
  } catch {
    throw new Error('Invalid upload platform configuration');
  }
  if (
    !Array.isArray(expectedHosts) ||
    expectedHosts.length !== 4 ||
    !expectedHosts.every((host): host is string => typeof host === 'string')
  )
    throw new Error('Invalid upload platform hosts');
  let backendBinding: UploadBackendBinding | undefined;
  try {
    if (!nas)
      backendBinding = parseUploadBackendBinding(
        await legacyBindingFile(
          env.CORTEX_UPLOAD_BACKEND_CONFIG || '/etc/cortex-upload-safety/backend.json',
        ),
        expectedHosts,
      );
  } catch (error) {
    // Existing legacy missing evidence remains closed in its runtime; it cannot select NAS.
    if (nas || !record(error) || error.code !== 'ENOENT')
      throw new Error('Invalid upload safety binding');
  }
  const collectors =
    rawCollectors === undefined ? undefined : collectorConfiguration(rawCollectors);
  let tls: UploadNfsReportClientOptions['tls'] | undefined;
  if (collectors) {
    const reads = await Promise.allSettled(
      ['ca.crt', 'client.crt', 'client.key'].map((name, index) =>
        material(`/etc/cortex-upload-resources/${name}`, index === 2, signal),
      ),
    );
    if (reads.some((read) => read.status === 'rejected')) {
      for (const read of reads) if (read.status === 'fulfilled') read.value.fill(0);
      throw new Error('Invalid upload TLS material');
    }
    const values = reads.map((read) => {
      if (read.status !== 'fulfilled') throw new Error('Invalid upload TLS material');
      return read.value;
    });
    tls = { ca: values[0], cert: values[1], key: values[2] };
  }
  const backendCa = backendBinding
    ? await material('/var/run/cortex-upload-safety/ca.crt', false, signal)
    : undefined;
  let nfs: ReturnType<typeof createUploadNfsReportClient> | undefined;
  let storageAvailability: UploadStorageAvailabilityOwner | undefined;
  if (nas) {
    try {
      const policy = await json('/etc/cortex-upload-resources/nfs.json', signal);
      if (
        !record(policy) ||
        Object.keys(policy).sort().join(',') !== 'binding,expectedReports,schema' ||
        policy.schema !== 1 ||
        !collectors ||
        !tls
      )
        throw new Error('policy');
      const binding = readUploadStorageHealthBinding(policy.binding);
      if (
        !binding ||
        binding.backend.kind !== nas.backend.kind ||
        binding.backend.uid !== nas.backend.uid ||
        binding.backend.protocol !== nas.backend.protocol ||
        binding.backend.configurationSha256 !== nas.backend.configurationSha256 ||
        [...binding.cpuHosts].sort().join('\0') !==
          [...nas.configuration.health.requiredHosts].sort().join('\0') ||
        binding.intervalMs !== nas.configuration.health.intervalMs ||
        binding.maxAgeMs !== nas.configuration.health.maxAgeMs
      )
        throw new Error('binding');
      nfs = createUploadNfsReportClient({
        collectors,
        tls,
        binding,
        expectedReports: reports(policy.expectedReports),
      });
      storageAvailability = createUploadStorageAvailability({
        binding,
        readNfs: nfs.readNfs,
        probeS3: nas.healthProbe(options.worker.hostId),
      });
    } catch {
      await nfs?.close();
      throw new Error('NAS storage health unavailable');
    }
  }
  let runtime: UploadPlatformRuntime;
  try {
    runtime = createUploadPlatformRuntime({
      repository: options.repository,
      worker: options.worker,
      stagingRoot: options.stagingRoot,
      storageAvailability,
      expectedHosts,
      collectors,
      tls,
      backendBinding,
      backendCa,
      parserSocketPath: '/var/run/cortex-upload-parser/parser.sock',
      cgroupDirectory: '/sys/fs/cgroup',
    });
  } catch (error) {
    await storageAvailability?.stop();
    await nfs?.close();
    throw error;
  }
  const originalClose = runtime.close;
  return {
    ...runtime,
    get metrics() {
      return runtime.metrics;
    },
    async close() {
      const outcomes = await Promise.allSettled([originalClose(), nfs?.close()]);
      if (outcomes.some((r) => r.status === 'rejected'))
        throw new Error('Upload platform shutdown unresolved');
    },
  };
}
