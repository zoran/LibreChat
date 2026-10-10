/** Actual Passport-local -> middleware -> controller lifecycle, with deferred storage ports. */
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('../../../../packages/api/src/auth/maintenance.ts'),
  ...jest.requireActual('../../../../packages/api/src/auth/sessionMaintenance.ts'),
  isEnabled: () => false,
  checkEmailConfig: () => false,
  comparePassword: jest.fn(async () => true),
}));
jest.mock('passport', () => new (jest.requireActual('passport').Passport)());
jest.mock('~/models', () => ({ findUser: jest.fn(), updateUser: jest.fn() }));
jest.mock('~/server/services/AuthService', () => ({ setAuthTokens: jest.fn() }));
jest.mock('~/server/services/twoFactorService', () => ({ generate2FATempToken: jest.fn() }));

const { EventEmitter } = require('node:events');
const passport = require('passport');
const { findUser, updateUser } = require('~/models');
const { setAuthTokens } = require('~/server/services/AuthService');
const {
  legacyAuthMaintenance: owner,
  authPersistence,
} = require('~/server/services/LegacyAuthMaintenance');
const requireLocalAuth = require('~/server/middleware/requireLocalAuth');
const { loginController } = require('~/server/controllers/auth/LoginController');
const localStrategy = require('~/strategies/localStrategy');

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
