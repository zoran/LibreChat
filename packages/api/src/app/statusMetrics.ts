import { Counter, Histogram } from 'prom-client';
import type { Registry } from 'prom-client';
import { attachGenerationAdmissionMetrics } from '../stream/generationAdmissionMetrics';

type Operation = 'snapshot' | 'observer' | 'request';
type Outcome = 'success' | 'failure' | 'cached' | 'refreshed' | 'aborted' | 'timeout' | 'busy';
let record: (
  operation: Operation,
  outcome: Outcome,
  seconds: number,
  bytes: number,
) => void = () => {};

/** The existing App registry owns lifecycle and publication; all labels are closed enums. */
export function attachStatusMetrics(registry?: Registry): void {
  attachGenerationAdmissionMetrics(registry);
  record = () => {};
  if (!registry) return;
  const calls = new Counter({
    name: 'cortex_status_operations_total',
    help: 'Bounded Status requests, cache refreshes and observer sequences by outcome',
    labelNames: ['operation', 'outcome'] as const,
    registers: [registry],
  });
  const duration = new Histogram({
    name: 'cortex_status_operation_seconds',
    help: 'Status operation cost including failed and cancelled work',
    labelNames: ['operation', 'outcome'] as const,
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 3, 5],
    registers: [registry],
  });
  const input = new Counter({
    name: 'cortex_status_observer_bytes_total',
    help: 'Observer bytes received including rejected or failed responses',
    registers: [registry],
  });
  record = (operation, outcome, seconds, bytes) => {
    if (
      !['snapshot', 'observer', 'request'].includes(operation) ||
      !['success', 'failure', 'cached', 'refreshed', 'aborted', 'timeout', 'busy'].includes(outcome)
    )
      return;
    calls.inc({ operation, outcome });
    if (Number.isFinite(seconds) && seconds >= 0) duration.observe({ operation, outcome }, seconds);
    if (operation === 'observer' && Number.isSafeInteger(bytes) && bytes >= 0) input.inc(bytes);
  };
}
export function recordStatusOperation(
  operation: Operation,
  outcome: Outcome,
  seconds: number,
  bytes = 0,
): void {
  record(operation, outcome, seconds, bytes);
}
