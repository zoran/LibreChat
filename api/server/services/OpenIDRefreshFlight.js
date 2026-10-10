const { authMutation } = require('./LegacyAuthMaintenance');
const { createOpenIDRefreshFlightService } = require('@librechat/api');
const { logger, encryptV2, decryptV2 } = require('@librechat/data-schemas');
const db = require('~/models');

module.exports = createOpenIDRefreshFlightService({
  db: {
    ...db,
    acquireOpenIDRefreshFlight: (...args) => authMutation(db.acquireOpenIDRefreshFlight, ...args),
    claimOpenIDRefreshFlightDelivery: (...args) =>
      authMutation(db.claimOpenIDRefreshFlightDelivery, ...args),
    completeOpenIDRefreshFlight: (...args) => authMutation(db.completeOpenIDRefreshFlight, ...args),
    failOpenIDRefreshFlight: (...args) => authMutation(db.failOpenIDRefreshFlight, ...args),
    releaseOpenIDRefreshFlightDelivery: (...args) =>
      authMutation(db.releaseOpenIDRefreshFlightDelivery, ...args),
    renewOpenIDRefreshFlight: (...args) => authMutation(db.renewOpenIDRefreshFlight, ...args),
    revokeOpenIDRefreshFlight: (...args) => authMutation(db.revokeOpenIDRefreshFlight, ...args),
  },
  logger,
  encrypt: encryptV2,
  decrypt: decryptV2,
});
