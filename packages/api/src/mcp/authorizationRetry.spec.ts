import type {
  MCPAuthorizationFenceRetryRecord,
  MCPAuthorizationFenceRetryStorage,
} from './authorizationRetry';
import { createMCPAuthorizationFenceRetryService } from './authorizationRetry';

const scope = { userId: 'user-1', serverName: 'server-1' };

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function createHarness() {
  const records = new Map<string, MCPAuthorizationFenceRetryRecord>();
  const key = (
    tenantId: string | null | undefined,
    userId: string,
    serverName: string,
    version: string,
  ) => JSON.stringify([tenantId ?? '', userId, serverName, version]);
  const storage: MCPAuthorizationFenceRetryStorage = {
    upsert: jest.fn(async ({ scope: inputScope, tenantId, version, now }) => {
      records.set(key(tenantId, inputScope.userId, inputScope.serverName, version), {
        ...inputScope,
        tenantId,
        version,
        updatedAt: now,
      });
    }),
    deleteVersion: jest.fn(async ({ scope: inputScope, tenantId, version }) => {
      records.delete(key(tenantId, inputScope.userId, inputScope.serverName, version));
    }),
    deferVersion: jest.fn(async ({ scope: inputScope, tenantId, version, updatedAt }) => {
      const recordKey = key(tenantId, inputScope.userId, inputScope.serverName, version);
      const record = records.get(recordKey);
      if (record?.version === version) {
        record.updatedAt = updatedAt;
      }
    }),
    list: jest.fn(async (limit) =>
      [...records.values()]
        .sort((left, right) => left.updatedAt.getTime() - right.updatedAt.getTime())
        .slice(0, limit),
    ),
  };
  const runInRetryScope = jest.fn(async (_retry, operation) => operation());
  const registerShutdown = jest.fn();
  const service = createMCPAuthorizationFenceRetryService({
    storage,
    getTenantId: () => 'tenant-a',
    runInRetryScope,
    registerShutdown,
  });
  return { records, registerShutdown, runInRetryScope, service, storage };
}

describe('MCP authorization fence retry service', () => {
  afterEach(() => jest.useRealTimers());

  it('clears only the marker version created by that publisher', async () => {
    const { records, service, storage } = createHarness();
    const firstVersion = await service.persist(scope);
    const secondVersion = await service.persist(scope);

    await service.clear(scope, firstVersion);

    expect(storage.deleteVersion).toHaveBeenCalledWith({
      scope,
      tenantId: 'tenant-a',
      version: firstVersion,
    });
    expect([...records.values()]).toEqual([
      expect.objectContaining({ ...scope, version: secondVersion }),
    ]);
  });

  it('preserves every overlapping publication intent for the same scope', async () => {
    const { records, service } = createHarness();
    const firstVersion = await service.persist(scope);
    const secondVersion = await service.persist(scope);

    expect(records.size).toBe(2);
    expect([...records.values()].map(({ version }) => version)).toEqual([
      firstVersion,
      secondVersion,
    ]);
  });

  it('replays a bounded batch in tenant scope and deletes exact published versions', async () => {
    const { records, runInRetryScope, service, storage } = createHarness();
    const version = await service.persist(scope);
    const invalidate = jest.fn().mockResolvedValue(undefined);

    service.start(invalidate, { intervalMs: 5_000, batchSize: 7 });
    await service.drain();

    expect(storage.list).toHaveBeenCalledWith(7);
    expect(runInRetryScope).toHaveBeenCalledWith(
      expect.objectContaining({ ...scope, tenantId: 'tenant-a', version }),
      expect.any(Function),
    );
    expect(invalidate).toHaveBeenCalledWith(scope);
    expect(storage.deleteVersion).toHaveBeenCalledWith({
      scope,
      tenantId: 'tenant-a',
      version,
    });
    expect(records.size).toBe(0);
    await service.stop();
  });

  it('uses the configured cadence and registers clean shutdown', async () => {
    jest.useFakeTimers();
    const { registerShutdown, service, storage } = createHarness();
    service.start(jest.fn().mockResolvedValue(undefined), { intervalMs: 2_500, batchSize: 3 });
    await service.drain();
    (storage.list as jest.Mock).mockClear();

    await jest.advanceTimersByTimeAsync(2_500);

    expect(storage.list).toHaveBeenCalledWith(3);
    expect(registerShutdown).toHaveBeenCalledWith(
      'MCP authorization fence retry worker',
      expect.any(Function),
      { phase: 'pre-drain', priority: 90 },
    );
    await service.stop();
  });

  it('times out and defers a failed oldest record so later retries are not starved', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const { records, service, storage } = createHarness();
    await service.persist({ userId: 'user-1', serverName: 'first' });
    jest.setSystemTime(new Date('2026-01-01T00:00:00.001Z'));
    await service.persist({ userId: 'user-1', serverName: 'second' });
    let finishFirst: (() => void) | undefined;
    const firstAttempt = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const invalidate = jest.fn(({ serverName }: typeof scope) =>
      serverName === 'first' ? firstAttempt : Promise.resolve(),
    );

    service.start(invalidate, { intervalMs: 10_000, batchSize: 1, attemptTimeoutMs: 5 });
    const firstDrain = service.drain();
    await jest.advanceTimersByTimeAsync(5);
    await firstDrain;
    await service.drain();
    const thirdDrain = service.drain();
    await jest.advanceTimersByTimeAsync(5);
    await thirdDrain;

    expect(invalidate).toHaveBeenNthCalledWith(1, { userId: 'user-1', serverName: 'first' });
    expect(invalidate).toHaveBeenNthCalledWith(2, { userId: 'user-1', serverName: 'second' });
    expect(invalidate).toHaveBeenNthCalledWith(3, { userId: 'user-1', serverName: 'first' });
    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(storage.deferVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { userId: 'user-1', serverName: 'first' },
        updatedAt: new Date('2026-01-01T00:00:00.006Z'),
      }),
    );
    expect([...records.values()].map(({ serverName }) => serverName)).toEqual(['first']);
    finishFirst?.();
    await firstAttempt;
    await service.drain();
    expect(records.size).toBe(0);
    await service.stop();
  });

  it('bounds a stalled deferral so the worker can drain again', async () => {
    jest.useFakeTimers();
    const { service, storage } = createHarness();
    await service.persist(scope);
    const deferral = deferred();
    const publication = deferred();
    (storage.deferVersion as jest.Mock).mockImplementationOnce(() => deferral.promise);
    service.start(
      jest.fn(() => publication.promise),
      {
        intervalMs: 10_000,
        batchSize: 1,
        attemptTimeoutMs: 5,
      },
    );

    const firstDrain = service.drain();
    await jest.advanceTimersByTimeAsync(10);
    await firstDrain;
    const secondDrain = service.drain();
    await jest.advanceTimersByTimeAsync(10);
    await secondDrain;

    expect(storage.list).toHaveBeenCalledTimes(2);
    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    publication.resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    expect((await service.maintenance.getMaintenanceCensus(null)).pendingWrites).toBe(1);
    deferral.resolve();
    await stopping;
  });

  /** Regression: bounded observers and dedup eviction never establish writer settlement. */
  it('registers shutdown at construction and closes public writes before dispatch', async () => {
    const { service, storage, registerShutdown } = createHarness();
    expect(registerShutdown.mock.calls.map(([name, , options]) => [name, options])).toEqual([
      ['MCP authorization fence retry admissions', { phase: 'pre-drain', priority: 110 }],
      ['MCP authorization fence retry worker', { phase: 'pre-drain', priority: 90 }],
    ]);
    const upsert = deferred();
    const deletion = deferred();
    (storage.upsert as jest.Mock).mockReturnValueOnce(upsert.promise);
    (storage.deleteVersion as jest.Mock).mockReturnValueOnce(deletion.promise);
    const input = { ...scope };
    const persist = service.persist(input);
    const clear = service.clear(input, 'original-version');
    input.serverName = 'changed-after-admission';
    expect(storage.upsert).not.toHaveBeenCalled();
    expect(storage.deleteVersion).not.toHaveBeenCalled();
    expect(service.maintenance.pauseAdmissions('hold')).toBe(true);
    expect(await service.maintenance.getMaintenanceCensus('hold')).toMatchObject({
      admissionClosed: true,
      pendingWrites: 2,
      complete: true,
    });
    await expect(service.persist(scope)).rejects.toThrow('ADMISSION_CLOSED');
    await expect(service.clear(scope, 'new')).rejects.toThrow('ADMISSION_CLOSED');
    expect(storage.upsert).toHaveBeenCalledWith(expect.objectContaining({ scope }));
    expect(storage.deleteVersion).toHaveBeenCalledWith({
      scope,
      tenantId: 'tenant-a',
      version: 'original-version',
    });
    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
    upsert.resolve();
    await persist;
    expect(stopped).toBe(false);
    deletion.resolve();
    await clear;
    await stopping;
    expect(service.maintenance.resumeAdmissions('hold')).toBe(false);
  });

  it('retains timed-out publication and its later exact-version delete across reconfiguration', async () => {
    jest.useFakeTimers();
    const { service, storage, runInRetryScope } = createHarness();
    const version = await service.persist(scope);
    const publication = deferred();
    const deletion = deferred();
    const first = jest.fn(() => publication.promise);
    const replacement = jest.fn().mockResolvedValue(undefined);
    (storage.deleteVersion as jest.Mock).mockReturnValueOnce(deletion.promise);
    service.start(first, { intervalMs: 10_000, attemptTimeoutMs: 5 });
    const batch = service.drain();
    await jest.advanceTimersByTimeAsync(5);
    await batch;
    expect(service.maintenance.pauseAdmissions('hold')).toBe(true);
    service.start(replacement, { intervalMs: 1 });
    await jest.advanceTimersByTimeAsync(100);
    expect(replacement).not.toHaveBeenCalled();
    expect((await service.maintenance.getMaintenanceCensus('hold')).pendingWrites).toBe(1);
    let stopped = false;
    const stopping = service.stop().then(() => {
      stopped = true;
    });
    publication.resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    expect(storage.deleteVersion).toHaveBeenCalledWith({ scope, tenantId: 'tenant-a', version });
    expect(runInRetryScope).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-a', version }),
      expect.any(Function),
    );
    deletion.resolve();
    await stopping;
    expect((await service.maintenance.getMaintenanceCensus('hold')).pendingWrites).toBe(0);
  });

  it('keeps the admitted callback and batch policy when list resolves after paused reconfiguration', async () => {
    jest.useFakeTimers();
    const { service, storage } = createHarness();
    const list = deferred<readonly MCPAuthorizationFenceRetryRecord[]>();
    (storage.list as jest.Mock).mockReturnValueOnce(list.promise);
    const first = jest.fn().mockResolvedValue(undefined);
    const next = jest.fn().mockResolvedValue(undefined);
    service.start(first, { batchSize: 7, intervalMs: 10_000 });
    const batch = service.drain();
    expect(service.maintenance.pauseAdmissions('hold')).toBe(true);
    service.start(next, { batchSize: 1, intervalMs: 1 });
    await jest.advanceTimersByTimeAsync(20);
    expect(storage.list).toHaveBeenCalledTimes(1);
    expect(storage.list).toHaveBeenCalledWith(7);
    list.resolve([
      { ...scope, tenantId: 'tenant-original', version: 'version-original', updatedAt: new Date() },
    ]);
    await batch;
    expect(first).toHaveBeenCalledWith(scope);
    expect(next).not.toHaveBeenCalled();
    expect(storage.deleteVersion).toHaveBeenCalledWith({
      scope,
      tenantId: 'tenant-original',
      version: 'version-original',
    });
    await service.stop();
  });

  it.each(['invalidation', 'delete', 'defer', 'list', 'upsert'] as const)(
    'latches late %s rejection without an unhandled bookkeeping promise',
    async (phase) => {
      jest.useFakeTimers();
      const { service, storage } = createHarness();
      await service.persist(scope);
      const original = deferred();
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);
      let observed: Promise<unknown> = Promise.resolve();
      try {
        if (phase === 'upsert') {
          (storage.upsert as jest.Mock).mockReturnValueOnce(original.promise);
          observed = service.persist(scope).catch(() => undefined);
        } else {
          if (phase === 'delete')
            (storage.deleteVersion as jest.Mock).mockReturnValueOnce(original.promise);
          if (phase === 'defer')
            (storage.deferVersion as jest.Mock).mockReturnValueOnce(original.promise);
          if (phase === 'list') (storage.list as jest.Mock).mockReturnValueOnce(original.promise);
          let invalidate: () => Promise<void> = async () => undefined;
          if (phase === 'invalidation') invalidate = () => original.promise;
          if (phase === 'defer') {
            invalidate = async () => {
              throw new Error('publication failed');
            };
          }
          service.start(invalidate, { intervalMs: 10_000, attemptTimeoutMs: 5 });
          observed = service.drain().catch(() => undefined);
        }
        await jest.advanceTimersByTimeAsync(10);
        expect(service.maintenance.pauseAdmissions('hold')).toBe(true);
        expect(
          (await service.maintenance.getMaintenanceCensus('hold')).pendingWrites,
        ).toBeGreaterThan(0);
        original.reject(new Error('late producer failure'));
        await observed;
        await jest.advanceTimersByTimeAsync(0);
        expect(await service.maintenance.getMaintenanceCensus('hold')).toMatchObject({
          pendingWrites: 0,
          complete: false,
          admissionClosed: true,
        });
        expect(service.maintenance.resumeAdmissions('hold')).toBe(false);
        await expect(service.stop()).rejects.toThrow('SETTLEMENT_UNCONFIRMED');
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.removeListener('unhandledRejection', unhandled);
      }
    },
  );

  it('keeps pause identity current and starts no interval while configured closed', async () => {
    jest.useFakeTimers();
    const { service, storage } = createHarness();
    expect(service.maintenance.pauseAdmissions('one')).toBe(true);
    expect(service.maintenance.pauseAdmissions('two')).toBe(false);
    service.start(jest.fn().mockResolvedValue(undefined), { intervalMs: 3 });
    await jest.advanceTimersByTimeAsync(30);
    expect(storage.list).not.toHaveBeenCalled();
    await expect(service.drain()).rejects.toThrow('ADMISSION_CLOSED');
    expect(service.maintenance.resumeAdmissions('two')).toBe(false);
    const stale = service.maintenance.getMaintenanceCensus('one');
    expect(service.maintenance.resumeAdmissions('one')).toBe(true);
    expect(service.maintenance.pauseAdmissions('two')).toBe(true);
    expect((await stale).complete).toBe(false);
    expect((await service.maintenance.getMaintenanceCensus('one')).complete).toBe(false);
    expect(service.maintenance.resumeAdmissions('two')).toBe(true);
    await jest.advanceTimersByTimeAsync(3);
    expect(storage.list).toHaveBeenCalledTimes(1);
    await service.stop();
    service.start(jest.fn(), { intervalMs: 1 });
    await jest.advanceTimersByTimeAsync(10);
    expect(storage.list).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'holds the real raw index/list chain through stop (reject=%s)',
    async (reject) => {
      const index = deferred<string>();
      const rows = deferred<[]>();
      const collection = {
        createIndex: jest.fn(() => index.promise),
        find: jest.fn(() => ({ sort: () => ({ limit: () => ({ toArray: () => rows.promise }) }) })),
      };
      const mongoose = { connection: { collection: jest.fn(() => collection) } };
      const service = createMCPAuthorizationFenceRetryService({
        storage: createMCPAuthorizationFenceRetryStorage(
          mongoose as unknown as typeof import('mongoose'),
        ),
        getTenantId: () => 'tenant-a',
        runInRetryScope: async (_retry, operation) => operation(),
        registerShutdown: jest.fn(),
      });
      expect(mongoose.connection.collection).not.toHaveBeenCalled();
      service.start(async () => undefined);
      const batch = service.drain().catch(() => undefined);
      expect(service.maintenance.pauseAdmissions('hold')).toBe(true);
      await service.maintenance.getMaintenanceCensus('hold');
      expect(collection.createIndex).toHaveBeenCalledWith(
        { updatedAt: 1 },
        { name: 'updatedAt_1' },
      );
      expect(collection.find).not.toHaveBeenCalled();
      let stopped = false;
      const stopping = service.stop();
      const settled = stopping.then(
        () => {
          stopped = true;
        },
        () => {
          stopped = true;
        },
      );
      if (reject) index.reject(new Error('index outcome unknown'));
      else {
        index.resolve('updatedAt_1');
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(collection.find).toHaveBeenCalledWith({});
        expect(stopped).toBe(false);
        rows.resolve([]);
      }
      await batch;
      await settled;
      expect((await service.maintenance.getMaintenanceCensus('hold')).complete).toBe(!reject);
      if (reject) await expect(stopping).rejects.toThrow('SETTLEMENT_UNCONFIRMED');
      else await stopping;
    },
  );
});
import { createMCPAuthorizationFenceRetryStorage } from '@librechat/data-schemas';
