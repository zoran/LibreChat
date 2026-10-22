/** File-owned current receipt assembly and bounded observations; no activity or quota mutation. */
import { createHash } from 'crypto';
import {
  buildManagedFileReadBinding,
  UPLOAD_RETENTION_MS,
  isUploadOriginalIntegrity,
  isUploadStorageReceipt,
  matchesUploadSecurityApproval,
  readManagedDocumentResult,
  readUploadDerivedOrigin,
  readHistoricalUploadDerivedOrigin,
  serializeManagedFileReadPreview,
} from 'librechat-data-provider';
import type { ManagedFileReadRepresentation } from 'librechat-data-provider';
import type { ClientSession, FilterQuery, Model } from 'mongoose';
import type { FileOwnerScope, FileSourceInspection, IMongoFile } from '~/types/file';
import type { StoredUpload } from './uploadManagementStore';
import { approvedFileFilter, uploadSecurityPolicySha256 } from './fileSecurity';
import { hasCurrentUploadSecurityApproval } from './uploadManagement.security';
import { tenantStorage, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { validFileRetentionActivity } from './fileActivityTransition';

export class FileSourceUnavailableError extends Error {
  constructor() {
    super('Document source unavailable');
    this.name = 'FileSourceUnavailableError';
  }
}

/** Admission capacity is distinct from revoked sources; retained readers preserve this safe code. */
export class FileSourceCapacityError extends Error {
  readonly code = 'capacity_exceeded';

  constructor() {
    super('Document source capacity exceeded');
    this.name = 'FileSourceCapacityError';
  }
}

export function fileSourceScope(owner: FileOwnerScope): { user: string; tenantId: string | null } {
  const tenant = tenantStorage.getStore()?.tenantId;
  if (
    !owner.userId ||
    (owner.tenantId != null &&
      (typeof owner.tenantId !== 'string' ||
        !/^[a-zA-Z0-9_.-]{1,128}$/.test(owner.tenantId) ||
        owner.tenantId === SYSTEM_TENANT_ID)) ||
    (tenant && tenant !== SYSTEM_TENANT_ID && tenant !== owner.tenantId)
  ) {
    throw new FileSourceUnavailableError();
  }
  return { user: owner.userId, tenantId: owner.tenantId ?? null };
}

/** Retained rows must carry the namespace explicitly; Mongo null equality also matches missing fields. */
export function managedFileScope(owner: FileOwnerScope): FilterQuery<IMongoFile> {
  const scope = fileSourceScope(owner);
  return {
    ...scope,
    ...(scope.tenantId === null ? { tenantId: { $eq: null, $exists: true } } : {}),
  };
}

export type ManagedFileSourceRefusal = 'not_found' | 'expired' | 'revoked' | 'source_changed';
export class ManagedFileSourceUnavailableError extends FileSourceUnavailableError {
  constructor(readonly reason: ManagedFileSourceRefusal) {
    super();
  }
}
function unavailable(reason: ManagedFileSourceRefusal): never {
  throw new ManagedFileSourceUnavailableError(reason);
}
export const fileSourceSha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');
export type CurrentManagedFileSource = {
  file: IMongoFile;
  operation: StoredUpload;
  binding: string;
  contentSha256: string;
  verifiedBytes: number;
  originalSha256: string;
  originalBytes: number;
};

export type CurrentFileDeadline = Readonly<{
  kind: 'original' | 'derived';
  deadlineAt: Date;
  deadlineGeneration: number;
  migrationEpoch: string | null;
}>;
/** One generation/freeze authority for current File, metadata projection and migration. */
export function currentFileDeadline(file: IMongoFile): CurrentFileDeadline {
  const value = file.derivedRetention;
  if (file.derivedOrigin !== undefined || value !== undefined) {
    if (
      !value ||
      file.retentionActivity !== undefined ||
      (!readUploadDerivedOrigin(file.derivedOrigin) &&
        !(
          (file.deletionRequestedAt ||
            file.deletionCompletedAt ||
            (file.expiredAt && file.expiredAt.getTime() <= Date.now())) &&
          (readHistoricalUploadDerivedOrigin(file.derivedOrigin) ||
            (file.deletionCompletedAt && file.derivedOrigin === undefined))
        )) ||
      value.version !== 1 ||
      !['admission', 'legacy-baseline'].includes(value.capBasis) ||
      !(value.ownDeadlineAt instanceof Date) ||
      !Number.isSafeInteger(value.ownDeadlineAt.getTime()) ||
      (value.capBasis === 'admission' &&
        (!(file.retentionAcceptedAt instanceof Date) ||
          value.ownDeadlineAt.getTime() !==
            file.retentionAcceptedAt.getTime() + UPLOAD_RETENTION_MS)) ||
      !(value.trackedSince instanceof Date) ||
      !Number.isSafeInteger(value.trackedSince.getTime()) ||
      !Number.isSafeInteger(value.deadlineGeneration) ||
      value.deadlineGeneration < 0 ||
      !(file.expiredAt instanceof Date) ||
      !Number.isSafeInteger(file.expiredAt.getTime()) ||
      file.expiredAt > value.ownDeadlineAt
    )
      unavailable('source_changed');
    return {
      kind: 'derived',
      deadlineAt: new Date(file.expiredAt),
      deadlineGeneration: value.deadlineGeneration,
      migrationEpoch: value.migrationEpoch ?? null,
    };
  }
  if (!validFileRetentionActivity(file.retentionActivity, file.expiredAt))
    unavailable('source_changed');
  return {
    kind: 'original',
    deadlineAt: new Date(file.expiredAt!),
    deadlineGeneration: file.retentionActivity.deadlineGeneration,
    migrationEpoch: file.retentionActivity.migrationEpoch ?? null,
  };
}

/** Ready attachment admission and private metadata traversal remain distinct purposes. */
export function currentManagedFileFilter(
  owner: FileOwnerScope,
  fileId: string,
  now: number,
  policy?: string,
  purpose: 'attachment' | 'derived-parent' = 'attachment',
): FilterQuery<IMongoFile> {
  return {
    ...managedFileScope(owner),
    file_id: fileId,
    uploadOperationId: fileId,
    retentionAcceptedAt: { $ne: null },
    expiredAt: { $gt: new Date(now) },
    deletionRequestedAt: null,
    deletionCompletedAt: null,
    'retentionActivity.migrationEpoch': { $exists: false },
    'derivedRetention.migrationEpoch': { $exists: false },
    ...(purpose === 'attachment'
      ? {
          status: 'ready',
          embedded: true,
          derivedOrigin: { $exists: false },
          derivedRetention: { $exists: false },
          'retentionActivity.version': 1,
        }
      : {}),
    $and: [approvedFileFilter(policy, now), { $expr: { $gt: ['$expiredAt', '$$NOW'] } }],
  };
}

/** Read-only observation; transactional consumers additionally use touchActiveUserPrincipal. */
export async function assertFileSourceOwnerActive(
  mongoose: typeof import('mongoose'),
  owner: FileOwnerScope,
  session?: ClientSession,
): Promise<void> {
  const scope = fileSourceScope(owner);
  if (!mongoose.isValidObjectId(scope.user)) unavailable('not_found');
  if (!mongoose.models.User) throw new Error('File source identity owner is unavailable');
  const user = await mongoose.models.User.exists({
    _id: scope.user,
    tenantId: scope.tenantId,
    agentTriggerDeletionStartedAt: { $exists: false },
    authDisabled: { $ne: true },
  })
    .session(session ?? null)
    .maxTimeMS(1000);
  if (!user) unavailable('revoked');
}

/** Assemble actual receipt evidence only; caller supplies rows from this owner transaction. */
export function assembleManagedFileSource(
  owner: FileOwnerScope,
  file: IMongoFile,
  operation: StoredUpload | undefined,
  representation: ManagedFileReadRepresentation,
  policy: string,
  purpose: 'attachment' | 'derived-parent',
  migrationEpoch?: string,
  observationAt: number = Date.now(),
): CurrentManagedFileSource {
  const fileId = file.file_id;
  const original = operation?.original;
  const approval = file.securityApproval;
  const deadline = currentFileDeadline(file);
  if (
    (file.derivedOrigin !== undefined && !readUploadDerivedOrigin(file.derivedOrigin)) ||
    (operation?.derivedOrigin !== undefined && !readUploadDerivedOrigin(operation.derivedOrigin))
  )
    unavailable('source_changed');
  if (
    !operation ||
    !hasCurrentUploadSecurityApproval(operation, policy, observationAt) ||
    (purpose === 'attachment'
      ? operation.state !== 'ready'
      : !['queued_processing', 'processing', 'ready', 'failed'].includes(operation.state)) ||
    operation.fileId !== fileId ||
    (purpose === 'attachment' &&
      (operation.derivedOrigin !== undefined || file.status !== 'ready' || !file.embedded)) ||
    JSON.stringify(readUploadDerivedOrigin(operation.derivedOrigin)) !==
      JSON.stringify(readUploadDerivedOrigin(file.derivedOrigin)) ||
    !isUploadStorageReceipt(original) ||
    original.outcome !== 'durable' ||
    !isUploadOriginalIntegrity(original.integrity, original.bytes) ||
    original.source !== 's3' ||
    original.source !== file.source ||
    original.filepath !== file.filepath ||
    operation.filename !== file.filename ||
    original.bytes !== file.bytes ||
    original.storageKey !== file.storageKey ||
    operation.actualBytes !== file.bytes ||
    operation.mediaType !== file.type ||
    operation.acceptedAt !== file.retentionAcceptedAt?.getTime() ||
    operation.expiresAt !== file.expiredAt?.getTime() ||
    operation.expiresAt! <= observationAt ||
    deadline.migrationEpoch !== (migrationEpoch ?? null) ||
    file.deletionRequestedAt != null ||
    file.deletionCompletedAt != null ||
    String(file.user) !== owner.userId ||
    file.tenantId !== (owner.tenantId ?? null) ||
    file.uploadOperationId !== file.file_id ||
    operation.userId !== owner.userId ||
    operation.tenantId !== (owner.tenantId ?? null) ||
    typeof policy !== 'string' ||
    !matchesUploadSecurityApproval(
      approval,
      {
        tenantId: owner.tenantId ?? null,
        userId: owner.userId,
        operationId: fileId,
        transferGeneration: operation.attemptGeneration!,
        mediaType: file.type,
        bytes: file.bytes,
        sha256: original.integrity.sha256,
      },
      policy,
      observationAt,
    )
  )
    unavailable('source_changed');
  let preview:
    | { text: string; structure: NonNullable<IMongoFile['documentStructure']> | null }
    | undefined;
  if (representation === 'preview') {
    if (typeof file.text !== 'string') unavailable('source_changed');
    const document =
      file.documentStructure === undefined
        ? undefined
        : readManagedDocumentResult({
            text: file.text,
            structure: file.documentStructure,
          });
    if (file.documentStructure !== undefined && !document) unavailable('source_changed');
    preview = { text: file.text, structure: document?.structure ?? null };
  }
  const binding = buildManagedFileReadBinding(
    {
      owner: { tenantId: owner.tenantId ?? null, userId: owner.userId },
      fileId,
      operationId: fileId,
      filename: file.filename,
      mediaType: file.type,
      source: file.source,
      bytes: file.bytes,
      storageKey: file.storageKey!,
      transferGeneration: operation.attemptGeneration ?? null,
      original,
      approval: approval!,
      representation,
      ...(preview ? { preview } : {}),
    },
    fileSourceSha256,
  );
  const previewBody = preview ? serializeManagedFileReadPreview(fileId, preview) : undefined;
  return {
    file,
    operation,
    binding,
    contentSha256:
      previewBody === undefined ? original.integrity.sha256 : fileSourceSha256(previewBody),
    verifiedBytes:
      previewBody === undefined ? original.bytes : Buffer.byteLength(previewBody, 'utf8'),
    originalSha256: original.integrity.sha256,
    originalBytes: original.bytes,
  };
}

/** Actual Upload original evidence is mandatory; no File-only or captured-deadline fallback. */
export async function loadManagedFileSource(
  mongoose: typeof import('mongoose'),
  owner: FileOwnerScope,
  fileId: string,
  representation: ManagedFileReadRepresentation,
  options: {
    purpose: 'attachment' | 'derived-parent';
    securityPolicySha256?: string;
    session?: ClientSession;
  },
): Promise<CurrentManagedFileSource> {
  if (!['original', 'preview'].includes(representation) || !/^[a-zA-Z0-9_.-]{1,128}$/.test(fileId))
    unavailable('not_found');
  const policy = uploadSecurityPolicySha256(options.securityPolicySha256);
  if (typeof policy !== 'string' || !mongoose.models.UploadOperation) unavailable('source_changed');
  await assertFileSourceOwnerActive(mongoose, owner, options.session);
  const File = mongoose.models.File as Model<IMongoFile>;
  const file = await File.findOne(
    currentManagedFileFilter(owner, fileId, Date.now(), policy, options.purpose),
  )
    .select(
      representation === 'preview'
        ? '+securityApproval +documentStructure +retentionActivity +derivedRetention +derivedOrigin +retentionRevocationId'
        : '-text -documentStructure +securityApproval +retentionActivity +derivedRetention +derivedOrigin +retentionRevocationId',
    )
    .session(options.session ?? null)
    .maxTimeMS(1000)
    .lean<IMongoFile>();
  if (!file) {
    const rejected = await File.findOne({ ...managedFileScope(owner), file_id: fileId })
      .select('expiredAt')
      .session(options.session ?? null)
      .maxTimeMS(1000)
      .lean<IMongoFile>();
    if (!rejected) unavailable('not_found');
    unavailable(
      rejected.expiredAt && rejected.expiredAt.getTime() <= Date.now() ? 'expired' : 'revoked',
    );
  }
  const operation = await mongoose.models.UploadOperation.findOne({
    _id: fileId,
    userId: owner.userId,
    tenantId: owner.tenantId ?? null,
  })
    .session(options.session ?? null)
    .maxTimeMS(1000)
    .lean<StoredUpload>();
  return assembleManagedFileSource(
    owner,
    file,
    operation ?? undefined,
    representation,
    policy,
    options.purpose,
  );
}

/** Bounded metadata batch for complete ancestry, not content access or a read capability. */
export async function loadFileSourceMetadata(
  mongoose: typeof import('mongoose'),
  owner: FileOwnerScope,
  ids: readonly string[],
  session: ClientSession,
): Promise<{ files: IMongoFile[]; operations: StoredUpload[] }> {
  const unique = boundedFileSourceIds(ids);
  if (!session.inTransaction()) throw new FileSourceUnavailableError();
  const files = await mongoose.models.File.find({
    ...managedFileScope(owner),
    file_id: { $in: unique },
  })
    .select(
      '-text -documentStructure +securityApproval +retentionActivity +derivedRetention +derivedOrigin +retentionRevocationId',
    )
    .session(session)
    .maxTimeMS(1000)
    .lean<IMongoFile[]>();
  const operations = await mongoose.models.UploadOperation.find({
    _id: { $in: unique },
    userId: owner.userId,
    tenantId: owner.tenantId ?? null,
  })
    .session(session)
    .maxTimeMS(1000)
    .lean<StoredUpload[]>();
  return { files, operations };
}

export function boundedFileSourceIds(ids: readonly string[]): string[] {
  if (!Array.isArray(ids)) throw new FileSourceUnavailableError();
  if (ids.length > 64) throw new FileSourceCapacityError();
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(id))
  )
    throw new FileSourceUnavailableError();
  return [...new Set(ids)];
}

/** Bounded owner observation. Missing reasons are concealed; database uncertainty still throws. */
export async function inspectFileSources(
  mongoose: typeof import('mongoose'),
  owner: FileOwnerScope,
  ids: readonly string[],
  session?: ClientSession,
): Promise<readonly FileSourceInspection[]> {
  const unique = boundedFileSourceIds(ids);
  const scope = fileSourceScope(owner);
  if (!unique.length) return [];
  try {
    await assertFileSourceOwnerActive(mongoose, owner, session);
  } catch (error) {
    if (error instanceof ManagedFileSourceUnavailableError)
      return unique.map((fileId) => ({ state: 'unavailable', fileId }));
    throw error;
  }
  const File = mongoose.models.File as Model<IMongoFile>;
  const rows = await File.find({ ...scope, file_id: { $in: unique } })
    .select(
      'file_id tenantId uploadOperationId retentionAcceptedAt expiredAt deletionRequestedAt deletionCompletedAt +derivedOrigin',
    )
    .session(session ?? null)
    .maxTimeMS(1000)
    .lean<IMongoFile[]>();
  const byId = new Map(rows.map((row) => [row.file_id, row]));
  const result: FileSourceInspection[] = [];
  for (const fileId of unique) {
    const row = byId.get(fileId);
    if (!row || row.derivedOrigin !== undefined) {
      result.push({ state: 'unavailable', fileId });
      continue;
    }
    if (
      row.uploadOperationId === undefined &&
      process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED !== 'true'
    ) {
      if (row.retentionAcceptedAt == null) {
        result.push({ state: 'unmanaged', fileId, sourceExpiresAt: null });
        continue;
      }
      if (
        row.tenantId === scope.tenantId &&
        row.expiredAt instanceof Date &&
        Number.isSafeInteger(row.expiredAt.getTime()) &&
        row.expiredAt.getTime() > Date.now() &&
        !row.deletionRequestedAt &&
        !row.deletionCompletedAt
      ) {
        result.push({ state: 'unmanaged', fileId, sourceExpiresAt: new Date(row.expiredAt) });
        continue;
      }
      result.push({ state: 'unavailable', fileId });
      continue;
    }
    try {
      const source = await loadManagedFileSource(mongoose, owner, fileId, 'original', {
        purpose: 'attachment',
        session,
      });
      result.push({
        state: 'managed',
        fileId,
        sourceExpiresAt: new Date(source.file.expiredAt!),
        sourceBindingSha256: source.binding,
      });
    } catch (error) {
      if (!(error instanceof ManagedFileSourceUnavailableError)) throw error;
      result.push({ state: 'unavailable', fileId });
    }
  }
  return result;
}
