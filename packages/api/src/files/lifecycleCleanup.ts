/** Sole typed File Housekeeping adapter; importing it starts no owner or background process. */
import type {
  FileCleanupPort,
  JobClaim,
  StepOutcome,
  FileCleanupProgressResult,
  FileCleanupProgressMethods,
  FileCleanupLifecycleMethods,
  FileCleanupClaimMethods,
} from '@librechat/data-schemas';
import type { StoragePort, StorageDeletionInput } from '../uploads/contract';
import type { GenerationCleanupPort } from '../generation-cleanup';

export interface FileCleanupComposition {
  entry: FileCleanupClaimMethods;
  targets: FileCleanupProgressMethods;
  lifecycle: FileCleanupLifecycleMethods;
  generations: GenerationCleanupPort;
  storage: Pick<
    StoragePort,
    'describeDeletion' | 'beginDeletion' | 'observeDeletion' | 'acknowledgeDeletionConsumed'
  >;
  /** Actual transport deadline; no promise is detached by a timeout race. */
  storageBudgetMs: number;
}
function outcome(value: FileCleanupProgressResult): StepOutcome {
  if (value.state === 'progress') {
    const ref = value.progress.lifecycle?.completionRef ?? null;
    return value.expected.phase === 'complete' && ref
      ? { state: 'settled', receiptRef: ref }
      : { state: 'progress', receiptRef: null };
  }
  if (value.state === 'pending') return { state: 'pending', code: 'owner_pending' };
  return { state: value.state };
}
export function createFileCleanupPort(ports: FileCleanupComposition): FileCleanupPort {
  if (
    !Number.isSafeInteger(ports.storageBudgetMs) ||
    ports.storageBudgetMs < 1 ||
    ports.storageBudgetMs > 10000
  )
    throw new Error('FILE_CLEANUP_FINITE_STORAGE_BUDGET_REQUIRED');
  return {
    async step(claim: JobClaim, signal: AbortSignal): Promise<StepOutcome> {
      if (signal.aborted) return { state: 'pending', code: 'owner_pending' };
      try {
        // Null->UUID promotion returns lost. It must never leak into an effect in this invocation.
        const entered = await ports.entry.enter(claim, signal);
        if (entered.state !== 'progress') return entered;
        let current = await ports.lifecycle.begin(claim, signal);
        if (current.state !== 'progress') return outcome(current);
        const value = current.progress;
        if (!value.lifecycle || claim.work.handler !== 'file.cleanup' || !claim.work.revocationId)
          return { state: 'pending', code: 'owner_pending' };
        const phase = current.expected.phase;
        if (phase === 'revoked') return outcome(await ports.targets.beginCapture(claim, signal));
        if (phase === 'capturing_generations' || phase === 'settling_generations') {
          if (!value.capture.complete) {
            if (signal.aborted) return { state: 'pending', code: 'owner_pending' };
            const page = await ports.generations.capture(
              {
                userId: claim.work.subject.ownerUserId,
                ...(claim.work.subject.tenantId === null
                  ? {}
                  : { tenantId: claim.work.subject.tenantId }),
                revocationId: claim.work.revocationId,
                sourceFileIds: [claim.work.subject.fileId],
              },
              value.capture.cursor ?? undefined,
            );
            return outcome(
              await ports.targets.recordCapturePage(claim, current.expected, page, signal),
            );
          }
          const targets = await ports.targets.readPendingTargets(claim, signal);
          if (targets.state !== 'progress') return outcome(targets);
          const target = targets.targets[0];
          if (target) {
            if (signal.aborted) return { state: 'pending', code: 'owner_pending' };
            const result = await ports.generations.reconcile(target.target);
            return outcome(
              await ports.targets.recordGenerationResult(
                claim,
                targets.expected,
                target.id,
                result,
                signal,
              ),
            );
          }
          return outcome(
            await ports.targets.finishGenerationStage(claim, targets.expected, signal),
          );
        }
        if (phase === 'purging_derivatives') {
          const d = value.lifecycle.derivatives;
          return outcome(
            d.retrieval === 'complete' && d.checkpoints === 'complete' && d.messages === 'complete'
              ? await ports.lifecycle.prepareStorage(claim, signal)
              : await ports.lifecycle.purgeDerivatives(claim, signal),
          );
        }
        if (phase !== 'removing_original' && phase !== 'finalizing') return outcome(current);
        // Reobserve the durable request/local commit under current authority before every handoff.
        current = await ports.lifecycle.observe(claim, signal);
        if (current.state !== 'progress') return outcome(current);
        const life = current.progress.lifecycle;
        const storage = life?.storage;
        if (!life || !storage) return { state: 'pending', code: 'owner_pending' };
        const base = {
          operationId: life.upload.operationId,
          generation: life.upload.attemptGeneration,
          tenantId: life.upload.tenantId,
          userId: life.upload.userId,
          request: storage.request,
        };
        if (storage.state === 'binding') {
          const binding = ports.storage.describeDeletion(base);
          return outcome(
            await ports.lifecycle.bindStorage(claim, current.expected, binding, signal),
          );
        }
        if (storage.state === 'terminal')
          return outcome(await ports.lifecycle.commitConsumption(claim, signal));
        if (storage.state === 'consumed')
          return outcome(await ports.lifecycle.finalize(claim, signal));
        if (signal.aborted) return { state: 'pending', code: 'owner_pending' };
        const input: StorageDeletionInput = {
          ...base,
          binding: storage.binding,
          signal,
          deadlineAtMs: Date.now() + ports.storageBudgetMs,
          request: {
            ...storage.request,
            ...(storage.state === 'observing' && storage.obligationId
              ? { obligationId: storage.obligationId }
              : {}),
          },
        };
        if (storage.state === 'committed') {
          const result = await ports.storage.acknowledgeDeletionConsumed({
            ...input,
            receipt: storage.receipt,
            consumerCommitId: storage.consumerCommitId,
          });
          return outcome(
            await ports.lifecycle.recordConsumption(claim, current.expected, result, signal),
          );
        }
        const result =
          storage.lastState === null
            ? await ports.storage.beginDeletion(input)
            : await ports.storage.observeDeletion(input);
        return outcome(
          await ports.lifecycle.recordStorage(claim, current.expected, result, signal),
        );
      } catch {
        // Local/remote reply loss never authorizes a second identity or a settled result.
        return { state: 'unknown' };
      }
    },
  };
}
