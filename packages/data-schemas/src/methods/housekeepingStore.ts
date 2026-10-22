/** Internal Mongo owner primitives. Sessions never cross the public Housekeeping port. */
import { performance } from 'node:perf_hooks';
import { randomUUID, randomInt } from 'node:crypto';
import { HOUSEKEEPING_HANDLERS } from 'librechat-data-provider';
import type { ClientSession, Model, mongo } from 'mongoose';
import type {
  JobClaim,
  JobOwnership,
  JobPhase,
  JobCode,
  JobState,
  HousekeepingHandler,
  WorkerIdentity,
} from '../types/housekeeping';
import type { HousekeepingProjection } from './housekeepingProjection';
import type { HousekeepingJobRecord } from '../models/housekeepingJob';
import {
  createHousekeepingProjection,
  assertWork,
  requireTransaction,
} from './housekeepingProjection';
import { createHousekeepingJobModel, HOUSEKEEPING_INDEXES } from '../models/housekeepingJob';

export const HOUSEKEEPING_STORE_POLICY: Readonly<{
  candidates: 32;
  queryMs: 3000;
  leaseMs: 90000;
  maxRecordBytes: 16384;
}> = Object.freeze({
  candidates: 32,
  queryMs: 3000,
  leaseMs: 90000,
  maxRecordBytes: 16384,
});
const MAX = Number.MAX_SAFE_INTEGER;
const majority = { w: 'majority' as const };
const CODES: readonly JobCode[] = [
  'owner_pending',
  'external_pending',
  'not_accepted',
  'source_unavailable',
  'insufficient_send_budget',
  'scheduled',
  'claimed',
  'renewed',
  'progress',
  'released',
  'settled',
  'superseded',
  'missed',
  'submission_unknown',
];
const PHASES: Record<HousekeepingHandler, readonly JobPhase[]> = {
  'file.warning': [
    'scheduled',
    'prepared',
    'armed',
    'accepted',
    'not_accepted',
    'unknown',
    'missed',
    'superseded',
  ],
  'file.cleanup': [
    'awaiting_deadline',
    'revoked',
    'capturing_generations',
    'settling_generations',
    'purging_derivatives',
    'removing_original',
    'finalizing',
    'complete',
  ],
  'upload.cleanup': [
    'awaiting_owner_transition',
    'awaiting_actor',
    'removing_unaccepted_original',
    'confirming',
    'complete',
  ],
};
const text = (value: unknown, max = 256): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  /^[A-Za-z0-9_.:-]+$/.test(value);
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
function allowedTransition(handler: HousekeepingHandler, from: JobPhase, to: JobPhase): boolean {
  if (from === to) return !['accepted', 'complete', 'missed', 'superseded'].includes(from);
  if (handler !== 'file.warning') {
    return PHASES[handler].indexOf(to) === PHASES[handler].indexOf(from) + 1;
  }
  const transitions: Partial<Record<JobPhase, readonly JobPhase[]>> = {
    scheduled: ['prepared', 'missed', 'superseded'],
    prepared: ['armed', 'not_accepted', 'missed', 'superseded'],
    armed: ['accepted', 'not_accepted', 'unknown'],
    not_accepted: ['prepared', 'missed', 'superseded'],
  };
  return transitions[from]?.includes(to) === true;
}
function exactKeys(value: object, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}
export function assertHandler(value: unknown): asserts value is HousekeepingHandler {
  if (!HOUSEKEEPING_HANDLERS.includes(value as HousekeepingHandler))
    throw Error('HOUSEKEEPING_INVALID');
}
function assertWorker(worker: WorkerIdentity): void {
  if (
    !worker ||
    !exactKeys(worker, ['podUid', 'incarnation', 'source', 'hostId']) ||
    !Object.values(worker).every((value) => text(value))
  )
    throw Error('HOUSEKEEPING_INVALID');
}
export function ownershipFilter(token: JobOwnership): mongo.Filter<HousekeepingJobRecord> {
  assertWorker(token.worker);
  if (!text(token.jobId, 64) || !text(token.claimId, 64) || !integer(token.fence))
    throw Error('HOUSEKEEPING_INVALID');
  return {
    _id: token.jobId,
    state: 'claimed',
    fence: token.fence,
    'claim.claimId': token.claimId,
    'claim.worker.podUid': token.worker.podUid,
    'claim.worker.incarnation': token.worker.incarnation,
    'claim.worker.source': token.worker.source,
    'claim.worker.hostId': token.worker.hostId,
    $expr: { $gt: ['$claim.leaseUntil', '$$NOW'] },
  };
}
export function claimView(row: HousekeepingJobRecord): JobClaim {
  if (!row.claim) throw Error('HOUSEKEEPING_INVALID_CLAIM');
  return {
    jobId: row._id,
    work: row.work,
    worker: row.claim.worker,
    claimId: row.claim.claimId,
    fence: row.fence,
    progressRevision: row.progressRevision,
    executionId: row.execution.id,
    leaseUntil: row.claim.leaseUntil.toISOString(),
  };
}
export interface ProgressExpectation {
  revision: number;
  phase: JobPhase;
}
export interface ProgressChange {
  phase: JobPhase;
  code: JobCode;
  state?: JobState;
  receiptRef?: string | null;
}
export interface HousekeepingStore extends HousekeepingProjection {
  model: Model<HousekeepingJobRecord>;
  initialize(): Promise<void>;
  claimNext(handler: HousekeepingHandler, worker: WorkerIdentity): Promise<JobClaim | null>;
  renew(token: JobOwnership): Promise<JobClaim | null>;
  observe(jobId: string, executionId: string): Promise<HousekeepingJobRecord | null>;
  advance(
    claim: JobClaim,
    expected: ProgressExpectation,
    change: ProgressChange,
    session: ClientSession,
  ): Promise<boolean>;
  release(claim: JobClaim, unstarted: boolean, code: JobCode): Promise<boolean>;
  pruneTerminal(
    limit: number,
    authorize: (row: HousekeepingJobRecord, session: ClientSession) => Promise<boolean>,
  ): Promise<number>;
}

/** One factory per existing connection; no global counter, clock injection, timer or leader. */
export function createHousekeepingStore(mongoose: typeof import('mongoose')): HousekeepingStore {
  const model = createHousekeepingJobModel(mongoose);
  const query = { maxTimeMS: HOUSEKEEPING_STORE_POLICY.queryMs };
  const standalone = { ...query, timeoutMS: HOUSEKEEPING_STORE_POLICY.queryMs };
  // Mongoose erases the collection's schema generic; this model owns its String _id and records.
  const collection = model.collection as unknown as mongo.Collection<HousekeepingJobRecord>;
  let expiredFirst = false;
  return {
    ...createHousekeepingProjection(mongoose, model, HOUSEKEEPING_STORE_POLICY),
    model,
    async initialize() {
      await model.init();
    },
    async claimNext(handler, worker) {
      assertHandler(handler);
      assertWorker(worker);
      const deadline = performance.now() + HOUSEKEEPING_STORE_POLICY.queryMs;
      const remaining = () => {
        const timeoutMS = Math.floor(deadline - performance.now());
        if (timeoutMS < 1) throw Error('HOUSEKEEPING_QUERY_TIMEOUT');
        return { ...query, timeoutMS };
      };
      // Server time supplies the index bound; the final CAS still checks its own $$NOW.
      const clock = await mongoose.connection.db!.command(
        { hello: 1 },
        { timeoutMS: remaining().timeoutMS },
      );
      if (!(clock.localTime instanceof Date)) throw Error('HOUSEKEEPING_CLOCK_UNAVAILABLE');
      const finite = {
        fence: { $lt: MAX },
        progressRevision: { $lt: MAX },
        attempts: { $lt: MAX },
        recoveries: { $lt: MAX },
      };
      // Separate indexed lanes prevent a large waiting population hiding expired claims.
      const lanes: {
        filter: mongo.Filter<HousekeepingJobRecord>;
        sort: mongo.Sort;
        hint: string;
      }[] = [
        {
          filter: {
            ...finite,
            handler,
            state: 'claimed',
            'claim.leaseUntil': { $lte: clock.localTime },
            $expr: { $lte: ['$claim.leaseUntil', '$$NOW'] },
          },
          sort: { 'claim.leaseUntil': 1 as const, _id: 1 as const },
          hint: HOUSEKEEPING_INDEXES.expired,
        },
        {
          filter: {
            ...finite,
            handler,
            state: { $in: ['queued', 'waiting'] },
            nextAttemptAt: { $lte: clock.localTime },
            $expr: { $lte: ['$nextAttemptAt', '$$NOW'] },
          },
          sort: { nextAttemptAt: 1 as const, _id: 1 as const },
          hint: HOUSEKEEPING_INDEXES.due,
        },
      ];
      if (!expiredFirst) lanes.reverse();
      expiredFirst = !expiredFirst;
      for (const lane of lanes) {
        const rows = await collection
          .find(lane.filter, {
            ...remaining(),
            hint: lane.hint,
            projection: {
              _id: 1,
              state: 1,
              fence: 1,
              progressRevision: 1,
              attempts: 1,
              recoveries: 1,
              execution: 1,
            },
          })
          .sort(lane.sort)
          .limit(16)
          .toArray();
        for (const candidate of rows) {
          const guard = {
            ...lane.filter,
            _id: candidate._id,
            fence: candidate.fence,
            progressRevision: candidate.progressRevision,
            attempts: { $lt: MAX },
            $and: [
              { fence: { $lt: MAX } },
              { progressRevision: { $lt: MAX } },
              { recoveries: { $lt: MAX } },
            ],
          };
          const takeover = candidate.state === 'claimed';
          if (
            handler === 'file.warning' &&
            ['armed', 'unknown'].includes(candidate.execution.phase)
          ) {
            await collection.updateOne(
              guard,
              [
                {
                  $set: {
                    state: 'unknown',
                    claim: null,
                    'execution.phase': 'unknown',
                    lastCode: 'submission_unknown',
                    updatedAt: '$$NOW',
                    fence: { $add: ['$fence', 1] },
                    progressRevision: { $add: ['$progressRevision', 1] },
                  },
                },
              ],
              { ...remaining(), writeConcern: majority },
            );
            continue;
          }
          const row = await collection.findOneAndUpdate(
            guard,
            [
              {
                $set: {
                  state: 'claimed',
                  fence: { $add: ['$fence', 1] },
                  attempts: { $add: ['$attempts', 1] },
                  claim: {
                    worker: { $literal: worker },
                    claimId: randomUUID(),
                    leaseUntil: { $add: ['$$NOW', HOUSEKEEPING_STORE_POLICY.leaseMs] },
                  },
                  recoveries: { $add: ['$recoveries', takeover ? 1 : 0] },
                  lastRecoveryAt: takeover ? '$$NOW' : '$lastRecoveryAt',
                  lastCode: 'claimed',
                  updatedAt: '$$NOW',
                },
              },
            ],
            {
              ...remaining(),
              writeConcern: majority,
              returnDocument: 'after',
              includeResultMetadata: false,
            },
          );
          if (row) return claimView(row as HousekeepingJobRecord);
        }
      }
      return null;
    },
    async renew(token) {
      const row = await collection.findOneAndUpdate(
        ownershipFilter(token),
        [
          {
            $set: {
              'claim.leaseUntil': { $add: ['$$NOW', HOUSEKEEPING_STORE_POLICY.leaseMs] },
              updatedAt: '$$NOW',
            },
          },
        ],
        {
          ...standalone,
          writeConcern: majority,
          returnDocument: 'after',
          includeResultMetadata: false,
        },
      );
      return row ? claimView(row as HousekeepingJobRecord) : null;
    },
    async observe(jobId, executionId) {
      if (!text(jobId, 64) || !text(executionId, 64)) throw Error('HOUSEKEEPING_INVALID');
      return (await collection.findOne(
        { _id: jobId, 'execution.id': executionId },
        {
          ...standalone,
          readConcern: { level: 'majority' },
        },
      )) as HousekeepingJobRecord | null;
    },
    async advance(claim, expected, change, session) {
      requireTransaction(session);
      assertWork(claim.work);
      if (
        !integer(expected.revision) ||
        expected.revision === MAX ||
        !PHASES[claim.work.handler].includes(expected.phase) ||
        !PHASES[claim.work.handler].includes(change.phase) ||
        !CODES.includes(change.code) ||
        (change.receiptRef != null && !text(change.receiptRef))
      )
        throw Error('HOUSEKEEPING_INVALID');
      const state = change.state ?? 'claimed';
      if (!['claimed', 'waiting', 'unknown', 'settled', 'superseded', 'missed'].includes(state))
        throw Error('HOUSEKEEPING_INVALID');
      if (!allowedTransition(claim.work.handler, expected.phase, change.phase))
        throw Error('HOUSEKEEPING_INVALID_TRANSITION');
      if (['armed', 'unknown'].includes(change.phase) && !['claimed', 'unknown'].includes(state))
        throw Error('HOUSEKEEPING_INVALID_TRANSITION');
      if (change.phase === 'unknown' && state !== 'unknown')
        throw Error('HOUSEKEEPING_INVALID_TRANSITION');
      if (['settled', 'missed'].includes(state) && !change.receiptRef)
        throw Error('HOUSEKEEPING_RECEIPT_REQUIRED');
      if (state === 'settled' && !['accepted', 'complete'].includes(change.phase))
        throw Error('HOUSEKEEPING_INVALID');
      const terminal = ['settled', 'missed', 'superseded'].includes(state);
      const result = await collection.updateOne(
        {
          ...ownershipFilter(claim),
          handler: claim.work.handler,
          work: claim.work,
          'execution.id': claim.executionId,
          'execution.phase': expected.phase,
          progressRevision: expected.revision,
        },
        [
          {
            $set: {
              state,
              'execution.phase': change.phase,
              'execution.receiptRef':
                change.receiptRef === undefined
                  ? '$execution.receiptRef'
                  : { $literal: change.receiptRef },
              lastCode: change.code,
              progressRevision: { $add: ['$progressRevision', 1] },
              updatedAt: '$$NOW',
              claim: state === 'claimed' ? '$claim' : null,
              terminalAt: terminal ? '$$NOW' : null,
            },
          },
        ],
        { ...query, session },
      );
      return result.modifiedCount === 1;
    },
    async release(claim, unstarted, code) {
      if (!CODES.includes(code)) throw Error('HOUSEKEEPING_INVALID');
      const observed = await this.observe(claim.jobId, claim.executionId);
      if (!observed || observed.state !== 'claimed' || observed.progressRevision === MAX)
        return false;
      const phase = observed.execution.phase;
      if (
        (unstarted && phase !== PHASES[observed.handler][0]) ||
        (observed.handler === 'file.warning' &&
          !['scheduled', 'prepared', 'not_accepted'].includes(phase))
      )
        return false;
      const delay = unstarted
        ? 0
        : Math.min(300000, 1000 * 2 ** Math.min(observed.attempts, 8)) + randomInt(1000);
      const result = await collection.updateOne(
        {
          ...ownershipFilter(claim),
          work: claim.work,
          'execution.id': claim.executionId,
          'execution.phase': phase,
          progressRevision: observed.progressRevision,
        },
        [
          {
            $set: {
              state: 'waiting',
              claim: null,
              retryNotBefore: unstarted ? null : { $add: ['$$NOW', delay] },
              nextAttemptAt: { $max: ['$dueAt', { $add: ['$$NOW', delay] }] },
              progressRevision: { $add: ['$progressRevision', 1] },
              lastCode: code,
              updatedAt: '$$NOW',
            },
          },
        ],
        { ...standalone, writeConcern: majority },
      );
      return result.modifiedCount === 1;
    },
    async pruneTerminal(limit, authorize) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw Error('HOUSEKEEPING_INVALID');
      const deadline = performance.now() + HOUSEKEEPING_STORE_POLICY.queryMs;
      const rows = await collection
        .find(
          {
            state: { $in: ['settled', 'superseded', 'missed'] },
            'execution.phase': { $nin: ['armed', 'unknown'] },
          },
          { ...standalone, hint: HOUSEKEEPING_INDEXES.terminal, projection: { _id: 1 } },
        )
        .sort({ terminalAt: 1, _id: 1 })
        .limit(limit)
        .toArray();
      let retired = 0;
      for (const candidate of rows) {
        const timeoutMS = Math.floor(deadline - performance.now());
        if (timeoutMS < 1) break;
        const session = await mongoose.startSession();
        try {
          const deleted = await session.withTransaction(
            async () => {
              const row = await collection.findOne(
                {
                  _id: candidate._id,
                  state: { $in: ['settled', 'superseded', 'missed'] },
                  'execution.phase': { $nin: ['armed', 'unknown'] },
                },
                { ...query, session },
              );
              // The domain owner must touch its authority and prove permanent ineligibility,
              // settled effects and consumed references in this SAME transaction.
              if (!row || !(await authorize(row as HousekeepingJobRecord, session))) return 0;
              return (
                await collection.deleteOne(
                  {
                    _id: row._id,
                    fence: row.fence,
                    progressRevision: row.progressRevision,
                    state: row.state,
                  },
                  { ...query, session },
                )
              ).deletedCount;
            },
            {
              readConcern: { level: 'snapshot' },
              writeConcern: majority,
              maxCommitTimeMS: 3000,
              timeoutMS,
            },
          );
          retired += deleted ?? 0;
        } finally {
          await session.endSession();
        }
      }
      return retired;
    },
  };
}
