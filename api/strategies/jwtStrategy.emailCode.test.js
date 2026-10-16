// Actual JWT activity consumer; unrelated aggregate API builds are deliberately outside this fixture.
let verify;
jest.mock('passport-jwt', () => ({
  Strategy: jest.fn((_options, callback) => {
    verify = callback;
  }),
  ExtractJwt: { fromAuthHeaderAsBearerToken: jest.fn() },
}));
jest.mock('~/server/services/LegacyAuthMaintenance', () => ({
  withAuthRequest: (_req, action) => action(),
  authWrite: (action) => action(),
  authUserUpdate: jest.fn(),
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn() },
  runAsSystem: (action) => action(),
}));
jest.mock('@librechat/api', () => ({
  AGENT_TRIGGER_SCOPE: 'agent_trigger',
  getAuthMode: () => 'transition',
  getEmailCodeSettings: () => ({ tenantId: 'cortex-bwi' }),
  validateEmailCodeBearer: jest.fn(),
  continueAfterBearerRetirement: (user, _meta, _strategy, _id, done) => done(null, user),
}));
jest.mock('~/models', () => ({ getUserById: jest.fn(), touchEmailCodeSession: jest.fn() }));
const jwtLogin = require('./jwtStrategy');
const { getUserById, touchEmailCodeSession } = require('~/models');
const { validateEmailCodeBearer } = require('@librechat/api');
beforeEach(() => {
  jest.clearAllMocks();
  jwtLogin();
});
it.each([
  ['GET', '/api/user', false],
  ['GET', '/api/files/status', false],
  ['POST', '/api/auth/refresh', false],
  ['POST', '/base/API/AUTH/refresh/?q=1', false],
  ['POST', '/api/files/usage', false],
  ['POST', '/base/API/FILES/USAGE/?q=1', false],
  ['POST', '/api/files', true],
  ['POST', '/api/agents/chat/agents', true],
  ['PATCH', '/api/user?next=/api/auth/refresh', true],
  ['DELETE', '/api/files/usage-extra', true],
])('activity admission %s %s', async (method, originalUrl, expected) => {
  const id = 'a'.repeat(24);
  const user = { _id: id, id, provider: 'email_code', role: 'USER' };
  getUserById.mockResolvedValue(user);
  validateEmailCodeBearer.mockResolvedValue({ user, grant: { tenantId: 'cortex-bwi' } });
  const done = jest.fn();
  await verify({ method, originalUrl, headers: {} }, { id, authMethod: 'email_code' }, done);
  expect(done).toHaveBeenCalledWith(null, user);
  expect(touchEmailCodeSession).toHaveBeenCalledTimes(expected ? 1 : 0);
});
