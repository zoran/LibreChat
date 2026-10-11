const {
  authAdmissionMiddleware,
  ownAuthHandler,
  authPersistence,
} = require('~/server/services/LegacyAuthMaintenance');
const express = require('express');
const { getTenantId, DEFAULT_SESSION_EXPIRY } = require('@librechat/data-schemas');
const {
  createBrowserAuth,
  math,
  limiterCache,
  createSetBalanceConfig,
  requireTwoFactorSetupToken,
  createTwoFactorManagementLimiter,
  forceRefreshCloudFrontAuthCookies,
  blockTwoFactorDisableWhenRequired,
  requireTwoFactorSetupAcknowledgementToken,
  requireTwoFactorSetupFinalizationToken,
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
router.post('/logout', middleware.requireJwtAuth, browserAuth.forget, logoutController);
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
router.post('/refresh', browserAuth.refresh, refreshController);
router.post('/browser', middleware.checkBan, browserAuth.bootstrap);
router.post('/browser/reset', browserAuth.reset);
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
