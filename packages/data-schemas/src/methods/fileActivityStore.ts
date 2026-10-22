/** Private File-owned transactions and current-source evidence; never acquires UploadCounter. */
import { isUploadPrincipal } from 'librechat-data-provider';
import type { ManagedFileReadRepresentation, UploadPrincipal } from 'librechat-data-provider';
import type { ClientSession, FilterQuery, Model } from 'mongoose';
import type { CurrentManagedFileSource } from './fileSourceAuthority';
import type { StoredFileReadReceipt } from '~/types/fileActivity';
import type { createUploadStore } from './uploadManagementStore';
import type { IMongoFile } from '~/types/file';
import {
  currentManagedFileFilter,
  loadManagedFileSource,
  ManagedFileSourceUnavailableError,
} from './fileSourceAuthority';
import { createFileReadReceiptModel } from '~/models/fileReadReceipt';
import { touchActiveUserPrincipal } from './userPrincipal';
import { principalFilter } from './uploadManagementStore';
export { fileSourceSha256 as sha256 } from './fileSourceAuthority';

export type FileReadRefusal = 'not_found' | 'expired' | 'revoked' | 'source_changed' | 'lease_lost';
export class FileReadError extends Error {
  constructor(readonly code: FileReadRefusal | 'busy' | 'unavailable') {
    super(code);
  }
}
export function refuse(code: FileReadError['code']): never {
  throw new FileReadError(code);
}
export type FileActivitySource = CurrentManagedFileSource;
export interface FileActivityStore {
  File: Model<IMongoFile>;
  Receipt: Model<StoredFileReadReceipt>;
  owner(principal: UploadPrincipal): ReturnType<typeof principalFilter>;
  fileFilter(principal: UploadPrincipal, fileId: string, now: number): FilterQuery<IMongoFile>;
  receipt(principal: UploadPrincipal, key: string): Promise<StoredFileReadReceipt>;
  receiptInTransaction(
    principal: UploadPrincipal,
    key: string,
    session: ClientSession,
  ): Promise<StoredFileReadReceipt>;
  transaction<T>(deadline: number, work: (session: ClientSession) => Promise<T>): Promise<T>;
  source(
    principal: UploadPrincipal,
    fileId: string,
    representation: ManagedFileReadRepresentation,
    session: ClientSession,
  ): Promise<FileActivitySource>;
  touchFile(
    principal: UploadPrincipal,
    current: FileActivitySource,
    session: ClientSession,
  ): Promise<void>;
}

export function createFileActivityStore(
  mongoose: typeof import('mongoose'),
  uploads: ReturnType<typeof createUploadStore>,
  options: { securityPolicySha256?: string },
): FileActivityStore {
  if (uploads.Operation !== mongoose.models.UploadOperation)
    throw new Error('File source upload owner mismatch');
  const File = mongoose.models.File as Model<IMongoFile>;
  const Receipt = createFileReadReceiptModel(mongoose);
  const owner = (principal: UploadPrincipal) => {
    if (!isUploadPrincipal(principal)) refuse('not_found');
    return principalFilter(principal);
  };
  function fileFilter(principal: UploadPrincipal, fileId: string, now: number) {
    owner(principal);
    return currentManagedFileFilter(principal, fileId, now, options.securityPolicySha256);
  }

  /** This preliminary majority read chooses a bounded transaction budget, never grants authority. */
  async function receipt(principal: UploadPrincipal, key: string): Promise<StoredFileReadReceipt> {
    const row = await Receipt.findOne({ _id: key, ...owner(principal) })
      .readConcern('majority')
      .maxTimeMS(1000)
      .lean<StoredFileReadReceipt>();
    if (!row) refuse('not_found');
    return row;
  }
  async function receiptInTransaction(
    principal: UploadPrincipal,
    key: string,
    session: ClientSession,
  ) {
    const row = await Receipt.findOne({ _id: key, ...owner(principal) })
      .session(session)
      .maxTimeMS(1000)
      .lean<StoredFileReadReceipt>();
    if (!row) refuse('not_found');
    if (row.notAfter.getTime() <= Date.now()) refuse('expired');
    return row;
  }
  async function transaction<T>(
    deadline: number,
    work: (session: ClientSession) => Promise<T>,
  ): Promise<T> {
    const remaining = Math.min(5000, deadline - Date.now());
    if (!Number.isSafeInteger(remaining) || remaining <= 0) refuse('expired');
    const session = await mongoose.startSession();
    try {
      const result = await session.withTransaction(
        async () => {
          if (Date.now() >= deadline) refuse('expired');
          const result = await work(session);
          // The driver also limits commit/retry to the original remaining budget.
          if (Date.now() >= deadline) refuse('expired');
          return result;
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority', wtimeout: remaining },
          maxCommitTimeMS: Math.min(1000, remaining),
          timeoutMS: remaining,
        },
      );
      return result as T;
    } finally {
      await session.endSession();
    }
  }
  async function source(
    principal: UploadPrincipal,
    fileId: string,
    representation: ManagedFileReadRepresentation,
    session: ClientSession,
  ) {
    owner(principal);
    await touchActiveUserPrincipal(mongoose, principal, session);
    try {
      return await loadManagedFileSource(mongoose, principal, fileId, representation, {
        purpose: 'attachment',
        securityPolicySha256: options.securityPolicySha256,
        session,
      });
    } catch (error) {
      if (error instanceof ManagedFileSourceUnavailableError) refuse(error.reason);
      throw error;
    }
  }
  async function touchFile(
    principal: UploadPrincipal,
    current: Awaited<ReturnType<typeof source>>,
    session: ClientSession,
  ) {
    const result = await File.updateOne(
      {
        ...fileFilter(principal, current.file.file_id, Date.now()),
        retentionRevision: current.file.retentionRevision,
        expiredAt: current.file.expiredAt,
      },
      { $inc: { retentionRevision: 1 } },
      { session, timestamps: false },
    );
    if (!result.acknowledged || result.matchedCount !== 1) refuse('revoked');
  }
  return {
    File,
    Receipt,
    owner,
    fileFilter,
    receipt,
    receiptInTransaction,
    transaction,
    source,
    touchFile,
  };
}
