import mongoose from 'mongoose';
import { createMethods } from '@librechat/data-schemas';
import type { CodeEnvironmentLifecycleMaintenance } from './lifecycle';
import { createCodeEnvironmentLifecycleMaintenance } from './lifecycle';
import { isLeader } from '~/cluster';

jest.mock('~/cluster', () => ({ isLeader: jest.fn() }));
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  createMethods: jest.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(mode?: 'removal' | 'registration' | 'revocation') {
  const environment = {
    _id: new mongoose.Types.ObjectId(),
    environmentId: 'fixture',
    deletionLeaseId: 'original-lease',
    workerPrincipal: { type: 'user' },
    workerId: 'fixture-worker',
    revocationTokenEnv: 'FIXTURE_ONLY',
    baseURL: 'https://fixture.invalid',
  };
  const query = (value: unknown) => {
    const result = {
      hint: jest.fn(),
      sort: jest.fn(),
      limit: jest.fn(),
      select: jest.fn(),
      lean: jest.fn(async () => value),
    };
    for (const method of ['hint', 'sort', 'limit', 'select'] as const)
      result[method].mockReturnValue(result);
    return result;
  };
  const checkpoints = {
    updateOne: jest.fn(async () => ({ matchedCount: 1 })),
    findOne: jest.fn(async () => ({ lastId: null, upperId: environment._id })),
  };
  const methods = {
    beginCodeEnvironmentRemoval: jest.fn(async () => environment),
    cancelCodeEnvironmentRemoval: jest.fn(async () => {}),
    commitCodeEnvironmentRemoval: jest.fn(async () => {}),
    deleteCodeEnvironmentById: jest.fn(async () => {}),
    deleteUserCodeEnvironments: jest.fn(async () => {}),
  };
  jest.mocked(createMethods).mockReturnValue(methods as never);
  const CodeEnvironment = {
    find: jest.fn((filter) =>
      query(
        (mode === 'removal' &&
          ('deletionLeaseExpiresAt' in filter || filter.deletionCommittedAt?.$exists === true)) ||
          (mode === 'registration' && 'registrationPendingAt' in filter) ||
          (mode === 'revocation' && 'revocationPendingAt' in filter)
          ? [environment]
          : [],
      ),
    ),
    findOneAndUpdate: jest.fn(() => query(environment)),
    updateOne: jest.fn(async () => {}),
    updateMany: jest.fn(async () => {}),
    deleteOne: jest.fn(async () => {}),
    aggregate: jest.fn(async () => []),
  };
  const database = {
    Types: mongoose.Types,
    models: {
      CodeEnvironment,
      AclEntry: { deleteMany: jest.fn(async () => {}) },
      User: { collection: { name: 'users' } },
    },
    connection: { db: { collection: jest.fn(() => checkpoints) } },
  } as unknown as typeof mongoose;
  return { database, checkpoints, methods, CodeEnvironment };
}

describe('code environment lifecycle scheduler', () => {
  let owner: CodeEnvironmentLifecycleMaintenance;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    jest.mocked(isLeader).mockReset().mockResolvedValue(false);
    owner = createCodeEnvironmentLifecycleMaintenance();
  });
  afterEach(async () => {
    owner.stopAdmissions();
    await owner.drain().catch(() => undefined);
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test('runs reconciliation only on the elected API replica', async () => {
    const f = fixture();
    const leader = jest.mocked(isLeader);
    leader.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await owner.start({ mongoose: f.database });
    expect(leader).toHaveBeenCalledTimes(1);
    expect(f.checkpoints.updateOne).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(leader).toHaveBeenCalledTimes(2);
    expect(f.checkpoints.updateOne).toHaveBeenCalledTimes(2);
  });

  test('retains the first leader original across pause and stop without dispatching another tick', async () => {
    const election = deferred<boolean>();
    jest.mocked(isLeader).mockReturnValueOnce(election.promise);
    const first = owner.start({ mongoose });
    expect(owner.start({ mongoose })).toBe(first);
    owner.pauseAdmissions('held-election');
    expect(await owner.getMaintenanceCensus('held-election')).toMatchObject({
      admissionClosed: true,
      queuedContinuations: 1,
      pendingWrites: 1,
      complete: true,
    });
    let drained = false;
    const drain = owner.drain().then(() => {
      drained = true;
    });
    try {
      await jest.advanceTimersByTimeAsync(120_000);
      expect(isLeader).toHaveBeenCalledTimes(1);
      expect(drained).toBe(false);
      await expect(owner.reconcile({ mongoose })).rejects.toThrow(
        'CODE_LIFECYCLE_ADMISSION_CLOSED',
      );
    } finally {
      election.resolve(false);
    }
    await first;
    await drain;
    expect(owner.resumeAdmissions('held-election')).toBe(false);
    await expect(owner.start({ mongoose })).rejects.toThrow('CODE_LIFECYCLE_ADMISSION_CLOSED');
  });

  test('retains the actual raw checkpoint original through pause and drain', async () => {
    const f = fixture();
    const update = deferred<{ matchedCount: number }>();
    f.checkpoints.updateOne.mockReturnValueOnce(update.promise);
    const original = owner.reconcile({ mongoose: f.database });
    owner.pauseAdmissions('raw-command');
    expect(await owner.getMaintenanceCensus('raw-command')).toMatchObject({
      queuedContinuations: 1,
      pendingWrites: 1,
      complete: true,
    });
    expect(f.checkpoints.updateOne).toHaveBeenCalledTimes(1);
    let drained = false;
    const drain = owner.drain().then(() => {
      drained = true;
    });
    try {
      await jest.advanceTimersByTimeAsync(120_000);
      expect(drained).toBe(false);
      expect(f.checkpoints.updateOne).toHaveBeenCalledTimes(1);
    } finally {
      update.resolve({ matchedCount: 1 });
    }
    await original;
    await drain;
    expect(f.checkpoints.updateOne).toHaveBeenCalledTimes(2);
    expect(await owner.getMaintenanceCensus('raw-command')).toMatchObject({
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
  });

  test.each(['leader', 'checkpoint'])(
    'retains failed %s original uncertainty after local settlement',
    async (boundary) => {
      const f = fixture();
      const failure = new Error('Original observation failed');
      if (boundary === 'leader') jest.mocked(isLeader).mockRejectedValueOnce(failure);
      else f.checkpoints.updateOne.mockRejectedValueOnce(failure);
      const original =
        boundary === 'leader'
          ? owner.start({ mongoose: f.database })
          : owner.reconcile({ mongoose: f.database });
      await expect(original).rejects.toBe(failure);
      owner.pauseAdmissions('uncertain');
      expect(await owner.getMaintenanceCensus('uncertain')).toMatchObject({
        queuedContinuations: 0,
        pendingWrites: 0,
        complete: false,
      });
      expect(owner.resumeAdmissions('uncertain')).toBe(false);
      await expect(owner.drain()).rejects.toThrow('CODE_LIFECYCLE_SETTLEMENT_UNCONFIRMED');
      await jest.advanceTimersByTimeAsync(120_000);
      expect(isLeader).toHaveBeenCalledTimes(boundary === 'leader' ? 1 : 0);
    },
  );

  test.each(['removal', 'registration', 'revocation'] as const)(
    'absorbed %s provider failure stays uncertain while actual following work settles',
    async (mode) => {
      const f = fixture(mode);
      const remote = deferred<Response>();
      const following = deferred<void>();
      const fetchImpl = jest.fn(() => remote.promise);
      if (mode === 'removal')
        f.methods.deleteCodeEnvironmentById.mockReturnValueOnce(following.promise);
      else f.CodeEnvironment.updateOne.mockReturnValueOnce(following.promise);
      const original = owner.reconcile({
        mongoose: f.database,
        fetchImpl,
        readSecret: () => 'fixture-only',
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      owner.pauseAdmissions('provider-unknown');
      remote.reject(
        Object.assign(new Error('Remote outcome unobserved'), { name: 'TimeoutError' }),
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(
        mode === 'removal' ? f.methods.deleteCodeEnvironmentById : f.CodeEnvironment.updateOne,
      ).toHaveBeenCalledTimes(1);
      expect(await owner.getMaintenanceCensus('provider-unknown')).toMatchObject({
        queuedContinuations: 1,
        pendingWrites: 1,
        complete: false,
      });
      let drained = false;
      const drain = owner.drain().catch((error) => {
        drained = true;
        return error;
      });
      try {
        await jest.advanceTimersByTimeAsync(120_000);
        expect(drained).toBe(false);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      } finally {
        following.resolve();
      }
      await original;
      expect((await drain).message).toBe('CODE_LIFECYCLE_SETTLEMENT_UNCONFIRMED');
      expect(await owner.getMaintenanceCensus('provider-unknown')).toMatchObject({
        queuedContinuations: 0,
        pendingWrites: 0,
        complete: false,
      });
      expect(owner.resumeAdmissions('provider-unknown')).toBe(false);
    },
  );

  test('rejects stale census and mismatched resume, without duplicating the interval', async () => {
    await owner.start({ mongoose });
    const stale = owner.getMaintenanceCensus(null);
    expect(owner.pauseAdmissions('current')).toBe(true);
    expect((await stale).complete).toBe(false);
    expect(owner.pauseAdmissions('other')).toBe(false);
    expect(owner.resumeAdmissions('other')).toBe(false);
    const same = owner.getMaintenanceCensus('current');
    expect(owner.pauseAdmissions('current')).toBe(true);
    expect((await same).complete).toBe(true);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(isLeader).toHaveBeenCalledTimes(1);
    expect(owner.resumeAdmissions('current')).toBe(true);
    expect(owner.resumeAdmissions('current')).toBe(false);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(isLeader).toHaveBeenCalledTimes(2);
    owner.stopAdmissions();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(isLeader).toHaveBeenCalledTimes(2);
  });
});
