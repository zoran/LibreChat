/** Proves only the local App writer's end; Intake, scanner, copies and S3 cleanup stay separate. */
import { isDeepStrictEqual } from 'node:util';
import { readUploadPromotionRecord } from 'librechat-data-provider';
import type { UploadCleanupTask, UploadWorker } from 'librechat-data-provider';
import type { UploadManagementRepository } from '@librechat/data-schemas';
import type { UploadAttemptPort } from '../contract';

/** Read a detached field without invoking accessors on a supplied task/identity/acknowledgement. */
function field(value: unknown, name: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

export async function settleUploadPromotionCleanup(options: {
  task: UploadCleanupTask;
  attempts: UploadAttemptPort;
  worker: UploadWorker;
  repository: Pick<UploadManagementRepository, 'settlePromotion'> &
    Partial<Pick<UploadManagementRepository, 'recordPromotionLocalCleanup'>>;
  signal: AbortSignal;
  now?: () => number;
}): Promise<boolean> {
  const { task, attempts, worker, repository, signal, now = Date.now } = options;
  try {
    if (
      signal.aborted ||
      !task ||
      typeof task !== 'object' ||
      Array.isArray(task) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(task))
    )
      return false;
    const descriptor = Object.getOwnPropertyDescriptor(task, 'promotion');
    if (descriptor && !('value' in descriptor)) return false;
    if (!descriptor || descriptor.value === undefined) return true;
    const promotion = readUploadPromotionRecord(descriptor.value);
    const principal = field(task, 'principal');
    if (
      !promotion ||
      promotion.lease.operationId !== field(task, 'operationId') ||
      promotion.lease.generation !== field(task, 'attemptGeneration') ||
      promotion.lease.tenantId !== field(principal, 'tenantId') ||
      promotion.lease.userId !== field(principal, 'userId')
    )
      return false;
    if (promotion.writerStopped) return true;
    if (
      promotion.worker.hostId !== field(worker, 'hostId') ||
      promotion.worker.instanceId !== field(worker, 'instanceId')
    )
      return false;
    const joined = await attempts.stopAndJoin(
      {
        operationId: promotion.lease.operationId,
        generation: promotion.lease.generation,
        worker: { ...promotion.worker },
      },
      signal,
    );
    const outcome = field(joined, 'storageOutcome');
    if (
      !signal.aborted &&
      (field(joined, 'localWriterStopped') === true || field(joined, 'writerStopped') === true) &&
      typeof repository.recordPromotionLocalCleanup === 'function'
    ) {
      await repository.recordPromotionLocalCleanup(
        {
          operationId: promotion.lease.operationId,
          transferGeneration: promotion.lease.generation,
          promotionId: promotion.promotionId,
          worker: { ...promotion.worker },
        },
        now(),
      );
    }
    if (
      signal.aborted ||
      field(joined, 'writerStopped') !== true ||
      !['not_started', 'absent', 'durable'].includes(outcome as string) ||
      (promotion.receipt && promotion.receipt.outcome !== outcome)
    )
      return false;
    const expected = { ...promotion, state: 'settled' as const, writerStopped: true };
    const result = readUploadPromotionRecord(
      await repository.settlePromotion(
        {
          operationId: promotion.lease.operationId,
          transferGeneration: promotion.lease.generation,
          promotionId: promotion.promotionId,
          worker: { ...promotion.worker },
          writerStopped: true,
          ...(promotion.receipt ? { receipt: promotion.receipt } : {}),
        },
        now(),
      ),
    );
    return !signal.aborted && isDeepStrictEqual(result, expected);
  } catch {
    // Lost acknowledgements and unknown writers remain pending; never invent a cleanup proof.
    return false;
  }
}
