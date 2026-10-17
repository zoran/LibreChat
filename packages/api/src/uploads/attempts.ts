/** One local attempt/cleanup journal per real writer incarnation; no processing or cleanup queue. */
import {
  readUploadIntakeRecovery,
  readUploadSecurityExecution,
  matchesUploadSecurityExecution,
  isCompleteUploadSecuritySettlement,
} from 'librechat-data-provider';
import type {
  UploadCleanupTask,
  UploadWorker,
  UploadSecurityExecution,
} from 'librechat-data-provider';
import type {
  UploadAttemptBinding,
  UploadAttemptSettlement,
  UploadAttemptPort,
  UploadAttemptRegistration,
} from './contract';
import type { ApplicationWorkPort } from '~/app';
import { uploadAttemptId } from './processing/paths';
import { UploadManagementError } from './errors';

export interface UploadAttemptJournal {
  attempts: UploadAttemptPort;
  maintenance: ApplicationWorkPort;
  recoverPending(
    signal: AbortSignal,
    limit?: number,
  ): Promise<{ attempted: number; settled: number; pending: number }>;
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
    recover?: Parameters<NonNullable<UploadAttemptRegistration['recover']>>[0];
    recovering?: Promise<void>;
    revision: number;
    securityExecution?: UploadSecurityExecution;
    invalidSecurity?: boolean;
  };
  const active = new Set<Record>();
  const receipts = new Map<string, Record>();
  let pausedBy: string | null = null;
  let closed = false;
  let uncertain = false;
  let recoveryCursor: string | undefined;

  const normalize = (proof: UploadAttemptSettlement): UploadAttemptSettlement => ({
    ...proof,
    ...(proof.securityExecution === undefined
      ? {}
      : {
          securityExecution: readUploadSecurityExecution(proof.securityExecution) ?? undefined,
        }),
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
      // Reserve a receipt before asynchronous claim. Only fully resolved evidence may be evicted.
      const reserved = [...active].filter((record) => !record.binding).length;
      if (receipts.size + reserved >= 256) {
        const oldest = [...receipts].find(([, record]) => !record.active && settled(record));
        if (!oldest) throw new UploadManagementError('queue_full');
        receipts.delete(oldest[0]);
      }
      let resolve!: Record['resolve'];
      const record: Record = {
        abort,
        active: true,
        revision: 0,
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
          record.binding = {
            hostId: lease.hostId,
            instanceId: lease.instanceId,
            operationId: lease.operationId,
            generation: lease.generation,
          };
          receipts.set(key, record);
          if (closed) record.abort();
        },
        recover(handler) {
          if (!record.active || !record.binding || record.recover || typeof handler !== 'function')
            throw new UploadManagementError('invalid_request');
          record.recover = handler;
        },
        settle(proof) {
          if (!record.active) return;
          record.active = false;
          record.proof = normalize(
            record.recover
              ? { ...proof, acknowledgementPending: proof.acknowledgementPending !== false }
              : proof,
          );
          if (proof.securityExecution !== undefined) {
            const execution = readUploadSecurityExecution(proof.securityExecution);
            if (
              !execution ||
              !record.binding ||
              execution.attemptId !== uploadAttemptId(record.binding)
            ) {
              record.invalidSecurity = true;
              record.proof = { ...record.proof, writerStopped: false, securityPending: true };
              delete record.proof.securityExecution;
            } else {
              record.securityExecution = execution;
              record.proof.securityExecution = { ...execution };
            }
          }
          record.revision++;
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
        ...record.proof,
        writerStopped: record.proof?.writerStopped === true || normalized.writerStopped,
        localCopiesAbsent: record.proof?.localCopiesAbsent === true || normalized.localCopiesAbsent,
        storageOutcome: record.proof?.storageOutcome,
        securityPending: normalized.securityPending ?? record.proof?.securityPending,
        ...(normalized.localWriterStopped === true ? { localWriterStopped: true } : {}),
        // Generic cleanup never acknowledges a remote obligation or replaces unknown storage.
        ...(record.proof?.acknowledgementPending === true ||
        normalized.acknowledgementPending === true
          ? { acknowledgementPending: true }
          : {}),
      });
      record.revision++;
    },
  };

  function settled(record: Record): boolean {
    return (
      record.proof?.writerStopped === true &&
      record.proof.localCopiesAbsent === true &&
      (!record.recover || record.proof.localWriterStopped === true) &&
      !record.proof.securityPending &&
      !record.proof.acknowledgementPending &&
      !record.invalidSecurity &&
      !record.recovering
    );
  }

  /** No timer or second queue: the service owns retries and the supplied finite deadline. */
  async function recoverPending(signal: AbortSignal, limit = 16) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
      throw new UploadManagementError('invalid_request');
    let attempted = 0;
    let recovered = 0;
    const records = [...receipts];
    const start = records.findIndex(([key]) => key === recoveryCursor) + 1;
    for (const [key, record] of [...records.slice(start), ...records.slice(0, start)]) {
      if (signal.aborted || attempted >= limit) break;
      if (
        record.active ||
        record.invalidSecurity ||
        settled(record) ||
        record.recovering ||
        !record.recover ||
        !record.binding ||
        record.proof?.localWriterStopped !== true ||
        record.proof.localCopiesAbsent !== true
      )
        continue;
      const revision = record.revision;
      const proof = Object.freeze({
        ...record.proof,
        ...(record.securityExecution
          ? { securityExecution: Object.freeze({ ...record.securityExecution }) }
          : {}),
      });
      const recover = record.recover;
      attempted++;
      recoveryCursor = key;
      // Install single-flight before invoking foreign code; retain it if that code ignores abort.
      const flight = Promise.resolve()
        .then(async () => {
          if (signal.aborted) return;
          const value = await recover(proof, signal);
          if (
            signal.aborted ||
            record.active ||
            receipts.get(key) !== record ||
            record.revision !== revision
          )
            return;
          const view = readUploadIntakeRecovery(value);
          if (
            !view ||
            view.operationId !== record.binding!.operationId ||
            view.transferGeneration !== record.binding!.generation ||
            !sameWorker(view.worker, worker)
          )
            return;
          if (
            record.securityExecution &&
            !matchesUploadSecurityExecution(view.securityExecution, record.securityExecution)
          )
            return;
          if (
            view.storageOutcome !== 'unknown' &&
            record.proof!.storageOutcome &&
            record.proof!.storageOutcome !== 'unknown' &&
            record.proof!.storageOutcome !== view.storageOutcome
          )
            return;
          if (view.securityExecution) {
            if (view.securityExecution.attemptId !== key) return;
            record.securityExecution = view.securityExecution;
            record.proof = { ...record.proof!, securityExecution: { ...view.securityExecution } };
          }
          const current = record.proof!;
          if (view.storageOutcome === 'unknown') return;
          const securityPending = view.securityExecution
            ? !isCompleteUploadSecuritySettlement(view.securitySettlement, view.securityExecution)
            : current.securityPending === true;
          record.proof = normalize({
            ...current,
            storageOutcome: view.storageOutcome,
            writerStopped: current.localWriterStopped === true && view.appWriterStopped,
            securityPending,
            acknowledgementPending: !view.acknowledged || securityPending,
          });
          record.revision++;
        })
        .catch(() => undefined);
      record.recovering = flight;
      void flight.finally(() => {
        if (record.recovering === flight) record.recovering = undefined;
      });
      try {
        await withinSignal(flight, signal);
      } catch {
        break;
      }
      if (settled(record)) recovered++;
    }
    return {
      attempted,
      settled: recovered,
      pending: [...receipts.values()].filter((record) => !settled(record)).length,
    };
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
    recoverPending,
    async close(signal: AbortSignal = AbortSignal.timeout(125_000)) {
      closed = true;
      for (const record of active) record.abort();
      try {
        await withinSignal(Promise.all([...active].map((record) => record.done)), signal);
        await recoverPending(signal);
        return { complete: active.size === 0 && complete() };
      } catch {
        return { complete: false };
      }
    },
  };
}
