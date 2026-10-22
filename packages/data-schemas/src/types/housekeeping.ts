import type { ClientSession } from 'mongoose';
/** Plain Housekeeping execution ports; File/Upload remain business and receipt authorities. */
import type { HousekeepingHandler, StatusHousekeeping } from 'librechat-data-provider';
import type { FileActivitySubject, FileActivitySnapshotBatch } from './fileActivity';

export type { HousekeepingHandler } from 'librechat-data-provider';
export type HousekeepingWork =
  | Readonly<{
      handler: 'file.warning';
      subject: FileActivitySubject;
      deadlineGeneration: number;
      offsetDays: 7 | 1;
    }>
  | Readonly<{
      handler: 'file.cleanup';
      subject: FileActivitySubject;
      deadlineGeneration: number;
      revocationId: string | null;
    }>
  | Readonly<{
      handler: 'upload.cleanup';
      subject: Readonly<{ tenantId: string | null; ownerUserId: string }>;
      operationId: string;
      cleanupGeneration: number;
      attemptGeneration: number | null;
    }>;

export type WorkerIdentity = Readonly<{
  podUid: string;
  incarnation: string;
  source: string;
  hostId: string;
}>;
/** Stable for one claim; progress changes never invalidate this heartbeat token. */
export type JobOwnership = Readonly<{
  jobId: string;
  worker: WorkerIdentity;
  claimId: string;
  fence: number;
}>;
export type JobClaim = JobOwnership &
  Readonly<{
    work: HousekeepingWork;
    /** Snapshot only. Progress mutation obtains its expected revision from a fresh owner read. */
    progressRevision: number;
    executionId: string;
    leaseUntil: string;
  }>;
export type JobState =
  | 'queued'
  | 'claimed'
  | 'waiting'
  | 'unknown'
  | 'settled'
  | 'superseded'
  | 'missed';
export type JobPhase =
  | 'scheduled'
  | 'prepared'
  | 'armed'
  | 'accepted'
  | 'not_accepted'
  | 'unknown'
  | 'missed'
  | 'superseded'
  | 'awaiting_deadline'
  | 'revoked'
  | 'capturing_generations'
  | 'settling_generations'
  | 'purging_derivatives'
  | 'removing_original'
  | 'finalizing'
  | 'complete'
  | 'awaiting_owner_transition'
  | 'awaiting_actor'
  | 'removing_unaccepted_original'
  | 'confirming';
export type RetryCode =
  | 'owner_pending'
  | 'external_pending'
  | 'not_accepted'
  | 'source_unavailable'
  | 'insufficient_send_budget';
export type JobCode =
  | RetryCode
  | 'scheduled'
  | 'claimed'
  | 'renewed'
  | 'progress'
  | 'released'
  | 'settled'
  | 'superseded'
  | 'missed'
  | 'submission_unknown';
export type WriteOutcome = 'recorded' | 'lost' | 'unknown';

/** A reference certifies nothing by itself: only the owning domain can validate the receipt. */
export type ExecutionObservation =
  | Readonly<{
      state: 'observed';
      jobId: string;
      executionId: string;
      jobState: JobState;
      phase: JobPhase;
      progressRevision: number;
      receiptRef: string | null;
      code: JobCode;
    }>
  | Readonly<{ state: 'missing' | 'unknown' }>;
export type CommitOutcome =
  | Readonly<{ state: 'progress' | 'settled'; receiptRef: string | null }>
  | Readonly<{ state: 'retry'; code: RetryCode }>
  | Readonly<{ state: 'pending'; code: 'owner_pending' | 'external_pending' }>
  | Readonly<{ state: 'superseded' | 'lost' | 'unknown' }>;
export type StepOutcome = CommitOutcome;
export type DiscoveryPage = Readonly<{ cursor: string | null; scanned: number; complete: boolean }>;

/** Rejected claim/renew promises are uncertain outcomes: callers must not start/replay effects. */
export interface HousekeepingRepository {
  discover(handler: HousekeepingHandler, cursor: string | null): Promise<DiscoveryPage>;
  claimNext(handler: HousekeepingHandler, worker: WorkerIdentity): Promise<JobClaim | null>;
  renew(ownership: JobOwnership): Promise<JobClaim | null>;
  inspect(jobId: string, executionId: string): Promise<ExecutionObservation>;
  defer(claim: JobClaim, reason: RetryCode): Promise<WriteOutcome>;
  releaseUnstarted(claim: JobClaim): Promise<WriteOutcome>;
  readStatus(signal: AbortSignal): Promise<StatusHousekeeping['domain']>;
}

export type PreparedNotice = Readonly<{
  state: 'prepared';
  submissionId: string;
  snapshotToken: string;
  recipient: string;
  offsetDays: 7 | 1;
  late: boolean;
  timezone: string;
  snapshot: FileActivitySnapshotBatch;
}>;
export type NoticePreparation =
  | PreparedNotice
  | Readonly<{
      state: 'no_send';
      reason:
        | 'not_due'
        | 'missed'
        | 'superseded'
        | 'owner_unavailable'
        | 'insufficient_send_budget'
        | 'submission_unknown'
        | 'lost';
    }>
  | Readonly<{ state: 'unknown' }>;

/** The API binds TSubmissionOutcome to its sole RetentionMailOutcome, avoiding a package cycle. */
export interface FileNoticePort<TSubmissionOutcome> {
  prepare(claim: JobClaim): Promise<NoticePreparation>;
  authorizeHandoff(claim: JobClaim, snapshotToken: string, signal: AbortSignal): Promise<boolean>;
  recordOutcome(
    claim: JobClaim,
    snapshotToken: string,
    outcome: TSubmissionOutcome,
  ): Promise<CommitOutcome>;
}
export interface FileCleanupPort {
  step(claim: JobClaim, signal: AbortSignal): Promise<StepOutcome>;
}
export interface UploadCleanupPort {
  step(claim: JobClaim, signal: AbortSignal): Promise<StepOutcome>;
}

/** Owner projection coverage in the counts' read snapshot, never inferred from an empty queue. */
export type HousekeepingCoverage = Readonly<{
  expected: number | null;
  observed: number;
  /** GC or incomplete retained history makes lifetime recovery values partial/unknown. */
  recoveryHistory: 'complete' | 'partial' | 'unknown';
}>;

/** Internal persistence composition; never exported as a plain worker port. */
export interface HousekeepingOwners {
  discover(handler: HousekeepingHandler, cursor: string | null): Promise<DiscoveryPage>;
  /**
   * Read authoritative coverage on this exact snapshot session, without replacing/ending it,
   * opening a transaction or mutating owner state. Bound DB work and honor the supplied signal.
   */
  coverage(
    handler: HousekeepingHandler,
    signal: AbortSignal,
    session: ClientSession,
  ): Promise<HousekeepingCoverage>;
}
