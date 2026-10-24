/** Existing File/job projection checks shared by the historical source owner. */
import type { ClientSession, mongo } from 'mongoose';
import type { HousekeepingJobRecord } from '~/models/housekeepingJob';
import type { UploadStore } from './uploadManagementStore';
import type { IMongoFile } from '~/types/file';
import {
  isFileCoverageInteger as integer,
  isFileCoverageIdentifier as id,
  sameFileCoverageData as same,
} from './fileHousekeepingCoverageContract';
import { housekeepingWorkIdentity, assertWork } from './housekeepingProjection';
import { fileHousekeepingObligations } from './fileHousekeepingProjection';
import { CoverageError, fields } from './fileHousekeepingCoverageData';
import { classifyFileCoverage } from './fileRetentionMigration';
import { createHousekeepingStore } from './housekeepingStore';
import { FileHistoryError } from './fileHousekeepingHistory';
import { currentFileDeadline } from './fileSourceAuthority';
type FileCoverageProjectionChecks = {
  jobKnown(
    row: HousekeepingJobRecord,
    session: ClientSession,
    end: number,
    signal: AbortSignal,
  ): Promise<boolean>;
  fileKnown(
    file: IMongoFile,
    session: ClientSession,
    end: number,
    signal: AbortSignal,
  ): Promise<'excluded' | 'retained' | 'unknown'>;
};
export function createFileCoverageProjectionChecks(
  store: UploadStore,
  options: (session: ClientSession, end: number, signal: AbortSignal) => mongo.FindOptions,
): FileCoverageProjectionChecks {
  const { mongoose } = store;
  const files = mongoose.models.File.collection as unknown as mongo.Collection<IMongoFile>;
  const collection = createHousekeepingStore(mongoose).model
    .collection as unknown as mongo.Collection<HousekeepingJobRecord>;
  async function jobKnown(
    row: HousekeepingJobRecord,
    session: ClientSession,
    end: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      assertWork(row.work);
      if (
        row.version !== 1 ||
        row.handler !== row.work.handler ||
        row._id !== housekeepingWorkIdentity(row.work).id ||
        row.identityHash !== row._id ||
        !integer(row.progressRevision) ||
        !integer(row.fence) ||
        !integer(row.attempts) ||
        !integer(row.recoveries) ||
        row.claim !== null ||
        ![row.dueAt, row.nextAttemptAt].every(
          (value) => value instanceof Date && Number.isFinite(value.getTime()),
        ) ||
        !(
          row.retryNotBefore === null ||
          (row.retryNotBefore instanceof Date && Number.isFinite(row.retryNotBefore.getTime()))
        ) ||
        !['queued', 'waiting', 'settled', 'superseded', 'missed'].includes(row.state) ||
        !row.execution ||
        !id(row.execution.id) ||
        ['armed', 'unknown'].includes(row.execution.phase)
      )
        return false;
      // Certification must not hide a runnable schedule that bypasses its retained lower bounds.
      if (
        ['queued', 'waiting'].includes(row.state) &&
        (row.nextAttemptAt < row.dueAt ||
          (row.retryNotBefore instanceof Date && row.nextAttemptAt < row.retryNotBefore))
      )
        return false;
      if (row.handler === 'upload.cleanup') return true;
      const work = row.work;
      if (
        work.handler === 'upload.cleanup' ||
        row.subjectId !== work.subject.fileId ||
        row.generation !== work.deadlineGeneration
      )
        return false;
      const file = await files.findOne(
        {
          file_id: work.subject.fileId,
          user: new mongoose.Types.ObjectId(work.subject.ownerUserId),
          tenantId: { $eq: work.subject.tenantId, $exists: true },
        } as unknown as mongo.Filter<IMongoFile>,
        { ...options(session, end, signal), projection: fields },
      );
      if (
        !file ||
        classifyFileCoverage(file) !== 'retained' ||
        work.deadlineGeneration > currentFileDeadline(file).deadlineGeneration
      )
        return false;
      if (
        row.handler === 'file.cleanup' &&
        file.deletionRetryAt instanceof Date &&
        (!(row.retryNotBefore instanceof Date) || row.retryNotBefore < file.deletionRetryAt)
      )
        return false;
      return true;
    } catch (error) {
      if (error instanceof CoverageError || error instanceof FileHistoryError) throw error;
      return false;
    }
  }
  async function fileKnown(
    file: IMongoFile,
    session: ClientSession,
    end: number,
    signal: AbortSignal,
  ): Promise<'excluded' | 'retained' | 'unknown'> {
    const kind = classifyFileCoverage(file);
    if (kind !== 'retained') return kind;
    for (const item of fileHousekeepingObligations(file)) {
      const row = await collection.findOne(
        { _id: housekeepingWorkIdentity(item.work).id },
        options(session, end, signal),
      );
      if (
        !row ||
        !(await jobKnown(row, session, end, signal)) ||
        !same(row.work, item.work) ||
        row.dueAt.getTime() !== item.dueAt.getTime()
      )
        return 'unknown';
    }
    return 'retained';
  }
  return { jobKnown, fileKnown };
}
