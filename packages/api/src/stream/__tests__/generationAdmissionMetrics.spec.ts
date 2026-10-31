/** generationAdmissionMetrics.spec verifies the real registry lifecycle and bounded labels. */
import { Registry } from 'prom-client';
import {
  attachGenerationAdmissionMetrics,
  recordGenerationAdmissionRefusal,
} from '../generationAdmissionMetrics';
import { attachStatusMetrics } from '../../app/statusMetrics';

const metricName = 'cortex_generation_admission_refusals_total';

describe('generation admission refusal metrics', () => {
  afterEach(() => attachStatusMetrics());

  it('publishes exactly six closed reasons at acquire through the normal App attachment', async () => {
    const registry = new Registry();
    attachStatusMetrics(registry);
    const reasons = [
      'INVALID_INPUT',
      'REQUEST_CONFLICT',
      'CONVERSATION_ACTIVE',
      'HELD',
      'OUTCOME_UNKNOWN',
      'ALREADY_ADMITTED',
    ] as const;
    for (const reason of reasons) recordGenerationAdmissionRefusal(reason);
    const metric = await registry.getSingleMetric(metricName)!.get();
    expect(metric.values).toHaveLength(6);
    expect(metric.values.map(({ labels, value }) => ({ labels, value }))).toEqual(
      reasons.map((reason) => ({ labels: { stage: 'acquire', reason }, value: 1 })),
    );
  });

  it('rejects unknown runtime values without adding data-bearing series or changing counters', async () => {
    const registry = new Registry();
    attachGenerationAdmissionMetrics(registry);
    for (const value of [null, undefined, {}, 1, 'arbitrary-private-value', 'acquire', 'held']) {
      Reflect.apply(recordGenerationAdmissionRefusal, undefined, [value]);
    }
    const metric = await registry.getSingleMetric(metricName)!.get();
    expect(metric.values).toHaveLength(6);
    expect(metric.values.every(({ value }) => value === 0)).toBe(true);
    expect(await registry.metrics()).not.toContain('arbitrary-private-value');
  });

  it('resets the old sink when metrics are disabled and reattaches only to the new registry', async () => {
    const first = new Registry();
    attachStatusMetrics(first);
    recordGenerationAdmissionRefusal('OUTCOME_UNKNOWN');
    attachStatusMetrics();
    recordGenerationAdmissionRefusal('OUTCOME_UNKNOWN');
    const second = new Registry();
    attachStatusMetrics(second);
    recordGenerationAdmissionRefusal('INVALID_INPUT');
    const oldMetric = await first.getSingleMetric(metricName)!.get();
    const newMetric = await second.getSingleMetric(metricName)!.get();
    expect(oldMetric.values.find(({ labels }) => labels.reason === 'OUTCOME_UNKNOWN')?.value).toBe(
      1,
    );
    expect(oldMetric.values.find(({ labels }) => labels.reason === 'INVALID_INPUT')?.value).toBe(0);
    expect(newMetric.values.find(({ labels }) => labels.reason === 'OUTCOME_UNKNOWN')?.value).toBe(
      0,
    );
    expect(newMetric.values.find(({ labels }) => labels.reason === 'INVALID_INPUT')?.value).toBe(1);
  });
});
