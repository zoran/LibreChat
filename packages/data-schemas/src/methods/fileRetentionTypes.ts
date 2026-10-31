/** fileRetentionTypes is the existing File lifecycle public method contract. */

/** File lifecycle authority shared by File CRUD and transactional Message admission. */

import type {
  ManagedDocumentResult,
  UploadDerivedIntent,
  UploadDerivedOrigin,
} from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type {
  FileOwnerScope,
  FileSourceCopyReservation,
  ManagedUploadAcceptance,
  FileRetentionAdmission,
} from '../types/file';
import type { IMongoFile } from '../types';

export {
  FileSourceUnavailableError,
  FileSourceCapacityError,
  fileSourceScope,
  inspectFileSources,
} from './fileSourceAuthority';

import type { FilePublicationActivityResult } from '../types/fileActivity';

export type FileRetentionMethods = {
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
};
