/** Real Mongo lifecycle evidence for job fencing; no File, Upload or external-effect substitute. */
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { HousekeepingWork, JobClaim } from '../types/housekeeping';
import type { HousekeepingJobRecord } from '../models/housekeepingJob';
import type { HousekeepingOwners } from './housekeeping';
import { housekeepingShape } from '../../../data-provider/src/status-housekeeping';
import { HOUSEKEEPING_INDEXES } from '../models/housekeepingJob';
import { createHousekeepingStore } from './housekeepingStore';
import { createHousekeepingRepository } from './housekeeping';

describe('distributed Housekeeping job ownership', () => {
  let mongo: MongoMemoryReplSet;
  let store: ReturnType<typeof createHousekeepingStore>;
  let repository: ReturnType<typeof createHousekeepingRepository>;
  const first = { podUid: 'pod-a', incarnation: 'boot-a', source: 'worker-a', hostId: 'cpu-2' };
  const second = { podUid: 'pod-b', incarnation: 'boot-b', source: 'worker-b', hostId: 'cpu-3' };
  const owners: HousekeepingOwners = {
    discover: async () => ({ cursor: null, scanned: 0, complete: false }),
    coverage: async () => ({ expected: 1, observed: 1, recoveryHistory: 'complete' }),
  };
  const work = (id: string): HousekeepingWork => ({
    handler: 'file.warning',
    subject: { tenantId: null, ownerUserId: 'owner', fileId: id },
    deadlineGeneration: 1,
    offsetDays: 7,
  });
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
  async function schedule(id: string) {
    return transaction((session) => store.project(work(id), new Date(Date.now() - 1000), session));
  }
  function readDomain(domain: Awaited<ReturnType<typeof repository.readStatus>>) {
    return housekeepingShape.shape.domain.parse(domain);
  }
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongo.getUri(), { retryWrites: false });
    store = createHousekeepingStore(mongoose);
    await store.initialize();
    repository = createHousekeepingRepository(store, owners, { sourceId: 'domain-observer' });
  });
  beforeEach(async () => {
    await store.model.deleteMany({});
  });
  afterAll(async () => {
    await mongoose.disconnect();
    mongoose.deleteModel(/.*/);
    await mongo?.stop();
  });
  it('claims once across two workers and keeps unrelated work claimable', async () => {
    await schedule('a');
    const claims = await Promise.all([
      repository.claimNext('file.warning', first),
      repository.claimNext('file.warning', second),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await schedule('b');
    const unrelated = await repository.claimNext('file.warning', second);
    expect(unrelated?.work).toMatchObject({ subject: { fileId: 'b' } });
    expect(await store.model.countDocuments({})).toBe(2);
  });
  it('keeps heartbeat ownership across prepare/arm but rejects stale progress CAS', async () => {
    await schedule('a');
    const claim = (await repository.claimNext('file.warning', first)) as JobClaim;
    const prepared = await transaction((session) =>
      store.advance(
        claim,
        { revision: claim.progressRevision, phase: 'scheduled' },
        { phase: 'prepared', code: 'progress' },
        session,
      ),
    );
    expect(prepared).toBe(true);
    const observation = await repository.inspect(claim.jobId, claim.executionId);
    expect(observation.state).toBe('observed');
    if (observation.state !== 'observed') throw Error('observation');
    expect(
      await transaction((session) =>
        store.advance(
          claim,
          { revision: claim.progressRevision, phase: 'scheduled' },
          { phase: 'prepared', code: 'progress' },
          session,
        ),
      ),
    ).toBe(false);
    await transaction((session) =>
      store.advance(
        claim,
        { revision: observation.progressRevision, phase: 'prepared' },
        { phase: 'armed', code: 'progress' },
        session,
      ),
    );
    const renewed = await repository.renew(claim);
    expect(renewed).toMatchObject({
      claimId: claim.claimId,
      fence: claim.fence,
      progressRevision: claim.progressRevision + 2,
    });
    expect(await repository.releaseUnstarted(claim)).toBe('lost');
  });
  it('renews concurrently with repeated owner-authorized arming without progress rollback', async () => {
    await schedule('a');
    const claim = (await repository.claimNext('file.warning', first)) as JobClaim;
    for (const [from, to] of [
      ['scheduled', 'prepared'],
      ['prepared', 'armed'],
      ['armed', 'armed'],
    ] as const) {
      const row = await store.observe(claim.jobId, claim.executionId);
      const [advanced, renewed] = await Promise.all([
        transaction((session) =>
          store.advance(
            claim,
            { revision: row!.progressRevision, phase: from },
            { phase: to, code: 'progress' },
            session,
          ),
        ),
        repository.renew(claim),
      ]);
      expect(advanced).toBe(true);
      expect(renewed?.claimId).toBe(claim.claimId);
    }
    expect((await store.observe(claim.jobId, claim.executionId))?.progressRevision).toBe(3);
  });
  it('uses DB expiry, preserves execution on takeover and rejects old renew/progress', async () => {
    await schedule('a');
    const old = (await repository.claimNext('file.warning', first)) as JobClaim;
    await (
      store.model.collection as unknown as mongoose.mongo.Collection<HousekeepingJobRecord>
    ).updateOne({ _id: old.jobId }, [
      {
        $set: {
          'claim.leaseUntil': { $subtract: ['$$NOW', 1] },
        },
      },
    ]);
    expect(await repository.renew(old)).toBeNull();
    const current = (await repository.claimNext('file.warning', second)) as JobClaim;
    expect(current.executionId).toBe(old.executionId);
    expect(current.fence).toBe(old.fence + 1);
    expect(current.claimId).not.toBe(old.claimId);
    expect(await repository.renew(old)).toBeNull();
    expect(
      await transaction((session) =>
        store.advance(
          old,
          { revision: old.progressRevision, phase: 'scheduled' },
          { phase: 'prepared', code: 'progress' },
          session,
        ),
      ),
    ).toBe(false);
    expect((await store.observe(current.jobId, current.executionId))?.recoveries).toBe(1);
  });
  it('invalidates an unsent claim in the owner transaction, preserving unknown armed evidence', async () => {
    await schedule('a');
    const old = (await repository.claimNext('file.warning', first)) as JobClaim;
    expect(
      await transaction((session) => store.invalidate(old.jobId, old.progressRevision, session)),
    ).toBe(true);
    expect(await repository.renew(old)).toBeNull();
    await schedule('b');
    const armed = (await repository.claimNext('file.warning', first)) as JobClaim;
    await transaction((session) =>
      store.advance(
        armed,
        { revision: 0, phase: 'scheduled' },
        { phase: 'prepared', code: 'progress' },
        session,
      ),
    );
    await transaction((session) =>
      store.advance(
        armed,
        { revision: 1, phase: 'prepared' },
        { phase: 'armed', code: 'progress' },
        session,
      ),
    );
    expect(await transaction((session) => store.invalidate(armed.jobId, 2, session))).toBe(false);
    await (
      store.model.collection as unknown as mongoose.mongo.Collection<HousekeepingJobRecord>
    ).updateOne({ _id: armed.jobId }, [
      { $set: { 'claim.leaseUntil': { $subtract: ['$$NOW', 1] } } },
    ]);
    expect(await repository.claimNext('file.warning', second)).toBeNull();
    expect(await repository.inspect(armed.jobId, armed.executionId)).toMatchObject({
      state: 'observed',
      jobState: 'unknown',
      phase: 'unknown',
    });
    expect(await repository.claimNext('file.warning', second)).toBeNull();
    expect(await repository.renew(armed)).toBeNull();
  });
  it('keeps a committed claim with a lost reply uncertain and never returns a fabricated token', async () => {
    await schedule('a');
    const original = store.model.collection.findOneAndUpdate.bind(store.model.collection);
    jest
      .spyOn(store.model.collection, 'findOneAndUpdate')
      .mockImplementationOnce(async (...args) => {
        await original(...args);
        throw Error('simulated acknowledgement lost after real Mongo commit');
      });
    await expect(repository.claimNext('file.warning', first)).rejects.toThrow(
      'acknowledgement lost',
    );
    const row = await store.model.findOne({}).lean();
    expect(row?.state).toBe('claimed');
    expect(await repository.claimNext('file.warning', second)).toBeNull();
    expect(await repository.inspect(row!._id, row!.execution.id)).toMatchObject({
      state: 'observed',
      jobState: 'claimed',
    });
  });
  it('reports an uncertain release commit and reconciles its persisted outcome', async () => {
    await schedule('a');
    const claim = (await repository.claimNext('file.warning', first)) as JobClaim;
    const original = store.model.collection.updateOne.bind(store.model.collection);
    jest.spyOn(store.model.collection, 'updateOne').mockImplementationOnce(async (...args) => {
      await original(...args);
      throw Error('simulated release reply lost');
    });
    expect(await repository.defer(claim, 'owner_pending')).toBe('unknown');
    expect(await repository.inspect(claim.jobId, claim.executionId)).toMatchObject({
      state: 'observed',
      jobState: 'waiting',
    });
    expect(await repository.renew(claim)).toBeNull();
  });
  it('projects idempotently in transactions and aborts the whole projection on owner failure', async () => {
    const firstId = await schedule('a');
    expect(await schedule('a')).toBe(firstId);
    expect(await store.model.countDocuments({})).toBe(1);
    await expect(
      transaction(async (session) => {
        await store.project(work('b'), new Date(), session);
        throw Error('owner abort');
      }),
    ).rejects.toThrow('owner abort');
    expect(await store.model.countDocuments({})).toBe(1);
    const session = await mongoose.startSession();
    try {
      await expect(store.project(work('c'), new Date(), session)).rejects.toThrow(
        'OWNER_TRANSACTION_REQUIRED',
      );
    } finally {
      await session.endSession();
    }
  });
  it('separates warning offset, tenant and cleanup generation identities', async () => {
    const base = work('a');
    if (base.handler !== 'file.warning') throw Error('fixture');
    for (const item of [
      base,
      { ...base, offsetDays: 1 as const },
      { ...base, subject: { ...base.subject, tenantId: 'tenant-b' } },
      { ...base, deadlineGeneration: 2 },
    ]) {
      await transaction((session) => store.project(item, new Date(), session));
    }
    for (const generation of [1, 2]) {
      await transaction((session) =>
        store.project(
          {
            handler: 'upload.cleanup',
            subject: { tenantId: null, ownerUserId: 'owner' },
            operationId: 'same-operation',
            cleanupGeneration: generation,
            attemptGeneration: 1,
          },
          new Date(),
          session,
        ),
      );
    }
    expect(await store.model.countDocuments({})).toBe(6);
  });
  it('uses both due and expired indexes with bounded candidate results and no TTL', async () => {
    await schedule('a');
    const claim = (await repository.claimNext('file.warning', first)) as JobClaim;
    await (
      store.model.collection as unknown as mongoose.mongo.Collection<HousekeepingJobRecord>
    ).updateOne({ _id: claim.jobId }, [
      { $set: { 'claim.leaseUntil': { $subtract: ['$$NOW', 1] } } },
    ]);
    await schedule('b');
    for (const [hint, filter, sort] of [
      [
        HOUSEKEEPING_INDEXES.due,
        {
          handler: 'file.warning',
          state: { $in: ['queued', 'waiting'] },
          nextAttemptAt: { $lte: new Date() },
        },
        { nextAttemptAt: 1, _id: 1 },
      ],
      [
        HOUSEKEEPING_INDEXES.expired,
        { handler: 'file.warning', state: 'claimed', 'claim.leaseUntil': { $lte: new Date() } },
        { 'claim.leaseUntil': 1, _id: 1 },
      ],
    ] as const) {
      const plan = await store.model.collection
        .find(filter)
        .hint(hint)
        .sort(sort)
        .limit(16)
        .explain('executionStats');
      expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain(hint);
      expect(JSON.stringify(plan.queryPlanner.winningPlan)).not.toContain('COLLSCAN');
      expect(plan.executionStats.nReturned).toBeLessThanOrEqual(16);
    }
    const indexes = await store.model.collection.indexes();
    expect(indexes.every((index) => index.expireAfterSeconds === undefined)).toBe(true);
  });
  it('fails counters closed without starving a separate eligible job', async () => {
    await schedule('a');
    await store.model.collection.updateOne(
      { subjectId: 'a' },
      { $set: { fence: Number.MAX_SAFE_INTEGER } },
    );
    await schedule('b');
    expect((await repository.claimNext('file.warning', first))?.work).toMatchObject({
      subject: { fileId: 'b' },
    });
    expect(await store.model.countDocuments({})).toBe(2);
  });
  it('requires actual owner GC authorization and preserves unresolved/current receipts', async () => {
    await schedule('a');
    const claim = (await repository.claimNext('file.warning', first)) as JobClaim;
    await transaction((session) => store.invalidate(claim.jobId, 0, session));
    await schedule('unresolved');
    expect(await store.pruneTerminal(32, async () => false)).toBe(0);
    const authorization = jest.fn(async (_row, session) => session.inTransaction());
    expect(await store.pruneTerminal(32, authorization)).toBe(1);
    expect(authorization).toHaveBeenCalledTimes(1);
    expect(await store.model.countDocuments({})).toBe(1);
    await expect(store.pruneTerminal(33, authorization)).rejects.toThrow('INVALID');
  });
  it('reports complete observed backlog, explicit partial coverage and unknown recovery honestly', async () => {
    await schedule('a');
    const claim = (await repository.claimNext('file.warning', first)) as JobClaim;
    let status = await repository.readStatus(new AbortController().signal);
    expect(status.observation).toMatchObject({ state: 'fresh', reason: 'observed' });
    expect(status.handlers[0]).toMatchObject({
      quality: 'complete',
      values: {
        pendingCount: 1,
        overdueCount: 1,
        activeClaimsCount: 1,
        expiredClaimsCount: 0,
        recoveredClaimsCount: 0,
      },
    });
    expect(status.handlers[0].values.oldestOverdueSeconds).toBeGreaterThan(0);
    const partial = createHousekeepingRepository(
      store,
      {
        ...owners,
        coverage: async (handler) =>
          handler === 'upload.cleanup'
            ? { expected: null, observed: 0, recoveryHistory: 'unknown' }
            : { expected: 2, observed: 1, recoveryHistory: 'unknown' },
      },
      { sourceId: 'domain-observer' },
    );
    status = await partial.readStatus(new AbortController().signal);
    expect(status.observation.reason).toBe('partial_coverage');
    expect(status.handlers[0]).toMatchObject({
      quality: 'partial',
      values: { pendingCount: 1, recoveredClaimsCount: null },
    });
    expect(status.handlers[2]).toMatchObject({
      quality: 'unknown',
      coverage: { expected: null, observed: 0 },
    });
    expect(Object.values(status.handlers[2].values).every((value) => value === null)).toBe(true);
    expect(await repository.renew(claim)).not.toBeNull();
  });
  it('keeps failed or cancelled Status observations unknown, never a healthy empty queue', async () => {
    const sessions: mongoose.ClientSession[] = [];
    const startSession = store.model.db.startSession.bind(store.model.db);
    jest.spyOn(store.model.db, 'startSession').mockImplementation(async (options) => {
      const session = await startSession(options);
      sessions.push(session);
      return session;
    });
    const signal = AbortSignal.abort();
    const cancelled = await repository.readStatus(signal);
    expect(cancelled.observation.state).toBe('unknown');
    expect(sessions).toHaveLength(0);
    const aggregate = jest.spyOn(store.model.collection, 'aggregate').mockImplementationOnce(() => {
      throw Error('DB unavailable');
    });
    const unavailable = await repository.readStatus(new AbortController().signal);
    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(unavailable.observation.state).toBe('unavailable');
    expect(
      unavailable.handlers.every((row) =>
        Object.values(row.values).every((value) => value === null),
      ),
    ).toBe(true);
    const failedOwner = createHousekeepingRepository(
      store,
      {
        ...owners,
        coverage: async () => {
          throw Error('Owner unavailable');
        },
      },
      { sourceId: 'domain-observer' },
    );
    expect((await failedOwner.readStatus(new AbortController().signal)).observation.state).toBe(
      'unavailable',
    );
    expect(sessions).toHaveLength(2);
    expect(sessions.every((session) => session.hasEnded)).toBe(true);
  });
  // H1: a real backfill commit after the count snapshot must not certify earlier counts.
  it.each([0, 1])(
    'H1 binds coverage to the count snapshot with %i earlier jobs',
    async (initial) => {
      const coverageRows = mongoose.connection.db!.collection<{
        _id: string;
        expected: number;
        observed: number;
        recoveryHistory: 'complete';
      }>('housekeeping_status_test_coverage');
      await coverageRows.deleteMany({});
      await coverageRows.insertOne({
        _id: 'file.warning',
        expected: 2,
        observed: 1,
        recoveryHistory: 'complete',
      });
      if (initial) await schedule('already-projected');
      let started!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const proceed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const sessions: Array<mongoose.ClientSession | undefined> = [];
      let firstCoverage = true;
      const producer = createHousekeepingRepository(
        store,
        {
          ...owners,
          coverage: async (handler, signal, session?: mongoose.ClientSession) => {
            if (handler !== 'file.warning')
              return { expected: 1, observed: 1, recoveryHistory: 'complete' };
            sessions.push(session);
            if (firstCoverage) {
              firstCoverage = false;
              started();
              await proceed;
            }
            const marker = await coverageRows.findOne(
              { _id: handler },
              {
                session,
                signal,
                maxTimeMS: 3000,
                timeoutMS: 3000,
              },
            );
            if (!marker) throw Error('Missing fixture coverage');
            return marker;
          },
        },
        { sourceId: 'housekeeping-domain' },
      );
      const earlierRead = producer.readStatus(new AbortController().signal);
      await entered;
      try {
        await transaction(async (session) => {
          await store.project(work('final-projection'), new Date(Date.now() - 1000), session);
          await coverageRows.updateOne(
            { _id: 'file.warning' },
            { $set: { observed: 2 } },
            { session },
          );
        });
      } finally {
        release();
      }
      const earlier = readDomain(await earlierRead);
      expect(earlier.handlers[0]).toMatchObject({
        quality: 'partial',
        values: { pendingCount: initial },
      });
      const later = readDomain(await producer.readStatus(new AbortController().signal));
      expect(later.handlers[0]).toMatchObject({
        quality: 'complete',
        values: { pendingCount: initial + 1 },
      });
      expect(sessions).toHaveLength(2);
      expect(sessions[0]).not.toBe(sessions[1]);
      expect(sessions.every((session) => session?.snapshotEnabled && session.hasEnded)).toBe(true);
    },
  );
  it('validates a real Mongo domain observation against the bounded Housekeeping domain', async () => {
    await schedule('a');
    const producer = createHousekeepingRepository(store, owners, {
      sourceId: 'housekeeping-domain',
    });
    const domain = await producer.readStatus(new AbortController().signal);
    expect(readDomain(domain).handlers[0].values.pendingCount).toBe(1);
  });
  it('retains the original coverage promise through cancellation before returning unknown', async () => {
    let snapshotSession!: mongoose.ClientSession;
    let closeStarted!: () => void;
    let closeRelease!: () => void;
    const closing = new Promise<void>((resolve) => {
      closeStarted = resolve;
    });
    const closeProceed = new Promise<void>((resolve) => {
      closeRelease = resolve;
    });
    let release!: (value: {
      expected: number;
      observed: number;
      recoveryHistory: 'complete';
    }) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const original = new Promise<{
      expected: number;
      observed: number;
      recoveryHistory: 'complete';
    }>((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();
    const producer = createHousekeepingRepository(
      store,
      {
        ...owners,
        coverage: async (_handler, _signal, session) => {
          snapshotSession = session;
          const endSession = session.endSession.bind(session);
          jest.spyOn(session, 'endSession').mockImplementation(async (options) => {
            closeStarted();
            await closeProceed;
            return endSession(options);
          });
          started();
          return original;
        },
      },
      { sourceId: 'domain-observer' },
    );
    let settled = false;
    const result = producer.readStatus(controller.signal).then((value) => {
      settled = true;
      return value;
    });
    await entered;
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(snapshotSession.hasEnded).toBe(false);
    release({ expected: 1, observed: 1, recoveryHistory: 'complete' });
    await closing;
    expect(settled).toBe(false);
    expect(snapshotSession.hasEnded).toBe(false);
    closeRelease();
    expect((await result).observation.state).toBe('unknown');
    expect(snapshotSession.hasEnded).toBe(true);
  });
  it('rejects caller payload expansion and invalid cross-phase completion', async () => {
    await expect(
      transaction((session) =>
        store.project(
          { ...work('a'), secret: 'forbidden' } as unknown as HousekeepingWork,
          new Date(),
          session,
        ),
      ),
    ).rejects.toThrow('INVALID');
    await schedule('a');
    const claim = (await repository.claimNext('file.warning', first)) as JobClaim;
    await expect(
      transaction((session) =>
        store.advance(
          claim,
          { revision: 0, phase: 'scheduled' },
          { phase: 'accepted', state: 'settled', code: 'settled', receiptRef: 'invented' },
          session,
        ),
      ),
    ).rejects.toThrow('INVALID_TRANSITION');
    expect((await store.observe(claim.jobId, claim.executionId))?.execution.phase).toBe(
      'scheduled',
    );
  });
});
