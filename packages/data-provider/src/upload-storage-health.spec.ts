/** upload-storage-health.spec verifies exact current cohort/freshness and privacy-safe projections. */
import {
  evaluateUploadStorageAvailability,
  readUploadNfsWriteProof,
  readUploadStorageHealthBinding,
} from './upload-storage-health';
import { readUploadStorageAvailability, readManagedUploadFeatureCapability } from './upload-live';
const now = Date.UTC(2026, 9, 30, 22);
const backend = {
  kind: 'nas-s3' as const,
  uid: 'nas',
  configurationSha256: 'a'.repeat(64),
  protocol: 'acknowledged-only-v1' as const,
};
const binding = {
  backend,
  cpuHosts: ['cpu-2', 'cpu-3', 'cpu-4', 'cpu-5'],
  cohortSha256: 'b'.repeat(64),
  nfsSourceSha256: 'c'.repeat(64),
  intervalMs: 60000,
  maxAgeMs: 90000,
};
const nfs = () =>
  binding.cpuHosts.map((hostId) => ({
    version: 1 as const,
    hostId,
    backend,
    cohortSha256: binding.cohortSha256,
    sourceSha256: binding.nfsSourceSha256,
    probeId: 'probe',
    mountIdentitySha256: 'd'.repeat(64),
    writeReadSha256: 'e'.repeat(64),
    originalState: 'joined' as const,
    outcome: 'ready' as const,
    startedAtMs: now - 1000,
    completedAtMs: now - 500,
    expiresAtMs: now + 89000,
  }));
const s3 = () => ({
  version: 1 as const,
  backend,
  owner: 'cpu-2',
  outcome: 'ready' as const,
  startedAtMs: now,
  completedAtMs: now,
  expiresAtMs: now + 90000,
});
it('requires all four actual CPU proofs and ignores a separate GPU failure', () => {
  expect(evaluateUploadStorageAvailability(binding, nfs(), s3(), now)).toEqual({
    available: true,
    reason: null,
  });
  expect(
    evaluateUploadStorageAvailability(
      binding,
      [...nfs(), { ...nfs()[0], hostId: 'gpu-1', outcome: 'failed' }],
      s3(),
      now,
    ),
  ).toEqual({ available: true, reason: null });
  expect(evaluateUploadStorageAvailability(binding, nfs().slice(1), s3(), now).available).toBe(
    false,
  );
  expect(
    evaluateUploadStorageAvailability(binding, [...nfs(), nfs()[0]], s3(), now).available,
  ).toBe(false);
  expect(
    evaluateUploadStorageAvailability(
      binding,
      [...nfs(), { ...nfs()[0], writeReadSha256: 'invalid' }],
      s3(),
      now,
    ).available,
  ).toBe(false);
});
it.each(binding.cpuHosts)(
  'closes globally for required %s failure or unjoined original',
  (host) => {
    for (const change of [
      { outcome: 'failed' },
      { outcome: 'unknown' },
      { originalState: 'unresolved' },
      { writeReadSha256: null },
    ]) {
      const reports = nfs().map((r) => (r.hostId === host ? { ...r, ...change } : r));
      expect(evaluateUploadStorageAvailability(binding, reports, s3(), now)).toEqual({
        available: false,
        reason: 'storage-unavailable',
      });
    }
  },
);
it('does not renew source time or accept another configuration/cohort/owner', () => {
  expect(evaluateUploadStorageAvailability(binding, nfs(), s3(), now + 89000)).toEqual({
    available: false,
    reason: 'storage-stale',
  });
  for (const change of [
    { backend: { ...backend, uid: 'other' } },
    { cohortSha256: 'f'.repeat(64) },
    { sourceSha256: 'f'.repeat(64) },
    { startedAtMs: now + 1 },
    { expiresAtMs: now + 91000 },
  ]) {
    expect(
      evaluateUploadStorageAvailability(
        binding,
        nfs().map((r, i) => (i ? r : { ...r, ...change })),
        s3(),
        now,
      ).available,
    ).toBe(false);
  }
  expect(
    evaluateUploadStorageAvailability(binding, nfs(), { ...s3(), owner: 'gpu-1' }, now).available,
  ).toBe(false);
  expect(
    evaluateUploadStorageAvailability(binding, nfs(), { ...s3(), outcome: 'unknown' }, now)
      .available,
  ).toBe(false);
});
it('rejects hostile descriptors without evaluating them and binds fixed settings', () => {
  const get = jest.fn(() => {
    throw Error('must not run');
  });
  const report = Object.defineProperty({ ...nfs()[0] }, 'probeId', { get, enumerable: true });
  expect(readUploadNfsWriteProof(report)).toBeNull();
  const hosts = Object.defineProperty([...binding.cpuHosts], '0', { get, enumerable: true });
  expect(readUploadStorageHealthBinding({ ...binding, cpuHosts: hosts })).toBeNull();
  expect(get).not.toHaveBeenCalled();
  expect(readUploadStorageHealthBinding({ ...binding, maxAgeMs: 120000 })).toBeNull();
});
it('normalizes only safe public status and upgrades genuinely legacy feature flags', () => {
  expect(readUploadStorageAvailability({ available: true, reason: null })).toEqual({
    available: true,
    reason: null,
  });
  expect(
    readUploadStorageAvailability({ available: true, reason: null, host: 'private' }),
  ).toBeNull();
  expect(readManagedUploadFeatureCapability({ enabled: true, eligible: true })).toEqual({
    enabled: true,
    eligible: true,
    storageAvailabilityRequired: false,
  });
  expect(
    readManagedUploadFeatureCapability({
      enabled: true,
      eligible: true,
      storageAvailabilityRequired: true,
    })?.storageAvailabilityRequired,
  ).toBe(true);
  for (const storageAvailabilityRequired of [undefined, null, 'false', 0])
    expect(
      readManagedUploadFeatureCapability({
        enabled: true,
        eligible: true,
        storageAvailabilityRequired,
      }),
    ).toBeNull();
});
