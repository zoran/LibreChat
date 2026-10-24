import { NOT_OWNED_STORAGE_PROVIDERS } from '../storage/providerObservation';
/** Real Keyv/Auth/legacy consumers retain Mongo originals across pause and normalized failure. */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';
import type { FindCursor } from 'mongodb';
import type { Keyv } from 'keyv';
import type { AuthMaintenance } from '../auth/maintenance';

interface LegacyAuthExports {
  legacyAuthMaintenance: AuthMaintenance;
  withAuthRequest: AuthMaintenance['run'];
  authCache(store: Keyv): Pick<Keyv, 'get' | 'set' | 'delete'>;
}
type CheckBan = (
  req: Pick<Request, 'ip' | 'body' | 'headers' | 'method'>,
  res: Pick<Response, 'status' | 'json'>,
  next: NextFunction,
) => Promise<unknown>;
type CacheCursor = Pick<FindCursor<{ key: string; value: unknown }>, 'toArray'> & {
  project(...projection: Parameters<FindCursor['project']>): CacheCursor;
};

const releases: Array<() => void> = [];
const originals: Array<Promise<unknown>> = [];
const owners: Array<{ drain(): Promise<void> }> = [];
function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  releases.push(() => resolve(fallback));
  return { promise, resolve, reject };
}
function original<T>(promise: Promise<T>): Promise<T> {
  originals.push(promise.catch(() => undefined));
  return promise;
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  await Promise.all(originals.splice(0));
  await Promise.all(owners.splice(0).map((owner) => owner.drain().catch(() => undefined)));
});

/** Only external Mongo/config/integration dependencies are inert; every selected owner is real. */
function fixture() {
  jest.resetModules();
  const documents = new Map<string, unknown>();
  const collection = {
    findOne: jest.fn(async (filter) =>
      documents.has(filter.key.$eq) ? { value: documents.get(filter.key.$eq) } : null,
    ),
    updateOne: jest.fn(async (filter, update) => {
      documents.set(filter.key.$eq, update.$set.value);
      return { acknowledged: true };
    }),
    deleteOne: jest.fn(async (filter) => ({
      deletedCount: Number(documents.delete(filter.key.$eq)),
    })),
    deleteMany: jest.fn(async (filter) => {
      const keys = filter.key.$in ?? [...documents.keys()];
      return {
        deletedCount: keys.reduce((n: number, key: string) => n + Number(documents.delete(key)), 0),
      };
    }),
    countDocuments: jest.fn(async (filter) => Number(documents.has(filter.key.$eq))),
    find: jest.fn((filter) => {
      const cursor: CacheCursor = {
        project: jest.fn(() => cursor),
        toArray: jest.fn(async () =>
          filter.key.$in.flatMap((key: string) =>
            documents.has(key) ? [{ key, value: documents.get(key) }] : [],
          ),
        ),
      };
      return cursor;
    }),
  };
  const database = { collection: jest.fn(() => collection) };
  const connection = { readyState: 1, db: database };
  const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() };
  jest.doMock('mongoose', () => ({ __esModule: true, default: { connection } }));
  jest.doMock('@librechat/data-schemas', () => ({ logger }));
  const cache = jest.requireActual<typeof import('./keyvMongo')>('./keyvMongo');
  const authModule =
    jest.requireActual<typeof import('../auth/maintenance')>('../auth/maintenance');
  const { Keyv } = jest.requireActual<typeof import('keyv')>('keyv');
  const provider =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  const api = {
    ...authModule,
    ...cache,
    keyvMongo: cache.default,
    createAuthSessionStore: () => {
      throw new Error('Session store is outside this fixture');
    },
    logFile: new Map(),
    cacheConfig: { CI: true, USE_REDIS: false, BAN_DURATION: 60_000 },
    sessionCache: () => new Keyv(),
    standardCache: () => new Keyv(),
    violationCache: () => new Keyv(),
    userPrincipalsCache: () => undefined,
    registerShutdownTask: () => {
      throw new Error('CI cache fixture cannot start a background task');
    },
    isEnabled: (value: string) => value === 'true',
    removePorts: (req: { ip: string }) => req.ip,
    getBanIp: ({ ip }: { ip: string }) => ip,
  };
  const load = <T>(relative: string, dependencies: Record<string, unknown>): T => {
    const filename = path.resolve(__dirname, '../../../../', relative);
    const module = { exports: {} };
    vm.runInNewContext(
      fs.readFileSync(filename, 'utf8'),
      {
        module,
        exports: module.exports,
        require: (name: string) => {
          if (!(name in dependencies))
            throw new Error(`Unexpected ${relative} dependency: ${name}`);
          return dependencies[name];
        },
        Buffer,
        process: { env: { BAN_VIOLATIONS: 'true', USE_REDIS: 'false' } },
        global: {},
        console,
      },
      { filename },
    );
    return module.exports as T;
  };
  const legacy = load<LegacyAuthExports>('api/server/services/LegacyAuthMaintenance.js', {
    '@librechat/api': api,
  });
  const getLogStores = load<(cacheName: string) => Keyv>('api/cache/getLogStores.js', {
    keyv: { Keyv },
    'librechat-data-provider': provider,
    '@librechat/api': api,
  });
  const findUser = jest.fn(async () => null as unknown);
  const checkBan = load<CheckBan>('api/server/middleware/checkBan.js', {
    '~/server/services/LegacyAuthMaintenance': legacy,
    keyv: { Keyv },
    'ua-parser-js': () => ({ browser: {} }),
    '@librechat/data-schemas': { logger },
    'librechat-data-provider': provider,
    '@librechat/api': api,
    '~/cache': { getLogStores },
    './oauthNavigation': { isOAuthNavigation: () => false, redirectOAuthFailure: jest.fn() },
    './denyRequest': jest.fn(),
    '~/models': { findUser },
  });
  const actions = load<{
    domainParser(domain: string, inverse?: boolean): Promise<string | undefined>;
  }>('api/server/services/ActionService.js', {
    jsonwebtoken: {},
    nanoid: {},
    '@librechat/agents': {},
    '@librechat/agents/langchain/tools': {},
    '@librechat/data-schemas': { logger },
    '@librechat/api': api,
    'librechat-data-provider': provider,
    '~/models': {},
    '~/config': {},
    '~/cache': { getLogStores },
  });
  owners.push(cache.mongoCacheMaintenance);
  return {
    cache,
    legacy,
    auth: legacy.legacyAuthMaintenance,
    Keyv,
    provider,
    collection,
    connection,
    database,
    documents,
    findUser,
    checkBan,
    actions,
    bans: getLogStores(provider.ViolationTypes.BAN),
    domains: getLogStores(provider.CacheKeys.ENCODED_DOMAINS),
  };
}

test('actual domain parser retains read-to-write work while new and foreign work is fenced', async () => {
  const f = fixture();
  const read = deferred<null>(null);
  const write = deferred({ acknowledged: true });
  f.collection.findOne.mockReturnValueOnce(read.promise);
  f.collection.updateOne.mockReturnValueOnce(write.promise);
  const hostname = `${'a'.repeat(80)}.example.test`;
  const parsing = original(f.actions.domainParser(hostname, true));
  await tick();
  expect(f.collection.findOne).toHaveBeenCalledTimes(1);
  expect(f.cache.mongoCacheMaintenance.maintenance.pauseAdmissions('cache')).toBe(true);
  await expect(f.actions.domainParser('new.example', true)).rejects.toThrow('APP_QUIESCING');
  await expect(f.domains.get('foreign')).rejects.toThrow('APP_QUIESCING');
  await expect(f.cache.default.set('raw', 'value')).rejects.toThrow('APP_QUIESCING');
  expect(f.collection.updateOne).not.toHaveBeenCalled();
  read.resolve(null);
  await tick();
  expect(f.collection.updateOne).toHaveBeenCalledTimes(1);
  const census = await f.cache.mongoCacheMaintenance.maintenance.getMaintenanceCensus('cache');
  expect(census.queuedContinuations).toBeGreaterThan(0);
  expect(census.pendingWrites).toBeGreaterThan(0);
  let drained = false;
  const draining = original(
    f.cache.mongoCacheMaintenance.drain().then(() => {
      drained = true;
    }),
  );
  await tick();
  expect(drained).toBe(false);
  write.resolve({ acknowledged: true });
  expect(await parsing).toBe(
    Buffer.from(hostname).toString('base64').slice(0, f.provider.Constants.ENCODED_DOMAIN_LENGTH),
  );
  await draining;
  expect(f.database.collection).toHaveBeenCalledWith('logs');
});

test('cache-only pause closes new Auth roots but the actual old Auth root can serialize its first child', async () => {
  const f = fixture();
  const preparing = deferred(undefined);
  const serializing = deferred(undefined);
  const writing = deferred({ acknowledged: true });
  f.bans.serialize = async (value: unknown) => {
    await serializing.promise;
    return JSON.stringify(value);
  };
  f.collection.updateOne.mockReturnValueOnce(writing.promise);
  const work = original(
    f.legacy.withAuthRequest({}, async () => {
      await preparing.promise;
      return f.legacy.authCache(f.bans).set('accepted', 'value');
    }),
  );
  expect(f.cache.mongoCacheMaintenance.maintenance.pauseAdmissions('cache')).toBe(true);
  const newWork = jest.fn();
  await expect(f.auth.run(undefined, newWork)).rejects.toThrow('APP_QUIESCING');
  expect(newWork).not.toHaveBeenCalled();
  const foreign = jest
    .requireActual<typeof import('../auth/maintenance')>('../auth/maintenance')
    .createAuthMaintenance();
  await expect(foreign.run(undefined, () => f.bans.get('foreign'))).rejects.toThrow(
    'APP_QUIESCING',
  );
  let drained = false;
  const draining = original(
    f.cache.mongoCacheMaintenance.drain().then(() => {
      drained = true;
    }),
  );
  preparing.resolve(undefined);
  await tick();
  expect(f.collection.updateOne).not.toHaveBeenCalled();
  expect(
    (await f.cache.mongoCacheMaintenance.maintenance.getMaintenanceCensus('cache'))
      .queuedContinuations,
  ).toBeGreaterThan(0);
  serializing.resolve(undefined);
  await tick();
  expect(f.collection.updateOne).toHaveBeenCalledTimes(1);
  expect(drained).toBe(false);
  writing.resolve({ acknowledged: true });
  expect(await work).toBe(true);
  await draining;
});

test('real Keyv expired read retains deserialization and its later delete', async () => {
  const f = fixture();
  const deserializing = deferred(undefined);
  const deleting = deferred({ deletedCount: 1 });
  f.bans.deserialize = async (value: string) => {
    await deserializing.promise;
    return JSON.parse(value);
  };
  f.documents.set(`${f.bans.namespace}:expired`, JSON.stringify({ value: 'old', expires: 1 }));
  f.collection.deleteOne.mockReturnValueOnce(deleting.promise);
  const reading = original(f.bans.get('expired'));
  await tick();
  expect(f.cache.mongoCacheMaintenance.maintenance.pauseAdmissions('cache')).toBe(true);
  expect(f.collection.deleteOne).not.toHaveBeenCalled();
  deserializing.resolve(undefined);
  await tick();
  expect(f.collection.deleteOne).toHaveBeenCalledTimes(1);
  expect(
    (await f.cache.mongoCacheMaintenance.maintenance.getMaintenanceCensus('cache')).pendingWrites,
  ).toBeGreaterThan(0);
  deleting.resolve({ deletedCount: 1 });
  expect(await reading).toBeUndefined();
  await expect(f.cache.mongoCacheMaintenance.drain()).resolves.toBeUndefined();
});

test('Keyv setMany early normalized failure retains a serializing sibling and its actual Auth parent', async () => {
  const f = fixture();
  const serializing = deferred(undefined);
  const writing = deferred({ acknowledged: true });
  f.bans.serialize = async (value: unknown) => {
    await serializing.promise;
    return JSON.stringify(value);
  };
  f.collection.updateOne.mockReturnValueOnce(writing.promise);
  const result = original(
    f.bans.setMany([
      { key: 'failed', value: Symbol('unserializable') },
      { key: 'held', value: 'value' },
    ]),
  );
  expect(await result).toEqual([false, false]);
  expect(f.cache.mongoCacheMaintenance.maintenance.pauseAdmissions('cache')).toBe(true);
  const census = await f.cache.mongoCacheMaintenance.maintenance.getMaintenanceCensus('cache');
  expect(census.complete).toBe(false);
  expect(census.queuedContinuations).toBeGreaterThan(0);
  let settled = false;
  const draining = original(
    f.cache.mongoCacheMaintenance.drain().catch((error: Error) => {
      settled = true;
      throw error;
    }),
  );
  serializing.resolve(undefined);
  await tick();
  expect(f.collection.updateOne).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  writing.resolve({ acknowledged: true });
  await expect(draining).rejects.toThrow('MONGO_CACHE_SETTLEMENT_UNCONFIRMED');
  expect(f.cache.mongoCacheMaintenance.maintenance.resumeAdmissions('cache')).toBe(false);
});

test.each(['get', 'set', 'delete'] as const)(
  'raw %s failure remains a veto below Keyv normalization',
  async (method) => {
    const f = fixture();
    const driver = {
      get: f.collection.findOne,
      set: f.collection.updateOne,
      delete: f.collection.deleteOne,
    }[method];
    driver.mockRejectedValueOnce(new Error('original Mongo command failed'));
    const result =
      method === 'set' ? await f.bans.set('key', 'value') : await f.bans[method]('key');
    expect(result).toBe(method === 'get' ? undefined : false);
    expect(driver).toHaveBeenCalledTimes(1);
    f.cache.mongoCacheMaintenance.maintenance.pauseAdmissions('cache');
    expect(
      await f.cache.mongoCacheMaintenance.maintenance.getMaintenanceCensus('cache'),
    ).toMatchObject({ complete: false });
    expect(f.cache.mongoCacheMaintenance.maintenance.resumeAdmissions('cache')).toBe(false);
    await expect(f.cache.mongoCacheMaintenance.drain()).rejects.toThrow(
      'MONGO_CACHE_SETTLEMENT_UNCONFIRMED',
    );
  },
);

test.each(['receiver', 'store', 'opts.store'] as const)(
  'facade %s mismatch refuses before Mongo work and vetoes settlement',
  async (mismatch) => {
    const f = fixture();
    const facade = f.bans;
    const method = facade.set;
    const owner = facade.store;
    const foreign = new f.Keyv();
    if (mismatch === 'store') facade.store = foreign.store;
    if (mismatch === 'opts.store') {
      facade.opts.store = foreign.store;
      expect(facade.store).toBe(owner);
    }
    const receiver = mismatch === 'receiver' ? foreign : facade;
    await expect(Reflect.apply(method, receiver, ['forbidden', 'value'])).rejects.toThrow(
      'APP_QUIESCING',
    );
    for (const command of Object.values(f.collection)) expect(command).not.toHaveBeenCalled();
    f.cache.mongoCacheMaintenance.maintenance.pauseAdmissions('cache');
    expect(
      await f.cache.mongoCacheMaintenance.maintenance.getMaintenanceCensus('cache'),
    ).toMatchObject({ complete: false });
    await expect(f.cache.mongoCacheMaintenance.drain()).rejects.toThrow(
      'MONGO_CACHE_SETTLEMENT_UNCONFIRMED',
    );
  },
);

test('acknowledged no-match delete is settled, and cache reopening never reopens Auth', async () => {
  const f = fixture();
  expect(await f.bans.delete('absent')).toBe(false);
  f.cache.mongoCacheMaintenance.maintenance.pauseAdmissions('cache');
  expect(await f.cache.mongoCacheMaintenance.maintenance.getMaintenanceCensus('cache')).toEqual({
    admissionClosed: true,
    queuedContinuations: 0,
    pendingWrites: 0,
    complete: true,
  });
  expect(f.cache.mongoCacheMaintenance.maintenance.resumeAdmissions('cache')).toBe(true);
  await expect(f.bans.get('new')).rejects.toThrow('APP_QUIESCING');
  expect(f.auth.resumeAdmissions('cache')).toBe(true);
  expect(await f.bans.get('new')).toBeUndefined();
});

test('actual checkBan preparation can finish its first Mongo cache writes after cache-only pause', async () => {
  const f = fixture();
  const preparing = deferred<unknown>(null);
  const writing = deferred({ acknowledged: true });
  await f.bans.set('accepted-user', { expiresAt: Date.now() + 30_000 });
  f.collection.updateOne.mockClear();
  f.collection.updateOne.mockReturnValueOnce(writing.promise);
  f.findUser.mockReturnValueOnce(preparing.promise);
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  const req = { ip: '', body: { email: 'fixture@example.test' }, headers: {}, method: 'GET' };
  const next = jest.fn();
  const checking = original(f.checkBan(req, res, next));
  f.cache.mongoCacheMaintenance.maintenance.pauseAdmissions('cache');
  await expect(f.checkBan({ ...req }, res, jest.fn())).rejects.toThrow('APP_QUIESCING');
  preparing.resolve({ _id: { toString: () => 'accepted-user' } });
  await tick();
  expect(f.collection.updateOne).toHaveBeenCalledTimes(1);
  expect(res.status).not.toHaveBeenCalled();
  writing.resolve({ acknowledged: true });
  await checking;
  expect(next).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(403);
  await expect(f.cache.mongoCacheMaintenance.drain()).resolves.toBeUndefined();
});

test('replacement Db cannot adopt a pending original or authorize its next write', async () => {
  const f = fixture();
  const reading = deferred<null>(null);
  f.collection.findOne.mockReturnValueOnce(reading.promise);
  const work = original(f.actions.domainParser(`${'a'.repeat(80)}.example.test`, true));
  await tick();
  const replacement = { collection: jest.fn() };
  f.connection.db = replacement;
  reading.resolve(null);
  await work;
  expect(replacement.collection).not.toHaveBeenCalled();
  expect(f.collection.updateOne).not.toHaveBeenCalled();
  f.cache.mongoCacheMaintenance.maintenance.pauseAdmissions('cache');
  expect(
    (await f.cache.mongoCacheMaintenance.maintenance.getMaintenanceCensus('cache')).complete,
  ).toBe(false);
  await expect(f.cache.mongoCacheMaintenance.drain()).rejects.toThrow(
    'MONGO_CACHE_SETTLEMENT_UNCONFIRMED',
  );
});

test('raw access needs a live facade and stale facade context cannot borrow a live sibling', async () => {
  const f = fixture();
  await expect(
    f.cache.runMongoDomainParser(() => f.cache.default.set('raw', 'value')),
  ).rejects.toThrow('APP_QUIESCING');
  expect(f.collection.updateOne).not.toHaveBeenCalled();
  const held = deferred(undefined);
  let stale!: (action: () => Promise<unknown>) => Promise<unknown>;
  f.bans.serialize = async (value) => {
    if (value.value === 'first') stale = AsyncLocalStorage.snapshot();
    else await held.promise;
    return JSON.stringify(value);
  };
  const work = original(
    f.bans.setMany([
      { key: 'first', value: 'first' },
      { key: 'held', value: 'held' },
    ]),
  );
  await tick();
  expect(f.collection.updateOne).toHaveBeenCalledTimes(1);
  await expect(stale(() => f.bans.set('late', 'forbidden'))).rejects.toThrow('APP_QUIESCING');
  expect(f.collection.updateOne).toHaveBeenCalledTimes(1);
  held.resolve(undefined);
  await work;
  expect(f.collection.updateOne).toHaveBeenCalledTimes(2);
  await expect(f.cache.mongoCacheMaintenance.drain()).rejects.toThrow(
    'MONGO_CACHE_SETTLEMENT_UNCONFIRMED',
  );
});

test('mismatched parent pause cannot authorize a new cache child from a live Auth original', async () => {
  const f = fixture();
  const preparing = deferred(undefined);
  const work = original(
    f.legacy.withAuthRequest({}, async () => {
      await preparing.promise;
      return f.bans.set('mismatched', 'value');
    }),
  );
  expect(f.auth.pauseAdmissions('foreign')).toBe(true);
  expect(f.cache.mongoCacheMaintenance.maintenance.pauseAdmissions('cache')).toBe(false);
  preparing.resolve(undefined);
  await expect(work).rejects.toThrow('APP_QUIESCING');
  expect(f.collection.updateOne).not.toHaveBeenCalled();
  expect(
    (await f.cache.mongoCacheMaintenance.maintenance.getMaintenanceCensus('cache')).complete,
  ).toBe(false);
});

/** A parent resume never admits another original into an already closed cache hold. */
test.each(['resumed', 'repaused'])(
  'Auth resume gap %s preserves the first cache admission boundary',
  async (transition) => {
    const f = fixture();
    const oldGate = deferred(undefined);
    const gapGate = deferred(undefined);
    let retired!: () => Promise<unknown>;
    const old = original(
      f.auth.run(undefined, async () => {
        const restore = AsyncLocalStorage.snapshot();
        retired = () => restore(() => f.bans.set('retired', 1));
        await oldGate.promise;
        return f.bans.set('old', 1);
      }),
    );
    await tick();
    if (transition === 'repaused') {
      expect(f.auth.pauseAdmissions('foreign')).toBe(true);
      expect(f.cache.mongoCacheMaintenance.maintenance.pauseAdmissions('cache')).toBe(false);
      expect(f.auth.resumeAdmissions('foreign')).toBe(true);
    } else {
      expect(f.cache.mongoCacheMaintenance.maintenance.pauseAdmissions('cache')).toBe(true);
      expect(f.auth.resumeAdmissions('cache')).toBe(true);
    }
    const gap = original(
      f.auth.run(undefined, async () => {
        await gapGate.promise;
        return f.bans.set('gap', 1);
      }),
    );
    await tick();
    try {
      if (transition === 'repaused')
        expect(f.cache.mongoCacheMaintenance.maintenance.pauseAdmissions('cache')).toBe(true);
      gapGate.resolve(undefined);
      await expect(gap).rejects.toThrow('APP_QUIESCING');
      expect(f.collection.updateOne).not.toHaveBeenCalled();
      oldGate.resolve(undefined);
      await expect(old).resolves.toBe(true);
      expect(f.collection.updateOne).toHaveBeenCalledTimes(1);
      expect(
        await f.cache.mongoCacheMaintenance.maintenance.getMaintenanceCensus('cache'),
      ).toMatchObject({
        queuedContinuations: 0,
        pendingWrites: 0,
        complete: transition === 'repaused',
      });
      const foreign = jest
        .requireActual<typeof import('../auth/maintenance')>('../auth/maintenance')
        .createAuthMaintenance();
      await expect(foreign.run(undefined, () => f.bans.set('foreign', 1))).rejects.toThrow(
        'APP_QUIESCING',
      );
      await foreign.drain();
      await expect(retired()).rejects.toThrow('APP_QUIESCING');
      expect(f.collection.updateOne).toHaveBeenCalledTimes(1);
      expect(f.cache.mongoCacheMaintenance.maintenance.resumeAdmissions('cache')).toBe(true);
      if (transition === 'repaused') expect(f.auth.resumeAdmissions('cache')).toBe(true);
      const stoppingGate = deferred(undefined);
      const stopping = original(
        f.auth.run(undefined, async () => {
          await stoppingGate.promise;
          return f.bans.set('stopped-original', 1);
        }),
      );
      await tick();
      f.cache.mongoCacheMaintenance.stopAdmissions();
      stoppingGate.resolve(undefined);
      await expect(stopping).resolves.toBe(true);
      expect(f.collection.updateOne).toHaveBeenCalledTimes(2);
    } finally {
      gapGate.resolve(undefined);
      oldGate.resolve(undefined);
    }
  },
);

test('actual App partial cancellation cannot admit a new Auth root into the retained cache hold', async () => {
  const f = fixture();
  const { createAppMaintenance } =
    jest.requireActual<typeof import('../app/maintenance')>('../app/maintenance');
  const gate = deferred(undefined);
  const old = original(
    f.auth.run(undefined, async () => {
      await gate.promise;
      return f.bans.set('original', 1);
    }),
  );
  await tick();
  // The actual encoded-domain producer can become uncertain without poisoning clean Auth.
  f.collection.findOne.mockRejectedValueOnce(new Error('domain read unknown'));
  await f.actions.domainParser('fixture.invalid', true);
  expect(f.collection.updateOne).toHaveBeenCalledTimes(1);
  expect(f.collection.updateOne.mock.calls[0][0].key.$eq).toMatch(/^ENCODED_DOMAINS:/);
  expect(await f.auth.getMaintenanceCensus(null)).toMatchObject({ complete: true });
  let generationClosed = false;
  const app = createAppMaintenance({
    readStorageProviders: () => NOT_OWNED_STORAGE_PROVIDERS,
    env: {
      LIBRECHAT_MAINTENANCE_TOKEN: 'a'.repeat(32),
      POD_UID: '12345678-1234-1234-1234-123456789012',
      BUILD_COMMIT: 'a'.repeat(40),
    },
    requiredSharedState: false,
    // These unrelated prerequisites are inert; App/cache/Auth behavior below is actual source.
    generation: {
      closeGenerationAdmission: () => {
        generationClosed = true;
        return true;
      },
      reopenGenerationAdmission: () => {
        generationClosed = false;
        return true;
      },
      getGenerationRuntimeHealth: async () => true,
      getGenerationAdmissionCensus: async () => ({
        admissionClosed: generationClosed,
        initializing: 0,
        providerExecutions: 0,
        queuedContinuations: 0,
        pendingWrites: 0,
        activeStreams: 0,
        unresolved: 0,
        complete: true,
      }),
    },
    workOwners: { cache: f.cache.mongoCacheMaintenance.maintenance, auth: f.auth },
    fileDomainOwners: [],
    unqualifiedOwners: [],
    startupReady: () => true,
    probeDatabase: async () => true,
    probeSharedState: async () => true,
  });
  try {
    const body = { requestId: 'cache', expectedRevision: 0, identity: app.identity };
    expect(app.operation('begin', body)).toBe(200);
    expect(app.operation('cancel', { ...body, expectedRevision: 1 })).toBe(503);
    expect(await f.auth.getMaintenanceCensus('cache')).toMatchObject({ admissionClosed: false });
    await expect(f.auth.run(undefined, () => f.bans.set('gap', 1))).rejects.toThrow(
      'APP_QUIESCING',
    );
    expect(f.collection.updateOne).toHaveBeenCalledTimes(1);
    gate.resolve(undefined);
    await expect(old).resolves.toBe(true);
    expect(f.collection.updateOne).toHaveBeenCalledTimes(2);
    expect(await app.status()).toMatchObject({
      requestId: 'cache',
      phase: 'quiescing',
      known: false,
    });
  } finally {
    gate.resolve(undefined);
    await app.close();
  }
});
