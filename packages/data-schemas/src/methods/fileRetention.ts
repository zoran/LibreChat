/** File lifecycle authority shared by File CRUD and transactional Message admission. */
import { UPLOAD_MAX_TEXT_BYTES, UPLOAD_RETENTION_MS } from 'librechat-data-provider';
import type { UploadPrincipal, UploadStorageReceipt } from 'librechat-data-provider';
import type { ClientSession, FilterQuery, Model } from 'mongoose';
import type { FileOwnerScope, FileSourceCopyReservation } from '~/types/file';
import type { IMongoFile, SourceRetentionContext } from '~/types';
import type { RetainedTextAllocation } from '~/types/message';
import { adjustRetainedTextBytes, RESOURCE_MAX } from './uploadManagementStore';
import { tenantStorage, SYSTEM_TENANT_ID } from '~/config/tenantContext';

/** Covers the BSON receipt and its bounded array-key overhead until File cleanup. */
const COPY_RECEIPT_BYTES = 256;
const MAX_COPY_RECEIPTS = 1024;

export function unreconciledDocumentStorage(): never {
  throw Object.assign(new Error('Document storage is not reconciled.'), {
    code: 'document_inventory_unreconciled',
  });
}

/** File owns copy liabilities; Message owns each allocation receipt. Both join the same commit. */
export async function resizeMessageDerivatives(
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
    ...fileSourceScope(owner),
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
      { _id: row._id, ...fileSourceScope(owner) },
      {
        $inc: { retainedDerivativeBytes: changes.get(row.file_id)!, retentionRevision: 1 },
      },
      { session, timestamps: false },
    );
  }
}

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
        $or: [{ uploadOperationId: { $exists: false } }, { status: 'ready' }],
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
  reserveFileSourceCopies(
    owner: FileOwnerScope,
    input: { reservationId: string; sourceFileIds: readonly string[]; bytes: number },
  ): Promise<FileSourceCopyReservation>;
  releaseFileSourceCopies(owner: FileOwnerScope, receipt: FileSourceCopyReservation): Promise<void>;
  acceptManagedUpload(input: ManagedUploadAcceptance, session: ClientSession): Promise<void>;
  claimManagedUploadProcessing(
    owner: FileOwnerScope,
    operationId: string,
    generation: number,
    now: number,
    session: ClientSession,
  ): Promise<void>;
  publishManagedUpload(
    owner: FileOwnerScope,
    operationId: string,
    generation: number,
    text: string,
    now: number,
    session: ClientSession,
  ): Promise<void>;
  revokeManagedUpload(
    owner: FileOwnerScope,
    operationId: string,
    now: number,
    session: ClientSession,
  ): Promise<void>;
  getManagedUploadAvailability(
    owner: FileOwnerScope,
    operationIds: readonly string[],
    now: number,
  ): Promise<{ fileId: string; ready: boolean }[]>;
  touchManagedUploadForRetry(
    owner: FileOwnerScope,
    operationId: string,
    now: number,
    session: ClientSession,
  ): Promise<void>;
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
  async function reserveFileSourceCopies(
    owner: FileOwnerScope,
    input: {
      reservationId: string;
      sourceFileIds: readonly string[];
      bytes: number;
    },
  ): Promise<FileSourceCopyReservation> {
    if (
      !/^[a-f0-9]{64}$/.test(input.reservationId) ||
      !Number.isSafeInteger(input.bytes) ||
      input.bytes <= 0 ||
      input.bytes > RESOURCE_MAX.textBytes ||
      !input.sourceFileIds.length ||
      input.sourceFileIds.length > 64
    )
      throw new FileSourceUnavailableError();
    const File = mongoose.models.File as Model<IMongoFile>;
    const session = await mongoose.startSession();
    let receipt: FileSourceCopyReservation | undefined;
    try {
      await session.withTransaction(
        async () => {
          const ids = [...new Set(input.sourceFileIds)].sort();
          const context = await touchFileSources(mongoose, owner, ids, session);
          if (context?.sourceFileIds.length !== ids.length) throw new FileSourceUnavailableError();
          const existing = await File.findOne({
            ...fileSourceScope(owner),
            'retainedDerivativeReservations.reservationId': input.reservationId,
          })
            .select('file_id +retainedDerivativeReservations +retainedDerivativeBytes')
            .session(session)
            .lean<IMongoFile>();
          if (existing) {
            const prior = existing.retainedDerivativeReservations!.find(
              (item) => item.reservationId === input.reservationId,
            )!;
            if (
              prior.state !== 'held' ||
              prior.bytes !== input.bytes ||
              !ids.includes(existing.file_id)
            )
              throw new FileSourceUnavailableError();
            if (
              !Number.isSafeInteger(existing.retainedDerivativeBytes) ||
              existing.retainedDerivativeBytes! < prior.bytes + COPY_RECEIPT_BYTES
            )
              unreconciledDocumentStorage();
            receipt = { fileId: existing.file_id, ...prior };
            return;
          }
          const file = await File.findOne({ ...fileSourceScope(owner), file_id: ids[0] })
            .select('file_id +retainedDerivativeReservations +retainedDerivativeBytes')
            .session(session)
            .lean<IMongoFile>();
          if (
            !file ||
            !Number.isSafeInteger(file.retainedDerivativeBytes) ||
            file.retainedDerivativeBytes! < 0
          )
            unreconciledDocumentStorage();
          if ((file.retainedDerivativeReservations?.length ?? 0) >= MAX_COPY_RECEIPTS) {
            throw Object.assign(
              new Error(
                'Document copy capacity is full. Use another document or retry after cleanup.',
              ),
              { code: 'document_capacity_exceeded' },
            );
          }
          const stored = {
            reservationId: input.reservationId,
            bytes: input.bytes,
            state: 'held' as const,
          };
          const charged = input.bytes + COPY_RECEIPT_BYTES;
          await adjustRetainedTextBytes(mongoose, charged, session);
          await File.updateOne(
            { ...fileSourceScope(owner), _id: file._id },
            {
              $inc: { retainedDerivativeBytes: charged, retentionRevision: 1 },
              $push: { retainedDerivativeReservations: stored },
            },
            { session, timestamps: false },
          );
          receipt = { fileId: file.file_id, ...stored };
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
      );
      return receipt!;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Trusted stream owner calls only after exact epoch stop and durable purge; never browser input.
   * Its persisted pre-reserve intent may stand in for a lost receipt. Missing reservations are
   * fenced with a charged tombstone; callers retain their intent on every failed/unknown outcome.
   */
  async function releaseFileSourceCopies(
    owner: FileOwnerScope,
    receipt: FileSourceCopyReservation,
  ): Promise<void> {
    if (!receipt.fileId || !/^[a-f0-9]{64}$/.test(receipt.reservationId))
      throw new FileSourceUnavailableError();
    const File = mongoose.models.File as Model<IMongoFile>;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(
        async () => {
          const file = await File.findOne({ ...fileSourceScope(owner), file_id: receipt.fileId })
            .select(
              'file_id retentionAcceptedAt deletionCompletedAt +retainedDerivativeReservations +retainedDerivativeBytes',
            )
            .session(session)
            .lean<IMongoFile>();
          if (!file) throw new FileSourceUnavailableError();
          if (file.deletionCompletedAt && file.retainedDerivativeBytes === 0) return;
          const stored = file.retainedDerivativeReservations?.find(
            (item) => item.reservationId === receipt.reservationId,
          );
          if (!stored) {
            if (!file.retentionAcceptedAt) throw new FileSourceUnavailableError();
            if (
              !Number.isSafeInteger(file.retainedDerivativeBytes) ||
              file.retainedDerivativeBytes! < 0
            )
              unreconciledDocumentStorage();
            if ((file.retainedDerivativeReservations?.length ?? 0) >= MAX_COPY_RECEIPTS) {
              throw Object.assign(
                new Error(
                  'Document copy capacity is full. Use another document or retry after cleanup.',
                ),
                { code: 'document_capacity_exceeded' },
              );
            }
            await adjustRetainedTextBytes(mongoose, COPY_RECEIPT_BYTES, session);
            await File.updateOne(
              { ...fileSourceScope(owner), _id: file._id },
              {
                $inc: { retainedDerivativeBytes: COPY_RECEIPT_BYTES, retentionRevision: 1 },
                $push: {
                  retainedDerivativeReservations: {
                    reservationId: receipt.reservationId,
                    bytes: 0,
                    state: 'released',
                  },
                },
              },
              { session, timestamps: false },
            );
            return;
          }
          if (stored.state === 'released') return;
          if (
            !Number.isSafeInteger(stored.bytes) ||
            stored.bytes <= 0 ||
            !Number.isSafeInteger(file.retainedDerivativeBytes) ||
            file.retainedDerivativeBytes! < stored.bytes + COPY_RECEIPT_BYTES
          )
            unreconciledDocumentStorage();
          await adjustRetainedTextBytes(mongoose, -stored.bytes, session);
          await File.updateOne(
            { ...fileSourceScope(owner), _id: file._id },
            {
              $inc: { retainedDerivativeBytes: -stored.bytes, retentionRevision: 1 },
              $set: { 'retainedDerivativeReservations.$[receipt].state': 'released' },
            },
            {
              session,
              timestamps: false,
              arrayFilters: [{ 'receipt.reservationId': receipt.reservationId }],
            },
          );
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
      );
    } finally {
      await session.endSession();
    }
  }
  async function acceptManagedUpload(
    input: ManagedUploadAcceptance,
    session: ClientSession,
  ): Promise<void> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const owner = fileSourceScope(input.principal);
    if (
      !session.inTransaction() ||
      input.expiresAt !== input.acceptedAt + UPLOAD_RETENTION_MS ||
      input.receipt.outcome !== 'durable'
    )
      throw new FileSourceUnavailableError();
    await File.create(
      [
        {
          ...owner,
          file_id: input.operationId,
          uploadOperationId: input.operationId,
          filename: input.filename,
          type: input.mediaType,
          bytes: input.receipt.bytes,
          filepath: input.receipt.filepath,
          source: input.receipt.source,
          storageKey: input.receipt.storageKey,
          object: 'file',
          context: 'message_attachment',
          status: 'pending',
          retentionAcceptedAt: new Date(input.acceptedAt),
          expiredAt: new Date(input.expiresAt),
          retentionRevision: 0,
          llmDeliveryPath: 'text',
        },
      ],
      { session },
    );
  }
  function managedFilter(owner: FileOwnerScope, operationId: string, now: number) {
    return {
      ...fileSourceScope(owner),
      file_id: operationId,
      uploadOperationId: operationId,
      retentionAcceptedAt: { $ne: null },
      expiredAt: { $gt: new Date(now) },
      deletionRequestedAt: null,
      deletionCompletedAt: null,
    };
  }
  async function claimManagedUploadProcessing(
    owner: FileOwnerScope,
    operationId: string,
    generation: number,
    now: number,
    session: ClientSession,
  ): Promise<void> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const result = await File.updateOne(
      managedFilter(owner, operationId, now),
      {
        $set: { previewRevision: String(generation), status: 'pending' },
        $inc: { retentionRevision: 1 },
      },
      { session, timestamps: false },
    );
    if (result.matchedCount !== 1) throw new FileSourceUnavailableError();
  }
  async function publishManagedUpload(
    owner: FileOwnerScope,
    operationId: string,
    generation: number,
    text: string,
    now: number,
    session: ClientSession,
  ): Promise<void> {
    if (
      !session.inTransaction() ||
      !text.length ||
      Buffer.byteLength(text, 'utf8') > UPLOAD_MAX_TEXT_BYTES
    ) {
      throw new FileSourceUnavailableError();
    }
    const File = mongoose.models.File as Model<IMongoFile>;
    const result = await File.updateOne(
      { ...managedFilter(owner, operationId, now), previewRevision: String(generation) },
      {
        $set: { text, textFormat: 'text', status: 'ready', embedded: true },
        $inc: { retentionRevision: 1 },
      },
      { session, timestamps: false },
    );
    if (result.matchedCount !== 1) throw new FileSourceUnavailableError();
  }
  async function revokeManagedUpload(
    owner: FileOwnerScope,
    operationId: string,
    now: number,
    session: ClientSession,
  ): Promise<void> {
    const File = mongoose.models.File as Model<IMongoFile>;
    await File.updateOne(
      {
        ...fileSourceScope(owner),
        file_id: operationId,
        uploadOperationId: operationId,
        deletionRequestedAt: null,
      },
      {
        $set: { deletionRequestedAt: new Date(now) },
        $inc: { retentionRevision: 1 },
      },
      { session, timestamps: false },
    );
  }
  async function getManagedUploadAvailability(
    owner: FileOwnerScope,
    operationIds: readonly string[],
    now: number,
  ): Promise<{ fileId: string; ready: boolean }[]> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const rows = await File.find({
      ...fileSourceScope(owner),
      uploadOperationId: { $in: operationIds },
      expiredAt: { $gt: new Date(now) },
      deletionRequestedAt: null,
      deletionCompletedAt: null,
    })
      .select('file_id status')
      .lean<IMongoFile[]>();
    return rows.map((row) => ({ fileId: row.file_id, ready: row.status === 'ready' }));
  }
  async function touchManagedUploadForRetry(
    owner: FileOwnerScope,
    operationId: string,
    now: number,
    session: ClientSession,
  ): Promise<void> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const result = await File.updateOne(
      managedFilter(owner, operationId, now),
      { $inc: { retentionRevision: 1 } },
      { session, timestamps: false },
    );
    if (result.matchedCount !== 1) throw new FileSourceUnavailableError();
  }
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
      'retainedDerivativeBytes',
    ]);
    for (const row of rows) {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(
          async () => {
            const current = await File.findOne({ ...fileSourceScope(owner), _id: row._id })
              .select('+retainedDerivativeBytes +retainedDerivativeReservations')
              .session(session)
              .lean<IMongoFile>();
            if (!current?.deletionRequestedAt) throw new FileSourceUnavailableError();
            if (
              !Number.isSafeInteger(current.retainedDerivativeBytes) ||
              current.retainedDerivativeBytes! < 0
            )
              unreconciledDocumentStorage();
            await adjustRetainedTextBytes(mongoose, -current.retainedDerivativeBytes!, session);
            const unset = Object.fromEntries(
              Object.keys(current)
                .filter((key) => !keep.has(key))
                .map((key) => [key, 1]),
            );
            await File.updateOne(
              { ...fileSourceScope(owner), _id: row._id, deletionRequestedAt: { $ne: null } },
              {
                $unset: unset,
                $set: {
                  retainedDerivativeBytes: 0,
                  deletionCompletedAt: current.deletionCompletedAt ?? new Date(),
                },
              },
              { session, timestamps: false },
            );
          },
          { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
        );
      } finally {
        await session.endSession();
      }
      completedFileIds.push(row.file_id);
    }
    return { completedFileIds };
  }
  return {
    reserveFileSourceCopies,
    releaseFileSourceCopies,
    acceptManagedUpload,
    claimManagedUploadProcessing,
    publishManagedUpload,
    revokeManagedUpload,
    getManagedUploadAvailability,
    touchManagedUploadForRetry,
    getFileSourceDeletionCandidates,
    revokeFileSources,
    finalizeFileSourceDeletion,
  };
}

export type ManagedUploadAcceptance = {
  principal: UploadPrincipal;
  operationId: string;
  filename: string;
  mediaType: string;
  receipt: UploadStorageReceipt;
  acceptedAt: number;
  expiresAt: number;
};
