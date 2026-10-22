/** Upload projection decisions plus actual owner transactions once the producer cohort is frozen. */
import mongoose from 'mongoose';
import { createHash } from 'crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  UPLOAD_REPLAY_MS,
  UPLOAD_RECORD_BYTES,
  canonicalStorageDeletionReceipt,
} from 'librechat-data-provider';
import type {
  StorageDeletionBinding,
  StorageDeletionTerminalReceipt,
} from 'librechat-data-provider';
import type { StoredUpload, CounterRow } from './uploadManagementStore';
import type { HousekeepingJobRecord } from '../models/housekeepingJob';
import type { HousekeepingStore } from './housekeepingStore';
import {
  createUploadHousekeepingProjection,
  uploadHousekeepingDue,
  uploadHousekeepingWork,
  retireUploadHousekeeping,
} from './uploadHousekeepingProjection';
import {
  WAIT_MS,
  createUploadStore,
  mirrorFileActivityDeadline,
  mirrorFileRetentionMigration,
} from './uploadManagementStore';
import { validateUploadCleanupCustody, assertUploadCleanupCapacity } from './uploadCleanupReceipts';
import { createUploadManagementRepository } from './uploadManagement';
import { createHousekeepingStore } from './housekeepingStore';
import { createModels } from '../models';

const row = (): StoredUpload => ({
  _id: 'operation',
  tenantId: null,
  userId: '111111111111111111111111',
  scope: { kind: 'personal' },
  idempotencyKey: '11111111-1111-4111-8111-111111111111',
  fingerprint: 'fixture',
  mediaType: 'text/plain',
  declaredBytes: 8,
  state: 'waiting',
  revision: 0,
  createdAt: 1_700_000_000_000,
  cleanupPending: false,
  generation: 0,
  originalBytes: 8,
  textBytes: 0,
  recordBytes: UPLOAD_RECORD_BYTES,
  queueCharged: true,
  pendingBytes: 8,
  stagingHeld: false,
  writerStopped: true,
});
function job(operation: StoredUpload): HousekeepingJobRecord {
  const dueAt = uploadHousekeepingDue(operation);
  return {
    _id: 'a'.repeat(64),
    version: 1,
    identityHash: 'a'.repeat(64),
    handler: 'upload.cleanup',
    work: uploadHousekeepingWork(operation),
    subjectId: operation._id,
    generation: operation.generation,
    dueAt,
    nextAttemptAt: dueAt,
    state: 'queued',
    fence: 0,
    progressRevision: 0,
    attempts: 0,
    recoveries: 0,
    lastRecoveryAt: null,
    claim: null,
    execution: { id: 'execution', phase: 'awaiting_owner_transition', receiptRef: null },
    lastCode: 'scheduled',
    createdAt: new Date(),
    updatedAt: new Date(),
    terminalAt: null,
  };
}

describe('Upload scheduling projection port boundary', () => {
  // Only the session boundary is simulated here; real transaction assertions are below.
  const session = { inTransaction: () => true } as mongoose.ClientSession;
  const ports = () => ({
    observeWork: jest.fn<
      ReturnType<HousekeepingStore['observeWork']>,
      Parameters<HousekeepingStore['observeWork']>
    >(),
    project: jest
      .fn<ReturnType<HousekeepingStore['project']>, Parameters<HousekeepingStore['project']>>()
      .mockResolvedValue('a'.repeat(64)),
    refreshDue: jest
      .fn<
        ReturnType<HousekeepingStore['refreshDue']>,
        Parameters<HousekeepingStore['refreshDue']>
      >()
      .mockResolvedValue('unchanged'),
    invalidate: jest
      .fn<
        ReturnType<HousekeepingStore['invalidate']>,
        Parameters<HousekeepingStore['invalidate']>
      >()
      .mockResolvedValue(false),
  });
  it('projects generation zero and the waiting deadline in the supplied transaction', async () => {
    const owner = ports();
    owner.observeWork.mockResolvedValue(null);
    const operation = row();
    await expect(createUploadHousekeepingProjection(owner)(null, operation, session)).resolves.toBe(
      true,
    );
    expect(owner.project).toHaveBeenCalledWith(
      uploadHousekeepingWork(operation),
      new Date(operation.createdAt + WAIT_MS),
      session,
    );
  });
  it('never turns accepted File expiry or extension into an Upload expiry job', () => {
    const operation = {
      ...row(),
      state: 'ready' as const,
      acceptedAt: row().createdAt,
      expiresAt: row().createdAt + 1,
      fileId: 'operation',
    };
    expect(uploadHousekeepingDue(operation).getTime()).toBe(operation.createdAt + UPLOAD_REPLAY_MS);
    expect(
      uploadHousekeepingDue({ ...operation, expiresAt: operation.expiresAt + 7 * 86400000 }),
    ).toEqual(uploadHousekeepingDue(operation));
  });
  it('keeps pending cleanup scheduling stable across repeated observations', () => {
    const operation = { ...row(), state: 'failed' as const, cleanupPending: true };
    expect(uploadHousekeepingDue(operation)).toEqual(new Date(operation.createdAt));
  });
  it('reports an updated current projection so callers stop using the fenced claim', async () => {
    const owner = ports();
    const operation = row();
    const current = job(operation);
    owner.observeWork.mockResolvedValue(current);
    owner.refreshDue.mockResolvedValue('updated');
    await expect(createUploadHousekeepingProjection(owner)(null, operation, session)).resolves.toBe(
      true,
    );
    expect(owner.refreshDue).toHaveBeenCalledWith(
      uploadHousekeepingWork(operation),
      { jobId: current._id, executionId: current.execution.id, progressRevision: 0 },
      current.dueAt,
      session,
    );
  });
  it('preserves a started predecessor while projecting the new generation', async () => {
    const owner = ports();
    const previous = row();
    const next = { ...previous, generation: 1 };
    const old = { ...job(previous), state: 'unknown' as const };
    old.execution.phase = 'removing_unaccepted_original';
    owner.observeWork.mockResolvedValueOnce(old).mockResolvedValueOnce(null);
    await expect(createUploadHousekeepingProjection(owner)(previous, next, session)).resolves.toBe(
      true,
    );
    expect(owner.invalidate).toHaveBeenCalledWith(old._id, 0, session);
    expect(owner.project).toHaveBeenCalledWith(
      uploadHousekeepingWork(next),
      uploadHousekeepingDue(next),
      session,
    );
    expect(old.state).toBe('unknown');
    expect(old.execution.phase).toBe('removing_unaccepted_original');
  });
  it('leaves preserved/unknown current work intact without regenerating execution identity', async () => {
    const owner = ports();
    const operation = row();
    owner.observeWork.mockResolvedValue(job(operation));
    owner.refreshDue.mockResolvedValue('preserved');
    await expect(createUploadHousekeepingProjection(owner)(null, operation, session)).resolves.toBe(
      false,
    );
    expect(owner.project).not.toHaveBeenCalled();
    expect(owner.invalidate).not.toHaveBeenCalled();
  });
  it('fails a stale projection CAS without an internal generic retry', async () => {
    const owner = ports();
    const operation = row();
    owner.observeWork.mockResolvedValue(job(operation));
    owner.refreshDue.mockResolvedValue('stale');
    await expect(
      createUploadHousekeepingProjection(owner)(null, operation, session),
    ).rejects.toThrow('UPLOAD_HOUSEKEEPING_CAS_LOST');
    expect(owner.refreshDue).toHaveBeenCalledTimes(1);
  });
});

describe('Upload Housekeeping composed Mongo transactions', () => {
  let mongo: MongoMemoryReplSet;
  const db = new mongoose.Mongoose();
  let uploads: ReturnType<typeof createUploadManagementRepository>;
  let jobs: ReturnType<typeof createHousekeepingStore>;
  const principal = {
    tenantId: null,
    userId: '111111111111111111111111',
    authentication: 'guest' as const,
  };
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await db.connect(mongo.getUri());
    createModels(db);
    await db.models.File.init();
    await db.models.User.create({
      _id: principal.userId,
      tenantId: null,
      email: 'upload@example.test',
      emailVerified: false,
    });
    jobs = createHousekeepingStore(db);
    uploads = createUploadManagementRepository(db, {
      reconciled: true,
      enabled: true,
      securityPolicySha256: 'c'.repeat(64),
      baseline: { originalBytes: 0, objectBytes: 0, textBytes: 0, recordBytes: 0, bundles: 0 },
    });
    await uploads.initialize();
  });
  beforeEach(async () => {
    await db.models.UploadOperation.deleteMany({});
    await db.models.UploadCounter.deleteMany({});
    await jobs.model.deleteMany({});
    await uploads.initialize();
  });
  afterAll(async () => {
    await db.disconnect();
    db.deleteModel(/.*/);
    await mongo?.stop();
  });
  const reserve = async (id: string) =>
    uploads.reserve(
      principal,
      {
        operationId: id,
        idempotencyKey:
          id === 'operation'
            ? '11111111-1111-4111-8111-111111111111'
            : '22222222-2222-4222-8222-222222222222',
        mediaType: 'text/plain',
        declaredBytes: 8,
        fingerprint: JSON.stringify([{ kind: 'personal' }, 'text/plain', 8]),
      },
      Date.now(),
    );
  // These are owner persistence/ordering cases. Storage receipts are explicit protocol fixtures,
  // not evidence of native physical deletion.
  const actor = { hostId: 'receipt-host', instanceId: 'receipt-app' };
  const currentRow = () => db.models.UploadOperation.findById('operation').lean<StoredUpload>();
  async function attempted() {
    await reserve('operation');
    const lease = await uploads.claim({
      kind: 'transfer',
      principal,
      operationId: 'operation',
      worker: actor,
      now: Date.now(),
    });
    if (!lease) throw Error('Missing transfer lease');
    await uploads.fail(lease, 'processing_failed', Date.now());
    return {
      operationId: lease.operationId,
      generation: lease.generation,
      attemptGeneration: lease.generation,
      principal,
    };
  }
  async function bound(authority: Awaited<ReturnType<typeof attempted>>) {
    const pending = await uploads.prepareCleanupStorage(authority);
    if (pending.state !== 'binding') throw Error('Expected binding preparation');
    const binding: StorageDeletionBinding = {
      ...pending.request,
      bucket: 'private-bucket',
      key: `managed-uploads/${principal.userId}/operation.${authority.attemptGeneration}__original`,
    };
    expect(await uploads.prepareCleanupStorage(authority, binding)).toMatchObject({
      state: 'observe',
      binding,
    });
    return binding;
  }
  const terminalReceipt = (binding: StorageDeletionBinding): StorageDeletionTerminalReceipt => ({
    ...binding,
    state: 'durable_delete_complete',
    obligationId: 'native-obligation',
    aggregateRevision: '4',
    proofSHA256: 'a'.repeat(64),
  });
  async function localOnly(authority: Awaited<ReturnType<typeof attempted>>) {
    await uploads.confirmActorCleanup(
      actor,
      {
        operationId: authority.operationId,
        generation: authority.generation,
        writerStopped: false,
        localWriterStopped: true,
        localCopiesAbsent: true,
      },
      Date.now(),
    );
  }
  it('receipt custody persists one immutable request/binding before storage and never takes the quota mutex', async () => {
    const authority = await attempted();
    const counter = await db.models.UploadCounter.findById('global').lean();
    const first = await uploads.prepareCleanupStorage(authority);
    const second = await uploads.prepareCleanupStorage(authority);
    expect(first).toEqual(second);
    expect(first.state).toBe('binding');
    if (first.state !== 'binding') throw Error('Expected binding');
    const binding = {
      ...first.request,
      bucket: 'private-bucket',
      key: `managed-uploads/${principal.userId}/operation.1__original`,
    };
    await uploads.prepareCleanupStorage(authority, binding);
    expect((await currentRow())?.cleanupCustody?.binding).toEqual(binding);
    await expect(
      uploads.prepareCleanupStorage(authority, { ...binding, bucket: 'different' }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(await db.models.UploadCounter.findById('global').lean()).toEqual(counter);
  });
  it('namespace absence and local-only proof preserve original accounting and receipt custody', async () => {
    const authority = await attempted();
    const binding = await bound(authority);
    await localOnly(authority);
    const counter = await db.models.UploadCounter.findById('global').lean();
    expect(
      await uploads.recordCleanupStorage(authority, {
        result: { ...binding, state: 'namespace_absent', obligationId: 'native-obligation' },
      }),
    ).toMatchObject({ state: 'observe' });
    expect((await currentRow())?.originalBytes).toBe(8);
    expect((await currentRow())?.cleanupCustody?.consumerCommitId).toBeUndefined();
    expect(await db.models.UploadCounter.findById('global').lean()).toEqual(counter);
  });
  it('terminal receipt alone preserves charges until the exact local actor closes', async () => {
    const authority = await attempted();
    const binding = await bound(authority);
    expect(
      await uploads.recordCleanupStorage(authority, { result: terminalReceipt(binding) }),
    ).toMatchObject({ state: 'observe' });
    expect((await currentRow())?.originalBytes).toBe(8);
    expect((await currentRow())?.cleanupCustody?.consumerCommitId).toBeUndefined();
    await localOnly(authority);
    expect(
      await uploads.recordCleanupStorage(authority, { result: terminalReceipt(binding) }),
    ).toMatchObject({ state: 'consume' });
  });
  it('commits exact receipt/accounting before consumption and retains the charged terminal tombstone', async () => {
    const authority = await attempted();
    const binding = await bound(authority);
    await localOnly(authority);
    const receipt = terminalReceipt(binding);
    const prepared = await uploads.recordCleanupStorage(authority, { result: receipt });
    if (prepared.state !== 'consume') throw Error('Expected persisted consumer commit');
    const stored = (await currentRow())!;
    const hash = createHash('sha256')
      .update(canonicalStorageDeletionReceipt(receipt))
      .digest('hex');
    expect(stored).toMatchObject({
      originalBytes: 0,
      textBytes: 0,
      cleanupPending: true,
      recordBytes: UPLOAD_RECORD_BYTES,
      cleanupCustody: { receipt, receiptSHA256: hash, consumerCommitId: prepared.consumerCommitId },
    });
    const accounting = await db.model<CounterRow>('UploadCounter').findById('global').lean();
    expect(accounting?.value).toMatchObject({
      originalBytes: 0,
      objectBytes: 0,
      recordBytes: UPLOAD_RECORD_BYTES,
      bundles: 1,
    });
    expect(
      await uploads.recordCleanupStorage(authority, { consumption: { state: 'unknown' } }),
    ).toEqual(prepared);
    const consumption = {
      state: 'recorded' as const,
      obligationId: receipt.obligationId,
      receiptSHA256: hash,
      consumerCommitId: prepared.consumerCommitId,
    };
    expect(await uploads.recordCleanupStorage(authority, { consumption })).toEqual({
      state: 'complete',
      receiptRef: hash,
    });
    expect(await uploads.prepareCleanupStorage(authority)).toEqual({
      state: 'complete',
      receiptRef: hash,
    });
    const after = (await currentRow())!;
    expect(after.cleanupPending).toBe(false);
    expect(after.recordBytes).toBe(UPLOAD_RECORD_BYTES);
    expect(after.cleanupCustody?.retiredAt).toEqual(expect.any(Number));
    expect(() => validateUploadCleanupCustody(after)).not.toThrow();
    expect(await db.models.UploadCounter.findById('global').lean()).toEqual(accounting);
  });
  it('rejects foreign receipt bindings and mismatched consume tuples without overwriting custody', async () => {
    const authority = await attempted();
    const binding = await bound(authority);
    await localOnly(authority);
    const receipt = terminalReceipt(binding);
    await expect(
      uploads.recordCleanupStorage(authority, { result: { ...receipt, generation: '2' } }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    const prepared = await uploads.recordCleanupStorage(authority, { result: receipt });
    if (prepared.state !== 'consume') throw Error('Expected consumer commit');
    const before = await currentRow();
    await expect(
      uploads.recordCleanupStorage(authority, {
        consumption: {
          state: 'recorded',
          obligationId: receipt.obligationId,
          receiptSHA256: 'b'.repeat(64),
          consumerCommitId: prepared.consumerCommitId,
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await currentRow()).toEqual(before);
  });
  it('settles only the fresh claimed execution after exact receipt consumption', async () => {
    const authority = await attempted();
    const claim = await jobs.claimNext('upload.cleanup', {
      podUid: 'receipt-pod',
      incarnation: 'receipt-boot',
      source: 'test',
      hostId: 'cpu-2',
    });
    if (!claim) throw Error('Missing claim');
    expect(claim.work).toMatchObject({
      attemptGeneration: authority.attemptGeneration,
      cleanupGeneration: 2,
    });
    expect(await uploads.prepareHousekeepingCleanup(claim)).toMatchObject({ state: 'ready' });
    const owned = { ...authority, claim };
    const prepared = await uploads.prepareCleanupStorage(owned);
    if (prepared.state !== 'binding') throw Error('Expected binding');
    const binding: StorageDeletionBinding = {
      ...prepared.request,
      bucket: 'private-bucket',
      key: `managed-uploads/${principal.userId}/operation.1__original`,
    };
    await uploads.prepareCleanupStorage(owned, binding);
    await localOnly(authority);
    const receipt = terminalReceipt(binding);
    const consume = await uploads.recordCleanupStorage(owned, { result: receipt });
    if (consume.state !== 'consume') throw Error('Expected consumer commit');
    const receiptSHA256 = createHash('sha256')
      .update(canonicalStorageDeletionReceipt(receipt))
      .digest('hex');
    expect(
      await uploads.recordCleanupStorage(owned, {
        consumption: {
          state: 'recorded',
          obligationId: receipt.obligationId,
          receiptSHA256,
          consumerCommitId: consume.consumerCommitId,
        },
      }),
    ).toEqual({ state: 'complete', receiptRef: receiptSHA256 });
    expect(await jobs.model.findById(claim.jobId).lean()).toMatchObject({
      state: 'settled',
      execution: { id: claim.executionId, phase: 'complete', receiptRef: receiptSHA256 },
    });
    expect(await uploads.prepareCleanupStorage(owned)).toEqual({ state: 'lost' });
  });
  it('rejects a stale housekeeping claim before persisting a deletion intent', async () => {
    const authority = await attempted();
    const claim = await jobs.claimNext('upload.cleanup', {
      podUid: 'receipt-pod',
      incarnation: 'receipt-boot',
      source: 'test',
      hostId: 'cpu-2',
    });
    if (!claim) throw Error('Missing claim');
    expect(
      await uploads.prepareCleanupStorage({
        ...authority,
        claim: { ...claim, fence: claim.fence + 1 },
      }),
    ).toEqual({ state: 'lost' });
    expect((await currentRow())?.cleanupCustody?.request).toBeUndefined();
  });
  it('refuses to create Upload deletion custody for an accepted File', async () => {
    const authority = await attempted();
    await db.models.UploadOperation.updateOne(
      { _id: 'operation' },
      { $set: { acceptedAt: Date.now(), fileId: 'operation' } },
    );
    expect(await uploads.prepareCleanupStorage(authority)).toEqual({ state: 'lost' });
    expect((await currentRow())?.cleanupCustody?.request).toBeUndefined();
  });
  it('requires receipt headroom before an effect and rejects a forged imported consumer commit', async () => {
    const authority = await attempted();
    const binding = await bound(authority);
    const source = (await currentRow())!;
    expect(() =>
      assertUploadCleanupCapacity(
        { ...source, filename: 'x'.repeat(18000) },
        mongoose.mongo.BSON.calculateObjectSize,
      ),
    ).toThrow();
    const forged = structuredClone(source);
    forged.cleanupCustody!.consumerCommitId = 'invented';
    expect(() => validateUploadCleanupCustody(forged)).toThrow();
    expect(binding.key).toContain('.1__original');
  });
  it('projects reserve/save changes atomically and retains the original execution on refresh', async () => {
    await reserve('operation');
    const before = await db.models.UploadOperation.findById('operation').lean<StoredUpload>();
    if (!before) throw Error('Missing reservation');
    const initial = await jobs.model
      .findOne({ subjectId: before._id })
      .lean<HousekeepingJobRecord>();
    expect(initial?.work).toEqual(uploadHousekeepingWork(before));
    const store = createUploadStore(db, {});
    await store.transaction(async (session) => {
      const current = await store.Operation.findById(before._id)
        .session(session)
        .lean<StoredUpload>();
      if (!current) throw Error('Missing current reservation');
      current.createdAt += 1000;
      await store.save(current, session);
    });
    const refreshed = await jobs.model.findById(initial!._id).lean<HousekeepingJobRecord>();
    expect(refreshed?.execution.id).toBe(initial?.execution.id);
    expect(refreshed?.dueAt.getTime()).toBe(initial!.dueAt.getTime() + 1000);
  });
  it('returns lost after refreshing a claimed stale deadline, without touching quota or progress', async () => {
    await reserve('operation');
    const current = await db.models.UploadOperation.findById('operation').lean<StoredUpload>();
    if (!current) throw Error('Missing current reservation');
    const work = uploadHousekeepingWork(current);
    const session = await db.startSession();
    try {
      await session.withTransaction(async () => {
        const observed = await jobs.observeWork(work, session);
        if (!observed) throw Error('Missing job');
        expect(
          await jobs.refreshDue(
            work,
            {
              jobId: observed._id,
              executionId: observed.execution.id,
              progressRevision: observed.progressRevision,
            },
            new Date(0),
            session,
          ),
        ).toBe('updated');
      });
    } finally {
      await session.endSession();
    }
    const claim = await jobs.claimNext('upload.cleanup', {
      podUid: 'pod-a',
      incarnation: 'boot-a',
      source: 'test',
      hostId: 'cpu-2',
    });
    if (!claim) throw Error('Missing claimed job');
    const counter = await db.models.UploadCounter.findById('global').lean();
    expect(await uploads.prepareHousekeepingCleanup(claim)).toEqual({
      state: 'outcome',
      outcome: { state: 'lost' },
    });
    expect(await jobs.renew(claim)).toBeNull();
    expect(await db.models.UploadCounter.findById('global').lean()).toEqual(counter);
    expect(
      (await jobs.model.findById(claim.jobId).lean<HousekeepingJobRecord>())?.execution.phase,
    ).toBe('awaiting_owner_transition');
  });
  it('rolls the Upload and projected due time back together on owner transaction abort', async () => {
    await reserve('second');
    const before = await db.models.UploadOperation.findById('second').lean<StoredUpload>();
    const oldJob = await jobs.model.findOne({ subjectId: 'second' }).lean<HousekeepingJobRecord>();
    const store = createUploadStore(db, {});
    await expect(
      store.transaction(async (session) => {
        const current = await store.Operation.findById('second')
          .session(session)
          .lean<StoredUpload>();
        if (!current) throw Error('Missing current reservation');
        current.createdAt += 1000;
        await store.save(current, session);
        throw Error('owner abort');
      }),
    ).rejects.toThrow('owner abort');
    expect(await db.models.UploadOperation.findById('second').lean()).toEqual(before);
    expect(await jobs.model.findById(oldJob!._id).lean()).toEqual(oldJob);
  });
  it('discovers bounded indexed pages without taking or mutating the global quota record', async () => {
    await db.models.UploadOperation.insertMany(
      Array.from({ length: 40 }, (_, index) => ({
        ...row(),
        _id: `scan-${String(index).padStart(3, '0')}`,
        idempotencyKey: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      })),
    );
    const counter = await db.models.UploadCounter.findById('global').lean();
    const first = await uploads.discoverUploadHousekeeping(null);
    expect(first).toEqual({ cursor: 'scan-031', scanned: 32, complete: false });
    expect(await jobs.model.countDocuments()).toBe(32);
    const second = await uploads.discoverUploadHousekeeping(first.cursor);
    expect(second).toEqual({ cursor: 'scan-039', scanned: 8, complete: false });
    expect(await uploads.discoverUploadHousekeeping(second.cursor)).toEqual({
      cursor: null,
      scanned: 0,
      complete: true,
    });
    expect(await db.models.UploadCounter.findById('global').lean()).toEqual(counter);
    const plan = (await db.models.UploadOperation.find({ _id: { $gt: 'scan-031' } })
      .sort({ _id: 1 })
      .limit(32)
      .explain('executionStats')) as unknown as {
      queryPlanner: { winningPlan: unknown };
      executionStats: { totalDocsExamined: number };
    };
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain('IXSCAN');
    expect(plan.executionStats.totalDocsExamined).toBe(8);
  });
  it('projects both direct File mirrors inside their supplied transaction without moving Upload due to File expiry', async () => {
    const now = Date.now();
    const accepted: StoredUpload = {
      ...row(),
      state: 'ready',
      fileId: 'operation',
      acceptedAt: now,
      createdAt: now,
      expiresAt: now + 14 * 86400000,
      firstPublishedAtMs: now,
      publishedDigest: 'a'.repeat(64),
      workerKind: 'processing',
      workerGeneration: 1,
      attemptGeneration: 1,
      parserExecution: {
        attemptId: 'operation.1',
        instanceId: 'parser',
        expiresAt: new Date(now + 1000).toISOString(),
      },
    };
    await db.models.UploadOperation.create(accepted);
    const counter = await db.models.UploadCounter.findById('global').lean();
    const session = await db.startSession();
    try {
      await session.withTransaction(async () => {
        await mirrorFileActivityDeadline(db, accepted, accepted.expiresAt! + 7 * 86400000, session);
      });
      const first = await jobs.model
        .findOne({ subjectId: accepted._id })
        .lean<HousekeepingJobRecord>();
      expect(first?.dueAt).toEqual(uploadHousekeepingDue(accepted));
      const current = await db.models.UploadOperation.findById(accepted._id).lean<StoredUpload>();
      if (!current) throw Error('Missing mirrored operation');
      await jobs.model.deleteMany({});
      const previousExpiry = current.expiresAt!;
      current.expiresAt = previousExpiry - 1000;
      await session.withTransaction(async () => {
        await mirrorFileRetentionMigration(db, current, previousExpiry, undefined, session);
      });
      const migrated = await jobs.model
        .findOne({ subjectId: accepted._id })
        .lean<HousekeepingJobRecord>();
      expect(migrated?.dueAt).toEqual(uploadHousekeepingDue(accepted));
      expect(await db.models.UploadCounter.findById('global').lean()).toEqual(counter);
    } finally {
      await session.endSession();
    }
  });
  it('retires only unstarted reservation jobs and preserves a started execution', async () => {
    const empty = { ...row(), state: 'failed' as const, originalBytes: 0, pendingBytes: 0 };
    const projection = createUploadHousekeepingProjection(jobs);
    const session = await db.startSession();
    try {
      await session.withTransaction(async () => {
        await projection(null, empty, session);
        expect(await retireUploadHousekeeping(db, empty, session)).toBe(true);
      });
      const started = { ...empty, _id: 'started' };
      await session.withTransaction(() => projection(null, started, session));
      const claim = await jobs.claimNext('upload.cleanup', {
        podUid: 'pod-a',
        incarnation: 'boot-a',
        source: 'test',
        hostId: 'cpu-2',
      });
      if (!claim) throw Error('Missing started claim');
      await session.withTransaction(async () => {
        const observed = await jobs.observeWork(claim.work, session);
        if (!observed) throw Error('Missing observed execution');
        expect(
          await jobs.advance(
            claim,
            { revision: observed.progressRevision, phase: observed.execution.phase },
            { phase: 'awaiting_actor', code: 'progress' },
            session,
          ),
        ).toBe(true);
        expect(await retireUploadHousekeeping(db, started, session)).toBe(false);
      });
      expect(
        (await jobs.model.findById(claim.jobId).lean<HousekeepingJobRecord>())?.execution.phase,
      ).toBe('awaiting_actor');
    } finally {
      await session.endSession();
    }
  });
  it('projects an actual v2 imported operation through the same target owner transaction', async () => {
    await reserve('operation');
    const page = await uploads.exportSnapshot({ epoch: 'upload-projection', limit: 1 });
    const targetDb = new mongoose.Mongoose();
    try {
      await targetDb.connect(mongo.getUri('upload_projection_import'));
      createModels(targetDb);
      await targetDb.models.File.init();
      const target = createUploadManagementRepository(targetDb, {
        securityPolicySha256: 'c'.repeat(64),
      });
      await target.initialize();
      await target.importSnapshot(page);
      const imported =
        await targetDb.models.UploadOperation.findById('operation').lean<StoredUpload>();
      if (!imported) throw Error('Missing imported operation');
      const projected = await createHousekeepingStore(targetDb)
        .model.findOne({ subjectId: imported._id })
        .lean<HousekeepingJobRecord>();
      expect(projected?.work).toEqual(uploadHousekeepingWork(imported));
      expect(projected?.dueAt).toEqual(uploadHousekeepingDue(imported));
      expect(projected?.execution.phase).toBe('awaiting_owner_transition');
    } finally {
      await targetDb.disconnect();
      targetDb.deleteModel(/.*/);
    }
  });
});
