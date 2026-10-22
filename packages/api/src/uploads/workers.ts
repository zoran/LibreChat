/** Processing admission and exact local actor settlement share one journal and bounded loop. */
import type { UploadActorSettlement, UploadActorSettlementOptions } from './actorSettlement';
import type { UploadProcessingDependencies } from './processing/run';
import type { UploadAttemptPort } from './contract';
import type { ApplicationWorkPort } from '~/app';
import { createUploadActorSettlement } from './actorSettlement';
import { processNextManagedUpload } from './processing/run';
import { createUploadAttemptJournal } from './attempts';

export interface UploadWorkers {
  attempts: UploadAttemptPort;
  settlement: UploadActorSettlement;
  maintenance: ApplicationWorkPort;
  start(): void;
  close(signal?: AbortSignal): Promise<{ complete: boolean }>;
}

async function withinSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Upload work drain interrupted'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** File/Housekeeping owns policy; this loop only settles this process's persisted actor requests. */
export function createUploadWorkers(options: {
  processing: UploadProcessingDependencies;
  settlement: Pick<UploadActorSettlementOptions, 'repository' | 'security'>;
  runAsSystem<T>(work: () => Promise<T>): Promise<T>;
  idleMs?: number;
  onError?: () => void;
}): UploadWorkers {
  const idleMs = options.idleMs ?? 1_000;
  if (!Number.isSafeInteger(idleMs) || idleMs < 10 || idleMs > 60_000)
    throw new Error('Invalid upload worker interval');
  const journal = createUploadAttemptJournal(options.processing.worker);
  const { attempts } = journal;
  const settlement = createUploadActorSettlement({
    ...options.settlement,
    documents: options.processing.documents,
    worker: options.processing.worker,
    stagingRoot: options.processing.stagingRoot,
    now: options.processing.now,
    attempts,
  });
  let pausedBy: string | null = null;
  let closed = false;
  let started = false;
  let uncertain = false;
  let actorPending = false;
  let pauseGeneration = 0;
  let emptyPauseGeneration = 0;
  let nextProcessingAt = 0;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let processingAbort: AbortController | undefined;
  let settlementFlight:
    | Promise<Awaited<ReturnType<UploadActorSettlement['reconcile']>>>
    | undefined;
  let tickFlight: Promise<void> | undefined;
  let tickAgain = false;
  const diagnostic = () => {
    try {
      options.onError?.();
    } catch {
      /* diagnostic only */
    }
  };
  const reconcile = (signal: AbortSignal) => {
    if (settlementFlight) return settlementFlight;
    const generation = pauseGeneration;
    const pause = pausedBy;
    settlementFlight = Promise.resolve()
      .then(async () => {
        const local = await journal.maintenance.getMaintenanceCensus(pause);
        const drained =
          !running &&
          local.complete &&
          local.queuedContinuations === 0 &&
          local.pendingWrites === 0;
        const result = await options.runAsSystem(() => settlement.reconcile(signal));
        // An old query or one begun during drain cannot certify the current pause.
        if (
          pause !== null &&
          pause === pausedBy &&
          generation === pauseGeneration &&
          drained &&
          result.scanned === 0 &&
          result.pending === 0
        )
          emptyPauseGeneration = generation;
        return result;
      })
      .then(
        (result) => {
          actorPending = result.pending > 0;
          return result;
        },
        (error) => {
          actorPending = true;
          diagnostic();
          throw error;
        },
      )
      .finally(() => {
        settlementFlight = undefined;
      });
    return settlementFlight;
  };
  const schedule = (immediate = false) => {
    if (!started || closed) return;
    if (tickFlight) {
      tickAgain ||= immediate;
      return;
    }
    if (timer && !immediate) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, immediate ? 0 : idleMs);
    timer.unref();
  };
  const process = () => {
    if (closed || pausedBy !== null || running || Date.now() < nextProcessingAt) return;
    processingAbort = new AbortController();
    let attempted = false;
    running = Promise.resolve()
      .then(() =>
        options.runAsSystem(() => {
          if (closed || pausedBy !== null) return Promise.resolve({ claimed: false });
          return processNextManagedUpload(
            { ...options.processing, attempts },
            processingAbort!.signal,
          );
        }),
      )
      .then(
        (result) => {
          attempted = result.claimed;
        },
        () => {
          attempted = true;
          uncertain = true;
          diagnostic();
        },
      )
      .finally(() => {
        running = undefined;
        processingAbort = undefined;
        nextProcessingAt = Date.now() + idleMs;
        // The next pass settles a lost acknowledgement before any new processing claim.
        schedule(attempted);
      });
  };
  const tick = () => {
    timer = undefined;
    if (closed || tickFlight) return;
    tickFlight = reconcile(AbortSignal.timeout(5_000))
      .then(
        () => {
          process();
        },
        () => undefined,
      )
      .finally(() => {
        tickFlight = undefined;
        const immediate = tickAgain;
        tickAgain = false;
        schedule(immediate);
      });
  };
  const maintenance: ApplicationWorkPort = {
    pauseAdmissions(requestId) {
      if (!journal.maintenance.pauseAdmissions(requestId)) return false;
      if (pausedBy !== requestId) pauseGeneration++;
      pausedBy = requestId;
      // Recovery continues while admissions are paused; no new processing claim is made.
      schedule();
      return true;
    },
    resumeAdmissions(requestId) {
      if (uncertain || !journal.maintenance.resumeAdmissions(requestId)) return false;
      pausedBy = null;
      schedule();
      return true;
    },
    async getMaintenanceCensus(requestId) {
      const census = await journal.maintenance.getMaintenanceCensus(requestId);
      return {
        ...census,
        queuedContinuations:
          census.queuedContinuations + (running ? 1 : 0) + (settlementFlight ? 1 : 0),
        complete:
          census.complete &&
          !uncertain &&
          !actorPending &&
          !settlementFlight &&
          (pausedBy === null || emptyPauseGeneration === pauseGeneration),
      };
    },
  };
  return {
    attempts,
    settlement,
    maintenance,
    start() {
      if (started || closed) return;
      started = true;
      schedule();
    },
    async close(signal: AbortSignal = AbortSignal.timeout(125_000)) {
      closed = true;
      clearTimeout(timer);
      timer = undefined;
      processingAbort?.abort();
      try {
        await withinSignal(Promise.all([running, tickFlight, journal.close(signal)]), signal);
        // One empty query proves the bounded pages are drained. Unknown effects do not spin.
        let result = await withinSignal(reconcile(signal), signal);
        for (let page = 0; result.pending && result.settled > 0 && page < 16; page++)
          result = await withinSignal(reconcile(signal), signal);
        const local = await withinSignal(journal.close(signal), signal);
        return { complete: local.complete && !uncertain && !actorPending && !settlementFlight };
      } catch {
        return { complete: false };
      }
    },
  };
}
