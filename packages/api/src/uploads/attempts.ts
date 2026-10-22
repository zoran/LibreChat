/** One local attempt/cleanup journal per real writer incarnation; no processing or cleanup queue. */
import { createHash } from 'node:crypto';
import {
  readUploadIntakeRecovery,
  canonicalStorageDeletionReceipt,
  UPLOAD_MAX_FILE_BYTES,
  readUploadSecurityExecution,
  matchesUploadSecurityExecution,
  isCompleteUploadSecuritySettlement,
} from 'librechat-data-provider';
import type {
  UploadCleanupTask,
  UploadWorker,
  UploadSecurityExecution,
  UploadOwnerCleanupReceipt,
} from 'librechat-data-provider';
import type {
  UploadAttemptBinding,
  UploadAttemptSettlement,
  UploadAttemptPort,
  UploadAttemptRegistration,
  UploadAttemptLocalGuard,
  UploadAttemptLocalReservation,
} from './contract';
import type { ApplicationWorkPort } from '../app/maintenance';
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
export function createUploadAttemptJournal(
  identity: UploadWorker,
  options: { resources?: UploadAttemptLocalGuard } = {},
): UploadAttemptJournal {
  const worker = { hostId: identity.hostId, instanceId: identity.instanceId };
  const resources = options.resources;
  if (!worker.hostId || !worker.instanceId) throw new Error('Missing upload worker identity');
  type Record = {
    declaredBytes?: number;
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
    cleanupReceipt?: UploadOwnerCleanupReceipt;
  };
  // The existing record is also the local reservation owner, including an
  // unbound claim whose outcome cannot yet be established.
  const records = new Set<Record>();
  const receipts = new Map<string, Record>();
  let pausedBy: string | null = null;
  let closed = false;
  let localChecks: Promise<void> = Promise.resolve();
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

  const localJoined = (record: Record) =>
    !record.active &&
    record.proof?.localCopiesAbsent === true &&
    (record.proof.localWriterStopped ?? record.proof.writerStopped) === true;

  function assertActive(record: Record, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (closed || !record.active) throw new UploadManagementError('unavailable');
  }

  function checkLocal(record: Record, signal: AbortSignal, bytes?: number): Promise<void> {
    // Install the flight before invoking a guard. A later candidate must see the
    // previous candidate's committed reservation, never the same free capacity.
    const flight = localChecks.then(async () => {
      assertActive(record, signal);
      if (
        bytes !== undefined &&
        record.declaredBytes !== undefined &&
        bytes !== record.declaredBytes
      )
        throw new UploadManagementError('invalid_request');
      const declaredBytes = bytes ?? record.declaredBytes;
      if (resources && declaredBytes === undefined) throw new UploadManagementError('unavailable');
      const reservations: UploadAttemptLocalReservation[] = [];
      for (const current of records) {
        const declared = current === record ? declaredBytes : current.declaredBytes;
        if (declared === undefined || localJoined(current)) continue;
        reservations.push(
          Object.freeze({
            declaredBytes: declared,
            ...(current.binding ? { binding: Object.freeze({ ...current.binding }) } : {}),
          }),
        );
      }
      await resources?.assertSafe(Object.freeze(reservations), signal);
      // Settle, shutdown or cancellation during measurement cannot mint capacity
      // or revive a writer. Rejected candidates never enter the record.
      assertActive(record, signal);
      if (bytes !== undefined) record.declaredBytes = bytes;
    });
    localChecks = flight.catch(() => undefined);
    return flight;
  }

  function consumeOwnerCleanup(record: Record, value: unknown): boolean {
    const view = readUploadIntakeRecovery(value);
    if (
      !view?.cleanupReceipt ||
      !view.acknowledged ||
      !view.appWriterStopped ||
      !record.binding ||
      record.active ||
      record.invalidSecurity ||
      record.proof?.localWriterStopped !== true ||
      record.proof.localCopiesAbsent !== true ||
      view.operationId !== record.binding.operationId ||
      view.transferGeneration !== record.binding.generation ||
      !sameWorker(view.worker, worker) ||
      (record.proof.storageOutcome !== undefined &&
        record.proof.storageOutcome !== 'unknown' &&
        record.proof.storageOutcome !== view.storageOutcome) ||
      (record.securityExecution &&
        !matchesUploadSecurityExecution(view.securityExecution, record.securityExecution))
    )
      return false;
    const receipt = view.cleanupReceipt;
    if (
      createHash('sha256')
        .update(canonicalStorageDeletionReceipt(receipt.receipt))
        .digest('hex') !== receipt.receiptSHA256
    )
      return false;
    if (
      record.cleanupReceipt &&
      (record.cleanupReceipt.receiptSHA256 !== receipt.receiptSHA256 ||
        record.cleanupReceipt.consumerCommitId !== receipt.consumerCommitId)
    )
      return false;
    const securityPending = view.securityExecution
      ? !isCompleteUploadSecuritySettlement(view.securitySettlement, view.securityExecution)
      : record.proof.securityPending === true;
    if (securityPending) return false;
    if (view.securityExecution) record.securityExecution = view.securityExecution;
    record.cleanupReceipt = receipt;
    record.proof = normalize({
      ...record.proof,
      ...(view.securityExecution ? { securityExecution: view.securityExecution } : {}),
      securityPending: false,
      acknowledgementPending: false,
    });
    record.revision++;
    return true;
  }

  const attempts: UploadAttemptPort = {
    begin(abort) {
      if (closed || pausedBy !== null) throw new UploadManagementError('unavailable');
      // A paused body consumes no document buffer; still bound outstanding local requests.
      if ([...records].filter((record) => record.active).length >= 128)
        throw new UploadManagementError('queue_full');
      // Reserve a receipt before asynchronous claim. Only fully resolved evidence may be evicted.
      if (records.size >= 256) {
        const oldest = [...receipts].find(([, record]) => !record.active && settled(record));
        if (!oldest) throw new UploadManagementError('queue_full');
        receipts.delete(oldest[0]);
        records.delete(oldest[1]);
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
      records.add(record);
      return {
        async reserveLocal(bytes, signal) {
          if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > UPLOAD_MAX_FILE_BYTES)
            throw new UploadManagementError('invalid_request');
          await checkLocal(record, signal, bytes);
        },
        async assertLocal(signal) {
          await checkLocal(record, signal);
        },
        bind(lease) {
          if (
            !record.active ||
            record.binding ||
            !sameWorker(lease, worker) ||
            (resources && record.declaredBytes === undefined)
          )
            throw new UploadManagementError('lease_lost');
          const key = uploadAttemptId(lease);
          const previous = receipts.get(key);
          if (previous && (previous.active || !settled(previous)))
            throw new UploadManagementError('lease_lost');
          if (previous) records.delete(previous);
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
              record.proof.securityExecution = readUploadSecurityExecution(execution)!;
            }
          }
          record.revision++;
          if (!record.binding && settled(record)) records.delete(record);
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
    acknowledgeOwnerCleanup(task, observation) {
      const record = lookup(task);
      return !!record && consumeOwnerCleanup(record, observation);
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
      !!record.proof &&
      (record.proof.writerStopped === true || !!record.cleanupReceipt) &&
      localJoined(record) &&
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
    const entries = [...receipts];
    const start = entries.findIndex(([key]) => key === recoveryCursor) + 1;
    for (const [key, record] of [...entries.slice(start), ...entries.slice(0, start)]) {
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
          ? { securityExecution: readUploadSecurityExecution(record.securityExecution)! }
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
          if (view.cleanupReceipt) {
            consumeOwnerCleanup(record, view);
            return;
          }
          if (view.securityExecution) {
            if (view.securityExecution.attemptId !== key) return;
            record.securityExecution = view.securityExecution;
            record.proof = {
              ...record.proof!,
              securityExecution: readUploadSecurityExecution(view.securityExecution)!,
            };
          }
          const current = record.proof!;
          if (view.storageOutcome === 'unknown') {
            consumeOwnerCleanup(record, view);
            return;
          }
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
    return [...records].every((record) => record.active || settled(record));
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
        queuedContinuations: [...records].filter((record) => record.active && !record.binding)
          .length,
        pendingWrites: [...records].filter((record) => record.active && record.binding).length,
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
      const active = [...records].filter((record) => record.active);
      for (const record of active) record.abort();
      try {
        await withinSignal(Promise.all(active.map((record) => record.done)), signal);
        await withinSignal(localChecks, signal);
        await recoverPending(signal);
        return { complete: ![...records].some((record) => record.active) && complete() };
      } catch {
        return { complete: false };
      }
    },
  };
}
