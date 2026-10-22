import { Registry } from 'prom-client';
import type { HousekeepingObservation } from './runtime';
import { attachHousekeepingMetrics } from './metrics';

const observation = (): HousekeepingObservation => ({
  identity: {
    podUid: '11111111-1111-1111-1111-111111111111',
    incarnation: '22222222-2222-4222-8222-222222222222',
    source: 'a'.repeat(40),
    hostId: 'lx-s-bwi-cpu-2',
  },
  lifecycle: 'ready',
  admitting: true,
  activeWorkCount: 1,
});
const samples = async (registry: Registry) =>
  (await registry.getMetricsAsJSON()).flatMap((metric) => metric.values);

describe('Housekeeping local metrics', () => {
  it('captures exactly one observation and clock, exports only the four bounded local families', async () => {
    const registry = new Registry();
    const observe = jest.fn(observation);
    const now = jest.fn(() => 1700000000123);
    const exporter = attachHousekeepingMetrics(registry, observe, now);
    expect(observe).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    exporter.collect();
    expect(observe).toHaveBeenCalledTimes(1);
    expect(now).toHaveBeenCalledTimes(1);
    const rows = await registry.getMetricsAsJSON();
    expect(rows.map((row) => row.name)).toEqual([
      'cortex_housekeeping_instance_info',
      'cortex_housekeeping_admitting',
      'cortex_housekeeping_active_work_count',
      'cortex_housekeeping_observed_at_seconds',
    ]);
    expect(rows.map((row) => row.values[0].value)).toEqual([1, 1, 1, 1700000000.123]);
    for (const row of rows) {
      expect(Object.keys(row.values[0].labels).sort()).toEqual(
        (row.name.endsWith('_info')
          ? ['worker_pod_uid', 'worker_node', 'source_revision', 'incarnation', 'lifecycle']
          : ['worker_pod_uid', 'worker_node', 'source_revision', 'incarnation']
        ).sort(),
      );
    }
  });

  it.each([
    ['starting', false, 0],
    ['ready', true, 0],
    ['draining', false, 1],
    ['stopped', false, 0],
    ['unknown', false, 1],
  ] as const)(
    'preserves local %s without inventing global state',
    async (lifecycle, admitting, activeWorkCount) => {
      const registry = new Registry();
      const exporter = attachHousekeepingMetrics(registry, () => ({
        ...observation(),
        lifecycle,
        admitting,
        activeWorkCount,
      }));
      exporter.collect();
      expect((await samples(registry)).map((row) => row.value).slice(0, 3)).toEqual([
        1,
        Number(admitting),
        activeWorkCount,
      ]);
      expect((await samples(registry))[0].labels.lifecycle).toBe(lifecycle);
    },
  );

  it.each([
    [
      'pod',
      (v: HousekeepingObservation) => ({
        ...v,
        identity: { ...v.identity, podUid: 'PRIVATE-FILE' },
      }),
    ],
    [
      'source',
      (v: HousekeepingObservation) => ({
        ...v,
        identity: { ...v.identity, source: 'not-a-source' },
      }),
    ],
    [
      'incarnation',
      (v: HousekeepingObservation) => ({
        ...v,
        identity: { ...v.identity, incarnation: v.identity.podUid },
      }),
    ],
    [
      'node',
      (v: HousekeepingObservation) => ({
        ...v,
        identity: { ...v.identity, hostId: 'x'.repeat(257) },
      }),
    ],
    ['lifecycle', (v: HousekeepingObservation) => ({ ...v, lifecycle: 'healthy' })],
    ['count', (v: HousekeepingObservation) => ({ ...v, activeWorkCount: 2 })],
    ['negative', (v: HousekeepingObservation) => ({ ...v, activeWorkCount: -1 })],
    ['null', (v: HousekeepingObservation) => ({ ...v, admitting: null })],
    ['contradiction', (v: HousekeepingObservation) => ({ ...v, lifecycle: 'draining' })],
  ])('rejects invalid %s and clears every previously published series', async (_name, mutate) => {
    const registry = new Registry();
    const observe = jest.fn(observation);
    const exporter = attachHousekeepingMetrics(registry, observe);
    exporter.collect();
    observe.mockReturnValue(mutate(observation()) as HousekeepingObservation);
    expect(() => exporter.collect()).toThrow('HOUSEKEEPING_METRICS_INVALID');
    expect(await samples(registry)).toEqual([]);
    expect(await registry.metrics()).not.toContain('PRIVATE-FILE');
  });

  it.each([NaN, Infinity, -1])(
    'rejects invalid clock %s and clears prior evidence',
    async (clock) => {
      const registry = new Registry();
      const now = jest.fn(() => 1700000000000);
      const exporter = attachHousekeepingMetrics(registry, observation, now);
      exporter.collect();
      now.mockReturnValue(clock);
      expect(() => exporter.collect()).toThrow('HOUSEKEEPING_METRICS_INVALID');
      expect(await samples(registry)).toEqual([]);
    },
  );

  it('clears prior evidence when the reader throws, without exposing callback details', async () => {
    const registry = new Registry();
    const observe = jest.fn(observation);
    const exporter = attachHousekeepingMetrics(registry, observe);
    exporter.collect();
    observe.mockImplementation(() => {
      throw Error('PRIVATE-FILE');
    });
    expect(() => exporter.collect()).toThrow('HOUSEKEEPING_METRICS_INVALID');
    expect(await samples(registry)).toEqual([]);
  });

  it('replaces incarnation labels and detaches idempotently without affecting another registry', async () => {
    const first = new Registry();
    const second = new Registry();
    const observe = jest.fn(observation);
    const a = attachHousekeepingMetrics(first, observe);
    const b = attachHousekeepingMetrics(second, observation);
    a.collect();
    b.collect();
    observe.mockReturnValue({
      ...observation(),
      identity: { ...observation().identity, incarnation: '33333333-3333-4333-8333-333333333333' },
    });
    a.collect();
    expect(await first.metrics()).not.toContain('22222222-2222-4222-8222-222222222222');
    a.detach();
    a.detach();
    expect(await first.getMetricsAsJSON()).toEqual([]);
    expect(await samples(second)).toHaveLength(4);
    expect(() => a.collect()).toThrow('HOUSEKEEPING_METRICS_DETACHED');
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it('keeps concurrent serialization bound to the snapshot captured for that scrape', async () => {
    const registry = new Registry();
    const observe = jest.fn(observation);
    const now = jest.fn().mockReturnValueOnce(100000).mockReturnValueOnce(200000);
    const exporter = attachHousekeepingMetrics(registry, observe, now);
    exporter.collect();
    const first = registry.metrics();
    observe.mockReturnValue({ ...observation(), lifecycle: 'draining', admitting: false });
    exporter.collect();
    const second = registry.metrics();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toContain('lifecycle="ready"');
    expect(a).not.toContain('lifecycle="draining"');
    expect(b).toContain('lifecycle="draining"');
    expect(b).not.toContain('lifecycle="ready"');
    expect(a).toMatch(/observed_at_seconds\{[^}]+\} 100/);
    expect(b).toMatch(/observed_at_seconds\{[^}]+\} 200/);
  });
});
