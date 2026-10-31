/** uploadNasFileCleanup joins the genuine File/job/derivative owner to NAS receipt consumption. */
import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type {
  FileCleanupProgress,
  FileLifecycleCustody,
  FileUploadCleanupAcknowledgment,
} from '../types/fileCleanup';
import type { FileCleanupAuthority, FileCleanupContext } from './fileCleanupAuthority';
import type { UploadManagementContext } from './uploadManagementContext';
import type { FileCleanupRow } from './fileCleanupAuthority';
import type { StoredUpload } from './uploadManagementState';
import type { JobClaim } from '../types/housekeeping';
import { hasUploadActorClosure, hasUploadAcceptedFileAck } from './uploadCleanupReceipts';
import { uploadFileCleanupBinding } from './uploadFileCleanupBinding';
import { createFileCleanupAuthority } from './fileCleanupAuthority';
import { derivativesComplete, same } from './fileCleanupCustody';
import { uploadDigest, reject } from './uploadManagementStore';
import { createHousekeepingStore } from './housekeepingStore';
import { validateNasFileStorage } from './fileCleanupCustody';
import { managedFileScope } from './fileSourceAuthority';

type NasFileContext = {
  a: FileCleanupAuthority;
  current: FileCleanupContext;
  progress: FileCleanupProgress;
  l: FileLifecycleCustody;
  claim: JobClaim;
};

/** Read the same retained NAS/Upload/File join; a receipt's public shape alone never completes it. */
export async function observeNasFileCleanup(
  mongoose: typeof import('mongoose'),
  row: StoredUpload,
  file: FileCleanupRow,
  session: ClientSession,
): Promise<{ state: 'pending' } | { state: 'acknowledged'; ack: FileUploadCleanupAcknowledgment }> {
  const progress = file.retentionCleanup;
  if (
    !progress ||
    progress.revocationId !== file.retentionRevocationId ||
    !progress.lifecycle?.contentPrepared ||
    !derivativesComplete(progress) ||
    !same(progress.lifecycle.upload, uploadFileCleanupBinding(row)) ||
    !hasUploadActorClosure(row) ||
    !hasUploadAcceptedFileAck(row)
  )
    return { state: 'pending' as const };
  const storage = validateNasFileStorage(progress);
  const n = row.cleanupCustody?.nas;
  const ack = row.cleanupCustody?.acceptedFileAck;
  if (
    storage.state !== 'consumed' ||
    n?.state !== 'consumed' ||
    !ack ||
    storage.consumerCommitId !== n.consumerCommitId ||
    !same(storage.receipt, n.receipt) ||
    !same(storage.uploadAck, ack) ||
    storage.receiptSHA256 !== uploadDigest(n.receipt)
  )
    return { state: 'pending' as const };
  const targets = mongoose.models.FileCleanupTarget;
  if (
    !targets ||
    (await targets
      .exists({
        tenantId: row.tenantId,
        ownerUserId: row.userId,
        fileId: row.fileId,
        revocationId: progress.revocationId,
        state: { $in: ['pending', 'unknown'] },
      })
      .session(session)
      .maxTimeMS(1000))
  )
    return { state: 'pending' as const };
  if (
    await mongoose.models.File.exists({
      ...managedFileScope({ tenantId: row.tenantId, userId: row.userId }),
      'derivedOrigin.ancestors.subject.operationId': row.fileId,
      deletionCompletedAt: null,
    })
      .session(session)
      .maxTimeMS(1000)
  )
    return { state: 'pending' as const };
  return { state: 'acknowledged' as const, ack: { ...ack } };
}

/** Actual current JobClaim is required for accepted File cleanup, never inferred from a user ID. */
export async function loadNasFileCleanup(
  context: UploadManagementContext,
  row: StoredUpload,
  session: ClientSession,
  claim?: JobClaim,
): Promise<NasFileContext | null> {
  if (
    !claim ||
    claim.work.handler !== 'file.cleanup' ||
    row.acceptedAt == null ||
    row.fileId !== row._id ||
    !['deleted', 'expired'].includes(row.state) ||
    claim.work.subject.tenantId !== row.tenantId ||
    claim.work.subject.ownerUserId !== row.userId ||
    claim.work.subject.fileId !== row.fileId
  )
    return null;
  const a = createFileCleanupAuthority(context.mongoose, createHousekeepingStore(context.mongoose));
  const current = await a.load(claim, session);
  const progress = a.progress(current);
  const l = progress.lifecycle;
  if (
    !l ||
    !same(l.upload, uploadFileCleanupBinding(row)) ||
    l.storage ||
    !derivativesComplete(progress) ||
    current.file.retentionAcceptedAt?.getTime() !== row.acceptedAt ||
    !['purging_derivatives', 'removing_original', 'finalizing'].includes(
      current.job.execution.phase,
    )
  )
    return null;
  return { a, current, progress, l, claim };
}

/** Called in Upload's existing transaction after its actual NAS receipt and actor checks. */
export async function consumeNasFileCleanup(
  context: UploadManagementContext,
  row: StoredUpload,
  session: ClientSession,
  claim?: JobClaim,
): Promise<boolean> {
  const c = await loadNasFileCleanup(context, row, session, claim);
  const n = row.cleanupCustody?.nas;
  if (!c || !n?.receipt || n.state !== 'consumed' || !n.consumerCommitId) return false;
  const targets = context.mongoose.models.FileCleanupTarget;
  if (
    !targets ||
    (await targets
      .exists({
        tenantId: row.tenantId,
        ownerUserId: row.userId,
        fileId: row.fileId,
        revocationId: c.progress.revocationId,
        state: { $in: ['pending', 'unknown'] },
      })
      .session(session)
      .maxTimeMS(1000))
  )
    return false;
  if (
    await context.mongoose.models.File.exists({
      ...managedFileScope({ tenantId: row.tenantId, userId: row.userId }),
      'derivedOrigin.ancestors.subject.operationId': row.fileId,
      deletionCompletedAt: null,
    })
      .session(session)
      .maxTimeMS(1000)
  )
    return false;
  const receiptSHA256 = uploadDigest(n.receipt);
  c.l.nasStorage = { state: 'terminal', receipt: structuredClone(n.receipt), receiptSHA256 };
  await c.a.save(c.claim, c.current, c.progress, 'finalizing', session);
  if (
    !(await context.lifecycle.settleFileSourceDeletionInSession(
      { tenantId: row.tenantId, userId: row.userId },
      row.fileId!,
      false,
      session,
    ))
  )
    reject('not_ready');
  c.l.contentPrepared = true;
  row.cleanupCustody!.acceptedFileAck = {
    reference: randomUUID(),
    operationId: row._id,
    cleanupGeneration: row.generation,
    attemptGeneration: row.attemptGeneration!,
    revocationId: c.progress.revocationId,
    receiptSHA256,
  };
  c.l.nasStorage = {
    ...c.l.nasStorage,
    state: 'consumed',
    uploadAck: { ...row.cleanupCustody!.acceptedFileAck },
    consumerCommitId: n.consumerCommitId,
  };
  await c.a.save(c.claim, c.current, c.progress, 'finalizing', session);
  return true;
}
