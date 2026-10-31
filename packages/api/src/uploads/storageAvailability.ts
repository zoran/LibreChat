/** storageAvailability owns one source-bound NFS/S3 snapshot, admission gate and joined lifecycle. */
import { performance } from 'node:perf_hooks';
import {
  evaluateUploadStorageAvailability,
  readUploadStorageHealthBinding,
  readUploadNfsWriteProof,
  readUploadS3HealthProof,
} from 'librechat-data-provider';
import type {
  UploadStorageHealthBinding,
  UploadStorageAvailability,
  UploadS3HealthProof,
} from 'librechat-data-provider';
import type { ManagedUploadFeatureCapability } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { NasS3HealthProbe, NasS3HealthContext } from '../storage/nas/health';
import type { UploadDurability } from './platform/backend';
import type { ResourcePort } from './contract';
import { UploadManagementError } from './errors';

/** Both startup branches expose only this feature bit from the actual private application config. */
export function managedUploadStartupCapability(
  config: Pick<AppConfig, 'managedUploads'> | undefined,
  feature: { enabled: boolean; eligible: boolean },
): ManagedUploadFeatureCapability {
  return {
    ...feature,
    storageAvailabilityRequired: config?.managedUploads?.storage?.kind === 'nas-s3',
  };
}

/** Injected only by the trusted normal collector composition, never request or SSE payloads. */
export interface UploadStorageAvailabilityOptions {
  binding: UploadStorageHealthBinding;
  readNfs(context: NasS3HealthContext): Promise<readonly unknown[]>;
  probeS3: NasS3HealthProbe;
  clock?: () => { nowMs: number; monotonicMs: number };
}
export interface UploadStorageAvailabilityOwner {
  tick(): Promise<void>;
  status(): UploadStorageAvailability;
  assertSafe(): void;
  matchesHosts(hosts: readonly string[]): boolean;
  durability(): UploadDurability;
  protect(resources: ResourcePort): ResourcePort;
  start(): void;
  stop(): Promise<void>;
}

/** Missing/expired evidence closes storage only; no manual policy, quota or security mutation. */
export function createUploadStorageAvailability(
  options: UploadStorageAvailabilityOptions,
): UploadStorageAvailabilityOwner {
  const parsedBinding = readUploadStorageHealthBinding(options.binding);
  if (
    !parsedBinding ||
    typeof options.readNfs !== 'function' ||
    typeof options.probeS3 !== 'function'
  )
    throw new Error('invalid_storage_health_binding');
  const binding: UploadStorageHealthBinding = parsedBinding;
  const readNfs = options.readNfs,
    probeS3 = options.probeS3;
  const clock = options.clock ?? (() => ({ nowMs: Date.now(), monotonicMs: performance.now() }));
  let sample:
    | { nfs: readonly unknown[]; s3: UploadS3HealthProof; at: ReturnType<typeof clock> }
    | undefined;
  let flight: Promise<void> | undefined, active: AbortController | undefined;
  let timer: ReturnType<typeof setInterval> | undefined,
    deadline: ReturnType<typeof setTimeout> | undefined;
  let closed = false,
    lastStart = -Infinity;
  const unknown = (): UploadStorageAvailability => ({
    available: false,
    reason: 'storage-unavailable',
  });
  let lastFailure = unknown();
  function status(): UploadStorageAvailability {
    if (closed) return unknown();
    if (!sample) return { ...lastFailure };
    const now = clock();
    if (
      !Number.isSafeInteger(now.nowMs) ||
      !Number.isFinite(now.monotonicMs) ||
      now.nowMs < sample.at.nowMs ||
      now.monotonicMs < sample.at.monotonicMs ||
      Math.abs(now.nowMs - sample.at.nowMs - (now.monotonicMs - sample.at.monotonicMs)) > 1000
    ) {
      sample = undefined;
      lastFailure = unknown();
      return unknown();
    }
    return evaluateUploadStorageAvailability(binding!, sample.nfs, sample.s3, now.nowMs);
  }
  function assertSafe(): void {
    const value = status();
    if (!value.available)
      throw new UploadManagementError(
        value.reason === 'storage-stale' ? 'storage_stale' : 'storage_unavailable',
      );
  }
  function tick(): Promise<void> {
    if (closed) return Promise.resolve();
    if (flight) return flight;
    const at = clock();
    if (at.monotonicMs - lastStart < binding!.intervalMs) return Promise.resolve();
    if (
      !Number.isSafeInteger(at.nowMs) ||
      at.nowMs < 0 ||
      at.nowMs > 8640000000000000 - 90000 ||
      !Number.isFinite(at.monotonicMs) ||
      at.monotonicMs < 0
    ) {
      sample = undefined;
      return Promise.resolve();
    }
    lastStart = at.monotonicMs;
    active = new AbortController();
    const context = {
      signal: active.signal,
      startedAtMs: at.nowMs,
      deadlineAtMs: at.nowMs + 15000,
      maxAgeMs: binding!.maxAgeMs,
    };
    deadline = setTimeout(() => {
      sample = undefined;
      lastFailure = unknown();
      active?.abort();
    }, 15000);
    deadline.unref?.();
    flight = (async () => {
      const invalidate = () => {
        sample = undefined;
        lastFailure = unknown();
      };
      const nfs = Promise.resolve()
        .then(() => readNfs(context))
        .then((value) => {
          if (
            sample &&
            !evaluateUploadStorageAvailability(binding, value, sample.s3, clock().nowMs).available
          )
            invalidate();
          return value;
        })
        .catch((e) => {
          invalidate();
          throw e;
        });
      const s3 = Promise.resolve()
        .then(() => probeS3(context))
        .then((value) => {
          if (value.outcome !== 'ready') invalidate();
          return value;
        })
        .catch((e) => {
          invalidate();
          throw e;
        });
      const [a, b] = await Promise.allSettled([nfs, s3]);
      const done = clock();
      if (
        closed ||
        context.signal.aborted ||
        done.nowMs >= context.deadlineAtMs ||
        done.nowMs < at.nowMs ||
        done.monotonicMs < at.monotonicMs ||
        Math.abs(done.nowMs - at.nowMs - (done.monotonicMs - at.monotonicMs)) > 1000 ||
        a.status !== 'fulfilled' ||
        b.status !== 'fulfilled'
      ) {
        invalidate();
        return;
      }
      const value = evaluateUploadStorageAvailability(binding!, a.value, b.value, done.nowMs);
      lastFailure = value.available ? unknown() : value;
      sample = value.available
        ? {
            nfs: a.value.map(readUploadNfsWriteProof).filter((r) => r !== null),
            s3: readUploadS3HealthProof(b.value)!,
            at,
          }
        : undefined;
    })()
      .catch(() => {
        sample = undefined;
        lastFailure = unknown();
      })
      .finally(() => {
        clearTimeout(deadline);
        deadline = undefined;
        active = undefined;
        flight = undefined;
      });
    return flight;
  }
  return {
    tick,
    status,
    assertSafe,
    /** Composition must bind this actual four-host storage cohort to its resource collectors. */
    matchesHosts(hosts: readonly string[]): boolean {
      return (
        hosts.length === 4 &&
        [...hosts].sort().join('\0') === [...binding.cpuHosts].sort().join('\0')
      );
    },
    /** Existing resource guard consumes the same source deadlines, never a renewed health lease. */
    durability(): UploadDurability {
      if (!sample || !status().available)
        return { state: 'unknown', observedAtMs: 0, expiresAtMs: 0, expiresMonotonicMs: 0 };
      const rows = [
        ...sample.nfs.map(readUploadNfsWriteProof).filter((r) => r !== null),
        sample.s3,
      ];
      const observedAtMs = Math.min(...rows.map((r) => r.startedAtMs));
      const expiresAtMs = Math.min(...rows.map((r) => r.expiresAtMs));
      return {
        state: 'safe',
        observedAtMs,
        expiresAtMs,
        expiresMonotonicMs: sample.at.monotonicMs + expiresAtMs - sample.at.nowMs,
      };
    },
    protect(resources: ResourcePort): ResourcePort {
      return {
        async assertSafe(input) {
          assertSafe();
          await resources.assertSafe(input);
          assertSafe();
        },
      };
    },
    start(): void {
      if (closed || timer) return;
      timer = setInterval(() => {
        void tick();
      }, binding.intervalMs);
      timer.unref?.();
      void tick();
    },
    async stop(): Promise<void> {
      closed = true;
      clearInterval(timer);
      timer = undefined;
      clearTimeout(deadline);
      active?.abort();
      await flight;
      sample = undefined;
    },
  };
}
