/** Legacy auth composition only; identity, tenant policy and storage remain with their owners. */
const { createAuthMaintenance, createAuthSessionStore } = require('@librechat/api');
const legacyAuthMaintenance = createAuthMaintenance();
const authWrite = (action) =>
  legacyAuthMaintenance.run(undefined, (operation) => operation.write(action));
const authTrack = (action) => legacyAuthMaintenance.run(undefined, action);
const authPersistence = Object.freeze({ write: authWrite });

module.exports = {
  legacyAuthMaintenance,
  authAdmissionMiddleware: legacyAuthMaintenance.admissionMiddleware,
  ownAuthHandler: legacyAuthMaintenance.own,
  authWrite,
  authMutation: (method, ...args) => authWrite(() => method(...args)),
  authUserMutation: (method, ...args) =>
    authWrite(() => method(...args, ...(legacyAuthMaintenance.current() ? [authPersistence] : []))),
  authTrack,
  authPersistence,
  authCache: (store) => ({
    get: (...args) => store.get(...args),
    set: (...args) => authWrite(() => store.set(...args)),
    delete: (...args) => authWrite(() => store.delete(...args)),
  }),
  withAuthRequest: (req, action) => legacyAuthMaintenance.run(req, action),
  authSessionStore: (store) => createAuthSessionStore(store, legacyAuthMaintenance),
};
