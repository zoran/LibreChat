/** Exercises real sweep admission and persistence lifetimes, including timer races. */
import type * as Sweep from './sweep';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('expired file maintenance ownership', () => {
  let sweep: typeof Sweep;
  const previousInterval = process.env.FILE_RETENTION_SWEEP_INTERVAL_MS;
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const dependencies = () => ({
    getExpiredFiles: jest.fn().mockResolvedValue([{ file_id: 'f', user: 'u' }]),
    processDeleteRequest: jest.fn().mockResolvedValue({ deletedFileIds: ['f'], failedFileIds: [] }),
    incrementFileDeletionAttempts: jest.fn().mockResolvedValue(1),
    deferExpiredFile: jest.fn().mockResolvedValue(undefined),
    logger,
  });
  beforeEach(async () => {
    jest.resetModules();
    sweep = await import('./sweep');
    jest.useFakeTimers();
    process.env.FILE_RETENTION_SWEEP_INTERVAL_MS = '1000';
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    if (previousInterval === undefined) delete process.env.FILE_RETENTION_SWEEP_INTERVAL_MS;
    else process.env.FILE_RETENTION_SWEEP_INTERVAL_MS = previousInterval;
  });

  it('fences new work synchronously and only accepts cancellation by the same request', async () => {
    const owner = sweep.expiredFileSweepMaintenance;
    const deps = dependencies();
    expect(owner.pauseAdmissions('drain')).toBe(true);
    expect(owner.pauseAdmissions('other')).toBe(false);
    expect(owner.resumeAdmissions('other')).toBe(false);
    await expect(sweep.sweepExpiredFiles({}, deps)).rejects.toThrow('FILE_SWEEP_QUIESCING');
    expect(deps.getExpiredFiles).not.toHaveBeenCalled();
    expect(await owner.getMaintenanceCensus('other')).toMatchObject({ complete: false });
    expect(owner.resumeAdmissions('drain')).toBe(true);
    await expect(sweep.sweepExpiredFiles({}, deps)).resolves.toEqual({
      scanned: 1,
      deleted: 1,
      failed: 0,
    });
  });

  it('keeps an accepted query and subsequent deletion counted after admission closes', async () => {
    const query = deferred<unknown>();
    const deletion = deferred<unknown>();
    const deps = dependencies();
    deps.getExpiredFiles.mockReturnValue(query.promise);
    deps.processDeleteRequest.mockReturnValue(deletion.promise);
    const run = sweep.sweepExpiredFiles({}, deps);
    const owner = sweep.expiredFileSweepMaintenance;
    owner.pauseAdmissions('drain');
    expect(await owner.getMaintenanceCensus('drain')).toMatchObject({ pendingWrites: 1 });
    query.resolve([{ file_id: 'f', user: 'u' }]);
    await jest.advanceTimersByTimeAsync(0);
    expect(deps.processDeleteRequest).toHaveBeenCalledTimes(1);
    expect(await owner.getMaintenanceCensus('drain')).toMatchObject({ pendingWrites: 1 });
    deletion.resolve({ deletedFileIds: ['f'], failedFileIds: [] });
    await run;
    expect(await owner.getMaintenanceCensus('drain')).toEqual({
      admissionClosed: true,
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
  });

  it('joins an in-flight leadership check without beginning a sweep after pause', async () => {
    const leader = deferred<boolean>();
    const execute = jest.fn().mockResolvedValue({ scanned: 0, deleted: 0, failed: 0 });
    const isLeader = jest.fn().mockReturnValueOnce(leader.promise).mockResolvedValue(true);
    sweep.startExpiredFileSweep(
      {},
      {
        isLeader,
        sweepExpiredFiles: execute,
        runAsSystem: (fn) => fn(),
        logger,
      },
    );
    const owner = sweep.expiredFileSweepMaintenance;
    owner.pauseAdmissions('drain');
    expect(await owner.getMaintenanceCensus('drain')).toMatchObject({ queuedContinuations: 1 });
    leader.resolve(true);
    await jest.advanceTimersByTimeAsync(3000);
    expect(execute).not.toHaveBeenCalled();
    expect(isLeader).toHaveBeenCalledTimes(1);
    expect(await owner.getMaintenanceCensus('drain')).toMatchObject({ queuedContinuations: 0 });
    owner.resumeAdmissions('drain');
    await jest.advanceTimersByTimeAsync(1000);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('joins retry metadata after deletion rejects and never converts uncertainty to drained', async () => {
    const retry = deferred<void>();
    const deps = dependencies();
    deps.processDeleteRequest.mockRejectedValue(new Error('write acknowledgement lost'));
    deps.deferExpiredFile.mockReturnValue(retry.promise);
    const run = sweep.sweepExpiredFiles({}, deps);
    await jest.advanceTimersByTimeAsync(0);
    const owner = sweep.expiredFileSweepMaintenance;
    owner.pauseAdmissions('drain');
    expect(await owner.getMaintenanceCensus('drain')).toMatchObject({
      pendingWrites: 1,
      complete: false,
    });
    retry.resolve();
    await run;
    expect(await owner.getMaintenanceCensus('drain')).toMatchObject({
      pendingWrites: 0,
      complete: false,
    });
    expect(owner.resumeAdmissions('drain')).toBe(false);
  });

  it.each(['failed', 'unresolved'])(
    'retains a fulfilled but %s deletion as uncertain',
    async (outcome) => {
      const deps = dependencies();
      deps.processDeleteRequest.mockResolvedValue({
        deletedFileIds: [],
        failedFileIds: outcome === 'failed' ? ['f'] : [],
      });
      await sweep.sweepExpiredFiles({}, deps);
      sweep.expiredFileSweepMaintenance.pauseAdmissions('drain');
      expect(await sweep.expiredFileSweepMaintenance.getMaintenanceCensus('drain')).toMatchObject({
        complete: false,
        pendingWrites: 0,
      });
    },
  );

  it('settles a read-only query rejection without inventing a pending write', async () => {
    const deps = dependencies();
    deps.getExpiredFiles.mockRejectedValue(new Error('read failed'));
    await expect(sweep.sweepExpiredFiles({}, deps)).rejects.toThrow('read failed');
    sweep.expiredFileSweepMaintenance.pauseAdmissions('drain');
    expect(await sweep.expiredFileSweepMaintenance.getMaintenanceCensus('drain')).toMatchObject({
      complete: true,
      pendingWrites: 0,
    });
  });
});
