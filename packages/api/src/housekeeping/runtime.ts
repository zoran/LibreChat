/** Local custody and finite admission for distributed owner-fenced work; no database or transport creation. */
import { HOUSEKEEPING_HANDLERS } from 'librechat-data-provider';
import type {
  HousekeepingHandler,
  HousekeepingRepository,
  JobClaim,
  JobOwnership,
  StepOutcome,
  WorkerIdentity,
} from '@librechat/data-schemas';
import type { StatusHousekeepingInstance } from 'librechat-data-provider';
import type { ApplicationWorkPort } from '../app/maintenance';
import type { HousekeepingHandlers } from './handlers';
import { HOUSEKEEPING_POLICY as policy, housekeepingIdentity } from './config';

export interface HousekeepingClock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
export type HousekeepingObservation = Readonly<
  Pick<StatusHousekeepingInstance, 'lifecycle' | 'admitting' | 'activeWorkCount'> & {
    identity: WorkerIdentity;
  }
>;
export type HousekeepingDrain = Readonly<{
  state: 'closed' | 'unresolved';
  activeWorkCount: number;
  pendingPromises: number;
  unknownEffects: boolean;
}>;
export interface HousekeepingRuntime extends ApplicationWorkPort {
  start(): void;
  observe(): HousekeepingObservation;
  /** The first drain owns its deadline. Timeout never grants resource-close or remote-stop authority. */
  drain(): Promise<HousekeepingDrain>;
}
export interface HousekeepingRuntimeDependencies {
  identity: WorkerIdentity;
  repository: HousekeepingRepository;
  handlers: HousekeepingHandlers;
  /** Closes only resources this composition owns, after original work has settled. */
  close(signal: AbortSignal): Promise<void>;
  clock?: HousekeepingClock;
}
const sameWorker = (a: WorkerIdentity, b: WorkerIdentity) =>
  a.podUid === b.podUid &&
  a.incarnation === b.incarnation &&
  a.source === b.source &&
  a.hostId === b.hostId;
const ownership = (claim: JobClaim): JobOwnership =>
  Object.freeze({
    jobId: claim.jobId,
    worker: claim.worker,
    claimId: claim.claimId,
    fence: claim.fence,
  });
const sameClaim = (a: JobClaim, b: JobClaim) =>
  a.jobId === b.jobId &&
  a.claimId === b.claimId &&
  a.fence === b.fence &&
  a.executionId === b.executionId &&
  sameWorker(a.worker, b.worker);

export function createHousekeepingRuntime(
  deps: HousekeepingRuntimeDependencies,
): HousekeepingRuntime {
  const identity = housekeepingIdentity(deps.identity);
  const clock: HousekeepingClock = deps.clock ?? {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => clearTimeout(timer),
  };
  const pending = new Set<Promise<unknown>>();
  const waiters = new Set<() => void>();
  const cursors = new Map<HousekeepingHandler, string | null>();
  let started = false;
  let paused: string | null = null;
  let draining = false;
  let closed = false;
  let admissionFault = false;
  let unknownEffects = false;
  let slot = false;
  let controller: AbortController | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let drainPromise: Promise<HousekeepingDrain> | undefined;
  let next =
    [...identity.incarnation].reduce((sum, char) => sum + char.charCodeAt(0), 0) %
    HOUSEKEEPING_HANDLERS.length;
  const admitting = () => started && !paused && !draining && !closed && !admissionFault;
  const notify = () => {
    for (const waiter of [...waiters]) waiter();
  };
  const cancelPoll = () => {
    if (pollTimer !== undefined) clock.clearTimeout(pollTimer);
    pollTimer = undefined;
  };
  const uncertain = () => {
    unknownEffects = true;
    controller?.abort();
  };

  /** Timers request cancellation. Only the original promise's settlement releases local custody. */
  function own<T>(
    operation: () => Promise<T>,
    milliseconds: number,
    timeout: () => void,
  ): Promise<T> {
    const original = Promise.resolve().then(operation);
    pending.add(original);
    const timer = clock.setTimeout(timeout, milliseconds);
    return original.finally(() => {
      clock.clearTimeout(timer);
      pending.delete(original);
      notify();
    });
  }
  const query = <T>(operation: () => Promise<T>) =>
    own(operation, policy.queryMs, () => controller?.abort());
  function schedule(delay: number = policy.pollMs): void {
    if (!admitting() || slot || pollTimer !== undefined) return;
    pollTimer = clock.setTimeout(() => {
      pollTimer = undefined;
      void cycle();
    }, delay);
  }
  async function inspectUnknown(claim: JobClaim): Promise<void> {
    controller?.abort();
    try {
      const observed = await query(() => deps.repository.inspect(claim.jobId, claim.executionId));
      if (
        observed.state === 'observed' &&
        observed.jobId === claim.jobId &&
        observed.executionId === claim.executionId &&
        ['waiting', 'unknown', 'settled', 'superseded', 'missed'].includes(observed.jobState)
      ) {
        // This owner's exact durable handoff is not remote-stop or domain-completion evidence.
        // Every original local promise still belongs to the census and must settle before close.
        return;
      }
    } catch {
      /* Keep an unconfirmed persistence handoff unresolved. */
    }
    // Never clear an earlier execution's uncertainty because a different job made progress.
    unknownEffects = true;
  }
  async function dispose(claim: JobClaim, outcome: StepOutcome): Promise<void> {
    switch (outcome.state) {
      case 'settled':
      case 'superseded':
        return;
      case 'unknown':
      case 'lost':
        return inspectUnknown(claim);
      case 'progress':
      case 'pending':
      case 'retry': {
        const code = 'code' in outcome ? outcome.code : 'owner_pending';
        try {
          if ((await query(() => deps.repository.defer(claim, code))) !== 'recorded')
            await inspectUnknown(claim);
        } catch {
          await inspectUnknown(claim);
        }
      }
    }
  }
  async function release(claim: JobClaim): Promise<void> {
    try {
      if ((await query(() => deps.repository.releaseUnstarted(claim))) !== 'recorded')
        await inspectUnknown(claim);
    } catch {
      await inspectUnknown(claim);
    }
  }
  async function execute(claim: JobClaim, signal: AbortSignal): Promise<void> {
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: Promise<void> | undefined;
    let executing = true;
    const beat = () => {
      if (!executing || signal.aborted) return;
      heartbeatTimer = clock.setTimeout(() => {
        heartbeatTimer = undefined;
        heartbeat = (async () => {
          try {
            const renewed = await query(() => deps.repository.renew(ownership(claim)));
            if (
              !renewed ||
              !sameClaim(claim, renewed) ||
              !Number.isFinite(Date.parse(renewed.leaseUntil)) ||
              Date.parse(renewed.leaseUntil) <= clock.now()
            )
              await inspectUnknown(claim);
          } catch {
            await inspectUnknown(claim);
          }
          if (executing && !signal.aborted) beat();
        })();
      }, policy.heartbeatMs);
    };
    beat();
    try {
      const outcome = await own(
        () => deps.handlers[claim.work.handler](claim, signal),
        policy.stepMs,
        () => controller?.abort(),
      );
      await dispose(claim, outcome);
    } catch {
      await inspectUnknown(claim);
    } finally {
      executing = false;
      if (heartbeatTimer !== undefined) clock.clearTimeout(heartbeatTimer);
      await heartbeat;
    }
  }
  async function cycle(): Promise<void> {
    if (!admitting() || slot) return;
    slot = true; // Reserve before discovery/claim; never preclaim into an in-memory queue.
    controller = new AbortController();
    const signal = controller.signal;
    try {
      for (
        let count = 0;
        count < HOUSEKEEPING_HANDLERS.length && admitting() && !signal.aborted;
        count++
      ) {
        const handler = HOUSEKEEPING_HANDLERS[next];
        next = (next + 1) % HOUSEKEEPING_HANDLERS.length;
        try {
          const page = await query(() =>
            deps.repository.discover(handler, cursors.get(handler) ?? null),
          );
          if (
            !Number.isSafeInteger(page.scanned) ||
            page.scanned < 0 ||
            page.scanned > policy.candidatePage ||
            typeof page.complete !== 'boolean' ||
            (page.cursor !== null && (typeof page.cursor !== 'string' || page.cursor.length > 512))
          )
            throw new Error('Invalid discovery page');
          cursors.set(handler, page.cursor);
        } catch {
          continue;
        }
        if (!admitting() || signal.aborted) break;
        let claim: JobClaim | null;
        try {
          claim = await query(() => deps.repository.claimNext(handler, identity));
        } catch {
          uncertain();
          admissionFault = true;
          break;
        }
        if (!claim) continue;
        if (claim.work.handler !== handler || !sameWorker(identity, claim.worker)) {
          uncertain();
          admissionFault = true;
          break;
        }
        if (
          !admitting() ||
          signal.aborted ||
          !Number.isFinite(Date.parse(claim.leaseUntil)) ||
          Date.parse(claim.leaseUntil) - clock.now() < policy.stepMs + policy.acknowledgementMs
        ) {
          await release(claim);
          break;
        }
        await execute(claim, signal);
        break;
      }
    } catch {
      uncertain();
      admissionFault = true;
    } finally {
      controller = undefined;
      slot = false;
      notify();
      schedule();
    }
  }
  const quiescent = () => !slot && pending.size === 0;
  function waitForSettlement(milliseconds: number): Promise<boolean> {
    if (quiescent()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (settled: boolean) => {
        clock.clearTimeout(timer);
        waiters.delete(check);
        resolve(settled);
      };
      const check = () => {
        if (quiescent()) finish(true);
      };
      const timer = clock.setTimeout(() => finish(false), Math.max(0, milliseconds));
      waiters.add(check);
      check();
    });
  }
  const result = (): HousekeepingDrain =>
    Object.freeze({
      state: closed ? 'closed' : 'unresolved',
      activeWorkCount: slot ? 1 : 0,
      pendingPromises: pending.size,
      unknownEffects,
    });
  async function drain(): Promise<HousekeepingDrain> {
    const deadline = clock.now() + policy.drainMs;
    if (!(await waitForSettlement(policy.drainMs - policy.closeReserveMs)) || unknownEffects)
      return result();
    const closeController = new AbortController();
    // Even when work drains immediately, the close call receives only its own reserved budget.
    const budget = Math.min(policy.closeReserveMs, deadline - clock.now());
    void own(
      async () => {
        try {
          await deps.close(closeController.signal);
          closed = true;
        } catch {
          unknownEffects = true;
        }
      },
      budget,
      () => closeController.abort(),
    );
    await waitForSettlement(budget);
    return result();
  }
  return Object.freeze({
    start() {
      if (started || draining || closed) return;
      started = true;
      schedule(0);
    },
    observe: (): HousekeepingObservation => {
      let lifecycle: HousekeepingObservation['lifecycle'] = 'starting';
      if (admitting()) lifecycle = 'ready';
      if (admissionFault) lifecycle = 'unknown';
      if (draining || paused) lifecycle = 'draining';
      if (closed) lifecycle = 'stopped';
      return Object.freeze({
        identity,
        lifecycle,
        admitting: admitting(),
        activeWorkCount: slot ? 1 : 0,
      });
    },
    pauseAdmissions(requestId: string) {
      if (!requestId || (paused !== null && paused !== requestId) || draining || closed)
        return false;
      paused = requestId;
      cancelPoll();
      controller?.abort();
      return true;
    },
    resumeAdmissions(requestId: string) {
      if (paused !== requestId || draining || closed || admissionFault) return false;
      paused = null;
      schedule(0);
      return true;
    },
    async getMaintenanceCensus(requestId: string | null) {
      return {
        admissionClosed: !admitting(),
        queuedContinuations: slot ? 1 : 0,
        pendingWrites: pending.size,
        complete: !unknownEffects && (requestId === null || requestId === paused),
      };
    },
    drain() {
      if (!drainPromise) {
        draining = true;
        cancelPoll();
        controller?.abort();
        drainPromise = drain();
      }
      return drainPromise;
    },
  });
}
