/** Actor-local settlement only: no object deletion, File policy, quota refund or second queue. */
import path from 'node:path';
import { lstat, realpath, rm } from 'node:fs/promises';
import {
  readHistoricalUploadSecuritySettlement,
  isCompleteHistoricalUploadSecuritySettlement,
} from 'librechat-data-provider';
import type { UploadCleanupTask, UploadCleanupProof, UploadWorker } from 'librechat-data-provider';
import type { UploadManagementRepository } from '@librechat/data-schemas';
import type { DocumentPort, UploadAttemptPort, UploadSecurityPort } from './contract';
import { cancelHistoricalSecurityExecution } from './security/cancellation';
import { attemptOriginalPath, uploadAttemptId } from './processing/paths';
import { settleUploadPromotionCleanup } from './intake/promotion-cleanup';

export interface UploadActorSettlement {
  settle(task: UploadCleanupTask, signal: AbortSignal): Promise<UploadCleanupProof>;
  reconcile(signal: AbortSignal): Promise<{ scanned: number; settled: number; pending: number }>;
}
export interface UploadActorSettlementOptions {
  repository: Pick<
    UploadManagementRepository,
    | 'cleanupForWorker'
    | 'confirmActorCleanup'
    | 'settlePromotion'
    | 'recordPromotionLocalCleanup'
    | 'readActorCleanupRecovery'
  >;
  documents: DocumentPort;
  security?: UploadSecurityPort;
  attempts: UploadAttemptPort;
  worker: UploadWorker;
  stagingRoot: string;
  now?: () => number;
}
export function createUploadActorSettlement(
  options: UploadActorSettlementOptions,
): UploadActorSettlement {
  if (!path.isAbsolute(options.stagingRoot)) throw new Error('Invalid managed staging root');
  const now = options.now ?? Date.now;
  const worker = Object.freeze({ ...options.worker });
  const local = (task: UploadCleanupTask) =>
    task.worker?.hostId === worker.hostId && task.worker.instanceId === worker.instanceId;
  let cursor: string | null = null;
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

  async function settleLocal(
    task: UploadCleanupTask,
    signal: AbortSignal,
  ): Promise<{
    proof: UploadCleanupProof;
    localWriterStopped: boolean;
    promotionStopped: boolean;
    localJoinStopped: boolean;
  }> {
    const proof: UploadCleanupProof = {
      operationId: task.operationId,
      generation: task.generation,
      writerStopped:
        task.writerStopped === true ||
        (local(task) && 'actorWriterStopped' in task && task.actorWriterStopped === true),
      localCopiesAbsent: task.localCopiesAbsent === true,
      originalAbsent: false,
      textAndHistoryRemoved: false,
    };
    let securityPending = false;
    let localJoinStopped = false;
    const appStopped =
      !task.promotion ||
      (typeof options.repository.settlePromotion === 'function' &&
        (await settleUploadPromotionCleanup({
          task,
          attempts: options.attempts,
          worker: options.worker,
          repository: {
            settlePromotion: options.repository.settlePromotion,
            recordPromotionLocalCleanup: options.repository.recordPromotionLocalCleanup,
          },
          signal,
          now,
        })));
    if (local(task) && (!proof.writerStopped || !proof.localCopiesAbsent)) {
      const joined = await options.attempts.stopAndJoin(task, signal);
      localJoinStopped = joined.localWriterStopped === true || joined.writerStopped === true;
      proof.writerStopped ||= joined.writerStopped && joined.storageOutcome !== 'unknown';
      proof.localCopiesAbsent ||= joined.localCopiesAbsent;
      securityPending = joined.securityPending === true;
      // Only a bound exact parser receipt can supplement the local journal.
      // An old worker incarnation cannot use this Pod's socket as stop evidence.
      if (
        !proof.writerStopped &&
        task.parserExecution &&
        joined.storageOutcome !== 'unknown' &&
        !signal.aborted
      ) {
        const stopped = await options.documents
          .cancel({ execution: task.parserExecution, signal })
          .catch(() => ({ writerStopped: false }));
        proof.writerStopped = stopped.writerStopped === true;
      }
    }
    if ((proof.writerStopped || localJoinStopped) && !proof.localCopiesAbsent && !signal.aborted) {
      proof.localCopiesAbsent = await removeLocal(task);
    }
    if (local(task) && task.securityExecution) {
      // Cleanup preserves the exact original protocol. Current executions still require AV
      // retirement; an authentic retained V2 receipt cannot authorize a new dispatch.
      const stored = readHistoricalUploadSecuritySettlement(task.securitySettlement);
      const settled = isCompleteHistoricalUploadSecuritySettlement(stored, task.securityExecution)
        ? stored
        : await cancelHistoricalSecurityExecution(options.security, task.securityExecution, signal);
      securityPending = !settled;
      if (settled) proof.securitySettlement = settled;
    }
    // Preserve local stop evidence separately; a remote join cannot attest local or S3 writers.
    options.attempts.recordCleanup(task, {
      ...proof,
      securityPending,
      ...(localJoinStopped ? { localWriterStopped: true } : {}),
    });
    const localWriterStopped = proof.writerStopped;
    proof.writerStopped &&= !securityPending && appStopped;
    return { proof, localWriterStopped, promotionStopped: appStopped, localJoinStopped };
  }

  return {
    async settle(task, signal) {
      return (await settleLocal(task, signal)).proof;
    },
    async reconcile(signal) {
      signal.throwIfAborted();
      const batch = await options.repository.cleanupForWorker(worker, { limit: 16, cursor });
      cursor = batch.cursor;
      let settled = 0;
      let pending = 0;
      for (const task of batch.tasks) {
        const promotionLocal =
          task.promotion?.worker.hostId === worker.hostId &&
          task.promotion.worker.instanceId === worker.instanceId;
        if (
          signal.aborted ||
          (!local(task) && !promotionLocal) ||
          ['waiting', 'transferring', 'processing'].includes(task.state)
        ) {
          pending++;
          continue;
        }
        try {
          const result = await settleLocal(task, signal);
          signal.throwIfAborted();
          if (
            options.attempts.acknowledgeOwnerCleanup &&
            typeof options.repository.readActorCleanupRecovery === 'function'
          ) {
            const generation = local(task) ? task.generation : task.promotion?.lease.generation;
            if (generation !== undefined) {
              const observation = await options.repository.readActorCleanupRecovery({
                operationId: task.operationId,
                attemptGeneration: generation,
                worker,
              });
              if (observation)
                options.attempts.acknowledgeOwnerCleanup(
                  { operationId: task.operationId, generation, worker },
                  observation,
                );
            }
          }
          if (local(task)) {
            const acknowledged = await options.repository.confirmActorCleanup(
              worker,
              {
                operationId: task.operationId,
                generation: task.generation,
                writerStopped: result.localWriterStopped,
                ...(result.localJoinStopped ? { localWriterStopped: true } : {}),
                localCopiesAbsent: result.proof.localCopiesAbsent,
                ...(result.proof.securitySettlement
                  ? { securitySettlement: result.proof.securitySettlement }
                  : {}),
              },
              now(),
            );
            if (
              !acknowledged.actorWriterStopped ||
              !acknowledged.localCopiesAbsent ||
              !acknowledged.writerStopped
            ) {
              pending++;
              continue;
            }
          } else if (!result.promotionStopped) {
            pending++;
            continue;
          }
          settled++;
        } catch {
          pending++;
        }
      }
      // Only an empty owner query proves that no previous cursor page still owes local work.
      return {
        scanned: batch.tasks.length,
        settled,
        pending: batch.tasks.length ? Math.max(1, pending) : 0,
      };
    },
  };
}
