import { processNextManagedUpload } from './processing/run';
import { createUploadWorkers } from './workers';

jest.mock('./processing/run', () => ({ processNextManagedUpload: jest.fn() }));
const processOne = processNextManagedUpload as jest.MockedFunction<typeof processNextManagedUpload>;
const worker = { hostId: 'host', instanceId: 'instance' };
const lease = {
  ...worker,
  tenantId: 'tenant',
  userId: 'user',
  operationId: 'op',
  generation: 1,
  kind: 'transfer' as const,
  expiresAt: '2099-01-01T00:00:00Z',
};
const task = { operationId: 'op', generation: 1, worker };
const stopped = {
  writerStopped: true,
  localCopiesAbsent: true,
  storageOutcome: 'durable' as const,
};

function fixture() {
  return createUploadWorkers({
    processing: { worker, stagingRoot: '/isolated-unused', documents: {} } as never,
    settlement: {
      repository: { cleanupForWorker: jest.fn().mockResolvedValue({ tasks: [], cursor: null }) },
    } as never,
    runAsSystem: (run) => run(),
    idleMs: 100,
  });
}

describe('managed upload work ownership', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    processOne.mockReset();
    processOne.mockResolvedValue({ claimed: false });
  });
  afterEach(() => jest.useRealTimers());

  it('runs one processing invocation at a time and waits before the next claim', async () => {
    let finish!: (result: { claimed: false }) => void;
    processOne.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const workers = fixture();
    workers.start();
    workers.start();
    await jest.advanceTimersByTimeAsync(100);
    expect(processOne).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(processOne).toHaveBeenCalledTimes(1);
    expect(
      (await workers.maintenance.getMaintenanceCensus(null)).queuedContinuations,
    ).toBeGreaterThan(0);
    finish({ claimed: false });
    await jest.advanceTimersByTimeAsync(99);
    expect(processOne).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(processOne).toHaveBeenCalledTimes(2);
    await expect(workers.close()).resolves.toEqual({ complete: true });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(processOne).toHaveBeenCalledTimes(2);
  });

  it('closes admission synchronously while retaining a claim accepted before pause', async () => {
    const workers = fixture();
    const ticket = workers.attempts.begin(jest.fn());
    expect(workers.maintenance.pauseAdmissions('maintenance')).toBe(true);
    expect(() => workers.attempts.begin(jest.fn())).toThrow();
    expect(await workers.maintenance.getMaintenanceCensus('maintenance')).toMatchObject({
      admissionClosed: true,
      queuedContinuations: 1,
    });
    ticket.bind(lease);
    expect(await workers.maintenance.getMaintenanceCensus('maintenance')).toMatchObject({
      pendingWrites: 1,
    });
    ticket.settle(stopped);
    expect(workers.maintenance.resumeAdmissions('other')).toBe(false);
    expect(workers.maintenance.resumeAdmissions('maintenance')).toBe(true);
    await workers.close();
  });

  it('shutdown aborts and joins even a claim that binds after shutdown started', async () => {
    const workers = fixture();
    const abort = jest.fn();
    const ticket = workers.attempts.begin(abort);
    let settled = false;
    const closing = workers.close().then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(abort).toHaveBeenCalled();
    expect(settled).toBe(false);
    ticket.bind(lease);
    ticket.settle(stopped);
    await expect(closing).resolves.toEqual({ complete: true });
  });

  it('never converts a locally joined uncertain PUT into remote-writer proof', async () => {
    const workers = fixture();
    const ticket = workers.attempts.begin(jest.fn());
    ticket.bind(lease);
    ticket.settle({ writerStopped: true, localCopiesAbsent: true, storageOutcome: 'unknown' });
    expect(await workers.attempts.stopAndJoin(task, new AbortController().signal)).toMatchObject({
      writerStopped: false,
    });
    expect((await workers.maintenance.getMaintenanceCensus(null)).complete).toBe(false);
    await expect(workers.close()).resolves.toEqual({ complete: false });
  });

  it('does not replace an unsettled remote writer with a new binding for the same attempt', async () => {
    const workers = fixture();
    const first = workers.attempts.begin(jest.fn());
    first.bind(lease);
    first.settle({ ...stopped, storageOutcome: 'unknown' });
    const second = workers.attempts.begin(jest.fn());
    expect(() => second.bind(lease)).toThrow('lease_lost');
    second.settle(stopped);
    await expect(workers.close()).resolves.toEqual({ complete: false });
  });

  it('keeps an unknown PUT incomplete after a cleanup report without a storage fence', async () => {
    const workers = fixture();
    const ticket = workers.attempts.begin(jest.fn());
    ticket.bind(lease);
    ticket.settle({ ...stopped, storageOutcome: 'unknown' });
    workers.attempts.recordCleanup(task, { writerStopped: true, localCopiesAbsent: true });
    expect((await workers.maintenance.getMaintenanceCensus(null)).complete).toBe(false);
    await expect(workers.close()).resolves.toEqual({ complete: false });
  });

  it('keeps a missing or previous worker incarnation unknown', async () => {
    const workers = fixture();
    const abort = jest.fn();
    const ticket = workers.attempts.begin(abort);
    ticket.bind(lease);
    ticket.settle(stopped);
    const signal = new AbortController().signal;
    expect(
      await workers.attempts.stopAndJoin(
        { ...task, worker: { ...worker, instanceId: 'previous' } },
        signal,
      ),
    ).toMatchObject({ writerStopped: false });
    expect(await workers.attempts.stopAndJoin({ ...task, generation: 2 }, signal)).toMatchObject({
      writerStopped: false,
    });
    expect(await workers.attempts.stopAndJoin(task, signal)).toMatchObject({ writerStopped: true });
    expect(abort).not.toHaveBeenCalled();
    await workers.close();
  });

  it('retains the independent scanner obligation after local and storage writers finish', async () => {
    const workers = fixture();
    const ticket = workers.attempts.begin(jest.fn());
    ticket.bind(lease);
    ticket.settle({ ...stopped, securityPending: true });
    expect(await workers.attempts.stopAndJoin(task, new AbortController().signal)).toMatchObject({
      writerStopped: true,
      securityPending: true,
    });
    workers.attempts.recordCleanup(task, stopped);
    expect((await workers.maintenance.getMaintenanceCensus(null)).complete).toBe(false);
    workers.attempts.recordCleanup(task, { ...stopped, securityPending: false });
    expect((await workers.maintenance.getMaintenanceCensus(null)).complete).toBe(true);
    await expect(workers.close()).resolves.toEqual({ complete: true });
  });

  it('a bounded join timeout leaves the active attempt in the maintenance census', async () => {
    const workers = fixture();
    const ticket = workers.attempts.begin(jest.fn());
    ticket.bind(lease);
    const signal = new AbortController();
    const joining = workers.attempts.stopAndJoin(task, signal.signal);
    signal.abort();
    await expect(joining).resolves.toMatchObject({ writerStopped: false });
    expect((await workers.maintenance.getMaintenanceCensus(null)).pendingWrites).toBe(1);
    ticket.settle(stopped);
    await workers.close();
  });

  it('pausing an idle loop prevents another processing claim', async () => {
    const workers = fixture();
    workers.start();
    workers.maintenance.pauseAdmissions('pause');
    await jest.advanceTimersByTimeAsync(1_000);
    expect(processOne).not.toHaveBeenCalled();
    expect(workers.maintenance.resumeAdmissions('pause')).toBe(true);
    await jest.advanceTimersByTimeAsync(100);
    expect(processOne).toHaveBeenCalledTimes(1);
    await workers.close();
  });

  it('keeps processing failures incomplete while using the same journal port', async () => {
    const onError = jest.fn(() => {
      throw new Error('diagnostic failed');
    });
    processOne.mockRejectedValueOnce(new Error('processing failed'));
    const workers = createUploadWorkers({
      processing: { worker, stagingRoot: '/isolated-unused', documents: {} } as never,
      settlement: {
        repository: { cleanupForWorker: jest.fn().mockResolvedValue({ tasks: [], cursor: null }) },
      } as never,
      runAsSystem: (run) => run(),
      idleMs: 100,
      onError,
    });
    workers.start();
    await jest.advanceTimersByTimeAsync(100);
    expect(processOne.mock.calls[0][0].attempts).toBe(workers.attempts);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(workers.maintenance.pauseAdmissions('pause')).toBe(true);
    expect(workers.maintenance.resumeAdmissions('pause')).toBe(false);
    expect((await workers.maintenance.getMaintenanceCensus('pause')).complete).toBe(false);
    await expect(workers.close()).resolves.toEqual({ complete: false });
  });

  it('drains the processing invocation separately from an empty journal', async () => {
    let finish!: (result: { claimed: false }) => void;
    processOne.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const workers = fixture();
    workers.start();
    await jest.advanceTimersByTimeAsync(100);
    const timeout = new AbortController();
    const closing = workers.close(timeout.signal);
    expect(processOne.mock.calls[0][1]?.aborted).toBe(true);
    timeout.abort();
    await expect(closing).resolves.toEqual({ complete: false });
    expect((await workers.maintenance.getMaintenanceCensus(null)).queuedContinuations).toBe(1);
    finish({ claimed: false });
    await expect(workers.close()).resolves.toEqual({ complete: true });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(processOne).toHaveBeenCalledTimes(1);
  });
  it('services durable actor cleanup while new processing admission is paused', async () => {
    const cleanupForWorker = jest.fn().mockResolvedValue({ tasks: [], cursor: null });
    const workers = createUploadWorkers({
      processing: { worker, stagingRoot: '/isolated-unused', documents: {} } as never,
      settlement: { repository: { cleanupForWorker } } as never,
      runAsSystem: (run) => run(),
      idleMs: 100,
    });
    workers.start();
    workers.maintenance.pauseAdmissions('pause');
    try {
      await jest.advanceTimersByTimeAsync(100);
      expect(cleanupForWorker).toHaveBeenCalledWith(worker, expect.objectContaining({ limit: 16 }));
      expect(processOne).not.toHaveBeenCalled();
    } finally {
      await workers.close();
    }
  });

  it('settles before admission and immediately after an attempt without overlapping processing', async () => {
    const events: string[] = [];
    const cleanupForWorker = jest.fn(async () => {
      events.push('settle');
      return { tasks: [], cursor: null };
    });
    processOne.mockImplementationOnce(async () => {
      events.push('process');
      return { claimed: true, operation: undefined };
    });
    const workers = createUploadWorkers({
      processing: { worker, stagingRoot: '/isolated-unused' } as never,
      settlement: { repository: { cleanupForWorker } } as never,
      runAsSystem: (run) => run(),
      idleMs: 100,
    });
    workers.start();
    await jest.advanceTimersByTimeAsync(101);
    expect(events.slice(0, 3)).toEqual(['settle', 'process', 'settle']);
    expect(processOne).toHaveBeenCalledTimes(1);
    await workers.close();
  });
  it('reports a stuck settlement during drain and does not detach its actual flight', async () => {
    let release!: (value: { tasks: []; cursor: null }) => void;
    const cleanupForWorker = jest.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const workers = createUploadWorkers({
      processing: { worker, stagingRoot: '/isolated-unused' } as never,
      settlement: { repository: { cleanupForWorker } } as never,
      runAsSystem: (run) => run(),
      idleMs: 100,
    });
    workers.start();
    await jest.advanceTimersByTimeAsync(100);
    const stop = new AbortController();
    const closing = workers.close(stop.signal);
    stop.abort();
    await expect(closing).resolves.toEqual({ complete: false });
    expect((await workers.maintenance.getMaintenanceCensus(null)).complete).toBe(false);
    cleanupForWorker.mockResolvedValue({ tasks: [], cursor: null });
    release({ tasks: [], cursor: null });
    await expect(workers.close()).resolves.toEqual({ complete: true });
    expect(processOne).not.toHaveBeenCalled();
  });

  it('keeps pause census incomplete before the first owner discovery', async () => {
    const cleanupForWorker = jest.fn().mockResolvedValue({
      tasks: [{ ...task, state: 'failed' }],
      cursor: 'op',
    });
    const workers = createUploadWorkers({
      processing: { worker, stagingRoot: '/isolated-unused', documents: {} } as never,
      settlement: {
        repository: {
          cleanupForWorker,
          confirmActorCleanup: jest.fn().mockResolvedValue({
            actorWriterStopped: false,
            localCopiesAbsent: false,
            writerStopped: false,
          }),
        },
      } as never,
      runAsSystem: (run) => run(),
      idleMs: 100,
    });
    workers.start();
    workers.maintenance.pauseAdmissions('pause');
    try {
      expect(cleanupForWorker).not.toHaveBeenCalled();
      expect((await workers.maintenance.getMaintenanceCensus('pause')).complete).toBe(false);
      await jest.advanceTimersByTimeAsync(100);
      expect((await workers.maintenance.getMaintenanceCensus('pause')).complete).toBe(false);
      cleanupForWorker.mockResolvedValue({ tasks: [], cursor: null });
      await jest.advanceTimersByTimeAsync(100);
      expect((await workers.maintenance.getMaintenanceCensus('pause')).complete).toBe(true);
    } finally {
      cleanupForWorker.mockResolvedValue({ tasks: [], cursor: null });
      await workers.close();
    }
  });

  it('does not let a pre-pause empty flight satisfy the newer pause census', async () => {
    let finish!: (value: { tasks: []; cursor: null }) => void;
    const cleanupForWorker = jest
      .fn()
      .mockResolvedValueOnce({ tasks: [], cursor: null })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ tasks: [], cursor: null });
    const workers = createUploadWorkers({
      processing: { worker, stagingRoot: '/isolated-unused', documents: {} } as never,
      settlement: { repository: { cleanupForWorker } } as never,
      runAsSystem: (run) => run(),
      idleMs: 100,
    });
    workers.start();
    await jest.advanceTimersByTimeAsync(200);
    expect(cleanupForWorker).toHaveBeenCalledTimes(2);
    workers.maintenance.pauseAdmissions('pause');
    finish({ tasks: [], cursor: null });
    await jest.advanceTimersByTimeAsync(0);
    try {
      expect((await workers.maintenance.getMaintenanceCensus('pause')).complete).toBe(false);
      await jest.advanceTimersByTimeAsync(100);
      expect((await workers.maintenance.getMaintenanceCensus('pause')).complete).toBe(true);
      workers.maintenance.pauseAdmissions('pause');
      expect((await workers.maintenance.getMaintenanceCensus('pause')).complete).toBe(true);
    } finally {
      await workers.close();
    }
  });

  it.each([false, true])(
    'requires discovery after an admitted local attempt finishes draining (scanner pending: %s)',
    async (scannerPending) => {
      let finish!: (value: { tasks: []; cursor: null }) => void;
      const cleanupForWorker = jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        )
        .mockResolvedValue({ tasks: [], cursor: null });
      const workers = createUploadWorkers({
        processing: { worker, stagingRoot: '/isolated-unused', documents: {} } as never,
        settlement: { repository: { cleanupForWorker } } as never,
        runAsSystem: (run) => run(),
        idleMs: 100,
      });
      const ticket = workers.attempts.begin(jest.fn());
      ticket.bind(lease);
      if (scannerPending) ticket.settle({ ...stopped, securityPending: true });
      workers.start();
      workers.maintenance.pauseAdmissions('pause');
      await jest.advanceTimersByTimeAsync(100);
      if (scannerPending)
        workers.attempts.recordCleanup(task, { ...stopped, securityPending: false });
      else ticket.settle(stopped);
      finish({ tasks: [], cursor: null });
      await jest.advanceTimersByTimeAsync(0);
      try {
        expect((await workers.maintenance.getMaintenanceCensus('pause')).complete).toBe(false);
        await jest.advanceTimersByTimeAsync(100);
        expect((await workers.maintenance.getMaintenanceCensus('pause')).complete).toBe(true);
      } finally {
        await workers.close();
      }
    },
  );

  it('does not certify an empty query begun before a processing invocation drains', async () => {
    let finishProcessing!: (value: Awaited<ReturnType<typeof processNextManagedUpload>>) => void;
    let finishQuery!: (value: { tasks: []; cursor: null }) => void;
    processOne.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishProcessing = resolve;
        }),
    );
    const cleanupForWorker = jest
      .fn()
      .mockResolvedValueOnce({ tasks: [], cursor: null })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishQuery = resolve;
          }),
      )
      .mockResolvedValue({ tasks: [], cursor: null });
    const workers = createUploadWorkers({
      processing: { worker, stagingRoot: '/isolated-unused', documents: {} } as never,
      settlement: { repository: { cleanupForWorker } } as never,
      runAsSystem: (run) => run(),
      idleMs: 100,
    });
    workers.start();
    await jest.advanceTimersByTimeAsync(100);
    workers.maintenance.pauseAdmissions('pause');
    await jest.advanceTimersByTimeAsync(100);
    finishProcessing({ claimed: true, operation: undefined });
    finishQuery({ tasks: [], cursor: null });
    // Flush the actual flights without running the newly scheduled recovery timer.
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
    try {
      expect((await workers.maintenance.getMaintenanceCensus('pause')).complete).toBe(false);
      await jest.advanceTimersByTimeAsync(100);
      expect((await workers.maintenance.getMaintenanceCensus('pause')).complete).toBe(true);
    } finally {
      await workers.close();
    }
  });
});
