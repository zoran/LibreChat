import type { UploadCleanupTask, UploadLease, UploadWorker } from 'librechat-data-provider';
import type { UploadAttemptSettlement, UploadAttemptPort } from './contract';
import type { UploadProcessingDependencies } from './processing/run';
import type { ApplicationWorkPort } from '~/app';
import { processNextManagedUpload } from './processing/run';
import { uploadAttemptId } from './processing/paths';
import { UploadManagementError } from './errors';

export interface UploadWorkers {
  attempts: UploadAttemptPort;
  maintenance: ApplicationWorkPort;
  start(): void;
  close(signal?: AbortSignal): Promise<{ complete: boolean }>;
}

const unknown = (): UploadAttemptSettlement => ({ writerStopped: false, localCopiesAbsent: false });
const sameWorker = (left: UploadWorker | undefined, right: UploadWorker) =>
  left?.hostId === right.hostId && left.instanceId === right.instanceId;

async function withinSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Upload work drain interrupted'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Local ownership journal and one processing loop; File retention owns all cleanup scheduling. */
export function createUploadWorkers(options: {
  processing: UploadProcessingDependencies;
  runAsSystem<T>(work: () => Promise<T>): Promise<T>;
  idleMs?: number;
  onError?: () => void;
}): UploadWorkers {
  const idleMs = options.idleMs ?? 1_000;
  if (!Number.isSafeInteger(idleMs) || idleMs < 10 || idleMs > 60_000)
    throw new Error('Invalid upload worker interval');
  const worker = options.processing.worker;
  if (!worker.hostId || !worker.instanceId) throw new Error('Missing upload worker identity');
  type Record = {
    lease?: UploadLease;
    abort: () => void;
    active: boolean;
    done: Promise<UploadAttemptSettlement>;
    resolve: (proof: UploadAttemptSettlement) => void;
    proof?: UploadAttemptSettlement;
  };
  const active = new Set<Record>();
  const receipts = new Map<string, Record>();
  let pausedBy: string | null = null;
  let closed = false;
  let started = false;
  let uncertain = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let processingAbort: AbortController | undefined;

  const normalize = (proof: UploadAttemptSettlement): UploadAttemptSettlement => ({
    ...proof,
    // Aborting and joining the SDK cannot fence an uncertain remote PUT.
    writerStopped: proof.writerStopped === true && proof.storageOutcome !== 'unknown',
    localCopiesAbsent: proof.localCopiesAbsent === true,
  });
  const lookup = (task: Pick<UploadCleanupTask, 'operationId' | 'generation' | 'worker'>) =>
    sameWorker(task.worker, worker) ? receipts.get(uploadAttemptId(task)) : undefined;

  const attempts: UploadAttemptPort = {
    begin(abort) {
      if (closed || pausedBy !== null) throw new UploadManagementError('unavailable');
      // A paused body consumes no document buffer; still bound outstanding local requests.
      if (active.size >= 128) throw new UploadManagementError('queue_full');
      let resolve!: Record['resolve'];
      const record: Record = {
        abort,
        active: true,
        done: new Promise((done) => {
          resolve = done;
        }),
        resolve: (proof) => resolve(proof),
      };
      active.add(record);
      return {
        bind(lease) {
          if (!record.active || record.lease || !sameWorker(lease, worker))
            throw new UploadManagementError('lease_lost');
          const key = uploadAttemptId(lease);
          if (receipts.get(key)?.active) throw new UploadManagementError('lease_lost');
          // Evict only settled receipts; missing later means unknown, never stopped.
          if (receipts.size >= 256) {
            const oldest = [...receipts].find(([, value]) => !value.active);
            if (!oldest) throw new UploadManagementError('queue_full');
            if (
              !oldest[1].proof?.writerStopped ||
              !oldest[1].proof?.localCopiesAbsent ||
              oldest[1].proof.securityPending
            )
              uncertain = true;
            receipts.delete(oldest[0]);
          }
          record.lease = { ...lease };
          receipts.set(key, record);
          if (closed) record.abort();
        },
        settle(proof) {
          if (!record.active) return;
          record.active = false;
          record.proof = normalize(proof);
          if (!record.lease && !record.proof.writerStopped) uncertain = true;
          active.delete(record);
          record.resolve(record.proof);
        },
      };
    },
    async stopAndJoin(task, signal) {
      const record = lookup(task);
      if (!record) return unknown();
      if (record.active) record.abort();
      try {
        return normalize(record.proof ?? (await withinSignal(record.done, signal)));
      } catch {
        return unknown();
      }
    },
    recordCleanup(task, proof) {
      const record = lookup(task);
      if (!record || record.active) return;
      const normalized = normalize(proof);
      record.proof = {
        writerStopped: record.proof?.writerStopped === true || normalized.writerStopped,
        localCopiesAbsent: record.proof?.localCopiesAbsent === true || normalized.localCopiesAbsent,
        storageOutcome: record.proof?.storageOutcome,
        securityPending: normalized.securityPending ?? record.proof?.securityPending,
      };
    },
  };

  function complete() {
    return (
      !uncertain &&
      [...receipts.values()].every(
        (record) =>
          record.active ||
          (record.proof?.writerStopped === true &&
            record.proof.localCopiesAbsent === true &&
            !record.proof.securityPending),
      )
    );
  }
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
      if (!requestId || closed || (pausedBy !== null && pausedBy !== requestId)) return false;
      pausedBy = requestId;
      clearTimeout(timer);
      timer = undefined;
      return true;
    },
    resumeAdmissions(requestId) {
      if (closed || pausedBy !== requestId || !complete()) return false;
      pausedBy = null;
      schedule();
      return true;
    },
    async getMaintenanceCensus(requestId) {
      return {
        admissionClosed: requestId !== null && pausedBy === requestId,
        queuedContinuations:
          [...active].filter((record) => !record.lease).length + (running ? 1 : 0),
        pendingWrites: [...active].filter((record) => record.lease).length,
        complete: complete() && (pausedBy === null || pausedBy === requestId),
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
      for (const record of active) record.abort();
      try {
        await withinSignal(
          Promise.all([running, ...[...active].map((record) => record.done)]),
          signal,
        );
        return { complete: active.size === 0 && complete() };
      } catch {
        return { complete: false };
      }
    },
  };
}
