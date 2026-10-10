/** Actual account routes, services, data methods and maintenance owner against an isolated Mongo. */
const mongoose = require('mongoose');
const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { MongoMemoryServer } = require('mongodb-memory-server');
const schemas = require('@librechat/data-schemas');
const mockApi = jest.requireActual('@librechat/api');

let mockDatabase;
let mockCache;
jest.mock('~/models', () => ({
  ...jest.requireActual('@librechat/data-schemas').createMethods(mockDatabase, {
    getCache: () => mockCache,
  }),
}));
jest.mock('@librechat/api', () => ({
  ...mockApi,
  ...jest.requireActual('../../../../packages/api/src/auth/maintenance.ts'),
  ...jest.requireActual('../../../../packages/api/src/auth/sessionMaintenance.ts'),
  checkEmailConfig: jest.fn(() => false),
}));
jest.mock('~/server/services/Config', () => ({
  getAppConfig: async () => ({ registration: {}, balance: { enabled: true, startBalance: 50 } }),
}));
jest.mock('~/server/utils', () => ({
  sendEmail: jest.fn(async () => ({ accepted: ['fixture'] })),
}));
// These provider paths are not part of the account routes exercised here.
jest.mock('~/server/services/GraphTokenService', () => ({}));
jest.mock('~/server/services/RefreshTokenBridge', () => ({}));
jest.mock('~/server/services/OpenIDRefreshRecovery', () => ({}));
jest.mock('~/server/services/OpenIDRefreshFlight', () => ({}));
jest.mock('~/server/controllers/auth/LoginController', () => ({ loginController: jest.fn() }));
jest.mock('~/server/controllers/auth/LogoutController', () => ({ logoutController: jest.fn() }));
jest.mock('~/server/middleware', () => {
  const next = (_req, _res, done) => done();
  return Object.fromEntries(
    [
      'logHeaders',
      'requireSameOrigin',
      'loginLimiter',
      'checkBan',
      'validateEmailLogin',
      'requireLdapAuth',
      'requireLocalAuth',
      'registerLimiter',
      'checkInviteUser',
      'validateRegistration',
      'resetPasswordLimiter',
      'validatePasswordReset',
      'resetPasswordSubmissionLimiter',
      'requireJwtAuth',
      'setTwoFactorTempUser',
      'twoFactorTempLimiter',
    ].map((name) => [name, next]),
  );
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));
let mongo;
let owner;
let services;
let checkEmailConfig;
let generateTOTP;
let sendEmail;
let app;
let user;
let User;
let Token;
let Balance;
let invite;
const cacheMode = process.env.AUTH_USER_CACHE_MODE;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  User = mongoose.models.User || mongoose.model('User', schemas.userSchema);
  Token = mongoose.models.Token || mongoose.model('Token', schemas.tokenSchema);
  Balance = mongoose.models.Balance || mongoose.model('Balance', schemas.balanceSchema);
  mongoose.models.Session || mongoose.model('Session', schemas.sessionSchema);
  mockDatabase = mongoose;
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  if (cacheMode === undefined) delete process.env.AUTH_USER_CACHE_MODE;
  else process.env.AUTH_USER_CACHE_MODE = cacheMode;
});
beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  process.env.AUTH_USER_CACHE_MODE = 'off';
  invite = undefined;
  mockCache = { get: jest.fn(async () => undefined), delete: jest.fn(async () => true) };
  jest.isolateModules(() => {
    ({ checkEmailConfig } = require('@librechat/api'));
    owner = require('~/server/services/LegacyAuthMaintenance').legacyAuthMaintenance;
    services = require('~/server/services/AuthService');
    ({ generateTOTP } = require('~/server/services/twoFactorService'));
    ({ sendEmail } = require('~/server/utils'));
    app = express();
    app.use(express.json(), owner.admissionMiddleware);
    app.use((req, _res, next) => {
      req.user = user;
      req.invite = invite;
      next();
    });
    app.use('/auth', require('../auth'));
  });
  user = await User.create({
    email: 'existing@example.test',
    name: 'Fixture',
    provider: 'local',
    emailVerified: true,
    twoFactorEnabled: true,
    totpSecret: 'ABCDEFGHIJKLMNOP',
    pendingTotpSecret: 'ABCDEFGHIJKLMNOP',
    backupCodes: [{ codeHash: await schemas.hashBackupCode('fixture-backup'), used: false }],
  });
});
afterEach(() => jest.restoreAllMocks());

test.each(['enable', 'verify', 'verify-temp', 'confirm', 'disable', 'backup/regenerate'])(
  'actual 2FA %s route holds its write through pause and rejects new admission',
  async (path) => {
    const gate = deferred();
    const entered = deferred();
    const update = User.findByIdAndUpdate.bind(User);
    jest.spyOn(User, 'findByIdAndUpdate').mockImplementation((...args) => {
      const query = update(...args);
      const lean = query.lean.bind(query);
      query.lean = async (...options) => {
        entered.resolve();
        await gate.promise;
        return lean(...options);
      };
      return query;
    });
    let body = { backupCode: 'fixture-backup' };
    if (path === 'confirm') {
      body = { token: await generateTOTP('ABCDEFGHIJKLMNOP') };
    } else if (path === 'verify-temp') {
      body.tempToken = jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
    }
    const pending = request(app)
      .post(`/auth/2fa/${path}`)
      .send(body)
      .then((result) => result);
    try {
      await Promise.race([
        entered.promise,
        pending.then((result) => {
          throw new Error(`Request ended before its write: ${result.status}`);
        }),
      ]);
      expect(owner.pauseAdmissions('account-drain')).toBe(true);
      expect((await owner.getMaintenanceCensus('account-drain')).pendingWrites).toBeGreaterThan(0);
      expect((await request(app).post(`/auth/2fa/${path}`).send(body)).status).toBe(503);
    } finally {
      gate.resolve();
    }
    expect((await pending).status).toBe(200);
    expect(await owner.getMaintenanceCensus('account-drain')).toEqual({
      admissionClosed: true,
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
    const changed = await User.findById(user._id).select('+backupCodes +pendingBackupCodes').lean();
    if (['verify', 'verify-temp'].includes(path)) expect(changed.backupCodes[0].used).toBe(true);
    if (path === 'enable') expect(changed.pendingBackupCodes).toHaveLength(10);
    if (path === 'disable') expect(changed.twoFactorEnabled).toBe(false);
  },
);

test('registration owns the real account/balance chain and delayed email delivery', async () => {
  const gate = deferred();
  const entered = deferred();
  checkEmailConfig.mockReturnValue(true);
  sendEmail.mockImplementation(async () => {
    entered.resolve();
    await gate.promise;
    return {};
  });
  const mutation = request(app)
    .post('/auth/register')
    .send({
      email: 'new@example.test',
      name: 'New Fixture',
      username: 'new-fixture',
      password: 'FixturePassword17!',
      confirm_password: 'FixturePassword17!',
    })
    .then((result) => result);
  try {
    await Promise.race([
      entered.promise,
      mutation.then((result) => {
        throw new Error(`Registration ended before email: ${result.status}`);
      }),
    ]);
    const created = await User.findOne({ email: 'new@example.test' });
    expect((await Balance.findById(created._id)).tokenCredits).toBe(50);
    owner.pauseAdmissions('register-drain');
    expect((await owner.getMaintenanceCensus('register-drain')).pendingWrites).toBeGreaterThan(0);
  } finally {
    gate.resolve();
  }
  expect((await mutation).status).toBe(200);
  expect(await Token.countDocuments({ email: 'new@example.test' })).toBe(1);
  expect(await owner.getMaintenanceCensus('register-drain')).toEqual({
    admissionClosed: true,
    queuedContinuations: 0,
    pendingWrites: 0,
    complete: true,
  });
});

test('a sanitized token failure retains its already started deletion sibling', async () => {
  const gate = deferred();
  const entered = deferred();
  const settled = deferred();
  const remove = Token.deleteMany.bind(Token);
  let calls = 0;
  jest.spyOn(Token, 'deleteMany').mockImplementation((...args) => {
    calls++;
    if (calls === 1) return Promise.reject(new Error('fixture write acknowledgement lost'));
    entered.resolve();
    return gate.promise.then(async () => {
      try {
        return await remove(...args);
      } finally {
        settled.resolve();
      }
    });
  });
  const response = request(app)
    .post('/auth/requestPasswordReset')
    .send({ email: user.email })
    .then((result) => result);
  try {
    await entered.promise;
    expect((await response).status).toBe(400);
    owner.pauseAdmissions('token-drain');
    expect(await owner.getMaintenanceCensus('token-drain')).toMatchObject({
      queuedContinuations: 1,
      pendingWrites: 1,
      complete: false,
    });
  } finally {
    gate.resolve();
  }
  await settled.promise;
  await tick();
  expect(await owner.getMaintenanceCensus('token-drain')).toMatchObject({
    pendingWrites: 0,
    queuedContinuations: 0,
    complete: false,
  });
  expect(owner.resumeAdmissions('token-drain')).toBe(false);
});

test('registration compensation owns user deletion even when its cache failure is hidden', async () => {
  process.env.AUTH_USER_CACHE_MODE = 'on';
  checkEmailConfig.mockReturnValue(true);
  sendEmail.mockRejectedValue(new Error('fixture email acknowledgement lost'));
  mockCache.get.mockResolvedValue(['rollback-cache']);
  mockCache.delete.mockRejectedValue(new Error('fixture cache acknowledgement lost'));
  const result = await request(app).post('/auth/register').send({
    email: 'rollback@example.test',
    name: 'Rollback Fixture',
    username: 'rollback-fixture',
    password: 'FixturePassword17!',
    confirm_password: 'FixturePassword17!',
  });
  expect(result.status).toBe(500);
  expect(await User.countDocuments({ email: 'rollback@example.test' })).toBe(0);
  expect(mockCache.delete).toHaveBeenCalledWith('rollback-cache');
  owner.pauseAdmissions('rollback-drain');
  expect(await owner.getMaintenanceCensus('rollback-drain')).toEqual({
    admissionClosed: true,
    queuedContinuations: 0,
    pendingWrites: 0,
    complete: false,
  });
});

test.each(['invite consumption', 'reset session removal'])(
  'the actual account controller retains %s after the service returns',
  async (phase) => {
    const gate = deferred();
    const entered = deferred();
    let path;
    let body;
    let model;
    if (phase === 'invite consumption') {
      invite = { token: 'fixture-invite' };
      await Token.create({
        userId: user._id,
        token: invite.token,
        expiresAt: new Date(Date.now() + 60_000),
      });
      model = Token;
      path = '/auth/register';
      body = {
        email: 'invite@example.test',
        name: 'Invite Fixture',
        username: 'invite-fixture',
        password: 'FixturePassword17!',
        confirm_password: 'FixturePassword17!',
      };
    } else {
      await Token.create({
        userId: user._id,
        type: 'password_reset',
        token: bcrypt.hashSync('fixture-reset', 10),
        expiresAt: new Date(Date.now() + 60_000),
      });
      model = mongoose.models.Session;
      path = '/auth/resetPassword';
      body = { userId: user.id, token: 'fixture-reset', password: 'ChangedFixturePassword17!' };
    }
    const remove = model.deleteMany.bind(model);
    jest.spyOn(model, 'deleteMany').mockImplementation((...args) => {
      entered.resolve();
      return gate.promise.then(() => remove(...args));
    });
    const pending = request(app)
      .post(path)
      .send(body)
      .then((result) => result);
    try {
      await Promise.race([
        entered.promise,
        pending.then((result) => {
          throw new Error(`Request ended before cleanup: ${result.status}`);
        }),
      ]);
      owner.pauseAdmissions('controller-drain');
      expect((await owner.getMaintenanceCensus('controller-drain')).pendingWrites).toBeGreaterThan(
        0,
      );
    } finally {
      gate.resolve();
    }
    expect((await pending).status).toBe(200);
    expect(await owner.getMaintenanceCensus('controller-drain')).toEqual({
      admissionClosed: true,
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
  },
);

test('verification reports hidden cache failure while preserving the existing successful response', async () => {
  process.env.AUTH_USER_CACHE_MODE = 'on';
  mockCache.get.mockResolvedValue(['cached-user']);
  mockCache.delete.mockRejectedValue(new Error('fixture cache acknowledgement lost'));
  await User.updateOne({ _id: user._id }, { emailVerified: false });
  await Token.create({
    userId: user._id,
    email: user.email,
    type: 'email_verification',
    token: bcrypt.hashSync('fixture-verification', 10),
    expiresAt: new Date(Date.now() + 60_000),
  });
  expect(
    await services.verifyEmail({ body: { email: user.email, token: 'fixture-verification' } }),
  ).toMatchObject({ status: 'success' });
  expect((await User.findById(user._id)).emailVerified).toBe(true);
  owner.pauseAdmissions('verification-drain');
  expect(await owner.getMaintenanceCensus('verification-drain')).toMatchObject({
    queuedContinuations: 0,
    pendingWrites: 0,
    complete: false,
  });
});
