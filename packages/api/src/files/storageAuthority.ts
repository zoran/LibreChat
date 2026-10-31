/** storageAuthority.ts binds private storage reads to the existing trusted Upload/File row. */
import {
  isUploadPrincipal,
  isUploadStorageReceipt,
  isUploadOriginalIntegrity,
  readUploadOriginalWriteBinding,
} from 'librechat-data-provider';
import type { UploadCleanupTask, UploadPrincipal } from 'librechat-data-provider';

export type FileStorageAuthority = Readonly<{
  principal: Readonly<UploadPrincipal>;
  operationId: string;
}>;
type Subject = Readonly<{
  operationId: string;
  source: string;
  storageKey: string;
  bytes: number;
  mediaType: string;
}>;

/** Shape validation cannot supply ownership: task must be the existing repository's scoped row. */
export function resolveFileStorageAuthority(
  task: UploadCleanupTask,
  file: Subject,
): FileStorageAuthority | undefined {
  const receipt = task?.original;
  if (
    !isUploadPrincipal(task?.principal) ||
    task.operationId !== file.operationId ||
    task.fileId !== file.operationId ||
    task.state !== 'ready' ||
    !isUploadStorageReceipt(receipt) ||
    receipt.outcome !== 'durable' ||
    receipt.source !== file.source ||
    receipt.storageKey !== file.storageKey ||
    receipt.bytes !== file.bytes
  )
    return undefined;
  const binding =
    task.writeBinding === undefined ? undefined : readUploadOriginalWriteBinding(task.writeBinding);
  if (task.writeBinding !== undefined && !binding) return undefined;
  if (
    binding &&
    (binding.operationId !== file.operationId ||
      binding.key !== file.storageKey ||
      binding.generation !== String(task.attemptGeneration) ||
      binding.bytes !== file.bytes ||
      binding.mediaType !== file.mediaType ||
      !isUploadOriginalIntegrity(receipt.integrity, file.bytes) ||
      binding.wholeSHA256 !== receipt.integrity.sha256)
  )
    return undefined;
  if (file.source === 'nas-s3') {
    if (
      !binding ||
      binding.version !== 2 ||
      !receipt.backend ||
      receipt.versionId !== undefined ||
      receipt.filepath !== `/api/files/managed/${file.operationId}` ||
      receipt.backend.uid !== binding.backend.uid ||
      receipt.backend.kind !== binding.backend.kind ||
      receipt.backend.protocol !== binding.backend.protocol ||
      receipt.backend.configurationSha256 !== binding.backend.configurationSha256
    )
      return undefined;
  } else if (
    file.source !== 's3' ||
    receipt.backend !== undefined ||
    (binding && binding.version !== 1)
  ) {
    return undefined;
  }
  const owner = task.principal;
  const principal: UploadPrincipal =
    owner.authentication === 'guest'
      ? { authentication: 'guest', tenantId: null, userId: owner.userId }
      : { authentication: 'verified-email', tenantId: owner.tenantId, userId: owner.userId };
  return Object.freeze({ principal: Object.freeze(principal), operationId: task.operationId });
}
