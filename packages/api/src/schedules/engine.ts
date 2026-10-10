import { logger, runAsSystem } from '@librechat/data-schemas';
import type { ScheduleEngineDeps } from './types';
import type { ApplicationWorkPort } from '~/app';
import { isShutdownInProgress, registerShutdownTask } from '~/app/shutdown';
import { reconcileSchedules } from './reconciliation';
import { computeNextRunAt } from './cadence';
import { fireSchedule } from './fire';

const TICK_MS = 30_000;
const TICK_JITTER_MS = 2_000;
const LEASE_MS = 5 * 60_000;
// Occurrences due more than this long ago (server downtime / paused engine) are
// skipped forward instead of fired, so a restart doesn't burst stale chats.
const MISFIRE_GRACE_MS = 15 * 60_000;

export type ScheduleEngine = ApplicationWorkPort & {
  stop: () => void;
  /** Exposed for tests and the run-now handler: one full claim/fire pass. */
  runTick: () => Promise<number>;
  /** Exposed for tests: one awaitable reconciliation pass (the tick loop's is fire-and-forget). */
  reconcile: () => Promise<void>;
};

export function startScheduleEngine(
  deps: ScheduleEngineDeps,
  maintenanceRequestId?: string,
): ScheduleEngine {
  let pausedBy = maintenanceRequestId;
  let pending = 0;
  let unconfirmed = false;
  const observe = async <T>(run: () => Promise<T>): Promise<T> => {
    pending++;
    try {
      return await run();
    } catch (error) {
      unconfirmed = true;
      throw error;
    } finally {
      pending--;
    }
  };
  let stopped = false;
  const stopController = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let ticks = 0;
  const instanceId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  /**
   * One claim/fire pass. Claims and cross-tenant reconciliation run in a system
   * tenant context (the claim scans all tenants; strict tenant isolation would
   * otherwise throw on the unscoped query). The fire itself re-enters the
   * owner's context via `runInTenantContext`.
   */
  async function claimPass(): Promise<number> {
    // GLOBAL kill switch: stop claiming entirely. This is the operator's hard stop
    // (SCHEDULES_DISABLED, or `interface.schedules: false` in the BASE config), which
    // no principal override can widen — distinct from per-principal availability below.
    // Deliberately gates CLAIMS only; reconcile() is never gated, because in-flight
    // runs must still be settled while the feature is off or they strand `started`
    // rows and leak capacity forever.
    if (await deps.isGloballyDisabled()) {
      return 0;
    }
    // Do NOT gate claims on the per-principal `enabled`: schedules can be enabled per
    // user/role/tenant, so gating here would silently never fire those users'
    // occurrences. The fire path re-resolves the OWNER's limits and skips ('disabled')
    // any occurrence whose owner has the feature off, so an owner-scoped disable is
    // still honored. The base config only supplies the per-tick claim budget.
    const limits = await deps.getLimits();
    let fired = 0;
    // Admission has its own bounded pool. MCP readiness runs before a generation
    // slot is reserved, so slow external servers cannot make generation occupancy
    // suppress later healthy claims. The durable capacity allocator in fireSchedule
    // remains the cross-replica authority for actual generations.
    const budget = limits.admissionConcurrency;
    const fires: Promise<unknown>[] = [];
    for (let i = 0; i < budget && !pausedBy; i++) {
      // Claim + the fire's pre-owner-context bookkeeping (disable/advance,
      // cross-tenant reads) run as system; fireSchedule re-enters owner context
      // internally for the run-specific work.
      const schedule = await runAsSystem(() =>
        deps.methods.claimDueSchedule({ instanceId, leaseMs: LEASE_MS }),
      );
      if (schedule == null) {
        break;
      }
      if (pausedBy) {
        const released =
          schedule.claimToken != null &&
          (await deps.methods.releaseLease(schedule.id, schedule.claimToken));
        if (!released) unconfirmed = true;
        break;
      }
      // Start each admission as soon as its claim lands. MCP preflight is bounded but
      // can legitimately wait for its full deadline; awaiting it here used to hold the
      // claim loop and could push healthy schedules beyond the misfire grace window.
      // The claim budget still caps this batch, and the durable capacity allocator in
      // fireSchedule arbitrates against work started by concurrent engine replicas.
      fires.push(
        observe(() =>
          runAsSystem(async () => {
            const scheduledFor = schedule.nextRunAt ?? new Date();
            /**
             * Advances this claimed occurrence without preserving a superseded holder.
             * Owner edits rotate the token/next occurrence but intentionally leave the old
             * lease in place; a fenced miss therefore releases only this worker's unique
             * holder. Infrastructure errors keep the lease as retry backoff, as before.
             */
            const advanceClaim = async (nextRunAt: Date | null): Promise<void> => {
              try {
                const advanced = await deps.methods.advanceSchedule(
                  schedule.id,
                  nextRunAt,
                  scheduledFor,
                  schedule.claimToken,
                );
                if (!advanced && schedule.leaseBy != null) {
                  await deps.methods.releaseLeaseByHolder(schedule.id, schedule.leaseBy);
                }
              } catch {
                unconfirmed = true;
                // Leave the claim lease as bounded backoff for transient storage failures.
              }
            };
            // Use the CLAIM's clock for the misfire cutoff: the claim wrote
            // leaseUntil = now + LEASE_MS from the claiming worker's clock, so
            // leaseUntil - LEASE_MS is that worker's "now" at claim — usually this very
            // process, making cutoff and claim self-consistent. (DocumentDB rules out the
            // server-clock `$$NOW` CAS; skew between REPLICAS shifts fire timing by at
            // most the skew and can never double-fire — the lease CAS and the unique
            // occurrence index arbitrate that regardless of clocks.)
            const dbNow = schedule.leaseUntil
              ? schedule.leaseUntil.getTime() - LEASE_MS
              : Date.now();
            // Misfire skip-forward: an occurrence overdue past the grace window (the
            // engine was down/paused) is advanced to the next FUTURE occurrence
            // without firing, so a restart doesn't launch stale or bursty chats.
            if (dbNow - scheduledFor.getTime() > MISFIRE_GRACE_MS) {
              const next = computeNextRunAt({
                cadence: schedule.cadence,
                timezone: schedule.timezone,
                scheduleId: schedule.id,
                // The claim's own clock (see dbNow above): a clock-behind worker would
                // otherwise compute another already-due occurrence and reclaim the row.
                after: new Date(dbNow),
              });
              if (next == null) {
                // Uncomputable cadence is NOT transient, so this occurrence can never run.
                // The advance below would clear nextRunAt AND the lease; doing that after a
                // transiently failed disable would leave `enabled: true` with no nextRunAt
                // and no disabledReason, permanently unclaimable and invisible. Bail
                // instead: the lease expires and the occurrence is retried.
                const disabled = await deps.methods
                  .disableSchedule(schedule.id, 'invalid_schedule', schedule.claimToken)
                  .then(() => true)
                  .catch(() => {
                    unconfirmed = true;
                    return false;
                  });
                if (!disabled) {
                  return false;
                }
              }
              // The SKIP-FORWARD itself, and the whole point of this branch: move to the
              // next FUTURE occurrence. Without it nextRunAt keeps pointing at the stale
              // one, so every later tick reclaims and skips the same occurrence forever and
              // a schedule overdue past an outage never fires again.
              await advanceClaim(next);
              logger.info(
                `[schedules] skipped stale occurrence for ${schedule.id} (misfire grace)`,
              );
              return false;
            }
            try {
              const result = await fireSchedule(
                // The dispatch boundary observes shutdown from BOTH signals: the
                // coordinator flag flips before the listener starts closing (ahead of
                // any pre-drain task ordering), and the engine's own stop covers direct
                // runTick callers outside a coordinated shutdown.
                {
                  ...deps,
                  isShuttingDown: () => !!pausedBy || stopped || isShutdownInProgress(),
                  onUnconfirmedWork: () => {
                    unconfirmed = true;
                    deps.onUnconfirmedWork?.();
                  },
                },
                schedule,
                limits,
                scheduledFor,
                {
                  dbNow: new Date(dbNow),
                  signal: stopController.signal,
                },
              );
              if (result.fired) {
                fired += 1;
              }
            } catch (error) {
              unconfirmed = true;
              // A transient preflight throw (user/config/permission/balance/capacity query)
              // must NOT advance past this occurrence: advancing schedules the NEXT
              // recurrence, so the due one is discarded permanently with no ScheduleRun row
              // and no evidence it was ever attempted. Leave nextRunAt alone and keep the
              // claim lease as backoff — the lease expires and the SAME occurrence is
              // re-claimed and retried, matching how the fire path already treats a
              // transient file-resolution failure.
              logger.error(
                `[schedules] unexpected fire error for ${schedule.id} (will retry):`,
                error,
              );
              // An UNCOMPUTABLE cadence is the one non-transient case: retrying can never
              // make progress, and leaving the lease would re-claim the same occurrence
              // forever. Disable so it stops being due, and only then clear nextRunAt —
              // advancing on a failed disable would leave `enabled: true` with no nextRunAt
              // and no disabledReason (permanently unclaimable and invisible). Everything
              // else falls through untouched: nextRunAt and the lease both stand.
              const next = computeNextRunAt({
                cadence: schedule.cadence,
                timezone: schedule.timezone,
                scheduleId: schedule.id,
                // The claim's clock (see the misfire branch) so a skewed worker doesn't
                // reschedule to an already-due occurrence and reclaim the same row.
                after: new Date(dbNow),
              });
              if (next == null) {
                const disabled = await deps.methods
                  .disableSchedule(schedule.id, 'invalid_schedule', schedule.claimToken)
                  .then(() => true)
                  .catch(() => {
                    unconfirmed = true;
                    return false;
                  });
                if (disabled) {
                  await advanceClaim(null);
                }
              }
            }
          }),
        ),
      );
    }
    const results = await Promise.allSettled(fires);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected) {
      throw rejected.reason;
    }
    return fired;
  }

  const reconcile = (): Promise<void> =>
    pausedBy
      ? Promise.resolve()
      : observe(() =>
          reconcileSchedules(deps, () => {
            unconfirmed = true;
          }),
        );
  const runTick = (): Promise<number> => (pausedBy ? Promise.resolve(0) : observe(claimPass));

  const scheduleNext = () => {
    if (stopped || pausedBy) {
      return;
    }
    timer = setTimeout(tick, TICK_MS + Math.floor(Math.random() * TICK_JITTER_MS));
    timer.unref?.();
  };

  let activePass: Promise<void> | null = null;

  async function tick() {
    if (stopped || pausedBy) {
      return;
    }
    const pass = (async () => {
      try {
        if (ticks % 4 === 0) {
          await reconcile();
        }
        ticks += 1;
        await runTick();
      } catch (error) {
        unconfirmed = true;
        logger.error('[schedules] tick failed:', error);
      }
    })().finally(() => {
      activePass = null;
    });
    activePass = pass;
    await pass;
    scheduleNext();
  }

  void reconcile();
  scheduleNext();

  const engine: ScheduleEngine = {
    pauseAdmissions: (requestId) => {
      if (!requestId || (pausedBy && pausedBy !== requestId)) return false;
      pausedBy = requestId;
      if (timer) clearTimeout(timer);
      timer = undefined;
      return true;
    },
    resumeAdmissions: (requestId) => {
      if (pausedBy !== requestId || stopped || unconfirmed) return false;
      pausedBy = undefined;
      scheduleNext();
      return true;
    },
    getMaintenanceCensus: async (requestId) => ({
      admissionClosed: stopped || (!!requestId && pausedBy === requestId),
      queuedContinuations: pending,
      pendingWrites: pending,
      complete: !unconfirmed && (pausedBy == null || pausedBy === requestId),
    }),
    stop: () => {
      stopped = true;
      stopController.abort(new Error('Schedule engine stopped'));
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    runTick,
    reconcile,
  };

  // PRE-DRAIN: the default post-drain phase leaves this timer armed while the HTTP
  // listener is closing and the generation manager has already begun refusing new jobs.
  // A tick in that window claims a due occurrence, fails its loopback POST against a
  // server that is shutting down, and books the failure against the schedule — walking a
  // healthy schedule toward auto-disable for nothing more than a restart. Stopping the
  // timer alone only narrowed the window: a pass ALREADY in flight could still claim a
  // due occurrence and lose its loopback POST against the closing listener, so the
  // shutdown also AWAITS the active pass — the coordinator's drain then holds the
  // listener open until that pass's fire completes or its claim is released.
  // Occurrences skipped by stopping early are simply still due at restart, within the
  // misfire grace.
  registerShutdownTask(
    'schedule engine',
    async () => {
      engine.stop();
      if (activePass) {
        await activePass;
      }
    },
    { phase: 'pre-drain' },
  );

  logger.info('[schedules] engine started');
  return engine;
}
