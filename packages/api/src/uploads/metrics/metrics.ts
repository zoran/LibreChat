import { Counter, Gauge, Histogram } from 'prom-client';
import type { UploadMetricsSnapshot, UploadState } from 'librechat-data-provider';
import type { Registry } from 'prom-client';
import type { UploadControlDecision, UploadLocalResources } from '../control';
import type { SourceReplayObservation } from '../../stream';
export interface UploadBackendObservation {
  operation: 'put' | 'read' | 'remove';
  outcome: 'durable' | 'unknown' | 'absent' | 'error';
  durationSeconds: number;
  observedAtMs: number;
}
type Stage = 'wait' | 'transfer' | 'processing' | 'request' | 'total';
type LocalPool = 'staging' | 'parser';
export interface UploadMetricObserver {
  transition(state: UploadState): void;
  observeBackend(input: UploadBackendObservation): void;
  observeBackendService(input: {
    outcome: 'success' | 'error';
    durationSeconds: number;
    observedAtMs: number;
  }): void;
  observeSnapshot(snapshot: UploadMetricsSnapshot): void;
  observeSourceReplay(observation: SourceReplayObservation): void;
  observeQueue(input: {
    stage: 'transfer' | 'processing' | 'all';
    count: number;
    bytes: number;
    oldestSeconds: number;
  }): void;
  observeDuration(input: {
    stage: Stage;
    outcome: 'success' | 'failure' | 'cancelled';
    seconds: number;
  }): void;
  received(count: number): void;
  fileSize(count: number): void;
  retry(reason: 'transport' | 'storage' | 'processing' | 'lease' | 'unavailable'): void;
  observeControl(decision: UploadControlDecision): void;
  observeSourceAge(seconds: number): void;
  observeRefresh(input: { outcome: 'ok' | 'partial' | 'failed'; durationSeconds: number }): void;
  observeLocal(input: {
    pool: LocalPool;
    usedBytes: number;
    reservedBytes: number;
    capacityBytes: number;
    freeBytes: number;
    freeInodes: number;
    observedAtMs: number;
  }): void;
  liveConnections(count: number): void;
  event(event: 'update' | 'heartbeat' | 'closed'): void;
  observeQuota(input: { usedBytes: number; reservedBytes: number; retainedBytes: number }): void;
  rejectQuota(
    reason: 'window' | 'originals' | 'objects' | 'queue' | 'outstanding' | 'capacity',
  ): void;
  observeResources(input: { resources: UploadLocalResources; observedAtMs: number }): void;
}
const states: readonly UploadState[] = [
  'waiting',
  'transferring',
  'queued_processing',
  'processing',
  'ready',
  'failed',
  'cancelled',
  'deleted',
  'expired',
];
const stages: readonly Stage[] = ['wait', 'transfer', 'processing', 'request', 'total'];
const reasons = [
  'startup',
  'healthy',
  'pressure',
  'warming',
  'stale',
  'missing',
  'invalid',
  'hard_guard',
  'durability',
  'hold',
] as const;
const modes = ['normal', 'fallback', 'blocked'] as const;
function finite(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new Error('invalid_upload_metric');
}
function member(value: string, allowed: readonly string[]): void {
  if (!allowed.includes(value)) throw new Error('invalid_upload_metric_label');
}

/** The application passes its existing registry; this module owns no HTTP server or timer. */
export function createUploadMetrics(
  registry: Registry,
  slots: readonly string[],
): { bind(slot: string): UploadMetricObserver } {
  if (
    !slots.length ||
    slots.length > 16 ||
    new Set(slots).size !== slots.length ||
    slots.some((slot) => !/^[a-zA-Z0-9_.-]{1,80}$/.test(slot))
  )
    throw new Error('invalid_upload_metric_slots');
  const registers = [registry];
  const backendDuration = new Histogram({
    name: 'cortex_upload_backend_duration_seconds',
    help: 'Observed storage operation durations; absence is unknown.',
    labelNames: ['slot'],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
    registers,
  });
  const backendOperations = new Counter({
    name: 'cortex_upload_backend_operations_total',
    help: 'Storage outcomes without object or principal identifiers.',
    labelNames: ['slot', 'operation', 'outcome'],
    registers,
  });
  const backendErrors = new Counter({
    name: 'cortex_upload_backend_errors_total',
    help: 'Observed failed or uncertain storage outcomes.',
    labelNames: ['slot'],
    registers,
  });
  const backendObserved = new Gauge({
    name: 'cortex_upload_backend_observed_at_seconds',
    help: 'Wall time of the actual last storage operation, not scrape time.',
    labelNames: ['slot'],
    registers,
  });
  const serviceDuration = new Histogram({
    name: 'cortex_upload_backend_service_duration_seconds',
    help: 'Isolated storage service wait, excluding stream production and consumption.',
    labelNames: ['slot'],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
    registers,
  });
  const serviceErrors = new Counter({
    name: 'cortex_upload_backend_service_errors_total',
    help: 'Actual failed isolated storage service observations.',
    labelNames: ['slot'],
    registers,
  });
  const serviceObserved = new Gauge({
    name: 'cortex_upload_backend_service_observed_at_seconds',
    help: 'Actual isolated service observation time; absent until a genuine source is connected.',
    labelNames: ['slot'],
    registers,
  });
  const transitions = new Counter({
    name: 'cortex_upload_transitions_total',
    help: 'Observed successful lifecycle write responses; idempotent replays can repeat. Not billing authority.',
    labelNames: ['slot', 'state'],
    registers,
  });
  const active = new Gauge({
    name: 'cortex_upload_operations',
    help: 'Current durable operation counts; do not sum replica snapshots.',
    labelNames: ['slot', 'state'],
    registers,
  });
  const bytes = new Gauge({
    name: 'cortex_upload_accounted_bytes',
    help: 'Logical storage accounting; do not sum replica snapshots.',
    labelNames: ['slot', 'pool'],
    registers,
  });
  const cleanup = new Gauge({
    name: 'cortex_upload_cleanup_pending',
    help: 'Durable pending cleanup operations.',
    labelNames: ['slot'],
    registers,
  });
  const stagingHeld = new Gauge({
    name: 'cortex_upload_staging_reserved_bytes',
    help: 'Global held staging reservations, including unresolved cleanup; do not sum replica snapshots.',
    labelNames: ['slot'],
    registers,
  });
  const snapshotObserved = new Gauge({
    name: 'cortex_upload_ledger_observed_at_seconds',
    help: 'Actual source time of the cached durable ledger view.',
    labelNames: ['slot'],
    registers,
  });
  const work = new Gauge({
    name: 'cortex_upload_active_work',
    help: 'Global durable active work, not a sum over replicas.',
    labelNames: ['slot', 'kind'],
    registers,
  });
  const replayHeld = new Gauge({
    name: 'cortex_upload_source_replay_held',
    help: 'Global durable source replay intents, including pending cleanup; do not sum replicas.',
    labelNames: ['slot'],
    registers,
  });
  const replayCleanup = new Gauge({
    name: 'cortex_upload_source_replay_cleanup_pending',
    help: 'Global source replay intents awaiting confirmed cleanup; do not sum replicas.',
    labelNames: ['slot'],
    registers,
  });
  const replayBytes = new Gauge({
    name: 'cortex_upload_source_replay_reserved_bytes',
    help: 'Logical held source replay capacity already included in File accounting; do not add to text totals.',
    labelNames: ['slot'],
    registers,
  });
  const replayObserved = new Gauge({
    name: 'cortex_upload_source_replay_observed_at_seconds',
    help: 'Time of a successful actual source replay census, absent until observed.',
    labelNames: ['slot'],
    registers,
  });
  const replayRejected = new Counter({
    name: 'cortex_upload_source_replay_rejections_total',
    help: 'Source replay admission failures by bounded reason.',
    labelNames: ['slot', 'reason'],
    registers,
  });
  const queue = new Gauge({
    name: 'cortex_upload_queue_operations',
    help: 'Current durable queue length.',
    labelNames: ['slot', 'stage'],
    registers,
  });
  const queueBytes = new Gauge({
    name: 'cortex_upload_queue_bytes',
    help: 'Declared bytes waiting in the durable queue.',
    labelNames: ['slot', 'stage'],
    registers,
  });
  const queueAge = new Gauge({
    name: 'cortex_upload_queue_oldest_seconds',
    help: 'Oldest durable queue wait.',
    labelNames: ['slot', 'stage'],
    registers,
  });
  const duration = new Histogram({
    name: 'cortex_upload_duration_seconds',
    help: 'Observed request and processing attempt durations; total is creation to acknowledged ready publication.',
    labelNames: ['slot', 'stage', 'outcome'],
    buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600],
    registers,
  });
  const received = new Counter({
    name: 'cortex_upload_received_bytes_total',
    help: 'Bytes accepted from upload streams.',
    labelNames: ['slot'],
    registers,
  });
  const sizes = new Histogram({
    name: 'cortex_upload_file_bytes',
    help: 'Original byte sizes at observed durable acceptance; not a durable file census.',
    labelNames: ['slot'],
    buckets: [1024, 65536, 1048576, 6291456, 15728640, 31457280],
    registers,
  });
  const retries = new Counter({
    name: 'cortex_upload_retries_total',
    help: 'Observed acknowledged retry responses; concurrent replays can repeat. Not billing authority.',
    labelNames: ['slot', 'reason'],
    registers,
  });
  const limits = new Gauge({
    name: 'cortex_upload_limits',
    help: 'Hard and current global ceilings (permits or bytes per second by kind).',
    labelNames: ['slot', 'kind', 'limit'],
    registers,
  });
  const control = new Gauge({
    name: 'cortex_upload_controller_state',
    help: 'One-hot state of the authoritative control view.',
    labelNames: ['slot', 'mode'],
    registers,
  });
  const controlChanges = new Counter({
    name: 'cortex_upload_controller_changes_total',
    help: 'Control reason changes.',
    labelNames: ['slot', 'reason'],
    registers,
  });
  const sourceAge = new Gauge({
    name: 'cortex_upload_source_age_seconds',
    help: 'Age of the oldest required raw observation.',
    labelNames: ['slot'],
    registers,
  });
  const refresh = new Histogram({
    name: 'cortex_upload_refresh_duration_seconds',
    help: 'Bounded collector refresh duration.',
    labelNames: ['slot', 'outcome'],
    buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 3],
    registers,
  });
  const occupancy = new Gauge({
    name: 'cortex_upload_temp_occupancy_ratio',
    help: 'Actual used plus reserved local bytes divided by bounded pool capacity.',
    labelNames: ['slot', 'pool'],
    registers,
  });
  const localBytes = new Gauge({
    name: 'cortex_upload_local_bytes',
    help: 'Measured local occupancy, reservation and free space.',
    labelNames: ['slot', 'pool', 'kind'],
    registers,
  });
  const inodes = new Gauge({
    name: 'cortex_upload_local_free_inodes',
    help: 'Measured free inodes on each local working pool.',
    labelNames: ['slot', 'pool'],
    registers,
  });
  const localObserved = new Gauge({
    name: 'cortex_upload_local_observed_at_seconds',
    help: 'Actual statfs/reservation observation time, never scrape time.',
    labelNames: ['slot', 'pool'],
    registers,
  });
  const memoryHeadroom = new Gauge({
    name: 'cortex_upload_cgroup_headroom_bytes',
    help: 'Measured memory limit less current use and reservations.',
    labelNames: ['slot'],
    registers,
  });
  const connections = new Gauge({
    name: 'cortex_upload_live_connections',
    help: 'Current private status stream connections.',
    labelNames: ['slot'],
    registers,
  });
  const events = new Counter({
    name: 'cortex_upload_events_total',
    help: 'Finite status stream events.',
    labelNames: ['slot', 'event'],
    registers,
  });
  const quotaBytes = new Gauge({
    name: 'cortex_upload_quota_bytes',
    help: 'Aggregate rolling quota accounting without principal labels.',
    labelNames: ['slot', 'kind'],
    registers,
  });
  const quotaRejections = new Counter({
    name: 'cortex_upload_quota_rejections_total',
    help: 'Observed rejected requests by known budget category; retries may repeat. Not billing authority.',
    labelNames: ['slot', 'reason'],
    registers,
  });
  const bound = new Map<string, UploadMetricObserver>();
  function bindSlot(slot: string): UploadMetricObserver {
    let previousReason = '';
    // Zero errors is only a counter baseline; observed-at/latency remain absent until real work.
    backendErrors.labels(slot).inc(0);
    serviceErrors.labels(slot).inc(0);
    const observers = {
      transition(state: UploadState): void {
        member(state, states);
        transitions.labels(slot, state).inc();
      },
      observeSourceReplay(observation: SourceReplayObservation): void {
        [observation.held, observation.pendingCleanup, observation.logicalReservedBytes].forEach(
          finite,
        );
        if (observation.rejectedReason)
          member(observation.rejectedReason, ['capacity', 'unavailable', 'unsupported']);
        replayHeld.labels(slot).set(observation.held);
        replayCleanup.labels(slot).set(observation.pendingCleanup);
        replayBytes.labels(slot).set(observation.logicalReservedBytes);
        replayObserved.labels(slot).set(Date.now() / 1000);
        if (observation.rejectedReason)
          replayRejected.labels(slot, observation.rejectedReason).inc();
      },
      observeBackend(input: UploadBackendObservation): void {
        member(input.operation, ['put', 'read', 'remove']);
        member(input.outcome, ['durable', 'unknown', 'absent', 'error']);
        finite(input.durationSeconds);
        finite(input.observedAtMs);
        backendDuration.labels(slot).observe(input.durationSeconds);
        backendOperations.labels(slot, input.operation, input.outcome).inc();
        if (input.outcome === 'unknown' || input.outcome === 'error')
          backendErrors.labels(slot).inc();
        backendObserved.labels(slot).set(input.observedAtMs / 1000);
      },
      observeBackendService(input: {
        outcome: 'success' | 'error';
        durationSeconds: number;
        observedAtMs: number;
      }): void {
        member(input.outcome, ['success', 'error']);
        finite(input.durationSeconds);
        finite(input.observedAtMs);
        serviceDuration.labels(slot).observe(input.durationSeconds);
        if (input.outcome === 'error') serviceErrors.labels(slot).inc();
        serviceObserved.labels(slot).set(input.observedAtMs / 1000);
      },
      observeSnapshot(snapshot: UploadMetricsSnapshot): void {
        Object.entries(snapshot.states).forEach(([state, count]) => {
          member(state, states);
          finite(count!);
        });
        [
          snapshot.originalBytes,
          snapshot.objectBytes,
          snapshot.textBytes,
          snapshot.recordBytes,
          snapshot.cleanupPending,
        ].forEach(finite);
        states.forEach((state) => active.labels(slot, state).set(snapshot.states[state] ?? 0));
        bytes.labels(slot, 'original').set(snapshot.originalBytes);
        bytes.labels(slot, 'object').set(snapshot.objectBytes);
        bytes.labels(slot, 'text').set(snapshot.textBytes);
        bytes.labels(slot, 'records').set(snapshot.recordBytes);
        cleanup.labels(slot).set(snapshot.cleanupPending);
        observers.observeQueue({
          stage: 'all',
          count: snapshot.queue.count,
          bytes: snapshot.queue.bytes,
          oldestSeconds: snapshot.queue.oldestAgeSeconds,
        });
        observers.observeQuota(snapshot.quota);
        [
          snapshot.staging.bytes,
          snapshot.observedAt,
          snapshot.transfers,
          snapshot.processors,
        ].forEach(finite);
        stagingHeld.labels(slot).set(snapshot.staging.bytes);
        snapshotObserved.labels(slot).set(snapshot.observedAt / 1000);
        work.labels(slot, 'transfer').set(snapshot.transfers);
        work.labels(slot, 'processing').set(snapshot.processors);
      },
      observeQueue(input: {
        stage: 'transfer' | 'processing' | 'all';
        count: number;
        bytes: number;
        oldestSeconds: number;
      }): void {
        member(input.stage, ['transfer', 'processing', 'all']);
        [input.count, input.bytes, input.oldestSeconds].forEach(finite);
        queue.labels(slot, input.stage).set(input.count);
        queueBytes.labels(slot, input.stage).set(input.bytes);
        queueAge.labels(slot, input.stage).set(input.oldestSeconds);
      },
      observeDuration(input: {
        stage: Stage;
        outcome: 'success' | 'failure' | 'cancelled';
        seconds: number;
      }): void {
        member(input.stage, stages);
        member(input.outcome, ['success', 'failure', 'cancelled']);
        finite(input.seconds);
        duration.labels(slot, input.stage, input.outcome).observe(input.seconds);
      },
      received(count: number): void {
        finite(count);
        received.labels(slot).inc(count);
      },
      fileSize(count: number): void {
        finite(count);
        sizes.labels(slot).observe(count);
      },
      retry(reason: 'transport' | 'storage' | 'processing' | 'lease' | 'unavailable'): void {
        member(reason, ['transport', 'storage', 'processing', 'lease', 'unavailable']);
        retries.labels(slot, reason).inc();
      },
      observeControl(decision: UploadControlDecision): void {
        member(decision.mode, modes);
        member(decision.reason, reasons);
        Object.values(decision.limits).forEach(finite);
        for (const [kind, current, hard] of [
          ['transfer', decision.limits.transferPermits, 6],
          ['processing', decision.limits.processingPermits, 3],
          ['transfer_bytes_per_second', decision.limits.transferBytesPerSecond, 8388608],
        ] as const) {
          limits.labels(slot, kind, 'current').set(current);
          limits.labels(slot, kind, 'hard').set(hard);
        }
        modes.forEach((mode) => control.labels(slot, mode).set(mode === decision.mode ? 1 : 0));
        if (previousReason !== decision.reason) {
          controlChanges.labels(slot, decision.reason).inc();
          previousReason = decision.reason;
        }
      },
      observeSourceAge(seconds: number): void {
        finite(seconds);
        sourceAge.labels(slot).set(seconds);
      },
      observeRefresh(input: {
        outcome: 'ok' | 'partial' | 'failed';
        durationSeconds: number;
      }): void {
        member(input.outcome, ['ok', 'partial', 'failed']);
        finite(input.durationSeconds);
        refresh.labels(slot, input.outcome).observe(input.durationSeconds);
      },
      observeLocal(input: {
        pool: LocalPool;
        usedBytes: number;
        reservedBytes: number;
        capacityBytes: number;
        freeBytes: number;
        freeInodes: number;
        observedAtMs: number;
      }): void {
        member(input.pool, ['staging', 'parser']);
        [
          input.usedBytes,
          input.reservedBytes,
          input.capacityBytes,
          input.freeBytes,
          input.freeInodes,
          input.observedAtMs,
        ].forEach(finite);
        if (!input.capacityBytes) throw new Error('invalid_upload_metric');
        occupancy
          .labels(slot, input.pool)
          .set((input.usedBytes + input.reservedBytes) / input.capacityBytes);
        localBytes.labels(slot, input.pool, 'used').set(input.usedBytes);
        localBytes.labels(slot, input.pool, 'reserved').set(input.reservedBytes);
        localBytes.labels(slot, input.pool, 'free').set(input.freeBytes);
        inodes.labels(slot, input.pool).set(input.freeInodes);
        localObserved.labels(slot, input.pool).set(input.observedAtMs / 1000);
      },
      liveConnections(count: number): void {
        finite(count);
        connections.labels(slot).set(count);
      },
      event(event: 'update' | 'heartbeat' | 'closed'): void {
        member(event, ['update', 'heartbeat', 'closed']);
        events.labels(slot, event).inc();
      },
      observeQuota(input: {
        usedBytes: number;
        reservedBytes: number;
        retainedBytes: number;
      }): void {
        Object.values(input).forEach(finite);
        quotaBytes.labels(slot, 'used').set(input.usedBytes);
        quotaBytes.labels(slot, 'reserved').set(input.reservedBytes);
        quotaBytes.labels(slot, 'retained').set(input.retainedBytes);
      },
      rejectQuota(
        reason: 'window' | 'originals' | 'objects' | 'queue' | 'outstanding' | 'capacity',
      ): void {
        member(reason, ['window', 'originals', 'objects', 'queue', 'outstanding', 'capacity']);
        quotaRejections.labels(slot, reason).inc();
      },
    };
    return {
      ...observers,
      observeResources({
        resources,
        observedAtMs,
      }: {
        resources: UploadLocalResources;
        observedAtMs: number;
      }): void {
        const memory = resources.memory;
        if (
          memory.limitBytes !== null &&
          [memory.limitBytes, memory.currentBytes, memory.reservedBytes].every(Number.isFinite)
        )
          memoryHeadroom
            .labels(slot)
            .set(Math.max(0, memory.limitBytes - memory.currentBytes - memory.reservedBytes));
        else memoryHeadroom.remove(slot);
        for (const mount of resources.mounts) {
          member(mount.slot, ['staging', 'parser']);
          observers.observeLocal({
            pool: mount.slot as LocalPool,
            usedBytes: mount.usedBytes,
            reservedBytes: mount.reservedBytes,
            capacityBytes: Math.min(128 * 1048576, mount.capacityBytes),
            freeBytes: mount.freeBytes,
            freeInodes: mount.freeInodes,
            observedAtMs,
          });
        }
      },
    };
  }
  return {
    bind(slot: string) {
      member(slot, slots);
      let instance = bound.get(slot);
      if (!instance) {
        instance = bindSlot(slot);
        bound.set(slot, instance);
      }
      return instance;
    },
  };
}
