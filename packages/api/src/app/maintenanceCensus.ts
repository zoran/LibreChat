/** Maintenance observation arithmetic only; original work and admission stay with their owners. */
export interface ApplicationWorkCensus {
  admissionClosed: boolean;
  queuedContinuations: number;
  pendingWrites: number;
  complete: boolean;
}
export type ExternalApplicationWorkCensus = Pick<
  ApplicationWorkCensus,
  'queuedContinuations' | 'pendingWrites' | 'complete'
>;
export interface ApplicationWorkPort {
  pauseAdmissions(requestId: string): boolean;
  resumeAdmissions(requestId: string): boolean;
  getMaintenanceCensus(requestId: string | null): Promise<ApplicationWorkCensus>;
}

/** Generation reports only its own durable admissions, descendants and original persistence. */
export interface GenerationMaintenanceCensus {
  admissionClosed: boolean;
  initializing: number;
  providerExecutions: number;
  queuedContinuations: number;
  pendingWrites: number;
  activeStreams: number;
  unresolved: number;
  complete: boolean;
}

export const MAINTENANCE_COUNTERS = [
  'initializing',
  'providerExecutions',
  'queuedContinuations',
  'pendingWrites',
  'activeStreams',
  'unresolved',
] as const;
export type MaintenanceOwnerSample = readonly [name: string, census: unknown];
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

/** An explicit empty selection declares no File coverage; it never creates an empty proof. */
export function captureFileDomainOwners(
  names: readonly string[],
  owners: readonly (readonly [string, ApplicationWorkPort])[],
): ReadonlySet<string> {
  const registered = new Set(owners.map(([name]) => name));
  if (
    !Array.isArray(names) ||
    [...names].some((name) => typeof name !== 'string' || !registered.has(name)) ||
    new Set(names).size !== names.length
  )
    throw new Error('Invalid File-domain maintenance configuration');
  return new Set(names);
}

/** Project one already-sampled owner set; global and File facts never resample or re-register it. */
export function aggregateMaintenanceOwners(
  samples: readonly MaintenanceOwnerSample[],
  closed: boolean,
  declared: boolean,
  selected?: ReadonlySet<string>,
): ExternalApplicationWorkCensus {
  let queuedContinuations = 0;
  let pendingWrites = 0;
  let complete = declared;
  for (const [name, sample] of samples) {
    if (selected && !selected.has(name)) continue;
    if (
      !object(sample) ||
      !exactKeys(sample, ['admissionClosed', 'queuedContinuations', 'pendingWrites', 'complete']) ||
      typeof sample.complete !== 'boolean' ||
      sample.admissionClosed !== closed ||
      !count(sample.queuedContinuations) ||
      !count(sample.pendingWrites)
    ) {
      complete = false;
      continue;
    }
    queuedContinuations += sample.queuedContinuations;
    pendingWrites += sample.pendingWrites;
    complete &&= sample.complete;
  }
  if (!count(queuedContinuations) || !count(pendingWrites))
    return { queuedContinuations: 0, pendingWrites: 0, complete: false };
  return { queuedContinuations, pendingWrites, complete };
}

/** A current qualified census contains generation once and each selected owner once. */
export function composeMaintenanceCensus(
  generation: unknown,
  external: ExternalApplicationWorkCensus,
  closed: boolean,
  current: boolean,
): GenerationMaintenanceCensus | null {
  if (
    !current ||
    !object(generation) ||
    !exactKeys(generation, ['admissionClosed', 'complete', ...MAINTENANCE_COUNTERS]) ||
    generation.admissionClosed !== closed ||
    generation.complete !== true ||
    !MAINTENANCE_COUNTERS.every((key) => count(generation[key])) ||
    !external.complete
  )
    return null;
  const queuedContinuations = Number(generation.queuedContinuations) + external.queuedContinuations;
  const pendingWrites = Number(generation.pendingWrites) + external.pendingWrites;
  if (!count(queuedContinuations) || !count(pendingWrites)) return null;
  return {
    admissionClosed: closed,
    initializing: Number(generation.initializing),
    providerExecutions: Number(generation.providerExecutions),
    queuedContinuations,
    pendingWrites,
    activeStreams: Number(generation.activeStreams),
    unresolved: Number(generation.unresolved),
    complete: true,
  };
}
