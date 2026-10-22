/** Upload-owned scheduling projection; every mutation joins the caller's owner transaction. */
import { UPLOAD_REPLAY_MS, UPLOAD_WINDOW_MS } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { HousekeepingWork } from '../types/housekeeping';
import type { HousekeepingStore } from './housekeepingStore';
import type { StoredUpload } from './uploadManagementState';
import { WAIT_MS, PROCESS_MS, storedUploadPrincipal } from './uploadManagementState';
import { HOUSEKEEPING_INDEXES } from '../models/housekeepingJob';
import { createHousekeepingStore } from './housekeepingStore';

/** Existing owner-transaction join. True means job projection changed and needs an Upload CAS. */
export type UploadHousekeepingProjection = (
  previous: StoredUpload | null,
  next: StoredUpload | null,
  session: ClientSession,
) => Promise<boolean>;

type UploadWork = Extract<HousekeepingWork, { handler: 'upload.cleanup' }>;
type ProjectionStore = Pick<
  HousekeepingStore,
  'project' | 'observeWork' | 'refreshDue' | 'invalidate'
>;
const terminal = new Set(['failed', 'deleted', 'expired', 'cancelled']);

export function uploadHousekeepingWork(row: StoredUpload): UploadWork {
  const principal = storedUploadPrincipal(row);
  return {
    handler: 'upload.cleanup',
    subject: { tenantId: principal.tenantId, ownerUserId: principal.userId },
    operationId: row._id,
    cleanupGeneration: row.generation,
    attemptGeneration: row.attemptGeneration ?? null,
  };
}

/** Accepted File expiry is never an Upload timeout or a second File deletion schedule. */
export function uploadHousekeepingDue(row: StoredUpload): Date {
  let at: number;
  if (row.slot && row.leaseExpiresAt != null && !terminal.has(row.state)) {
    at = row.leaseExpiresAt;
  } else if (row.state === 'waiting') {
    at = row.createdAt + WAIT_MS;
  } else if (row.state === 'queued_processing' && row.processingQueuedAt != null) {
    at = row.processingQueuedAt + PROCESS_MS;
  } else if (row.cleanupPending) {
    // A stable past anchor makes discovery idempotent; the store alone owns retry backoff.
    at = row.createdAt;
  } else {
    at = Math.max(
      row.createdAt + UPLOAD_REPLAY_MS,
      row.acceptedAt == null ? 0 : row.acceptedAt + UPLOAD_WINDOW_MS,
    );
  }
  if (!Number.isSafeInteger(at) || at < 0 || at > 8.64e15)
    throw Error('UPLOAD_HOUSEKEEPING_INVALID');
  return new Date(at);
}

export function createUploadHousekeepingProjection(
  jobs: ProjectionStore,
): UploadHousekeepingProjection {
  return async (previous, next, session) => {
    if (!session.inTransaction()) throw Error('HOUSEKEEPING_OWNER_TRANSACTION_REQUIRED');
    let changed = false;
    if (previous && (!next || previous.generation !== next.generation)) {
      const old = await jobs.observeWork(uploadHousekeepingWork(previous), session);
      // Invalidation deliberately preserves started/unknown executions and their original evidence.
      if (old) changed = await jobs.invalidate(old._id, old.progressRevision, session);
    }
    if (!next) return changed;
    const work = uploadHousekeepingWork(next);
    const dueAt = uploadHousekeepingDue(next);
    const current = await jobs.observeWork(work, session);
    if (!current) {
      await jobs.project(work, dueAt, session);
      return true;
    }
    const refreshed = await jobs.refreshDue(
      work,
      {
        jobId: current._id,
        executionId: current.execution.id,
        progressRevision: current.progressRevision,
      },
      dueAt,
      session,
    );
    if (refreshed === 'stale') throw Error('UPLOAD_HOUSEKEEPING_CAS_LOST');
    return changed || refreshed === 'updated';
  };
}

/** Direct File mirrors/imports use the same model/connection without another transaction. */
export async function projectUploadHousekeeping(
  mongoose: typeof import('mongoose'),
  previous: StoredUpload | null,
  next: StoredUpload | null,
  session: ClientSession,
): Promise<boolean> {
  return createUploadHousekeepingProjection(createHousekeepingStore(mongoose))(
    previous,
    next,
    session,
  );
}

/** Only a never-started reservation can retire without an external receipt-consumption owner. */
export async function retireUploadHousekeeping(
  mongoose: typeof import('mongoose'),
  row: StoredUpload,
  session: ClientSession,
): Promise<boolean> {
  if (!session.inTransaction()) throw Error('HOUSEKEEPING_OWNER_TRANSACTION_REQUIRED');
  if (
    row.acceptedAt != null ||
    row.fileId ||
    row.attemptGeneration != null ||
    row.worker ||
    row.original ||
    row.parserExecution ||
    row.securityExecution ||
    row.promotion ||
    row.slot ||
    row.cleanupPending ||
    row.stagingHeld ||
    row.originalBytes ||
    row.textBytes
  )
    return false;
  const jobs = createHousekeepingStore(mongoose);
  await createUploadHousekeepingProjection(jobs)(row, null, session);
  const pending = await jobs.model
    .findOne({
      handler: 'upload.cleanup',
      'work.subject.tenantId': row.tenantId,
      'work.subject.ownerUserId': row.userId,
      subjectId: row._id,
      state: { $nin: ['settled', 'superseded', 'missed'] },
    })
    .select('_id')
    .hint(HOUSEKEEPING_INDEXES.owner)
    .session(session)
    .maxTimeMS(3_000)
    .lean();
  return pending === null;
}
