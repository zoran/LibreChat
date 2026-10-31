/** Actual Express guards, Keyv and session methods; only storage delays/failures are injected. */
const http = require('node:http');
const express = require('express');
const request = require('supertest');
const mockMongoose = jest.requireActual('mongoose');
const mongoose = mockMongoose;
// Keep the actual connected Mongoose owner when module isolation refreshes Auth and cache.
jest.mock('mongoose', () => mockMongoose);
const { Keyv } = require('keyv');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const schemas = require('@librechat/data-schemas');
const { ViolationTypes } = require('librechat-data-provider');

let mockDatabase;
let mockStores;
let mockBanCacheStore;
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  // The installed limiter uses its actual MemoryStore here; real Redis has its own integration test.
  limiterCache: () => undefined,
}));
jest.mock('~/models', () =>
  jest.requireActual('@librechat/data-schemas').createMethods(mockDatabase),
);
jest.mock('~/cache/getLogStores', () => (type) => mockStores.get(type));
jest.mock('~/cache', () => ({
  getLogStores: require('~/cache/getLogStores'),
  logViolation: require('~/cache/logViolation'),
}));
jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn(async () => ({})),
}));

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
const originalEnv = { ...process.env };
let mongo;
let Session;
let userId;
let owner;
let app;
let limiter;
let errors;
let configRead;
let configuredDone;
let peerClosed;
const waitForStorage = (entered, response) =>
  Promise.race([
    entered.promise,
    response.then((result) => {
      throw new Error(
        `Response ended before storage: ${result.status}; ${errors.map(String).join('; ')}`,
      );
    }),
  ]);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  schemas.createModels(mongoose);
  Session = mongoose.models.Session || mongoose.model('Session', schemas.sessionSchema);
  mockDatabase = mongoose;
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  process.env = originalEnv;
});
beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  process.env.BAN_VIOLATIONS = 'true';
  process.env.BAN_INTERVAL = '20';
  process.env.LOGIN_MAX = '1';
  process.env.LOGIN_VIOLATION_SCORE = '1';
  process.env.USE_REDIS = 'false';
  userId = new mongoose.Types.ObjectId();
  mockBanCacheStore = mongoose.connection.db.collection('logs');
  const collection = mongoose.connection.db.collection.bind(mongoose.connection.db);
  jest
    .spyOn(mongoose.connection.db, 'collection')
    .mockImplementation((name, ...args) =>
      name === 'logs' ? mockBanCacheStore : collection(name, ...args),
    );
  errors = [];
  configuredDone = deferred();
  peerClosed = deferred();
  mockStores = new Map(
    Object.values(ViolationTypes).map((type) => [
      type,
      new Keyv({ store: new Map(), namespace: type, ttl: 60_000 }),
    ]),
  );
  jest.resetModules();
  jest.isolateModules(() => {
    owner = require('~/server/services/LegacyAuthMaintenance').legacyAuthMaintenance;
    const checkBan = require('../checkBan');
    const configMiddleware = require('../config/app');
    ({ getAppConfig: configRead } = require('~/server/services/Config'));
    const banViolation = require('~/cache/banViolation');
    limiter = require('../limiters/loginLimiter');
    app = express();
    app.use(owner.admissionMiddleware);
    app.use((req, res, next) => {
      res.once('close', peerClosed.resolve);
      req.user = { id: userId.toString() };
      next();
    });
    app.get('/guard', checkBan, (_req, res) => res.sendStatus(204));
    app.get('/configured', configMiddleware, checkBan, (_req, res) => {
      configuredDone.resolve();
      if (!res.destroyed) res.sendStatus(204);
    });
    app.get('/login', limiter, (_req, res) => res.sendStatus(204));
    app.get(
      '/violate',
      owner.own(async (req, res) => {
        await banViolation(req, res, {
          type: ViolationTypes.LOGINS,
          user_id: userId.toString(),
          prev_count: 19,
          violation_count: 20,
        });
        if (!res.destroyed) res.sendStatus(204);
      }),
    );
    app.use((error, _req, res, _next) => {
      errors.push(error);
      configuredDone.resolve();
      res.sendStatus(500);
    });
  });
});

test('actual config continuation retains the accepted request through peer close and the following ban guard', async () => {
  const gate = deferred();
  const entered = deferred();
  configRead.mockImplementation(async () => {
    entered.resolve();
    await gate.promise;
    return {};
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const peer = http.get({
    hostname: '127.0.0.1',
    port: server.address().port,
    path: '/configured',
  });
  peer.on('error', () => undefined);
  try {
    await entered.promise;
    owner.pauseAdmissions('config');
    peer.destroy();
    await peerClosed.promise;
    expect(await owner.getMaintenanceCensus('config')).toMatchObject({
      queuedContinuations: 1,
      pendingWrites: 0,
      complete: true,
    });
    gate.resolve();
    await configuredDone.promise;
    await tick();
    expect(errors).toEqual([]);
    expect(configRead).toHaveBeenCalledTimes(1);
    expect(await owner.getMaintenanceCensus('config')).toEqual({
      admissionClosed: true,
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
  } finally {
    gate.resolve();
    await tick();
    peer.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
afterEach(() => jest.restoreAllMocks());

test('a sanitized first ban-cache failure cannot hide its pending sibling', async () => {
  const second = deferred();
  const entered = deferred();
  let writes = 0;
  jest.spyOn(mockBanCacheStore, 'updateOne').mockImplementation(() => {
    writes++;
    if (writes === 1) throw new Error('cache refused first write');
    entered.resolve();
    return second.promise;
  });
  await mockStores
    .get(ViolationTypes.BAN)
    .set(userId.toString(), { expiresAt: Date.now() + 60_000 });
  const response = request(app)
    .get('/guard')
    .then((result) => result);
  try {
    await waitForStorage(entered, response);
    owner.pauseAdmissions('ban-cache');
    await tick();
    // Auth tracks the facade and driver as two ports of the same pending Mongo action.
    expect(await owner.getMaintenanceCensus('ban-cache')).toMatchObject({
      queuedContinuations: 1,
      pendingWrites: 2,
      complete: false,
    });
    second.resolve(true);
    expect((await response).status).toBe(403);
    await tick();
    expect(await owner.getMaintenanceCensus('ban-cache')).toMatchObject({
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: false,
    });
    expect(owner.resumeAdmissions('ban-cache')).toBe(false);
  } finally {
    second.resolve(true);
    await response;
  }
});

test('expired-ban cleanup holds both deletes when one fails before the other settles', async () => {
  const store = mockStores.get(ViolationTypes.BAN);
  // Seed expiry in the payload while the Keyv record itself remains available.
  await store.set(userId.toString(), { expiresAt: Date.now() - 1000 });
  await store.set('127.0.0.1', { expiresAt: Date.now() - 1000 });
  await store.set('::ffff:127.0.0.1', { expiresAt: Date.now() - 1000 });
  const second = deferred();
  const entered = deferred();
  jest
    .spyOn(store, 'delete')
    .mockRejectedValueOnce(new Error('delete uncertain'))
    .mockImplementationOnce(() => {
      entered.resolve();
      return second.promise;
    });
  const response = request(app)
    .get('/guard')
    .then((result) => result);
  try {
    await waitForStorage(entered, response);
    owner.pauseAdmissions('cleanup');
    expect((await response).status).toBe(500);
    expect(await owner.getMaintenanceCensus('cleanup')).toMatchObject({
      queuedContinuations: 1,
      pendingWrites: 1,
      complete: false,
    });
    second.resolve(false); // A missing key is a valid delete result.
    await tick();
    expect(await owner.getMaintenanceCensus('cleanup')).toMatchObject({
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: false,
    });
  } finally {
    second.resolve(false);
    await response;
  }
});

test('a real session deletion remains owned across pause and applies to only the banned user', async () => {
  const otherUser = new mongoose.Types.ObjectId();
  await Session.collection.insertMany([{ user: userId }, { user: otherUser }]);
  const gate = deferred();
  const entered = deferred();
  const remove = Session.collection.deleteMany.bind(Session.collection);
  jest.spyOn(Session.collection, 'deleteMany').mockImplementation(async (...args) => {
    entered.resolve();
    await gate.promise;
    return remove(...args);
  });
  const response = request(app)
    .get('/violate')
    .then((result) => result);
  try {
    await entered.promise;
    owner.pauseAdmissions('sessions');
    expect(await owner.getMaintenanceCensus('sessions')).toMatchObject({
      queuedContinuations: 1,
      pendingWrites: 1,
      complete: true,
    });
    await request(app).get('/guard').expect(503);
    gate.resolve();
    const result = await response;
    expect(errors).toEqual([]);
    expect(result.status).toBe(204);
    expect(result.headers['set-cookie'].some((cookie) => cookie.startsWith('refreshToken='))).toBe(
      true,
    );
    expect(await Session.countDocuments({ user: userId })).toBe(0);
    expect(await Session.countDocuments({ user: otherUser })).toBe(1);
    expect(await owner.getMaintenanceCensus('sessions')).toEqual({
      admissionClosed: true,
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
  } finally {
    gate.resolve();
    await response;
  }
});

test('installed rate limiter retains its ignored async handler after the HTTP peer closes', async () => {
  const store = mockStores.get(ViolationTypes.LOGINS);
  const gate = deferred();
  const entered = deferred();
  const handlerDone = deferred();
  const put = store.set.bind(store);
  jest.spyOn(store, 'set').mockImplementation(async (...args) => {
    entered.resolve();
    await gate.promise;
    return put(...args);
  });
  const logs = mockStores.get(ViolationTypes.GENERAL);
  const putLog = logs.set.bind(logs);
  jest.spyOn(logs, 'set').mockImplementation(async (...args) => {
    const result = await putLog(...args);
    handlerDone.resolve();
    return result;
  });
  expect(typeof limiter.resetKey).toBe('function');
  expect(typeof limiter.getKey).toBe('function');
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  let peer;
  try {
    await request(server).get('/login').expect(204);
    peer = http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/login' });
    peer.on('error', () => undefined);
    await entered.promise;
    owner.pauseAdmissions('handler');
    peer.destroy();
    await new Promise((resolve) => peer.once('close', resolve));
    expect(await owner.getMaintenanceCensus('handler')).toMatchObject({
      queuedContinuations: 1,
      pendingWrites: 1,
      complete: true,
    });
    gate.resolve();
    await handlerDone.promise;
    await tick();
    expect(await owner.getMaintenanceCensus('handler')).toEqual({
      admissionClosed: true,
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
    expect(await store.get(userId.toString())).toBe(1);
  } finally {
    gate.resolve();
    peer?.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
