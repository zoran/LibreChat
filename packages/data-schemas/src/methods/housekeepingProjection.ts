/** Internal owner-transaction projection. This module never opens a transaction or grants effects. */
import { createHash, randomUUID } from 'node:crypto';
import { HOUSEKEEPING_HANDLERS } from 'librechat-data-provider';
import type { ClientSession, Model, mongo } from 'mongoose';
import type { HousekeepingWork, JobPhase } from '../types/housekeeping';
import type { HousekeepingJobRecord } from '../models/housekeepingJob';

const MAX = Number.MAX_SAFE_INTEGER;
const INITIAL: Record<HousekeepingWork['handler'], JobPhase> = {
  'file.warning': 'scheduled',
  'file.cleanup': 'awaiting_deadline',
  'upload.cleanup': 'awaiting_owner_transition',
};
const text = (value: unknown, max = 256): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  /^[A-Za-z0-9_.:-]+$/.test(value);
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const exactKeys = (value: object, keys: string[]): boolean =>
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));

export function assertWork(work: HousekeepingWork): void {
  if (!HOUSEKEEPING_HANDLERS.includes(work?.handler)) throw Error('HOUSEKEEPING_INVALID');
  const subject = work.subject;
  if (
    !subject ||
    !(subject.tenantId === null || text(subject.tenantId)) ||
    !text(subject.ownerUserId)
  ) {
    throw Error('HOUSEKEEPING_INVALID');
  }
  if (work.handler === 'upload.cleanup') {
    if (
      !exactKeys(work, [
        'handler',
        'subject',
        'operationId',
        'cleanupGeneration',
        'attemptGeneration',
      ]) ||
      !exactKeys(subject, ['tenantId', 'ownerUserId']) ||
      !text(work.operationId) ||
      !integer(work.cleanupGeneration) ||
      !(work.attemptGeneration === null || integer(work.attemptGeneration))
    )
      throw Error('HOUSEKEEPING_INVALID');
  } else if (
    !exactKeys(subject, ['tenantId', 'ownerUserId', 'fileId']) ||
    !text(work.subject.fileId) ||
    !integer(work.deadlineGeneration) ||
    (work.handler === 'file.warning'
      ? !exactKeys(work, ['handler', 'subject', 'deadlineGeneration', 'offsetDays']) ||
        ![7, 1].includes(work.offsetDays)
      : !exactKeys(work, ['handler', 'subject', 'deadlineGeneration', 'revocationId']) ||
        !(work.revocationId === null || text(work.revocationId)))
  )
    throw Error('HOUSEKEEPING_INVALID');
}

export function requireTransaction(session: ClientSession): void {
  if (!session?.inTransaction()) throw Error('HOUSEKEEPING_OWNER_TRANSACTION_REQUIRED');
}

export function housekeepingWorkIdentity(work: HousekeepingWork): {
  id: string;
  subjectId: string;
  generation: number;
} {
  assertWork(work);
  const subjectId = work.handler === 'upload.cleanup' ? work.operationId : work.subject.fileId;
  const generation =
    work.handler === 'upload.cleanup' ? work.cleanupGeneration : work.deadlineGeneration;
  const key = [
    work.handler,
    work.subject.tenantId,
    work.subject.ownerUserId,
    subjectId,
    generation,
    work.handler === 'file.warning' ? work.offsetDays : null,
  ];
  return {
    id: createHash('sha256').update(JSON.stringify(key)).digest('hex'),
    subjectId,
    generation,
  };
}

function assertDate(dueAt: Date): void {
  if (!(dueAt instanceof Date) || !Number.isFinite(dueAt.getTime()))
    throw Error('HOUSEKEEPING_INVALID');
}

function metadata(
  before: HousekeepingWork,
  after: HousekeepingWork,
): 'same' | 'advance' | 'preserve' {
  if (before.handler === 'file.cleanup' && after.handler === 'file.cleanup') {
    if (before.revocationId === after.revocationId) return 'same';
    return before.revocationId === null && after.revocationId !== null ? 'advance' : 'preserve';
  }
  if (before.handler === 'upload.cleanup' && after.handler === 'upload.cleanup') {
    if (before.attemptGeneration === after.attemptGeneration) return 'same';
    return after.attemptGeneration !== null &&
      (before.attemptGeneration === null || after.attemptGeneration > before.attemptGeneration)
      ? 'advance'
      : 'preserve';
  }
  return before.handler === after.handler ? 'same' : 'preserve';
}

export interface ProjectionExpectation {
  jobId: string;
  executionId: string;
  progressRevision: number;
}
export type DueRefresh = 'updated' | 'unchanged' | 'preserved' | 'stale';
export interface HousekeepingProjection {
  project(work: HousekeepingWork, dueAt: Date, session: ClientSession): Promise<string>;
  /** Same identity as project: revocation/attempt metadata are deliberately excluded. */
  observeWork(
    work: HousekeepingWork,
    session: ClientSession,
  ): Promise<HousekeepingJobRecord | null>;
  /** Only unstarted initial work may change; an updated claim is fenced and must be reacquired. */
  refreshDue(
    work: HousekeepingWork,
    expected: ProjectionExpectation,
    dueAt: Date,
    session: ClientSession,
  ): Promise<DueRefresh>;
  invalidate(jobId: string, expectedRevision: number, session: ClientSession): Promise<boolean>;
}

export function createHousekeepingProjection(
  mongoose: typeof import('mongoose'),
  model: Model<HousekeepingJobRecord>,
  policy: Readonly<{ queryMs: number; maxRecordBytes: number }>,
): HousekeepingProjection {
  const collection = model.collection as unknown as mongo.Collection<HousekeepingJobRecord>;
  const query = { maxTimeMS: policy.queryMs };
  return {
    async project(work, dueAt, session) {
      requireTransaction(session);
      const { id, subjectId, generation } = housekeepingWorkIdentity(work);
      assertDate(dueAt);
      const now = new Date();
      const row: HousekeepingJobRecord = {
        _id: id,
        version: 1,
        identityHash: id,
        handler: work.handler,
        work: structuredClone(work),
        subjectId,
        generation,
        dueAt,
        nextAttemptAt: dueAt,
        retryNotBefore: null,
        state: 'queued',
        fence: 0,
        progressRevision: 0,
        attempts: 0,
        recoveries: 0,
        lastRecoveryAt: null,
        claim: null,
        execution: { id: randomUUID(), phase: INITIAL[work.handler], receiptRef: null },
        lastCode: 'scheduled',
        createdAt: now,
        updatedAt: now,
        terminalAt: null,
      };
      if (mongoose.mongo.BSON.calculateObjectSize(row) > policy.maxRecordBytes) {
        throw Error('HOUSEKEEPING_RECORD_TOO_LARGE');
      }
      await collection.updateOne(
        { _id: id },
        { $setOnInsert: row },
        { ...query, session, upsert: true },
      );
      return id;
    },
    async observeWork(work, session) {
      requireTransaction(session);
      return collection.findOne({ _id: housekeepingWorkIdentity(work).id }, { ...query, session });
    },
    async refreshDue(work, expected, dueAt, session) {
      requireTransaction(session);
      const { id } = housekeepingWorkIdentity(work);
      assertDate(dueAt);
      if (
        !expected ||
        !exactKeys(expected, ['jobId', 'executionId', 'progressRevision']) ||
        !text(expected.jobId, 64) ||
        !text(expected.executionId, 64) ||
        !integer(expected.progressRevision) ||
        expected.progressRevision === MAX
      ) {
        throw Error('HOUSEKEEPING_INVALID');
      }
      if (expected.jobId !== id) return 'stale';
      const row = await collection.findOne(
        {
          _id: id,
          'execution.id': expected.executionId,
          progressRevision: expected.progressRevision,
        },
        { ...query, session },
      );
      if (!row) return 'stale';
      if (
        row.retryNotBefore === undefined &&
        (row.attempts !== 0 || row.state !== 'queued' || row.lastCode !== 'scheduled')
      ) {
        // Only owner migration can classify a legacy attempted row's hidden retry floor.
        return 'preserved';
      }
      const retryNotBefore = row.retryNotBefore ?? null;
      const transition = metadata(row.work, work);
      if (transition === 'same' && row.dueAt.getTime() === dueAt.getTime()) return 'unchanged';
      if (
        transition === 'preserve' ||
        !['queued', 'waiting', 'claimed'].includes(row.state) ||
        row.execution.phase !== INITIAL[row.handler] ||
        row.execution.receiptRef !== null ||
        row.terminalAt !== null ||
        row.fence === MAX
      )
        return 'preserved';
      const result = await collection.updateOne(
        {
          _id: id,
          work: row.work,
          state: row.state,
          fence: row.fence,
          'execution.id': expected.executionId,
          'execution.phase': row.execution.phase,
          'execution.receiptRef': null,
          progressRevision: expected.progressRevision,
        },
        [
          {
            $set: {
              work: { $literal: structuredClone(work) },
              dueAt: { $literal: dueAt },
              // Owner schedule and repository backoff remain independent through repeated refreshes.
              retryNotBefore: { $literal: retryNotBefore },
              nextAttemptAt:
                retryNotBefore === null
                  ? { $literal: dueAt }
                  : { $max: [{ $literal: dueAt }, { $literal: retryNotBefore }] },
              state: row.state === 'claimed' ? 'queued' : row.state,
              claim: null,
              fence: { $add: ['$fence', 1] },
              progressRevision: { $add: ['$progressRevision', 1] },
              updatedAt: '$$NOW',
            },
          },
        ],
        { ...query, session },
      );
      return result.modifiedCount === 1 ? 'updated' : 'stale';
    },
    async invalidate(jobId, expectedRevision, session) {
      requireTransaction(session);
      if (!text(jobId, 64) || !integer(expectedRevision) || expectedRevision === MAX) {
        throw Error('HOUSEKEEPING_INVALID');
      }
      const result = await collection.updateOne(
        {
          _id: jobId,
          progressRevision: expectedRevision,
          fence: { $lt: MAX },
          state: { $in: ['queued', 'waiting', 'claimed'] },
          terminalAt: null,
          $or: [
            {
              handler: 'file.warning',
              'execution.phase': { $in: ['scheduled', 'prepared', 'not_accepted'] },
            },
            {
              handler: 'file.cleanup',
              'execution.phase': 'awaiting_deadline',
              'execution.receiptRef': null,
              'work.revocationId': null,
            },
            {
              handler: 'upload.cleanup',
              'execution.phase': 'awaiting_owner_transition',
              'execution.receiptRef': null,
            },
          ],
        },
        [
          {
            $set: {
              state: 'superseded',
              claim: null,
              fence: { $add: ['$fence', 1] },
              progressRevision: { $add: ['$progressRevision', 1] },
              lastCode: 'superseded',
              terminalAt: '$$NOW',
              updatedAt: '$$NOW',
            },
          },
        ],
        { ...query, session },
      );
      return result.modifiedCount === 1;
    },
  };
}

/** Migration may add a proven legacy File floor; it cannot reconstruct an attempted job's unknown floor. */
export async function importFileRetryFloor(
  model: Model<HousekeepingJobRecord>,
  work: Extract<HousekeepingWork, { handler: 'file.cleanup' }>,
  floor: Date,
  session: ClientSession,
): Promise<boolean> {
  requireTransaction(session);
  assertDate(floor);
  const collection = model.collection as unknown as mongo.Collection<HousekeepingJobRecord>;
  const row = await collection.findOne(
    { _id: housekeepingWorkIdentity(work).id },
    { session, maxTimeMS: 1000 },
  );
  if (
    !row ||
    (row.retryNotBefore === undefined &&
      (row.attempts !== 0 || row.state !== 'queued' || row.lastCode !== 'scheduled'))
  )
    return false;
  if (row.retryNotBefore instanceof Date && row.retryNotBefore >= floor) return true;
  if (
    !['queued', 'waiting', 'claimed'].includes(row.state) ||
    row.execution.phase !== 'awaiting_deadline' ||
    row.execution.receiptRef !== null ||
    row.terminalAt !== null ||
    row.fence >= MAX ||
    row.progressRevision >= MAX
  )
    return false;
  const result = await collection.updateOne(
    {
      _id: row._id,
      progressRevision: row.progressRevision,
      fence: row.fence,
      state: row.state,
      claim: row.claim,
      execution: row.execution,
      retryNotBefore: row.retryNotBefore === undefined ? { $exists: false } : row.retryNotBefore,
    },
    {
      $set: {
        retryNotBefore: floor,
        nextAttemptAt: new Date(Math.max(row.dueAt.getTime(), floor.getTime())),
        state: 'queued',
        claim: null,
        updatedAt: new Date(),
      },
      $inc: { fence: 1, progressRevision: 1 },
    },
    { session, maxTimeMS: 1000 },
  );
  return result.matchedCount === 1;
}
