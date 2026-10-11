const {
  ownAuthHandler,
  authPersistence,
  authMutation,
} = require('~/server/services/LegacyAuthMaintenance');
const { createTwoFactorLimiters, limiterCache, removePorts } = require('@librechat/api');
const { logViolation } = require('~/cache');

const { twoFactorTempLimiter, twoFactorSetupLimiter } = createTwoFactorLimiters({
  env: process.env,
  limiterCache: (prefix) => limiterCache(prefix, authPersistence),
  removePorts,
  logViolation: (...args) => authMutation(logViolation, ...args),
});

module.exports = ownAuthHandler(twoFactorTempLimiter);
module.exports.twoFactorSetupLimiter = ownAuthHandler(twoFactorSetupLimiter);
