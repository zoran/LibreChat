/** fileRetentionAccounting owns retained-copy liabilities and source activity fences. */

import type { ClientSession, FilterQuery, Model } from 'mongoose';
import type { IMongoFile, SourceRetentionContext } from '~/types';
import type { RetainedTextAllocation } from '~/types/file';
import type { FileOwnerScope } from '~/types/file';
import {
  FileSourceUnavailableError,
  fileSourceScope,
  managedFileScope,
  inspectFileSources,
  boundedFileSourceIds,
  currentManagedFileFilter,
} from './fileSourceAuthority';
import { adjustRetainedTextBytes } from './uploadManagementStore';
import { SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { approvedFileFilter } from './fileSecurity';
export {
  FileSourceUnavailableError,
  FileSourceCapacityError,
  fileSourceScope,
  inspectFileSources,
} from './fileSourceAuthority';
import { touchActiveUserPrincipal } from './userPrincipal';

/** Covers the BSON receipt and its bounded array-key overhead until File cleanup. */
export const COPY_RECEIPT_BYTES = 256;
export const MAX_COPY_RECEIPTS = 1024;

export function unreconciledDocumentStorage(): never {
  throw Object.assign(new Error('Document storage is not reconciled.'), {
    code: 'document_inventory_unreconciled',
  });
}

/** File owns copy liabilities; retained consumers own their allocation receipts. Both join the same commit. */
export async function resizeRetainedDerivatives(
  mongoose: typeof import('mongoose'),
  owner: FileOwnerScope,
  previous: readonly RetainedTextAllocation[],
  next: readonly RetainedTextAllocation[],
  session: ClientSession,
): Promise<void> {
  if (!session.inTransaction()) throw new Error('Derivative writes require a transaction');
  const changes = new Map<string, number>();
  for (const [allocations, sign] of [
    [previous, -1],
    [next, 1],
  ] as const) {
    const seen = new Set<string>();
    if (allocations.length > 64) unreconciledDocumentStorage();
    for (const { fileId, bytes } of allocations) {
      if (!fileId || seen.has(fileId) || !Number.isSafeInteger(bytes) || bytes < 0)
        unreconciledDocumentStorage();
      seen.add(fileId);
      changes.set(fileId, (changes.get(fileId) ?? 0) + sign * bytes);
    }
  }
  for (const [id, delta] of changes) if (delta === 0) changes.delete(id);
  if (!changes.size) return;
  const File = mongoose.models.File as Model<IMongoFile>;
  const rows = await File.find({
    ...managedFileScope(owner),
    file_id: { $in: [...changes.keys()] },
    retentionAcceptedAt: { $ne: null },
  })
    .select(
      'file_id retentionAcceptedAt expiredAt deletionRequestedAt deletionCompletedAt +retainedDerivativeBytes',
    )
    .session(session)
    .lean<IMongoFile[]>();
  if (rows.length !== changes.size) throw new FileSourceUnavailableError();
  const now = new Date();
  for (const row of rows) {
    const delta = changes.get(row.file_id)!;
    if (
      !Number.isSafeInteger(row.retainedDerivativeBytes) ||
      row.retainedDerivativeBytes! < 0 ||
      row.retainedDerivativeBytes! + delta < 0
    )
      unreconciledDocumentStorage();
    if (
      delta > 0 &&
      (row.deletionRequestedAt || row.deletionCompletedAt || !row.expiredAt || row.expiredAt <= now)
    )
      throw new FileSourceUnavailableError();
  }
  await adjustRetainedTextBytes(
    mongoose,
    [...changes.values()].reduce((sum, bytes) => sum + bytes, 0),
    session,
  );
  for (const row of rows) {
    await File.updateOne(
      { _id: row._id, ...managedFileScope(owner) },
      {
        $inc: { retainedDerivativeBytes: changes.get(row.file_id)!, retentionRevision: 1 },
      },
      { session, timestamps: false },
    );
  }
}

/** Unmanaged files keep upstream semantics. Managed files use their current owner deadline. */
export function liveFileFilter(): FilterQuery<IMongoFile> {
  const security = approvedFileFilter();
  const managedOnly = process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED === 'true';
  return {
    // Draft access belongs to a later explicit Workspace consumer, never native attachments.
    derivedOrigin: { $exists: false },
    $or: [
      ...(!managedOnly
        ? [{ retentionAcceptedAt: null, uploadOperationId: { $exists: false } }]
        : []),
      {
        retentionAcceptedAt: { $ne: null },
        $and: [
          {
            $or: [
              { tenantId: { $type: 10 } },
              {
                tenantId: {
                  $type: 'string',
                  $regex: /^[a-zA-Z0-9_.-]{1,128}$/,
                  $ne: SYSTEM_TENANT_ID,
                },
              },
            ],
          },
        ],
        deletionRequestedAt: null,
        deletionCompletedAt: null,
        expiredAt: { $gt: new Date() },
        $or: [
          ...(!managedOnly ? [{ uploadOperationId: { $exists: false } }] : []),
          { status: 'ready', ...security },
        ],
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
  const observed = await inspectFileSources(mongoose, owner, ids, session);
  if (observed.some((source) => source.state === 'unavailable'))
    throw new FileSourceUnavailableError();
  const retained = observed.flatMap((source) =>
    source.state !== 'unavailable' && source.sourceExpiresAt !== null
      ? [{ fileId: source.fileId, deadline: source.sourceExpiresAt }]
      : [],
  );
  if (!retained.length) return undefined;
  return {
    sourceFileIds: retained.map((source) => source.fileId).sort(),
    sourceExpiresAt: new Date(Math.min(...retained.map((source) => source.deadline.getTime()))),
  };
}

/** Conditional writes serialize retained consumers with current activity, revoke and migration. */
export async function touchFileSources(
  mongoose: typeof import('mongoose'),
  owner: FileOwnerScope,
  ids: readonly string[],
  session: ClientSession,
): Promise<SourceRetentionContext | undefined> {
  const unique = boundedFileSourceIds(ids);
  if (!session.inTransaction()) throw new FileSourceUnavailableError();
  if (!unique.length) return undefined;
  const scope = fileSourceScope(owner);
  await touchActiveUserPrincipal(
    mongoose,
    { userId: scope.user, tenantId: scope.tenantId },
    session,
  );
  const observed = await inspectFileSources(mongoose, owner, unique, session);
  if (observed.some((source) => source.state === 'unavailable'))
    throw new FileSourceUnavailableError();
  const File = mongoose.models.File as Model<IMongoFile>;
  const retained = observed.filter(
    (source): source is Exclude<typeof source, { state: 'unavailable' }> =>
      source.state !== 'unavailable' && source.sourceExpiresAt !== null,
  );
  for (const source of retained) {
    const current = await File.findOne({ ...scope, file_id: source.fileId })
      .select('retentionRevision')
      .session(session)
      .maxTimeMS(1000)
      .lean<IMongoFile>();
    if (!current) throw new FileSourceUnavailableError();
    const now = Date.now();
    const live =
      source.state === 'managed'
        ? currentManagedFileFilter(owner, source.fileId, now)
        : {
            ...managedFileScope(owner),
            file_id: source.fileId,
            uploadOperationId: { $exists: false },
            retentionAcceptedAt: { $ne: null },
            derivedOrigin: { $exists: false },
            deletionRequestedAt: null,
            deletionCompletedAt: null,
            $and: [
              { expiredAt: { $gt: new Date(now) } },
              { $expr: { $gt: ['$expiredAt', '$$NOW'] } },
            ],
          };
    const touched = await File.updateOne(
      {
        ...live,
        expiredAt: source.sourceExpiresAt,
        retentionRevision:
          current.retentionRevision === undefined ? { $exists: false } : current.retentionRevision,
      },
      { $inc: { retentionRevision: 1 } },
      { session, timestamps: false },
    );
    if (!touched.acknowledged || touched.matchedCount !== 1) throw new FileSourceUnavailableError();
  }
  if (!retained.length) return undefined;
  return {
    sourceFileIds: retained.map((source) => source.fileId).sort(),
    sourceExpiresAt: new Date(
      Math.min(...retained.map((source) => source.sourceExpiresAt!.getTime())),
    ),
  };
}
