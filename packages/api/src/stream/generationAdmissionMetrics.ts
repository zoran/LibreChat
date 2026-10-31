/** generationAdmissionMetrics counts closed acquisition refusals in the existing App registry. */
import { Counter } from 'prom-client';
import type { GenerationAdmissionFailureCode } from '@librechat/data-schemas';
import type { Registry } from 'prom-client';

/** Both refusal producers and their observer share this closed diagnostic contract. */
export type GenerationAdmissionRefusalReason = GenerationAdmissionFailureCode | 'ALREADY_ADMITTED';

const reasons: readonly GenerationAdmissionRefusalReason[] = [
  'INVALID_INPUT',
  'REQUEST_CONFLICT',
  'CONVERSATION_ACTIVE',
  'HELD',
  'OUTCOME_UNKNOWN',
  'ALREADY_ADMITTED',
];
const allowedReasons = new Set<unknown>(reasons);
let record: (reason: GenerationAdmissionRefusalReason) => void = () => {};

/** Registry lifecycle also disables old sinks; observations never change admission or custody. */
export function attachGenerationAdmissionMetrics(registry?: Registry): void {
  record = () => {};
  if (!registry) return;
  const refused = new Counter({
    name: 'cortex_generation_admission_refusals_total',
    help: 'Closed durable generation acquisition refusals; not a full chat readiness proof',
    labelNames: ['stage', 'reason'] as const,
    registers: [registry],
  });
  for (const reason of reasons) refused.inc({ stage: 'acquire', reason }, 0);
  record = (reason) => {
    if (allowedReasons.has(reason)) refused.inc({ stage: 'acquire', reason });
  };
}

/** No identifiers, error messages, input values or arbitrary labels enter the metric. */
export function recordGenerationAdmissionRefusal(reason: GenerationAdmissionRefusalReason): void {
  record(reason);
}
