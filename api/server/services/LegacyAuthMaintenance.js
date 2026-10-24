/** Legacy auth composition only; identity, tenant policy and storage remain with their owners. */
const {
  createAuthMaintenance,
  mongoCacheMaintenance,
  createAuthSessionStore,
  observeAuthCacheWrite,
} = require('@librechat/api');
const legacyAuthMaintenance = createAuthMaintenance();
// Bind the exact existing Auth owner once; Mongo cache never constructs a competing parent.
mongoCacheMaintenance.bindAuth(legacyAuthMaintenance);
const authWrite = (action) =>
  legacyAuthMaintenance.run(undefined, (operation) => operation.write(action));
const authTrack = (action) => legacyAuthMaintenance.run(undefined, action);
const authPersistence = Object.freeze({ write: authWrite });
const installedPassports = new WeakSet();
const authenticatedMethods = new WeakSet();

/** Retain real Passport preparation and terminal delivery on its per-request strategy clone. */
function installAuthPassport(passport) {
  if (installedPassports.has(passport)) return passport;
  const terminalNames = ['success', 'fail', 'redirect', 'pass', 'error'];
  const wrap = (strategy) => {
    const authenticate = strategy.authenticate;
    if (authenticatedMethods.has(authenticate)) return;
    const observed = function (...args) {
      const receiver = this;
      const actions = Object.fromEntries(terminalNames.map((name) => [name, receiver[name]]));
      let started = false;
      let original;
      const work = legacyAuthMaintenance.run(args[0], (operation) =>
        operation.callback(
          (done) => {
            started = true;
            for (const name of terminalNames) {
              const action = actions[name];
              const terminal = function (...values) {
                return done(undefined, { action, receiver: this, values });
              };
              Object.defineProperty(terminal, 'length', { value: action.length });
              receiver[name] = terminal;
            }
            original = Reflect.apply(authenticate, receiver, args);
            return original;
          },
          {
            write: false,
            complete(error, terminal) {
              if (terminal)
                return Reflect.apply(terminal.action, terminal.receiver, terminal.values);
              return Reflect.apply(actions.error, receiver, [error]);
            },
          },
        ),
      );
      void work
        .catch((error) => {
          // A refused operation never invokes strategy preparation or rewrites its callbacks.
          if (!started) Reflect.apply(actions.error, receiver, [error]);
        })
        .catch(() => legacyAuthMaintenance.markUncertain());
      return original;
    };
    Object.defineProperty(observed, 'length', { value: authenticate.length });
    authenticatedMethods.add(observed);
    strategy.authenticate = observed;
  };
  // Passport registers this strategy in its constructor, before application use() calls.
  wrap(passport._strategy('session'));
  const use = passport.use;
  const observedUse = function (...args) {
    wrap(args[1] || args[0]);
    return Reflect.apply(use, this, args);
  };
  Object.defineProperty(observedUse, 'length', { value: use.length });
  passport.use = observedUse;
  installedPassports.add(passport);
  return passport;
}
let browserAuth;
/** Construct the existing browser owner before web startup admission; routes reuse this instance. */
function getBrowserAuth() {
  if (browserAuth) return browserAuth;
  const { createBrowserAuth, limiterCache, math } = require('@librechat/api');
  const { getTenantId, DEFAULT_SESSION_EXPIRY } = require('@librechat/data-schemas');
  const methods = require('~/models');
  const { getAppConfig } = require('./Config');
  browserAuth = createBrowserAuth({
    ...methods,
    getAppConfig: () => getAppConfig({ baseOnly: true }),
    getTenantId,
    origin: process.env.DOMAIN_CLIENT,
    store: limiterCache('browser_enrollment_limiter', authPersistence),
    mintToken: (user) =>
      methods.generateToken(user, math(process.env.SESSION_EXPIRY, DEFAULT_SESSION_EXPIRY)),
  });
  return browserAuth;
}
const authUserMutation = (method, ...args) =>
  authWrite(() => method(...args, ...(legacyAuthMaintenance.current() ? [authPersistence] : [])));

module.exports = {
  getBrowserAuth,
  installAuthPassport,
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
