/** Genuine policy composition with inert filesystem/transport/runtime boundaries, no physical health claim. */
import type { NasStorageDeployment } from '../../storage/nas/deployment';
import type { UploadPlatformRuntime } from './runtime';
import { createUploadStorageAvailability } from '../storageAvailability';
import { createUploadPlatformFromConfiguration } from './composition';
import { createUploadNfsReportClient } from '../nfsReports';
import { readNasLocalFile } from '../../storage/nas/files';
import { createUploadPlatformRuntime } from './runtime';

jest.mock('../../storage/nas/files', () => ({ readNasLocalFile: jest.fn() }));
jest.mock('../nfsReports', () => ({ createUploadNfsReportClient: jest.fn() }));
jest.mock('../storageAvailability', () => ({ createUploadStorageAvailability: jest.fn() }));
jest.mock('./runtime', () => ({ createUploadPlatformRuntime: jest.fn() }));
const hosts = ['lx-s-bwi-cpu-2', 'lx-s-bwi-cpu-3', 'lx-s-bwi-cpu-4', 'lx-s-bwi-cpu-5'];
const backend = {
  kind: 'nas-s3' as const,
  uid: 'owned',
  configurationSha256: 'a'.repeat(64),
  protocol: 'acknowledged-only-v1' as const,
};
let policy: { schema: number; binding: Record<string, unknown>; expectedReports: unknown[] };
let runtime: UploadPlatformRuntime;
let closeNfs: jest.Mock;
let readNfs: jest.Mock;
let availability: ReturnType<typeof createUploadStorageAvailability>;
let nas: NasStorageDeployment;
beforeEach(() => {
  jest.clearAllMocks();
  policy = {
    schema: 1,
    binding: {
      backend: {
        protocol: backend.protocol,
        configurationSha256: backend.configurationSha256,
        uid: backend.uid,
        kind: backend.kind,
      },
      cpuHosts: hosts,
      cohortSha256: 'b'.repeat(64),
      nfsSourceSha256: 'c'.repeat(64),
      intervalMs: 60000,
      maxAgeMs: 90000,
    },
    expectedReports: hosts.map((hostId) => ({
      hostId,
      configurationSha256: 'd'.repeat(64),
      backendBindingSha256: backend.configurationSha256,
    })),
  };
  jest
    .mocked(readNasLocalFile)
    .mockImplementation(async (path) =>
      Buffer.from(path.endsWith('nfs.json') ? JSON.stringify(policy) : 'SYNTHETIC_MTLS_ONLY'),
    );
  closeNfs = jest.fn(async () => {});
  readNfs = jest.fn(async () => []);
  jest.mocked(createUploadNfsReportClient).mockReturnValue({ readNfs, close: closeNfs });
  availability = {
    assertSafe: jest.fn(),
    stop: jest.fn(async () => {}),
    matchesHosts: jest.fn(() => true),
  } as unknown as typeof availability;
  jest.mocked(createUploadStorageAvailability).mockReturnValue(availability);
  runtime = {
    close: jest.fn(async () => {}),
    storageAvailability: availability,
    metrics: undefined,
  } as unknown as UploadPlatformRuntime;
  jest.mocked(createUploadPlatformRuntime).mockReturnValue(runtime);
  nas = {
    backend,
    configuration: {
      health: {
        requiredHosts: hosts,
        intervalMs: 60000,
        maxAgeMs: 90000,
      },
    },
    healthProbe: jest.fn(() => jest.fn()),
  } as unknown as NasStorageDeployment;
});
const options = () => ({
  env: {
    CORTEX_UPLOAD_EXPECTED_HOSTS: JSON.stringify(hosts),
    CORTEX_UPLOAD_RESOURCE_COLLECTORS: JSON.stringify([
      { observer: 'first', url: 'https://first.invalid/v1/upload-resources' },
      { observer: 'second', url: 'https://second.invalid/v1/upload-resources' },
    ]),
  },
  nas,
  repository: { localReservations: jest.fn() },
  worker: { hostId: hosts[0], instanceId: 'owned' },
  stagingRoot: '/owned/staging',
});

it('binds one canonical health owner by namespace values, independent of JSON property order', async () => {
  const selected = await createUploadPlatformFromConfiguration(options());
  expect(createUploadStorageAvailability).toHaveBeenCalledWith(
    expect.objectContaining({ readNfs }),
  );
  expect(createUploadPlatformRuntime).toHaveBeenCalledWith(
    expect.objectContaining({
      storageAvailability: availability,
      backendBinding: undefined,
    }),
  );
  expect(readNasLocalFile).toHaveBeenCalledWith(
    '/etc/cortex-upload-resources/client.key',
    expect.objectContaining({ secret: true }),
  );
  expect(selected.storageAvailability).toBe(availability);
  await selected.close();
  expect(runtime.close).toHaveBeenCalledTimes(1);
  expect(closeNfs).toHaveBeenCalledTimes(1);
});
it.each(['uid', 'configurationSha256'])(
  'refuses a foreign NAS %s before creating a health owner',
  async (field) => {
    policy.binding.backend = { ...backend, [field]: field === 'uid' ? 'foreign' : 'e'.repeat(64) };
    await expect(createUploadPlatformFromConfiguration(options())).rejects.toThrow(
      'NAS storage health unavailable',
    );
    expect(createUploadStorageAvailability).not.toHaveBeenCalled();
    expect(createUploadPlatformRuntime).not.toHaveBeenCalled();
  },
);
it('does not substitute another CPU cohort or cadence for the selected deployment', async () => {
  policy.binding.intervalMs = 30000;
  await expect(createUploadPlatformFromConfiguration(options())).rejects.toThrow(
    'NAS storage health unavailable',
  );
  expect(createUploadNfsReportClient).not.toHaveBeenCalled();
});
it('joins the created NFS client and health owner when runtime construction fails', async () => {
  jest.mocked(createUploadPlatformRuntime).mockImplementation(() => {
    throw new Error('runtime failed');
  });
  await expect(createUploadPlatformFromConfiguration(options())).rejects.toThrow('runtime failed');
  expect(availability.stop).toHaveBeenCalledTimes(1);
  expect(closeNfs).toHaveBeenCalledTimes(1);
});
