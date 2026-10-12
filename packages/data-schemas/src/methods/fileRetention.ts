/** File lifecycle authority shared by File CRUD and transactional Message admission. */
import type { ClientSession, FilterQuery, Model } from 'mongoose';
import type { IMongoFile, SourceRetentionContext } from '~/types';
import type { FileOwnerScope } from '~/types/file';
import { tenantStorage, SYSTEM_TENANT_ID } from '~/config/tenantContext';

export class FileSourceUnavailableError extends Error {
  constructor() {
    super('Document source unavailable');
    this.name = 'FileSourceUnavailableError';
  }
}

export function fileSourceScope(owner: FileOwnerScope): { user: string; tenantId: string | null } {
  const tenant = tenantStorage.getStore()?.tenantId;
  if (!owner.userId || (tenant && tenant !== SYSTEM_TENANT_ID && tenant !== owner.tenantId)) {
    throw new FileSourceUnavailableError();
  }
  return { user: owner.userId, tenantId: owner.tenantId || null };
}

/** Unmanaged files keep upstream semantics. Managed files never outlive original admission. */
export function liveFileFilter(): FilterQuery<IMongoFile> {
  return {
    $or: [
      { retentionAcceptedAt: null },
      {
        retentionAcceptedAt: { $ne: null },
        deletionRequestedAt: null,
        deletionCompletedAt: null,
        expiredAt: { $gt: new Date() },
      },
    ],
  };
}

export async function resolveFileSources(
  mongoose: typeof import('mongoose'),
  owner: FileOwnerScope,
  ids: readonly string[],
  session?: ClientSession,
): Promise<SourceRetentionContext | undefined> {
  const unique = [...new Set(ids)];
  if (!unique.length) return undefined;
  const File = mongoose.models.File as Model<IMongoFile>;
  const rows = await File.find({
    $and: [fileSourceScope(owner), { file_id: { $in: unique } }, liveFileFilter()],
  })
    .session(session ?? null)
    .select('file_id retentionAcceptedAt expiredAt')
    .lean<IMongoFile[]>();
  if (rows.length !== unique.length) throw new FileSourceUnavailableError();
  const managed = rows.filter((row) => row.retentionAcceptedAt != null);
  if (!managed.length) return undefined;
  return {
    sourceFileIds: managed.map((row) => row.file_id).sort(),
    sourceExpiresAt: new Date(
      Math.min(...managed.map((row) => new Date(row.expiredAt!).getTime())),
    ),
  };
}

/** Real writes to the same File rows as revoke, in the caller's Message transaction. */
export async function touchFileSources(
  mongoose: typeof import('mongoose'),
  owner: FileOwnerScope,
  ids: readonly string[],
  session: ClientSession,
): Promise<SourceRetentionContext | undefined> {
  const context = await resolveFileSources(mongoose, owner, ids, session);
  if (!context) return undefined;
  const File = mongoose.models.File as Model<IMongoFile>;
  const result = await File.updateMany(
    {
      $and: [
        fileSourceScope(owner),
        { file_id: { $in: context.sourceFileIds }, retentionAcceptedAt: { $ne: null } },
        liveFileFilter(),
      ],
    },
    { $inc: { retentionRevision: 1 } },
    { session, timestamps: false },
  );
  if (result.matchedCount !== context.sourceFileIds.length) throw new FileSourceUnavailableError();
  return context;
}

export function createFileRetentionMethods(mongoose: typeof import('mongoose')): {
  getFileSourceDeletionCandidates(
    owner: FileOwnerScope,
    fileIds: readonly string[],
  ): Promise<IMongoFile[]>;
  revokeFileSources(owner: FileOwnerScope, fileIds: readonly string[]): Promise<void>;
  finalizeFileSourceDeletion(
    owner: FileOwnerScope,
    fileIds: readonly string[],
  ): Promise<{ completedFileIds: string[] }>;
} {
  async function loadFileSourceRecords(owner: FileOwnerScope, fileIds: readonly string[]) {
    const File = mongoose.models.File as Model<IMongoFile>;
    return File.find({
      ...fileSourceScope(owner),
      file_id: { $in: [...new Set(fileIds)] },
      retentionAcceptedAt: { $ne: null },
    }).lean<IMongoFile[]>();
  }

  async function getFileSourceDeletionCandidates(
    owner: FileOwnerScope,
    fileIds: readonly string[],
  ) {
    return (await loadFileSourceRecords(owner, fileIds)).filter((row) => !row.deletionCompletedAt);
  }

  async function revokeFileSources(
    owner: FileOwnerScope,
    fileIds: readonly string[],
  ): Promise<void> {
    const ids = [...new Set(fileIds)];
    if (!ids.length) return;
    const rows = await loadFileSourceRecords(owner, ids);
    if (rows.length !== ids.length) throw new FileSourceUnavailableError();
    const File = mongoose.models.File as Model<IMongoFile>;
    await File.updateMany(
      {
        ...fileSourceScope(owner),
        file_id: { $in: ids },
        retentionAcceptedAt: { $ne: null },
        deletionRequestedAt: null,
      },
      {
        $set: { deletionRequestedAt: new Date() },
        $inc: { retentionRevision: 1 },
        $unset: { deletionRetryAt: 1 },
      },
      { timestamps: false },
    );
  }

  /** Only deletion composition calls this after storage, Message and replay completion. */
  async function finalizeFileSourceDeletion(owner: FileOwnerScope, fileIds: readonly string[]) {
    const File = mongoose.models.File as Model<IMongoFile>;
    const rows = await loadFileSourceRecords(owner, fileIds);
    const completedFileIds: string[] = [];
    const keep = new Set([
      '_id',
      '__v',
      'file_id',
      'user',
      'tenantId',
      'createdAt',
      'retentionAcceptedAt',
      'expiredAt',
      'retentionRevision',
      'deletionRequestedAt',
      'deletionCompletedAt',
    ]);
    for (const row of rows) {
      if (!row.deletionRequestedAt) throw new FileSourceUnavailableError();
      const unset = Object.fromEntries(
        Object.keys(row)
          .filter((key) => !keep.has(key))
          .map((key) => [key, 1]),
      );
      await File.updateOne(
        { ...fileSourceScope(owner), _id: row._id, deletionRequestedAt: { $ne: null } },
        { $unset: unset, $set: { deletionCompletedAt: row.deletionCompletedAt ?? new Date() } },
        { timestamps: false },
      );
      completedFileIds.push(row.file_id);
    }
    return { completedFileIds };
  }
  return { getFileSourceDeletionCandidates, revokeFileSources, finalizeFileSourceDeletion };
}
