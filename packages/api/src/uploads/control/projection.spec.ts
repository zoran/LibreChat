import { decodeUploadProjection } from './projection';
const nowMs = 1800000000000;
const expected = [{ node: 'cpu-1', pool: 'host', signal: 'cpu' as const }];
function response(source = nowMs / 1000) {
  const fields = {
    expected: 1,
    value: 0.4,
    source_time_seconds: source,
    sample_count: 4,
    resets: 0,
    healthy: 1,
    observations: 0,
  };
  return {
    status: 'success',
    data: {
      resultType: 'vector',
      result: Object.entries(fields).map(([field, value]) => ({
        metric: {
          __name__: `cortex_upload_resource_${field}`,
          observer: 'collector-1',
          ...expected[0],
        },
        value: [nowMs / 1000, String(value)],
      })),
    },
  };
}
describe('finite Prometheus projection', () => {
  it('preserves the oldest raw time rather than fresh rule evaluation time', () => {
    const result = decodeUploadProjection(response(nowMs / 1000 - 50), 'collector-1', expected, {
      nowMs,
      monotonicMs: 1000,
    });
    expect(result.expiresAtMs).toBe(nowMs + 20000);
    expect(result.expiresMonotonicMs).toBe(21000);
    expect(result.samples[0].sourceTimeMs).toBe(nowMs - 50000);
  });
  it('rejects stale raw data and incomplete, duplicate, nonfinite or foreign series', () => {
    expect(() =>
      decodeUploadProjection(response(nowMs / 1000 - 80), 'collector-1', expected, {
        nowMs,
        monotonicMs: 0,
      }),
    ).toThrow();
    const missing = response();
    missing.data.result.pop();
    expect(() =>
      decodeUploadProjection(missing, 'collector-1', expected, { nowMs, monotonicMs: 0 }),
    ).toThrow();
    const duplicate = response();
    duplicate.data.result.push(duplicate.data.result[0]);
    expect(() =>
      decodeUploadProjection(duplicate, 'collector-1', expected, { nowMs, monotonicMs: 0 }),
    ).toThrow();
    const nan = response();
    nan.data.result[0].value[1] = 'NaN';
    expect(() =>
      decodeUploadProjection(nan, 'collector-1', expected, { nowMs, monotonicMs: 0 }),
    ).toThrow();
    const foreign = response();
    foreign.data.result[0].metric.observer = 'collector-2';
    expect(() =>
      decodeUploadProjection(foreign, 'collector-1', expected, { nowMs, monotonicMs: 0 }),
    ).toThrow();
  });
  it('rejects successful partial-result warnings rather than treating missing inputs as idle', () => {
    expect(() =>
      decodeUploadProjection({ ...response(), warnings: ['partial'] }, 'collector-1', expected, {
        nowMs,
        monotonicMs: 0,
      }),
    ).toThrow();
  });
});
