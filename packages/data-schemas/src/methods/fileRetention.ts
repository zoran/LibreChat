/** File lifecycle authority shared by File CRUD and transactional Message admission. */

import {
  UPLOAD_MAX_TEXT_BYTES,
  readUploadOriginalWriteBinding,
  UPLOAD_DERIVED_MAX_DESCENDANTS,
  isUploadPrincipal,
  readUploadDerivedOrigin,
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
} from '../types/file';
import type { IMongoFile } from '../types';
import {
  FileSourceUnavailableError,
  FileSourceCapacityError,
  fileSourceScope,
  managedFileScope,
  currentFileDeadline,
} from './fileSourceAuthority';
import {
  captureDerivedFileOrigin,
  projectDerivedFileDeadline,
  refreshDerivedFileDeadlines,
} from './fileDerivedRetention';
import {
  approvedFileFilter,
  captureManagedFileApproval,
  uploadSecurityPolicySha256,
} from './fileSecurity';
import {
  prepareManagedRetrievalPublication,
  createManagedFileRetrievalInventory,
} from './fileRetrieval';
import { adjustRetainedTextBytes, RESOURCE_MAX } from './uploadManagementStore';
import { projectFileHousekeeping } from './fileHousekeepingProjection';
export {
  FileSourceUnavailableError,
  FileSourceCapacityError,
  fileSourceScope,
  inspectFileSources,
} from './fileSourceAuthority';

import type { FilePublicationActivityResult } from '../types/fileActivity';
import {
  initialFileRetentionActivity,
  advanceFileRetentionActivity,
} from './fileActivityTransition';

import type { FileRetentionMethods } from './fileRetentionTypes';
import { createFileRetentionLifecycle } from './fileRetentionLifecycle';
import {
  COPY_RECEIPT_BYTES,
  MAX_COPY_RECEIPTS,
  touchFileSources,
  unreconciledDocumentStorage,
} from './fileRetentionAccounting';
export {
  resizeRetainedDerivatives,
  liveFileFilter,
  resolveFileSources,
  touchFileSources,
  unreconciledDocumentStorage,
} from './fileRetentionAccounting';
export function createFileRetentionMethods(
  mongoose: typeof import('mongoose'),
  options: { securityPolicySha256?: string; extractionPolicySha256?: string } = {},
): FileRetentionMethods {
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
    const writeBinding = input.writeBinding
      ? readUploadOriginalWriteBinding(input.writeBinding)
      : null;
    const securityApproval = captureManagedFileApproval(
      { ...input, writeBinding: writeBinding ?? undefined },
      options.securityPolicySha256,
    );
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
          ...(writeBinding ? { originalWriteBinding: writeBinding } : {}),
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

  const lifecycle = createFileRetentionLifecycle(
    mongoose,
    options,
    managedFilter,
    descendantFilter,
  );
  return {
    captureManagedUploadOrigin,
    reserveFileSourceCopies,
    releaseFileSourceCopies,
    acceptManagedUpload,
    claimManagedUploadProcessing,
    assertManagedUploadProcessing,
    publishManagedUpload,
    ...lifecycle,
  };
}
export type { ManagedUploadAcceptance } from '../types/file';
