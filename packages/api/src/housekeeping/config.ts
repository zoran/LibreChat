/** One reviewed local policy. Placement, credentials and domain eligibility belong to composition. */
import type { WorkerIdentity } from '@librechat/data-schemas';

export const HOUSEKEEPING_POLICY: Readonly<{
  concurrency: 1;
  candidatePage: 32;
  queryMs: 3000;
  leaseMs: 90000;
  heartbeatMs: 20000;
  stepMs: 45000;
  acknowledgementMs: 10000;
  drainMs: 120000;
  closeReserveMs: 15000;
  pollMs: 1000;
}> = Object.freeze({
  concurrency: 1,
  candidatePage: 32,
  queryMs: 3_000,
  leaseMs: 90_000,
  heartbeatMs: 20_000,
  stepMs: 45_000,
  acknowledgementMs: 10_000,
  drainMs: 120_000,
  closeReserveMs: 15_000,
  pollMs: 1_000,
});

/** A validated identity is still not placement proof; composition binds Pod UID to admitted inventory. */
export function housekeepingIdentity(value: WorkerIdentity): WorkerIdentity {
  if (
    !value ||
    typeof value.podUid !== 'string' ||
    typeof value.incarnation !== 'string' ||
    typeof value.source !== 'string' ||
    typeof value.hostId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.podUid) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value.incarnation,
    ) ||
    !/^[a-f0-9]{40}$/.test(value.source) ||
    !/^[A-Za-z0-9_.:-]{1,256}$/.test(value.hostId)
  ) {
    throw new Error('Invalid Housekeeping worker identity');
  }
  return Object.freeze({
    podUid: value.podUid,
    incarnation: value.incarnation,
    source: value.source,
    hostId: value.hostId,
  });
}
