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
    processing: { worker } as never,
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
});
