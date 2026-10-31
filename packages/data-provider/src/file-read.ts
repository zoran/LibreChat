/** Finite managed File reads. A ticket identifies one logical read; it never grants file access. */
import type { ManagedDocumentResult } from './document-structure';
import type { UploadStorageReceipt } from './upload-management';
import type { UploadSecurityApproval } from './upload-security';
import type { ManagedSha256 } from './managed-retrieval';
import { readHistoricalUploadSecurityApproval } from './upload-security';
import { readManagedDocumentResult } from './document-structure';
import { isUploadStorageReceipt } from './upload-management';
import { managedDigest } from './managed-retrieval';

export const MANAGED_FILE_READ_HEADER = 'X-Cortex-File-Read';
export type ManagedFileReadRepresentation = 'original' | 'preview';
export type ManagedFileReadTicket = Readonly<{
  version: 1;
  readId: string;
  fileId: string;
  representation: ManagedFileReadRepresentation;
  admittedAt: string;
  notAfter: string;
}>;
/** Routes receive only the opaque ID. The File owner resolves the original stored deadline. */
export type ManagedFileReadReference = Pick<
  ManagedFileReadTicket,
  'version' | 'readId' | 'fileId' | 'representation'
>;
export type ManagedFileReadBindingInput = {
  owner: { tenantId: string | null; userId: string };
  fileId: string;
  operationId: string;
  filename: string;
  mediaType: string;
  source: string;
  bytes: number;
  storageKey: string;
  transferGeneration: number | null;
  original: UploadStorageReceipt;
  approval: UploadSecurityApproval | null;
  representation: ManagedFileReadRepresentation;
  preview?: { text: string; structure: ManagedDocumentResult['structure'] | null };
};

const bounded = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;

export function isManagedFileReadTicket(value: unknown): value is ManagedFileReadTicket {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as ManagedFileReadTicket;
  const keys = ['version', 'readId', 'fileId', 'representation', 'admittedAt', 'notAfter'];
  if (Object.keys(v).length !== keys.length || !Object.keys(v).every((key) => keys.includes(key)))
    return false;
  const start = Date.parse(v.admittedAt);
  const end = Date.parse(v.notAfter);
  return (
    v.version === 1 &&
    typeof v.readId === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(v.readId) &&
    bounded(v.fileId, 128) &&
    ['original', 'preview'].includes(v.representation) &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    end > start &&
    end - start <= 120_000 &&
    new Date(start).toISOString() === v.admittedAt &&
    new Date(end).toISOString() === v.notAfter
  );
}

/**
 * The sole immutable binding projection shared by File persistence and server source handles.
 * Mutable retention/operation expiry is deliberately absent. Authorization, current approval policy
 * and original-integrity admission remain with the caller; this digest grants no authority.
 */
export function buildManagedFileReadBinding(
  input: ManagedFileReadBindingInput,
  sha256: ManagedSha256,
): string {
  const {
    owner,
    fileId,
    operationId,
    filename,
    mediaType,
    source,
    bytes,
    storageKey,
    transferGeneration,
    original,
    approval,
    representation,
    preview,
  } = input;
  if (
    !owner ||
    !bounded(owner.userId, 256) ||
    !(owner.tenantId === null || bounded(owner.tenantId, 256)) ||
    !bounded(fileId, 128) ||
    !bounded(operationId, 128) ||
    fileId !== operationId ||
    typeof filename !== 'string' ||
    filename.length > 255 ||
    !bounded(mediaType, 127) ||
    !bounded(source, 256) ||
    !bounded(storageKey, 4096) ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > 30 * 1024 * 1024 ||
    !(
      transferGeneration === null ||
      (Number.isSafeInteger(transferGeneration) && transferGeneration > 0)
    ) ||
    !isUploadStorageReceipt(original) ||
    original.outcome !== 'durable' ||
    original.bytes !== bytes ||
    original.source !== source ||
    original.storageKey !== storageKey ||
    !(
      approval === null ||
      (readHistoricalUploadSecurityApproval(approval) &&
        (source !== 'nas-s3' || approval.version === 2))
    ) ||
    !['original', 'preview'].includes(representation)
  )
    throw new Error('Invalid managed File read binding');
  if (
    approval &&
    (approval.subject.tenantId !== owner.tenantId ||
      approval.subject.userId !== owner.userId ||
      approval.subject.operationId !== operationId ||
      approval.subject.bytes !== bytes ||
      approval.subject.mediaType !== mediaType ||
      approval.subject.transferGeneration !== transferGeneration ||
      (original.integrity && approval.subject.sha256 !== original.integrity.sha256))
  )
    throw new Error('Foreign managed File read approval');
  if (representation === 'preview') {
    if (
      !preview ||
      typeof preview.text !== 'string' ||
      new TextEncoder().encode(preview.text).length > 15 * 1024 * 1024 ||
      (preview.structure !== null && !readManagedDocumentResult(preview))
    )
      throw new Error('Invalid managed File read preview');
  } else if (preview !== undefined) throw new Error('Unexpected managed File read preview');
  return managedDigest(
    {
      version: 1,
      owner: { tenantId: owner.tenantId, userId: owner.userId },
      fileId,
      operationId,
      filename,
      mediaType,
      source,
      bytes,
      storageKey,
      transferGeneration,
      original,
      approval,
      representation,
      ...(representation === 'preview' ? { preview } : {}),
    },
    sha256,
  );
}

/** Exact UTF-8 preview body for server completion evidence and File-owned verification. */
export function serializeManagedFileReadPreview(
  fileId: string,
  preview: NonNullable<ManagedFileReadBindingInput['preview']>,
): string {
  if (
    !bounded(fileId, 128) ||
    typeof preview?.text !== 'string' ||
    new TextEncoder().encode(preview.text).length > 15 * 1024 * 1024 ||
    (preview.structure !== null && !readManagedDocumentResult(preview))
  )
    throw new Error('Invalid managed File preview');
  return JSON.stringify({
    file_id: fileId,
    status: 'ready',
    text: preview.text,
    textFormat: 'text',
    ...(preview.structure === null ? {} : { documentStructure: preview.structure }),
  });
}
