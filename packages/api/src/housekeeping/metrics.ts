/** Local process observation only; the supplied App registry owns publication and lifecycle. */
import { Gauge } from 'prom-client';
import type { Registry } from 'prom-client';
import type { HousekeepingObservation } from './runtime';
import { housekeepingIdentity, HOUSEKEEPING_POLICY } from './config';

export interface HousekeepingMetrics {
  collect(): void;
  detach(): void;
}

/** No observation, timer, database access or process-global registry is created here. */
export function attachHousekeepingMetrics(
  registry: Registry,
  observe: () => HousekeepingObservation,
  now: () => number = Date.now,
): HousekeepingMetrics {
  const names = {
    info: 'cortex_housekeeping_instance_info',
    admitting: 'cortex_housekeeping_admitting',
    active: 'cortex_housekeeping_active_work_count',
    captured: 'cortex_housekeeping_observed_at_seconds',
  } as const;
  const lifecycles: Record<HousekeepingObservation['lifecycle'], boolean> = {
    unknown: false,
    starting: false,
    ready: true,
    draining: false,
    stopped: false,
  };
  const labels = ['worker_pod_uid', 'worker_node', 'source_revision', 'incarnation'] as const;
  const info = new Gauge({
    name: names.info,
    help: 'Housekeeping process identity and local lifecycle',
    labelNames: [...labels, 'lifecycle'],
    registers: [registry],
  });
  const admitting = new Gauge({
    name: names.admitting,
    help: 'Whether this Housekeeping process admits work',
    labelNames: labels,
    registers: [registry],
  });
  const active = new Gauge({
    name: names.active,
    help: 'Work slots retained by this Housekeeping process, not global claims',
    labelNames: labels,
    registers: [registry],
  });
  const captured = new Gauge({
    name: names.captured,
    help: 'Original capture time of this local Housekeeping observation',
    labelNames: labels,
    registers: [registry],
  });
  const metrics = [
    [names.info, info],
    [names.admitting, admitting],
    [names.active, active],
    [names.captured, captured],
  ] as const;
  const reset = (): void => {
    for (const [, metric] of metrics) metric.reset();
  };
  let detached = false;
  return {
    collect(): void {
      if (detached) throw new Error('HOUSEKEEPING_METRICS_DETACHED');
      reset();
      try {
        const value = observe();
        const at = now() / 1000;
        const identity = housekeepingIdentity(value.identity);
        const instance = value;
        if (
          !Number.isFinite(at) ||
          at < 0 ||
          at > 8640000000000 ||
          typeof instance.lifecycle !== 'string' ||
          !Object.prototype.hasOwnProperty.call(lifecycles, instance.lifecycle) ||
          typeof instance.admitting !== 'boolean' ||
          typeof instance.activeWorkCount !== 'number' ||
          !Number.isSafeInteger(instance.activeWorkCount) ||
          instance.activeWorkCount < 0 ||
          instance.activeWorkCount > HOUSEKEEPING_POLICY.concurrency ||
          (instance.lifecycle === 'ready' && !instance.admitting) ||
          (instance.lifecycle !== 'ready' && instance.admitting) ||
          (['starting', 'stopped'].includes(instance.lifecycle) && instance.activeWorkCount !== 0)
        )
          throw new Error('HOUSEKEEPING_METRICS_INVALID');
        const identityLabels = {
          worker_pod_uid: identity.podUid,
          worker_node: identity.hostId,
          source_revision: identity.source,
          incarnation: identity.incarnation,
        };
        info.set({ ...identityLabels, lifecycle: instance.lifecycle }, 1);
        admitting.set(identityLabels, Number(instance.admitting));
        active.set(identityLabels, instance.activeWorkCount);
        captured.set(identityLabels, at);
      } catch {
        reset();
        // Do not expose untrusted observations or arbitrary callback errors in logs.
        throw new Error('HOUSEKEEPING_METRICS_INVALID');
      }
    },
    detach(): void {
      if (detached) return;
      detached = true;
      reset();
      for (const [name, metric] of metrics) {
        if (registry.getSingleMetric(name) === metric) registry.removeSingleMetric(name);
      }
    },
  };
}
