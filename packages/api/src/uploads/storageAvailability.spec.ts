/** storageAvailability.spec tests real admission, source clocks and joining one original flight. */
import type { AppConfig } from '@librechat/data-schemas';
import type { UploadManagementDependencies } from './management';
import {
  healthNow,
  healthBinding,
  nfsHealthFixture,
  s3HealthFixture,
} from './storageAvailability.helper';
import {
  createUploadStorageAvailability,
  managedUploadStartupCapability,
} from './storageAvailability';
import { createUploadManagement } from './management';
import { UploadManagementError } from './errors';
const principal = { tenantId: 'tenant', userId: 'user', authentication: 'verified-email' as const };
function fixture() {
  let now = healthNow,
    mono = 1000;
  const readNfs = jest.fn(async () => nfsHealthFixture());
  const probeS3 = jest.fn(async () => s3HealthFixture());
  const owner = createUploadStorageAvailability({
    binding: healthBinding,
    readNfs,
    probeS3,
    clock: () => ({ nowMs: now, monotonicMs: mono }),
  });
  return {
    owner,
    readNfs,
    probeS3,
    advance(ms: number) {
      now += ms;
      mono += ms;
    },
    rollback() {
      now--;
    },
  };
}
it('boots unavailable, joins actual healthy ports and never renews report deadlines on refresh', async () => {
  const f = fixture();
  expect(f.owner.status()).toEqual({ available: false, reason: 'storage-unavailable' });
  await f.owner.tick();
  expect(f.owner.status().available).toBe(true);
  const expires = f.owner.durability().expiresAtMs;
  f.advance(60000);
  await f.owner.tick();
  expect(f.owner.durability().expiresAtMs).toBe(expires);
  f.advance(30000);
  expect(f.owner.status()).toEqual({ available: false, reason: 'storage-stale' });
  await f.owner.stop();
});
it('keeps manual pause and other repository denials after storage alone recovers', async () => {
  const f = fixture();
  const reserve = jest.fn(async () => {
    throw new UploadManagementError('admission_paused');
  });
  const resources = { assertSafe: jest.fn(async () => undefined) };
  const management = createUploadManagement({
    repository: { reserve, findReservation: async () => null },
    resources: f.owner.protect(resources),
    identity: { authorize: async () => true },
  } as unknown as UploadManagementDependencies);
  const request = {
    mediaType: 'text/plain',
    declaredBytes: 5,
    idempotencyKey: '11111111-1111-4111-8111-111111111111',
    scope: { kind: 'personal' as const },
  };
  await expect(management.reserve(principal, request)).rejects.toMatchObject({
    code: 'storage_unavailable',
  });
  expect(reserve).not.toHaveBeenCalled();
  await f.owner.tick();
  await expect(management.reserve(principal, request)).rejects.toMatchObject({
    code: 'admission_paused',
  });
  expect(reserve).toHaveBeenCalledTimes(1);
  f.advance(90000);
  await expect(management.assertAdmissionSafe()).rejects.toMatchObject({ code: 'storage_stale' });
  await expect(
    management.claimWorkBytes({ kind: 'transfer', hostId: 'cpu-2' } as never, 4096),
  ).rejects.toMatchObject({ code: 'storage_stale' });
  await f.owner.stop();
});
it('checks current source after an awaited local guard and rejects another configured cohort', async () => {
  const f = fixture();
  await f.owner.tick();
  expect(f.owner.matchesHosts(['cpu-5', 'cpu-4', 'cpu-3', 'cpu-2'])).toBe(true);
  expect(f.owner.matchesHosts(['gpu-1', 'cpu-4', 'cpu-3', 'cpu-2'])).toBe(false);
  const resources = f.owner.protect({
    assertSafe: async () => {
      f.advance(90000);
    },
  });
  await expect(resources.assertSafe({ phase: 'admission' })).rejects.toMatchObject({
    code: 'storage_stale',
  });
  await f.owner.stop();
});
it('automatically recovers only from a new genuine healthy sample and fails closed on clock rollback', async () => {
  const f = fixture();
  f.readNfs.mockResolvedValueOnce(nfsHealthFixture().map((r) => ({ ...r, outcome: 'unknown' })));
  await f.owner.tick();
  expect(f.owner.status().available).toBe(false);
  f.advance(60000);
  f.readNfs.mockResolvedValue(nfsHealthFixture(healthNow + 60000));
  f.probeS3.mockResolvedValue(s3HealthFixture(healthNow + 60000));
  await f.owner.tick();
  expect(f.owner.status().available).toBe(true);
  f.rollback();
  expect(f.owner.status().available).toBe(false);
  f.advance(1);
  expect(f.owner.status().available).toBe(false);
  await f.owner.stop();
});
it('does not mistake timeout/abort for joining an unresolved NFS original', async () => {
  jest.useFakeTimers();
  const f = fixture();
  await f.owner.tick();
  expect(f.owner.status().available).toBe(true);
  f.advance(60000);
  let release!: (v: ReturnType<typeof nfsHealthFixture>) => void;
  f.readNfs.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const original = f.owner.tick();
  expect(f.owner.tick()).toBe(original);
  await Promise.resolve();
  await Promise.resolve();
  f.advance(15000);
  await jest.advanceTimersByTimeAsync(15000);
  expect(f.owner.status().available).toBe(false);
  let joined = false;
  const stopping = f.owner.stop().then(() => {
    joined = true;
  });
  await Promise.resolve();
  expect(joined).toBe(false);
  expect(f.readNfs).toHaveBeenCalledTimes(2);
  release(nfsHealthFixture());
  await original;
  await stopping;
  expect(joined).toBe(true);
  expect(f.owner.status().available).toBe(false);
  jest.useRealTimers();
});
it('exposes only the selected startup bit and preserves feature/auth eligibility flags', () => {
  const config = { managedUploads: { storage: { kind: 'nas-s3' } } } as Pick<
    AppConfig,
    'managedUploads'
  >;
  expect(managedUploadStartupCapability(config, { enabled: false, eligible: false })).toEqual({
    enabled: false,
    eligible: false,
    storageAvailabilityRequired: true,
  });
  expect(managedUploadStartupCapability(undefined, { enabled: true, eligible: true })).toEqual({
    enabled: true,
    eligible: true,
    storageAvailabilityRequired: false,
  });
});
