/** Read-only original status for a promotion already authorized by Intake control.
 * Caller retains capability, principal, worker and lease checks; only bound publication settles. */
import type { UploadPromotionRecord, UploadPrincipal } from 'librechat-data-provider';
import type { UploadManagementRepository } from '@librechat/data-schemas';
import type { StoragePort } from '../contract';

export async function reconcilePromotionOriginal({
  record,
  repository,
  options,
  ctx,
  auth,
  signal,
  now,
}: {
  record: UploadPromotionRecord | null;
  repository: Pick<UploadManagementRepository, 'readOriginalWrite' | 'settlePromotion'>;
  options: { storage: Pick<StoragePort, 'observeOriginal'> };
  ctx: { operationId: string };
  auth: { principal: UploadPrincipal };
  signal: AbortSignal;
  now: () => number;
}): Promise<UploadPromotionRecord | null> {
  if (!record || record.state !== 'writing' || record.writerStopped) return record;

  const binding = await repository.readOriginalWrite(auth.principal, ctx.operationId);

  if (
    !binding ||
    binding.operationId !== ctx.operationId ||
    binding.generation !== String(record.lease.generation) ||
    binding.bytes !== record.approval.subject.bytes ||
    binding.wholeSHA256 !== record.integrity.sha256 ||
    binding.mediaType !== record.approval.subject.mediaType
  )
    return record;

  const receipt = await options.storage
    .observeOriginal({ principal: auth.principal, binding, integrity: record.integrity, signal })
    .catch(() => undefined);

  if (receipt?.outcome !== 'durable') return record;

  return repository.settlePromotion(
    {
      operationId: ctx.operationId,
      transferGeneration: record.lease.generation,
      promotionId: record.promotionId,
      worker: record.worker,
      writerStopped: true,
      receipt,
    },
    now(),
  );
}
