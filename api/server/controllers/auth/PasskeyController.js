const {
  authMutation,
  authUserUpdate,
  authCache,
} = require('~/server/services/LegacyAuthMaintenance');
const bcrypt = require('bcryptjs');
const { CacheKeys } = require('librechat-data-provider');
const { createPasskeyHandlers } = require('@librechat/api');
const { checkBan } = require('~/server/middleware');
const { getLogStores } = require('~/cache');
const { getAppConfig } = require('~/server/services/Config/app');
const db = require('~/models');

module.exports = createPasskeyHandlers({
  checkBan,
  compare: bcrypt.compare,
  getChallengeCache: () => authCache(getLogStores(CacheKeys.PASSKEY_CHALLENGE)),
  getAppConfig,
  getUserById: db.getUserById,
  updateUser: (...args) => authUserUpdate(db.updateUser, ...args),
  createPasskey: (...args) => authMutation(db.createPasskey, ...args),
  deletePasskey: (...args) => authMutation(db.deletePasskey, ...args),
  renamePasskey: (...args) => authMutation(db.renamePasskey, ...args),
  recordPasskeyUse: (...args) => authMutation(db.recordPasskeyUse, ...args),
  findPasskeysByUser: db.findPasskeysByUser,
  countPasskeysByUser: db.countPasskeysByUser,
  findPasskeyByCredentialId: db.findPasskeyByCredentialId,
});
