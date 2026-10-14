import { Registry } from 'prom-client';
import { createUploadMetrics } from './metrics';

describe('private finite upload metrics', () => {
  it('rejects unconfigured slots and does not create a parallel registry', () => {
    const registry = new Registry();
    const metrics = createUploadMetrics(registry, ['cpu-1']);
    expect(() => metrics.bind('private-user-id')).toThrow();
    expect(registry.getSingleMetric('cortex_upload_backend_observed_at_seconds')).toBeDefined();
  });
  it('exports actual observation time and measured backend count, without inventing fleet health', async () => {
    const registry = new Registry();
    const metrics = createUploadMetrics(registry, ['cpu-1']).bind('cpu-1');
    metrics.observeBackend({
      operation: 'put',
      outcome: 'durable',
      durationSeconds: 0.4,
      observedAtMs: 1800000000000,
    });
    const text = await registry.metrics();
    expect(text).toContain('cortex_upload_backend_observed_at_seconds{slot="cpu-1"} 1800000000');
    expect(text).toContain('cortex_upload_backend_duration_seconds_count{slot="cpu-1"} 1');
    expect(text).not.toContain('replication_healthy');
    expect(text).not.toContain('cortex_upload_backend_service_observed_at_seconds{');
  });
  it('rejects arbitrary runtime labels and invalid durations before metrics mutation', async () => {
    const registry = new Registry();
    const metrics = createUploadMetrics(registry, ['cpu-1']).bind('cpu-1');
    expect(() =>
      metrics.observeBackend({
        operation: 'secret-path' as 'put',
        outcome: 'error',
        durationSeconds: 1,
        observedAtMs: 1800000000000,
      }),
    ).toThrow();
    expect(() =>
      metrics.observeBackend({
        operation: 'put',
        outcome: 'error',
        durationSeconds: -1,
        observedAtMs: 1800000000000,
      }),
    ).toThrow();
    expect(await registry.metrics()).not.toContain('secret-path');
  });
  it('observes held replay and cleanup separately without per-user labels or invented freshness', async () => {
    const registry = new Registry();
    const metrics = createUploadMetrics(registry, ['cpu-2']).bind('cpu-2');
    expect(await registry.metrics()).not.toContain(
      'cortex_upload_source_replay_observed_at_seconds{',
    );
    metrics.observeSourceReplay({
      held: 2,
      pendingCleanup: 1,
      logicalReservedBytes: 58720256,
      rejectedReason: 'capacity',
    });
    const text = await registry.metrics();
    expect(text).toContain('cortex_upload_source_replay_held{slot="cpu-2"} 2');
    expect(text).toContain('cortex_upload_source_replay_cleanup_pending{slot="cpu-2"} 1');
    expect(text).toContain('cortex_upload_source_replay_reserved_bytes{slot="cpu-2"} 58720256');
    expect(text).toContain(
      'cortex_upload_source_replay_rejections_total{slot="cpu-2",reason="capacity"} 1',
    );
    expect(() =>
      metrics.observeSourceReplay({
        held: 1,
        pendingCleanup: 0,
        logicalReservedBytes: 1,
        rejectedReason: 'private-account' as 'capacity',
      }),
    ).toThrow();
    expect(await registry.metrics()).not.toContain('private-account');
  });
  it('exports the actual global ledger timestamp and unresolved reservations', async () => {
    const registry = new Registry();
    const metrics = createUploadMetrics(registry, ['cpu-2']).bind('cpu-2');
    metrics.observeSnapshot({
      observedAt: 1800000000000,
      control: {
        limits: { transferPermits: 1, processingPermits: 1, transferBytesPerSecond: 1048576 },
        mode: 'fallback',
        sourceExpiresAt: 1800000010000,
        leaseExpiresAt: 1800000010000,
        enabled: true,
      },
      queue: { count: 2, bytes: 200, oldestAgeSeconds: 4 },
      quota: { usedBytes: 300, reservedBytes: 200, retainedBytes: 100 },
      staging: { count: 2, bytes: 200 },
      states: { waiting: 2, ready: 1 },
      originalBytes: 100,
      objectBytes: 110,
      textBytes: 10,
      recordBytes: 30,
      bundles: 3,
      cleanupPending: 1,
      transfers: 1,
      processors: 0,
    });
    const text = await registry.metrics();
    expect(text).toContain('cortex_upload_ledger_observed_at_seconds{slot="cpu-2"} 1800000000');
    expect(text).toContain('cortex_upload_staging_reserved_bytes{slot="cpu-2"} 200');
    expect(text).toContain('cortex_upload_active_work{slot="cpu-2",kind="transfer"} 1');
    expect(text).toContain('cortex_upload_quota_bytes{slot="cpu-2",kind="used"} 300');
  });
  it('exports measured reservation occupancy and removes unknown cgroup headroom', async () => {
    const registry = new Registry();
    const metrics = createUploadMetrics(registry, ['cpu-1']).bind('cpu-1');
    const resources = {
      memory: { currentBytes: 256, limitBytes: 1024 as number | null, reservedBytes: 128 },
      mounts: [
        {
          slot: 'staging',
          freeBytes: 1024,
          freeInodes: 2048,
          usedBytes: 16,
          reservedBytes: 16,
          requiredBytes: 0,
          capacityBytes: 128,
          floorBytes: 16,
        },
      ],
    };
    metrics.observeResources({ resources, observedAtMs: 1800000000000 });
    let text = await registry.metrics();
    expect(text).toContain('cortex_upload_temp_occupancy_ratio{slot="cpu-1",pool="staging"} 0.25');
    expect(text).toContain('cortex_upload_cgroup_headroom_bytes{slot="cpu-1"} 640');
    resources.memory.limitBytes = null;
    metrics.observeResources({ resources, observedAtMs: 1800000000000 });
    text = await registry.metrics();
    expect(text).not.toContain('cortex_upload_cgroup_headroom_bytes{slot="cpu-1"}');
  });
  it('keeps request and actual end-to-end durations separate with finite budget categories', async () => {
    const registry = new Registry();
    const metrics = createUploadMetrics(registry, ['cpu-1']).bind('cpu-1');
    metrics.observeDuration({ stage: 'request', outcome: 'success', seconds: 1 });
    metrics.observeDuration({ stage: 'total', outcome: 'success', seconds: 9 });
    metrics.rejectQuota('capacity');
    metrics.fileSize(5);
    metrics.retry('processing');
    const text = await registry.metrics();
    expect(text).toContain(
      'cortex_upload_duration_seconds_sum{slot="cpu-1",stage="request",outcome="success"} 1',
    );
    expect(text).toContain(
      'cortex_upload_duration_seconds_sum{slot="cpu-1",stage="total",outcome="success"} 9',
    );
    expect(text).toContain(
      'cortex_upload_quota_rejections_total{slot="cpu-1",reason="capacity"} 1',
    );
    expect(text).toContain('cortex_upload_file_bytes_sum{slot="cpu-1"} 5');
    expect(text).toContain('cortex_upload_retries_total{slot="cpu-1",reason="processing"} 1');
    expect(() => metrics.rejectQuota('private-user' as never)).toThrow();
    expect(await registry.metrics()).not.toContain('private-user');
  });
});
