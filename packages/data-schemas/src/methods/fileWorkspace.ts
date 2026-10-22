/** Private Workspace access composes the existing File approval, lineage and retention authority. */
import {
  matchesUploadSecurityApproval,
  readUploadDerivedIntent,
  readUploadDerivedOrigin,
  readUploadSecuritySubject,
  sameUploadDerivedOrigin,
} from 'librechat-data-provider';
import type {
  UploadDerivedBinding,
  UploadDerivedOrigin,
  UploadSecurityApproval,
} from 'librechat-data-provider';
import type { ClientSession, Model } from 'mongoose';
import type { FileOwnerScope, IMongoFile } from '~/types/file';
import {
  createFileRetentionMethods,
  fileSourceScope,
  FileSourceUnavailableError,
} from './fileRetention';
import { loadManagedFileSource, currentFileDeadline } from './fileSourceAuthority';
import { approvedFileFilter, uploadSecurityPolicySha256 } from './fileSecurity';
import { projectDerivedFileDeadline } from './fileDerivedRetention';

/** The trusted Workspace owner supplies this reference from its stored immutable revision. */
export type WorkspaceFileReference = { fileId: string; binding: UploadDerivedBinding };

/** Internal only: original streaming still requires Upload receipt/integrity and final authorization. */
export type WorkspaceFileSource = {
  file_id: string;
  filename: string;
  uploadOperationId: string;
  user: string;
  tenantId: string | null;
  type: 'text/plain' | 'text/csv';
  bytes: number;
  source: 's3';
  storageKey: string;
  filepath: string;
  status: 'ready';
  retentionAcceptedAt: Date;
  expiredAt: Date;
  securityApproval: UploadSecurityApproval;
  derivedOrigin: UploadDerivedOrigin;
  /** Immutable actual original-receipt binding; excludes mutable deadline/revision. */
  sourceBindingSha256: string;
};

/** Existing deletion adapters need these routing fields, never content or authorization receipts. */
export type AccountFileCleanupCandidate = Pick<
  IMongoFile,
  | 'file_id'
  | 'user'
  | 'tenantId'
  | 'source'
  | 'filepath'
  | 'storageKey'
  | 'storageRegion'
  | 'bytes'
  | 'embedded'
  | 'uploadOperationId'
  | 'retentionAcceptedAt'
  | 'expiredAt'
  | 'deletionRequestedAt'
> & {
  metadata?: Pick<NonNullable<IMongoFile['metadata']>, 'codeEnvRef' | 'codeEnvRefs'>;
};

export type FileWorkspaceMethods = {
  getWorkspaceFile(
    owner: FileOwnerScope,
    reference: WorkspaceFileReference,
    now: number,
  ): Promise<WorkspaceFileSource>;
  touchWorkspaceFile(
    owner: FileOwnerScope,
    reference: WorkspaceFileReference,
    now: number,
    session: ClientSession,
  ): Promise<WorkspaceFileSource>;
  getAccountFileCleanupCandidates(owner: FileOwnerScope): Promise<AccountFileCleanupCandidate[]>;
};

function capture(owner: FileOwnerScope, reference: WorkspaceFileReference, now: number) {
  const scope = fileSourceScope(owner);
  const prototype = reference && Object.getPrototypeOf(reference);
  const fields = reference && Object.getOwnPropertyDescriptors(reference);
  const id = fields?.fileId?.value;
  const intent = readUploadDerivedIntent({
    binding: fields?.binding?.value,
    directSourceFileIds: [],
  });
  if (
    typeof scope.user !== 'string' ||
    !/^[a-fA-F0-9]{24}$/.test(scope.user) ||
    (prototype !== Object.prototype && prototype !== null) ||
    !fields ||
    Reflect.ownKeys(reference).length !== 2 ||
    !fields.fileId?.enumerable ||
    !fields.binding?.enumerable ||
    typeof id !== 'string' ||
    !/^[a-zA-Z0-9_.-]{1,128}$/.test(id) ||
    !intent ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    now > 8_640_000_000_000_000
  )
    throw new FileSourceUnavailableError();
  return {
    owner: { userId: scope.user, tenantId: scope.tenantId },
    reference: { fileId: id, binding: intent.binding },
    now,
  };
}

export function createFileWorkspaceMethods(
  mongoose: typeof import('mongoose'),
  options: { securityPolicySha256?: string } = {},
): FileWorkspaceMethods {
  const configuredPolicy = options.securityPolicySha256;
  const lifecycle = createFileRetentionMethods(mongoose, {
    securityPolicySha256: configuredPolicy,
  });

  async function touchWorkspaceFile(
    owner: FileOwnerScope,
    reference: WorkspaceFileReference,
    now: number,
    session: ClientSession,
  ): Promise<WorkspaceFileSource> {
    const input = capture(owner, reference, now);
    const policy = uploadSecurityPolicySha256(configuredPolicy);
    if (!session.inTransaction() || !policy) throw new FileSourceUnavailableError();
    const scope = fileSourceScope(input.owner);
    const filter = {
      ...scope,
      ...(scope.tenantId === null ? { tenantId: { $eq: null, $exists: true } } : {}),
      file_id: input.reference.fileId,
      uploadOperationId: input.reference.fileId,
      retentionAcceptedAt: { $ne: null },
      expiredAt: { $gt: new Date(input.now) },
      deletionRequestedAt: null,
      deletionCompletedAt: null,
      status: 'ready',
      embedded: true,
      'retentionActivity.migrationEpoch': { $exists: false },
      'derivedRetention.migrationEpoch': { $exists: false },
      $expr: { $gt: ['$expiredAt', '$$NOW'] },
      'derivedOrigin.binding.purpose': input.reference.binding.purpose,
      'derivedOrigin.binding.sourceId': input.reference.binding.sourceId,
      'derivedOrigin.binding.sourceRevision': input.reference.binding.sourceRevision,
      ...approvedFileFilter(policy, input.now),
    };
    const File = mongoose.models.File as Model<IMongoFile>;
    const row = await File.findOne(filter)
      .session(session)
      .select(
        'file_id uploadOperationId user tenantId type bytes source storageKey filepath status retentionAcceptedAt expiredAt retentionRevision +securityApproval +derivedOrigin +derivedRetention +retentionActivity',
      )
      .lean<IMongoFile>();
    if (!row) throw new FileSourceUnavailableError();
    const origin = readUploadDerivedOrigin(row.derivedOrigin);
    const subject = readUploadSecuritySubject(row.securityApproval?.subject);
    const acceptedAt = new Date(row.retentionAcceptedAt!).getTime();
    const expiresAt = new Date(row.expiredAt!).getTime();
    if (
      !origin ||
      JSON.stringify(origin.binding) !== JSON.stringify(input.reference.binding) ||
      origin.ancestors.some((source) => source.subject.operationId === row.file_id) ||
      !subject ||
      !matchesUploadSecurityApproval(row.securityApproval, subject, policy, input.now) ||
      (row.type !== 'text/plain' && row.type !== 'text/csv') ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes < 1 ||
      row.bytes > 65_536 ||
      !row.storageKey ||
      row.filepath !== `/api/files/managed/${input.reference.fileId}` ||
      !Number.isSafeInteger(acceptedAt) ||
      acceptedAt < 0 ||
      acceptedAt > input.now ||
      currentFileDeadline(row).kind !== 'derived'
    )
      throw new FileSourceUnavailableError();
    const actual = await lifecycle.captureManagedUploadOrigin(
      input.owner,
      { binding: origin.binding, directSourceFileIds: origin.directSourceFileIds },
      input.now,
      session,
    );
    if (
      !sameUploadDerivedOrigin(actual, origin) ||
      projectDerivedFileDeadline(
        row.derivedRetention!.ownDeadlineAt,
        actual.ancestors.map((source) => new Date(source.expiresAt)),
      ).getTime() !== expiresAt
    )
      throw new FileSourceUnavailableError();
    // The artifact itself must have the same actual durable receipt as its File metadata.
    const current = await loadManagedFileSource(mongoose, input.owner, row.file_id, 'original', {
      purpose: 'derived-parent',
      securityPolicySha256: policy,
      session,
    });
    if (
      current.file.retentionRevision !== row.retentionRevision ||
      current.file.expiredAt?.getTime() !== expiresAt
    )
      throw new FileSourceUnavailableError();
    const touched = await File.updateOne(
      { ...filter, retentionRevision: row.retentionRevision, expiredAt: row.expiredAt },
      { $inc: { retentionRevision: 1 } },
      { session, timestamps: false },
    );
    if (touched.matchedCount !== 1) throw new FileSourceUnavailableError();
    return {
      file_id: row.file_id,
      filename: current.file.filename,
      uploadOperationId: row.uploadOperationId!,
      user: scope.user,
      tenantId: scope.tenantId,
      type: row.type,
      bytes: row.bytes,
      source: 's3',
      storageKey: row.storageKey,
      filepath: row.filepath,
      status: 'ready',
      retentionAcceptedAt: new Date(acceptedAt),
      expiredAt: new Date(expiresAt),
      securityApproval: {
        ...row.securityApproval!,
        subject,
        coverage: { ...row.securityApproval!.coverage },
      },
      derivedOrigin: origin,
      sourceBindingSha256: current.binding,
    };
  }

  async function getWorkspaceFile(
    owner: FileOwnerScope,
    reference: WorkspaceFileReference,
    now: number,
  ): Promise<WorkspaceFileSource> {
    const input = capture(owner, reference, now);
    const session = await mongoose.startSession();
    try {
      return await session.withTransaction(
        () => touchWorkspaceFile(input.owner, input.reference, input.now, session),
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
      );
    } finally {
      await session.endSession();
    }
  }

  async function getAccountFileCleanupCandidates(
    owner: FileOwnerScope,
  ): Promise<AccountFileCleanupCandidate[]> {
    const scope = fileSourceScope(owner);
    if (typeof scope.user !== 'string' || !/^[a-fA-F0-9]{24}$/.test(scope.user))
      throw new FileSourceUnavailableError();
    const File = mongoose.models.File as Model<IMongoFile>;
    return File.find({ ...scope, deletionCompletedAt: null })
      .select(
        'file_id user tenantId source filepath storageKey storageRegion bytes embedded uploadOperationId retentionAcceptedAt expiredAt deletionRequestedAt metadata.codeEnvRef metadata.codeEnvRefs -_id',
      )
      .sort({ file_id: 1 })
      .lean<AccountFileCleanupCandidate[]>();
  }

  return { getWorkspaceFile, touchWorkspaceFile, getAccountFileCleanupCandidates };
}
