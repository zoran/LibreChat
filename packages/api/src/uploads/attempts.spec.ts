import type { UploadIntakeRecovery, UploadSecurityExecution } from 'librechat-data-provider';
import type {
  UploadAttemptBinding,
  UploadAttemptSettlement,
  UploadAttemptLocalReservation,
} from './contract';
import { createUploadAttemptJournal } from './attempts';

const worker = { hostId: 'host', instanceId: 'current' };
const binding: UploadAttemptBinding = { ...worker, operationId: 'operation', generation: 1 };
const task = { operationId: binding.operationId, generation: binding.generation, worker };
const stopped = {
  writerStopped: true,
  localCopiesAbsent: true,
  storageOutcome: 'durable' as const,
};
const unknown = { writerStopped: false, localCopiesAbsent: false };
const signal = () => new AbortController().signal;

describe('local reservations in the existing attempt record', () => {
  it('serializes candidates so two admissions cannot both consume the same free capacity', async () => {
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const assertSafe = jest.fn(async (reservations: readonly UploadAttemptLocalReservation[]) => {
      if (assertSafe.mock.calls.length === 1) {
        finish();
        await gate;
      }
      if (reservations.reduce((sum, item) => sum + item.declaredBytes, 0) > 10)
        throw new Error('Local capacity exhausted');
    });
    const journal = createUploadAttemptJournal(worker, { resources: { assertSafe } });
    const first = journal.attempts.begin(jest.fn());
    const second = journal.attempts.begin(jest.fn());
    const admitted = first.reserveLocal!(6, signal());
    const rejected = second.reserveLocal!(6, signal()).catch((error: unknown) => error);
    await entered;
    expect(assertSafe).toHaveBeenCalledTimes(1);
    release();
    await admitted;
    await expect(rejected).resolves.toMatchObject({ message: 'Local capacity exhausted' });
    expect(assertSafe.mock.calls[1][0]).toEqual([{ declaredBytes: 6 }, { declaredBytes: 6 }]);
    expect(() => second.bind({ ...binding, generation: 2 })).toThrow();
    first.bind(binding);
    first.settle(stopped);
    second.settle(stopped);
    expect(await journal.close()).toEqual({ complete: true });
  });

  it('takes immutable minimal snapshots, requires prior reserve and permits only exact repeats', async () => {
    const assertSafe = jest.fn(
      async (_reservations: readonly UploadAttemptLocalReservation[]) => {},
    );
    const journal = createUploadAttemptJournal(worker, { resources: { assertSafe } });
    const registration = journal.attempts.begin(jest.fn());
    expect(() => registration.bind(binding)).toThrow();
    await expect(registration.assertLocal!(signal())).rejects.toThrow();
    await registration.reserveLocal!(5, signal());
    await registration.reserveLocal!(5, signal());
    await expect(registration.reserveLocal!(6, signal())).rejects.toThrow('invalid_request');
    const mutable = { ...binding };
    registration.bind(mutable);
    mutable.generation = 99;
    await registration.assertLocal!(signal());
    const snapshot = assertSafe.mock.calls[2][0];
    expect(snapshot).toEqual([{ declaredBytes: 5, binding }]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(Object.isFrozen(snapshot[0].binding)).toBe(true);
    expect(assertSafe.mock.calls[0][0]).toEqual([{ declaredBytes: 5 }]);
    registration.settle(stopped);
    await expect(registration.reserveLocal!(5, signal())).rejects.toThrow();
    expect(await journal.close()).toEqual({ complete: true });
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, 31_457_281])(
    'rejects invalid declared bytes %s without invoking the guard',
    async (bytes) => {
      const assertSafe = jest.fn(async () => {});
      const journal = createUploadAttemptJournal(worker, { resources: { assertSafe } });
      const registration = journal.attempts.begin(jest.fn());
      await expect(registration.reserveLocal!(bytes, signal())).rejects.toThrow('invalid_request');
      expect(assertSafe).not.toHaveBeenCalled();
      registration.settle(stopped);
      expect(await journal.close()).toEqual({ complete: true });
    },
  );

  it.each(['settle', 'abort', 'close'] as const)(
    'does not commit a late positive measurement after %s',
    async (action) => {
      let entered!: () => void;
      const measuring = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const assertSafe = jest.fn(async () => {
        entered();
        await gate;
      });
      const journal = createUploadAttemptJournal(worker, { resources: { assertSafe } });
      const registration = journal.attempts.begin(jest.fn());
      const controller = new AbortController();
      const pending = registration.reserveLocal!(5, controller.signal).catch(
        (error: unknown) => error,
      );
      await measuring;
      if (action === 'settle') registration.settle(stopped);
      if (action === 'abort') controller.abort();
      if (action === 'close')
        expect(await journal.close(AbortSignal.abort())).toEqual({ complete: false });
      release();
      await expect(pending).resolves.toBeInstanceOf(Error);
      expect(() => registration.bind(binding)).toThrow();
      registration.settle(stopped);
      expect(await journal.close()).toEqual({ complete: true });
    },
  );

  it.each([
    [{ writerStopped: false, localCopiesAbsent: true, storageOutcome: 'unknown' }, true],
    [{ writerStopped: true, localWriterStopped: false, localCopiesAbsent: true }, true],
    [{ writerStopped: false, localWriterStopped: true, localCopiesAbsent: false }, true],
    [
      {
        writerStopped: false,
        localWriterStopped: true,
        localCopiesAbsent: true,
        storageOutcome: 'unknown',
        acknowledgementPending: true,
      },
      false,
    ],
  ] as const)(
    'releases only proven local join and absence, independently of remote cleanup: %j',
    async (proof, retained) => {
      const assertSafe = jest.fn(
        async (_reservations: readonly UploadAttemptLocalReservation[]) => {},
      );
      const journal = createUploadAttemptJournal(worker, { resources: { assertSafe } });
      const registration = journal.attempts.begin(jest.fn());
      await registration.reserveLocal!(5, signal());
      registration.bind(binding);
      registration.settle(proof);
      const probe = journal.attempts.begin(jest.fn());
      await probe.reserveLocal!(1, signal());
      expect(assertSafe.mock.calls[1][0]).toEqual([
        ...(retained ? [{ declaredBytes: 5, binding }] : []),
        { declaredBytes: 1 },
      ]);
      expect((await journal.maintenance.getMaintenanceCensus(null)).complete).toBe(false);
      expect(await journal.attempts.stopAndJoin(task, signal())).toMatchObject(proof);
      probe.settle(stopped);
      expect(await journal.close()).toEqual({ complete: false });
    },
  );

  it('retains unbound uncertain reservations and enforces the existing 256-record ceiling', async () => {
    const assertSafe = jest.fn(
      async (_reservations: readonly UploadAttemptLocalReservation[]) => {},
    );
    const journal = createUploadAttemptJournal(worker, { resources: { assertSafe } });
    for (let index = 0; index < 256; index++) {
      const registration = journal.attempts.begin(jest.fn());
      await registration.reserveLocal!(1, signal());
      registration.settle({ writerStopped: false, localCopiesAbsent: true });
    }
    expect(assertSafe.mock.calls[255][0]).toEqual(
      Array.from({ length: 256 }, () => ({ declaredBytes: 1 })),
    );
    expect(() => journal.attempts.begin(jest.fn())).toThrow('queue_full');
    expect(await journal.close()).toEqual({ complete: false });
  });

  it('replaces a fully settled receipt without leaking obsolete records into the capacity bound', async () => {
    const journal = createUploadAttemptJournal(worker, {
      resources: { assertSafe: async () => {} },
    });
    for (let index = 0; index < 300; index++) {
      const registration = journal.attempts.begin(jest.fn());
      await registration.reserveLocal!(1, signal());
      registration.bind(binding);
      registration.settle(stopped);
    }
    const active = Array.from({ length: 128 }, () => journal.attempts.begin(jest.fn()));
    expect(() => journal.attempts.begin(jest.fn())).toThrow('queue_full');
    active.forEach((registration) => registration.settle(stopped));
    expect(await journal.close()).toEqual({ complete: true });
  });
});

describe('shared upload attempt journal', () => {
  it('binds a real App writer without inventing an intake lease', async () => {
    const journal = createUploadAttemptJournal(worker);
    const registration = journal.attempts.begin(jest.fn());
    expect(await journal.maintenance.getMaintenanceCensus(null)).toMatchObject({
      queuedContinuations: 1,
      pendingWrites: 0,
    });
    registration.bind(binding);
    expect(await journal.maintenance.getMaintenanceCensus(null)).toMatchObject({
      queuedContinuations: 0,
      pendingWrites: 1,
    });
    registration.settle(stopped);
    expect(await journal.attempts.stopAndJoin(task, signal())).toEqual(stopped);
    await expect(journal.close()).resolves.toEqual({ complete: true });
  });

  test.each([{ ...worker, hostId: 'foreign' }, { ...worker, instanceId: 'previous' }, undefined])(
    'rejects a missing or foreign worker lookup: %j',
    async (foreign) => {
      const journal = createUploadAttemptJournal(worker);
      const abort = jest.fn();
      const registration = journal.attempts.begin(abort);
      registration.bind(binding);
      expect(await journal.attempts.stopAndJoin({ ...task, worker: foreign }, signal())).toEqual(
        unknown,
      );
      journal.attempts.recordCleanup({ ...task, worker: foreign }, stopped);
      expect(abort).not.toHaveBeenCalled();
      expect((await journal.maintenance.getMaintenanceCensus(null)).pendingWrites).toBe(1);
      registration.settle(stopped);
      await journal.close();
    },
  );

  test.each([
    { ...binding, hostId: 'other' },
    { ...binding, instanceId: 'old' },
    { ...binding, generation: 0 },
    { ...binding, operationId: '../invalid' },
  ])('does not admit invalid bindings: %j', async (invalid) => {
    const journal = createUploadAttemptJournal(worker);
    const registration = journal.attempts.begin(jest.fn());
    expect(() => registration.bind(invalid)).toThrow();
    registration.settle(stopped);
    await expect(journal.close()).resolves.toEqual({ complete: true });
  });

  it('snapshots both the actual worker and the minimal binding', async () => {
    const identity = { ...worker };
    const mutable = { ...binding };
    const journal = createUploadAttemptJournal(identity);
    const registration = journal.attempts.begin(jest.fn());
    identity.instanceId = 'mutated';
    registration.bind(mutable);
    mutable.operationId = 'other';
    mutable.generation = 2;
    registration.settle(stopped);
    expect(await journal.attempts.stopAndJoin(task, signal())).toEqual(stopped);
    await journal.close();
  });

  it('does not steal an active attempt or let a settled registration bind later', async () => {
    const journal = createUploadAttemptJournal(worker);
    const first = journal.attempts.begin(jest.fn());
    const second = journal.attempts.begin(jest.fn());
    first.bind(binding);
    expect(() => first.bind(binding)).toThrow('lease_lost');
    expect(() => second.bind(binding)).toThrow('lease_lost');
    second.settle(stopped);
    expect(() => second.bind({ ...binding, generation: 2 })).toThrow('lease_lost');
    first.settle(stopped);
    first.settle(unknown);
    await expect(journal.close()).resolves.toEqual({ complete: true });
  });

  it('joins only when the actual writer settles, retaining timeout evidence', async () => {
    const journal = createUploadAttemptJournal(worker);
    const abort = jest.fn();
    const registration = journal.attempts.begin(abort);
    registration.bind(binding);
    const timeout = new AbortController();
    const joining = journal.attempts.stopAndJoin(task, timeout.signal);
    expect(abort).toHaveBeenCalledTimes(1);
    timeout.abort();
    await expect(joining).resolves.toEqual(unknown);
    journal.attempts.recordCleanup(task, stopped);
    expect((await journal.maintenance.getMaintenanceCensus(null)).pendingWrites).toBe(1);
    registration.settle(stopped);
    expect(await journal.attempts.stopAndJoin(task, signal())).toEqual(stopped);
    await journal.close();
  });

  it('closes admission synchronously and joins a claim binding after shutdown begins', async () => {
    const journal = createUploadAttemptJournal(worker);
    const abort = jest.fn();
    const registration = journal.attempts.begin(abort);
    let finished = false;
    const closing = journal.close().then((result) => {
      finished = true;
      return result;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(() => journal.attempts.begin(jest.fn())).toThrow('unavailable');
    registration.bind(binding);
    expect(abort).toHaveBeenCalledTimes(2);
    registration.settle(stopped);
    await expect(closing).resolves.toEqual({ complete: true });
    expect(journal.maintenance.pauseAdmissions('late')).toBe(false);
  });

  it('retains an active writer after close times out and can later join its actual settlement', async () => {
    const journal = createUploadAttemptJournal(worker);
    const registration = journal.attempts.begin(jest.fn());
    registration.bind(binding);
    const timeout = new AbortController();
    const closing = journal.close(timeout.signal);
    timeout.abort();
    await expect(closing).resolves.toEqual({ complete: false });
    expect((await journal.maintenance.getMaintenanceCensus(null)).pendingWrites).toBe(1);
    registration.settle(stopped);
    await expect(journal.close()).resolves.toEqual({ complete: true });
  });

  it('keeps scanner cleanup separate from local and storage completion', async () => {
    const journal = createUploadAttemptJournal(worker);
    const registration = journal.attempts.begin(jest.fn());
    registration.bind(binding);
    registration.settle({ ...stopped, securityPending: true });
    expect(journal.maintenance.pauseAdmissions('owner')).toBe(true);
    expect(journal.maintenance.pauseAdmissions('other')).toBe(false);
    expect(journal.maintenance.resumeAdmissions('other')).toBe(false);
    journal.attempts.recordCleanup(task, stopped);
    expect(journal.maintenance.resumeAdmissions('owner')).toBe(false);
    journal.attempts.recordCleanup(task, { ...stopped, securityPending: false });
    expect(journal.maintenance.resumeAdmissions('owner')).toBe(true);
    await expect(journal.close()).resolves.toEqual({ complete: true });
  });

  it('bounds active registrations without discarding any admitted writer', async () => {
    const journal = createUploadAttemptJournal(worker);
    const registrations = Array.from({ length: 128 }, () => journal.attempts.begin(jest.fn()));
    expect(() => journal.attempts.begin(jest.fn())).toThrow('queue_full');
    expect((await journal.maintenance.getMaintenanceCensus(null)).queuedContinuations).toBe(128);
    registrations.forEach((registration) => registration.settle(stopped));
    await expect(journal.close()).resolves.toEqual({ complete: true });
  });

  test.each([
    [stopped, true],
    [{ ...stopped, storageOutcome: 'unknown' as const }, false],
    [{ ...stopped, securityPending: true }, false],
  ])(
    'evicts only completed receipts while retaining unresolved evidence: %j',
    async (first, complete) => {
      const journal = createUploadAttemptJournal(worker);
      for (let generation = 1; generation <= 257; generation++) {
        const registration = journal.attempts.begin(jest.fn());
        registration.bind({ ...binding, generation });
        registration.settle(generation === 1 ? first : stopped);
      }
      expect(await journal.attempts.stopAndJoin(task, signal())).toEqual(
        complete ? unknown : { ...first, writerStopped: first.storageOutcome !== 'unknown' },
      );
      journal.attempts.recordCleanup(task, stopped);
      expect((await journal.maintenance.getMaintenanceCensus(null)).complete).toBe(complete);
      await expect(journal.close()).resolves.toEqual({ complete });
    },
  );

  test.each([
    { ...stopped, writerStopped: false },
    { ...stopped, localCopiesAbsent: false },
    { ...stopped, securityPending: true },
  ])('retains incomplete evidence even without a successful claim: %j', async (proof) => {
    const journal = createUploadAttemptJournal(worker);
    journal.attempts.begin(jest.fn()).settle(proof);
    expect((await journal.maintenance.getMaintenanceCensus(null)).complete).toBe(false);
    await expect(journal.close()).resolves.toEqual({ complete: false });
  });
});

describe('bound technical recovery in the existing journal', () => {
  const local = {
    writerStopped: false,
    localWriterStopped: true,
    localCopiesAbsent: true,
    storageOutcome: 'unknown' as const,
    acknowledgementPending: true,
  };
  const execution: UploadSecurityExecution = {
    version: 1,
    attemptId: 'operation.1',
    instanceId: '11111111-1111-4111-8111-111111111111',
    executionId: '22222222-2222-4222-8222-222222222222',
    expiresAt: '2026-10-17T00:00:00.000Z',
  };
  const view = (overrides: Partial<UploadIntakeRecovery> = {}): UploadIntakeRecovery => ({
    version: 1,
    operationId: binding.operationId,
    transferGeneration: binding.generation,
    worker: { ...worker },
    closed: true,
    acknowledged: true,
    storageOutcome: 'durable',
    appWriterStopped: true,
    ...overrides,
  });
  const journals: ReturnType<typeof createUploadAttemptJournal>[] = [];
  const create = () => {
    const value = createUploadAttemptJournal(worker);
    journals.push(value);
    return value;
  };
  afterEach(async () => {
    await Promise.all(journals.splice(0).map((j) => j.close(AbortSignal.abort())));
  });
  function fixture(
    handler: (
      proof: UploadAttemptSettlement,
      signal: AbortSignal,
    ) => Promise<UploadIntakeRecovery | null> = jest.fn(async () => view()),
    proof: UploadAttemptSettlement = local,
  ) {
    const journal = create();
    const registration = journal.attempts.begin(jest.fn());
    registration.bind(binding);
    registration.recover!(handler);
    registration.settle(proof);
    return { journal, registration, handler };
  }

  it.each(['not_started', 'absent', 'durable'] as const)(
    'recovers confirmed %s only after actual local completion',
    async (storageOutcome) => {
      const { journal, handler } = fixture(jest.fn(async () => view({ storageOutcome })));
      expect(await journal.recoverPending(signal())).toEqual({
        attempted: 1,
        settled: 1,
        pending: 0,
      });
      expect(handler).toHaveBeenCalledWith(local, expect.any(AbortSignal));
      expect(await journal.attempts.stopAndJoin(task, signal())).toMatchObject({
        writerStopped: true,
        localWriterStopped: true,
        storageOutcome,
        acknowledgementPending: false,
      });
      expect(await journal.close()).toEqual({ complete: true });
      expect(handler).toHaveBeenCalledTimes(1);
    },
  );

  it('requires registration once, after bind and before settlement', () => {
    const journal = create();
    const registration = journal.attempts.begin(jest.fn());
    const handler = jest.fn(async () => view());
    expect(() => registration.recover!(handler)).toThrow();
    registration.bind(binding);
    registration.recover!(handler);
    expect(() => registration.recover!(handler)).toThrow();
    registration.settle(local);
    expect(() => registration.recover!(handler)).toThrow();
  });

  it('does not recover an active writer or one lacking actual local stop/copy evidence', async () => {
    const journal = create();
    const handler = jest.fn(async () => view());
    const registration = journal.attempts.begin(jest.fn());
    registration.bind(binding);
    registration.recover!(handler);
    expect((await journal.recoverPending(signal())).attempted).toBe(0);
    registration.settle({ ...local, localWriterStopped: false });
    expect((await journal.recoverPending(signal())).attempted).toBe(0);
    expect(handler).not.toHaveBeenCalled();
    const noCopies = fixture(
      jest.fn(async () => view()),
      { ...local, localCopiesAbsent: false },
    );
    expect((await noCopies.journal.recoverPending(signal())).attempted).toBe(0);
  });

  it.each([
    null,
    { operationId: 'foreign' },
    { transferGeneration: 2 },
    { worker: { ...worker, instanceId: 'old' } },
    { closed: false },
    { extra: true },
    { version: 2 },
    { securityExecution: { ...execution, attemptId: 'other.1' } },
    {
      securityExecution: execution,
      securitySettlement: {
        execution: { ...execution, executionId: '33333333-3333-4333-8333-333333333333' },
        writerStopped: true,
        transientDataRemoved: true,
      },
    },
  ])('rejects missing, foreign, stale and malformed recovery %j', async (patch) => {
    const candidate = patch === null ? null : { ...view(), ...patch };
    const { journal } = fixture(jest.fn(async () => candidate as UploadIntakeRecovery));
    expect(await journal.recoverPending(signal())).toEqual({
      attempted: 1,
      settled: 0,
      pending: 1,
    });
    expect(await journal.attempts.stopAndJoin(task, signal())).toEqual(local);
  });

  it('does not invoke recovery getters', async () => {
    const getter = jest.fn(() => true);
    const candidate = view();
    Object.defineProperty(candidate, 'acknowledged', { get: getter });
    const { journal } = fixture(jest.fn(async () => candidate));
    expect((await journal.recoverPending(signal())).settled).toBe(0);
    expect(getter).not.toHaveBeenCalled();
  });

  it('keeps unknown App writers and missing acknowledgements in census and drain', async () => {
    const handler = jest.fn(async () =>
      view({ storageOutcome: 'unknown', appWriterStopped: false, acknowledged: false }),
    );
    const { journal } = fixture(handler);
    await journal.recoverPending(signal());
    expect(await journal.attempts.stopAndJoin(task, signal())).toEqual(local);
    handler.mockResolvedValue(view({ acknowledged: false }));
    await journal.recoverPending(signal());
    expect((await journal.maintenance.getMaintenanceCensus(null)).complete).toBe(false);
    journal.attempts.recordCleanup(task, { ...stopped, acknowledgementPending: false });
    expect((await journal.maintenance.getMaintenanceCensus(null)).complete).toBe(false);
    expect(await journal.close()).toEqual({ complete: false });
    handler.mockResolvedValue(view());
    expect(await journal.close()).toEqual({ complete: true });
  });

  it('retains scanner pending until its exact pinned execution is fully settled', async () => {
    const handler = jest.fn(async () =>
      view({ acknowledged: false, securityExecution: execution }),
    );
    const { journal } = fixture(handler, { ...local, securityPending: true });
    await journal.recoverPending(signal());
    const other = { ...execution, executionId: '33333333-3333-4333-8333-333333333333' };
    handler.mockResolvedValue(
      view({
        securityExecution: other,
        securitySettlement: { execution: other, writerStopped: true, transientDataRemoved: true },
      }),
    );
    expect((await journal.recoverPending(signal())).settled).toBe(0);
    handler.mockResolvedValue(
      view({
        securityExecution: execution,
        securitySettlement: { execution, writerStopped: true, transientDataRemoved: true },
      }),
    );
    expect((await journal.recoverPending(signal())).settled).toBe(1);
    expect(await journal.attempts.stopAndJoin(task, signal())).toMatchObject({
      securityPending: false,
      acknowledgementPending: false,
    });
  });

  it('does not clear pending scanner evidence when the recovery omits execution', async () => {
    const { journal } = fixture(
      jest.fn(async () => view()),
      { ...local, securityPending: true },
    );
    expect((await journal.recoverPending(signal())).settled).toBe(0);
  });

  it('binds the actual initial scanner execution and snapshots it independently', async () => {
    const expected = { ...execution };
    const changed = { ...execution, executionId: '33333333-3333-4333-8333-333333333333' };
    const handler = jest.fn<Promise<UploadIntakeRecovery>, [UploadAttemptSettlement, AbortSignal]>(
      async () =>
        view({
          securityExecution: changed,
          securitySettlement: {
            execution: changed,
            writerStopped: true,
            transientDataRemoved: true,
          },
        }),
    );
    const { journal } = fixture(handler, {
      ...local,
      securityPending: true,
      securityExecution: expected,
    });
    expected.executionId = changed.executionId;
    const returned = await journal.attempts.stopAndJoin(task, signal());
    returned.securityExecution!.executionId = changed.executionId;
    expect((await journal.recoverPending(signal())).settled).toBe(0);
    expect(handler.mock.calls[0][0].securityExecution).toEqual(execution);
    expect(Object.isFrozen(handler.mock.calls[0][0])).toBe(true);
    expect(Object.isFrozen(handler.mock.calls[0][0].securityExecution)).toBe(true);
    handler.mockResolvedValue(
      view({
        securityExecution: execution,
        securitySettlement: { execution, writerStopped: true, transientDataRemoved: true },
      }),
    );
    expect((await journal.recoverPending(signal())).settled).toBe(1);
  });

  it('does not complete a remote registration without a proven local stop', async () => {
    const { journal, handler } = fixture(
      jest.fn(async () => view()),
      {
        ...stopped,
        acknowledgementPending: false,
      },
    );
    expect((await journal.recoverPending(signal())).attempted).toBe(0);
    expect(await journal.close()).toEqual({ complete: false });
    expect(handler).not.toHaveBeenCalled();
  });

  it('quarantines malformed or foreign initial scanner evidence', async () => {
    const { journal, handler } = fixture(
      jest.fn(async () => view()),
      {
        ...local,
        securityExecution: { ...execution, attemptId: 'foreign.1' },
      },
    );
    expect((await journal.recoverPending(signal())).attempted).toBe(0);
    expect(handler).not.toHaveBeenCalled();
    expect(await journal.close()).toEqual({ complete: false });
  });

  it('does not replace a known remote outcome with a contradictory response', async () => {
    const { journal } = fixture(
      jest.fn(async () => view({ storageOutcome: 'absent' })),
      {
        ...local,
        storageOutcome: 'durable',
        writerStopped: true,
      },
    );
    expect((await journal.recoverPending(signal())).settled).toBe(0);
    expect(await journal.attempts.stopAndJoin(task, signal())).toMatchObject({
      storageOutcome: 'durable',
      acknowledgementPending: true,
    });
  });

  it('bounds an uncooperative callback, prevents overlap and ignores its late result', async () => {
    let resolve!: (value: UploadIntakeRecovery) => void;
    const handler = jest.fn(
      () =>
        new Promise<UploadIntakeRecovery>((done) => {
          resolve = done;
        }),
    );
    const { journal } = fixture(handler);
    const controller = new AbortController();
    const recovering = journal.recoverPending(controller.signal);
    await Promise.resolve();
    expect((await journal.recoverPending(signal())).attempted).toBe(0);
    controller.abort();
    expect(await recovering).toEqual({ attempted: 1, settled: 0, pending: 1 });
    expect((await journal.recoverPending(signal())).attempted).toBe(0);
    resolve(view());
    await new Promise((done) => setImmediate(done));
    expect(await journal.attempts.stopAndJoin(task, signal())).toEqual(local);
    handler.mockResolvedValue(view());
    expect((await journal.recoverPending(signal())).settled).toBe(1);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('does not let callback mutation or a stale response overwrite newer local evidence', async () => {
    let resolve!: (value: UploadIntakeRecovery) => void;
    const handler = jest.fn((proof: UploadAttemptSettlement) => {
      try {
        proof.localCopiesAbsent = false;
      } catch {
        /* frozen snapshot */
      }
      return new Promise<UploadIntakeRecovery>((done) => {
        resolve = done;
      });
    });
    const { journal } = fixture(handler);
    const running = journal.recoverPending(signal());
    await Promise.resolve();
    journal.attempts.recordCleanup(task, { ...local, securityPending: true });
    resolve(view());
    expect((await running).settled).toBe(0);
    expect(await journal.attempts.stopAndJoin(task, signal())).toMatchObject({
      localCopiesAbsent: true,
      securityPending: true,
    });
  });

  it('keeps thrown recovery incomplete and permits a later bounded retry', async () => {
    const handler = jest.fn(async (): Promise<UploadIntakeRecovery> => {
      throw new Error('disconnect');
    });
    const { journal } = fixture(handler);
    expect((await journal.recoverPending(signal())).settled).toBe(0);
    handler.mockResolvedValue(view());
    expect((await journal.recoverPending(signal())).settled).toBe(1);
  });

  it('close joins local work before recovery and keeps pending acknowledgements visible', async () => {
    const journal = create();
    const handler = jest.fn(async () => view());
    const registration = journal.attempts.begin(jest.fn());
    registration.bind(binding);
    registration.recover!(handler);
    const closing = journal.close();
    await Promise.resolve();
    expect(handler).not.toHaveBeenCalled();
    registration.settle(local);
    expect(await closing).toEqual({ complete: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('retains 256 unresolved receipts and refuses the next registration before any claim', async () => {
    const journal = create();
    for (let generation = 1; generation <= 256; generation++) {
      const registration = journal.attempts.begin(jest.fn());
      registration.bind({ ...binding, generation });
      registration.settle(local);
    }
    expect(() => journal.attempts.begin(jest.fn())).toThrow('queue_full');
    expect(await journal.attempts.stopAndJoin(task, signal())).toEqual(local);
    expect(await journal.close()).toEqual({ complete: false });
  });

  it('reserves journal capacity for unbound registrations and obeys the recovery batch limit', async () => {
    const journal = create();
    const handlers: jest.Mock[] = [];
    for (let generation = 1; generation <= 256; generation++) {
      const registration = journal.attempts.begin(jest.fn());
      registration.bind({ ...binding, generation });
      const handler = jest.fn(async () => view({ transferGeneration: generation }));
      handlers.push(handler);
      registration.recover!(handler);
      registration.settle(local);
    }
    expect(await journal.recoverPending(signal(), 2)).toEqual({
      attempted: 2,
      settled: 2,
      pending: 254,
    });
    const first = journal.attempts.begin(jest.fn());
    const second = journal.attempts.begin(jest.fn());
    expect(() => journal.attempts.begin(jest.fn())).toThrow('queue_full');
    first.settle(stopped);
    second.settle(stopped);
    expect(handlers.filter((handler) => handler.mock.calls.length)).toHaveLength(2);
    await expect(journal.recoverPending(signal(), 0)).rejects.toThrow();
    await expect(journal.recoverPending(signal(), 257)).rejects.toThrow();
  });

  it('advances the bounded batch past an unresolved earlier record', async () => {
    const journal = create();
    const callbacks = [
      jest.fn(async () =>
        view({ storageOutcome: 'unknown', appWriterStopped: false, acknowledged: false }),
      ),
      jest.fn(async () => view({ transferGeneration: 2 })),
    ];
    for (let generation = 1; generation <= 2; generation++) {
      const registration = journal.attempts.begin(jest.fn());
      registration.bind({ ...binding, generation });
      registration.recover!(callbacks[generation - 1]);
      registration.settle(local);
    }
    expect(await journal.recoverPending(signal(), 1)).toEqual({
      attempted: 1,
      settled: 0,
      pending: 2,
    });
    expect(await journal.recoverPending(signal(), 1)).toEqual({
      attempted: 1,
      settled: 1,
      pending: 1,
    });
    expect(callbacks[0]).toHaveBeenCalledTimes(1);
    expect(callbacks[1]).toHaveBeenCalledTimes(1);
  });
});
