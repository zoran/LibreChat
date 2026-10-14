import { performance } from 'node:perf_hooks';
import type {
  ManagedUploadSnapshot,
  UploadControllerLease,
  UploadMetricsSnapshot,
  UploadWorker,
} from 'librechat-data-provider';
import type {
  UploadClock,
  UploadControlInput,
  UploadControlDecision,
  UploadResourceKey,
  UploadResourceSnapshot,
} from './control';
import type { UploadRepository } from './contract';
import { advanceUploadController, createUploadControllerState } from './control';

type UploadStatus = Pick<ManagedUploadSnapshot, 'throttled' | 'waitingReason'>;
export interface UploadRuntimeOptions {
  ownerId: string;
  repository: Pick<
    UploadRepository,
    'claimController' | 'renewController' | 'publishControl' | 'activeWorkers' | 'metrics'
  >;
  expected: readonly UploadResourceKey[];
  snapshots: { refresh(): Promise<void>; current(): readonly UploadResourceSnapshot[] };
  /** Fresh independent backend safety; active membership is supplied for inventory checks.
   * Every worker separately enforces its own filesystem/cgroup guards on claim and renewal. */
  hardGuards(workers: readonly UploadWorker[]): Promise<UploadControlInput['hardGuards']>;
  clock?: () => UploadClock;
  observe?: (
    event:
      | { kind: 'metrics'; snapshot: UploadMetricsSnapshot }
      | { kind: 'control'; decision: UploadControlDecision }
      | { kind: 'unavailable' },
  ) => void;
}

/** One explicit controller timer; processing and File cleanup retain their existing owners. */
export function createUploadRuntime(options: UploadRuntimeOptions): UploadRuntime {
  if (
    !options.ownerId ||
    options.ownerId.length > 128 ||
    !options.expected.length ||
    options.expected.length > 64
  ) {
    throw new Error('invalid_upload_runtime');
  }
  const clock = options.clock ?? (() => ({ nowMs: Date.now(), monotonicMs: performance.now() }));
  const coveredHosts = new Set(options.expected.map((key) => key.node));
  let state = createUploadControllerState(clock());
  let lease: UploadControllerLease | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let flight: Promise<void> | undefined;
  let stopped = false;
  let lastTick = -Infinity;
  let lastRefresh = -Infinity;
  let lastClock: UploadClock | undefined;
  let cached: { snapshot: UploadMetricsSnapshot; at: UploadClock } | undefined;
  const observe = (event: Parameters<NonNullable<UploadRuntimeOptions['observe']>>[0]) => {
    try {
      options.observe?.(event);
    } catch {
      /* Metrics cannot grant or revoke authority. */
    }
  };
  const lose = () => {
    lease = undefined;
    state = createUploadControllerState(clock());
  };
  const clockValid = (now: UploadClock, prior?: UploadClock) =>
    Number.isSafeInteger(now.nowMs) &&
    Number.isFinite(now.monotonicMs) &&
    (!prior ||
      (now.nowMs >= prior.nowMs &&
        now.monotonicMs >= prior.monotonicMs &&
        Math.abs(now.nowMs - prior.nowMs - (now.monotonicMs - prior.monotonicMs)) <= 5000));

  async function control(at: UploadClock) {
    if (lease && Date.parse(lease.expiresAt) <= at.nowMs) lose();
    if (lease) {
      const renewed = await options.repository.renewController({ lease, now: at.nowMs });
      if (!renewed) {
        lose();
        return;
      }
      lease = renewed;
    } else {
      const acquired = await options.repository.claimController({
        ownerId: options.ownerId,
        now: at.nowMs,
      });
      if (!acquired) return;
      lease = acquired;
      state = createUploadControllerState(at);
      lastRefresh = -Infinity;
    }
    if (stopped) return;
    if (at.monotonicMs - lastRefresh >= 30_000) {
      lastRefresh = at.monotonicMs;
      try {
        await options.snapshots.refresh();
      } catch {
        /* Source deadlines remain unchanged. */
      }
    }
    if (stopped) return;
    let guards: UploadControlInput['hardGuards'] = { safe: false, durability: 'unknown' };
    try {
      const workers = await options.repository.activeWorkers();
      guards = await options.hardGuards(workers);
      if (workers.some((worker) => !coveredHosts.has(worker.hostId)))
        guards = { ...guards, safe: false };
    } catch {
      /* Unknown active membership or safety stops new writes. */
    }
    const evaluatedAt = clock();
    if (
      stopped ||
      !lease ||
      !clockValid(evaluatedAt, at) ||
      Date.parse(lease.expiresAt) <= evaluatedAt.nowMs
    ) {
      lose();
      return;
    }
    const next = advanceUploadController(state, {
      ...evaluatedAt,
      expected: options.expected,
      snapshots: options.snapshots.current(),
      hardGuards: guards,
    });
    const published = await options.repository.publishControl({
      lease,
      now: evaluatedAt.nowMs,
      mode: next.decision.mode,
      limits: next.decision.limits,
      sourceExpiresAt: next.decision.sourceExpiresAtMs,
    });
    if (!published) {
      lose();
      return;
    }
    state = next.state;
    observe({ kind: 'control', decision: next.decision });
  }

  async function run() {
    const at = clock();
    if (!clockValid(at, lastClock)) {
      lose();
      cached = undefined;
      observe({ kind: 'unavailable' });
      return;
    }
    if (at.monotonicMs - lastTick < 10_000) return;
    lastTick = at.monotonicMs;
    lastClock = at;
    try {
      await control(at);
    } catch {
      lose();
      observe({ kind: 'unavailable' });
    }
    if (stopped) return;
    try {
      const snapshot = await options.repository.metrics(clock().nowMs);
      const received = clock();
      if (!clockValid(received, at)) throw new Error('invalid_upload_metrics_clock');
      // Copy the private global policy so later adapter mutation cannot restamp this receipt.
      cached = {
        snapshot: {
          ...snapshot,
          control: { ...snapshot.control, limits: { ...snapshot.control.limits } },
        },
        at: received,
      };
      observe({ kind: 'metrics', snapshot: cached.snapshot });
    } catch {
      cached = undefined;
      observe({ kind: 'unavailable' });
    }
  }

  function tick(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (flight) return flight;
    flight = run().finally(() => {
      flight = undefined;
    });
    return flight;
  }
  function status(): UploadStatus {
    const at = clock();
    if (
      stopped ||
      !cached ||
      !clockValid(at, cached.at) ||
      at.monotonicMs - cached.at.monotonicMs >= 15_000
    ) {
      return { throttled: true, waitingReason: 'unavailable' };
    }
    const policy = cached.snapshot.control;
    if (
      !policy.enabled ||
      policy.mode === 'blocked' ||
      Object.values(policy.limits).some((value) => !Number.isSafeInteger(value) || value <= 0)
    ) {
      return { throttled: true, waitingReason: 'unavailable' };
    }
    const throttled =
      policy.mode !== 'normal' ||
      policy.sourceExpiresAt <= at.nowMs ||
      policy.leaseExpiresAt <= at.nowMs ||
      policy.limits.transferPermits < 6 ||
      policy.limits.processingPermits < 3 ||
      policy.limits.transferBytesPerSecond < 8 * 1048576;
    return { throttled, waitingReason: throttled ? 'capacity' : null };
  }
  return {
    tick,
    status,
    start() {
      if (stopped) throw new Error('closed_upload_runtime');
      if (timer) return;
      timer = setInterval(() => {
        void tick();
      }, 10_000);
      timer.unref?.();
      void tick();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await flight;
      lose();
      cached = undefined;
    },
  };
}

export interface UploadRuntime {
  tick(): Promise<void>;
  status(): UploadStatus;
  start(): void;
  stop(): Promise<void>;
}
