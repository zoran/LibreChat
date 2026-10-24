import { EventEmitter } from 'node:events';
import { CacheKeys } from 'librechat-data-provider';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AppConfig } from '@librechat/data-schemas';
import type { LCAvailableTools } from '../types';
import type { CatalogStoreDeps } from './store';
import { notifyMCPToolsChanged, setMCPToolsChangedHandler } from '../toolsChanged';
import { NOT_OWNED_STORAGE_PROVIDERS } from '../../storage/providerObservation';
import { createAppMaintenance } from '../../app/maintenance';
import { createAppConfigService } from '../../app/service';
import { createMCPCatalogStore } from './store';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 40; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('Catalog original was not dispatched');
}
function fixture(shared = false) {
  const values = new Map<string, unknown>();
  const cache = Object.assign(new EventEmitter(), {
    get: jest.fn(async (key: string) => values.get(key)),
    set: jest.fn(async (key: string, value: unknown) => {
      values.set(key, value);
      return true;
    }),
    delete: jest.fn(async (key: string) => values.delete(key)),
  });
  const redis = { set: jest.fn(async () => 'OK'), eval: jest.fn(async () => 1) };
  const keyv = {
    eval: jest.fn<Promise<unknown>, [string, { keys: string[]; arguments: string[] }]>(
      async () => 1,
    ),
  };
  const deps: CatalogStoreDeps = {
    getCache: () => cache,
    cacheConfig: {},
    ...(shared ? { ioredisClient: redis, keyvRedisClient: keyv } : {}),
  };
  const store = createMCPCatalogStore(deps);
  return { store, cache, values, redis, keyv, deps };
}

afterEach(() => {
  setMCPToolsChangedHandler(null);
  jest.useRealTimers();
});

describe('MCP catalog original custody', () => {
  test('retains actual write and both captured cleanup originals through pause and drain', async () => {
    const f = fixture(true);
    const write = deferred<unknown>(),
      fence = deferred<unknown>(),
      lock = deferred<number>();
    f.keyv.eval
      .mockResolvedValueOnce(1)
      .mockImplementationOnce(() => write.promise)
      .mockImplementationOnce(() => fence.promise);
    f.redis.eval.mockImplementationOnce(() => lock.promise);
    const work = f.store.updateCachedGlobalTools(() => ({}));
    const settled = work.then(() => true);
    await until(() => f.keyv.eval.mock.calls.length === 2);
    f.store.maintenance.pauseAdmissions('catalog');
    let drained = false;
    const drain = f.store.maintenance.drain().then(() => {
      drained = true;
    });
    try {
      await expect(f.store.setCachedTools({})).rejects.toThrow('APP_QUIESCING');
      expect(await f.store.maintenance.getMaintenanceCensus('catalog')).toMatchObject({
        queuedContinuations: 1,
        pendingWrites: 1,
      });
      f.deps.keyvRedisClient = {
        eval: jest.fn(async () => {
          throw new Error('replacement');
        }),
      };
      write.resolve(1);
      await until(() => f.keyv.eval.mock.calls.length === 3);
      expect(drained).toBe(false);
      // Cleanup must use the acquired client's captured release, even if the dependency drifts.
      fence.resolve(1);
      await until(() => f.redis.eval.mock.calls.length === 1);
      expect(drained).toBe(false);
      lock.resolve(1);
      await settled;
      await drain;
      expect(await f.store.maintenance.getMaintenanceCensus('catalog')).toMatchObject({
        queuedContinuations: 0,
        pendingWrites: 0,
        complete: true,
      });
    } finally {
      write.resolve(1);
      fence.resolve(1);
      lock.resolve(1);
    }
  });

  test.each(['write', 'fence', 'lock'])(
    'preserves %s failure before cleanup or caller normalization',
    async (stage) => {
      const f = fixture(true);
      const failure = new Error(stage);
      const cleanupFailure = new Error('later cleanup');
      if (stage === 'write')
        f.keyv.eval
          .mockResolvedValueOnce(1)
          .mockRejectedValueOnce(failure)
          .mockRejectedValueOnce(cleanupFailure);
      if (stage === 'fence')
        f.keyv.eval
          .mockResolvedValueOnce(1)
          .mockResolvedValueOnce(1)
          .mockRejectedValueOnce(failure);
      if (stage === 'lock') f.redis.eval.mockRejectedValueOnce(failure);
      const outcome = await f.store.updateCachedGlobalTools(() => ({})).catch((error) => error);
      expect(outcome).toBe(stage === 'write' ? failure : undefined);
      f.store.maintenance.pauseAdmissions('catalog');
      expect(await f.store.maintenance.getMaintenanceCensus('catalog')).toMatchObject({
        complete: false,
      });
      await expect(f.store.maintenance.drain()).rejects.toMatchObject({ cause: failure });
    },
  );

  test.each(['set-false', 'error-event'])(
    'retains Keyv %s failure while keeping existing result semantics',
    async (kind) => {
      const f = fixture();
      f.cache.set.mockImplementationOnce(async () => {
        if (kind === 'error-event') f.cache.emit('error', new Error('cache error'));
        return false;
      });
      expect(await f.store.setCachedTools({})).toBe(false);
      f.store.maintenance.pauseAdmissions('catalog');
      expect(await f.store.maintenance.getMaintenanceCensus('catalog')).toMatchObject({
        complete: false,
      });
      await expect(f.store.maintenance.drain()).rejects.toThrow(
        'MCP_CATALOG_SETTLEMENT_UNCONFIRMED',
      );
      expect(f.cache.listenerCount('error')).toBe(0);
    },
  );

  test('keeps acknowledged stale generation and absent delete non-failing', async () => {
    const f = fixture(true);
    f.keyv.eval.mockResolvedValue(0);
    expect(
      await f.store.renewMCPToolsCacheGeneration({
        userId: 'user',
        serverName: 'server',
        publicationGeneration: 'old',
      }),
    ).toBe(false);
    const local = fixture();
    await local.store.invalidateCachedTools({ invalidateGlobal: true });
    f.store.maintenance.pauseAdmissions('catalog');
    local.store.maintenance.pauseAdmissions('catalog');
    expect(await f.store.maintenance.getMaintenanceCensus('catalog')).toMatchObject({
      complete: true,
    });
    expect(await local.store.maintenance.getMaintenanceCensus('catalog')).toMatchObject({
      complete: true,
    });
    await Promise.all([f.store.maintenance.drain(), local.store.maintenance.drain()]);
  });

  test.each(['generation', 'renewal', 'revision'])(
    'retains the %s allocator original',
    async (operation) => {
      const f = fixture(true);
      const gate = deferred<unknown>();
      f.keyv.eval.mockImplementation(() => gate.promise);
      let work: Promise<string | boolean | undefined>;
      if (operation === 'generation') {
        work = f.store.getMCPToolsCacheGeneration({ userId: 'user', serverName: 'server' });
      } else if (operation === 'renewal') {
        work = f.store.renewMCPToolsCacheGeneration({
          userId: 'user',
          serverName: 'server',
          publicationGeneration: 'generation',
        });
      } else {
        work = f.store.getNextAppToolsPublicationRevision('server', 'config');
      }
      const outcome = work.catch((error) => error);
      await until(() => f.keyv.eval.mock.calls.length > 0);
      f.store.maintenance.pauseAdmissions('catalog');
      try {
        expect(await f.store.maintenance.getMaintenanceCensus('catalog')).toMatchObject({
          queuedContinuations: 1,
          pendingWrites: 1,
        });
      } finally {
        gate.resolve(1);
      }
      await outcome;
      await f.store.maintenance.drain();
    },
  );

  test.each(['resolve', 'reject'])(
    'retains an accepted child after its caller rejects: %s',
    async (outcome) => {
      const f = fixture();
      const gate = deferred<boolean>();
      f.cache.set.mockImplementationOnce(() => gate.promise);
      let child: Promise<boolean> | undefined;
      const failure = new Error('caller failed');
      const effectFailure = new Error('child write failed');
      const parent = f.store
        .trackPublication(async () => {
          child = f.store.setCachedTools({});
          void child.catch(() => undefined);
          await until(() => f.cache.set.mock.calls.length > 0);
          throw failure;
        })
        .catch((error) => error);
      expect(await parent).toBe(failure);
      f.store.maintenance.pauseAdmissions('catalog');
      let settled = false;
      const drain = f.store.maintenance.drain();
      void drain.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        expect(await f.store.maintenance.getMaintenanceCensus('catalog')).toMatchObject({
          queuedContinuations: 1,
          pendingWrites: 1,
          complete: true,
        });
        expect(settled).toBe(false);
      } finally {
        if (outcome === 'resolve') gate.resolve(true);
        else gate.reject(effectFailure);
      }
      if (outcome === 'resolve') {
        await expect(child).resolves.toBe(true);
        await expect(drain).resolves.toBeUndefined();
      } else {
        await expect(child).rejects.toBe(effectFailure);
        await expect(drain).rejects.toMatchObject({ cause: effectFailure });
      }
      expect(await f.store.maintenance.getMaintenanceCensus('catalog')).toMatchObject({
        queuedContinuations: 0,
        pendingWrites: 0,
        complete: outcome === 'resolve',
      });
    },
  );

  test('rejects stale publication context and permits a fresh post-resume root', async () => {
    const f = fixture();
    let stale!: ReturnType<typeof AsyncLocalStorage.snapshot>;
    await f.store.trackPublication(async () => {
      stale = AsyncLocalStorage.snapshot();
    });
    f.store.maintenance.pauseAdmissions('catalog');
    await expect(f.store.setCachedTools({})).rejects.toThrow('APP_QUIESCING');
    expect(f.cache.set).not.toHaveBeenCalled();
    expect(f.store.maintenance.resumeAdmissions('catalog')).toBe(true);
    expect(await f.store.setCachedTools({})).toBe(true);
    await expect(stale(() => f.store.setCachedTools({}))).rejects.toThrow(
      'continuation used after settlement',
    );
    expect(f.cache.set).toHaveBeenCalledTimes(1);
  });

  test('existing retry timer dispatches no storage while paused and publishes after exact resume', async () => {
    jest.useFakeTimers();
    const f = fixture();
    setMCPToolsChangedHandler(() => f.store.setCachedTools({}).then(() => undefined));
    f.store.maintenance.pauseAdmissions('catalog');
    await notifyMCPToolsChanged({
      serverName: 'server',
      tools: [],
      serverConfig: { type: 'stdio', command: 'fixture', args: [] },
    });
    await jest.advanceTimersByTimeAsync(250);
    expect(f.cache.get).not.toHaveBeenCalled();
    expect(f.cache.set).not.toHaveBeenCalled();
    expect(f.store.maintenance.resumeAdmissions('wrong')).toBe(false);
    expect(f.store.maintenance.resumeAdmissions('catalog')).toBe(true);
    await jest.advanceTimersByTimeAsync(500);
    expect(f.cache.set).toHaveBeenCalledTimes(1);
    await f.store.maintenance.drain();
    expect(f.store.maintenance.resumeAdmissions('catalog')).toBe(false);
  });

  test('actual closed App admits only its preexisting cold-config preparation and retains unknown groups', async () => {
    const f = fixture();
    const write = deferred<boolean>();
    f.cache.set.mockImplementationOnce(() => write.promise);
    const values = new Map<string, unknown>();
    const config = createAppConfigService({
      loadBaseConfig: async () => ({ availableTools: {} }) as AppConfig,
      setCachedTools: async (tools) => {
        await f.store.setCachedTools(tools as LCAvailableTools);
      },
      getCache: () => ({
        get: async (key: string) => values.get(key),
        set: async (key: string, value: unknown) => {
          values.set(key, value);
          return true;
        },
        delete: async (key: string) => values.delete(key),
      }),
      cacheKeys: CacheKeys,
      getApplicableConfigs: async () => [],
      getUserPrincipals: async () => [],
    });
    const unknown = [
      'raw database commands, sessions and independent writers outside qualified owners',
      'standalone tag/share and other HTTP mutations',
      'MCP/OAuth reconnect, search indexing, code lifecycle and remaining background owners',
    ];
    let app!: ReturnType<typeof createAppMaintenance>;
    const prepare = f.store.trackPublication(async () => {
      app = createAppMaintenance({
        readStorageProviders: () => NOT_OWNED_STORAGE_PROVIDERS,
        env: {
          LIBRECHAT_MAINTENANCE_TOKEN: 'a'.repeat(32),
          POD_UID: '12345678-1234-1234-1234-123456789012',
          BUILD_COMMIT: 'a'.repeat(40),
        },
        requiredSharedState: true,
        startupAdmission: 'closed',
        workOwners: { mcpCatalog: f.store.maintenance },
        fileDomainOwners: [],
        unqualifiedOwners: unknown,
        generation: {
          closeGenerationAdmission: () => true,
          reopenGenerationAdmission: () => true,
          getGenerationAdmissionCensus: async () => ({
            admissionClosed: true,
            initializing: 0,
            providerExecutions: 0,
            queuedContinuations: 0,
            pendingWrites: 0,
            activeStreams: 0,
            unresolved: 0,
            complete: true,
          }),
          getGenerationRuntimeHealth: async () => true,
        },
        startupReady: () => false,
        probeDatabase: async () => true,
        probeSharedState: async () => true,
      });
      return config.getAppConfig({ baseOnly: true });
    });
    await until(() => f.cache.set.mock.calls.length > 0);
    const id = `startup_${app.identity.incarnation}`;
    try {
      expect(await f.store.maintenance.getMaintenanceCensus(id)).toMatchObject({
        admissionClosed: true,
        queuedContinuations: 1,
        pendingWrites: 1,
      });
      await expect(f.store.setCachedTools({})).rejects.toThrow('APP_QUIESCING');
    } finally {
      write.resolve(true);
    }
    await prepare;
    expect(await f.store.maintenance.getMaintenanceCensus(id)).toMatchObject({
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
    expect(await app.externalCensus()).toMatchObject({ complete: false });
    const controller = new AbortController();
    const release = app.waitForStartupRelease(controller.signal).catch((error) => error);
    await f.store.maintenance.drain();
    const aborted = new Error('startup cancelled');
    controller.abort(aborted);
    expect(await release).toBe(aborted);
    await app.close();
  });
});
