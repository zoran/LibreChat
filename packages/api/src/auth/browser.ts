import { rateLimit } from 'express-rate-limit';
import type {
  AppConfig,
  BrowserMethods,
  BrowserIdentity,
  BrowserUser,
} from '@librechat/data-schemas';
import type { Request, RequestHandler, Response } from 'express';
import type { Store } from 'express-rate-limit';

export const BROWSER_COOKIE = '__Host-librechat-browser';
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'strict', path: '/' } as const;

interface BrowserAuthDependencies extends BrowserMethods {
  getAppConfig: () => Promise<AppConfig>;
  getTenantId: () => string | undefined;
  mintToken: (user: BrowserUser) => Promise<string>;
  origin: string;
  store?: Store;
}

function browserCookie(req: Request): string | undefined {
  const raw = req.headers.cookie ?? '';
  const matches = raw.split(';').filter((part) => part.trim().startsWith(`${BROWSER_COOKIE}=`));
  if (matches.length > 1 || raw.length > 16_384) {
    return '';
  }
  const value: unknown = req.cookies?.[BROWSER_COOKIE];
  if (typeof value === 'string') {
    return value;
  }
  return matches.length ? '' : undefined;
}

function hasRegularSession(req: Request): boolean {
  return !!(
    req.cookies?.refreshToken ||
    req.cookies?.token_provider ||
    req.cookies?.openid_user_id
  );
}

function failure(res: Response, status: number, code: string): void {
  res.set('Cache-Control', 'no-store').status(status).json({ code });
}

/** Mount after the existing cookie-parser owner. Legacy auth falls through; storage/signing are injected. */
export function createBrowserAuth(deps: BrowserAuthDependencies): {
  bootstrap: RequestHandler;
  refresh: RequestHandler;
  forget: RequestHandler;
  reset: RequestHandler;
} {
  const configs = new WeakMap<Request, AppConfig>();
  const loadConfig = async (req: Request) => {
    let config = configs.get(req);
    if (!config) {
      config = await deps.getAppConfig();
      configs.set(req, config);
    }
    return config;
  };
  let origin: string | undefined;
  try {
    const parsed = new URL(deps.origin);
    if (parsed.protocol === 'https:') {
      origin = parsed.origin;
    }
  } catch {
    // Disabled configurations retain legacy auth, including HTTP local development.
  }

  const trusted = (req: Request, res: Response): boolean => {
    if (
      !origin ||
      !req.secure ||
      req.get('origin') !== origin ||
      (req.get('sec-fetch-site') != null && req.get('sec-fetch-site') !== 'same-origin')
    ) {
      failure(res, 403, 'BROWSER_SESSION_ORIGIN');
      return false;
    }
    return true;
  };

  const sendIdentity = async (res: Response, identity: BrowserIdentity) => {
    const token = await deps.mintToken(identity.user);
    res.set('Cache-Control', 'no-store').json({ token, user: identity.user });
  };

  const limiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: async (req) => (await loadConfig(req)).registration?.browserSession?.enrollmentMax ?? 100,
    standardHeaders: true,
    legacyHeaders: false,
    store: deps.store,
    handler: (_req, res) => failure(res, 429, 'BROWSER_SESSION_RATE_LIMITED'),
  });

  const enroll: RequestHandler = async (req, res) => {
    try {
      const config = await loadConfig(req);
      const seconds = config.registration?.browserSession?.maxAgeSeconds ?? 15_552_000;
      const identity = await deps.enrollBrowserIdentity(
        new Date(Date.now() + seconds * 1000),
        config.balance,
      );
      const token = await deps.mintToken(identity.user);
      res.cookie(BROWSER_COOKIE, identity.credential, {
        ...cookieOptions,
        expires: identity.expiration,
      });
      res.set('Cache-Control', 'no-store').json({ token, user: identity.user });
    } catch {
      failure(res, 503, 'BROWSER_SESSION_UNAVAILABLE');
    }
  };

  const bootstrap: RequestHandler = async (req, res, next) => {
    try {
      const config = await loadConfig(req);
      if (!config.registration?.browserSession?.enabled) {
        failure(res, 404, 'BROWSER_SESSION_DISABLED');
        return;
      }
      if (!trusted(req, res)) {
        return;
      }
      if (!req.is('application/json') || req.get('x-librechat-browser') !== '1') {
        failure(res, 400, 'BROWSER_SESSION_REQUEST');
        return;
      }
      if (hasRegularSession(req) || deps.getTenantId()) {
        failure(res, 409, 'BROWSER_SESSION_CONFLICT');
        return;
      }
      const credential = browserCookie(req);
      if (credential !== undefined) {
        const identity = await deps.findBrowserIdentity(credential);
        if (!identity) {
          failure(res, 403, 'BROWSER_SESSION_EXPIRED');
          return;
        }
        await sendIdentity(res, identity);
        return;
      }
      return limiter(req, res, (error) => {
        if (error) {
          next(error);
          return;
        }
        void enroll(req, res, next);
      });
    } catch {
      failure(res, 503, 'BROWSER_SESSION_UNAVAILABLE');
    }
  };

  const refresh: RequestHandler = async (req, res, next) => {
    if (hasRegularSession(req) || browserCookie(req) === undefined) {
      next();
      return;
    }
    try {
      const config = await loadConfig(req);
      if (!config.registration?.browserSession?.enabled || deps.getTenantId()) {
        failure(res, 403, 'BROWSER_SESSION_DISABLED');
        return;
      }
      if (!trusted(req, res)) {
        return;
      }
      const identity = await deps.findBrowserIdentity(browserCookie(req) ?? '');
      if (!identity) {
        failure(res, 403, 'BROWSER_SESSION_EXPIRED');
        return;
      }
      await sendIdentity(res, identity);
    } catch {
      failure(res, 503, 'BROWSER_SESSION_UNAVAILABLE');
    }
  };

  const forget: RequestHandler = async (req, res, next) => {
    const credential = browserCookie(req);
    if (credential === undefined) {
      next();
      return;
    }
    if (!trusted(req, res)) {
      return;
    }
    try {
      await deps.revokeBrowserIdentity(credential);
      res.clearCookie(BROWSER_COOKIE, cookieOptions);
      next();
    } catch {
      failure(res, 503, 'BROWSER_SESSION_UNAVAILABLE');
    }
  };

  const reset: RequestHandler = (req, res, next) => {
    if (!trusted(req, res)) {
      return;
    }
    if (
      !req.is('application/json') ||
      req.get('x-librechat-browser') !== '1' ||
      hasRegularSession(req)
    ) {
      failure(res, 400, 'BROWSER_SESSION_REQUEST');
      return;
    }
    return forget(req, res, (error) => {
      if (error) {
        next(error);
        return;
      }
      res.set('Cache-Control', 'no-store').status(204).end();
    });
  };

  return { bootstrap, refresh, forget, reset };
}
