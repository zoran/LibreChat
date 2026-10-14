import path from 'node:path';
import { lstat, realpath, rm } from 'node:fs/promises';
import type { UploadCleanupTask, UploadCleanupProof, UploadWorker } from 'librechat-data-provider';
import type { UploadRepository, DocumentPort, StoragePort, UploadAttemptPort } from './contract';
import { attemptOriginalPath, uploadAttemptId } from './processing/paths';

type FileOwner = { tenantId?: string; userId?: string };
type CleanupRepository = Pick<
  UploadRepository,
  'cleanupForFile' | 'delete' | 'reconcile' | 'cleanupTasks' | 'confirmCleanup'
>;
export interface ManagedUploadCleanup {
  beginFileDeletion(owner: FileOwner, fileId: string): Promise<UploadCleanupTask | null>;
  removeFileOriginal(task: UploadCleanupTask): Promise<UploadCleanupProof>;
  finishFileDeletion(task: UploadCleanupTask, proof: UploadCleanupProof): Promise<void>;
  sweep(input: {
    limit?: number;
    deleteAcceptedFile(task: UploadCleanupTask): Promise<boolean>;
  }): Promise<{ scanned: number; cleaned: number; pending: number }>;
}

/** Called only by the existing File lifecycle. It starts no timer and owns no File/Message writes. */
export function createManagedUploadCleanup(options: {
  repository: CleanupRepository;
  storage: StoragePort;
  documents: DocumentPort;
  attempts: UploadAttemptPort;
  worker: UploadWorker;
  stagingRoot: string;
  now?: () => number;
}): ManagedUploadCleanup {
  if (!path.isAbsolute(options.stagingRoot)) throw new Error('Invalid managed staging root');
  const now = options.now ?? Date.now;
  const local = (task: UploadCleanupTask) =>
    task.worker?.hostId === options.worker.hostId &&
    task.worker.instanceId === options.worker.instanceId;

  async function removeLocal(task: UploadCleanupTask): Promise<boolean> {
    if (!local(task)) return false;
    const directory = path.dirname(attemptOriginalPath(options.stagingRoot, uploadAttemptId(task)));
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      const root = await realpath(options.stagingRoot);
      if ((await realpath(directory)) !== path.join(root, uploadAttemptId(task))) return false;
      await rm(directory, { recursive: true, force: false });
      try {
        await lstat(directory);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT';
      }
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }

  async function stopAndCleanLocal(
    task: UploadCleanupTask,
    signal: AbortSignal,
  ): Promise<UploadCleanupProof> {
    const proof: UploadCleanupProof = {
      operationId: task.operationId,
      generation: task.generation,
      writerStopped: task.writerStopped === true,
      localCopiesAbsent: task.localCopiesAbsent === true,
      originalAbsent: false,
      textAndHistoryRemoved: false,
    };
    if (local(task) && (!proof.writerStopped || !proof.localCopiesAbsent)) {
      const joined = await options.attempts.stopAndJoin(task, signal);
      proof.writerStopped ||= joined.writerStopped && joined.storageOutcome !== 'unknown';
      proof.localCopiesAbsent ||= joined.localCopiesAbsent;
      // Only a bound exact parser receipt can supplement the local journal.
      // An old worker incarnation cannot use this Pod's socket as stop evidence.
      if (!proof.writerStopped && task.parserExecution && !signal.aborted) {
        const stopped = await options.documents
          .cancel({ execution: task.parserExecution, signal })
          .catch(() => ({ writerStopped: false }));
        proof.writerStopped = stopped.writerStopped === true;
      }
    }
    if (proof.writerStopped && !proof.localCopiesAbsent && !signal.aborted) {
      proof.localCopiesAbsent = await removeLocal(task);
    }
    options.attempts.recordCleanup(task, proof);
    return proof;
  }

  async function originalAbsence(
    task: UploadCleanupTask,
    proof: UploadCleanupProof,
    signal: AbortSignal,
  ) {
    if (!proof.writerStopped || signal.aborted) return false;
    if (task.attemptGeneration == null) {
      // The repository records no admitted attempt and no accepted relationship.
      return !task.worker && !task.fileId && !task.original;
    }
    return (
      (await options.storage
        .remove({
          operationId: task.operationId,
          generation: task.attemptGeneration,
          tenantId: task.principal.tenantId,
          userId: task.principal.userId,
          signal,
        })
        .catch(() => 'unknown')) === 'absent'
    );
  }

  async function confirm(task: UploadCleanupTask, proof: UploadCleanupProof) {
    if (
      task.operationId !== proof.operationId ||
      task.generation !== proof.generation ||
      !proof.writerStopped
    ) {
      throw new Error('Managed cleanup proof is incomplete');
    }
    const operation = await options.repository.confirmCleanup(proof, now());
    options.attempts.recordCleanup(task, proof);
    return operation;
  }

  const api = {
    async beginFileDeletion(owner: FileOwner, fileId: string): Promise<UploadCleanupTask | null> {
      if (!owner.tenantId || !owner.userId) return null;
      const scope = { tenantId: owner.tenantId, userId: owner.userId };
      const task = await options.repository.cleanupForFile(scope, fileId);
      if (!task) return null;
      await options.repository.delete(task.principal, task.operationId, now());
      const fenced = await options.repository.cleanupForFile(scope, fileId);
      if (!fenced || !['deleted', 'expired'].includes(fenced.state))
        throw new Error('Managed deletion fence unavailable');
      return fenced;
    },
    async removeFileOriginal(task: UploadCleanupTask): Promise<UploadCleanupProof> {
      if (!task.fileId || !['deleted', 'expired'].includes(task.state))
        throw new Error('Managed deletion fence required');
      const signal = AbortSignal.timeout(30_000);
      const proof = await stopAndCleanLocal(task, signal);
      proof.originalAbsent = await originalAbsence(task, proof, signal);
      // Store only the classes actually proven so a later lifecycle retry can proceed.
      if (proof.writerStopped) await confirm(task, proof);
      return proof;
    },
    /** File composition calls only after generation purge, Message redaction and File finalization. */
    async finishFileDeletion(task: UploadCleanupTask, proof: UploadCleanupProof): Promise<void> {
      if (!task.fileId || !['deleted', 'expired'].includes(task.state) || !proof.originalAbsent) {
        throw new Error('Managed original absence required');
      }
      await confirm(task, { ...proof, textAndHistoryRemoved: true });
    },
    async sweep(input: {
      limit?: number;
      deleteAcceptedFile(task: UploadCleanupTask): Promise<boolean>;
    }): Promise<{ scanned: number; cleaned: number; pending: number }> {
      const limit = input.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error('Invalid managed cleanup batch');
      const signal = AbortSignal.timeout(30_000);
      await options.repository.reconcile(now(), limit);
      const tasks = await options.repository.cleanupTasks(limit);
      let cleaned = 0;
      let pending = 0;
      for (const task of tasks) {
        if (signal.aborted) {
          pending++;
          continue;
        }
        // Reconciliation must fence a live/expired lease before any attempt is stopped.
        if (['waiting', 'transferring', 'processing'].includes(task.state)) continue;
        try {
          if (task.fileId && ['deleted', 'expired'].includes(task.state)) {
            if (await input.deleteAcceptedFile(task)) cleaned++;
            else pending++;
            continue;
          }
          const proof = await stopAndCleanLocal(task, signal);
          if (!proof.writerStopped) {
            pending++;
            continue;
          }
          if (!task.fileId) {
            proof.originalAbsent = await originalAbsence(task, proof, signal);
            // The fenced repository row has never accepted a File/history relationship.
            proof.textAndHistoryRemoved = true;
          }
          const result = await confirm(task, proof);
          if (result.cleanupPending) pending++;
          else cleaned++;
        } catch {
          pending++;
        }
      }
      return { scanned: tasks.length, cleaned, pending };
    },
  };
  return api;
}
