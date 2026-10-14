import type { UploadClock, UploadResourceKey, UploadResourceSnapshot } from './types';
import { uploadResourceKey, UPLOAD_SOURCE_MAX_AGE_MS } from './controller';
const fields = [
  'expected',
  'value',
  'source_time_seconds',
  'sample_count',
  'resets',
  'healthy',
  'observations',
] as const;
const prefix = 'cortex_upload_resource_';
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_upload_projection');
  return value as Record<string, unknown>;
}
function number(value: unknown): number {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    value === '' ||
    !Number.isFinite(Number(value))
  )
    throw new Error('invalid_upload_projection');
  return Number(value);
}
export function decodeUploadProjection(
  body: unknown,
  observer: string,
  expected: readonly UploadResourceKey[],
  clock: UploadClock,
): UploadResourceSnapshot {
  const root = object(body);
  const data = object(root.data);
  if (
    root.status !== 'success' ||
    root.warnings !== undefined ||
    root.infos !== undefined ||
    data.resultType !== 'vector' ||
    !Array.isArray(data.result) ||
    data.result.length > 512 ||
    !expected.length ||
    expected.length > 64
  )
    throw new Error('invalid_upload_projection');
  if (![clock.nowMs, clock.monotonicMs].every(Number.isFinite))
    throw new Error('invalid_upload_clock');
  const allow = new Map(expected.map((key) => [uploadResourceKey(key), key]));
  if (allow.size !== expected.length) throw new Error('invalid_upload_expectations');
  const grouped = new Map<string, { values: Map<string, number>; evaluated: number }>();
  for (const raw of data.result) {
    const series = object(raw);
    const metric = object(series.metric);
    if (
      Object.keys(metric).some(
        (key) => !['__name__', 'observer', 'node', 'pool', 'signal'].includes(key),
      ) ||
      metric.observer !== observer ||
      typeof metric.__name__ !== 'string' ||
      !metric.__name__.startsWith(prefix)
    )
      throw new Error('unexpected_upload_series');
    const field = metric.__name__.slice(prefix.length);
    if (!(fields as readonly string[]).includes(field)) throw new Error('unexpected_upload_series');
    const id = JSON.stringify([metric.node, metric.pool, metric.signal]);
    if (!allow.has(id) || !Array.isArray(series.value) || series.value.length !== 2)
      throw new Error('unexpected_upload_series');
    const evaluated = number(series.value[0]) * 1000;
    const value = number(series.value[1]);
    if (evaluated > clock.nowMs || clock.nowMs - evaluated >= UPLOAD_SOURCE_MAX_AGE_MS)
      throw new Error('stale_upload_projection');
    const group = grouped.get(id) ?? { values: new Map<string, number>(), evaluated };
    if (group.values.has(field)) throw new Error('duplicate_upload_series');
    group.values.set(field, value);
    group.evaluated = Math.min(group.evaluated, evaluated);
    grouped.set(id, group);
  }
  const samples = expected.map((key) => {
    const group = grouped.get(uploadResourceKey(key));
    if (!group || fields.some((field) => !group.values.has(field)))
      throw new Error('missing_upload_series');
    const value = (field: (typeof fields)[number]) => group.values.get(field)!;
    const sourceTimeMs = value('source_time_seconds') * 1000;
    if (
      value('expected') !== 1 ||
      ![0, 1].includes(value('healthy')) ||
      value('value') < 0 ||
      value('resets') < 0 ||
      !Number.isInteger(value('sample_count')) ||
      value('sample_count') < 0 ||
      value('observations') < 0 ||
      sourceTimeMs > group.evaluated ||
      sourceTimeMs > clock.nowMs ||
      clock.nowMs - sourceTimeMs >= UPLOAD_SOURCE_MAX_AGE_MS
    )
      throw new Error('invalid_upload_source');
    return {
      ...key,
      value: value('value'),
      sourceTimeMs,
      evaluatedTimeMs: group.evaluated,
      rawSamples: value('sample_count'),
      resets: value('resets'),
      healthy: value('healthy') === 1,
      observations: value('observations'),
    };
  });
  const expiresAtMs = Math.min(
    ...samples.map(
      (sample) => Math.min(sample.sourceTimeMs, sample.evaluatedTimeMs) + UPLOAD_SOURCE_MAX_AGE_MS,
    ),
  );
  return {
    observer,
    receivedAt: { ...clock },
    expiresAtMs,
    expiresMonotonicMs: clock.monotonicMs + expiresAtMs - clock.nowMs,
    samples,
  };
}
