import representative from './status-fixtures/representative.json';
import { readStatusSnapshot } from './status';

const fresh = () => {
  const wire = JSON.parse(JSON.stringify(representative));
  const source = wire.sources.length;
  wire.sources.push({
    id: 'usage-regression',
    kind: 'application_usage',
    observerId: 'application',
    capturedAt: wire.usage.current.at,
  });
  wire.usage.sources = Array(5).fill(source);
  return wire;
};
const reference = (now: number) => ({
  id: 'semantic-regression',
  observedAt: now,
  valuationDate: '2026-10-19',
  reviewBefore: '2026-12-01',
  scenario: 'uncached_nominal',
  weighting: 'equal',
  models: ['gpt-6-astra', 'claude-fable-5-1', 'gemini-4-argon'].map((modelId, i) => ({
    modelId,
    sourceKey: ['openai_api_pricing', 'anthropic_api_pricing', 'google_api_pricing'][i],
    tiers: [{ upperInputTokens: null, inputUsdMicrosPerMillion: 1, outputUsdMicrosPerMillion: 1 }],
  })),
  fx: {
    usdPerEurMicros: 1122500,
    rateDate: '2026-10-19',
    observedAt: now,
    sourceKey: 'ecb_euro_reference_usd',
    carriedForward: false,
    stale: false,
  },
});
const emptyTokens = (now: number) => [0, now, 0, 0, ...Array(18).fill(0)];

describe('Status usage evidence invariants', () => {
  test.each(['grants', 'presence', 'documents'])('%s zero needs a completed query', (key) => {
    const wire = fresh();
    wire.usage.current[key] = [0, wire.usage.current.at, 0, 0, 0];
    expect(readStatusSnapshot(wire)).toBeNull();
    wire.usage.current[key] = [0, wire.usage.current.at, 1, 1, 0];
    expect(readStatusSnapshot(wire)).not.toBeNull();
  });

  test.each(['p50', 'p95'])('%s alone still requires samples', (percentile) => {
    const wire = fresh();
    const values = percentile === 'p50' ? [50, null] : [null, 100];
    const latency = [1, wire.usage.current.at, 2, 1, ...values, 0, 2, 1, 0, 0, 0];
    wire.usage.lastHour.groups[3] = latency;
    expect(readStatusSnapshot(wire)).toBeNull();
    latency[6] = null;
    expect(readStatusSnapshot(wire)).toBeNull();
    latency[6] = 1;
    expect(readStatusSnapshot(wire)).not.toBeNull();
  });

  test('both percentiles preserve ordering', () => {
    const wire = fresh();
    wire.usage.lastHour.groups[3] = [1, wire.usage.current.at, 2, 1, 100, 50, 1, 2, 1, 0, 0, 0];
    expect(readStatusSnapshot(wire)).toBeNull();
    wire.usage.lastHour.groups[3][5] = 150;
    expect(readStatusSnapshot(wire)).not.toBeNull();
  });

  test.each(['unknown', 'partial'])('complete valuation rejects %s token coverage', (quality) => {
    const wire = fresh();
    const now = wire.usage.current.at;
    wire.usage.comparisonReference = reference(now);
    wire.usage.lastHour.groups[4] = [0, now, 1, 1, ...Array(7).fill(10)];
    if (quality === 'partial') {
      wire.usage.lastHour.groups[2] = [1, now, 2, 1, ...Array(18).fill(null)];
    }
    expect(readStatusSnapshot(wire)).toBeNull();
    wire.usage.lastHour.groups[4][0] = 1;
    expect(readStatusSnapshot(wire)).not.toBeNull();
  });

  test('a genuinely empty complete attempt interval permits zero valuation', () => {
    const wire = fresh();
    const now = wire.usage.current.at;
    wire.usage.comparisonReference = reference(now);
    wire.usage.lastHour.groups[2] = emptyTokens(now);
    wire.usage.lastHour.groups[4] = [0, now, 0, 0, ...Array(7).fill(0)];
    expect(readStatusSnapshot(wire)).not.toBeNull();
  });

  test('complete valuation must cover the same complete token interval', () => {
    const wire = fresh();
    const now = wire.usage.current.at;
    wire.usage.comparisonReference = reference(now);
    wire.usage.lastHour.groups[2] = emptyTokens(now);
    wire.usage.lastHour.groups[4] = [0, now, 1, 1, ...Array(7).fill(0)];
    expect(readStatusSnapshot(wire)).toBeNull();
  });

  test('history applies the same valuation coverage invariant', () => {
    const wire = fresh();
    const now = wire.usage.current.at;
    wire.usage.comparisonReference = reference(now);
    wire.usage.history.rows[0][4] = [0, now, 1, 1, ...Array(7).fill(0)];
    expect(readStatusSnapshot(wire)).toBeNull();
  });

  test.each(['lastHour', 'history'])(
    '%s complete valuation cannot outlive token evidence',
    (window) => {
      const wire = fresh();
      const now = wire.usage.current.at;
      wire.usage.comparisonReference = reference(now);
      const groups =
        window === 'lastHour' ? wire.usage.lastHour.groups : wire.usage.history.rows[0];
      groups[2] = emptyTokens(now);
      groups[4] = [0, now, 0, 0, ...Array(7).fill(0)];
      wire.usage.maxAgeSeconds[2] = 60;
      wire.usage.maxAgeSeconds[4] = 90;
      expect(readStatusSnapshot(wire)).toBeNull();
      // A labelled partial subtotal is not promoted to a complete dependent total.
      groups[4][0] = 1;
      expect(readStatusSnapshot(wire)).not.toBeNull();
    },
  );

  test.each(['lastHour', 'history'])('%s checks capture time as well as max age', (window) => {
    const wire = fresh();
    const now = wire.usage.current.at;
    wire.usage.comparisonReference = reference(now);
    const groups = window === 'lastHour' ? wire.usage.lastHour.groups : wire.usage.history.rows[0];
    groups[2] = emptyTokens(now - 10);
    groups[4] = [0, now, 0, 0, ...Array(7).fill(0)];
    expect(readStatusSnapshot(wire)).toBeNull();
    groups[4][1] = now - 20;
    expect(readStatusSnapshot(wire)).not.toBeNull();
  });

  test.each(['lastHour', 'history'])(
    '%s admits unequal capture and age with exactly equal expiry',
    (window) => {
      const wire = fresh();
      const now = wire.usage.current.at;
      wire.usage.comparisonReference = reference(now);
      const groups =
        window === 'lastHour' ? wire.usage.lastHour.groups : wire.usage.history.rows[0];
      groups[2] = emptyTokens(now - 20);
      groups[4] = [0, now - 10, 0, 0, ...Array(7).fill(0)];
      wire.usage.maxAgeSeconds[2] = 90;
      wire.usage.maxAgeSeconds[4] = 80;
      expect(readStatusSnapshot(wire)).not.toBeNull();
    },
  );
});
