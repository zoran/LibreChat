/** Real Mongo owner transactions and ordered claim/effect races for internal projection. */
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { HousekeepingWork, JobClaim } from '../types/housekeeping';
import type { HousekeepingJobRecord } from '../models/housekeepingJob';
import { createHousekeepingStore } from './housekeepingStore';

describe('Housekeeping owner projection', () => {
  let mongo: MongoMemoryReplSet;
  let store: ReturnType<typeof createHousekeepingStore>;
  const worker = { podUid: 'pod-a', incarnation: 'boot-a', source: 'worker-a', hostId: 'cpu-2' };
  const past = new Date(0);
  const future = new Date('2099-01-01T00:00:00Z');
  const warning = (id: string): HousekeepingWork => ({
    handler: 'file.warning',
    subject: { tenantId: null, ownerUserId: 'owner', fileId: id },
    deadlineGeneration: 1,
    offsetDays: 7,
  });
  const file = (revocationId: string | null): HousekeepingWork => ({
    handler: 'file.cleanup',
    subject: { tenantId: null, ownerUserId: 'owner', fileId: 'file' },
    deadlineGeneration: 1,
    revocationId,
  });
  const upload = (attemptGeneration: number | null): HousekeepingWork => ({
    handler: 'upload.cleanup',
    subject: { tenantId: null, ownerUserId: 'owner' },
    operationId: 'operation',
    cleanupGeneration: 1,
    attemptGeneration,
  });
  const expected = (row: HousekeepingJobRecord | null) => {
    if (!row) throw Error('Missing test observation');
    return {
      jobId: row._id,
      executionId: row.execution.id,
      progressRevision: row.progressRevision,
    };
  };
  const barrier = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  };
  async function transaction<T>(action: (session: mongoose.ClientSession) => Promise<T>) {
    const session = await mongoose.startSession();
    try {
      return await session.withTransaction(() => action(session), {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        maxCommitTimeMS: 3000,
      });
    } finally {
      await session.endSession();
    }
  }
  const observe = (work: HousekeepingWork) =>
    transaction((session) => store.observeWork(work, session));
  const project = (work: HousekeepingWork, dueAt = past) =>
    transaction((session) => store.project(work, dueAt, session));
  async function claim(handler: HousekeepingWork['handler']) {
    const claimed = await store.claimNext(handler, worker);
    if (!claimed) throw Error('Missing test claim');
    return claimed;
  }
  async function prepareAndArm(claimed: JobClaim) {
    return transaction(async (session) => {
      const row = await store.observeWork(claimed.work, session);
      expect(
        await store.advance(
          claimed,
          { revision: expected(row).progressRevision, phase: 'scheduled' },
          { phase: 'prepared', code: 'progress' },
          session,
        ),
      ).toBe(true);
      expect(
        await store.advance(
          claimed,
          { revision: expected(row).progressRevision + 1, phase: 'prepared' },
          { phase: 'armed', code: 'progress', receiptRef: 'owner-submission' },
          session,
        ),
      ).toBe(true);
    });
  }
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongo.getUri(), { retryWrites: false });
    store = createHousekeepingStore(mongoose);
    await store.initialize();
  });
  beforeEach(async () => {
    await store.model.deleteMany({});
  });
  afterAll(async () => {
    await mongoose.disconnect();
    mongoose.deleteModel(/.*/);
    await mongo?.stop();
  });

  it('uses the caller transaction and same identity for one-way File revocation promotion', async () => {
    const inactive = await mongoose.startSession();
    try {
      await expect(store.observeWork(file(null), inactive)).rejects.toThrow(
        'OWNER_TRANSACTION_REQUIRED',
      );
    } finally {
      await inactive.endSession();
    }
    await expect(
      transaction(async (session) => {
        const id = await store.project(file(null), future, session);
        expect((await store.observeWork(file('revocation'), session))?._id).toBe(id);
        expect(await store.model.countDocuments({})).toBe(0);
        throw Error('owner abort');
      }),
    ).rejects.toThrow('owner abort');
    expect(await observe(file(null))).toBeNull();
    const id = await project(file(null), future);
    const before = await observe(file(null));
    expect(
      await transaction((session) =>
        store.refreshDue(file('revocation'), expected(before), past, session),
      ),
    ).toBe('updated');
    const promoted = await observe(file(null));
    expect(promoted).toMatchObject({
      _id: id,
      work: file('revocation'),
      dueAt: past,
      nextAttemptAt: past,
      execution: before!.execution,
      progressRevision: before!.progressRevision + 1,
    });
    expect(await project(file(null), future)).toBe(id);
    expect(
      await transaction((session) =>
        store.refreshDue(file('revocation'), expected(before), future, session),
      ),
    ).toBe('stale');
    for (const proposed of [file(null), file('different-revocation')]) {
      expect(
        await transaction((session) =>
          store.refreshDue(proposed, expected(promoted), future, session),
        ),
      ).toBe('preserved');
    }
    expect(
      await transaction((session) => store.invalidate(id, promoted!.progressRevision, session)),
    ).toBe(false);
    expect(await observe(file(null))).toEqual(promoted);
  });

  it('fences a changed Upload attempt before execution and retains started execution evidence', async () => {
    await project(upload(null));
    const old = await claim('upload.cleanup');
    const before = await observe(upload(2));
    expect(
      await transaction((session) => store.refreshDue(upload(2), expected(before), past, session)),
    ).toBe('updated');
    const refreshed = await observe(upload(null));
    expect(refreshed).toMatchObject({
      work: upload(2),
      execution: before!.execution,
      claim: null,
      fence: old.fence + 1,
      attempts: 1,
      state: 'queued',
    });
    expect(await store.renew(old)).toBeNull();
    expect(
      await transaction((session) =>
        store.advance(
          old,
          { revision: refreshed!.progressRevision, phase: 'awaiting_owner_transition' },
          { phase: 'awaiting_actor', code: 'progress' },
          session,
        ),
      ),
    ).toBe(false);
    const current = await claim('upload.cleanup');
    expect(current.executionId).toBe(old.executionId);
    expect(current.work).toEqual(upload(2));
    expect(
      await transaction((session) =>
        store.advance(
          current,
          { revision: refreshed!.progressRevision, phase: 'awaiting_owner_transition' },
          { phase: 'awaiting_actor', code: 'external_pending', receiptRef: 'original-actor' },
          session,
        ),
      ),
    ).toBe(true);
    const started = await observe(upload(3));
    expect(
      await transaction((session) =>
        store.refreshDue(upload(3), expected(started), future, session),
      ),
    ).toBe('preserved');
    expect(
      await transaction((session) =>
        store.invalidate(current.jobId, started!.progressRevision, session),
      ),
    ).toBe(false);
    expect(await observe(upload(3))).toEqual(started);
    expect((await store.renew(current))?.claimId).toBe(current.claimId);
  });

  it('retains repository backoff while updating an unstarted same-generation obligation', async () => {
    await project(upload(1));
    const claimed = await claim('upload.cleanup');
    expect(await store.release(claimed, false, 'owner_pending')).toBe(true);
    const waiting = await observe(upload(1));
    expect(
      await transaction((session) => store.refreshDue(upload(2), expected(waiting), past, session)),
    ).toBe('updated');
    const refreshed = await observe(upload(2));
    expect(refreshed).toMatchObject({
      nextAttemptAt: waiting!.nextAttemptAt,
      attempts: waiting!.attempts,
      state: 'waiting',
      lastCode: 'owner_pending',
      execution: waiting!.execution,
    });
    for (const proposed of [upload(null), upload(1)]) {
      expect(
        await transaction((session) =>
          store.refreshDue(proposed, expected(refreshed), future, session),
        ),
      ).toBe('preserved');
    }
    expect(
      await transaction((session) =>
        store.refreshDue(upload(2), expected(refreshed), past, session),
      ),
    ).toBe('unchanged');
  });

  it('handles postponement then acceleration without retaining obsolete due time or erasing backoff', async () => {
    const work = upload(1);
    const refresh = (dueAt: Date) =>
      transaction(async (session) => {
        const row = await store.observeWork(work, session);
        return store.refreshDue(work, expected(row), dueAt, session);
      });
    await project(work);
    await claim('upload.cleanup');
    expect(await refresh(future)).toBe('updated');
    expect(await refresh(past)).toBe('updated');
    expect((await observe(work))?.nextAttemptAt).toEqual(past);
    const claimed = await claim('upload.cleanup');
    expect(await store.release(claimed, false, 'owner_pending')).toBe(true);
    const retry = await observe(work);
    expect(retry?.retryNotBefore).toEqual(retry?.nextAttemptAt);
    expect(await refresh(future)).toBe('updated');
    expect(await refresh(past)).toBe('updated');
    expect((await observe(work))?.nextAttemptAt).toEqual(retry!.nextAttemptAt);
  });

  it('classifies untouched legacy rows but preserves an unclassified attempted retry floor', async () => {
    const work = upload(1);
    const id = await project(work);
    const raw = store.model
      .collection as unknown as mongoose.mongo.Collection<HousekeepingJobRecord>;
    await raw.updateOne({ _id: id }, { $unset: { retryNotBefore: '' } });
    const untouched = await observe(work);
    expect(untouched?.retryNotBefore).toBeUndefined();
    expect((await store.model.findById(id))?.retryNotBefore).toBeUndefined();
    expect(
      await transaction((session) => store.refreshDue(work, expected(untouched), future, session)),
    ).toBe('updated');
    const classified = await observe(work);
    expect(classified?.retryNotBefore).toBeNull();
    expect(
      await transaction((session) => store.refreshDue(work, expected(classified), past, session)),
    ).toBe('updated');
    const claimed = await claim('upload.cleanup');
    expect(await store.release(claimed, false, 'owner_pending')).toBe(true);
    await raw.updateOne({ _id: id }, { $unset: { retryNotBefore: '' } });
    const legacyRetry = await observe(work);
    for (const dueAt of [future, past]) {
      expect(
        await transaction((session) =>
          store.refreshDue(work, expected(legacyRetry), dueAt, session),
        ),
      ).toBe('preserved');
    }
    expect(await observe(work)).toEqual(legacyRetry);
  });

  it('retries a snapshot overtaken by a claim and fences the actual claimed generation', async () => {
    const work = warning('claim-race');
    await project(work);
    const observed = barrier();
    const resume = barrier();
    let attempts = 0;
    const refresh = transaction(async (session) => {
      attempts++;
      const row = await store.observeWork(work, session);
      if (attempts === 1) {
        observed.release();
        await resume.promise;
      }
      return store.refreshDue(work, expected(row), future, session);
    });
    let claimed: JobClaim;
    try {
      await observed.promise;
      claimed = await claim('file.warning');
    } finally {
      resume.release();
    }
    expect(await refresh).toBe('updated');
    expect(attempts).toBe(2);
    const row = await observe(work);
    expect(row).toMatchObject({
      state: 'queued',
      fence: claimed!.fence + 1,
      claim: null,
      progressRevision: 1,
      dueAt: future,
      nextAttemptAt: future,
      execution: { id: claimed!.executionId },
    });
    expect(await store.renew(claimed!)).toBeNull();
    expect(await store.claimNext('file.warning', worker)).toBeNull();
  });

  it('rejects a real claim CAS whose candidate was rescheduled before its write', async () => {
    const work = warning('candidate-race');
    await project(work);
    const selected = barrier();
    const resume = barrier();
    const original = store.model.collection.findOneAndUpdate.bind(store.model.collection);
    const spy = jest
      .spyOn(store.model.collection, 'findOneAndUpdate')
      .mockImplementationOnce(async (...args) => {
        selected.release();
        await resume.promise;
        return original(...args);
      });
    const pending = store.claimNext('file.warning', worker);
    try {
      await selected.promise;
      await transaction(async (session) => {
        const row = await store.observeWork(work, session);
        expect(await store.refreshDue(work, expected(row), future, session)).toBe('updated');
      });
    } finally {
      resume.release();
    }
    expect(await pending).toBeNull();
    spy.mockRestore();
    expect(await observe(work)).toMatchObject({
      state: 'queued',
      fence: 1,
      attempts: 0,
      claim: null,
      dueAt: future,
    });
  });

  it('retries a snapshot overtaken by arming and preserves the exact submission and later receipt', async () => {
    const work = warning('arm-race');
    await project(work);
    const claimed = await claim('file.warning');
    const observed = barrier();
    const resume = barrier();
    let attempts = 0;
    const refresh = transaction(async (session) => {
      attempts++;
      const row = await store.observeWork(work, session);
      if (attempts === 1) {
        observed.release();
        await resume.promise;
      }
      return store.refreshDue(work, expected(row), future, session);
    });
    try {
      await observed.promise;
      await prepareAndArm(claimed);
    } finally {
      resume.release();
    }
    expect(await refresh).toBe('preserved');
    expect(attempts).toBe(2);
    const armed = await observe(work);
    expect(armed).toMatchObject({
      dueAt: past,
      state: 'claimed',
      fence: claimed.fence,
      execution: { id: claimed.executionId, phase: 'armed', receiptRef: 'owner-submission' },
    });
    expect(
      await transaction((session) =>
        store.invalidate(claimed.jobId, armed!.progressRevision, session),
      ),
    ).toBe(false);
    expect((await store.renew(claimed))?.claimId).toBe(claimed.claimId);
    expect(
      await transaction((session) =>
        store.advance(
          claimed,
          { revision: armed!.progressRevision, phase: 'armed' },
          {
            phase: 'accepted',
            code: 'settled',
            state: 'settled',
            receiptRef: 'original-relay-receipt',
          },
          session,
        ),
      ),
    ).toBe(true);
    const settled = await observe(work);
    expect(
      await transaction((session) => store.refreshDue(work, expected(settled), future, session)),
    ).toBe('preserved');
    expect(
      await transaction((session) =>
        store.invalidate(claimed.jobId, settled!.progressRevision, session),
      ),
    ).toBe(false);
    expect(await observe(work)).toEqual(settled);
  });

  it('invalidates unsent preparation while retaining cleanup and unknown-effect obligations', async () => {
    const work = warning('prepared');
    await project(work);
    const prepared = await claim('file.warning');
    expect(
      await transaction((session) =>
        store.advance(
          prepared,
          { revision: 0, phase: 'scheduled' },
          { phase: 'prepared', code: 'progress', receiptRef: 'prepared-binding' },
          session,
        ),
      ),
    ).toBe(true);
    expect(await transaction((session) => store.invalidate(prepared.jobId, 1, session))).toBe(true);
    expect(await observe(work)).toMatchObject({
      state: 'superseded',
      claim: null,
      execution: { id: prepared.executionId, phase: 'prepared', receiptRef: 'prepared-binding' },
    });
    await project(file('revocation'));
    const cleanup = await claim('file.cleanup');
    expect(
      await transaction((session) =>
        store.advance(
          cleanup,
          { revision: 0, phase: 'awaiting_deadline' },
          { phase: 'revoked', code: 'progress', receiptRef: 'revocation-proof' },
          session,
        ),
      ),
    ).toBe(true);
    const revoked = await observe(file(null));
    expect(await transaction((session) => store.invalidate(cleanup.jobId, 1, session))).toBe(false);
    expect(
      await transaction((session) =>
        store.refreshDue(file('revocation'), expected(revoked), future, session),
      ),
    ).toBe('preserved');
    expect(await observe(file(null))).toEqual(revoked);
    await project(warning('unknown'));
    const unknown = await claim('file.warning');
    await prepareAndArm(unknown);
    expect(
      await transaction((session) =>
        store.advance(
          unknown,
          { revision: 2, phase: 'armed' },
          { phase: 'unknown', code: 'submission_unknown', state: 'unknown' },
          session,
        ),
      ),
    ).toBe(true);
    const pending = await observe(unknown.work);
    expect(
      await transaction((session) =>
        store.refreshDue(unknown.work, expected(pending), future, session),
      ),
    ).toBe('preserved');
    expect(await transaction((session) => store.invalidate(unknown.jobId, 3, session))).toBe(false);
    expect(await observe(unknown.work)).toEqual(pending);
  });
});
