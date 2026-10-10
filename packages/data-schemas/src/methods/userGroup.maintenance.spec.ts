/** Real data owners with deferred cache/driver adapters; no network or database is needed. */
import { Types } from 'mongoose';
import { EventEmitter } from 'node:events';
import type { ClientSession } from 'mongoose';
import type { AuthContinuationObserver } from './authPersistence';
import { createUserGroupMethods, runAfterTransaction } from './userGroup';
import { tenantStorage } from '~/config/tenantContext';
import { createPromptMethods } from './prompt';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function observation() {
  const state = { pending: 0, uncertain: false };
  const observer: AuthContinuationObserver = {
    markUncertain: () => {
      state.uncertain = true;
    },
    async track(action) {
      state.pending++;
      try {
        return await action();
      } finally {
        state.pending--;
      }
    },
    write(action) {
      return observer.track(async () => {
        try {
          return await action();
        } catch (error) {
          observer.markUncertain();
          throw error;
        }
      });
    },
  };
  return { state, observer };
}

function driver() {
  const session = Object.assign(new EventEmitter(), {
    inTransaction: () => true,
    commitTransaction: jest.fn(async (): Promise<void> => undefined),
    abortTransaction: jest.fn(async (): Promise<void> => undefined),
    startTransaction: jest.fn(),
  });
  return { session: session as unknown as ClientSession, native: { ...session } };
}

afterEach(() => {
  jest.useRealTimers();
});

test('a returned membership mutation retains the grace interval and each delayed delete', async () => {
  jest.useFakeTimers();
  const { state, observer } = observation();
  const first = deferred();
  const second = deferred();
  const cache = {
    get: async () => undefined,
    set: async () => undefined,
    delete: jest.fn(async (_key: string): Promise<void> => undefined),
    crossProcess: true,
    staleEvictionDelayMs: 3000,
  };
  const methods = createUserGroupMethods(
    {
      models: {
        Group: { updateMany: async () => ({ modifiedCount: 1, upsertedCount: 0 }) },
      },
    } as never,
    { getCache: () => cache },
  );
  await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
    methods.bulkUpdateGroups({}, { $addToSet: { memberIds: 'member' } }, {}, observer),
  );
  expect(cache.delete).toHaveBeenCalledTimes(2);
  expect(state).toEqual({ pending: 1, uncertain: false });
  cache.delete
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  await jest.advanceTimersByTimeAsync(3000);
  expect(cache.delete.mock.calls.map((call) => call[0])).toEqual([
    'member',
    'member:tenant-a',
    'member',
    'member:tenant-a',
  ]);
  expect(state.pending).toBe(3);
  first.reject(new Error('unknown delete result'));
  await jest.advanceTimersByTimeAsync(0);
  expect(state).toEqual({ pending: 1, uncertain: true });
  second.resolve();
  await jest.advanceTimersByTimeAsync(0);
  expect(state).toEqual({ pending: 0, uncertain: true });
});

test('commit retains the captured tenant and callback children until their actual completion', async () => {
  const { state, observer } = observation();
  const { session, native } = driver();
  const commit = deferred();
  const child = deferred();
  native.commitTransaction.mockImplementation(() => commit.promise);
  let observedTenant: string | undefined;
  const invalidate = jest.fn(async () => {
    observedTenant = tenantStorage.getStore()?.tenantId;
    await child.promise;
  });
  await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
    runAfterTransaction(session, invalidate, observer),
  );
  expect(state.pending).toBe(1);
  const work = tenantStorage.run({ tenantId: 'tenant-b' }, () => session.commitTransaction());
  expect(invalidate).not.toHaveBeenCalled();
  commit.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(observedTenant).toBe('tenant-a');
  expect(state.pending).toBe(1);
  child.resolve();
  await work;
  expect(state).toEqual({ pending: 0, uncertain: false });
  await session.commitTransaction();
  expect(invalidate).toHaveBeenCalledTimes(1);
});

test('an uncertain commit keeps its callback for a retry and never clears uncertainty', async () => {
  const { state, observer } = observation();
  const { session, native } = driver();
  native.commitTransaction.mockRejectedValueOnce(new Error('commit acknowledgement lost'));
  const invalidate = jest.fn(async () => undefined);
  await runAfterTransaction(session, invalidate, observer);
  await expect(session.commitTransaction()).rejects.toThrow('acknowledgement');
  expect(invalidate).not.toHaveBeenCalled();
  expect(state).toEqual({ pending: 1, uncertain: true });
  await session.commitTransaction();
  expect(invalidate).toHaveBeenCalledTimes(1);
  expect(state).toEqual({ pending: 0, uncertain: true });
});

test.each([false, true])(
  'abort settles only with the actual driver outcome (failure=%s)',
  async (failure) => {
    const { state, observer } = observation();
    const { session, native } = driver();
    const abort = deferred();
    native.abortTransaction.mockImplementation(() => abort.promise);
    const invalidate = jest.fn(async () => undefined);
    await runAfterTransaction(session, invalidate, observer);
    const work = session.abortTransaction().catch(() => undefined);
    expect(state.pending).toBe(1);
    if (failure) abort.reject(new Error('abort failed'));
    else abort.resolve();
    await work;
    expect(invalidate).not.toHaveBeenCalled();
    expect(state).toEqual({ pending: 0, uncertain: failure });
  },
);

test.each(['ended', 'new-transaction'])(
  '%s cannot replay or silently erase a retained transaction',
  async (boundary) => {
    const { state, observer } = observation();
    const { session } = driver();
    const invalidate = jest.fn(async () => undefined);
    await runAfterTransaction(session, invalidate, observer);
    if (boundary === 'ended') session.emit('ended', session);
    else session.startTransaction();
    await Promise.resolve();
    expect(state).toEqual({ pending: 0, uncertain: true });
    await session.commitTransaction();
    expect(invalidate).not.toHaveBeenCalled();
  },
);

test('a failed callback does not release its sibling after commit', async () => {
  const { state, observer } = observation();
  const { session } = driver();
  const child = deferred();
  await runAfterTransaction(
    session,
    async () => {
      throw new Error('hidden cache error');
    },
    observer,
  );
  await runAfterTransaction(session, () => child.promise, observer);
  const work = session.commitTransaction();
  await new Promise((resolve) => setImmediate(resolve));
  expect(state).toEqual({ pending: 1, uncertain: true });
  child.resolve();
  await work;
  expect(state).toEqual({ pending: 0, uncertain: true });
});

test('prompt owner observes a sanitized generation-set failure after successful eviction', async () => {
  const { state, observer } = observation();
  const cache = { get: async () => undefined, delete: async () => true, set: async () => false };
  const methods = createPromptMethods(
    { models: {}, Types } as never,
    { getCache: () => cache } as never,
  );
  await expect(methods.invalidatePromptGroupAccessContext(observer)).resolves.toBeUndefined();
  expect(state).toEqual({ pending: 0, uncertain: true });
});
