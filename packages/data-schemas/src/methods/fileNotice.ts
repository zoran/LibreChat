/** File-owned warning preparation/arming/outcome transactions; the worker never owns recipient authority. */
import { randomUUID } from 'node:crypto';
import type { ClientSession, Model, mongo } from 'mongoose';
import type {
  FileNoticePort,
  JobClaim,
  NoticePreparation,
  CommitOutcome,
} from '../types/housekeeping';
import type { NoticeBinding, NoticeDeliveryOutcome, NoticeJob } from './fileNoticeBinding';
import type { HousekeepingStore, ProgressChange } from './housekeepingStore';
import type { FileActivitySnapshotBatch } from '../types/fileActivity';
import type { IMongoFile } from '../types/file';
import {
  noticeDigest,
  noticeOwnershipDigest,
  recipientDigest,
  snapshotDigest,
  validNoticeBinding,
  captureNoticeOutcome,
} from './fileNoticeBinding';
import { touchActiveUserPrincipal, UserPrincipalUnavailableError } from './userPrincipal';
import { currentFileDeadline, managedFileScope } from './fileSourceAuthority';
import { projectFileActivitySnapshot } from './fileActivitySnapshot';
import { ownershipFilter } from './housekeepingStore';

const QUERY_MS = 1000;
const TRANSACTION_MS = 5000;
// The accepted sender's whole-call budget is 20 seconds; reserve one bounded owner settlement.
const REQUIRED_REMAINING_MS = 20000 + TRANSACTION_MS;
const DAY_MS = 86400000;
class NoticeLost extends Error {}
class NoticeUnavailable extends Error {}
interface NoticeUser {
  email: string;
  emailChangedAt?: Date;
  emailVerified: boolean;
}
interface CurrentNotice {
  snapshot: FileActivitySnapshotBatch;
  file: IMongoFile;
  user: NoticeUser;
  now: Date;
}
export interface FileNoticeOptions {
  allowedDomains: readonly string[];
  timezone: string;
}

/** Construct at the database owner. The returned public port contains only plain application DTOs. */
export function createFileNoticePort<TOutcome extends NoticeDeliveryOutcome>(
  mongoose: typeof import('mongoose'),
  store: HousekeepingStore,
  options: FileNoticeOptions,
): FileNoticePort<TOutcome> {
  if (
    store.model !== mongoose.models.HousekeepingJob ||
    !mongoose.models.File ||
    !mongoose.models.User ||
    !options.allowedDomains.length ||
    options.allowedDomains.some((domain) => !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(domain))
  )
    throw new Error('FILE_NOTICE_CONFIGURATION');
  new Intl.DateTimeFormat('de', { timeZone: options.timezone }).format(0);
  const domains = Object.freeze([...new Set(options.allowedDomains)]);
  const timezone = options.timezone;
  const File = mongoose.models.File as Model<IMongoFile>;
  const collection = store.model.collection as unknown as mongo.Collection<NoticeJob>;

  async function transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await mongoose.startSession();
    try {
      return (await session.withTransaction(() => work(session), {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority', wtimeout: TRANSACTION_MS },
        maxCommitTimeMS: QUERY_MS,
        timeoutMS: TRANSACTION_MS,
      })) as T;
    } finally {
      await session.endSession();
    }
  }
  function warning(claim: JobClaim) {
    if (claim.work.handler !== 'file.warning') throw new Error('FILE_NOTICE_HANDLER');
    return claim.work;
  }
  async function job(
    claim: JobClaim,
    session: ClientSession,
  ): Promise<NoticeJob & { noticeNow: Date }> {
    warning(claim);
    const row = (await collection
      .aggregate(
        [
          {
            $match: {
              ...ownershipFilter(claim),
              handler: 'file.warning',
              work: claim.work,
              'execution.id': claim.executionId,
            },
          },
          { $addFields: { noticeNow: '$$NOW' } },
        ],
        { session, maxTimeMS: QUERY_MS },
      )
      .next()) as (NoticeJob & { noticeNow: Date }) | null;
    if (!row) throw new NoticeLost();
    return row;
  }
  async function advance(
    claim: JobClaim,
    row: NoticeJob,
    change: ProgressChange,
    binding: NoticeBinding | undefined,
    session: ClientSession,
  ) {
    if (
      !(await store.advance(
        claim,
        {
          revision: row.progressRevision,
          phase: row.execution.phase,
        },
        change,
        session,
      ))
    )
      throw new NoticeLost();
    if (binding) {
      const result = await collection.updateOne(
        {
          _id: row._id,
          'execution.id': claim.executionId,
          'execution.phase': change.phase,
          progressRevision: row.progressRevision + 1,
        },
        { $set: { 'execution.notice': binding } },
        { session, maxTimeMS: QUERY_MS },
      );
      if (result.matchedCount !== 1) throw new NoticeLost();
    }
    row.progressRevision++;
    row.execution.phase = change.phase;
    row.state = change.state ?? 'claimed';
    if (binding) row.execution.notice = binding;
  }
  function owner(claim: JobClaim) {
    return { userId: claim.work.subject.ownerUserId, tenantId: claim.work.subject.tenantId };
  }
  async function current(
    claim: JobClaim,
    session: ClientSession,
    now: Date,
    asOf?: Date,
  ): Promise<CurrentNotice | 'missed' | 'superseded' | 'not_due' | 'insufficient_send_budget'> {
    const work = warning(claim);
    const scope = managedFileScope(owner(claim));
    // Metadata reminders do not require ready/embedded content and never acquire a read capability.
    const file = await File.findOne({ ...scope, file_id: work.subject.fileId })
      .select(
        'user tenantId file_id filename retentionAcceptedAt expiredAt retentionRevision deletionRequestedAt deletionCompletedAt +retentionActivity +derivedRetention +derivedOrigin +retentionRevocationId',
      )
      .session(session)
      .maxTimeMS(QUERY_MS)
      .lean<IMongoFile>();
    if (
      !file ||
      file.deletionRequestedAt != null ||
      file.deletionCompletedAt != null ||
      file.retentionRevocationId != null
    )
      return 'superseded';
    if (!file.expiredAt) throw new NoticeUnavailable();
    const remaining = file.expiredAt.getTime() - now.getTime();
    if (remaining <= 0) return 'missed';
    let deadline: ReturnType<typeof currentFileDeadline>;
    try {
      deadline = currentFileDeadline(file);
    } catch {
      throw new NoticeUnavailable();
    }
    if (deadline.migrationEpoch !== null) throw new NoticeUnavailable();
    let snapshot: FileActivitySnapshotBatch;
    try {
      snapshot = {
        asOf: (asOf ?? now).toISOString(),
        files: [projectFileActivitySnapshot(file, asOf ?? now)],
      };
    } catch {
      throw new NoticeUnavailable();
    }
    if (snapshot.files[0].deadlineGeneration !== work.deadlineGeneration) return 'superseded';
    if (remaining > work.offsetDays * DAY_MS) return 'not_due';
    if (work.offsetDays === 7 && remaining <= DAY_MS) return 'missed';
    if (remaining <= REQUIRED_REMAINING_MS) return 'insufficient_send_budget';
    await touchActiveUserPrincipal(mongoose, owner(claim), session);
    const user = await mongoose.models.User.findOne({
      _id: work.subject.ownerUserId,
      tenantId: work.subject.tenantId,
      emailVerified: true,
      authDisabled: { $ne: true },
      agentTriggerDeletionStartedAt: { $exists: false },
    })
      .select('email emailVerified emailChangedAt')
      .session(session)
      .maxTimeMS(QUERY_MS)
      .lean<NoticeUser>();
    if (
      !user ||
      typeof user.email !== 'string' ||
      user.email !== user.email.toLowerCase() ||
      !/^[^\s<>@]+@[^\s<>@]+$/.test(user.email) ||
      !domains.includes(user.email.slice(user.email.lastIndexOf('@') + 1))
    )
      throw new NoticeUnavailable();
    const emailTouch = await mongoose.models.User.updateOne(
      {
        _id: work.subject.ownerUserId,
        tenantId: work.subject.tenantId,
        email: user.email,
        emailVerified: true,
        emailChangedAt: user.emailChangedAt ?? { $exists: false },
        authDisabled: { $ne: true },
        agentTriggerDeletionStartedAt: { $exists: false },
      },
      { $inc: { __v: 1 } },
      { session, timestamps: false, upsert: false, maxTimeMS: QUERY_MS },
    );
    if (!emailTouch.acknowledged || emailTouch.matchedCount !== 1) throw new NoticeUnavailable();
    const touched = await File.updateOne(
      {
        ...scope,
        file_id: work.subject.fileId,
        retentionRevision: file.retentionRevision,
        expiredAt: file.expiredAt,
        deletionRequestedAt: null,
        deletionCompletedAt: null,
        retentionRevocationId: { $exists: false },
        [`${deadline.kind === 'original' ? 'retentionActivity' : 'derivedRetention'}.deadlineGeneration`]:
          work.deadlineGeneration,
        [`${deadline.kind === 'original' ? 'retentionActivity' : 'derivedRetention'}.migrationEpoch`]:
          { $exists: false },
        $expr: {
          $and: [
            { $gt: ['$expiredAt', { $add: ['$$NOW', REQUIRED_REMAINING_MS] }] },
            { $lte: ['$expiredAt', { $add: ['$$NOW', work.offsetDays * DAY_MS] }] },
            ...(work.offsetDays === 7
              ? [{ $gt: ['$expiredAt', { $add: ['$$NOW', DAY_MS] }] }]
              : []),
          ],
        },
      },
      { $inc: { retentionRevision: 1 } },
      { session, timestamps: false, upsert: false, maxTimeMS: QUERY_MS },
    );
    if (!touched.acknowledged || touched.matchedCount !== 1) throw new NoticeUnavailable();
    return { snapshot, file, user, now };
  }
  async function prepare(claim: JobClaim): Promise<NoticePreparation> {
    warning(claim);
    try {
      return await transaction(async (session): Promise<NoticePreparation> => {
        const row = await job(claim, session);
        if (['armed', 'unknown'].includes(row.execution.phase))
          return { state: 'no_send', reason: 'submission_unknown' };
        if (!['scheduled', 'prepared', 'not_accepted'].includes(row.execution.phase))
          return { state: 'no_send', reason: 'lost' };
        const observed = await current(claim, session, row.noticeNow);
        if (typeof observed === 'string') {
          if (observed === 'missed' || observed === 'superseded') {
            const receiptRef = noticeDigest([claim.jobId, claim.executionId, observed]);
            await advance(
              claim,
              row,
              {
                phase: observed,
                state: observed,
                code: observed,
                receiptRef,
              },
              undefined,
              session,
            );
          }
          return { state: 'no_send', reason: observed };
        }
        const work = warning(claim);
        const binding: NoticeBinding = {
          version: 1,
          snapshotToken: noticeDigest([claim.executionId, randomUUID()]),
          snapshotDigest: snapshotDigest(observed.snapshot, claim),
          recipientDigest: recipientDigest(observed.user, claim),
          preparedAt: observed.now,
          submissionId: claim.executionId,
        };
        await advance(claim, row, { phase: 'prepared', code: 'progress' }, binding, session);
        return {
          state: 'prepared',
          submissionId: binding.submissionId,
          snapshotToken: binding.snapshotToken,
          recipient: observed.user.email,
          offsetDays: work.offsetDays,
          timezone,
          late:
            observed.now.getTime() > observed.file.expiredAt!.getTime() - work.offsetDays * DAY_MS,
          snapshot: observed.snapshot,
        };
      });
    } catch (error) {
      if (error instanceof NoticeLost) return { state: 'no_send', reason: 'lost' };
      if (error instanceof NoticeUnavailable || error instanceof UserPrincipalUnavailableError)
        return { state: 'no_send', reason: 'owner_unavailable' };
      return { state: 'unknown' };
    }
  }
  async function authorizeHandoff(
    claim: JobClaim,
    token: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    warning(claim);
    if (signal.aborted) return false;
    try {
      const authorized = await transaction(async (session) => {
        if (signal.aborted) return false;
        const row = await job(claim, session);
        const binding = row.execution.notice;
        if (
          !['prepared', 'armed'].includes(row.execution.phase) ||
          !validNoticeBinding(binding) ||
          binding.snapshotToken !== token ||
          binding.submissionId !== claim.executionId ||
          (row.execution.phase === 'armed' && binding.armedBy !== noticeOwnershipDigest(claim))
        )
          return false;
        const observed = await current(claim, session, row.noticeNow, binding.preparedAt);
        if (
          typeof observed === 'string' ||
          signal.aborted ||
          snapshotDigest(observed.snapshot, claim) !== binding.snapshotDigest ||
          recipientDigest(observed.user, claim) !== binding.recipientDigest
        )
          return false;
        await advance(
          claim,
          row,
          { phase: 'armed', code: 'progress' },
          {
            ...binding,
            armedBy: noticeOwnershipDigest(claim),
          },
          session,
        );
        if (signal.aborted) throw new NoticeUnavailable();
        return true;
      });
      return authorized && !signal.aborted;
    } catch {
      return false;
    } // An unknown arm commit grants no external submission authority.
  }
  async function recordOutcome(
    claim: JobClaim,
    token: string,
    raw: TOutcome,
  ): Promise<CommitOutcome> {
    warning(claim);
    const outcome = captureNoticeOutcome(raw);
    const digest = noticeDigest([token, outcome]);
    try {
      return await transaction(async (session): Promise<CommitOutcome> => {
        const row = await job(claim, session);
        const binding = row.execution.notice;
        if (
          !validNoticeBinding(binding) ||
          binding.snapshotToken !== token ||
          binding.submissionId !== claim.executionId
        )
          throw new NoticeLost();
        if (!['prepared', 'armed'].includes(row.execution.phase)) throw new NoticeLost();
        if (
          outcome.state === 'accepted' &&
          (row.execution.phase !== 'armed' || binding.armedBy !== noticeOwnershipDigest(claim))
        )
          throw new NoticeLost();
        // An unexpectedly rejected sender call can be ambiguous even before recorded arming.
        // Poison that same execution conservatively; this transition never authorizes SMTP.
        if (outcome.state === 'unknown' && row.execution.phase === 'prepared')
          await advance(
            claim,
            row,
            { phase: 'armed', code: 'submission_unknown' },
            binding,
            session,
          );
        const receiptRef = noticeDigest([claim.jobId, claim.executionId, digest]);
        const recorded: NoticeBinding = { ...binding, outcome, outcomeDigest: digest };
        if (outcome.state === 'accepted') {
          await advance(
            claim,
            row,
            { phase: 'accepted', state: 'settled', code: 'settled', receiptRef },
            recorded,
            session,
          );
          return { state: 'settled', receiptRef };
        }
        if (outcome.state === 'unknown') {
          await advance(
            claim,
            row,
            { phase: 'unknown', state: 'unknown', code: 'submission_unknown', receiptRef },
            recorded,
            session,
          );
          return { state: 'pending', code: 'external_pending' };
        }
        await advance(
          claim,
          row,
          { phase: 'not_accepted', code: 'not_accepted', receiptRef },
          recorded,
          session,
        );
        return {
          state: 'retry',
          code: outcome.reason === 'unavailable' ? 'not_accepted' : 'owner_pending',
        };
      });
    } catch (error) {
      if (error instanceof NoticeLost) return { state: 'lost' };
      return { state: 'unknown' };
    }
  }
  return { prepare, authorizeHandoff, recordOutcome };
}
