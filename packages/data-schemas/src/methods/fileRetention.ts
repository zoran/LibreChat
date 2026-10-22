import { createHash } from 'node:crypto';
import {
  isStorageDeletionResult,
  isStorageDeletionConsumptionResult,
  canonicalStorageDeletionReceipt,
} from 'librechat-data-provider';
/** File lifecycle authority shared by File CRUD and transactional Message admission. */
import { randomUUID } from 'crypto';
import {
  UPLOAD_MAX_TEXT_BYTES,
  UPLOAD_DERIVED_MAX_DESCENDANTS,
  isUploadPrincipal,
  readUploadDerivedOrigin,
  readHistoricalUploadDerivedOrigin,
  UPLOAD_RETENTION_MS,
  sameUploadDerivedOrigin,
  readManagedDocumentResult,
} from 'librechat-data-provider';
import type {
  ManagedDocumentResult,
  UploadDerivedIntent,
  UploadDerivedOrigin,
} from 'librechat-data-provider';
import type { ClientSession, FilterQuery, Model } from 'mongoose';
import type {
  FileOwnerScope,
  FileSourceCopyReservation,
  ManagedUploadAcceptance,
  FileRetentionAdmission,
} from '~/types/file';
import type { IMongoFile, SourceRetentionContext } from '~/types';
import type { RetainedTextAllocation } from '~/types/file';
import { adjustRetainedTextBytes, RESOURCE_MAX } from './uploadManagementStore';
import {
  approvedFileFilter,
  captureManagedFileApproval,
  uploadSecurityPolicySha256,
} from './fileSecurity';
import {
  captureDerivedFileOrigin,
  projectDerivedFileDeadline,
  refreshDerivedFileDeadlines,
} from './fileDerivedRetention';
import { projectFileHousekeeping } from './fileHousekeepingProjection';
import {
  prepareManagedRetrievalPublication,
  createManagedFileRetrievalInventory,
  managedFileRetrievalDeletionSettled,
} from './fileRetrieval';
import { SYSTEM_TENANT_ID } from '~/config/tenantContext';
import {
  FileSourceUnavailableError,
  FileSourceCapacityError,
  fileSourceScope,
  managedFileScope,
  inspectFileSources,
  boundedFileSourceIds,
  currentManagedFileFilter,
  currentFileDeadline,
} from './fileSourceAuthority';
export {
  FileSourceUnavailableError,
  FileSourceCapacityError,
  fileSourceScope,
  inspectFileSources,
} from './fileSourceAuthority';
import { touchActiveUserPrincipal } from './userPrincipal';

import type { FilePublicationActivityResult } from '~/types/fileActivity';
import {
  initialFileRetentionActivity,
  advanceFileRetentionActivity,
} from './fileActivityTransition';

/** Covers the BSON receipt and its bounded array-key overhead until File cleanup. */
const COPY_RECEIPT_BYTES = 256;
const MAX_COPY_RECEIPTS = 1024;

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

/** All cleanup entry paths retain the real File custody, receipt and consumption guard. */
function fileCleanupReady(file: IMongoFile, finalize: boolean): boolean {
  const p = file.retentionCleanup;
  const l = p?.lifecycle;
  const s = l?.storage;
  if (
    !p ||
    p.schema !== 1 ||
    p.revocationId !== file.retentionRevocationId ||
    p.capture.complete !== true ||
    p.capture.recoveryUnresolved !== false ||
    typeof p.generationReceiptRef !== 'string' ||
    !p.generationReceiptRef.length ||
    p.generationReceiptRef.length > 256 ||
    !l ||
    l.derivatives.retrieval !== 'complete' ||
    l.derivatives.checkpoints !== 'complete' ||
    l.derivatives.messages !== 'complete' ||
    !s ||
    !['terminal', 'committed', 'consumed'].includes(s.state) ||
    !('receipt' in s) ||
    Buffer.byteLength(JSON.stringify(p)) > 32768
  )
    return false;
  if (
    !isStorageDeletionResult(s.receipt, s.binding) ||
    s.receipt.state !== 'durable_delete_complete' ||
    s.receiptSHA256 !==
      createHash('sha256').update(canonicalStorageDeletionReceipt(s.receipt)).digest('hex')
  )
    return false;
  return (
    !finalize ||
    (s.state === 'consumed' &&
      s.consumption.state === 'recorded' &&
      l.contentPrepared === true &&
      typeof l.completionRef === 'string' &&
      l.completionRef.length > 0 &&
      l.completionRef.length <= 256 &&
      isStorageDeletionConsumptionResult(s.consumption, {
        obligationId: s.receipt.obligationId,
        receiptSHA256: s.receiptSHA256,
        consumerCommitId: s.consumerCommitId,
      }))
  );
}

export function createFileRetentionMethods(
  mongoose: typeof import('mongoose'),
  options: { securityPolicySha256?: string; extractionPolicySha256?: string } = {},
): {
  reserveFileSourceCopies(
    owner: FileOwnerScope,
    input: { reservationId: string; sourceFileIds: readonly string[]; bytes: number },
  ): Promise<FileSourceCopyReservation>;
  releaseFileSourceCopies(owner: FileOwnerScope, receipt: FileSourceCopyReservation): Promise<void>;
  captureManagedUploadOrigin(
    owner: FileOwnerScope,
    intent: UploadDerivedIntent,
    now: number,
    session: ClientSession,
  ): Promise<UploadDerivedOrigin>;
  acceptManagedUpload(
    input: ManagedUploadAcceptance,
    session: ClientSession,
  ): Promise<FileRetentionAdmission>;
  claimManagedUploadProcessing(
    owner: FileOwnerScope,
    operationId: string,
    generation: number,
    now: number,
    session: ClientSession,
  ): Promise<void>;
  assertManagedUploadProcessing(
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
    result: ManagedDocumentResult,
    now: number,
    session: ClientSession,
  ): Promise<FilePublicationActivityResult>;
  revokeExpiredManagedUpload(
    owner: FileOwnerScope,
    operationId: string,
    expectedDeadline: number,
    now: number,
    session: ClientSession,
  ): Promise<boolean>;
  revokeManagedUpload(
    owner: FileOwnerScope,
    operationId: string,
    now: number,
    session: ClientSession,
  ): Promise<{ revokedFileIds: string[] }>;
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
  revokeFileSources(
    owner: FileOwnerScope,
    fileIds: readonly string[],
  ): Promise<{ revokedFileIds: string[] }>;
  assertFileSourceDeletionReady(owner: FileOwnerScope, fileIds: readonly string[]): Promise<void>;
  settleFileSourceDeletionInSession(
    owner: FileOwnerScope,
    fileId: string,
    finalize: boolean,
    session: ClientSession,
  ): Promise<boolean>;
  prepareFileSourceDeletion(
    owner: FileOwnerScope,
    fileIds: readonly string[],
  ): Promise<{ preparedFileIds: string[] }>;
  finalizeFileSourceDeletion(
    owner: FileOwnerScope,
    fileIds: readonly string[],
  ): Promise<{ completedFileIds: string[] }>;
} {
  /** Capture the existing File authority, including private drafts, in the caller's transaction. */
  async function captureManagedUploadOrigin(
    owner: FileOwnerScope,
    value: UploadDerivedIntent,
    now: number,
    session: ClientSession,
  ): Promise<UploadDerivedOrigin> {
    if (!Number.isSafeInteger(now) || now < 0) throw new FileSourceUnavailableError();
    const policy = uploadSecurityPolicySha256(options.securityPolicySha256);
    if (!policy) throw new FileSourceUnavailableError();
    return captureDerivedFileOrigin(mongoose, owner, value, session, policy);
  }

  function descendantFilter(scope: FilterQuery<IMongoFile>, id: string): FilterQuery<IMongoFile> {
    return {
      ...scope,
      'derivedOrigin.ancestors.subject.operationId': id,
      deletionCompletedAt: null,
    };
  }

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
            ...managedFileScope(owner),
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
          const file = await File.findOne({ ...managedFileScope(owner), file_id: ids[0] })
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
            { ...managedFileScope(owner), _id: file._id },
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
          const file = await File.findOne({ ...managedFileScope(owner), file_id: receipt.fileId })
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
              { ...managedFileScope(owner), _id: file._id },
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
            { ...managedFileScope(owner), _id: file._id },
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
  ): Promise<FileRetentionAdmission> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const owner = fileSourceScope(input.principal);
    const securityApproval = captureManagedFileApproval(input, options.securityPolicySha256);
    const origin =
      input.derivedOrigin === undefined ? undefined : readUploadDerivedOrigin(input.derivedOrigin);
    const ownDeadline = new Date(input.acceptedAt + UPLOAD_RETENTION_MS);
    if (
      !Number.isSafeInteger(input.acceptedAt) ||
      input.acceptedAt < 0 ||
      !Number.isSafeInteger(ownDeadline.getTime()) ||
      ownDeadline.getTime() <= Date.now()
    )
      throw new FileSourceUnavailableError();
    let expiresAt = ownDeadline;
    const accepted = { ...input, receipt: { ...input.receipt }, principal: { ...input.principal } };
    if (
      !session.inTransaction() ||
      !isUploadPrincipal(input.principal) ||
      (input.derivedOrigin !== undefined && !origin) ||
      input.receipt.outcome !== 'durable' ||
      !securityApproval
    )
      throw new FileSourceUnavailableError();
    if (origin) {
      if (origin.ancestors.some((source) => source.subject.operationId === accepted.operationId))
        throw new FileSourceUnavailableError();
      const actual = await captureManagedUploadOrigin(
        accepted.principal,
        { binding: origin.binding, directSourceFileIds: origin.directSourceFileIds },
        accepted.acceptedAt,
        session,
      );
      if (!sameUploadDerivedOrigin(actual, origin)) throw new FileSourceUnavailableError();
      expiresAt = projectDerivedFileDeadline(
        ownDeadline,
        actual.ancestors.map((source) => new Date(source.expiresAt)),
      );
      for (const source of origin.ancestors) {
        const count = await File.countDocuments(
          descendantFilter(managedFileScope(accepted.principal), source.subject.operationId),
        )
          .limit(UPLOAD_DERIVED_MAX_DESCENDANTS + 1)
          .session(session);
        if (count >= UPLOAD_DERIVED_MAX_DESCENDANTS) throw new FileSourceCapacityError();
      }
    }
    const [created] = await File.create(
      [
        {
          ...owner,
          file_id: accepted.operationId,
          uploadOperationId: accepted.operationId,
          retrievalCreation: createManagedFileRetrievalInventory(
            { userId: accepted.principal.userId, tenantId: accepted.principal.tenantId },
            accepted.operationId,
            accepted.acceptedAt,
          ),
          securityApproval,
          ...(origin
            ? {
                derivedOrigin: origin,
                derivedRetention: {
                  version: 1,
                  ownDeadlineAt: ownDeadline,
                  capBasis: 'admission',
                  trackedSince: new Date(accepted.acceptedAt),
                  deadlineGeneration: 0,
                },
              }
            : {}),
          filename: accepted.filename,
          type: accepted.mediaType,
          bytes: accepted.receipt.bytes,
          filepath: accepted.receipt.filepath,
          source: accepted.receipt.source,
          storageKey: accepted.receipt.storageKey,
          object: 'file',
          context: 'message_attachment',
          status: 'pending',
          retentionAcceptedAt: new Date(accepted.acceptedAt),
          expiredAt: expiresAt,
          ...(origin
            ? {}
            : {
                retentionActivity: initialFileRetentionActivity(
                  expiresAt,
                  new Date(accepted.acceptedAt),
                  'complete',
                ),
              }),
          retentionRevision: 0,
          llmDeliveryPath: 'text',
        },
      ],
      { session },
    );
    await projectFileHousekeeping(
      mongoose,
      null,
      created.toObject<IMongoFile>({ transform: false }),
      session,
    );
    return { acceptedAt: new Date(accepted.acceptedAt), expiredAt: new Date(expiresAt) };
  }
  function managedFilter(owner: FileOwnerScope, operationId: string, now: number) {
    return {
      ...managedFileScope(owner),
      file_id: operationId,
      uploadOperationId: operationId,
      retentionAcceptedAt: { $ne: null },
      expiredAt: { $gt: new Date(now) },
      deletionRequestedAt: null,
      deletionCompletedAt: null,
      ...approvedFileFilter(options.securityPolicySha256, now),
      'retentionActivity.migrationEpoch': { $exists: false },
      'derivedRetention.migrationEpoch': { $exists: false },
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
    input: ManagedDocumentResult,
    now: number,
    session: ClientSession,
  ): Promise<FilePublicationActivityResult> {
    const document = readManagedDocumentResult(input);
    if (
      !session.inTransaction() ||
      !document ||
      Buffer.byteLength(document.text, 'utf8') +
        Buffer.byteLength(JSON.stringify(document.structure), 'utf8') >
        UPLOAD_MAX_TEXT_BYTES
    ) {
      throw new FileSourceUnavailableError();
    }
    const File = mongoose.models.File as Model<IMongoFile>;
    const filter = {
      ...managedFilter(owner, operationId, Math.max(now, Date.now())),
      previewRevision: String(generation),
      'securityApproval.subject.sha256': document.structure.source.sha256,
      'securityApproval.subject.bytes': document.structure.source.bytes,
      'securityApproval.subject.mediaType': document.structure.source.mediaType,
      bytes: document.structure.source.bytes,
      type: document.structure.source.mediaType,
    };
    // Read the private proof in the same transaction; request File JSON cannot supply it.
    const current = await File.findOne(filter)
      .select(
        '+securityApproval +managedRetrieval +derivedOrigin +retentionActivity +derivedRetention +retentionRevocationId',
      )
      .session(session)
      .lean<IMongoFile>();
    if (!current?.securityApproval) throw new FileSourceUnavailableError();
    const scope = fileSourceScope(owner);
    const managedRetrieval = prepareManagedRetrievalPublication({
      owner: { userId: scope.user, tenantId: scope.tenantId },
      fileId: current.file_id,
      operationId,
      document,
      approval: current.securityApproval,
      extractionPolicySha256: options.extractionPolicySha256,
      previous: current.managedRetrieval,
    });
    const eligibilityNow = Math.max(now, Date.now());
    const success =
      current.derivedOrigin === undefined
        ? advanceFileRetentionActivity(
            current.retentionActivity,
            current.expiredAt,
            'processing',
            now,
            eligibilityNow,
          )
        : undefined;
    const result = await File.updateOne(
      { ...filter, expiredAt: { $gt: new Date(eligibilityNow) } },
      {
        $set: {
          text: document.text,
          documentStructure: document.structure,
          textFormat: 'text',
          status: 'ready',
          embedded: true,
          ...(success ? { retentionActivity: success.activity, expiredAt: success.expiredAt } : {}),
          ...(managedRetrieval === undefined ? {} : { managedRetrieval }),
        },
        $inc: { retentionRevision: 1 },
      },
      { session, timestamps: false },
    );
    if (result.matchedCount !== 1) throw new FileSourceUnavailableError();
    const next: IMongoFile = {
      ...current,
      status: 'ready',
      embedded: true,
      retentionRevision: (current.retentionRevision ?? 0) + 1,
      ...(success ? { expiredAt: success.expiredAt, retentionActivity: success.activity } : {}),
    };
    if (success) await refreshDerivedFileDeadlines(mongoose, owner, current, next, session);
    await projectFileHousekeeping(mongoose, current, next, session);
    return {
      expiredAtMs: next.expiredAt!.getTime(),
      deadlineGeneration: currentFileDeadline(next).deadlineGeneration,
    };
  }
  async function assertManagedUploadProcessing(
    owner: FileOwnerScope,
    operationId: string,
    generation: number,
    now: number,
    session: ClientSession,
  ): Promise<void> {
    if (
      !session.inTransaction() ||
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      !Number.isSafeInteger(now) ||
      now < 0
    )
      throw new FileSourceUnavailableError();
    const File = mongoose.models.File as Model<IMongoFile>;
    const result = await File.updateOne(
      { ...managedFilter(owner, operationId, now), previewRevision: String(generation) },
      { $inc: { retentionRevision: 1 } },
      { session, timestamps: false },
    );
    if (result.matchedCount !== 1) throw new FileSourceUnavailableError();
  }

  /** The ancestor write serializes every admission with its bounded reverse-lineage revoke. */
  async function revokeSourceClosure(
    owner: FileOwnerScope,
    operationId: string,
    now: number,
    session: ClientSession,
  ): Promise<{ revokedFileIds: string[] }> {
    const scope = managedFileScope(owner);
    if (!session.inTransaction() || !Number.isSafeInteger(now) || now < 0)
      throw new FileSourceUnavailableError();
    const File = mongoose.models.File as Model<IMongoFile>;
    const projection =
      '-text -documentStructure +securityApproval +derivedOrigin +retentionActivity +derivedRetention +retentionRevocationId';
    const root = await File.findOne({
      ...scope,
      file_id: operationId,
      retentionAcceptedAt: { $ne: null },
    })
      .select(projection)
      .session(session)
      .lean<IMongoFile>();
    if (!root) throw new FileSourceUnavailableError();
    if (root.deletionCompletedAt) return { revokedFileIds: [root.file_id] };
    const revoke = async (file: IMongoFile) => {
      if (currentFileDeadline(file).migrationEpoch !== null) throw new FileSourceUnavailableError();
      const next: IMongoFile = {
        ...file,
        deletionRequestedAt: file.deletionRequestedAt ?? new Date(Math.max(now, Date.now())),
        retentionRevocationId: file.retentionRevocationId ?? randomUUID(),
        retentionRevision: (file.retentionRevision ?? 0) + 1,
      };
      const changed = await File.updateOne(
        {
          ...scope,
          _id: file._id,
          retentionRevision: file.retentionRevision,
          expiredAt: file.expiredAt,
          'retentionActivity.migrationEpoch': { $exists: false },
          'derivedRetention.migrationEpoch': { $exists: false },
        },
        {
          $set: {
            deletionRequestedAt: next.deletionRequestedAt,
            retentionRevocationId: next.retentionRevocationId,
          },
          $inc: { retentionRevision: 1 },
          $unset: { deletionRetryAt: 1 },
        },
        { session, timestamps: false },
      );
      if (changed.matchedCount !== 1) throw new FileSourceUnavailableError();
      await projectFileHousekeeping(mongoose, file, next, session);
    };
    await revoke(root);
    const descendants = await File.find(descendantFilter(scope, operationId))
      .select(projection)
      .limit(UPLOAD_DERIVED_MAX_DESCENDANTS + 1)
      .session(session)
      .lean<IMongoFile[]>();
    if (descendants.length > UPLOAD_DERIVED_MAX_DESCENDANTS) throw new FileSourceUnavailableError();
    for (const file of descendants) await revoke(file);
    return {
      revokedFileIds: [
        ...new Set([operationId, ...descendants.map((file) => file.file_id)]),
      ].sort(),
    };
  }

  /** Indexed expiry discovery is not authority; same-transaction File revalidation precedes quota changes. */
  async function revokeExpiredManagedUpload(
    owner: FileOwnerScope,
    operationId: string,
    expectedDeadline: number,
    now: number,
    session: ClientSession,
  ): Promise<boolean> {
    if (!session.inTransaction() || !Number.isSafeInteger(expectedDeadline))
      throw new FileSourceUnavailableError();
    const current = await mongoose.models.File.findOne({
      ...managedFileScope(owner),
      file_id: operationId,
      uploadOperationId: operationId,
      expiredAt: { $eq: new Date(expectedDeadline), $lte: new Date(Math.min(now, Date.now())) },
      $expr: { $lte: ['$expiredAt', '$$NOW'] },
      'retentionActivity.migrationEpoch': { $exists: false },
      'derivedRetention.migrationEpoch': { $exists: false },
    })
      .select('_id')
      .session(session)
      .maxTimeMS(1000)
      .lean();
    if (!current) return false;
    await revokeSourceClosure(owner, operationId, now, session);
    return true;
  }

  async function revokeManagedUpload(
    owner: FileOwnerScope,
    operationId: string,
    now: number,
    session: ClientSession,
  ): Promise<{ revokedFileIds: string[] }> {
    return revokeSourceClosure(owner, operationId, now, session);
  }
  async function getManagedUploadAvailability(
    owner: FileOwnerScope,
    operationIds: readonly string[],
    now: number,
  ): Promise<{ fileId: string; ready: boolean }[]> {
    const File = mongoose.models.File as Model<IMongoFile>;
    const rows = await File.find({
      ...managedFileScope(owner),
      uploadOperationId: { $in: operationIds },
      derivedOrigin: { $exists: false },
      expiredAt: { $gt: new Date(now) },
      deletionRequestedAt: null,
      deletionCompletedAt: null,
      ...approvedFileFilter(options.securityPolicySha256, now),
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
      ...managedFileScope(owner),
      file_id: { $in: [...new Set(fileIds)] },
      retentionAcceptedAt: { $ne: null },
    })
      .select(
        '+derivedOrigin +securityApproval +documentStructure +managedRetrieval +retrievalCreation',
      )
      .lean<IMongoFile[]>();
  }

  /** Deletion composition calls this after revocation, BEFORE original or history removal. */
  async function assertFileSourceDeletionReady(owner: FileOwnerScope, fileIds: readonly string[]) {
    const scope = fileSourceScope(owner);
    const capturedOwner = { tenantId: scope.tenantId, userId: scope.user };
    const rows = await loadFileSourceRecords(capturedOwner, fileIds);
    if (new Set(rows.map((row) => row.file_id)).size !== new Set(fileIds).size)
      throw new FileSourceUnavailableError();
    for (const row of rows) {
      if (row.deletionCompletedAt) continue;
      if (!row.deletionRequestedAt || !managedFileRetrievalDeletionSettled(row))
        throw new FileSourceUnavailableError();
    }
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
  ): Promise<{ revokedFileIds: string[] }> {
    const ids = [...new Set(fileIds)];
    if (!ids.length) return { revokedFileIds: [] };
    const scope = fileSourceScope(owner);
    const capturedOwner = { userId: scope.user, tenantId: scope.tenantId };
    if (ids.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 128))
      throw new FileSourceUnavailableError();
    const revoked = new Set<string>();
    for (const id of ids) {
      const session = await mongoose.startSession();
      try {
        const result = await session.withTransaction(
          () => revokeSourceClosure(capturedOwner, id, Date.now(), session),
          { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
        );
        for (const revokedId of result.revokedFileIds) revoked.add(revokedId);
      } finally {
        await session.endSession();
      }
    }
    return { revokedFileIds: [...revoked].sort() };
  }

  /** Internal caller-owned transaction; the lifecycle owner supplies the fresh HK/File CAS. */
  async function settleFileSourceDeletionInSession(
    owner: FileOwnerScope,
    fileId: string,
    finalize: boolean,
    session: ClientSession,
  ): Promise<boolean> {
    if (!session.inTransaction()) throw new FileSourceUnavailableError();
    const capturedOwner = owner;
    const File = mongoose.models.File as Model<IMongoFile>;
    const keep = new Set([
      '_id',
      '__v',
      'file_id',
      'user',
      'tenantId',
      'createdAt',
      'retentionAcceptedAt',
      'retentionActivity',
      'derivedRetention',
      'expiredAt',
      'retentionRevision',
      'deletionRequestedAt',
      'deletionCompletedAt',
      'retainedDerivativeBytes',
      'managedRetrieval',
      'retrievalCreation',
      'uploadOperationId',
      'retentionRevocationId',
      'retentionCleanup',
      ...(!finalize ? ['derivedOrigin', 'uploadOperationId'] : []),
    ]);
    const current = await File.findOne({ ...managedFileScope(capturedOwner), file_id: fileId })
      .select(
        '+retentionActivity +derivedRetention +retainedDerivativeBytes +retainedDerivativeReservations +documentStructure +securityApproval +derivedOrigin +managedRetrieval +retrievalCreation +retentionCleanup +retentionRevocationId',
      )
      .session(session)
      .maxTimeMS(1000)
      .lean<IMongoFile>();
    if (!current?.deletionRequestedAt) throw new FileSourceUnavailableError();
    if (current.deletionCompletedAt) return true;
    // Unknown inventory preserves ORIGINAL evidence, not just a final tombstone.
    // All private cleanup paths retain this guard even if composition is bypassed.
    if (!fileCleanupReady(current, finalize) || !managedFileRetrievalDeletionSettled(current))
      return false;
    const pendingChild = await File.findOne(
      descendantFilter(managedFileScope(capturedOwner), current.file_id),
    )
      .select('_id')
      .session(session)
      .maxTimeMS(1000)
      .lean();
    if (pendingChild) return false;
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
    const updated = await File.updateOne(
      {
        ...managedFileScope(capturedOwner),
        file_id: fileId,
        deletionRequestedAt: { $ne: null },
      },
      {
        $unset: unset,
        $set: {
          retainedDerivativeBytes: 0,
          ...(finalize ? { deletionCompletedAt: new Date() } : {}),
        },
      },
      { session, timestamps: false, maxTimeMS: 1000 },
    );
    if (!updated.acknowledged || updated.matchedCount !== 1) throw new FileSourceUnavailableError();
    return true;
  }

  /** Content removal and final completion share one idempotent, child-fenced transaction. */
  async function settleFileSourceDeletion(
    owner: FileOwnerScope,
    fileIds: readonly string[],
    finalize: boolean,
  ): Promise<string[]> {
    const scope = fileSourceScope(owner);
    const capturedOwner = { userId: scope.user, tenantId: scope.tenantId };
    const rows = await loadFileSourceRecords(capturedOwner, fileIds);
    const depth = new Map<string, number>();
    for (const row of rows) {
      const origin =
        row.derivedOrigin === undefined
          ? undefined
          : readHistoricalUploadDerivedOrigin(row.derivedOrigin);
      if (row.derivedOrigin !== undefined && !origin) throw new FileSourceUnavailableError();
      depth.set(row.file_id, origin?.ancestors.length ?? 0);
    }
    rows.sort(
      (a, b) => depth.get(b.file_id)! - depth.get(a.file_id)! || a.file_id.localeCompare(b.file_id),
    );
    const completedFileIds: string[] = [];
    for (const row of rows) {
      const session = await mongoose.startSession();
      try {
        const completed = await session.withTransaction(
          async () => {
            return settleFileSourceDeletionInSession(capturedOwner, row.file_id, finalize, session);
          },
          { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
        );
        if (completed) completedFileIds.push(row.file_id);
      } finally {
        await session.endSession();
      }
    }
    return completedFileIds;
  }
  /** Keep reverse lineage until the existing Upload cleanup acknowledgement is known. */
  async function prepareFileSourceDeletion(owner: FileOwnerScope, fileIds: readonly string[]) {
    return { preparedFileIds: await settleFileSourceDeletion(owner, fileIds, false) };
  }
  /** Only deletion composition calls this after the real Upload cleanup acknowledgement. */
  async function finalizeFileSourceDeletion(owner: FileOwnerScope, fileIds: readonly string[]) {
    return { completedFileIds: await settleFileSourceDeletion(owner, fileIds, true) };
  }
  return {
    captureManagedUploadOrigin,
    reserveFileSourceCopies,
    releaseFileSourceCopies,
    acceptManagedUpload,
    claimManagedUploadProcessing,
    assertManagedUploadProcessing,
    publishManagedUpload,
    revokeManagedUpload,
    revokeExpiredManagedUpload,
    getManagedUploadAvailability,
    touchManagedUploadForRetry,
    getFileSourceDeletionCandidates,
    revokeFileSources,
    assertFileSourceDeletionReady,
    settleFileSourceDeletionInSession,
    prepareFileSourceDeletion,
    finalizeFileSourceDeletion,
  };
}

export type { ManagedUploadAcceptance } from '~/types/file';
