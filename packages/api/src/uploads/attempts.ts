/** One local attempt/cleanup journal per real writer incarnation; no processing or cleanup queue. */
import type { UploadCleanupTask, UploadWorker } from 'librechat-data-provider';
import type { UploadAttemptBinding, UploadAttemptSettlement, UploadAttemptPort } from './contract';
import type { ApplicationWorkPort } from '~/app';
import { uploadAttemptId } from './processing/paths';
import { UploadManagementError } from './errors';

export interface UploadAttemptJournal {
  attempts: UploadAttemptPort;
  maintenance: ApplicationWorkPort;
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

/** The supplied identity is this process's actual writer, never a lease owner's stand-in. */
export function createUploadAttemptJournal(identity: UploadWorker): UploadAttemptJournal {
  const worker = { hostId: identity.hostId, instanceId: identity.instanceId };
  if (!worker.hostId || !worker.instanceId) throw new Error('Missing upload worker identity');
  type Record = {
    binding?: UploadAttemptBinding;
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
  let uncertain = false;

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
          if (!record.active || record.binding || !sameWorker(lease, worker))
            throw new UploadManagementError('lease_lost');
          const key = uploadAttemptId(lease);
          const previous = receipts.get(key);
          if (previous && (previous.active || !settled(previous)))
            throw new UploadManagementError('lease_lost');
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
          record.binding = {
            hostId: lease.hostId,
            instanceId: lease.instanceId,
            operationId: lease.operationId,
            generation: lease.generation,
          };
          receipts.set(key, record);
          if (closed) record.abort();
        },
        settle(proof) {
          if (!record.active) return;
          record.active = false;
          record.proof = normalize(proof);
          if (!record.binding && !settled(record)) uncertain = true;
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
      record.proof = normalize({
        writerStopped: record.proof?.writerStopped === true || normalized.writerStopped,
        localCopiesAbsent: record.proof?.localCopiesAbsent === true || normalized.localCopiesAbsent,
        storageOutcome: record.proof?.storageOutcome,
        securityPending: normalized.securityPending ?? record.proof?.securityPending,
      });
    },
  };

  function settled(record: Record): boolean {
    return (
      record.proof?.writerStopped === true &&
      record.proof.localCopiesAbsent === true &&
      !record.proof.securityPending
    );
  }

  function complete(): boolean {
    return !uncertain && [...receipts.values()].every((record) => record.active || settled(record));
  }
  const maintenance: ApplicationWorkPort = {
    pauseAdmissions(requestId) {
      if (!requestId || closed || (pausedBy !== null && pausedBy !== requestId)) return false;
      pausedBy = requestId;
      return true;
    },
    resumeAdmissions(requestId) {
      if (closed || pausedBy !== requestId || !complete()) return false;
      pausedBy = null;
      return true;
    },
    async getMaintenanceCensus(requestId) {
      return {
        admissionClosed: requestId !== null && pausedBy === requestId,
        queuedContinuations: [...active].filter((record) => !record.binding).length,
        pendingWrites: [...active].filter((record) => record.binding).length,
        complete: complete() && (pausedBy === null || pausedBy === requestId),
      };
    },
  };
  return {
    attempts,
    maintenance,
    async close(signal: AbortSignal = AbortSignal.timeout(125_000)) {
      closed = true;
      for (const record of active) record.abort();
      try {
        await withinSignal(Promise.all([...active].map((record) => record.done)), signal);
        return { complete: active.size === 0 && complete() };
      } catch {
        return { complete: false };
      }
    },
  };
}
