/** File-owned transaction join. Housekeeping owns job identity, CAS and retained effect evidence. */
import type { ClientSession } from 'mongoose';
import type { HousekeepingWork } from '~/types/housekeeping';
import type { IMongoFile } from '~/types/file';
import { createHousekeepingStore } from './housekeepingStore';
import { currentFileDeadline } from './fileSourceAuthority';

const DAY = 86400000;
type FileWork = Extract<HousekeepingWork, { handler: 'file.warning' | 'file.cleanup' }>;

/** The sole current File obligation projection; snapshot census uses these same identities/dates. */
export function fileHousekeepingObligations(file: IMongoFile): { work: FileWork; dueAt: Date }[] {
  const deadline = currentFileDeadline(file);
  if (file.deletionCompletedAt) return [];
  const subject = {
    tenantId: file.tenantId ?? null,
    ownerUserId: String(file.user),
    fileId: file.file_id,
  };
  const revoked = file.deletionRequestedAt != null;
  if (revoked && !file.retentionRevocationId)
    throw new Error('Revoked File lacks its durable identity');
  const cleanup: FileWork = {
    handler: 'file.cleanup',
    subject,
    deadlineGeneration: deadline.deadlineGeneration,
    revocationId: file.retentionRevocationId ?? null,
  };
  return [
    ...(!revoked
      ? ([7, 1] as const).map((offsetDays) => ({
          work: {
            handler: 'file.warning' as const,
            subject,
            deadlineGeneration: deadline.deadlineGeneration,
            offsetDays,
          },
          dueAt: new Date(deadline.deadlineAt.getTime() - offsetDays * DAY),
        }))
      : []),
    { work: cleanup, dueAt: revoked ? new Date(file.deletionRequestedAt!) : deadline.deadlineAt },
  ];
}

export async function projectFileHousekeeping(
  mongoose: typeof import('mongoose'),
  currentFile: IMongoFile | null,
  nextFile: IMongoFile,
  session: ClientSession,
): Promise<void> {
  if (!session.inTransaction()) throw new Error('File projection requires its owner transaction');
  const subject = {
    tenantId: nextFile.tenantId ?? null,
    ownerUserId: String(nextFile.user),
    fileId: nextFile.file_id,
  };
  if (
    currentFile &&
    (currentFile.file_id !== nextFile.file_id ||
      String(currentFile.user) !== subject.ownerUserId ||
      (currentFile.tenantId ?? null) !== subject.tenantId)
  )
    throw new Error('File projection identity changed');
  const previous =
    currentFile && (currentFile.retentionActivity || currentFile.derivedRetention)
      ? currentFileDeadline(currentFile)
      : null;
  const next =
    nextFile.deletionCompletedAt && !nextFile.retentionActivity && !nextFile.derivedRetention
      ? previous
      : currentFileDeadline(nextFile);
  if (!next) throw new Error('File projection has no current generation');
  const jobs = createHousekeepingStore(mongoose);
  const work = (generation: number, revocationId: string | null = null): FileWork[] => [
    { handler: 'file.warning', subject, deadlineGeneration: generation, offsetDays: 7 },
    { handler: 'file.warning', subject, deadlineGeneration: generation, offsetDays: 1 },
    { handler: 'file.cleanup', subject, deadlineGeneration: generation, revocationId },
  ];
  async function invalidate(item: FileWork): Promise<void> {
    const row = await jobs.observeWork(item, session);
    if (
      !row ||
      ['unknown', 'settled', 'superseded', 'missed'].includes(row.state) ||
      (row.handler === 'file.warning' && ['armed', 'unknown'].includes(row.execution.phase)) ||
      (row.handler === 'file.cleanup' && row.execution.phase !== 'awaiting_deadline')
    )
      return;
    if (!(await jobs.invalidate(row._id, row.progressRevision, session)))
      throw new Error('File projection lost its job fence');
  }
  if (previous && previous.deadlineGeneration !== next.deadlineGeneration)
    for (const item of work(previous.deadlineGeneration)) await invalidate(item);
  const revoked = nextFile.deletionRequestedAt != null || nextFile.deletionCompletedAt != null;
  const current = work(next.deadlineGeneration, nextFile.retentionRevocationId ?? null);
  if (revoked) {
    for (const item of current) if (item.handler === 'file.warning') await invalidate(item);
  }
  if (nextFile.deletionCompletedAt) return;
  for (const { work: item, dueAt } of fileHousekeepingObligations(nextFile)) {
    await jobs.project(item, dueAt, session);
    const observed = await jobs.observeWork(item, session);
    if (!observed) throw new Error('File projection was not observed in its transaction');
    const result = await jobs.refreshDue(
      item,
      {
        jobId: observed._id,
        executionId: observed.execution.id,
        progressRevision: observed.progressRevision,
      },
      dueAt,
      session,
    );
    if (result === 'stale') throw new Error('File projection lost its job fence');
    if (
      result === 'preserved' &&
      (observed.dueAt.getTime() !== dueAt.getTime() ||
        (item.handler === 'file.cleanup' &&
          observed.work.handler === 'file.cleanup' &&
          observed.work.revocationId !== item.revocationId))
    )
      throw new Error('File projection preserved an incompatible obligation');
  }
}
