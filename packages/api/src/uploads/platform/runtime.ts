/** Current Pod composition. Durable ownership, parser execution and advisory policy stay separate. */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { UploadLease, UploadLocalReservations, UploadWorker } from 'librechat-data-provider';
import type {
  UploadClock,
  UploadHardGuards,
  UploadResourceKey,
  UploadResourceSnapshot,
} from '../control/types';
import type { UploadBackendCapture } from '../../storage/providerObservation';
import type { UploadSnapshotOptions } from '../control/snapshotClient';
import type { UploadBackendObservation } from '../metrics/metrics';
import type { ResourcePort, UploadRepository } from '../contract';
import type { UploadLocalResources } from '../control/hardGuards';
import type { UploadBackendBinding } from './backend';
import {
  createUploadLocalSampler,
  measureUploadMemory,
  uploadLocalReservation,
  LOCAL_POOL_BYTES,
  LOCAL_FLOOR_BYTES,
} from './local';
import { createUploadParserResourceClient, parserResourcesSafe } from './parserResources';
import { immutableUploadBackendBinding } from '../../storage/providerObservation';
import { createUploadSnapshotClient } from '../control/snapshotClient';
import { createUploadResourcePort } from '../control/hardGuards';
import { createUploadBackendClient } from './backendClient';
import { UploadManagementError } from '../errors';

export interface UploadPlatformMetrics {
  observeResources(input: { resources: UploadLocalResources; observedAtMs: number }): void;
  observeLocal(input: {
    pool: 'staging' | 'parser';
    usedBytes: number;
    reservedBytes: number;
    capacityBytes: number;
    freeBytes: number;
    freeInodes: number;
    observedAtMs: number;
  }): void;
  observeRefresh(input: { outcome: 'ok' | 'partial' | 'failed'; durationSeconds: number }): void;
  observeBackend(input: UploadBackendObservation): void;
  observeBackendService(input: {
    outcome: 'success' | 'error';
    durationSeconds: number;
    observedAtMs: number;
  }): void;
}
export interface UploadPlatformRuntime {
  resources: ResourcePort;
  snapshots: { refresh(): Promise<void>; current(): readonly UploadResourceSnapshot[] };
  expected: readonly UploadResourceKey[];
  hardGuards(workers: readonly UploadWorker[]): Promise<UploadHardGuards>;
  readonly metrics: UploadPlatformMetrics | undefined;
  bindMetrics(metrics: UploadPlatformMetrics): void;
  start(): Promise<void>;
  close(): Promise<void>;
  readStorageBackend(): UploadBackendCapture | undefined;
}
export interface UploadPlatformRuntimeOptions {
  repository: Pick<UploadRepository, 'localReservations'>;
  worker: UploadWorker;
  stagingRoot: string;
  parserSocketPath: string;
  expectedHosts: readonly string[];
  collectors?: UploadSnapshotOptions['collectors'];
  tls?: UploadSnapshotOptions['tls'];
  backendBinding?: UploadBackendBinding;
  backendCa?: string | Buffer;
  cgroupDirectory?: string;
  clock?: () => UploadClock;
}

export function createUploadPlatformRuntime(
  options: UploadPlatformRuntimeOptions,
): UploadPlatformRuntime {
  if (
    options.expectedHosts.length !== 4 ||
    new Set(options.expectedHosts).size !== 4 ||
    options.expectedHosts.some((host) => !/^[a-zA-Z0-9_.-]{1,80}$/.test(host)) ||
    !options.expectedHosts.includes(options.worker.hostId) ||
    !options.worker.instanceId ||
    options.worker.instanceId.length > 128
  ) {
    throw new Error('invalid_upload_platform_identity');
  }
  const binding =
    options.backendBinding === undefined
      ? undefined
      : immutableUploadBackendBinding(options.backendBinding, options.expectedHosts);
  const backendCapture = binding && Object.freeze({ instanceId: randomUUID(), binding });
  const clock = options.clock ?? (() => ({ nowMs: Date.now(), monotonicMs: performance.now() }));
  const expected: UploadResourceKey[] = options.expectedHosts.flatMap((node) =>
    (['cpu', 'cpu_psi', 'memory_psi', 'io_psi', 'memory', 'nic'] as const).map((signal) => ({
      node,
      pool: 'host',
      signal,
    })),
  );
  expected.push(
    { node: 'application', pool: 'working', signal: 'temp' },
    { node: 'application', pool: 'backend', signal: 'latency' },
  );
  let metrics: UploadPlatformMetrics | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let metricsFlight: Promise<void> | undefined;
  let journalFlight: Promise<UploadLocalReservations> | undefined;
  let closed = false;
  const disk = createUploadLocalSampler({ root: options.stagingRoot, clock });
  const parser = createUploadParserResourceClient({ socketPath: options.parserSocketPath, clock });
  const backend = createUploadBackendClient({
    binding,
    ca: options.backendCa ?? '',
    clock,
  });
  const observe = (callback: (value: UploadPlatformMetrics) => void): void => {
    try {
      if (metrics) callback(metrics);
    } catch {
      /* Diagnostics grant no resource authority. */
    }
  };
  const snapshots =
    options.collectors && options.tls
      ? createUploadSnapshotClient({
          collectors: options.collectors,
          tls: options.tls,
          expected,
          clock,
          observeRefresh: (input) => observe((value) => value.observeRefresh(input)),
        })
      : {
          refresh: async (): Promise<void> => undefined,
          current: (): UploadResourceSnapshot[] => [],
        };

  async function journal(): Promise<UploadLocalReservations> {
    if (!journalFlight)
      journalFlight = options.repository
        .localReservations(options.worker, clock().nowMs)
        .finally(() => {
          journalFlight = undefined;
        });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    return await Promise.race([
      journalFlight,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new UploadManagementError('unavailable')), 3_000);
        timeout.unref();
      }),
    ]).finally(() => clearTimeout(timeout));
  }
  const reservations = async (
    phase: 'admission' | 'transfer' | 'processing',
    lease?: UploadLease,
  ) => {
    const held = await journal();
    const measured = disk.current();
    if (!measured || closed) throw new UploadManagementError('unavailable');
    return {
      ...uploadLocalReservation({
        worker: options.worker,
        journal: held,
        disk: measured,
        phase,
        lease,
        clock: clock(),
      }),
      observedAtMs: Math.min(held.observedAt, measured.observedAtMs),
    };
  };
  const local = createUploadResourcePort({
    cgroupDirectory: options.cgroupDirectory ?? '/sys/fs/cgroup',
    mounts: [
      {
        slot: 'staging',
        path: options.stagingRoot,
        capacityBytes: LOCAL_POOL_BYTES,
        floorBytes: LOCAL_FLOOR_BYTES,
      },
    ],
    reservations,
    durability: async () => backend.current(),
    clock,
    observeResources: (input) => observe((value) => value.observeResources(input)),
  });
  async function publishLocal(): Promise<void> {
    if (closed || metricsFlight) return;
    const started = clock();
    metricsFlight = (async () => {
      const [heldResult, memoryResult] = await Promise.allSettled([
        journal(),
        measureUploadMemory(options.cgroupDirectory ?? '/sys/fs/cgroup'),
      ]);
      if (heldResult.status !== 'fulfilled' || memoryResult.status !== 'fulfilled') return;
      const held = heldResult.value;
      const memory = memoryResult.value;
      const measured = disk.current();
      const parserState = parser.current();
      const finished = clock();
      if (
        !measured ||
        closed ||
        finished.monotonicMs - started.monotonicMs >= 3_000 ||
        finished.monotonicMs < started.monotonicMs ||
        finished.nowMs < started.nowMs ||
        Math.abs(finished.nowMs - started.nowMs - (finished.monotonicMs - started.monotonicMs)) >
          1_000
      )
        return;
      // Metrics include current holdings only; prospective admission allowances are excluded below.
      const allowance = uploadLocalReservation({
        worker: options.worker,
        journal: held,
        disk: measured,
        phase: 'admission',
        clock: clock(),
      });
      const reserved = allowance.mounts.staging;
      observe((value) =>
        value.observeResources({
          observedAtMs: Math.min(started.nowMs, held.observedAt, measured.observedAtMs),
          resources: {
            memory: {
              ...memory,
              reservedBytes:
                held.counts.transfer * 2 * 1048576 + held.counts.processing * 64 * 1048576,
            },
            mounts: [
              {
                slot: 'staging',
                ...reserved,
                requiredBytes: 0,
                capacityBytes: LOCAL_POOL_BYTES,
                floorBytes: LOCAL_FLOOR_BYTES,
                freeBytes: measured.freeBytes,
                freeInodes: measured.freeInodes,
              },
            ],
          },
        }),
      );
      if (parserState)
        observe((value) =>
          value.observeLocal({
            pool: 'parser',
            ...parserState.scratch,
            observedAtMs: parserState.observedAtMs,
          }),
        );
    })()
      .catch(() => {
        /* Preserve old metric source times on measurement failure. */
      })
      .finally(() => {
        metricsFlight = undefined;
      });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      metricsFlight,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 3_000);
        timeout.unref();
      }),
    ]).finally(() => clearTimeout(timeout));
  }
  return {
    readStorageBackend: () => (closed ? undefined : backendCapture),
    expected,
    snapshots,
    resources: {
      async assertSafe(input): Promise<void> {
        const state = parser.current();
        if (
          closed ||
          !state ||
          !parserResourcesSafe(state, input.phase === 'processing' && !input.lease)
        ) {
          throw new UploadManagementError('unavailable');
        }
        await local.assertSafe(input);
      },
    },
    async hardGuards(workers): Promise<UploadHardGuards> {
      return {
        safe:
          !closed &&
          workers.length <= 9 &&
          workers.every(
            (worker) =>
              options.expectedHosts.includes(worker.hostId) &&
              typeof worker.instanceId === 'string' &&
              worker.instanceId.length > 0 &&
              worker.instanceId.length <= 128,
          ),
        durability: closed ? 'unknown' : backend.current().state,
      };
    },
    get metrics(): UploadPlatformMetrics | undefined {
      return metrics;
    },
    bindMetrics(value): void {
      metrics = value;
    },
    async start(): Promise<void> {
      if (closed || timer) return;
      await Promise.all([disk.start(), parser.start(), backend.start()]);
      await publishLocal();
      if (!closed && !timer) {
        timer = setInterval(() => {
          void publishLocal();
        }, 5_000);
        timer.unref();
      }
    },
    async close(): Promise<void> {
      closed = true;
      clearInterval(timer);
      disk.close();
      await Promise.all([parser.close(), backend.close()]);
    },
  };
}
