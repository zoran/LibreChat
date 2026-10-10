import express from 'express';
import request from 'supertest';
import type { AppConfig, BrowserIdentity } from '@librechat/data-schemas';
import type { Store } from 'express-rate-limit';
import { BROWSER_COOKIE, createBrowserAuth } from './browser';

const parseCookies: (header: string) => Record<string, string> = jest.requireActual('cookie').parse;

const origin = 'https://chat.example.test';
const credential = `${'a'.repeat(24)}.${'b'.repeat(43)}`;
const identity: BrowserIdentity = {
  expiration: new Date(Date.now() + 60_000),
  user: {
    _id: 'a'.repeat(24),
    id: 'a'.repeat(24),
    name: 'Browser',
    username: '',
    email: 'browser@browser.invalid',
    emailVerified: false,
    provider: 'browser',
    role: 'USER',
  },
};

function fixture(enabled = true, max = 100, store?: Store) {
  const deps = {
    origin,
    store,
    getTenantId: () => undefined,
    getAppConfig: jest.fn().mockResolvedValue({
      registration: {
        browserSession: {
          enabled,
          maxAgeSeconds: 15_552_000,
          enrollmentMax: max,
        },
      },
    } as AppConfig),
    enrollBrowserIdentity: jest.fn().mockResolvedValue({ ...identity, credential }),
    findBrowserIdentity: jest.fn().mockResolvedValue(identity),
    revokeBrowserIdentity: jest.fn().mockResolvedValue(undefined),
    mintToken: jest.fn().mockResolvedValue('access-token'),
  };
  const handlers = createBrowserAuth(deps);
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  app.use((req, _res, next) => {
    req.cookies = parseCookies(req.headers.cookie ?? '');
    next();
  });
  app.post('/browser', handlers.bootstrap);
  app.post('/refresh', handlers.refresh, (_req, res) => {
    res.json({ legacy: true });
  });
  app.post('/reset', handlers.reset);
  return { app, deps, handlers };
}

function post(app: express.Express, path: string) {
  return request(app)
    .post(path)
    .set('Origin', origin)
    .set('X-Forwarded-Proto', 'https')
    .set('Sec-Fetch-Site', 'same-origin')
    .set('X-LibreChat-Browser', '1')
    .send({});
}

describe('optional browser identity HTTP boundary', () => {
  it('is off by default and preserves native refresh', async () => {
    const { app, deps } = fixture(false);
    expect((await post(app, '/browser')).status).toBe(404);
    expect((await post(app, '/refresh')).body).toEqual({ legacy: true });
    expect(deps.enrollBrowserIdentity).not.toHaveBeenCalled();
  });

  it('publishes only a secure host cookie and the native token/user response', async () => {
    const { app, deps } = fixture();
    const response = await post(app, '/browser');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ token: 'access-token', user: identity.user });
    expect(response.body.credential).toBeUndefined();
    const cookie = response.headers['set-cookie'][0];
    expect(cookie).toContain(`${BROWSER_COOKIE}=`);
    expect(cookie).toMatch(/Path=\/;.*HttpOnly; Secure; SameSite=Strict/);
    expect(cookie).not.toContain('Domain=');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(deps.enrollBrowserIdentity.mock.calls[0][0].getTime() - Date.now()).toBeGreaterThan(
      15_551_990_000,
    );
  });

  it.each(['https://evil.example', 'null'])('rejects untrusted origin %s', async (host) => {
    const { app, deps } = fixture();
    const response = await post(app, '/browser').set('Origin', host);
    expect(response.status).toBe(403);
    expect(deps.enrollBrowserIdentity).not.toHaveBeenCalled();
  });

  it('does not enroll over HTTP or replace normal authentication', async () => {
    const { app, deps } = fixture();
    expect((await post(app, '/browser').set('X-Forwarded-Proto', 'http')).status).toBe(403);
    expect((await post(app, '/browser').set('Cookie', 'refreshToken=existing')).status).toBe(409);
    expect((await post(app, '/refresh').set('Cookie', 'refreshToken=existing')).body).toEqual({
      legacy: true,
    });
    expect(deps.enrollBrowserIdentity).not.toHaveBeenCalled();
  });

  it('resumes concurrent requests without rotating or publishing a cookie', async () => {
    const { app, deps } = fixture();
    const responses = await Promise.all(
      [1, 2].map(() => post(app, '/refresh').set('Cookie', `${BROWSER_COOKIE}=${credential}`)),
    );
    for (const response of responses) {
      expect(response.body.user.id).toBe(identity.user.id);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(deps.enrollBrowserIdentity).not.toHaveBeenCalled();
  });

  it('never replaces an invalid existing credential or interprets outage as absence', async () => {
    const { app, deps } = fixture();
    deps.findBrowserIdentity.mockResolvedValueOnce(null);
    expect((await post(app, '/browser').set('Cookie', `${BROWSER_COOKIE}=invalid`)).body.code).toBe(
      'BROWSER_SESSION_EXPIRED',
    );
    deps.findBrowserIdentity.mockRejectedValueOnce(new Error('private database diagnostic'));
    const response = await post(app, '/refresh').set('Cookie', `${BROWSER_COOKIE}=${credential}`);
    expect(response.status).toBe(503);
    expect(response.text).not.toContain('private');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(deps.enrollBrowserIdentity).not.toHaveBeenCalled();
  });

  it('does not claim successful revocation during a storage failure', async () => {
    const { app, deps } = fixture();
    deps.revokeBrowserIdentity.mockRejectedValueOnce(new Error('unavailable'));
    const response = await post(app, '/reset').set('Cookie', `${BROWSER_COOKIE}=${credential}`);
    expect(response.status).toBe(503);
    expect(response.headers['set-cookie']).toBeUndefined();
    const success = await post(app, '/reset').set('Cookie', `${BROWSER_COOKIE}=${credential}`);
    expect(success.status).toBe(204);
    expect(success.headers['set-cookie'][0]).toContain('Expires=Thu, 01 Jan 1970');
  });

  it('counts successful enrollments against the configured IP budget', async () => {
    const { app, deps } = fixture(true, 1);
    expect((await post(app, '/browser')).status).toBe(200);
    expect((await post(app, '/browser')).status).toBe(429);
    expect(deps.enrollBrowserIdentity).toHaveBeenCalledTimes(1);
  });
});

function deferredBrowser<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('browser owner maintenance', () => {
  it('joins limiter admission and delayed enrollment across pause without abandoning accepted work', async () => {
    const limiting = deferredBrowser<void>();
    const allowed = deferredBrowser<{ totalHits: number; resetTime: Date }>();
    const enrolling = deferredBrowser<void>();
    const enrolled = deferredBrowser<BrowserIdentity & { credential: string }>();
    const store: Store = {
      increment: async () => {
        limiting.resolve();
        return allowed.promise;
      },
      decrement: async () => {},
      resetKey: async () => {},
    };
    const { app, deps, handlers } = fixture(true, 100, store);
    deps.enrollBrowserIdentity.mockImplementation(() => {
      enrolling.resolve();
      return enrolled.promise;
    });
    const response = post(app, '/browser').then((value) => value);
    await limiting.promise;
    expect(handlers.pauseAdmissions('op')).toBe(true);
    expect(await handlers.getMaintenanceCensus('op')).toMatchObject({
      queuedContinuations: 1,
      pendingWrites: 1,
    });
    expect((await post(app, '/browser')).body.code).toBe('APP_QUIESCING');
    allowed.resolve({ totalHits: 1, resetTime: new Date(Date.now() + 10000) });
    await enrolling.promise;
    expect((await handlers.getMaintenanceCensus('op')).queuedContinuations).toBe(1);
    enrolled.resolve({ ...identity, credential });
    expect((await response).status).toBe(200);
    expect(await handlers.getMaintenanceCensus('op')).toEqual({
      admissionClosed: true,
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
    expect(handlers.resumeAdmissions('foreign')).toBe(false);
    expect(handlers.resumeAdmissions('op')).toBe(true);
  });

  it('settles limiter429 and known precondition rejection without uncertain writes', async () => {
    const { app, handlers } = fixture(true, 1);
    await post(app, '/browser');
    expect((await post(app, '/browser')).status).toBe(429);
    expect((await post(app, '/browser').set('Origin', 'https://foreign.test')).status).toBe(403);
    handlers.pauseAdmissions('op');
    expect(await handlers.getMaintenanceCensus('op')).toMatchObject({
      complete: true,
      queuedContinuations: 0,
      pendingWrites: 0,
    });
  });

  it('joins limiter store errors and keeps uncertain effects incomplete', async () => {
    const store: Store = {
      increment: async () => {
        throw new Error('store uncertain');
      },
      decrement: async () => {},
      resetKey: async () => {},
    };
    const { app, handlers, deps } = fixture(true, 100, store);
    expect((await post(app, '/browser')).status).toBe(500);
    handlers.pauseAdmissions('op');
    expect(await handlers.getMaintenanceCensus('op')).toMatchObject({
      complete: false,
      queuedContinuations: 0,
    });
    expect(deps.enrollBrowserIdentity).not.toHaveBeenCalled();
  });

  it.each(['enrollBrowserIdentity', 'revokeBrowserIdentity'] as const)(
    'retains uncertain %s failures despite sanitized handler response',
    async (method) => {
      const { app, handlers, deps } = fixture();
      deps[method].mockRejectedValueOnce(new Error('unknown write'));
      const response =
        method === 'enrollBrowserIdentity'
          ? await post(app, '/browser')
          : await post(app, '/reset').set('Cookie', `${BROWSER_COOKIE}=${credential}`);
      expect(response.status).toBe(503);
      handlers.pauseAdmissions('op');
      expect((await handlers.getMaintenanceCensus('op')).complete).toBe(false);
      expect(handlers.resumeAdmissions('op')).toBe(false);
    },
  );

  it('counts reset/forget once through revocation and rejects stale census ownership', async () => {
    const started = deferredBrowser<void>();
    const finish = deferredBrowser<void>();
    const { app, handlers, deps } = fixture();
    deps.revokeBrowserIdentity.mockImplementation(() => {
      started.resolve();
      return finish.promise;
    });
    const response = post(app, '/reset')
      .set('Cookie', `${BROWSER_COOKIE}=${credential}`)
      .then((value) => value);
    await started.promise;
    handlers.pauseAdmissions('op');
    expect(await handlers.getMaintenanceCensus('op')).toMatchObject({
      queuedContinuations: 1,
      pendingWrites: 1,
    });
    expect((await handlers.getMaintenanceCensus('foreign')).complete).toBe(false);
    const sample = handlers.getMaintenanceCensus('op');
    handlers.resumeAdmissions('op');
    handlers.pauseAdmissions('op');
    expect((await sample).complete).toBe(false);
    finish.resolve();
    expect((await response).status).toBe(204);
    expect((await handlers.getMaintenanceCensus('op')).queuedContinuations).toBe(0);
  });
});
