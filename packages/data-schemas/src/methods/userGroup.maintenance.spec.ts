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

test.each(['create', 'update-members', 'update-name'] as const)(
  'selected %s retains its original write and preserves rejection identity',
  async (kind) => {
    const { state, observer } = observation();
    const write = deferred();
    const failure = new Error('original write acknowledgement lost');
    const cache = { get: async () => undefined, set: async () => undefined, delete: jest.fn() };
    const Group = {
      create: jest.fn(() => write.promise),
      findByIdAndUpdate: jest.fn(() => ({ lean: () => write.promise })),
    };
    const methods = createUserGroupMethods({ models: { Group } } as never, {
      getCache: () => cache,
    });
    const work =
      kind === 'create'
        ? methods.createGroup({ memberIds: ['member'] }, undefined, observer)
        : methods.updateGroupById(
            'group',
            kind === 'update-members' ? { memberIds: ['member'] } : { name: 'renamed' },
            undefined,
            observer,
          );
    const outcome = work.catch((error: unknown) => error);
    const beforeRejection = { ...state };
    write.reject(failure);
    expect(await outcome).toBe(failure);
    expect(beforeRejection).toEqual({ pending: 1, uncertain: false });
    expect(state).toEqual({ pending: 0, uncertain: true });
    expect(cache.delete).not.toHaveBeenCalled();
  },
);

test.each(['create', 'update'] as const)(
  'selected %s retains delayed tenant membership and real prompt generation writes',
  async (kind) => {
    jest.useFakeTimers();
    const { state, observer } = observation();
    const delayedDelete = deferred();
    const delayedGeneration = deferred();
    const group = { _id: new Types.ObjectId(), memberIds: ['new-member'] };
    const previous = { ...group, memberIds: ['old-member'] };
    const Group = {
      create: jest.fn(async () => [group]),
      findByIdAndUpdate: jest.fn(() => ({ lean: async () => previous })),
      findOne: jest.fn(() => ({ lean: async () => group })),
    };
    const cache = {
      get: async () => undefined,
      set: async () => undefined,
      delete: jest.fn(async (_key: string): Promise<void> => undefined),
      crossProcess: true,
      staleEvictionDelayMs: 3000,
    };
    const promptCache = {
      get: async () => undefined,
      delete: jest.fn(async () => true),
      set: jest.fn(async (_key: string): Promise<void> => undefined),
    };
    const prompt = createPromptMethods(
      { models: {}, Types } as never,
      { getCache: () => promptCache } as never,
    );
    const methods = createUserGroupMethods({ models: { Group } } as never, {
      getCache: () => cache,
      onMemberGroupsInvalidated: prompt.invalidatePromptGroupAccessContext,
    });
    const result = await tenantStorage.run({ tenantId: 'selected-tenant' }, () =>
      kind === 'create'
        ? methods.createGroup(group, undefined, observer)
        : methods.updateGroupById(group._id, { memberIds: group.memberIds }, undefined, observer),
    );
    expect(result).toBe(group);
    if (kind === 'update') {
      expect(Group.findByIdAndUpdate).toHaveBeenCalledWith(
        group._id,
        { $set: { memberIds: ['new-member'] } },
        { new: false },
      );
      expect(Group.findOne).toHaveBeenCalledWith({ _id: group._id }, {});
    }
    const keys =
      kind === 'create'
        ? ['new-member', 'new-member:selected-tenant']
        : ['old-member', 'old-member:selected-tenant', 'new-member', 'new-member:selected-tenant'];
    expect(cache.delete.mock.calls.map(([key]) => key)).toEqual(keys);
    expect(promptCache.set).toHaveBeenCalledWith(
      'access:generation:selected-tenant',
      expect.any(String),
      expect.any(Number),
    );
    expect(state).toEqual({ pending: 1, uncertain: false });
    cache.delete.mockImplementationOnce(() => delayedDelete.promise);
    promptCache.set.mockImplementationOnce(() => delayedGeneration.promise);
    await jest.advanceTimersByTimeAsync(3000);
    expect(cache.delete.mock.calls.map(([key]) => key)).toEqual([...keys, ...keys]);
    expect(promptCache.set).toHaveBeenCalledTimes(1);
    expect(state.pending).toBe(2);
    delayedDelete.resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(promptCache.set).toHaveBeenCalledTimes(2);
    expect(state.pending).toBe(2);
    delayedGeneration.resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(state).toEqual({ pending: 0, uncertain: false });
  },
);

test('selected mutations from separate factories share the original session hook and tenant queues', async () => {
  const first = observation();
  const second = observation();
  const { session, native } = driver();
  const group = { _id: new Types.ObjectId(), memberIds: ['member'] };
  const query = { session: jest.fn(), lean: async () => group };
  const Group = {
    create: jest.fn(async () => [group]),
    findByIdAndUpdate: jest.fn(() => ({ lean: async () => group })),
    findOne: jest.fn(() => query),
  };
  const cache = {
    get: async () => undefined,
    set: async () => undefined,
    delete: jest.fn(async (_key: string) => undefined),
  };
  const mongoose = { models: { Group } } as never;
  const a = createUserGroupMethods(mongoose, { getCache: () => cache });
  const b = createUserGroupMethods(mongoose, { getCache: () => cache });
  await tenantStorage.run({ tenantId: 'group-a' }, () =>
    a.createGroup(group, session, first.observer),
  );
  const commit = session.commitTransaction;
  await tenantStorage.run({ tenantId: 'group-b' }, () =>
    b.updateGroupById(group._id, { memberIds: ['member'] }, session, second.observer),
  );
  expect(session.commitTransaction).toBe(commit);
  expect(session.listenerCount('ended')).toBe(1);
  expect(Group.create).toHaveBeenCalledWith([group], { session });
  expect(Group.findByIdAndUpdate).toHaveBeenCalledWith(
    group._id,
    { $set: { memberIds: ['member'] } },
    { new: false, session },
  );
  expect(query.session).toHaveBeenCalledWith(session);
  expect(cache.delete).not.toHaveBeenCalled();
  expect(first.state.pending).toBe(1);
  expect(second.state.pending).toBe(1);
  await session.commitTransaction();
  expect(native.commitTransaction).toHaveBeenCalledTimes(1);
  expect(cache.delete.mock.calls.map((call) => call[0])).toEqual([
    'member',
    'member:group-a',
    'member',
    'member:group-b',
  ]);
  expect(first.state).toEqual({ pending: 0, uncertain: false });
  expect(second.state).toEqual({ pending: 0, uncertain: false });
});

test('separate public factories deduplicate tenant lookups while sessions bypass the cache', async () => {
  const pending = deferred();
  const groupId = new Types.ObjectId();
  const userId = new Types.ObjectId();
  const cache = { get: jest.fn(async () => undefined), set: jest.fn(async () => undefined) };
  const query = {
    session: jest.fn(),
    read: jest.fn(),
    lean: jest.fn(async () => {
      await pending.promise;
      return [{ _id: groupId }];
    }),
  };
  const Group = { find: jest.fn(() => query) };
  const mongoose = { models: { Group } } as never;
  const a = createUserGroupMethods(mongoose, { getCache: () => cache });
  const b = createUserGroupMethods(mongoose, { getCache: () => cache });
  const params = { userId, role: 'USER', idOnTheSource: 'shared-member' };
  const first = tenantStorage.run({ tenantId: 'lookup-tenant' }, () => a.getUserPrincipals(params));
  const second = tenantStorage.run({ tenantId: 'lookup-tenant' }, () =>
    b.getUserPrincipals(params),
  );
  await new Promise((resolve) => setImmediate(resolve));
  expect(Group.find).toHaveBeenCalledTimes(1);
  expect(query.read).toHaveBeenCalledWith('primary');
  pending.resolve();
  expect(await first).toEqual(await second);
  expect(cache.set).toHaveBeenCalledTimes(1);
  expect(cache.set).toHaveBeenCalledWith('shared-member:lookup-tenant', [groupId.toString()]);
  const { session } = driver();
  cache.get.mockClear();
  query.read.mockClear();
  await b.getUserPrincipals(params, session);
  expect(Group.find).toHaveBeenCalledTimes(2);
  expect(query.session).toHaveBeenCalledWith(session);
  expect(query.read).not.toHaveBeenCalled();
  expect(cache.get).not.toHaveBeenCalled();
});
