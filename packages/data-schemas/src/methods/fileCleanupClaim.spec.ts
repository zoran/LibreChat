/** Real owner composition. Run only against frozen File/HK producers; no replacement revocation port. */
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { JobClaim } from '../types/housekeeping';
import type { IMongoFile } from '../types/file';
import {
  initialFileRetentionActivity,
  advanceFileRetentionActivity,
} from './fileActivityTransition';
import { tenantStorage, SYSTEM_TENANT_ID } from '../config/tenantContext';
import { projectFileHousekeeping } from './fileHousekeepingProjection';
import { createFileCleanupClaimMethods } from './fileCleanupClaim';
import { createHousekeepingStore } from './housekeepingStore';
import { createFileRetentionMethods } from './fileRetention';
import { createFileModel } from '../models/file';

const DAY = 86400000;
const db = new mongoose.Mongoose();
const worker = { podUid: 'pod-a', incarnation: 'one', source: 'candidate', hostId: 'cpu2' };
const owner = { tenantId: 'tenant-a', userId: new mongoose.Types.ObjectId().toString() };
const fileId = 'cleanup-claim-original';
let mongo: MongoMemoryReplSet;
let store: ReturnType<typeof createHousekeepingStore>;
let lifecycle: ReturnType<typeof createFileRetentionMethods>;
let methods: ReturnType<typeof createFileCleanupClaimMethods>;
const system = <T>(fn: () => Promise<T>) => tenantStorage.run({ tenantId: SYSTEM_TENANT_ID }, fn);
const signal = () => new AbortController().signal;
async function tx<T>(fn: (session: mongoose.ClientSession) => Promise<T>) {
  const session = await db.startSession();
  try {
    return await session.withTransaction(() => fn(session), { writeConcern: { w: 'majority' } });
  } finally {
    await session.endSession();
  }
}
async function rawFile(): Promise<IMongoFile | null> {
  return system(() =>
    db.models.File.findOne({ file_id: fileId })
      .select('+retentionActivity +derivedRetention +derivedOrigin +retentionRevocationId')
      .lean<IMongoFile>(),
  );
}
async function fixture(remaining = -1000): Promise<void> {
  await system(async () => {
    const expiry = new Date(Date.now() + remaining);
    const accepted = new Date(expiry.getTime() - 28 * DAY);
    await tx(async (session) => {
      const [file] = await db.models.File.create(
        [
          {
            user: owner.userId,
            tenantId: owner.tenantId,
            file_id: fileId,
            uploadOperationId: fileId,
            filename: 'Private file.pdf',
            filepath: '/original',
            bytes: 8,
            type: 'application/pdf',
            source: 's3',
            status: 'pending',
            embedded: false,
            retentionAcceptedAt: accepted,
            expiredAt: expiry,
            retentionRevision: 0,
            retainedDerivativeBytes: 0,
            retentionActivity: initialFileRetentionActivity(expiry, accepted, 'complete'),
          },
        ],
        { session },
      );
      await projectFileHousekeeping(
        db,
        null,
        file.toObject({ transform: false }) as IMongoFile,
        session,
      );
    });
  });
}
async function claim(): Promise<JobClaim> {
  const result = await store.claimNext('file.cleanup', worker);
  expect(result).not.toBeNull();
  return result!;
}
const observed = (value: JobClaim) => store.observe(value.jobId, value.executionId);
const enter = (value: JobClaim, abort = signal()) => system(() => methods.enter(value, abort));
async function expiredClaim() {
  await fixture();
  return claim();
}
async function revokedClaim() {
  const first = await expiredClaim();
  expect(await enter(first)).toEqual({ state: 'lost' });
  return claim();
}
async function change(update: object) {
  await system(() => db.models.File.updateOne({ file_id: fileId }, update));
}
function loseCommittedReply() {
  const start = db.startSession.bind(db);
  jest.spyOn(db, 'startSession').mockImplementationOnce(async () => {
    const session = await start();
    const run = session.withTransaction.bind(session);
    session.withTransaction = (async (...args: Parameters<typeof run>) => {
      await run(...args);
      throw new Error('synthetic lost committed reply');
    }) as typeof session.withTransaction;
    return session;
  });
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await db.connect(mongo.getUri('file_cleanup_claim'));
  createFileModel(db);
  store = createHousekeepingStore(db);
  await Promise.all([db.models.File.init(), store.initialize()]);
  lifecycle = createFileRetentionMethods(db);
  methods = createFileCleanupClaimMethods(db, store, lifecycle);
});
beforeEach(async () => {
  await system(() => Promise.all([db.models.File.deleteMany({}), store.model.deleteMany({})]));
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await db.disconnect();
  await mongo?.stop();
});

test('expiry revokes through the actual producer, fences old claim and reacquires the same execution', async () => {
  const first = await expiredClaim();
  const before = (await rawFile())!;
  expect(await enter(first)).toEqual({ state: 'lost' });
  const revoked = (await rawFile())!;
  const handoff = (await observed(first))!;
  expect(revoked.retentionRevocationId).toMatch(/^[a-f0-9-]{36}$/);
  expect(handoff).toMatchObject({
    state: 'queued',
    claim: null,
    work: { revocationId: revoked.retentionRevocationId },
    execution: { id: first.executionId, phase: 'awaiting_deadline', receiptRef: null },
  });
  expect(handoff.fence).toBeGreaterThan(first.fence);
  expect(await enter(first)).toEqual({ state: 'lost' });
  const next = await claim();
  expect(next.jobId).toBe(first.jobId);
  expect(next.executionId).toBe(first.executionId);
  expect(await enter(next)).toEqual({ state: 'progress', receiptRef: null });
  const final = (await rawFile())!;
  expect(final.retentionRevocationId).toBe(revoked.retentionRevocationId);
  expect(final.expiredAt).toEqual(before.expiredAt);
  expect(final.retentionActivity).toEqual(before.retentionActivity);
  expect(final.deletionCompletedAt).toBeUndefined();
  expect((await observed(next))!.execution).toMatchObject({ phase: 'revoked', receiptRef: null });
});

test('manual revocation before expiry enters with its existing UUID, without an active User dependency', async () => {
  await fixture(DAY);
  await system(() => lifecycle.revokeFileSources(owner, [fileId]));
  const uuid = (await rawFile())!.retentionRevocationId;
  const value = await claim();
  expect(await enter(value)).toEqual({ state: 'progress', receiptRef: null });
  expect((await rawFile())!.retentionRevocationId).toBe(uuid);
  expect((await rawFile())!.deletionCompletedAt).toBeUndefined();
});

test('repeated entry and heartbeat use fresh progress without rewriting an existing revocation', async () => {
  const value = await revokedClaim();
  expect(await enter(value)).toEqual({ state: 'progress', receiptRef: null });
  const first = (await observed(value))!;
  const file = (await rawFile())!;
  expect(await store.renew(value)).not.toBeNull();
  expect(await enter(value)).toEqual({ state: 'progress', receiptRef: null });
  expect((await observed(value))!.progressRevision).toBe(first.progressRevision);
  expect((await rawFile())!.retentionRevision).toBe(file.retentionRevision);
});

test('takeover retains UUID and execution; the old ownership cannot advance progress', async () => {
  const first = await revokedClaim();
  await store.model.updateOne({ _id: first.jobId }, { $set: { 'claim.leaseUntil': new Date(0) } });
  const next = await store.claimNext('file.cleanup', { ...worker, incarnation: 'replacement' });
  expect(next).not.toBeNull();
  expect(next!.executionId).toBe(first.executionId);
  expect(next!.work).toEqual(first.work);
  expect(await enter(first)).toEqual({ state: 'lost' });
  expect(await enter(next!)).toEqual({ state: 'progress', receiptRef: null });
});

test('an expired claim and an already aborted entry make no File mutation', async () => {
  const value = await expiredClaim();
  const before = await rawFile();
  const controller = new AbortController();
  controller.abort();
  expect(await enter(value, controller.signal)).toEqual({
    state: 'pending',
    code: 'owner_pending',
  });
  await store.model.updateOne({ _id: value.jobId }, { $set: { 'claim.leaseUntil': new Date(0) } });
  expect(await enter(value)).toEqual({ state: 'lost' });
  expect(await rawFile()).toEqual(before);
});

test.each(['revocation', 'phase'] as const)(
  'lost actual committed %s reply stays unknown and preserves original progress',
  async (stage) => {
    const value = stage === 'revocation' ? await expiredClaim() : await revokedClaim();
    loseCommittedReply();
    expect(await enter(value)).toEqual({ state: 'unknown' });
    const row = (await observed(value))!;
    expect(row.execution.id).toBe(value.executionId);
    expect(row.execution.phase).toBe(stage === 'revocation' ? 'awaiting_deadline' : 'revoked');
    expect((await rawFile())!.retentionRevocationId).toBeTruthy();
    expect((await rawFile())!.deletionCompletedAt).toBeUndefined();
    expect(await enter(stage === 'revocation' ? await claim() : value)).toEqual({
      state: 'progress',
      receiptRef: null,
    });
  },
);

test.each([
  { 'retentionActivity.migrationEpoch': 'export-a' },
  { 'retentionActivity.deadlineGeneration': 1 },
  { uploadOperationId: 'another-operation' },
  { retentionRevision: Number.MAX_SAFE_INTEGER },
  { deletionCompletedAt: new Date() },
])('actual File authority refuses unsafe expiry entry: %j', async (update) => {
  const value = await expiredClaim();
  await change({ $set: update });
  expect(await enter(value)).toEqual({ state: 'retry', code: 'owner_pending' });
  expect((await rawFile())!.retentionRevocationId).toBeUndefined();
  expect((await observed(value))!.execution.phase).toBe('awaiting_deadline');
});

test('missing File metadata and mismatched persisted UUID are not completion proof', async () => {
  const value = await revokedClaim();
  await change({ $set: { retentionRevocationId: '11111111-1111-4111-8111-111111111111' } });
  expect(await enter(value)).toEqual({ state: 'retry', code: 'owner_pending' });
  await system(() => db.models.File.deleteOne({ file_id: fileId }));
  expect(await enter(value)).toEqual({ state: 'retry', code: 'owner_pending' });
  expect((await observed(value))!.execution.phase).toBe('awaiting_deadline');
});

test('a due queue record cannot override a current future File deadline', async () => {
  await fixture(DAY);
  await store.model.updateMany(
    { handler: 'file.cleanup' },
    {
      $set: {
        dueAt: new Date(0),
        nextAttemptAt: new Date(0),
      },
    },
  );
  const value = await claim();
  expect(await enter(value)).toEqual({ state: 'retry', code: 'owner_pending' });
  expect((await rawFile())!.retentionRevocationId).toBeUndefined();
});

test('actual activity transition/projection fences previously claimed scheduling before cleanup', async () => {
  await fixture(DAY);
  await store.model.updateMany(
    { handler: 'file.cleanup' },
    {
      $set: {
        dueAt: new Date(0),
        nextAttemptAt: new Date(0),
      },
    },
  );
  const value = await claim();
  await system(() =>
    tx(async (session) => {
      const before = await db.models.File.findOne({ file_id: fileId })
        .select('+retentionActivity')
        .session(session)
        .lean<IMongoFile>();
      const now = Date.now();
      const transition = advanceFileRetentionActivity(
        before!.retentionActivity,
        before!.expiredAt,
        'read',
        now,
        now,
      );
      const next = {
        ...before!,
        expiredAt: transition.expiredAt,
        retentionActivity: transition.activity,
        retentionRevision: before!.retentionRevision! + 1,
      };
      await db.models.File.updateOne(
        { _id: before!._id, retentionRevision: before!.retentionRevision },
        {
          $set: {
            expiredAt: next.expiredAt,
            retentionActivity: next.retentionActivity,
            retentionRevision: next.retentionRevision,
          },
        },
        { session, timestamps: false },
      );
      await projectFileHousekeeping(db, before!, next, session);
    }),
  );
  expect(await enter(value)).toEqual({ state: 'lost' });
  expect((await observed(value))!.state).toBe('superseded');
  expect((await rawFile())!.retentionRevocationId).toBeUndefined();
});

test('exact tenant/work/handler guards reject caller-forged ownership views', async () => {
  const value = await expiredClaim();
  if (value.work.handler !== 'file.cleanup') throw new Error('wrong fixture');
  expect(
    await enter({
      ...value,
      work: { ...value.work, subject: { ...value.work.subject, tenantId: 'foreign-tenant' } },
    }),
  ).toEqual({ state: 'lost' });
  await expect(
    enter({
      ...value,
      work: {
        handler: 'file.warning',
        subject: value.work.subject,
        deadlineGeneration: 0,
        offsetDays: 7,
      },
    }),
  ).rejects.toThrow('FILE_CLEANUP_CLAIM_HANDLER');
  expect((await rawFile())!.retentionRevocationId).toBeUndefined();
});
