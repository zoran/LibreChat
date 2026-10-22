/** Bounded, read-only Housekeeping projection. No claims, scheduling or execution authority. */
import { z } from 'zod';

/** The sole handler registry, shared with the domain/worker implementation. */
export const HOUSEKEEPING_HANDLERS = Object.freeze([
  'file.warning',
  'file.cleanup',
  'upload.cleanup',
] as const);
export type HousekeepingHandler = (typeof HOUSEKEEPING_HANDLERS)[number];
export const STATUS_HOUSEKEEPING_LIMITS = Object.freeze({
  maxSlots: 128,
  maxInstancesPerSlot: 2,
  maxAgeSeconds: 90,
});

const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const token = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9_.-]+$/);
const time = z.number().finite().min(0).max(8640000000000);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const coverage = z
  .object({
    expected: z.number().int().min(0).max(1000000).nullable(),
    observed: z.number().int().min(0).max(1000000),
  })
  .strict()
  .refine((v) => v.expected === null || v.observed <= v.expected, 'invalid coverage');
const observation = z
  .object({
    state: z.enum(['fresh', 'stale', 'unknown', 'unavailable', 'disagreement']),
    reason: z.enum([
      'observed',
      'partial_coverage',
      'not_measured',
      'source_unavailable',
      'source_stale',
      'sources_disagree',
    ]),
    evidence: z
      .array(
        z
          .object({
            sourceId: token,
            observedAt: time,
            maxAgeSeconds: z.literal(90),
            coverage,
          })
          .strict(),
      )
      .max(2),
  })
  .strict();
const instance = z
  .object({
    runtimeNodeId: id,
    lifecycle: z.enum(['unknown', 'starting', 'ready', 'draining', 'stopped']),
    admitting: z.boolean().nullable(),
    activeWorkCount: count.nullable(),
  })
  .strict();
const handlerValues = z
  .object({
    pendingCount: count.nullable(),
    overdueCount: count.nullable(),
    oldestOverdueSeconds: z.number().finite().nonnegative().max(8640000000000).nullable(),
    activeClaimsCount: count.nullable(),
    expiredClaimsCount: count.nullable(),
    notificationUnknownCount: count.nullable(),
    recoveredClaimsCount: count.nullable(),
    lastRecoveryAt: time.nullable(),
  })
  .strict();
const handler = z
  .object({
    handler: z.enum(HOUSEKEEPING_HANDLERS),
    quality: z.enum(['complete', 'partial', 'unknown']),
    coverage,
    values: handlerValues,
  })
  .strict();
const domainShape = z
  .object({
    observation,
    handlers: z.array(handler).length(HOUSEKEEPING_HANDLERS.length),
  })
  .strict();

function coherentDomain(domain: z.infer<typeof domainShape>): boolean {
  const { state, reason, evidence } = domain.observation;
  if (state === 'unknown' || state === 'unavailable') {
    if (
      evidence.length !== 0 ||
      reason !== (state === 'unknown' ? 'not_measured' : 'source_unavailable')
    )
      return false;
  } else if (
    state === 'disagreement' ||
    evidence.length !== 1 ||
    evidence[0].coverage.observed < 1 ||
    (state === 'fresh' && !['observed', 'partial_coverage'].includes(reason)) ||
    (state === 'stale' && reason !== 'source_stale')
  )
    return false;
  if (new Set(domain.handlers.map((row) => row.handler)).size !== HOUSEKEEPING_HANDLERS.length)
    return false;
  const domainAt = domain.observation.evidence[0]?.observedAt;
  for (const row of domain.handlers) {
    if (row.quality === 'unknown') {
      if (
        row.coverage.expected !== null ||
        row.coverage.observed !== 0 ||
        Object.values(row.values).some((v) => v !== null)
      )
        return false;
      continue;
    }
    if (
      domainAt === undefined ||
      row.coverage.observed < 1 ||
      (row.quality === 'complete') !== complete(row.coverage)
    )
      return false;
    const v = row.values;
    if (
      v.pendingCount === null ||
      v.overdueCount === null ||
      v.oldestOverdueSeconds === null ||
      v.activeClaimsCount === null ||
      v.expiredClaimsCount === null ||
      v.notificationUnknownCount === null ||
      v.overdueCount > v.pendingCount ||
      (v.overdueCount === 0 && v.oldestOverdueSeconds !== 0) ||
      (v.lastRecoveryAt !== null &&
        (v.lastRecoveryAt > domainAt ||
          v.recoveredClaimsCount === null ||
          v.recoveredClaimsCount < 1))
    )
      return false;
  }
  const knownRows = domain.handlers.filter((row) => row.quality !== 'unknown');
  if (domain.observation.state === 'fresh') {
    const full =
      complete(domain.observation.evidence[0].coverage) &&
      domain.handlers.every((row) => row.quality === 'complete');
    if (knownRows.length === 0 || (domain.observation.reason === 'observed') !== full) return false;
  } else if (['unknown', 'unavailable'].includes(domain.observation.state) && knownRows.length > 0)
    return false;
  return true;
}

export const housekeepingShape = z
  .object({
    serviceNodeId: id,
    slots: z
      .array(
        z
          .object({
            hostNodeId: id,
            presence: z.enum(['present', 'absent', 'unknown']),
            observation,
            instances: z.array(instance).max(STATUS_HOUSEKEEPING_LIMITS.maxInstancesPerSlot),
          })
          .strict(),
      )
      .min(1)
      .max(STATUS_HOUSEKEEPING_LIMITS.maxSlots),
    domain: domainShape.refine(coherentDomain, 'invalid Housekeeping domain'),
  })
  .strict();
export type StatusHousekeeping = z.infer<typeof housekeepingShape>;
export type StatusHousekeepingObservation = z.infer<typeof observation>;
export type StatusHousekeepingInstance = z.infer<typeof instance>;
export type StatusHousekeepingSlot = StatusHousekeeping['slots'][number];
/** Partial counts are observed-scope lower bounds at the domain observation time, never complete
 * fleet totals or healthy evidence. Display partial/≥ with age. Stale partial values are historical
 * observations, not current lower bounds. Unknown/unavailable rows contain only null values.
 * pendingCount covers outstanding eligible work (including claimed work); overdueCount is its
 * past-due subset. Recovery values require durable evidence; missing history remains null.
 */
export type StatusHousekeepingHandler = z.infer<typeof handler>;

const complete = (v: { expected: number | null; observed: number }) =>
  v.expected !== null && v.expected > 0 && v.observed === v.expected;
const unknownObservation = (): StatusHousekeepingObservation => ({
  state: 'unknown',
  reason: 'not_measured',
  evidence: [],
});
const unknownValues = (): StatusHousekeepingHandler['values'] => ({
  pendingCount: null,
  overdueCount: null,
  oldestOverdueSeconds: null,
  activeClaimsCount: null,
  expiredClaimsCount: null,
  notificationUnknownCount: null,
  recoveredClaimsCount: null,
  lastRecoveryAt: null,
});

/** Preserve desired inventory while awaiting observation; this never asserts absence or zero work. */
export function createUnknownStatusHousekeeping(
  serviceNodeId: string,
  hostNodeIds: readonly string[],
): StatusHousekeeping {
  if (new Set(hostNodeIds).size !== hostNodeIds.length) throw new Error('STATUS_DTO_INVALID');
  return housekeepingShape.parse({
    serviceNodeId,
    slots: hostNodeIds.map((hostNodeId) => ({
      hostNodeId,
      presence: 'unknown',
      observation: unknownObservation(),
      instances: [],
    })),
    domain: {
      observation: unknownObservation(),
      handlers: HOUSEKEEPING_HANDLERS.map((handler) => ({
        handler,
        quality: 'unknown',
        coverage: { expected: null, observed: 0 },
        values: unknownValues(),
      })),
    },
  });
}

/** Age at the caller's snapshot/render clock. Last observed values remain visible only as stale. */
export function ageStatusHousekeeping(
  value: StatusHousekeeping | null,
  now: number,
): StatusHousekeeping | null {
  if (!Number.isFinite(now) || now < 0) throw new Error('STATUS_DTO_INVALID');
  if (value === null) return null;
  const copy = housekeepingShape.parse(value);
  for (const item of [copy.domain.observation, ...copy.slots.map((slot) => slot.observation)]) {
    if (
      (item.state === 'fresh' || item.state === 'disagreement') &&
      item.evidence.some((e) => now - e.observedAt > e.maxAgeSeconds)
    ) {
      item.state = 'stale';
      item.reason = 'source_stale';
    }
  }
  return copy;
}
