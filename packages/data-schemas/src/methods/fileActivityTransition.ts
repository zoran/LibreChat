/** One arithmetic transition for successful original publication and finite user-read settlement. */
import type { StoredFileRetentionActivity } from '~/types/fileActivity';

export const FILE_ACTIVITY_EXTENSION_MS: number = 7 * 86400000;
const MAX_DATE = 8.64e15;
const instant = (value: Date) => value instanceof Date && Number.isSafeInteger(value.getTime());
const count = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** New originals start at acceptance; migration passes the exact existing deadline without extension. */
export function initialFileRetentionActivity(
  deadlineAt: Date,
  trackedSince: Date,
  historyConfidence: StoredFileRetentionActivity['historyConfidence'],
): StoredFileRetentionActivity {
  if (!instant(deadlineAt) || !instant(trackedSince) || trackedSince >= deadlineAt)
    throw new Error('Invalid File activity baseline');
  return {
    version: 1,
    baselineDeadlineAt: new Date(deadlineAt),
    trackedSince: new Date(trackedSince),
    historyConfidence,
    readCount: 0,
    processingCount: 0,
    deadlineGeneration: 0,
  };
}

export function validFileRetentionActivity(
  activity: StoredFileRetentionActivity | undefined,
  expiredAt: Date | null | undefined,
): activity is StoredFileRetentionActivity {
  if (
    !activity ||
    activity.version !== 1 ||
    !expiredAt ||
    !instant(expiredAt) ||
    !instant(activity.baselineDeadlineAt) ||
    !instant(activity.trackedSince) ||
    !['complete', 'since-tracking'].includes(activity.historyConfidence) ||
    !count(activity.readCount) ||
    !count(activity.processingCount) ||
    !count(activity.deadlineGeneration) ||
    !Number.isSafeInteger(activity.readCount + activity.processingCount) ||
    activity.deadlineGeneration !== activity.readCount + activity.processingCount ||
    activity.baselineDeadlineAt.getTime() +
      activity.deadlineGeneration * FILE_ACTIVITY_EXTENSION_MS !==
      expiredAt.getTime()
  )
    return false;
  for (const [n, at] of [
    [activity.readCount, activity.lastSuccessfulReadAt],
    [activity.processingCount, activity.lastSuccessfulProcessingAt],
  ] as const)
    if (n === 0 ? at !== undefined : !at || !instant(at) || at < activity.trackedSince)
      return false;
  return true;
}

/** Caller fences logical-event uniqueness, live File state and the matching Upload in its transaction. */
export function advanceFileRetentionActivity(
  activity: StoredFileRetentionActivity | undefined,
  expiredAt: Date | null | undefined,
  kind: 'read' | 'processing',
  observedAt: number,
  eligibilityNow: number,
): { activity: StoredFileRetentionActivity; expiredAt: Date } {
  if (
    !validFileRetentionActivity(activity, expiredAt) ||
    activity.migrationEpoch !== undefined ||
    !Number.isSafeInteger(observedAt) ||
    !Number.isSafeInteger(eligibilityNow) ||
    observedAt < activity.trackedSince.getTime() ||
    observedAt > eligibilityNow ||
    expiredAt!.getTime() <= eligibilityNow ||
    activity.deadlineGeneration >= Number.MAX_SAFE_INTEGER ||
    expiredAt!.getTime() > MAX_DATE - FILE_ACTIVITY_EXTENSION_MS
  )
    throw new Error('File activity is unavailable');
  const next = { ...activity, deadlineGeneration: activity.deadlineGeneration + 1 };
  if (kind === 'read') {
    next.readCount++;
    next.lastSuccessfulReadAt = new Date(
      Math.max(observedAt, activity.lastSuccessfulReadAt?.getTime() ?? 0),
    );
  } else {
    next.processingCount++;
    next.lastSuccessfulProcessingAt = new Date(
      Math.max(observedAt, activity.lastSuccessfulProcessingAt?.getTime() ?? 0),
    );
  }
  const deadline = new Date(expiredAt!.getTime() + FILE_ACTIVITY_EXTENSION_MS);
  if (!validFileRetentionActivity(next, deadline)) throw new Error('File activity overflow');
  return { activity: next, expiredAt: deadline };
}
