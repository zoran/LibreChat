import type { UploadProcessingDependencies } from './processing/run';
import type { UploadAttemptPort } from './contract';
import type { ApplicationWorkPort } from '~/app';
import { processNextManagedUpload } from './processing/run';
import { createUploadAttemptJournal } from './attempts';

export interface UploadWorkers {
  attempts: UploadAttemptPort;
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

/** Compose the common attempt journal with one processing loop; File retention schedules cleanup. */
export function createUploadWorkers(options: {
  processing: UploadProcessingDependencies;
  runAsSystem<T>(work: () => Promise<T>): Promise<T>;
  idleMs?: number;
  onError?: () => void;
}): UploadWorkers {
  const idleMs = options.idleMs ?? 1_000;
  if (!Number.isSafeInteger(idleMs) || idleMs < 10 || idleMs > 60_000)
    throw new Error('Invalid upload worker interval');
  const journal = createUploadAttemptJournal(options.processing.worker);
  const { attempts } = journal;
  let pausedBy: string | null = null;
  let closed = false;
  let started = false;
  let uncertain = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let processingAbort: AbortController | undefined;

  const schedule = () => {
    if (!started || closed || pausedBy !== null || running || timer) return;
    timer = setTimeout(tick, idleMs);
    timer.unref();
  };
  const tick = () => {
    timer = undefined;
    if (closed || pausedBy !== null || running) return;
    processingAbort = new AbortController();
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
        () => undefined,
        () => {
          uncertain = true;
          try {
            options.onError?.();
          } catch {
            /* diagnostic only */
          }
        },
      )
      .finally(() => {
        running = undefined;
        processingAbort = undefined;
        schedule();
      });
  };
  const maintenance: ApplicationWorkPort = {
    pauseAdmissions(requestId) {
      if (!journal.maintenance.pauseAdmissions(requestId)) return false;
      pausedBy = requestId;
      clearTimeout(timer);
      timer = undefined;
      return true;
    },
    resumeAdmissions(requestId) {
      if (uncertain || !journal.maintenance.resumeAdmissions(requestId)) return false;
      pausedBy = null;
      schedule();
      return true;
    },
    async getMaintenanceCensus(requestId) {
      const processingQueued = running ? 1 : 0;
      const processingComplete = !uncertain;
      const census = await journal.maintenance.getMaintenanceCensus(requestId);
      return {
        ...census,
        queuedContinuations: census.queuedContinuations + processingQueued,
        complete: census.complete && processingComplete,
      };
    },
  };
  return {
    attempts,
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
      const draining = journal.close(signal);
      try {
        const [, result] = await withinSignal(Promise.all([running, draining]), signal);
        return { complete: result.complete && !uncertain };
      } catch {
        return { complete: false };
      }
    },
  };
}
