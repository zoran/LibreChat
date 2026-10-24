/** Actual Passport-local -> middleware -> controller lifecycle, with deferred storage ports. */
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  ...jest.requireActual('../../../../packages/api/src/auth/maintenance.ts'),
  ...jest.requireActual('../../../../packages/api/src/auth/sessionMaintenance.ts'),
  isEnabled: () => false,
  checkEmailConfig: () => false,
  comparePassword: jest.fn(async () => true),
}));
jest.mock('passport', () => new (jest.requireActual('passport').Passport)());
jest.mock('~/models', () => ({
  findUser: jest.fn(),
  updateUser: jest.fn(),
  getUserById: jest.fn(async () => ({ credentialsChangedAt: undefined })),
  deleteAllUserSessions: jest.fn(async () => ({ acknowledged: true })),
}));
jest.mock('~/server/services/AuthService', () => ({ setAuthTokens: jest.fn() }));
jest.mock('~/server/services/twoFactorService', () => ({ generate2FATempToken: jest.fn() }));

const { EventEmitter } = require('node:events');
const { AsyncLocalStorage } = require('node:async_hooks');
const passport = require('passport');
const { findUser, updateUser } = require('~/models');
const { setAuthTokens } = require('~/server/services/AuthService');
const {
  legacyAuthMaintenance: owner,
  installAuthPassport,
  authPersistence,
} = require('~/server/services/LegacyAuthMaintenance');
const requireLocalAuth = require('~/server/middleware/requireLocalAuth');
const { loginController } = require('~/server/controllers/auth/LoginController');
const localStrategy = require('~/strategies/localStrategy');
installAuthPassport(passport);

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('admitted login retains strategy writes and session creation across pause and response disconnect', async () => {
  passport.use(localStrategy());
  const verification = deferred();
  const session = deferred();
  findUser.mockResolvedValue({
    _id: 'user',
    password: 'hash',
    createdAt: new Date('2020-01-01'),
    emailVerified: false,
  });
  updateUser.mockImplementation(() => verification.promise);
  setAuthTokens.mockImplementation(() =>
    authPersistence.write(async () => {
      await session.promise;
      return 'test-token';
    }),
  );
  const req = { body: { email: 'test@example.com', password: 'test-password' }, headers: {} };
  const res = Object.assign(new EventEmitter(), {
    end: jest.fn(),
    setHeader: jest.fn(),
    status: jest.fn(),
    send: jest.fn(),
    json: jest.fn(),
  });
  res.status.mockReturnValue(res);
  res.send.mockImplementation(() => res.end());
  res.json.mockImplementation(() => res.end());
  const error = jest.fn();
  owner.admissionMiddleware(req, res, () =>
    requireLocalAuth(req, res, (err) => (err ? error(err) : loginController(req, res))),
  );
  await tick();
  expect(updateUser).toHaveBeenCalledTimes(1);
  owner.pauseAdmissions('login-drain');
  expect(await owner.getMaintenanceCensus('login-drain')).toMatchObject({
    queuedContinuations: 1,
    pendingWrites: 1,
  });
  req.aborted = true; // Socket state is not an ownership completion signal.
  verification.resolve();
  await tick();
  expect(setAuthTokens).toHaveBeenCalledTimes(1);
  expect(await owner.getMaintenanceCensus('login-drain')).toMatchObject({
    queuedContinuations: 1,
    pendingWrites: 1,
  });
  session.resolve();
  await tick();
  expect(error).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(200);
  expect(await owner.getMaintenanceCensus('login-drain')).toEqual({
    admissionClosed: true,
    queuedContinuations: 0,
    pendingWrites: 0,
    complete: true,
  });
  expect(owner.resumeAdmissions('login-drain')).toBe(true);
});

function passportFixture() {
  let instance, maintenance, install;
  jest.isolateModules(() => {
    instance = new (jest.requireActual('passport').Passport)();
    const service = require('~/server/services/LegacyAuthMaintenance');
    maintenance = service.legacyAuthMaintenance;
    install = service.installAuthPassport;
    install(instance);
  });
  const req = { headers: {}, session: {}, body: {} };
  const res = Object.assign(new EventEmitter(), {
    end: jest.fn(),
    setHeader: jest.fn(),
    statusCode: 200,
  });
  instance.initialize()(req, res, () => undefined);
  return { passport: instance, owner: maintenance, install, req, res, end: res.end };
}

test('actual Passport preparation, callback delivery and returned tail retain the original request', async () => {
  const f = passportFixture();
  const requestContext = new AsyncLocalStorage();
  const preparation = deferred();
  const tail = deferred();
  const child = deferred();
  let receiver;
  let childWork;
  const options = { session: false, scope: ['fixture'] };
  const strategy = {
    name: 'delayed',
    async authenticate(req, receivedOptions) {
      receiver = this;
      expect(this).not.toBe(strategy);
      expect(req).toBe(f.req);
      expect(receivedOptions).toBe(options);
      await preparation.promise;
      this.success({ id: 'principal' }, { marker: 'information' });
      await tail.promise;
    },
  };
  const originalArity = strategy.authenticate.length;
  expect(f.passport.use(strategy)).toBe(f.passport);
  expect(strategy.authenticate.length).toBe(originalArity);
  const callback = jest.fn((error, user, info) => {
    expect(error).toBeNull();
    expect(user).toEqual({ id: 'principal' });
    expect(info).toEqual({ marker: 'information' });
    expect(requestContext.getStore()).toBe('tenant-request');
    expect(f.owner.current()).toBe(f.owner.forRequest(f.req));
    childWork = f.owner.current().write(() => child.promise);
  });
  const next = jest.fn();
  requestContext.run('tenant-request', () =>
    f.owner.admissionMiddleware(f.req, f.res, () => {
      f.passport.authenticate('delayed', options, callback)(f.req, f.res, next);
    }),
  );
  f.res.emit('close');
  f.owner.pauseAdmissions('passport-original');
  let settled = false;
  const drain = f.owner.drain().then(() => {
    settled = true;
  });
  expect(await f.owner.getMaintenanceCensus('passport-original')).toMatchObject({
    queuedContinuations: 1,
    pendingWrites: 0,
  });
  preparation.resolve();
  await tick();
  expect(callback).toHaveBeenCalledTimes(1);
  expect(receiver.success.length).toBe(2);
  child.resolve();
  await childWork;
  expect(settled).toBe(false);
  tail.resolve();
  await drain;
  expect(next).not.toHaveBeenCalled();
  expect(settled).toBe(true);
});

test.each(['success', 'fail', 'redirect', 'pass', 'error'])(
  'real Passport %s preserves terminal behavior and duplicate delivery stays single',
  async (terminal) => {
    const f = passportFixture();
    let clone;
    const strategy = {
      name: 'terminal',
      authenticate(req, options) {
        clone = this;
        expect(options.session).toBe(false);
      },
    };
    const use = f.passport.use;
    expect(f.install(f.passport)).toBe(f.passport);
    expect(f.passport.use).toBe(use);
    f.passport.use('alias', strategy);
    const callback = jest.fn();
    const next = jest.fn();
    f.owner.admissionMiddleware(f.req, f.res, () => {
      f.passport.authenticate('alias', { session: false }, callback)(f.req, f.res, next);
    });
    f.res.emit('close');
    f.owner.pauseAdmissions('terminal-original');
    expect((await f.owner.getMaintenanceCensus('terminal-original')).queuedContinuations).toBe(1);
    const failure = new Error('strategy error');
    const args = {
      success: [{ id: 'principal' }, { info: true }],
      fail: ['challenge', 403],
      redirect: ['/destination', 307],
      pass: [],
      error: [failure],
    }[terminal];
    clone[terminal](...args);
    clone[terminal](...args);
    await tick();
    if (terminal === 'success') expect(callback).toHaveBeenCalledWith(null, ...args);
    if (terminal === 'fail') expect(callback).toHaveBeenCalledWith(null, false, 'challenge', 403);
    if (terminal === 'error') expect(callback).toHaveBeenCalledWith(failure);
    if (['success', 'fail', 'error'].includes(terminal)) expect(callback).toHaveBeenCalledTimes(1);
    if (terminal === 'pass') expect(next).toHaveBeenCalledTimes(1);
    if (terminal === 'redirect') {
      expect(f.res.statusCode).toBe(307);
      expect(f.res.setHeader).toHaveBeenCalledWith('Location', '/destination');
      expect(f.end).toHaveBeenCalledTimes(1);
    }
    expect(await f.owner.getMaintenanceCensus('terminal-original')).toMatchObject({
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
  },
);

test('preinstalled session strategy retains the original req-aware deserializer callback', async () => {
  const f = passportFixture();
  f.req.session.passport = { user: 'stored-user' };
  let complete;
  f.passport.deserializeUser(function (req, id, done) {
    expect(req).toBe(f.req);
    expect(id).toBe('stored-user');
    complete = done;
  });
  const next = jest.fn(() => {
    expect(f.owner.current()).toBe(f.owner.forRequest(f.req));
  });
  f.owner.admissionMiddleware(f.req, f.res, () => f.passport.session()(f.req, f.res, next));
  f.res.emit('close');
  f.owner.pauseAdmissions('builtin-session');
  expect((await f.owner.getMaintenanceCensus('builtin-session')).queuedContinuations).toBe(1);
  complete(null, { id: 'restored' });
  await tick();
  expect(next).toHaveBeenCalledTimes(1);
  expect(f.req.user).toEqual({ id: 'restored' });
  expect((await f.owner.getMaintenanceCensus('builtin-session')).queuedContinuations).toBe(0);
});

test.each(['throw', 'reject'])(
  'strategy preparation %s preserves actual terminal custody and original failure',
  async (mode) => {
    const f = passportFixture();
    const failure = new Error('preparation failed');
    let complete;
    f.passport.use({
      name: 'broken',
      authenticate() {
        if (mode === 'throw') throw failure;
        complete = () => this.error(failure);
        return Promise.reject(failure);
      },
    });
    const callback = jest.fn();
    f.owner.admissionMiddleware(f.req, f.res, () => {
      f.passport.authenticate('broken', { session: false }, callback)(f.req, f.res, jest.fn());
    });
    f.res.emit('close');
    f.owner.pauseAdmissions('broken');
    await tick();
    if (mode === 'reject') {
      expect(callback).not.toHaveBeenCalled();
      expect(await f.owner.getMaintenanceCensus('broken')).toMatchObject({
        queuedContinuations: 1,
        complete: true,
      });
      let drained = false;
      const drain = f.owner.drain().then(() => {
        drained = true;
      });
      await tick();
      expect(drained).toBe(false);
      complete();
      await drain;
    }
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(failure);
    expect(await f.owner.getMaintenanceCensus('broken')).toMatchObject({
      queuedContinuations: 0,
      complete: true,
    });
  },
);

test('paused Passport admission rejects preparation without substituting an authentication policy', async () => {
  const f = passportFixture();
  const authenticate = jest.fn();
  f.passport.use('held', { authenticate });
  f.owner.pauseAdmissions('startup');
  const callback = jest.fn();
  f.passport.authenticate('held', { session: false }, callback)(f.req, f.res, jest.fn());
  await tick();
  expect(authenticate).not.toHaveBeenCalled();
  expect(callback).toHaveBeenCalledTimes(1);
  expect(callback.mock.calls[0][0].message).toBe('APP_QUIESCING');
});
