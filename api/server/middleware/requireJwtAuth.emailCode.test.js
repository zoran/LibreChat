const mockGate = jest.fn((_req, _res, _next, continued) => continued());
const mockEnrollment = jest.fn(() => true);

jest.mock('passport', () => ({
  _strategy: jest.fn(() => ({})),
  authenticate: jest.fn((strategy, _options, callback) => (req) => callback(null, req.testUser)),
}));
jest.mock('~/models', () => ({
  getUserById: jest.fn(),
  updateUserStatefulCodeEnvironment: jest.fn(),
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), warn: jest.fn() },
}));
jest.mock('@librechat/api', () => ({
  getAuthMode: () => process.env.AUTH_MODE ?? 'default',
  isEnabled: () => true,
  isTokenRetired: () => false,
  createRequiredTwoFactorGate: () => mockGate,
  clearCloudFrontCookies: jest.fn(),
  tenantContextMiddleware: (req, _res, next) => {
    req.tenantWasEstablished = true;
    next();
  },
  getAuthFailureReasonCategory: () => 'test',
  buildSafeAuthLogContext: () => ({}),
  maybeRefreshCloudFrontAuthCookiesMiddleware: (_req, _res, next) => next(),
  recordRumProxyRequest: jest.fn(),
  getValidOpenIdReuseUserId: () => 'user-id',
  generateTwoFactorSetupToken: jest.fn(),
  isTwoFactorEnrollmentRequired: (...args) => mockEnrollment(...args),
  continueAfterOptionalAuth: (req, res, next, user, strategy, tenant, deps) => {
    req.enrollmentRequired = deps.enrollmentRequired(user);
    req.user = user;
    req.authStrategy = strategy;
    tenant(req, res, next);
  },
  createUserPreferencesHandler: () => (_req, res) => res.sendStatus(204),
}));
jest.mock('~/server/services/LegacyAuthMaintenance', () => ({ ownAuthHandler: (fn) => fn }));
jest.mock('~/server/routes/settings', () => require('express').Router());
jest.mock('~/server/controllers/UserController', () =>
  Object.fromEntries(
    [
      'updateUserPluginsController',
      'resendVerificationController',
      'getTermsStatusController',
      'acceptTermsController',
      'verifyEmailController',
      'requestEmailChangeController',
      'confirmEmailChangeController',
      'deleteUserController',
      'getUserController',
    ].map((name) => [name, (_req, res) => res.status(200).json({ reached: name })]),
  ),
);
jest.mock('~/server/middleware', () =>
  Object.fromEntries(
    [
      'verifyEmailLimiter',
      'emailChangeLimiter',
      'emailChangeSubmissionLimiter',
      'emailChangeSubmissionIpLimiter',
      'verifyEmailSubmissionLimiter',
      'configMiddleware',
      'strictConfigMiddleware',
      'canDeleteAccount',
      'requireJwtAuth',
    ].map((name) => [name, (_req, _res, next) => next()]),
  ),
);

const passport = require('passport');
const express = require('express');
const supertest = require('supertest');
const requireJwtAuth = require('./requireJwtAuth');
const optionalJwtAuth = require('./optionalJwtAuth');
const userRouter = require('~/server/routes/user');

describe('Cortex identity policy consumers', () => {
  const originalMode = process.env.AUTH_MODE;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AUTH_MODE = 'transition';
  });
  afterAll(() => {
    if (originalMode == null) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = originalMode;
  });
  const request = () => ({
    headers: {
      cookie: 'token_provider=openid; openid_user_id=old-provider',
      authorization: 'Bearer value',
    },
    testUser: { id: 'user-id', provider: 'email_code', tenantId: 'cortex-bwi' },
  });

  it.each(['transition', 'email_code'])(
    'selects only native JWT and no closed enrollment flow in %s',
    (mode) => {
      process.env.AUTH_MODE = mode;
      const req = request();
      const next = jest.fn();
      requireJwtAuth(req, {}, next);
      expect(passport.authenticate.mock.calls.map(([strategy]) => strategy)).toEqual(['jwt']);
      expect(mockGate).not.toHaveBeenCalled();
      expect(req.tenantWasEstablished).toBe(true);
      expect(next).toHaveBeenCalledTimes(1);
    },
  );

  it('applies the same native strategy to optional auth and RUM', () => {
    const req = request();
    optionalJwtAuth(req, {}, jest.fn());
    expect(req.authStrategy).toBe('jwt');
    expect(req.enrollmentRequired).toBe(false);
    expect(mockEnrollment).not.toHaveBeenCalled();
    requireJwtAuth.requireRumProxyAuth(request(), {}, jest.fn());
    expect(passport.authenticate.mock.calls.every(([strategy]) => strategy === 'jwt')).toBe(true);
  });

  it('preserves upstream OpenID strategy and enrollment policy in default mode', () => {
    process.env.AUTH_MODE = 'default';
    requireJwtAuth(request(), {}, jest.fn());
    expect(passport.authenticate).toHaveBeenCalledWith(
      'openidJwt',
      expect.anything(),
      expect.any(Function),
    );
    expect(mockGate).toHaveBeenCalledTimes(1);
    const req = request();
    optionalJwtAuth(req, {}, jest.fn());
    expect(req.enrollmentRequired).toBe(true);
  });

  it.each(['/email/change', '/email/verify', '/verify', '/verify/resend', '/EMAIL/CHANGE/'])(
    'blocks legacy identity mutation %s in Cortex without changing default routing',
    async (path) => {
      const app = express();
      app.use('/api/user', userRouter);
      expect((await supertest(app).post(`/api/user${path}`)).status).toBe(404);
      process.env.AUTH_MODE = 'default';
      expect((await supertest(app).post(`/api/user${path}`)).status).toBe(200);
    },
  );
});
