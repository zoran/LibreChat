/** fileRetentionLifecycle owns existing revoke, expiry and actual source-deletion settlement. */
import { fileCleanupReady } from './fileCleanupCustody';
/** File lifecycle authority shared by File CRUD and transactional Message admission. */
/** File lifecycle authority shared by File CRUD and transactional Message admission. */
import { randomUUID } from 'crypto';
import {
  UPLOAD_DERIVED_MAX_DESCENDANTS,
  readHistoricalUploadDerivedOrigin,
} from 'librechat-data-provider';

import type { ClientSession, FilterQuery, Model } from 'mongoose';
import type { FileOwnerScope } from '../types/file';
import type { IMongoFile } from '../types';

import { adjustRetainedTextBytes } from './uploadManagementStore';
import { approvedFileFilter } from './fileSecurity';

import { projectFileHousekeeping } from './fileHousekeepingProjection';
import { managedFileRetrievalDeletionSettled } from './fileRetrieval';

import {
  FileSourceUnavailableError,
  fileSourceScope,
  managedFileScope,
  currentFileDeadline,
} from './fileSourceAuthority';
export {
  FileSourceUnavailableError,
  FileSourceCapacityError,
  fileSourceScope,
  inspectFileSources,
} from './fileSourceAuthority';

import type { FileRetentionMethods } from './fileRetentionTypes';
import { unreconciledDocumentStorage } from './fileRetentionAccounting';
export function createFileRetentionLifecycle(
  mongoose: typeof import('mongoose'),
  options: { securityPolicySha256?: string; extractionPolicySha256?: string },
  managedFilter: (owner: FileOwnerScope, id: string, now: number) => FilterQuery<IMongoFile>,
  descendantFilter: (scope: FilterQuery<IMongoFile>, id: string) => FilterQuery<IMongoFile>,
): Pick<
  FileRetentionMethods,
  | 'revokeManagedUpload'
  | 'revokeExpiredManagedUpload'
  | 'getManagedUploadAvailability'
  | 'touchManagedUploadForRetry'
  | 'getFileSourceDeletionCandidates'
  | 'revokeFileSources'
  | 'assertFileSourceDeletionReady'
  | 'settleFileSourceDeletionInSession'
  | 'prepareFileSourceDeletion'
  | 'finalizeFileSourceDeletion'
> {
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
      'originalWriteBinding',
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
