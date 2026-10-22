/** Private File notice bindings: no mailbox, filename, message body or transport diagnostic persists. */
import { createHash } from 'node:crypto';
import type { HousekeepingJobRecord } from '../models/housekeepingJob';
import type { FileActivitySnapshotBatch } from '../types/fileActivity';
import type { JobClaim } from '../types/housekeeping';

/** Structural bound for the existing sender's outcome; no API-package dependency or second transport. */
export type NoticeDeliveryOutcome =
  | Readonly<{ state: 'accepted'; relayIndex: number }>
  | Readonly<{
      state: 'notAccepted';
      reason: 'invalid' | 'tooLarge' | 'notAuthorized' | 'unavailable';
    }>
  | Readonly<{ state: 'unknown'; reason: 'acknowledgementUnknown' }>;
export interface NoticeBinding {
  version: 1;
  snapshotToken: string;
  snapshotDigest: string;
  recipientDigest: string;
  preparedAt: Date;
  submissionId: string;
  armedBy?: string;
  outcome?: NoticeDeliveryOutcome;
  outcomeDigest?: string;
}
export type NoticeJob = HousekeepingJobRecord & {
  execution: HousekeepingJobRecord['execution'] & { notice?: NoticeBinding };
};
export const noticeDigest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const noticeOwnershipDigest = (claim: JobClaim): string =>
  noticeDigest([claim.jobId, claim.executionId, claim.claimId, claim.fence, claim.worker]);
export function recipientDigest(
  user: { email: string; emailChangedAt?: Date },
  claim: JobClaim,
): string {
  return noticeDigest([
    claim.work.subject.tenantId,
    claim.work.subject.ownerUserId,
    user.email,
    user.emailChangedAt?.toISOString() ?? null,
    true,
  ]);
}
export function snapshotDigest(snapshot: FileActivitySnapshotBatch, claim: JobClaim): string {
  return noticeDigest([claim.work, snapshot]);
}
export function validNoticeBinding(value: NoticeBinding | undefined): value is NoticeBinding {
  return (
    !!value &&
    value.version === 1 &&
    [value.snapshotToken, value.snapshotDigest, value.recipientDigest].every(
      (part) => typeof part === 'string' && /^[a-f0-9]{64}$/.test(part),
    ) &&
    value.preparedAt instanceof Date &&
    Number.isSafeInteger(value.preparedAt.getTime()) &&
    typeof value.submissionId === 'string' &&
    value.submissionId.length > 0 &&
    value.submissionId.length <= 256
  );
}
export function captureNoticeOutcome(value: NoticeDeliveryOutcome): NoticeDeliveryOutcome {
  if (
    value?.state === 'accepted' &&
    Number.isInteger(value.relayIndex) &&
    value.relayIndex >= 0 &&
    value.relayIndex <= 1
  )
    return { state: 'accepted', relayIndex: value.relayIndex };
  if (
    value?.state === 'notAccepted' &&
    ['invalid', 'tooLarge', 'notAuthorized', 'unavailable'].includes(value.reason)
  )
    return { state: 'notAccepted', reason: value.reason };
  // Unknown/malformed evidence cannot authorize a retry or become a delivery claim.
  return { state: 'unknown', reason: 'acknowledgementUnknown' };
}
