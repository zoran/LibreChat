const { withAuthRequest, authMutation } = require('~/server/services/LegacyAuthMaintenance');
const { createLoginController, clearCloudFrontCookies } = require('@librechat/api');
const { generate2FATempToken } = require('~/server/services/twoFactorService');
const { getUserById, deleteAllUserSessions } = require('~/models');
const { setAuthTokens } = require('~/server/services/AuthService');

const loginController = createLoginController({
  generate2FATempToken,
  getUserById,
  deleteAllUserSessions: (...args) => authMutation(deleteAllUserSessions, ...args),
  setAuthTokens,
  clearCloudFrontCookies,
});

module.exports = {
  loginController: (req, res) => withAuthRequest(req, () => loginController(req, res)),
};
