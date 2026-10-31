/** storageAvailability.helper supplies synthetic authenticated-port frames, never NFS/NAS proof. */
import type {
  UploadNfsWriteProof,
  UploadS3HealthProof,
  UploadStorageHealthBinding,
} from 'librechat-data-provider';
export const healthNow = Date.UTC(2026, 9, 30, 22);
export const healthBinding: UploadStorageHealthBinding = {
  backend: {
    kind: 'nas-s3',
    uid: 'nas',
    configurationSha256: 'a'.repeat(64),
    protocol: 'acknowledged-only-v1',
  },
  cpuHosts: ['cpu-2', 'cpu-3', 'cpu-4', 'cpu-5'],
  cohortSha256: 'b'.repeat(64),
  nfsSourceSha256: 'c'.repeat(64),
  intervalMs: 60000,
  maxAgeMs: 90000,
};
export const nfsHealthFixture = (at = healthNow): UploadNfsWriteProof[] =>
  healthBinding.cpuHosts.map((hostId) => ({
    version: 1,
    hostId,
    backend: { ...healthBinding.backend },
    cohortSha256: healthBinding.cohortSha256,
    sourceSha256: healthBinding.nfsSourceSha256,
    probeId: 'probe',
    mountIdentitySha256: 'd'.repeat(64),
    writeReadSha256: 'e'.repeat(64),
    originalState: 'joined',
    outcome: 'ready',
    startedAtMs: at,
    completedAtMs: at,
    expiresAtMs: at + 90000,
  }));
export const s3HealthFixture = (at = healthNow): UploadS3HealthProof => ({
  version: 1,
  backend: { ...healthBinding.backend },
  owner: 'cpu-2',
  outcome: 'ready',
  startedAtMs: at,
  completedAtMs: at,
  expiresAtMs: at + 90000,
});
