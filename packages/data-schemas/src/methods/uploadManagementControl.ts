/** Fenced control and byte leases, composed by the single upload repository owner. */
import type {
  UploadControllerLease,
  UploadControlPolicy,
  UploadLease,
  UploadByteLease,
} from 'librechat-data-provider';
import type { UploadStore, GlobalState, StoredUpload } from './uploadManagementStore';
import {
  assertLease,
  effectiveLimits,
  HARD_LIMITS,
  FALLBACK_LIMITS,
  reject,
} from './uploadManagementStore';

export type UploadControlMethods = {
  claimController(input: { ownerId: string; now: number }): Promise<UploadControllerLease | null>;
  renewController(input: {
    lease: UploadControllerLease;
    now: number;
  }): Promise<UploadControllerLease | null>;
  publishControl(
    input: UploadControlPolicy & { lease: UploadControllerLease; now: number },
  ): Promise<boolean>;
  claimWorkBytes(input: {
    lease: UploadLease;
    requestedBytes: number;
    now: number;
  }): Promise<UploadByteLease | null>;
  completeWorkBytes(input: { lease: UploadLease; generation: number; now: number }): Promise<void>;
};

export function createUploadControlMethods(store: UploadStore): UploadControlMethods {
  function valid(global: GlobalState, lease: UploadControllerLease, now: number): boolean {
    return (
      global.controllerOwner === lease.ownerId &&
      global.controllerGeneration === lease.generation &&
      global.controllerUntil > now
    );
  }
  function project(global: GlobalState): UploadControllerLease {
    return {
      ownerId: global.controllerOwner!,
      generation: global.controllerGeneration,
      expiresAt: new Date(global.controllerUntil).toISOString(),
    };
  }
  return {
    async claimController({ ownerId, now }) {
      if (!ownerId || ownerId.length > 128 || !Number.isSafeInteger(now)) reject('invalid_request');
      return store.transaction(async (_session, global) => {
        if (global.controllerUntil > now) return null;
        global.controllerOwner = ownerId;
        global.controllerGeneration++;
        global.controllerUntil = now + 45_000;
        global.mode = 'fallback';
        global.limits = { ...FALLBACK_LIMITS };
        global.policyUntil = now;
        return project(global);
      });
    },
    async renewController({ lease, now }) {
      return store.transaction(async (_session, global) => {
        if (!valid(global, lease, now)) return null;
        global.controllerUntil = now + 45_000;
        return project(global);
      });
    },
    async publishControl({ lease, now, limits, mode, sourceExpiresAt }) {
      for (const field of Object.keys(HARD_LIMITS) as (keyof typeof HARD_LIMITS)[]) {
        if (
          !Number.isSafeInteger(limits[field]) ||
          limits[field] < 0 ||
          limits[field] > HARD_LIMITS[field]
        )
          reject('invalid_request');
      }
      if (
        !['normal', 'fallback', 'blocked'].includes(mode) ||
        !Number.isSafeInteger(sourceExpiresAt) ||
        (mode === 'normal' && sourceExpiresAt <= now) ||
        sourceExpiresAt > now + 70_000
      )
        reject('invalid_request');
      return store.transaction(async (_session, global) => {
        if (!valid(global, lease, now)) return false;
        global.mode = mode;
        global.limits =
          mode === 'fallback'
            ? {
                transferPermits: Math.min(1, limits.transferPermits),
                processingPermits: Math.min(1, limits.processingPermits),
                transferBytesPerSecond: Math.min(1_048_576, limits.transferBytesPerSecond),
              }
            : { ...limits };
        global.policyUntil = Math.min(sourceExpiresAt, global.controllerUntil);
        return true;
      });
    },
    async claimWorkBytes({ lease, requestedBytes, now }) {
      if (
        !Number.isSafeInteger(requestedBytes) ||
        requestedBytes <= 0 ||
        !Number.isSafeInteger(now)
      )
        reject('invalid_request');
      return store.transaction(async (session, global) => {
        const row = await store.Operation.findById(lease.operationId)
          .session(session)
          .lean<StoredUpload>();
        assertLease(row, lease, now);
        if (row.state !== (lease.kind === 'transfer' ? 'transferring' : 'processing'))
          reject('lease_lost');
        if ((row.byteLeaseUntil ?? 0) > now) return null;
        const limits = effectiveLimits(global, now);
        // Completed grants remain charged for a full second; replicas cannot burst across a clock boundary.
        global.byteGrants = global.byteGrants.filter((grant) => grant.at > now - 1000);
        const host = lease.hostId;
        const used = global.byteGrants.reduce((sum, grant) => sum + grant.bytes, 0);
        const hostUsed = global.byteGrants.reduce(
          (sum, grant) => sum + (grant.host === host ? grant.bytes : 0),
          0,
        );
        const bytes = Math.min(
          requestedBytes,
          256 * 1024,
          limits.transferBytesPerSecond - used,
          4 * 1_048_576 - hostUsed,
        );
        if (bytes <= 0) return null;
        const bucket = global.byteGrants.find((grant) => grant.at === now && grant.host === host);
        if (bucket) bucket.bytes += bytes;
        else if (global.byteGrants.length >= 2048) return null;
        else global.byteGrants.push({ at: now, bytes, host });
        row.byteLeaseUntil = Math.min(now + 1000, row.leaseExpiresAt!);
        row.byteLeaseGeneration = (row.byteLeaseGeneration ?? 0) + 1;
        await store.save(row, session);
        return {
          bytes,
          expiresAt: new Date(row.byteLeaseUntil).toISOString(),
          generation: row.byteLeaseGeneration,
        };
      });
    },
    async completeWorkBytes({ lease, generation, now }) {
      await store.transaction(async (session) => {
        const row = await store.Operation.findById(lease.operationId)
          .session(session)
          .lean<StoredUpload>();
        assertLease(row, lease, now);
        if (row.byteLeaseGeneration !== generation) reject('lease_lost');
        // Acknowledgment permits the next sequential chunk; never refunds this window's grant.
        row.byteLeaseUntil = now;
        await store.save(row, session);
      });
    },
  };
}
