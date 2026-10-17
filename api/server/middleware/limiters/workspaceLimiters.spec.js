const express = require('express');
const request = require('supertest');
const { MemoryStore } = require('express-rate-limit');

const mockStores = [];
const mockLimiterCache = jest.fn(() => {
  const store = new MemoryStore();
  mockStores.push(store);
  return store;
});
jest.mock('@librechat/api', () => ({ limiterCache: (...args) => mockLimiterCache(...args) }));

const { createWorkspaceLimiters } = require('./workspaceLimiters');

const principals = {
  owner: Object.freeze({ tenantId: 'tenant-a', userId: 'owner-a' }),
  other: Object.freeze({ tenantId: 'tenant-a', userId: 'owner-b' }),
  tenant: Object.freeze({ tenantId: 'tenant-b', userId: 'owner-a' }),
  personal: Object.freeze({ tenantId: null, userId: 'owner-a' }),
};

function fixture(options = {}) {
  const identities = new WeakMap();
  const app = express();
  const accepted = jest.fn((_req, res) => res.status(204).end());
  app.use((req, _res, next) => {
    identities.set(req, principals[req.headers['x-test-principal'] ?? 'owner']);
    next();
  });
  const { read, write } = createWorkspaceLimiters(
    options.getPrincipal ?? ((req) => identities.get(req)),
  );
  app.use(read, write);
  app.use(express.json());
  app.use(accepted);
  return { app, accepted };
}

afterEach(() => {
  for (const store of mockStores.splice(0)) store.shutdown();
  mockLimiterCache.mockClear();
});

describe('private Workspace request limits', () => {
  it('shares the actual 180/minute read budget between GET and HEAD, independently of writes', async () => {
    const { app } = fixture();
    for (let index = 0; index < 180; index++) {
      const method = index % 2 ? 'head' : 'get';
      await request(app)[method]('/workspaces').expect(204);
    }
    const denied = await request(app).get('/workspaces').expect(429);
    expect(denied.body).toEqual({ code: 'rate_limited' });
    expect(Number(denied.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(denied.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(denied.headers.ratelimit).toContain('limit=180');
    await request(app).head('/workspaces').expect(429);
    await request(app).post('/workspaces').send({ format: 'markdown' }).expect(204);
  });

  it('shares the actual 30/minute write budget across methods, paths and forged request fields', async () => {
    const { app } = fixture();
    const methods = ['post', 'put', 'patch', 'delete', 'options'];
    for (let index = 0; index < 30; index++) {
      await request(app)
        [methods[index % methods.length]](`/workspaces/${index}?userId=forged-${index}`)
        .send({ userId: `forged-${index}`, tenantId: `forged-${index}` })
        .expect(204);
    }
    const denied = await request(app)
      .post('/workspaces/new?tenantId=untrusted')
      .send({ userId: 'another-user', tenantId: 'another-tenant' })
      .expect(429);
    expect(denied.body).toEqual({ code: 'rate_limited' });
    expect(Number(denied.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(denied.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(denied.headers.ratelimit).toContain('limit=30');
    await request(app).get('/workspaces').expect(204);
  });

  it('keeps authenticated owners and tenant namespaces independent', async () => {
    const { app, accepted } = fixture();
    for (let index = 0; index < 30; index++) await request(app).post('/workspaces').expect(204);
    await request(app).post('/workspaces').expect(429);
    for (const principal of ['other', 'tenant', 'personal']) {
      await request(app).post('/workspaces').set('x-test-principal', principal).expect(204);
    }
    await request(app).post('/workspaces').expect(429);
    expect(accepted).toHaveBeenCalledTimes(33);
  });

  it.each(['get', 'post'])(
    'refuses missing trusted identity before %s parsing or work',
    async (method) => {
      const { app, accepted } = fixture();
      const increments = mockStores.map((store) => jest.spyOn(store, 'increment'));
      const denied = await request(app)
        [method]('/workspaces?userId=forged')
        .set('x-test-principal', 'missing')
        .set('Content-Type', 'application/json')
        .send('{invalid-json')
        .expect(401);
      expect(denied.body).toEqual({ code: 'unauthorized' });
      expect(accepted).not.toHaveBeenCalled();
      for (const increment of increments) expect(increment).not.toHaveBeenCalled();
    },
  );

  it('refuses an invalid principal without reading user-controlled properties', async () => {
    const { app, accepted } = fixture({
      getPrincipal: () => ({ userId: 'owner-a', tenantId: undefined }),
    });
    const denied = await request(app).post('/workspaces').send(principals.owner).expect(401);
    expect(denied.body).toEqual({ code: 'unauthorized' });
    expect(accepted).not.toHaveBeenCalled();
  });

  it('sanitizes a failing trusted principal getter', async () => {
    const { app, accepted } = fixture({
      getPrincipal: () => {
        throw new Error('private authentication context');
      },
    });
    const denied = await request(app).get('/workspaces').expect(401);
    expect(denied.body).toEqual({ code: 'unauthorized' });
    expect(accepted).not.toHaveBeenCalled();
  });

  it.each([
    ['get', 0],
    ['post', 1],
  ])('fails closed when the native %s store increment rejects', async (method, index) => {
    const { app, accepted } = fixture();
    jest
      .spyOn(mockStores[index], 'increment')
      .mockRejectedValueOnce(new Error('private Redis error'));
    const denied = await request(app)[method]('/workspaces').expect(503);
    expect(denied.body).toEqual({ code: 'unavailable' });
    expect(accepted).not.toHaveBeenCalled();
    await request(app)[method]('/workspaces').expect(204);
  });

  it('returns rate limiting before a body-parser error for an exhausted write budget', async () => {
    const { app } = fixture();
    for (let index = 0; index < 30; index++) await request(app).post('/workspaces').expect(204);
    const denied = await request(app)
      .post('/workspaces')
      .set('Content-Type', 'application/json')
      .send('{invalid-json')
      .expect(429);
    expect(denied.body).toEqual({ code: 'rate_limited' });
  });
});
