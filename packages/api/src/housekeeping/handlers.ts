/** Dispatches one owner-fenced step. File, Upload and the existing sender retain all effect authority. */
import { HOUSEKEEPING_HANDLERS } from 'librechat-data-provider';
import type {
  HousekeepingHandler,
  JobClaim,
  StepOutcome,
  FileNoticePort,
  FileCleanupPort,
  UploadCleanupPort,
} from '@librechat/data-schemas';
import type { RetentionMailOutcome, RetentionMailSender } from '../files/retentionMailSender';

export type HousekeepingStep = (claim: JobClaim, signal: AbortSignal) => Promise<StepOutcome>;
export type HousekeepingHandlers = Readonly<Record<HousekeepingHandler, HousekeepingStep>>;
export interface HousekeepingHandlerDependencies {
  fileNotice: FileNoticePort<RetentionMailOutcome>;
  fileCleanup: FileCleanupPort;
  uploadCleanup: UploadCleanupPort;
  /** Disabled mail has no sender; construction/configuration remains with the existing mail owner. */
  mailSender?: RetentionMailSender;
}

export function createHousekeepingHandlers(
  deps: HousekeepingHandlerDependencies,
): HousekeepingHandlers {
  const warning: HousekeepingStep = async (claim, signal) => {
    if (!deps.mailSender) return { state: 'retry', code: 'source_unavailable' };
    const prepared = await deps.fileNotice.prepare(claim);
    if (prepared.state === 'unknown') return { state: 'unknown' };
    if (prepared.state === 'no_send') {
      switch (prepared.reason) {
        case 'missed':
        case 'superseded':
          return { state: 'superseded' };
        case 'lost':
          return { state: 'lost' };
        case 'submission_unknown':
          return { state: 'pending', code: 'external_pending' };
        case 'owner_unavailable':
          return { state: 'retry', code: 'source_unavailable' };
        case 'insufficient_send_budget':
          return { state: 'retry', code: 'insufficient_send_budget' };
        case 'not_due':
          return { state: 'retry', code: 'owner_pending' };
      }
    }
    if (signal.aborted) return { state: 'pending', code: 'owner_pending' };
    let outcome: RetentionMailOutcome;
    try {
      outcome = await deps.mailSender.sendReminder({
        recipient: prepared.recipient,
        submissionId: prepared.submissionId,
        signal,
        authorizeHandoff: async (senderSignal) => {
          if (signal.aborted || senderSignal.aborted) return false;
          const authorized = await deps.fileNotice.authorizeHandoff(
            claim,
            prepared.snapshotToken,
            senderSignal,
          );
          return authorized && !signal.aborted && !senderSignal.aborted;
        },
        notice: {
          offsetDays: prepared.offsetDays,
          late: prepared.late,
          timezone: prepared.timezone,
          asOf: prepared.snapshot.asOf,
          files: prepared.snapshot.files.map((file) => ({
            filename: file.filename,
            acceptedAt: file.acceptedAt,
            lastSuccessfulReadAt: file.lastSuccessfulReadAt,
            lastReadKnown: file.lastReadKnown,
            readCount: file.readCount,
            processingCount: file.processingCount,
            inactivity: file.inactivity,
            deadlineAt: file.deadlineAt,
          })),
        },
      });
    } catch {
      // A rejected transport call is not proof of non-submission. Preserve this execution once.
      outcome = { state: 'unknown', reason: 'acknowledgementUnknown' };
    }
    // Cancellation cannot discard a known relay outcome or detach its original persistence promise.
    return deps.fileNotice.recordOutcome(claim, prepared.snapshotToken, outcome);
  };
  const steps: HousekeepingHandlers = {
    'file.warning': warning,
    'file.cleanup': (claim, signal) => deps.fileCleanup.step(claim, signal),
    'upload.cleanup': (claim, signal) => deps.uploadCleanup.step(claim, signal),
  };
  return Object.freeze(
    Object.fromEntries(
      HOUSEKEEPING_HANDLERS.map((handler) => [
        handler,
        async (claim: JobClaim, signal: AbortSignal): Promise<StepOutcome> => {
          if (claim.work.handler !== handler) throw new Error('Housekeeping handler mismatch');
          if (signal.aborted) return { state: 'pending', code: 'owner_pending' };
          return steps[handler](claim, signal);
        },
      ]),
    ) as Record<HousekeepingHandler, HousekeepingStep>,
  );
}
