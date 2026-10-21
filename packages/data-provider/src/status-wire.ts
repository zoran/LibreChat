import { z } from 'zod';
import type { StatusSnapshot, StatusMeasurement } from './status-schema';
import { usageShape, decodeStatusUsage, encodeStatusUsage } from './status-usage';
import { shape, STATUS_LIMITS, STATUS_METRICS } from './status-schema';

const states = ['fresh', 'unknown', 'stale', 'disabled', 'unavailable', 'disagreement'] as const;
const reasons = [
  'observed',
  'not_measured',
  'not_configured',
  'source_unavailable',
  'source_stale',
  'sources_disagree',
  'partial_coverage',
  'no_traffic',
  'counter_reset',
  'insufficient_samples',
  'not_qualified',
] as const;
const uint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// Preserve observer precision; fractional Unix seconds distinguish same-second evidence.
const timestamp = z.number().finite().min(0).max(8640000000000);
const index = uint.max(STATUS_LIMITS.maxSources - 1);
const metricShape = shape.shape.measurements.element;
const sample = z.tuple([
  index,
  timestamp,
  z.number().finite().nonnegative(),
  z.union([z.literal(0), z.literal(120)]),
  uint.max(1000000),
  uint.max(1000000),
  uint.max(1000000).nullable(),
  uint.max(1000000),
]);
const measurement = z.tuple([
  metricShape.shape.id,
  z.union([z.literal(0), z.literal(1)]),
  uint.max(STATUS_LIMITS.maxEdges - 1),
  metricShape.shape.key,
  metricShape.shape.scope,
  uint.max(states.length - 1),
  uint.max(reasons.length - 1),
  z.number().finite().nonnegative().nullable(),
  index.nullable(),
  z.array(sample).max(2),
]);
const wireShape = shape
  .omit({ measurements: true })
  .extend({
    measurements: z.array(measurement).max(STATUS_LIMITS.maxMeasurements),
    usage: usageShape,
  })
  .strict();
export type StatusWireSnapshot = z.infer<typeof wireShape>;
export function decodeStatusWire(value: unknown): StatusSnapshot | null {
  const parsed = wireShape.safeParse(value);
  if (!parsed.success) return null;
  try {
    const w = parsed.data;
    const measurements = w.measurements.map((m) => {
      const target = (m[1] === 0 ? w.nodes : w.edges)[m[2]];
      if (!target || (m[8] !== null && !w.sources[m[8]])) throw Error('index');
      return {
        id: m[0],
        target: { kind: m[1] === 0 ? 'node' : 'edge', id: target.id },
        key: m[3],
        unit: STATUS_METRICS[m[3]].unit,
        scope: m[4],
        state: states[m[5]],
        reason: reasons[m[6]],
        value: m[7],
        selectedSourceId: m[8] === null ? null : w.sources[m[8]].id,
        samples: m[9].map((s) => {
          if (!w.sources[s[0]]) throw Error('source');
          return {
            sourceId: w.sources[s[0]].id,
            observedAt: s[1],
            value: s[2],
            windowSeconds: s[3],
            sampleCount: s[4],
            resetCount: s[5],
            coverage: { expected: s[6], observed: s[7] },
          };
        }),
      };
    });
    const { usage, ...base } = w;
    const decoded = shape.parse({ ...base, measurements });
    return { ...decoded, usage: decodeStatusUsage(usage, w.sources, w.generatedAt) };
  } catch {
    return null;
  }
}
export function packStatusWire(value: StatusSnapshot): StatusWireSnapshot {
  const source = (id: string) => {
    const i = value.sources.findIndex((s) => s.id === id);
    if (i < 0) throw Error('STATUS_SOURCE_INDEX');
    return i;
  };
  const measurement = (m: StatusMeasurement) => [
    m.id,
    m.target.kind === 'node' ? 0 : 1,
    (m.target.kind === 'node' ? value.nodes : value.edges).findIndex((n) => n.id === m.target.id),
    m.key,
    m.scope,
    states.indexOf(m.state),
    reasons.indexOf(m.reason),
    m.value,
    m.selectedSourceId === null ? null : source(m.selectedSourceId),
    m.samples.map((s) => [
      source(s.sourceId),
      s.observedAt,
      s.value,
      s.windowSeconds,
      s.sampleCount,
      s.resetCount,
      s.coverage.expected,
      s.coverage.observed,
    ]),
  ];
  return wireShape.parse({
    ...value,
    measurements: value.measurements.map(measurement),
    usage: encodeStatusUsage(value.usage, value.sources),
  });
}
