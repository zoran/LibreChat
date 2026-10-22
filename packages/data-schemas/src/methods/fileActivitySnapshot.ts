/** Existing housekeeping/mail consumers receive one truthful File-owned observation projection. */
import type {
  FileActivityCount,
  FileActivityInactivity,
  FileActivitySnapshot,
} from '~/types/fileActivity';
import type { IMongoFile } from '~/types/file';
import { validFileRetentionActivity } from './fileActivityTransition';
import { currentFileDeadline } from './fileSourceAuthority';

export function projectFileActivitySnapshot(file: IMongoFile, asOf: Date): FileActivitySnapshot {
  const deadline = currentFileDeadline(file);
  if (!Number.isSafeInteger(asOf.getTime())) throw new Error('Invalid File observation');
  if (deadline.kind === 'derived')
    return {
      subject: {
        tenantId: file.tenantId ?? null,
        ownerUserId: String(file.user),
        fileId: file.file_id,
      },
      filename: file.filename,
      acceptedAt: file.retentionAcceptedAt?.toISOString() ?? null,
      deadlineAt: deadline.deadlineAt.toISOString(),
      deadlineGeneration: deadline.deadlineGeneration,
      lastSuccessfulReadAt: null,
      lastSuccessfulProcessingAt: null,
      lastReadKnown: false,
      readCount: { known: false },
      processingCount: { known: false },
      inactivity: { known: false },
    };
  const activity = file.retentionActivity;
  if (
    !validFileRetentionActivity(activity, file.expiredAt) ||
    !Number.isSafeInteger(asOf.getTime())
  )
    throw new Error('File activity has not been reconciled');
  const complete = activity.historyConfidence === 'complete';
  const count = (value: number): FileActivityCount =>
    complete
      ? { known: true, value, coverage: 'complete' }
      : { known: true, value, coverage: 'since', since: activity.trackedSince.toISOString() };
  const lastRead = activity.lastSuccessfulReadAt?.getTime();
  const lastProcessing = activity.lastSuccessfulProcessingAt?.getTime();
  const successful = Math.max(lastRead ?? 0, lastProcessing ?? 0);
  const lastUse = successful || (complete ? file.retentionAcceptedAt?.getTime() : undefined);
  const inactivity: FileActivityInactivity =
    lastUse === undefined
      ? { known: false }
      : {
          known: true,
          since: new Date(lastUse).toISOString(),
          fullDays: Math.max(0, Math.floor((asOf.getTime() - lastUse) / 86400000)),
          basis: successful ? 'successful-use' : 'upload',
        };
  return {
    subject: {
      tenantId: file.tenantId ?? null,
      ownerUserId: file.user.toString(),
      fileId: file.file_id,
    },
    filename: file.filename,
    acceptedAt: file.retentionAcceptedAt?.toISOString() ?? null,
    deadlineAt: file.expiredAt!.toISOString(),
    deadlineGeneration: activity.deadlineGeneration,
    lastSuccessfulReadAt: activity.lastSuccessfulReadAt?.toISOString() ?? null,
    lastReadKnown: complete || lastRead !== undefined,
    lastSuccessfulProcessingAt: activity.lastSuccessfulProcessingAt?.toISOString() ?? null,
    readCount: count(activity.readCount),
    processingCount: count(activity.processingCount),
    inactivity,
  };
}
