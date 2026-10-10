const { authMutation } = require('./LegacyAuthMaintenance');
const {
  createRefreshTokenBridgeIdentity,
  createRefreshTokenBridgeService,
  math,
} = require('@librechat/api');
const {
  logger,
  encryptV2,
  decryptV2,
  DEFAULT_REFRESH_TOKEN_EXPIRY,
} = require('@librechat/data-schemas');
const db = require('~/models');

module.exports = createRefreshTokenBridgeService({
  db: {
    ...db,
    deleteRefreshTokenBridges: (...args) => authMutation(db.deleteRefreshTokenBridges, ...args),
    upsertRefreshTokenBridge: (...args) => authMutation(db.upsertRefreshTokenBridge, ...args),
  },
  logger,
  encrypt: encryptV2,
  decrypt: decryptV2,
  math,
  defaultRefreshTokenExpiry: DEFAULT_REFRESH_TOKEN_EXPIRY,
  createIdentity: createRefreshTokenBridgeIdentity,
});
