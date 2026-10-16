import { rateLimit } from 'express-rate-limit';
import type {
  AppConfig,
  BrowserMethods,
  BrowserIdentity,
  BrowserUser,
} from '@librechat/data-schemas';
import type { Request, RequestHandler, Response } from 'express';
import type { Store } from 'express-rate-limit';
import type { ApplicationWorkPort } from '~/app';
import { getAuthSelection, guestUploadTransitionEnabled } from './authMode';
import { isTokenRetired } from './twoFactor';

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

export type BrowserGrant = { userId: string; sessionId: string; tenantId: null };

/** Signature/expiry verification belongs to the bearer owner; this binds the same current cookie account. */
export async function validateBrowserBearer(
  payload: unknown,
  request: Request & { tenantId?: string | null },
  repository: Pick<BrowserMethods, 'findBrowserIdentity'>,
): Promise<{ user: BrowserUser; grant: BrowserGrant } | null> {
  if (
    request.tenantId != null ||
    !guestUploadTransitionEnabled() ||
    !['guest', undefined].includes(getAuthSelection(request)) ||
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  )
    return null;
  const claim = payload as Record<string, unknown>;
  if (
    claim.provider !== 'browser' ||
    typeof claim.id !== 'string' ||
    !/^[a-f0-9]{24}$/.test(claim.id) ||
    claim.tenantId != null ||
    claim.scope !== undefined ||
    claim.authMethod !== undefined ||
    claim.tokenUse !== undefined ||
    typeof claim.iat !== 'number' ||
    !Number.isFinite(claim.iat) ||
    typeof claim.exp !== 'number' ||
    !Number.isFinite(claim.exp) ||
    claim.exp * 1000 <= Date.now()
  )
    return null;
  const credential = browserCookie(request);
  if (!credential || !credential.startsWith(`${claim.id}.`)) return null;
  const identity = await repository.findBrowserIdentity(credential);
  if (
    !identity ||
    identity.user.id !== claim.id ||
    identity.user.provider !== 'browser' ||
    identity.user.role !== 'USER' ||
    !identity.sessionId ||
    !/^[a-f0-9]{24}$/.test(identity.sessionId) ||
    identity.expiration.getTime() <= Date.now() ||
    claim.exp * 1000 <= Date.now() ||
    isTokenRetired(
      {
        issuedAt: claim.iat,
        issuedAtMs: typeof claim.issuedAtMs === 'number' ? claim.issuedAtMs : undefined,
      },
      identity.retirement,
    )
  )
    return null;
  return {
    user: identity.user,
    grant: { userId: identity.user.id, sessionId: identity.sessionId, tenantId: null },
  };
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
export function createBrowserAuth(deps: BrowserAuthDependencies): ApplicationWorkPort & {
  bootstrap: RequestHandler;
  refresh: RequestHandler;
  forget: RequestHandler;
  reset: RequestHandler;
} {
  let maintenanceRequest: string | null = null;
  let revision = 0;
  let active = 0;
  let pendingWrites = 0;
  let uncertainWrites = false;
  async function write<T>(action: () => Promise<T>): Promise<T> {
    pendingWrites++;
    try {
      return await action();
    } catch (error) {
      uncertainWrites = true;
      throw error;
    } finally {
      pendingWrites--;
    }
  }
  const own =
    (handler: RequestHandler): RequestHandler =>
    async (req, res, next) => {
      if (maintenanceRequest !== null) {
        failure(res, 503, 'APP_QUIESCING');
        return;
      }
      active++;
      try {
        await handler(req, res, next);
      } finally {
        active--;
      }
    };
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
      const identity = await write(() =>
        deps.enrollBrowserIdentity(new Date(Date.now() + seconds * 1000), config.balance),
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
      let enrollment: Promise<unknown> | undefined;
      // express-rate-limit awaits its store before invoking next/denial. Its next
      // callback does not join enrollment, so retain that actual child explicitly.
      await write(async () =>
        limiter(req, res, (error) => {
          if (error) {
            uncertainWrites = true;
            next(error);
            return;
          }
          enrollment = Promise.resolve(enroll(req, res, next));
        }),
      );
      await enrollment;
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
      await write(() => deps.revokeBrowserIdentity(credential));
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

  return {
    bootstrap: own(bootstrap),
    refresh: own(refresh),
    forget: own(forget),
    reset: own(reset),
    pauseAdmissions: (requestId) => {
      if (
        typeof requestId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(requestId) ||
        (maintenanceRequest !== null && maintenanceRequest !== requestId)
      )
        return false;
      if (maintenanceRequest === requestId) return true;
      maintenanceRequest = requestId;
      revision++;
      return true;
    },
    resumeAdmissions: (requestId) => {
      if (maintenanceRequest !== requestId || uncertainWrites) return false;
      maintenanceRequest = null;
      revision++;
      return true;
    },
    getMaintenanceCensus: async (requestId) => {
      const sampledRevision = revision;
      const matches = requestId === maintenanceRequest;
      await Promise.resolve();
      return {
        admissionClosed: maintenanceRequest !== null,
        queuedContinuations: active,
        pendingWrites,
        complete:
          matches &&
          requestId === maintenanceRequest &&
          sampledRevision === revision &&
          !uncertainWrites,
      };
    },
  };
}
