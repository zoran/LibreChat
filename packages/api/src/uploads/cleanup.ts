/** File lifecycle orchestration; local actor and storage proofs remain separate. */
import type { UploadCleanupTask, UploadCleanupProof } from 'librechat-data-provider';
import type { JobClaim, StepOutcome } from '@librechat/data-schemas';
import type { UploadRepository, StoragePort } from './contract';
import type { UploadActorSettlement } from './actorSettlement';

type FileOwner = { tenantId?: string | null; userId?: string };
type CleanupRepository = Pick<
  UploadRepository,
  | 'cleanupForFile'
  | 'delete'
  | 'reconcile'
  | 'cleanupTasks'
  | 'confirmCleanup'
  | 'prepareCleanupStorage'
  | 'recordCleanupStorage'
> &
  Partial<Pick<UploadRepository, 'prepareHousekeepingCleanup' | 'confirmHousekeepingCleanup'>>;
export interface ManagedUploadCleanup {
  reconcileCleanupOperation(claim: JobClaim, signal: AbortSignal): Promise<StepOutcome>;
  beginFileDeletion(owner: FileOwner, fileId: string): Promise<UploadCleanupTask | null>;
  removeFileOriginal(task: UploadCleanupTask): Promise<UploadCleanupProof>;
  finishFileDeletion(task: UploadCleanupTask, proof: UploadCleanupProof): Promise<void>;
  sweep(input: {
    limit?: number;
    deleteAcceptedFile(task: UploadCleanupTask): Promise<boolean>;
  }): Promise<{ scanned: number; cleaned: number; pending: number }>;
}

/** Called only by the existing File lifecycle. It starts no timer or local attempt journal. */
export function createManagedUploadCleanup(options: {
  repository: CleanupRepository;
  storage: StoragePort;
  actor?: Pick<UploadActorSettlement, 'settle'>;
  now?: () => number;
}): ManagedUploadCleanup {
  const now = options.now ?? Date.now;
  const localProof = (task: UploadCleanupTask, signal: AbortSignal): Promise<UploadCleanupProof> =>
    options.actor
      ? options.actor.settle(task, signal)
      : Promise.resolve({
          operationId: task.operationId,
          generation: task.generation,
          writerStopped: task.writerStopped === true,
          localCopiesAbsent: task.localCopiesAbsent === true,
          originalAbsent: false,
          textAndHistoryRemoved: false,
        });
  async function storageSettlement(task: UploadCleanupTask, signal: AbortSignal, claim?: JobClaim) {
    if (task.attemptGeneration == null || task.fileId || signal.aborted)
      return { state: 'pending' as const };
    const authority = {
      operationId: task.operationId,
      principal: task.principal,
      generation: task.generation,
      attemptGeneration: task.attemptGeneration,
      ...(claim ? { claim } : {}),
    };
    const identity = {
      operationId: task.operationId,
      generation: task.attemptGeneration,
      tenantId: task.principal.tenantId,
      userId: task.principal.userId,
    };
    let prepared = await options.repository.prepareCleanupStorage(authority);
    if (prepared.state === 'binding') {
      const binding = options.storage.describeDeletion({ ...identity, request: prepared.request });
      prepared = await options.repository.prepareCleanupStorage(authority, binding);
    }
    if (signal.aborted) return { state: 'pending' as const };
    const deadlineAtMs = now() + 30_000;
    if (prepared.state === 'observe') {
      const input = {
        ...identity,
        request: prepared.request,
        binding: prepared.binding,
        signal,
        deadlineAtMs,
      };
      let result = await options.storage.observeDeletion(input);
      // An unknown lookup is not rollback; the only admissible begin is this same persisted request.
      if (result.state === 'unknown' && !signal.aborted)
        result = await options.storage.beginDeletion(input);
      prepared = await options.repository.recordCleanupStorage(authority, { result });
    }
    if (prepared.state === 'consume' && !signal.aborted) {
      const consumption = await options.storage.acknowledgeDeletionConsumed({
        ...identity,
        request: prepared.request,
        binding: prepared.binding,
        receipt: prepared.receipt,
        consumerCommitId: prepared.consumerCommitId,
        signal,
        deadlineAtMs,
      });
      prepared = await options.repository.recordCleanupStorage(authority, { consumption });
    }
    return prepared;
  }
  async function originalAbsence(
    task: UploadCleanupTask,
    proof: UploadCleanupProof,
    signal: AbortSignal,
  ) {
    if (task.attemptGeneration == null)
      return proof.writerStopped && !task.worker && !task.fileId && !task.original;
    // Accepted originals are exclusively consumed through the File receipt owner.
    return (await storageSettlement(task, signal)).state === 'complete';
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
    return operation;
  }

  const api = {
    async reconcileCleanupOperation(claim: JobClaim, signal: AbortSignal): Promise<StepOutcome> {
      if (claim.work.handler !== 'upload.cleanup')
        throw new Error('Invalid Upload cleanup handler');
      const prepare = options.repository.prepareHousekeepingCleanup;
      const confirm = options.repository.confirmHousekeepingCleanup;
      if (!prepare || !confirm) throw new Error('Upload Housekeeping repository unavailable');
      if (signal.aborted) return { state: 'pending', code: 'owner_pending' };
      // This branch never calls a local actor, a batch cursor or File deletion.
      const prepared = await prepare.call(options.repository, claim);
      if (prepared.state === 'outcome') return prepared.outcome;
      const task = prepared.task;
      if (
        task.operationId !== claim.work.operationId ||
        task.principal.tenantId !== claim.work.subject.tenantId ||
        task.principal.userId !== claim.work.subject.ownerUserId ||
        (task.attemptGeneration ?? null) !== claim.work.attemptGeneration ||
        task.fileId ||
        ['waiting', 'transferring', 'processing'].includes(task.state)
      )
        throw new Error('Invalid unaccepted Upload cleanup preparation');
      if (signal.aborted) return { state: 'pending', code: 'owner_pending' };
      const result = await storageSettlement(task, signal, claim);
      if (result.state === 'complete') return { state: 'settled', receiptRef: result.receiptRef };
      if (result.state === 'lost') return { state: 'lost' };
      return { state: 'pending', code: 'owner_pending' };
    },
    async beginFileDeletion(owner: FileOwner, fileId: string): Promise<UploadCleanupTask | null> {
      if (
        !owner.userId ||
        (owner.tenantId != null && (typeof owner.tenantId !== 'string' || !owner.tenantId))
      )
        return null;
      const scope = { tenantId: owner.tenantId ?? null, userId: owner.userId };
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
      const proof = await localProof(task, signal);
      proof.originalAbsent = await originalAbsence(task, proof, signal);
      // Store only the classes actually proven so a later lifecycle retry can proceed.
      if (proof.writerStopped) await confirm(task, proof);
      return proof;
    },
    /** After generation purge, Message redaction and File-content preparation; final File completion follows this ACK. */
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
          const proof = await localProof(task, signal);
          if (!proof.writerStopped) {
            if (!task.fileId && task.attemptGeneration != null)
              await storageSettlement(task, signal);
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
