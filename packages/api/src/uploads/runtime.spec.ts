import type { UploadMetricsSnapshot } from 'librechat-data-provider';
import type { UploadRuntimeOptions } from './runtime';
import { createUploadRuntime } from './runtime';

const epoch = 1_800_000_000_000;
const limits = { transferPermits: 6, processingPermits: 3, transferBytesPerSecond: 8 * 1048576 };
const worker = { hostId: 'cpu-1', instanceId: 'app-1' };
const expected = [{ node: 'cpu-1', pool: 'originals', signal: 'cpu' as const }];

function fixture(leader = true) {
  let elapsed = 0;
  const clock = () => ({ nowMs: epoch + elapsed, monotonicMs: elapsed });
  const metrics: UploadMetricsSnapshot = {
    observedAt: epoch,
    admissionsPaused: false,
    states: {},
    originalBytes: 0,
    objectBytes: 0,
    textBytes: 0,
    recordBytes: 0,
    bundles: 0,
    cleanupPending: 0,
    transfers: 0,
    processors: 0,
    queue: { count: 0, bytes: 0, oldestAgeSeconds: 0 },
    quota: { usedBytes: 0, reservedBytes: 0, retainedBytes: 0 },
    staging: { count: 0, bytes: 0 },
    control: {
      mode: 'normal',
      limits,
      enabled: true,
      sourceExpiresAt: epoch + 70_000,
      leaseExpiresAt: epoch + 45_000,
    },
  };
  const repository = {
    claimController: jest.fn(async () =>
      leader
        ? {
            ownerId: 'app-1',
            generation: 1,
            expiresAt: new Date(clock().nowMs + 45_000).toISOString(),
          }
        : null,
    ),
    renewController: jest.fn(
      async ({ lease }: Parameters<UploadRuntimeOptions['repository']['renewController']>[0]) => ({
        ...lease,
        expiresAt: new Date(clock().nowMs + 45_000).toISOString(),
      }),
    ),
    publishControl: jest.fn(async () => true),
    activeWorkers: jest.fn(async () => [worker]),
    metrics: jest.fn(async () => metrics),
  };
  const snapshots = {
    refresh: jest.fn(async (): Promise<void> => undefined),
    current: jest.fn(() => []),
  };
  const hardGuards = jest.fn(async () => ({ safe: true, durability: 'safe' as const }));
  const observe = jest.fn();
  const runtime = createUploadRuntime({
    ownerId: 'app-1',
    repository,
    snapshots,
    expected,
    hardGuards,
    clock,
    observe,
  } as UploadRuntimeOptions);
  return {
    runtime,
    repository,
    snapshots,
    hardGuards,
    metrics,
    observe,
    advance: (ms: number) => {
      elapsed += ms;
    },
  };
}

describe('fenced upload controller runtime', () => {
  it('never refreshes collectors as follower and reports the shared authoritative policy', async () => {
    const f = fixture(false);
    expect(f.runtime.status()).toEqual({
      throttled: true,
      waitingReason: 'unavailable',
      admissionsPaused: null,
    });
    await f.runtime.tick();
    expect(f.snapshots.refresh).not.toHaveBeenCalled();
    expect(f.repository.publishControl).not.toHaveBeenCalled();
    expect(f.runtime.status()).toEqual({
      throttled: false,
      waitingReason: null,
      admissionsPaused: false,
    });
    f.advance(16_000);
    expect(f.runtime.status()).toEqual({
      throttled: true,
      waitingReason: 'unavailable',
      admissionsPaused: null,
    });
    await f.runtime.stop();
  });

  it('renews every ten seconds, refreshes every thirty, and passes all held workers to hard guards', async () => {
    const f = fixture();
    await f.runtime.tick();
    for (let i = 0; i < 3; i++) {
      f.advance(10_000);
      await f.runtime.tick();
    }
    expect(f.repository.claimController).toHaveBeenCalledTimes(1);
    expect(f.repository.renewController).toHaveBeenCalledTimes(3);
    expect(f.snapshots.refresh).toHaveBeenCalledTimes(2);
    expect(f.hardGuards).toHaveBeenCalledWith([worker]);
    expect(f.repository.publishControl).toHaveBeenLastCalledWith(
      expect.objectContaining({
        lease: expect.objectContaining({ generation: 1 }),
        mode: 'fallback',
        sourceExpiresAt: epoch + 30_000,
      }),
    );
    await f.runtime.stop();
  });

  it('blocks missing active-host coverage even when advisory samples and supplied guards seem safe', async () => {
    const f = fixture();
    f.repository.activeWorkers.mockResolvedValue([{ ...worker, hostId: 'uncovered-host' }]);
    await f.runtime.tick();
    expect(f.repository.publishControl).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'blocked',
        limits: { transferPermits: 0, processingPermits: 0, transferBytesPerSecond: 0 },
      }),
    );
    await f.runtime.stop();
  });

  it('joins overlapping ticks, loses authority on failed renewal, and does not refresh or publish afterward', async () => {
    const f = fixture();
    let finish!: () => void;
    f.snapshots.refresh.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const one = f.runtime.tick();
    await Promise.resolve();
    await Promise.resolve();
    const two = f.runtime.tick();
    expect(two).toBe(one);
    finish();
    await one;
    f.repository.renewController.mockResolvedValueOnce(null as never);
    f.advance(30_000);
    await f.runtime.tick();
    expect(f.snapshots.refresh).toHaveBeenCalledTimes(1);
    expect(f.repository.publishControl).toHaveBeenCalledTimes(1);
    await f.runtime.stop();
  });

  it('does not publish after stop races an in-flight collector refresh', async () => {
    const f = fixture();
    let finish!: () => void;
    f.snapshots.refresh.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const tick = f.runtime.tick();
    await Promise.resolve();
    await Promise.resolve();
    const stopping = f.runtime.stop();
    finish();
    await Promise.all([tick, stopping]);
    expect(f.repository.publishControl).not.toHaveBeenCalled();
  });

  it('treats shared blocked policy and source expiry conservatively without querying from status()', async () => {
    const f = fixture(false);
    f.metrics.control.mode = 'blocked';
    await f.runtime.tick();
    expect(f.runtime.status().waitingReason).toBe('unavailable');
    f.metrics.control.mode = 'normal';
    f.metrics.control.sourceExpiresAt = epoch;
    f.advance(10_000);
    await f.runtime.tick();
    expect(f.runtime.status()).toEqual({
      throttled: true,
      waitingReason: 'capacity',
      admissionsPaused: false,
    });
    for (let i = 0; i < 5; i++) f.runtime.status();
    expect(f.repository.metrics).toHaveBeenCalledTimes(2);
    expect(f.snapshots.refresh).not.toHaveBeenCalled();
    await f.runtime.stop();
  });

  it('projects pause independently of critical control without a status-time database read', async () => {
    const f = fixture(false);
    f.metrics.admissionsPaused = true;
    f.metrics.control.mode = 'blocked';
    await f.runtime.tick();
    expect(f.runtime.status()).toEqual({
      admissionsPaused: true,
      throttled: true,
      waitingReason: 'unavailable',
    });
    for (let i = 0; i < 10; i++) expect(f.runtime.status().admissionsPaused).toBe(true);
    expect(f.repository.metrics).toHaveBeenCalledTimes(1);
    f.metrics.admissionsPaused = false;
    expect(f.runtime.status().admissionsPaused).toBe(true);
    await f.runtime.stop();
  });

  it('does not rejuvenate an old admission observation when a slow metrics read finishes', async () => {
    const f = fixture(false);
    f.repository.metrics.mockImplementationOnce(async () => {
      f.advance(14_000);
      return f.metrics;
    });
    await f.runtime.tick();
    expect(f.runtime.status().admissionsPaused).toBe(false);
    f.advance(1000);
    expect(f.runtime.status().admissionsPaused).toBeNull();
    await f.runtime.stop();
  });

  it.each([null, undefined, 'false', 0])(
    'treats unavailable or malformed admission %p as unknown',
    async (value) => {
      const f = fixture(false);
      Object.assign(f.metrics, { admissionsPaused: value });
      await f.runtime.tick();
      expect(f.runtime.status().admissionsPaused).toBeNull();
      expect(f.runtime.status().throttled).toBe(false);
      await f.runtime.stop();
    },
  );

  it('rejects a future source timestamp and clears readiness after a failed refresh', async () => {
    const f = fixture(false);
    f.metrics.observedAt = epoch + 1;
    await f.runtime.tick();
    expect(f.runtime.status().admissionsPaused).toBeNull();
    f.advance(10_000);
    f.metrics.observedAt = epoch + 10_000;
    await f.runtime.tick();
    expect(f.runtime.status().admissionsPaused).toBe(false);
    f.advance(10_000);
    f.repository.metrics.mockRejectedValueOnce(new Error('unavailable'));
    await f.runtime.tick();
    expect(f.runtime.status().admissionsPaused).toBeNull();
    await f.runtime.stop();
  });
});
