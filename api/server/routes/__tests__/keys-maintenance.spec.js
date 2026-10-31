/** Actual key routers, permission guard, methods and Auth owner; controlled crypto/storage only. */
const { AsyncLocalStorage } = require('node:async_hooks');
const { EventEmitter } = require('node:events');

let mockFixture;
jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  const mongoose = Object.create(actual);
  Object.defineProperties(mongoose, {
    models: { get: () => ({ ...actual.models, ...mockFixture?.models }) },
    default: { value: mongoose },
  });
  return mongoose;
});
jest.mock('~/models', () => mockFixture.methods);
jest.mock('~/server/middleware', () => ({ requireJwtAuth: (_req, _res, next) => next() }));
jest.mock('dotenv/config', () => ({}));
jest.mock('~/config/winston', () => ({ debug: jest.fn(), error: jest.fn(), warn: jest.fn() }));
jest.mock('../../../../packages/data-schemas/src/config/winston', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));
jest.mock('../../../../packages/data-schemas/src/crypto', () => ({
  encrypt: (...args) => mockFixture.result('encrypt', 'encrypted-fixture', args),
  decrypt: () => {
    throw new Error('Unexpected credential read');
  },
  getRandomValues: (...args) => mockFixture.result('random', 'fixture-random', args),
  hashToken: (...args) => mockFixture.result('hash', 'fixture-hash', args),
}));
jest.mock('@librechat/api', () => jest.requireActual('@librechat/api'));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
const tick = () => new Promise(setImmediate);
async function until(predicate) {
  for (let i = 0; i < 40; i++) {
    if (await predicate()) return;
    await tick();
  }
  throw new Error('Key fixture did not reach the expected original');
}
function query(original) {
  const value = { then: (yes, no) => original.then(yes, no) };
  for (const name of ['lean', 'sort', 'select']) value[name] = () => value;
  value.exec = () => original;
  return value;
}
function fixture() {
  const { PermissionTypes, Permissions } = require('librechat-data-provider');
  const f = {
    userId: '507f1f77bcf86cd799439011',
    keyId: '507f1f77bcf86cd799439012',
    trace: [],
    gates: new Map(),
    defaults: new Map(),
    requests: [],
    models: {},
    cacheResult: true,
    emitCacheError: false,
  };
  mockFixture = f;
  f.role = {
    name: 'USER',
    permissions: { [PermissionTypes.REMOTE_AGENTS]: { [Permissions.USE]: true } },
  };
  f.cachedRole = f.role;
  f.storedRole = f.role;
  f.result = (name, fallback, args) => {
    f.trace.push({ name, args });
    f.defaults.set(name, fallback);
    f.snapshot ??= AsyncLocalStorage.snapshot();
    return f.gates.get(name)?.promise ?? Promise.resolve(fallback);
  };
  f.models.Key = {
    findOne: (...args) => query(f.result('key-read', { expiresAt: null }, args)),
    findOneAndUpdate: (...args) => query(f.result('key-upsert', {}, args)),
    findOneAndDelete: (...args) => query(f.result('key-delete', null, args)),
    deleteMany: (...args) => query(f.result('key-delete-all', { deletedCount: 0 }, args)),
  };
  f.models.AgentApiKey = {
    create: (...args) =>
      f.result(
        'agent-create',
        {
          _id: { toString: () => f.keyId },
          name: 'fixture',
          keyPrefix: 'fixture',
          createdAt: new Date(0),
        },
        args,
      ),
    deleteOne: (...args) =>
      query(f.result('agent-delete', { deletedCount: f.deletedCount ?? 1 }, args)),
    find: (...args) => query(f.result('agent-list', [], args)),
    findOne: (...args) => query(f.result('agent-read', null, args)),
  };
  f.models.Role = class Role {
    constructor(value) {
      this.value = value;
    }
    save() {
      return f.result('role-create', { toObject: () => f.role }, [this.value]);
    }
    static findOne(...args) {
      return query(f.result('role-read', f.storedRole, args));
    }
  };
  f.cache = Object.assign(new EventEmitter(), {
    get: (...args) => f.result('role-cache-read', f.cachedRole, args),
    set: async (...args) => {
      const result = await f.result('role-cache-set', f.cacheResult, args);
      if (f.emitCacheError) f.cache.emit('error', new Error('role cache failed'));
      return result;
    },
    delete: async () => false,
  });
  const mongoose = require('mongoose');
  f.methods = {
    ...require('../../../../packages/data-schemas/src/methods/key').createKeyMethods(mongoose),
    ...require('../../../../packages/data-schemas/src/methods/agentApiKey').createAgentApiKeyMethods(
      mongoose,
    ),
    ...require('../../../../packages/data-schemas/src/methods/role').createRoleMethods(mongoose, {
      getCache: () => f.cache,
    }),
  };
  f.owner = require('~/server/services/LegacyAuthMaintenance').legacyAuthMaintenance;
  f.routers = { user: require('../keys'), agent: require('../apiKeys') };
  f.hold = (name) => {
    const gate = deferred();
    f.gates.set(name, gate);
    return gate;
  };
  f.called = (name) => f.trace.some((entry) => entry.name === name);
  f.start = (kind, method, url = '/', body = {}) => {
    const finished = deferred();
    const req = {
      method,
      url,
      originalUrl: url,
      headers: {},
      body,
      query: Object.fromEntries(new URL(url, 'http://fixture').searchParams),
      user: { id: f.userId, role: 'USER' },
    };
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      setHeader: jest.fn(),
      set() {
        return this;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(value) {
        this.body = value;
        this.end();
        return this;
      },
      send(value) {
        this.body = value;
        this.end();
        return this;
      },
      end() {
        finished.resolve();
        return this;
      },
    });
    f.routers[kind].handle(req, res, (error) => res.status(error?.status ?? 500).json({ error }));
    const request = { req, res, finished: finished.promise };
    f.requests.push(request);
    return request;
  };
  f.close = (request) => {
    request.req.aborted = true;
    request.res.emit('close');
  };
  f.census = () => f.owner.getMaintenanceCensus('keys');
  return f;
}

describe('key management original custody', () => {
  beforeEach(() => {
    jest.resetModules();
    mockFixture = undefined;
  });
  afterEach(async () => {
    for (const request of mockFixture?.requests ?? []) mockFixture.close(request);
    for (const [name, gate] of mockFixture?.gates ?? [])
      gate.resolve(mockFixture.defaults.get(name));
    await tick();
    await mockFixture?.owner.drain().catch(() => undefined);
    jest.restoreAllMocks();
  });

  test('retains encryption and actual upsert after the HTTP peer closes', async () => {
    const f = fixture();
    const encrypt = f.hold('encrypt'),
      write = f.hold('key-upsert');
    const request = f.start('user', 'PUT', '/', { name: 'fixture', value: 'inert' });
    await until(() => f.called('encrypt'));
    f.close(request);
    f.owner.pauseAdmissions('keys');
    expect(await f.census()).toMatchObject({ queuedContinuations: 1, pendingWrites: 0 });
    let drained = false;
    const drain = f.owner.drain().then(() => {
      drained = true;
    });
    encrypt.resolve('encrypted-fixture');
    await until(() => f.called('key-upsert'));
    expect(drained).toBe(false);
    expect(await f.census()).toMatchObject({ queuedContinuations: 1, pendingWrites: 1 });
    write.resolve({});
    await request.finished;
    await drain;
    expect(request.res.statusCode).toBe(201);
    expect(await f.census()).toMatchObject({
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
  });

  test.each([
    ['/fixture', 'key-delete'],
    ['/?all=true', 'key-delete-all'],
  ])('retains actual user-key deletion %s until its model settles', async (url, name) => {
    const f = fixture(),
      write = f.hold(name);
    const request = f.start('user', 'DELETE', url);
    await until(() => f.called(name));
    f.close(request);
    f.owner.pauseAdmissions('keys');
    expect(await f.census()).toMatchObject({ queuedContinuations: 1, pendingWrites: 1 });
    expect(f.trace.find((row) => row.name === name).args[0].userId).toBe(f.userId);
    write.resolve(null);
    await request.finished;
    expect(request.res.statusCode).toBe(204);
    await f.owner.drain();
  });

  test.each([
    ['PUT', '/', 'key-upsert'],
    ['DELETE', '/fixture', 'key-delete'],
    ['DELETE', '/?all=true', 'key-delete-all'],
  ])('retains user-key write failure for %s %s', async (method, url, name) => {
    const f = fixture(),
      write = f.hold(name);
    const request = f.start('user', method, url, { name: 'fixture', value: 'inert' });
    await until(() => f.called(name));
    write.reject(new Error('storage failed'));
    await request.finished;
    f.owner.pauseAdmissions('keys');
    expect(request.res.statusCode).toBe(500);
    expect(await f.census()).toMatchObject({ complete: false });
    await expect(f.owner.drain()).rejects.toThrow('AUTH_SETTLEMENT_UNCONFIRMED');
  });

  test('crypto preflight failure dispatches no write and leaves a clean census', async () => {
    const f = fixture(),
      encrypt = f.hold('encrypt');
    const request = f.start('user', 'PUT', '/', { name: 'fixture', value: 'inert' });
    await until(() => f.called('encrypt'));
    encrypt.reject(new Error('crypto refused'));
    await request.finished;
    f.owner.pauseAdmissions('keys');
    expect(f.called('key-upsert')).toBe(false);
    expect(await f.census()).toMatchObject({ pendingWrites: 0, complete: true });
  });

  test.each([
    ['PUT', '/', null],
    ['DELETE', '/', {}],
  ])('keeps validation refusal clean for %s %s', async (method, url, body) => {
    const f = fixture(),
      request = f.start('user', method, url, body);
    await request.finished;
    f.owner.pauseAdmissions('keys');
    expect(request.res.statusCode).toBe(400);
    expect(f.trace).toEqual([]);
    expect(await f.census()).toMatchObject({ complete: true });
  });

  test('owns permission lookup, lazy Role save and exact cache afterwork before key creation', async () => {
    const f = fixture();
    f.cachedRole = undefined;
    f.storedRole = null;
    const read = f.hold('role-read'),
      role = f.hold('role-create'),
      cache = f.hold('role-cache-set');
    const request = f.start('agent', 'POST', '/', { name: 'fixture' });
    await until(() => f.called('role-read'));
    f.close(request);
    f.owner.pauseAdmissions('keys');
    expect(await f.census()).toMatchObject({ queuedContinuations: 1, pendingWrites: 0 });
    read.resolve(null);
    await until(() => f.called('role-create'));
    expect(await f.census()).toMatchObject({ queuedContinuations: 1, pendingWrites: 1 });
    role.resolve({ toObject: () => f.role });
    await until(() => f.called('role-cache-set'));
    expect(f.called('random')).toBe(false);
    expect(f.cache.listenerCount('error')).toBe(1);
    cache.resolve(true);
    await request.finished;
    expect(request.res.statusCode).toBe(201);
    expect(f.cache.listenerCount('error')).toBe(0);
    await until(async () => (await f.census()).queuedContinuations === 0);
    expect(await f.census()).toMatchObject({
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
  });

  test.each(['role-create', 'role-cache-set', 'cache-false', 'cache-event'])(
    'preserves permission preflight persistence failure %s before HTTP normalization',
    async (kind) => {
      const f = fixture();
      f.cachedRole = undefined;
      if (kind === 'role-create') f.storedRole = null;
      if (kind === 'cache-false') f.cacheResult = false;
      if (kind === 'cache-event') f.emitCacheError = true;
      const gate = kind.startsWith('role-') ? f.hold(kind) : undefined;
      const request = f.start('agent', 'POST', '/', { name: 'fixture' });
      if (gate) {
        await until(() => f.called(kind));
        gate.reject(new Error('role persistence failed'));
      }
      await request.finished;
      f.owner.pauseAdmissions('keys');
      expect(request.res.statusCode).toBe(gate ? 500 : 201);
      expect(await f.census()).toMatchObject({ complete: false });
      expect(f.cache.listenerCount('error')).toBe(0);
      await expect(f.owner.drain()).rejects.toThrow('AUTH_SETTLEMENT_UNCONFIRMED');
    },
  );

  test('permission denial creates no key and remains clean', async () => {
    const f = fixture();
    f.role.permissions = {};
    const request = f.start('agent', 'POST', '/', { name: 'fixture' });
    await request.finished;
    f.owner.pauseAdmissions('keys');
    expect(request.res.statusCode).toBe(403);
    expect(f.called('random')).toBe(false);
    expect(await f.census()).toMatchObject({ complete: true });
  });

  test.each(['random', 'hash'])(
    'retains agent-key %s preflight and its later actual create',
    async (stage) => {
      const f = fixture(),
        preflight = f.hold(stage),
        write = f.hold('agent-create');
      const request = f.start('agent', 'POST', '/', { name: 'fixture', userId: 'foreign' });
      await until(() => f.called(stage));
      f.close(request);
      f.owner.pauseAdmissions('keys');
      expect(await f.census()).toMatchObject({ queuedContinuations: 1, pendingWrites: 0 });
      preflight.resolve('inert');
      await until(() => f.called('agent-create'));
      expect(await f.census()).toMatchObject({ queuedContinuations: 1, pendingWrites: 1 });
      expect(f.trace.find((row) => row.name === 'agent-create').args[0].userId).toBe(f.userId);
      write.resolve(f.defaults.get('agent-create'));
      await request.finished;
      expect(request.res.statusCode).toBe(201);
      expect(Object.keys(request.res.body).sort()).toEqual([
        'createdAt',
        'expiresAt',
        'id',
        'key',
        'keyPrefix',
        'name',
      ]);
    },
  );

  test.each([
    ['POST', '/', 'agent-create'],
    ['DELETE', '/key', 'agent-delete'],
  ])('retains agent model failure caught by the %s handler', async (method, url, name) => {
    const f = fixture(),
      write = f.hold(name);
    const request = f.start('agent', method, url, { name: 'fixture' });
    await until(() => f.called(name));
    write.reject(new Error('agent write failed'));
    await request.finished;
    f.owner.pauseAdmissions('keys');
    expect(request.res.statusCode).toBe(500);
    expect(await f.census()).toMatchObject({ complete: false });
  });

  test.each([
    [0, 404],
    [1, 204],
  ])('keeps acknowledged agent deletion count %s clean', async (count, status) => {
    const f = fixture(),
      write = f.hold('agent-delete');
    const request = f.start('agent', 'DELETE', '/key');
    await until(() => f.called('agent-delete'));
    f.close(request);
    f.owner.pauseAdmissions('keys');
    expect(await f.census()).toMatchObject({ queuedContinuations: 1, pendingWrites: 1 });
    expect(f.trace.find((row) => row.name === 'agent-delete').args[0]).toEqual({
      _id: 'key',
      userId: f.userId,
    });
    write.resolve({ deletedCount: count });
    await request.finished;
    expect(request.res.statusCode).toBe(status);
    expect(await f.census()).toMatchObject({ complete: true });
  });

  test.each([
    ['user', 'PUT', '/'],
    ['user', 'DELETE', '/key'],
    ['user', 'DELETE', '/?all=true'],
    ['user', 'GET', '/'],
    ['agent', 'POST', '/'],
    ['agent', 'DELETE', '/key'],
    ['agent', 'GET', '/'],
    ['agent', 'GET', '/key'],
  ])(
    'refuses new %s %s %s before permission, crypto or model dispatch',
    async (kind, method, url) => {
      const f = fixture();
      f.owner.pauseAdmissions('keys');
      const request = f.start(kind, method, url, { name: 'fixture', value: 'inert' });
      await request.finished;
      expect(request.res.statusCode).toBe(503);
      expect(f.trace).toEqual([]);
    },
  );

  test('allows only exact resume and rejects a settled request context', async () => {
    const f = fixture(),
      request = f.start('user', 'GET', '/?name=fixture');
    await request.finished;
    await until(async () => (await f.owner.getMaintenanceCensus(null)).queuedContinuations === 0);
    f.owner.pauseAdmissions('keys');
    expect(f.owner.resumeAdmissions('wrong')).toBe(false);
    expect(f.owner.resumeAdmissions('keys')).toBe(true);
    const trace = f.trace.length;
    await expect(
      f.snapshot(() =>
        f.owner.run(undefined, () => f.methods.deleteUserKey({ userId: f.userId, all: true })),
      ),
    ).rejects.toThrow('Authentication continuation used after settlement');
    expect(f.trace).toHaveLength(trace);
    await expect(f.owner.drain()).rejects.toThrow('AUTH_SETTLEMENT_UNCONFIRMED');
  });

  test('preserves non-observed method callers and cache semantics', async () => {
    const f = fixture();
    f.cachedRole = undefined;
    await f.methods.updateUserKey({ userId: f.userId, name: 'fixture', value: 'inert' });
    await f.methods.deleteUserKey({ userId: f.userId, all: true });
    const created = await f.methods.createAgentApiKey({ userId: f.userId, name: 'fixture' });
    expect(created.id).toBe(f.keyId);
    expect(await f.methods.deleteAgentApiKey('key', f.userId)).toBe(true);
    expect(await f.methods.getRoleByName('USER')).toBe(f.role);
    expect(f.cache.listenerCount('error')).toBe(0);
    expect(await f.owner.getMaintenanceCensus(null)).toMatchObject({
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
  });
});
