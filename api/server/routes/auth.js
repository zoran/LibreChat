const {
  authAdmissionMiddleware,
  ownAuthHandler,
  authPersistence,
} = require('~/server/services/LegacyAuthMaintenance');
const express = require('express');
const { getTenantId, tenantStorage, DEFAULT_SESSION_EXPIRY } = require('@librechat/data-schemas');
const {
  createBrowserAuth,
  math,
  limiterCache,
  createSetBalanceConfig,
  requireTwoFactorSetupToken,
  createTwoFactorManagementLimiter,
  forceRefreshCloudFrontAuthCookies,
  clearCloudFrontCookies,
  blockTwoFactorDisableWhenRequired,
  requireTwoFactorSetupAcknowledgementToken,
  requireTwoFactorSetupFinalizationToken,
  getAuthMode,
  getEmailCodeConfig,
  getAuthSelection,
  setAuthSelection,
  mayRefreshGuest,
  EMAIL_CODE_COOKIE_OPTIONS,
} = require('@librechat/api');
const {
  resetPasswordRequestController,
  resetPasswordController,
  registrationController,
  graphTokenController,
  refreshController,
} = require('~/server/controllers/AuthController');
const {
  regenerateBackupCodes,
  disable2FA,
  confirm2FA,
  enable2FA,
  verify2FA,
} = require('~/server/controllers/TwoFactorController');
const {
  listPasskeys,
  updatePasskey,
  removePasskey,
  authenticatePasskey,
  loginPasskeyOptions,
  registerPasskeyOptions,
  registerPasskeyVerify,
} = require('~/server/controllers/auth/PasskeyController');
const {
  verify2FAWithTempToken,
  confirm2FASetupWithTempToken,
  acknowledge2FASetup,
  finalize2FASetup,
} = require('~/server/controllers/auth/TwoFactorAuthController');
const { logoutController } = require('~/server/controllers/auth/LogoutController');
const { loginController } = require('~/server/controllers/auth/LoginController');
const { findBalanceByUser, upsertBalanceFields } = require('~/models');
const browserMethods = require('~/models');
const { getAppConfig } = require('~/server/services/Config');
const middleware = require('~/server/middleware');
const emailCodeAuth = require('~/server/controllers/auth/emailCodeController');
const { logoutUser } = require('~/server/services/AuthService');

const setBalanceConfig = ownAuthHandler(
  createSetBalanceConfig({
    observer: authPersistence,
    getAppConfig,
    findBalanceByUser,
    upsertBalanceFields,
  }),
);

const router = express.Router();
router.use(authAdmissionMiddleware);
const cortexRoutes = new Set([
  'GET /mode',
  'POST /email-code/request',
  'POST /email-code/verify',
  'POST /guest',
  'POST /logout',
  'POST /refresh',
  'POST /browser',
  'POST /browser/reset',
]);
router.use((req, res, next) => {
  if (getAuthMode() !== 'default' && !cortexRoutes.has(`${req.method} ${req.path}`)) {
    return res.status(404).json({ code: 'AUTH_MODE_DISABLED' });
  }
  return next();
});
const cortexSameOrigin = (req, res, next) =>
  getAuthMode() === 'default' ? next() : middleware.requireSameOrigin(req, res, next);
router.get('/mode', (_req, res) => res.set('Cache-Control', 'no-store').json(getEmailCodeConfig()));
router.post(
  '/email-code/request',
  middleware.requireSameOrigin,
  middleware.checkBan,
  ownAuthHandler(emailCodeAuth.requestCode),
);
router.post(
  '/email-code/verify',
  middleware.requireSameOrigin,
  middleware.checkBan,
  ownAuthHandler(emailCodeAuth.verifyCode),
);
const browserAuth = createBrowserAuth({
  ...browserMethods,
  getAppConfig: () => getAppConfig({ baseOnly: true }),
  getTenantId,
  origin: process.env.DOMAIN_CLIENT,
  store: limiterCache('browser_enrollment_limiter', authPersistence),
  mintToken: (user) =>
    browserMethods.generateToken(user, math(process.env.SESSION_EXPIRY, DEFAULT_SESSION_EXPIRY)),
});
const twoFactorManagementLimiter = ownAuthHandler(
  createTwoFactorManagementLimiter({
    getAppConfig: () => getAppConfig({ baseOnly: true }),
    store: limiterCache('two_factor_management_user_limiter', authPersistence),
  }),
);
const getCloudFrontAuthCookieRefreshResult = (req, res) => {
  const warmedResult = req.cloudFrontAuthCookieRefreshResult;
  if (warmedResult && (warmedResult.attempted || !warmedResult.enabled)) {
    return warmedResult;
  }

  return forceRefreshCloudFrontAuthCookies(req, res, req.user);
};

const ldapAuth = !!process.env.LDAP_URL && !!process.env.LDAP_USER_SEARCH_BASE;
//Local
router.post(
  '/logout',
  cortexSameOrigin,
  ownAuthHandler((req, res, next) => {
    if (getAuthMode() !== 'default' && req.cookies?.refreshToken) {
      return emailCodeAuth.logout(req, res, next);
    }
    return next();
  }),
  middleware.requireJwtAuth,
  ownAuthHandler(async (req, res, next) => {
    // Signing out of email must not destroy the retained guest identity or its private history.
    if (getAuthMode() !== 'default' && req.user?.provider === 'email_code') {
      const result = await logoutUser(req);
      if (result.status !== 200) {
        return res
          .set('Cache-Control', 'no-store')
          .status(result.status)
          .json({ code: 'AUTH_SESSION_UNAVAILABLE' });
      }
      res.clearCookie('refreshToken', EMAIL_CODE_COOKIE_OPTIONS);
      res.clearCookie('token_provider', EMAIL_CODE_COOKIE_OPTIONS);
      clearCloudFrontCookies(res, { userId: String(req.user._id), tenantId: req.user.tenantId });
      return res.set('Cache-Control', 'no-store').json({ message: 'Logout successful' });
    }
    return browserAuth.forget(req, res, next);
  }),
  logoutController,
);
router.post(
  '/guest',
  middleware.requireSameOrigin,
  middleware.checkBan,
  ownAuthHandler(async (req, res, next) => {
    if (getAuthMode() !== 'transition') return res.status(404).json({ code: 'AUTH_MODE_DISABLED' });
    try {
      await emailCodeAuth.revokeCurrentRefresh(req);
      for (const name of [
        'refreshToken',
        'token_provider',
        'openid_user_id',
        'openid_access_token',
        'openid_id_token',
      ]) {
        res.clearCookie(name, EMAIL_CODE_COOKIE_OPTIONS);
        if (req.cookies) delete req.cookies[name];
      }
      setAuthSelection(res, 'guest');
      req.headers['x-librechat-browser'] = '1';
      delete req.tenantId;
      return await tenantStorage.run(
        { ...tenantStorage.getStore(), tenantId: undefined },
        async () => browserAuth.bootstrap(req, res, next),
      );
    } catch {
      return res.status(503).json({ code: 'EMAIL_CODE_UNAVAILABLE' });
    }
  }),
);
router.post(
  '/login',
  middleware.logHeaders,
  middleware.requireSameOrigin,
  middleware.loginLimiter,
  middleware.checkBan,
  middleware.validateEmailLogin,
  ldapAuth ? middleware.requireLdapAuth : middleware.requireLocalAuth,
  setBalanceConfig,
  loginController,
);
router.post(
  '/refresh',
  cortexSameOrigin,
  ownAuthHandler((req, res, next) => {
    if (getAuthMode() === 'default')
      return browserAuth.refresh(req, res, () => refreshController(req, res, next));
    if (req.cookies?.refreshToken) return emailCodeAuth.refresh(req, res, next);
    if (mayRefreshGuest(req)) return browserAuth.refresh(req, res, () => res.status(200).json({}));
    // Empty state routes to the explicit login choices, never to guest bootstrap.
    return res.set('Cache-Control', 'no-store').status(200).json({});
  }),
);
const allowBrowserAction = (req, res, next) => {
  if (
    getAuthMode() === 'default' ||
    (getAuthMode() === 'transition' &&
      (getAuthSelection(req) === 'guest' ||
        (req.path === '/browser/reset' && mayRefreshGuest(req))))
  )
    return next();
  return res.status(403).json({ code: 'AUTH_MODE_DISABLED' });
};
router.post(
  '/browser',
  cortexSameOrigin,
  allowBrowserAction,
  middleware.checkBan,
  browserAuth.bootstrap,
);
router.post('/browser/reset', cortexSameOrigin, allowBrowserAction, browserAuth.reset);
router.post('/cloudfront/refresh', middleware.requireJwtAuth, (req, res) => {
  const result = getCloudFrontAuthCookieRefreshResult(req, res);
  if (!result.enabled) {
    return res.sendStatus(404);
  }

  const status = result.refreshed ? 200 : 500;
  return res.status(status).json({
    ok: result.refreshed,
    expiresInSec: result.expiresInSec,
    refreshAfterSec: result.refreshAfterSec,
  });
});
router.post(
  '/register',
  middleware.registerLimiter,
  middleware.checkBan,
  middleware.checkInviteUser,
  middleware.validateRegistration,
  registrationController,
);
router.post(
  '/requestPasswordReset',
  middleware.resetPasswordLimiter,
  middleware.checkBan,
  middleware.validatePasswordReset,
  resetPasswordRequestController,
);
router.post(
  '/resetPassword',
  middleware.resetPasswordSubmissionLimiter,
  middleware.checkBan,
  middleware.validatePasswordReset,
  resetPasswordController,
);

router.post(
  '/2fa/enable',
  middleware.requireJwtAuth,
  twoFactorManagementLimiter,
  ownAuthHandler(enable2FA),
);
router.post(
  '/2fa/verify',
  middleware.requireJwtAuth,
  twoFactorManagementLimiter,
  ownAuthHandler(verify2FA),
);
router.post(
  '/2fa/setup',
  middleware.setTwoFactorTempUser,
  middleware.twoFactorSetupLimiter,
  middleware.checkBan,
  requireTwoFactorSetupToken,
  middleware.blockRetiredSetupToken,
  ownAuthHandler(enable2FA),
);
router.post(
  '/2fa/setup/confirm',
  middleware.setTwoFactorTempUser,
  middleware.twoFactorTempLimiter,
  middleware.checkBan,
  requireTwoFactorSetupToken,
  middleware.blockRetiredSetupToken,
  ownAuthHandler(confirm2FASetupWithTempToken),
);
router.post(
  '/2fa/setup/acknowledge',
  middleware.setTwoFactorAcknowledgementTempUser,
  middleware.twoFactorSetupLimiter,
  middleware.checkBan,
  requireTwoFactorSetupAcknowledgementToken,
  ownAuthHandler(acknowledge2FASetup),
);
router.post(
  '/2fa/setup/finalize',
  middleware.setTwoFactorFinalizationTempUser,
  middleware.twoFactorSetupLimiter,
  middleware.checkBan,
  requireTwoFactorSetupFinalizationToken,
  ownAuthHandler(finalize2FASetup),
);
router.post(
  '/2fa/verify-temp',
  middleware.requireSameOrigin,
  middleware.setTwoFactorTempUser,
  middleware.twoFactorTempLimiter,
  middleware.checkBan,
  ownAuthHandler(verify2FAWithTempToken),
);
router.post(
  '/2fa/confirm',
  middleware.requireJwtAuth,
  twoFactorManagementLimiter,
  ownAuthHandler(confirm2FA),
);
router.post(
  '/2fa/disable',
  middleware.requireJwtAuth,
  twoFactorManagementLimiter,
  blockTwoFactorDisableWhenRequired,
  ownAuthHandler(disable2FA),
);
router.post(
  '/2fa/backup/regenerate',
  middleware.requireJwtAuth,
  twoFactorManagementLimiter,
  ownAuthHandler(regenerateBackupCodes),
);

/* Passkeys (WebAuthn) */
router.post(
  '/passkey/login/options',
  middleware.logHeaders,
  middleware.passkeyLimiter,
  middleware.checkBan,
  ownAuthHandler(loginPasskeyOptions),
);
router.post(
  '/passkey/login/verify',
  middleware.logHeaders,
  middleware.requireSameOrigin,
  middleware.passkeyLimiter,
  middleware.checkBan,
  ownAuthHandler(authenticatePasskey),
  setBalanceConfig,
  loginController,
);
router.get('/passkey', middleware.requireJwtAuth, ownAuthHandler(listPasskeys));
router.post(
  '/passkey/register/options',
  middleware.requireJwtAuth,
  middleware.passkeyStepUpLimiter,
  ownAuthHandler(registerPasskeyOptions),
);
router.post(
  '/passkey/register/verify',
  middleware.requireJwtAuth,
  middleware.passkeyStepUpLimiter,
  ownAuthHandler(registerPasskeyVerify),
);
router.patch('/passkey/:passkeyId', middleware.requireJwtAuth, ownAuthHandler(updatePasskey));
router.delete(
  '/passkey/:passkeyId',
  middleware.requireJwtAuth,
  middleware.passkeyStepUpLimiter,
  ownAuthHandler(removePasskey),
);

router.get('/graph-token', middleware.requireJwtAuth, graphTokenController);

module.exports = router;

// Private composition port; this property does not create an HTTP route.
module.exports.browserMaintenance = Object.freeze({
  pauseAdmissions: browserAuth.pauseAdmissions,
  resumeAdmissions: browserAuth.resumeAdmissions,
  getMaintenanceCensus: browserAuth.getMaintenanceCensus,
});
