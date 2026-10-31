/** Runtime fixture identities are shared by their producers and assertions. */
const mockRandomUUID = require('node:crypto').randomUUID;
const mockAccessToken1 = mockRandomUUID();

/** Actual Graph/OBO, Passport JWT, Keyv and Mongo owners; only provider/storage faults are injected. */
const http = require('node:http');
const express = require('express');
const request = require('supertest');
const mockMongoose = jest.requireActual('mongoose');
const mongoose = mockMongoose;
// Keep the actual connected Mongoose owner when module isolation refreshes Auth and cache.
jest.mock('mongoose', () => mockMongoose);
const jwt = require('jsonwebtoken');
const { Keyv } = require('keyv');
const { Passport } = require('passport');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const schemas = require('@librechat/data-schemas');

let mockDatabase;
let mockTokens;
let mockUserCache;
jest.mock('@librechat/api', () => jest.requireActual('@librechat/api'));
jest.mock('~/models', () =>
  jest.requireActual('@librechat/data-schemas').createMethods(mockDatabase, {
    getCache: () => mockUserCache,
  }),
);
jest.mock('~/cache/getLogStores', () => () => mockTokens);
jest.mock('~/strategies/openidStrategy', () => ({ getOpenIdConfig: () => ({}) }));
// Unused account and refresh providers stay outside this Graph/JWT integration fixture.
jest.mock('~/server/services/AuthService', () => ({}));
jest.mock('~/server/services/RefreshTokenBridge', () => ({}));
jest.mock('~/server/services/OpenIDRefreshRecovery', () => ({}));

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
const token = { access_token: mockAccessToken1, expires_in: 3600 };
const originalEnv = { ...process.env };
let mongo;
let User;
let Flight;
let owner;
let exchange;
let grant;
let app;
let user;
let graphDone;
let peerClosed;
let errors;
let tokenStore;

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  schemas.createModels(mongoose);
  User = mongoose.models.User || mongoose.model('User', schemas.userSchema);
  Flight =
    mongoose.models.OpenIDRefreshFlight ||
    mongoose.model('OpenIDRefreshFlight', schemas.openidRefreshFlightSchema);
  mockDatabase = mongoose;
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  process.env = originalEnv;
});
beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  process.env.OPENID_REUSE_TOKENS = 'true';
  process.env.AUTH_USER_CACHE_MODE = 'on';
  tokenStore = new Map();
  mockTokens = new Keyv({ store: tokenStore, namespace: 'obo' });
  mockUserCache = { get: jest.fn(async () => ['cached-user']), delete: jest.fn(async () => true) };
  graphDone = deferred();
  peerClosed = deferred();
  errors = [];
  user = {
    _id: new mongoose.Types.ObjectId(),
    provider: 'openid',
    openidId: 'subject',
    openidIssuer: 'https://issuer.example.test',
    tenantId: 'tenant',
    federatedTokens: { access_token: 'assertion' },
  };
  await Flight.create({
    key: 'flight',
    ownerId: 'generation',
    status: 'completed',
    encryptedResult: 'fixture-result',
    lockExpiresAt: new Date(Date.now() + 60_000),
    expiresAt: new Date(Date.now() + 60_000),
  });
  jest.resetModules();
  jest.isolateModules(() => {
    owner = require('~/server/services/LegacyAuthMaintenance').legacyAuthMaintenance;
    ({ exchangeOboToken: exchange } = require('~/server/services/OboTokenService'));
    ({ genericGrantRequest: grant } = require('openid-client'));
    grant.mockReset().mockResolvedValue(token);
    const { graphTokenController } = require('~/server/controllers/AuthController');
    const passport = new Passport();
    passport.use(require('~/strategies/jwtStrategy')());
    app = express();
    app.use(owner.admissionMiddleware, passport.initialize());
    app.use((req, res, next) => {
      res.once('close', peerClosed.resolve);
      if (req.path === '/graph') {
        req.user = user;
        req.session = {
          openidTokens: {
            accessToken: 'assertion',
            publicationFlightKey: 'flight',
            publicationFlightOwnerId: 'generation',
          },
        };
      }
      next();
    });
    app.get('/graph', (req, res, next) => {
      graphTokenController(req, res).then(graphDone.resolve, next);
    });
    app.get('/jwt', passport.authenticate('jwt', { session: false }), (req, res) => {
      res.json({ role: req.user.role });
    });
    app.use((error, _req, res, _next) => {
      errors.push(error);
      graphDone.resolve();
      if (!res.destroyed) res.sendStatus(500);
    });
  });
});
afterEach(() => jest.restoreAllMocks());

test('Graph retains the real delivery claim and exchange after an HTTP peer closes, then releases it', async () => {
  const entered = deferred();
  const provider = deferred();
  grant.mockImplementation(() => {
    entered.resolve();
    return provider.promise;
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const peer = http.get({
    hostname: '127.0.0.1',
    port: server.address().port,
    path: '/graph?scopes=api%3A%2F%2Fdownstream%2FRead',
  });
  peer.on('error', () => undefined);
  try {
    await Promise.race([
      entered.promise,
      graphDone.promise.then(() => {
        throw new Error(`Graph response preceded exchange: ${errors.map(String).join('; ')}`);
      }),
    ]);
    expect((await Flight.findOne({ key: 'flight' }).lean()).deliveryId).toEqual(expect.any(String));
    owner.pauseAdmissions('exchange');
    peer.destroy();
    await peerClosed.promise;
    expect(await owner.getMaintenanceCensus('exchange')).toMatchObject({
      queuedContinuations: 1,
      pendingWrites: 0,
      complete: true,
    });
    expect((await request(app).get('/graph?scopes=other')).status).toBe(503);
    provider.resolve(token);
    await graphDone.promise;
    expect(errors).toEqual([]);
    expect((await Flight.findOne({ key: 'flight' }).lean()).deliveryId).toBeUndefined();
    expect(await owner.getMaintenanceCensus('exchange')).toEqual({
      admissionClosed: true,
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
  } finally {
    provider.resolve(token);
    await graphDone.promise;
    peer.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('direct coalesced OBO consumers retain both continuations and the one actual cache write', async () => {
  const provider = deferred();
  const entered = deferred();
  const persisted = deferred();
  const cacheEntered = deferred();
  grant.mockImplementation(() => {
    entered.resolve();
    return provider.promise;
  });
  const set = tokenStore.set.bind(tokenStore);
  jest.spyOn(tokenStore, 'set').mockImplementation(async (...args) => {
    cacheEntered.resolve();
    await persisted.promise;
    return set(...args);
  });
  const first = exchange(user, 'assertion', 'api://downstream/Read');
  const second = exchange(user, 'assertion', 'api://downstream/Read');
  try {
    await entered.promise;
    await tick();
    owner.pauseAdmissions('coalesced');
    expect((await owner.getMaintenanceCensus('coalesced')).queuedContinuations).toBe(2);
    await expect(exchange(user, 'new-assertion', 'other')).rejects.toMatchObject({ status: 503 });
    provider.resolve(token);
    await cacheEntered.promise;
    expect(await owner.getMaintenanceCensus('coalesced')).toMatchObject({
      queuedContinuations: 2,
      pendingWrites: 1,
    });
  } finally {
    provider.resolve(token);
    persisted.resolve();
    await Promise.all([first, second]);
  }
  expect(await first).toBe(await second);
  expect(grant).toHaveBeenCalledTimes(1);
  expect(await owner.getMaintenanceCensus('coalesced')).toMatchObject({
    queuedContinuations: 0,
    pendingWrites: 0,
    complete: true,
  });
});

test('the existing one-retry OBO delay remains owned after admission closes', async () => {
  const retried = deferred();
  const provider = deferred();
  grant
    .mockRejectedValueOnce(Object.assign(new Error('temporarily unavailable'), { status: 503 }))
    .mockImplementationOnce(() => {
      retried.resolve();
      return provider.promise;
    });
  const pending = exchange(user, 'assertion', 'api://downstream/Read');
  try {
    await tick();
    owner.pauseAdmissions('retry');
    expect(grant).toHaveBeenCalledTimes(1);
    expect((await owner.getMaintenanceCensus('retry')).queuedContinuations).toBe(1);
    await retried.promise;
    expect((await owner.getMaintenanceCensus('retry')).queuedContinuations).toBe(1);
  } finally {
    provider.resolve(token);
    await pending;
  }
  expect(grant).toHaveBeenCalledTimes(2);
  expect((await owner.getMaintenanceCensus('retry')).queuedContinuations).toBe(0);
});

test('a swallowed real Keyv failure preserves the token response but prevents clean drain', async () => {
  jest.spyOn(tokenStore, 'set').mockRejectedValue(new Error('cache acknowledgement lost'));
  const result = await exchange(user, 'assertion', 'api://downstream/Read');
  expect(result.access_token).toBe(token.access_token);
  owner.pauseAdmissions('cache-failure');
  expect(await owner.getMaintenanceCensus('cache-failure')).toEqual({
    admissionClosed: true,
    queuedContinuations: 0,
    pendingWrites: 0,
    complete: false,
  });
  expect(owner.resumeAdmissions('cache-failure')).toBe(false);
});

test('response completion retains the real delivery-release retry after a failed Mongo acknowledgement', async () => {
  const retryEntered = deferred();
  const release = deferred();
  const update = Flight.findOneAndUpdate.bind(Flight);
  let attempts = 0;
  jest.spyOn(Flight, 'findOneAndUpdate').mockImplementation((filter, mutation, ...rest) => {
    const query = update(filter, mutation, ...rest);
    if (mutation.$unset?.deliveryId !== undefined && filter.revocationRequestedAt?.$exists) {
      const lean = query.lean.bind(query);
      query.lean = async (...args) => {
        attempts++;
        if (attempts === 1) throw new Error('release acknowledgement lost');
        retryEntered.resolve();
        await release.promise;
        return lean(...args);
      };
    }
    return query;
  });
  const response = request(app).get('/graph?scopes=api%3A%2F%2Fdownstream%2FRead');
  try {
    expect((await response).status).toBe(200);
    await Promise.race([
      retryEntered.promise,
      graphDone.promise.then(() => {
        throw new Error('Graph continuation ended before the release retry');
      }),
    ]);
    owner.pauseAdmissions('delivery-retry');
    expect(await owner.getMaintenanceCensus('delivery-retry')).toMatchObject({
      queuedContinuations: 1,
      pendingWrites: 1,
      complete: false,
    });
  } finally {
    release.resolve();
    await graphDone.promise;
  }
  expect(attempts).toBe(2);
  expect((await Flight.findOne({ key: 'flight' }).lean()).deliveryId).toBeUndefined();
  expect(await owner.getMaintenanceCensus('delivery-retry')).toMatchObject({
    queuedContinuations: 0,
    pendingWrites: 0,
    complete: false,
  });
});

test('actual Passport JWT repairs a missing role and retains its sanitized cache invalidation failure', async () => {
  const inserted = await User.collection.insertOne({
    email: 'jwt@example.test',
    provider: 'local',
  });
  const entered = deferred();
  const invalidation = deferred();
  mockUserCache.delete.mockImplementation(() => {
    entered.resolve();
    return invalidation.promise;
  });
  const bearer = jwt.sign({ id: inserted.insertedId.toString() }, process.env.JWT_SECRET);
  const response = request(app)
    .get('/jwt')
    .auth(bearer, { type: 'bearer' })
    .then((result) => result);
  try {
    await Promise.race([
      entered.promise,
      response.then((result) => {
        throw new Error(`JWT response preceded invalidation: ${result.status}`);
      }),
    ]);
    owner.pauseAdmissions('jwt');
    expect((await owner.getMaintenanceCensus('jwt')).pendingWrites).toBeGreaterThan(0);
    expect((await request(app).get('/jwt').auth(bearer, { type: 'bearer' })).status).toBe(503);
  } finally {
    invalidation.reject(new Error('user cache acknowledgement lost'));
    await response;
  }
  expect((await response).body).toEqual({ role: 'USER' });
  expect((await User.findById(inserted.insertedId).lean()).role).toBe('USER');
  expect(await owner.getMaintenanceCensus('jwt')).toEqual({
    admissionClosed: true,
    queuedContinuations: 0,
    pendingWrites: 0,
    complete: false,
  });
});
