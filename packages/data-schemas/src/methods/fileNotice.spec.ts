/** Real Mongo owner transactions and actual File/User/job schemas; SMTP effects stay outside this suite. */
import mongoose from 'mongoose';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { rootCertificates } from 'node:tls';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Socket } from 'node:net';
import type { HousekeepingJobRecord } from '../models/housekeepingJob';
import type { MailMessage } from '../../../api/src/mail/submission';
import type { JobClaim } from '../types/housekeeping';
import type { IMongoFile } from '../types/file';
import { createBoundedRetentionMailSender } from '../../../api/src/files/retentionMailSender';
import { createHousekeepingHandlers } from '../../../api/src/housekeeping/handlers';
import { tenantStorage, SYSTEM_TENANT_ID } from '../config/tenantContext';
import { initialFileRetentionActivity } from './fileActivityTransition';
import { createHousekeepingStore } from './housekeepingStore';
import { createFileNoticePort } from './fileNotice';
import { createFileModel } from '../models/file';
import { createUserModel } from '../models/user';

const DAY = 86400000;
const db = new mongoose.Mongoose();
const worker = { podUid: 'pod-a', incarnation: 'first', source: 'candidate', hostId: 'cpu2' };
const scope = {
  tenantId: 'tenant-a',
  ownerUserId: new mongoose.Types.ObjectId().toString(),
  fileId: 'notice-original',
};
let mongo: MongoMemoryReplSet;
let store: ReturnType<typeof createHousekeepingStore>;
let port: ReturnType<typeof createFileNoticePort>;
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
async function fixture(remaining = 6 * DAY, offsetDays: 7 | 1 = 7): Promise<JobClaim> {
  return system(async () => {
    const at = Date.now();
    const expiry = new Date(at + remaining);
    await db.models.User.create({
      _id: scope.ownerUserId,
      tenantId: scope.tenantId,
      email: 'notice@bwi.de',
      emailVerified: true,
    });
    await db.models.File.create({
      user: scope.ownerUserId,
      tenantId: scope.tenantId,
      file_id: scope.fileId,
      bytes: 8,
      filename: 'Private filename <&>.pdf',
      filepath: '/private-original',
      type: 'application/pdf',
      source: 's3',
      status: 'pending',
      embedded: false,
      retentionAcceptedAt: new Date(at - 22 * DAY),
      expiredAt: expiry,
      retentionRevision: 0,
      retentionActivity: initialFileRetentionActivity(expiry, new Date(at - 22 * DAY), 'complete'),
    });
    await tx((session) =>
      store.project(
        { handler: 'file.warning', subject: scope, deadlineGeneration: 0, offsetDays },
        new Date(at - 1000),
        session,
      ),
    );
    const claim = await store.claimNext('file.warning', worker);
    expect(claim).not.toBeNull();
    return claim!;
  });
}
async function prepared(claim: JobClaim) {
  const result = await system(() => port.prepare(claim));
  expect(result.state).toBe('prepared');
  if (result.state !== 'prepared') throw new Error('expected prepared');
  return result;
}
async function row(claim: JobClaim) {
  return await store.observe(claim.jobId, claim.executionId);
}
async function changeFile(update: object) {
  await system(() => db.models.File.updateOne({ file_id: scope.fileId }, update));
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
  await db.connect(mongo.getUri('retention_notice_owner'));
  createFileModel(db);
  createUserModel(db);
  store = createHousekeepingStore(db);
  await Promise.all([db.models.File.init(), db.models.User.init(), store.initialize()]);
  port = createFileNoticePort(db, store, { allowedDomains: ['bwi.de'], timezone: 'Europe/Berlin' });
});
beforeEach(async () => {
  await system(async () => {
    await Promise.all([
      db.models.User.deleteMany({}),
      db.models.File.deleteMany({}),
      store.model.deleteMany({}),
    ]);
  });
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  await db.disconnect();
  await mongo?.stop();
});

test('prepares processing metadata and retains only private digests, never full personal content', async () => {
  const claim = await fixture();
  const notice = await prepared(claim);
  expect(notice.snapshot.files[0]).toMatchObject({
    filename: 'Private filename <&>.pdf',
    readCount: { known: true, value: 0 },
    processingCount: { known: true, value: 0 },
    inactivity: { known: true, basis: 'upload' },
    deadlineGeneration: 0,
  });
  const stored = JSON.stringify(await row(claim));
  expect(stored).not.toContain('notice@bwi.de');
  expect(stored).not.toContain('Private filename');
  expect(stored).not.toContain('/private-original');
  expect(notice.submissionId).toBe(claim.executionId);
});

test('repeated authorization uses fresh progress after heartbeat and never changes retention or usage', async () => {
  const claim = await fixture();
  const notice = await prepared(claim);
  const before = await db
    .model<IMongoFile>('File')
    .findOne({ file_id: scope.fileId })
    .select('+retentionActivity')
    .lean();
  expect(await system(() => port.authorizeHandoff(claim, notice.snapshotToken, signal()))).toBe(
    true,
  );
  expect(await store.renew(claim)).not.toBeNull();
  expect(await system(() => port.authorizeHandoff(claim, notice.snapshotToken, signal()))).toBe(
    true,
  );
  const after = await db
    .model<IMongoFile>('File')
    .findOne({ file_id: scope.fileId })
    .select('+retentionActivity')
    .lean();
  if (before?.retentionRevision === undefined || after?.retentionRevision === undefined)
    throw new Error('Expected persisted File retention revisions before and after authorization');
  expect(after.expiredAt).toEqual(before.expiredAt);
  expect(after.retentionActivity).toEqual(before.retentionActivity);
  expect(after.retentionRevision).toBeGreaterThan(before.retentionRevision);
  expect((await row(claim))!.execution.phase).toBe('armed');
});

test.each([
  { email: 'changed@bwi.de', emailChangedAt: new Date() },
  { emailVerified: false },
  { authDisabled: true },
  { agentTriggerDeletionStartedAt: new Date() },
])('revalidates verified owner binding before handoff: %j', async (update) => {
  const claim = await fixture();
  const notice = await prepared(claim);
  await db.models.User.updateOne({ _id: scope.ownerUserId }, { $set: update });
  expect(await system(() => port.authorizeHandoff(claim, notice.snapshotToken, signal()))).toBe(
    false,
  );
  expect((await row(claim))!.execution.phase).toBe('prepared');
});

test('rejects foreign owner or tenant claims and unverified recipients without preparing', async () => {
  const claim = await fixture();
  const foreign = { ...claim, work: { ...claim.work, subject: { ...scope, tenantId: 'other' } } };
  expect(await system(() => port.prepare(foreign))).toEqual({ state: 'no_send', reason: 'lost' });
  await db.models.User.updateOne({ _id: scope.ownerUserId }, { $set: { emailVerified: false } });
  expect(await system(() => port.prepare(claim))).toEqual({
    state: 'no_send',
    reason: 'owner_unavailable',
  });
});

test('stale complete snapshot or a new deadline generation prevents submission', async () => {
  const claim = await fixture();
  const notice = await prepared(claim);
  await changeFile({ $set: { filename: 'Renamed.pdf' } });
  expect(await system(() => port.authorizeHandoff(claim, notice.snapshotToken, signal()))).toBe(
    false,
  );
  const next = await prepared(claim);
  await changeFile({
    $inc: { 'retentionActivity.readCount': 1, 'retentionActivity.deadlineGeneration': 1 },
    $set: { 'retentionActivity.lastSuccessfulReadAt': new Date() },
  });
  expect(await system(() => port.authorizeHandoff(claim, next.snapshotToken, signal()))).toBe(
    false,
  );
});

test.each([
  { deletionRequestedAt: new Date() },
  { expiredAt: new Date(Date.now() - 1) },
  { 'retentionActivity.migrationEpoch': 'export-a' },
])('does not arm revoked, expired or migrating File: %j', async (update) => {
  const claim = await fixture();
  const notice = await prepared(claim);
  await changeFile({ $set: update });
  expect(await system(() => port.authorizeHandoff(claim, notice.snapshotToken, signal()))).toBe(
    false,
  );
});

test('uses only the urgent current window and durably marks earlier or expired windows missed', async () => {
  const earlier = await fixture(DAY / 2, 7);
  expect(await system(() => port.prepare(earlier))).toEqual({ state: 'no_send', reason: 'missed' });
  expect((await row(earlier))!.state).toBe('missed');
  await tx((session) =>
    store.project(
      { handler: 'file.warning', subject: scope, deadlineGeneration: 0, offsetDays: 1 },
      new Date(Date.now() - 1000),
      session,
    ),
  );
  const urgent = (await store.claimNext('file.warning', worker))!;
  expect((await prepared(urgent)).offsetDays).toBe(1);
  await changeFile({ $set: { expiredAt: new Date(Date.now() - 1) } });
  expect(await system(() => port.prepare(urgent))).toEqual({ state: 'no_send', reason: 'missed' });
  expect((await row(urgent))!.state).toBe('missed');
});

test.each([
  [8 * DAY, 'not_due'],
  [10000, 'insufficient_send_budget'],
] as const)(
  'refuses out-of-window or insufficient remaining budget: %s',
  async (remaining, reason) => {
    const claim = await fixture(remaining, 1);
    expect(await system(() => port.prepare(claim))).toEqual({ state: 'no_send', reason });
    expect((await row(claim))!.execution.phase).toBe('scheduled');
  },
);

test('unknown arm acknowledgement denies SMTP and preserves original execution for reconciliation', async () => {
  const claim = await fixture();
  const notice = await prepared(claim);
  loseCommittedReply();
  expect(await system(() => port.authorizeHandoff(claim, notice.snapshotToken, signal()))).toBe(
    false,
  );
  expect((await row(claim))!.execution.phase).toBe('armed');
  expect(await system(() => port.prepare(claim))).toEqual({
    state: 'no_send',
    reason: 'submission_unknown',
  });
});

test('worker loss after arming never creates a fresh submission on takeover', async () => {
  const claim = await fixture();
  const notice = await prepared(claim);
  expect(await system(() => port.authorizeHandoff(claim, notice.snapshotToken, signal()))).toBe(
    true,
  );
  await db.connection
    .collection<HousekeepingJobRecord>(store.model.collection.name)
    .updateOne({ _id: claim.jobId }, { $set: { 'claim.leaseUntil': new Date(0) } });
  expect(
    await store.claimNext('file.warning', { ...worker, incarnation: 'replacement' }),
  ).toBeNull();
  const observed = (await row(claim))!;
  expect(observed.state).toBe('unknown');
  expect(observed.execution.id).toBe(claim.executionId);
  expect(await system(() => port.authorizeHandoff(claim, notice.snapshotToken, signal()))).toBe(
    false,
  );
});

test('preserves unknown submission and never releases it as a retryable failure', async () => {
  const claim = await fixture();
  const notice = await prepared(claim);
  expect(await system(() => port.authorizeHandoff(claim, notice.snapshotToken, signal()))).toBe(
    true,
  );
  expect(
    await port.recordOutcome(claim, notice.snapshotToken, {
      state: 'unknown',
      reason: 'acknowledgementUnknown',
    }),
  ).toEqual({ state: 'pending', code: 'external_pending' });
  expect((await row(claim))!.state).toBe('unknown');
  expect(await store.release(claim, false, 'not_accepted')).toBe(false);
  expect(await store.claimNext('file.warning', worker)).toBeNull();
});

test('a sender throw while prepared poisons that execution without inventing a successful handoff', async () => {
  const claim = await fixture();
  const notice = await prepared(claim);
  expect(
    await port.recordOutcome(claim, notice.snapshotToken, {
      state: 'unknown',
      reason: 'acknowledgementUnknown',
    }),
  ).toEqual({ state: 'pending', code: 'external_pending' });
  expect((await row(claim))!.state).toBe('unknown');
});

test('definite rejection permits only repository-owned backoff; it never extends the deadline', async () => {
  const claim = await fixture();
  const notice = await prepared(claim);
  expect(await system(() => port.authorizeHandoff(claim, notice.snapshotToken, signal()))).toBe(
    true,
  );
  expect(
    await port.recordOutcome(claim, notice.snapshotToken, {
      state: 'notAccepted',
      reason: 'unavailable',
    }),
  ).toEqual({ state: 'retry', code: 'not_accepted' });
  expect(await store.release(claim, false, 'not_accepted')).toBe(true);
  expect(await store.claimNext('file.warning', worker)).toBeNull();
  expect((await row(claim))!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
});

test('known relay acceptance survives later revocation and lost outcome acknowledgement without resend', async () => {
  const claim = await fixture();
  const notice = await prepared(claim);
  expect(await system(() => port.authorizeHandoff(claim, notice.snapshotToken, signal()))).toBe(
    true,
  );
  await changeFile({ $set: { deletionRequestedAt: new Date() } });
  loseCommittedReply();
  expect(
    await port.recordOutcome(claim, notice.snapshotToken, { state: 'accepted', relayIndex: 0 }),
  ).toEqual({ state: 'unknown' });
  expect((await row(claim))!.state).toBe('settled');
  expect((await row(claim))!.execution.phase).toBe('accepted');
  expect(await store.claimNext('file.warning', worker)).toBeNull();
});

test('unarmed positive result and stale ownership cannot manufacture a delivery receipt', async () => {
  const claim = await fixture();
  const notice = await prepared(claim);
  expect(
    await port.recordOutcome(claim, notice.snapshotToken, { state: 'accepted', relayIndex: 0 }),
  ).toEqual({ state: 'lost' });
  expect(
    await system(() =>
      port.authorizeHandoff({ ...claim, fence: claim.fence + 1 }, notice.snapshotToken, signal()),
    ),
  ).toBe(false);
  expect((await row(claim))!.execution.phase).toBe('prepared');
});

test('accepted handler and bounded sender arm the actual File owner before inert transport handoff', async () => {
  const claim = await fixture();
  let message: MailMessage | undefined;
  const observations: string[] = [];
  const socket = Object.assign(new EventEmitter(), {
    connect() {
      observations.push('connect');
      void row(claim).then((current) => {
        expect(current!.execution.phase).toBe('armed');
        socket.emit('connect');
      });
      return socket;
    },
    destroy: jest.fn(),
  });
  const sender = createBoundedRetentionMailSender(
    {
      purpose: 'retention',
      hosts: ['mail.example.test'],
      username: 'retention@example.test',
      password: 'synthetic-only',
      ca: rootCertificates[0],
      servername: 'mail.example.test',
      from: 'retention@example.test',
      appTitle: 'Portal',
      allowedDomains: ['bwi.de'],
    },
    {
      createMimeStream(value) {
        message = value;
        return Readable.from([Buffer.from('synthetic-mime')]);
      },
      createSocket: () => socket as unknown as Socket,
      createTransport(options) {
        return {
          close: jest.fn(),
          sendMail(_mail, callback) {
            options.getSocket({}, (error) => {
              if (error) return callback(error);
              void row(claim).then((current) => {
                expect(current!.execution.phase).toBe('armed');
                expect(current!.progressRevision).toBe(3);
                observations.push('handoff');
                callback(null, {
                  accepted: ['notice@bwi.de'],
                  rejected: [],
                  response: '250 synthetic accepted',
                });
              });
            });
          },
        };
      },
    },
  );
  const unused = { step: jest.fn() };
  const handlers = createHousekeepingHandlers({
    fileNotice: port,
    fileCleanup: unused,
    uploadCleanup: unused,
    mailSender: sender,
  });
  expect(await system(() => handlers['file.warning'](claim, signal()))).toMatchObject({
    state: 'settled',
  });
  expect(observations).toEqual(['connect', 'handoff']);
  expect(message!.to.address).toBe('notice@bwi.de');
  expect(message!.text).toContain('Private filename <&>.pdf');
  expect((await row(claim))!.execution.phase).toBe('accepted');
  expect(await store.claimNext('file.warning', worker)).toBeNull();
  expect(unused.step).not.toHaveBeenCalled();
});

test('legacy accepted-date and use history remain unknown rather than becoming invented values', async () => {
  const claim = await fixture();
  await changeFile({
    $unset: { retentionAcceptedAt: 1 },
    $set: { 'retentionActivity.historyConfidence': 'since-tracking' },
  });
  const notice = await prepared(claim);
  expect(notice.snapshot.files[0]).toMatchObject({
    acceptedAt: null,
    lastSuccessfulReadAt: null,
    lastReadKnown: false,
    lastSuccessfulProcessingAt: null,
    inactivity: { known: false },
    readCount: { known: true, value: 0, coverage: 'since' },
    processingCount: { known: true, value: 0, coverage: 'since' },
  });
  expect(await system(() => port.authorizeHandoff(claim, notice.snapshotToken, signal()))).toBe(
    true,
  );
});
