/** Legacy auth composition only; identity, tenant policy and storage remain with their owners. */
const {
  createAuthMaintenance,
  createAuthSessionStore,
  observeAuthCacheWrite,
} = require('@librechat/api');
const legacyAuthMaintenance = createAuthMaintenance();
const authWrite = (action) =>
  legacyAuthMaintenance.run(undefined, (operation) => operation.write(action));
const authTrack = (action) => legacyAuthMaintenance.run(undefined, action);
const authPersistence = Object.freeze({ write: authWrite });
const authUserMutation = (method, ...args) =>
  authWrite(() => method(...args, ...(legacyAuthMaintenance.current() ? [authPersistence] : [])));

module.exports = {
  legacyAuthMaintenance,
  authAdmissionMiddleware: legacyAuthMaintenance.admissionMiddleware,
  ownAuthHandler: legacyAuthMaintenance.own,
  authWrite,
  authMutation: (method, ...args) => authWrite(() => method(...args)),
  authUserMutation,
  authUserUpdate: (method, userId, update, expectedState, options) =>
    authUserMutation(method, userId, update, expectedState, options),
  authTrack,
  authPersistence,
  authCache: (store) => ({
    get: (...args) => store.get(...args),
    set: (...args) =>
      observeAuthCacheWrite(legacyAuthMaintenance, store, 'set', () => store.set(...args)),
    delete: (...args) =>
      observeAuthCacheWrite(legacyAuthMaintenance, store, 'delete', () => store.delete(...args)),
  }),
  withAuthRequest: (req, action) => legacyAuthMaintenance.run(req, action),
  authSessionStore: (store) => createAuthSessionStore(store, legacyAuthMaintenance),
};
