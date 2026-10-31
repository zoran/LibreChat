/** Actual settings router, Auth owner and persistence helpers; no HTTP or database server. */
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
jest.mock('~/cache', () => ({ getLogStores: () => mockFixture.store }));
jest.mock('~/server/middleware', () => ({ requireJwtAuth: (_req, _res, next) => next() }));
jest.mock('~/server/services/PermissionService', () => ({
  findAccessibleResources: async () => [mockFixture.skillId],
}));
jest.mock('dotenv/config', () => ({}));
jest.mock('~/config/winston', () => ({ debug: jest.fn(), error: jest.fn(), warn: jest.fn() }));
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
}));
jest.mock('@librechat/api', () => jest.requireActual('@librechat/api'));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Failure gates may be armed before their controlled driver is dispatched.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

const tick = () => new Promise(setImmediate);
async function until(predicate) {
  for (let i = 0; i < 40; i++) {
    if (await predicate()) return;
    await tick();
  }
  throw new Error('Settings fixture did not reach the expected original');
}

function query(original) {
  const result = { then: (yes, no) => original.then(yes, no) };
  for (const name of ['lean', 'sort', 'select']) result[name] = () => result;
  return result;
}

function createFixture() {
  const f = {
    userId: '507f1f77bcf86cd799439011',
    skillId: '507f1f77bcf86cd799439012',
    models: {},
    gates: new Map(),
    trace: [],
    user: { favorites: [], skillStates: {}, pinnedOrder: [] },
    existing: null,
    count: 0,
  };
  mockFixture = f;
  const result = (name, value, args) => {
    f.trace.push({ name, args });
    return f.gates.get(name)?.promise ?? Promise.resolve(value);
  };
  f.models.ToolFavorite = {
    exists: jest.fn((...args) => result('exists', f.existing, args)),
    countDocuments: jest.fn((...args) => result('count', f.count, args)),
    updateOne: jest.fn((...args) => result('upsert', { acknowledged: true }, args)),
    deleteOne: jest.fn((...args) => result('remove', { deletedCount: 1 }, args)),
  };
  f.models.User = {
    findById: jest.fn((...args) => query(result('user-read', f.user, args))),
    findOneAndUpdate: jest.fn((...args) =>
      query(result('user-write', { ...f.user, ...args[1].$set }, args)),
    ),
  };
  f.models.Skill = {
    find: jest.fn((...args) => query(result('skills', [{ _id: f.skillId }], args))),
  };
  f.store = Object.assign(new EventEmitter(), {
    get: jest.fn((...args) => result('cache-read', ['cached-user'], args)),
    delete: jest.fn((key) =>
      result(key === 'cached-user' ? 'cache-delete' : 'cache-index-delete', true, [key]),
    ),
  });
  const mongoose = require('mongoose');
  const schemas = jest.requireActual('@librechat/data-schemas');
  schemas.createModels(jest.requireActual('mongoose'));
  f.methods = schemas.createMethods(mongoose, { getCache: () => f.store });
  f.owner = require('~/server/services/LegacyAuthMaintenance').legacyAuthMaintenance;
  f.router = require('../settings');
  f.hold = (name) => {
    const gate = deferred();
    f.gates.set(name, gate);
    return gate;
  };
  f.called = (name) => f.trace.some((row) => row.name === name);
  f.start = (method, url, body = {}) => {
    const finished = deferred();
    const req = {
      method,
      url,
      headers: {},
      body,
      user: { id: f.userId, role: 'USER' },
    };
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      setHeader: jest.fn(),
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(value) {
        this.body = value;
        this.end();
        return this;
      },
      end() {
        finished.resolve();
      },
    });
    const next = (error) => res.status(error?.status ?? 500).json({ error });
    f.owner.admissionMiddleware(req, res, () => f.router.handle(req, res, next));
    return { req, res, finished: finished.promise };
  };
  f.close = (request) => {
    request.req.aborted = true;
    request.res.emit('close');
  };
  return f;
}

describe('settings original custody', () => {
  beforeEach(() => {
    jest.resetModules();
    mockFixture = undefined;
    process.env.AUTH_USER_CACHE_MODE = 'off';
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    // Release every controlled original even when the predecessor assertion fails.
    for (const gate of mockFixture?.gates.values() ?? []) gate.resolve({ acknowledged: true });
    await tick();
    jest.restoreAllMocks();
    delete process.env.AUTH_USER_CACHE_MODE;
  });

  test('retains preflight and actual upsert after response closes', async () => {
    const f = createFixture();
    const preflight = f.hold('exists');
    const write = f.hold('upsert');
    const request = f.start('PUT', '/favorites/tools/skill/tool');
    await until(() => f.called('exists'));
    f.close(request);
    f.owner.pauseAdmissions('settings');
    expect(await f.owner.getMaintenanceCensus('settings')).toMatchObject({
      queuedContinuations: 1,
      pendingWrites: 0,
    });
    let drained = false;
    const drain = f.owner.drain().then(() => {
      drained = true;
    });
    preflight.resolve(null);
    await until(() => f.called('upsert'));
    expect(drained).toBe(false);
    expect(await f.owner.getMaintenanceCensus('settings')).toMatchObject({
      queuedContinuations: 1,
      pendingWrites: 1,
    });
    write.resolve({ acknowledged: true });
    await request.finished;
    await drain;
    expect(request.res.statusCode).toBe(200);
    expect(await f.owner.getMaintenanceCensus('settings')).toEqual({
      admissionClosed: true,
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
  });

  test('retains the actual delete after response closes', async () => {
    const f = createFixture();
    const write = f.hold('remove');
    const request = f.start('DELETE', '/favorites/tools/skill/tool');
    await until(() => f.called('remove'));
    f.close(request);
    f.owner.pauseAdmissions('settings');
    expect(await f.owner.getMaintenanceCensus('settings')).toMatchObject({
      queuedContinuations: 1,
      pendingWrites: 1,
    });
    write.resolve({ deletedCount: 1 });
    await request.finished;
    await f.owner.drain();
    expect(request.res.body).toEqual({ ok: true });
  });

  test.each([
    ['PUT', 'upsert'],
    ['DELETE', 'remove'],
  ])('preserves the %s persistence failure before HTTP normalization', async (method, name) => {
    const f = createFixture();
    const write = f.hold(name);
    const request = f.start(method, '/favorites/tools/skill/tool');
    await until(() => f.called(name));
    write.reject(new Error('driver failed'));
    await request.finished;
    f.owner.pauseAdmissions('settings');
    expect(request.res.statusCode).toBe(500);
    expect(await f.owner.getMaintenanceCensus('settings')).toMatchObject({ complete: false });
    await expect(f.owner.drain()).rejects.toThrow('AUTH_SETTLEMENT_UNCONFIRMED');
  });

  test.each(['capacity', 'existing', 'duplicate'])(
    'preserves expected %s semantics',
    async (kind) => {
      const f = createFixture();
      f.count = kind === 'capacity' ? 100 : 0;
      f.existing = kind === 'existing' ? { _id: 'favorite' } : null;
      if (kind === 'duplicate')
        f.hold('upsert').reject(Object.assign(new Error('duplicate'), { code: 11000 }));
      const request = f.start('PUT', '/favorites/tools/skill/tool');
      await request.finished;
      f.owner.pauseAdmissions('settings');
      expect(request.res.statusCode).toBe(kind === 'capacity' ? 400 : 200);
      expect(f.models.ToolFavorite.updateOne).toHaveBeenCalledTimes(kind === 'duplicate' ? 1 : 0);
      expect(await f.owner.getMaintenanceCensus('settings')).toMatchObject({ complete: true });
      await f.owner.drain();
    },
  );

  test('keeps direct helper calls without an observer compatible', async () => {
    const f = createFixture();
    const params = { userId: f.userId, itemType: 'skill', itemId: 'tool' };
    expect(await f.methods.addToolFavorite(params)).toEqual({ ok: true, added: true });
    expect(await f.methods.removeToolFavorite(params)).toEqual({ ok: true, removed: true });
  });

  test.each([
    ['POST', '/favorites', { favorites: [{ spec: 'default' }] }],
    ['GET', '/favorites', {}],
    ['POST', '/skills/active', { skillStates: { '507f1f77bcf86cd799439012': true } }],
    ['POST', '/pinned-order', { pinnedOrder: ['spec:default'] }],
  ])('retains %s %s User persistence after response closes', async (method, url, body) => {
    const f = createFixture();
    f.user.favorites = 'legacy-malformed';
    const write = f.hold('user-write');
    const request = f.start(method, url, body);
    await until(() => f.called('user-write'));
    f.close(request);
    f.owner.pauseAdmissions('settings');
    const held = await f.owner.getMaintenanceCensus('settings');
    expect(held.queuedContinuations).toBe(1);
    expect(held.pendingWrites).toBeGreaterThan(0);
    write.resolve({ favorites: [], skillStates: body.skillStates ?? {}, pinnedOrder: [] });
    await request.finished;
    await f.owner.drain();
    expect(request.res.statusCode).toBe(200);
    expect(f.models.User.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(await f.owner.getMaintenanceCensus('settings')).toMatchObject({ complete: true });
  });

  test.each(['pinned-explicit', 'user-afterwork'])(
    'retains %s cache cleanup through drain',
    async (kind) => {
      process.env.AUTH_USER_CACHE_MODE = kind === 'user-afterwork' ? 'on' : 'off';
      const f = createFixture();
      const cleanup = f.hold('cache-delete');
      const request =
        kind === 'pinned-explicit'
          ? f.start('POST', '/pinned-order', { pinnedOrder: ['spec:default'] })
          : f.start('POST', '/favorites', { favorites: [] });
      await until(() => f.called('cache-delete'));
      f.close(request);
      f.owner.pauseAdmissions('settings');
      let drained = false;
      const drain = f.owner.drain().then(() => {
        drained = true;
      });
      const held = await f.owner.getMaintenanceCensus('settings');
      expect(held.queuedContinuations).toBe(1);
      expect(held.pendingWrites).toBeGreaterThan(0);
      expect(drained).toBe(false);
      cleanup.resolve(true);
      await request.finished;
      await drain;
      expect(f.called('cache-index-delete')).toBe(true);
      expect(request.res.statusCode).toBe(200);
    },
  );

  test.each(['rejection', 'error-event'])(
    'preserves cache %s before eviction normalization',
    async (kind) => {
      const f = createFixture();
      const cleanup = f.hold('cache-delete');
      const request = f.start('POST', '/pinned-order', { pinnedOrder: ['spec:default'] });
      await until(() => f.called('cache-delete'));
      if (kind === 'rejection') cleanup.reject(new Error('cache failed'));
      else {
        f.store.emit('error', new Error('cache failed'));
        cleanup.resolve(false);
      }
      await request.finished;
      f.owner.pauseAdmissions('settings');
      // Existing eviction semantics preserve the successful User write and HTTP response.
      expect(request.res.statusCode).toBe(200);
      expect(await f.owner.getMaintenanceCensus('settings')).toMatchObject({ complete: false });
      await expect(f.owner.drain()).rejects.toThrow('AUTH_SETTLEMENT_UNCONFIRMED');
      expect(f.store.listenerCount('error')).toBe(0);
    },
  );

  test('refuses a new settings request before any persistence dispatch', async () => {
    const f = createFixture();
    f.owner.pauseAdmissions('settings');
    const request = f.start('PUT', '/favorites/tools/skill/tool');
    await request.finished;
    expect(request.res.statusCode).toBe(503);
    expect(request.res.body).toEqual({ code: 'APP_QUIESCING' });
    expect(f.trace).toEqual([]);
    await f.owner.drain();
  });
});
