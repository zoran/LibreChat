/* eslint-disable @typescript-eslint/no-explicit-any */
import axios from 'axios';
import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import type * as t from './types';
import {
  notifyBrowserSessionFailure,
  BrowserSessionError,
  BROWSER_SESSION_MARKER,
} from './browser';
import { TWO_FACTOR_ENROLLMENT_REQUIRED_CODE } from './config';
import { persistTwoFactorSetupToken } from './twoFactor';
import { setTokenHeader } from './headers-helpers';
import * as endpoints from './api-endpoints';

async function _get<T>(url: string, options?: AxiosRequestConfig): Promise<T> {
  const response = await axios.get(url, { ...options });
  return response.data;
}

async function _getResponse<T = unknown>(
  url: string,
  options?: AxiosRequestConfig,
): Promise<AxiosResponse<T>> {
  return await axios.get<T>(url, { ...options });
}

async function _post(url: string, data?: any) {
  const response = await axios.post(url, JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
  return response.data;
}

async function _postMultiPart(url: string, formData: FormData, options?: AxiosRequestConfig) {
  const response = await axios.post(url, formData, {
    ...options,
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return response.data;
}

async function _postTTS(url: string, formData: FormData, options?: AxiosRequestConfig) {
  const response = await axios.post(url, formData, {
    ...options,
    headers: { 'Content-Type': 'multipart/form-data' },
    responseType: 'arraybuffer',
  });
  return response.data;
}

async function _put(url: string, data?: any) {
  const response = await axios.put(url, JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
  return response.data;
}

async function _delete<T>(url: string): Promise<T> {
  const response = await axios.delete(url);
  return response.data;
}

async function _deleteWithOptions<T>(url: string, options?: AxiosRequestConfig): Promise<T> {
  const response = await axios.delete(url, { ...options });
  return response.data;
}

async function _patch(url: string, data?: any) {
  const response = await axios.patch(url, JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
  return response.data;
}

const AUTH_RECOVERY_EVENT = 'authRecovery';
const AUTH_REDIRECT_EVENT = 'authRedirectStarted';
const AUTH_REDIRECT_STORAGE_KEY = 'librechat.auth.redirect.startedAt';
const AUTH_REDIRECT_DEDUPE_MS = 15_000;
const TOKEN_REFRESH_BUFFER_MS = 2 * 60 * 1000;

type RetryableAxiosRequestConfig = AxiosRequestConfig & {
  _retry?: boolean;
  _authGeneration?: number;
  _authRefreshManaged?: boolean;
};

type AuthRecoveryState = {
  lastRedirectStartedAt: number;
  refreshPromise: Promise<string | null> | null;
  sessionGeneration: number;
  refreshRequestPromise: Promise<t.TRefreshTokenResponse | undefined> | null;
  refreshController?: AbortController;
};

type AuthRecoveryWindow = Window & {
  __librechatAuthRecovery?: AuthRecoveryState;
};

class AuthSessionChangedError extends Error {
  readonly code = 'AUTH_SESSION_CHANGED';
  constructor() {
    super('Authentication session changed');
  }
}

const assertSessionGeneration = (generation: number) => {
  if (generation !== getAuthRecoveryState().sessionGeneration) throw new AuthSessionChangedError();
};
const getAuthSessionGeneration = () => getAuthRecoveryState().sessionGeneration;

/** All mutation, SSE, axios and fetch recovery callers share the same refresh authority. */
const refreshToken = (retry?: boolean): Promise<t.TRefreshTokenResponse | undefined> => {
  if (typeof window === 'undefined') return _post(endpoints.refreshToken(retry));
  const state = getAuthRecoveryState();
  if (state.refreshRequestPromise) return state.refreshRequestPromise;
  const generation = state.sessionGeneration;
  const controller = new AbortController();
  state.refreshController = controller;
  // Includes waiting for another tab's lock and the one bounded conflict retry.
  const deadline = window.setTimeout(() => controller.abort(), 20_000);
  const send = async (legacyRetry?: boolean) => {
    assertSessionGeneration(generation);
    const response = await axios.post<t.TRefreshTokenResponse>(
      endpoints.refreshToken(legacyRetry),
      undefined,
      {
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        timeout: 20_000,
        _authRefreshManaged: true,
      } as RetryableAxiosRequestConfig,
    );
    assertSessionGeneration(generation);
    return response.data;
  };
  const run = async () => {
    assertSessionGeneration(generation);
    try {
      return await send(retry);
    } catch (error) {
      assertSessionGeneration(generation);
      const failure = error as {
        response?: { status?: number; data?: { code?: string } | string };
      };
      const response = failure.response;
      if (
        response?.status === 409 &&
        typeof response.data === 'object' &&
        response.data?.code === 'REFRESH_REPLACED' &&
        !controller.signal.aborted
      ) {
        // The winning Set-Cookie is shared. Do not clear it, loop, or replay the stale response.
        return send(retry);
      }
      // Preserve the upstream local-refresh terminal retry, without recursive interceptors.
      if (
        response?.status === 401 &&
        typeof response.data === 'string' &&
        retry !== true &&
        getBearerToken() &&
        !controller.signal.aborted
      )
        return send(true);
      throw error;
    }
  };
  const execute = async () => {
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      return navigator.locks.request(
        `librechat:refresh:${endpoints.apiBaseUrl()}`,
        {
          mode: 'exclusive',
          signal: controller.signal,
        },
        run,
      );
    }
    return run();
  };
  const operation = execute().finally(() => {
    window.clearTimeout(deadline);
    if (state.refreshRequestPromise === operation) state.refreshRequestPromise = null;
    if (state.refreshController === controller) state.refreshController = undefined;
  });
  state.refreshRequestPromise = operation;
  return operation;
};

const enrollBrowser = async (): Promise<t.TRefreshTokenResponse> => {
  const response = await axios.post(
    endpoints.browserSession(),
    {},
    {
      headers: { 'Content-Type': 'application/json', 'X-LibreChat-Browser': '1' },
    },
  );
  return response.data;
};

const resetBrowser = async (): Promise<void> => {
  await axios.post(
    endpoints.browserSession(true),
    {},
    {
      headers: { 'Content-Type': 'application/json', 'X-LibreChat-Browser': '1' },
    },
  );
};

const SHARE_PAGE_PATH_REGEX = /^\/share\/[^/]+\/?$/;
const SHARED_MESSAGES_PATH_REGEX = /^\/api\/share\/[^/]+$/;
const SHARE_FORK_PATH_REGEX = /^\/api\/share\/[^/]+\/fork$/;

const normalizePathname = (pathname: string) =>
  pathname.startsWith('/') ? pathname : `/${pathname}`;

const stripBasePath = (pathname: string) => {
  const normalizedPathname = normalizePathname(pathname);
  const baseUrl = endpoints.apiBaseUrl();
  if (!baseUrl) {
    return normalizedPathname;
  }

  const normalizedBaseUrl = normalizePathname(baseUrl);
  if (
    normalizedPathname === normalizedBaseUrl ||
    normalizedPathname.startsWith(`${normalizedBaseUrl}/`)
  ) {
    return normalizedPathname.slice(normalizedBaseUrl.length) || '/';
  }
  return normalizedPathname;
};

const isSharePage = () => SHARE_PAGE_PATH_REGEX.test(stripBasePath(window.location.pathname));

const getRequestPathname = (url?: string) => {
  if (typeof url !== 'string') {
    return '';
  }
  try {
    return new URL(url, window.location.origin).pathname;
  } catch {
    return url.split(/[?#]/)[0] ?? '';
  }
};

const isSharedMessagesRequest = (url?: string, method?: string) =>
  method?.toLowerCase() === 'get' &&
  SHARED_MESSAGES_PATH_REGEX.test(stripBasePath(getRequestPathname(url)));

/** The "continue this chat" fork is a deliberate authenticated action initiated
 *  from a share page, so it must reach auth recovery/redirect like the shared
 *  data request — otherwise a logged-out (or cold-loaded) viewer's 401 is
 *  rejected silently instead of routing them through login. */
const isShareForkRequest = (url?: string, method?: string) =>
  method?.toLowerCase() === 'post' &&
  SHARE_FORK_PATH_REGEX.test(stripBasePath(getRequestPathname(url)));

const dispatchTokenUpdatedEvent = (token: string, generation = getAuthSessionGeneration()) => {
  assertSessionGeneration(generation);
  setTokenHeader(token);
  clearAuthRedirectStartedAt();
  window.dispatchEvent(new CustomEvent('tokenUpdated', { detail: token }));
};

const getAuthRecoveryState = (): AuthRecoveryState => {
  const browserWindow = window as AuthRecoveryWindow;
  browserWindow.__librechatAuthRecovery ??= {
    lastRedirectStartedAt: 0,
    refreshPromise: null,
    sessionGeneration: 0,
    refreshRequestPromise: null,
  };
  // Additive fields also cover an existing page during hot module replacement.
  browserWindow.__librechatAuthRecovery.sessionGeneration ??= 0;
  browserWindow.__librechatAuthRecovery.refreshRequestPromise ??= null;
  return browserWindow.__librechatAuthRecovery;
};

const getAuthRedirectStartedAt = () => {
  const state = getAuthRecoveryState();
  try {
    const startedAt = window.localStorage.getItem(AUTH_REDIRECT_STORAGE_KEY);
    const storedStartedAt = startedAt != null ? Number(startedAt) : 0;
    const finiteStartedAt = Number.isFinite(storedStartedAt) ? storedStartedAt : 0;
    return Math.max(finiteStartedAt, state.lastRedirectStartedAt);
  } catch {
    return state.lastRedirectStartedAt;
  }
};

const setAuthRedirectStartedAt = () => {
  const state = getAuthRecoveryState();
  state.lastRedirectStartedAt = Date.now();
  try {
    window.localStorage.setItem(AUTH_REDIRECT_STORAGE_KEY, String(state.lastRedirectStartedAt));
  } catch {
    // localStorage can be blocked in embedded/private contexts.
  }
};

const clearAuthRedirectStartedAt = () => {
  const state = getAuthRecoveryState();
  state.lastRedirectStartedAt = 0;
  try {
    window.localStorage.removeItem(AUTH_REDIRECT_STORAGE_KEY);
  } catch {
    // Ignore unavailable storage.
  }
};

const isAuthRedirectInProgress = () => {
  const startedAt = getAuthRedirectStartedAt();
  return (
    Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt < AUTH_REDIRECT_DEDUPE_MS
  );
};

/** Stream transports surface the body as text, while axios and fetch have already parsed it. */
const parseSetupPayload = (payload: unknown): unknown => {
  if (typeof payload !== 'string') {
    return payload;
  }

  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
};

const getTwoFactorSetupToken = (payload: unknown): string | null => {
  if (typeof payload !== 'object' || payload == null) {
    return null;
  }

  const response = payload as {
    code?: unknown;
    twoFASetupRequired?: unknown;
    tempToken?: unknown;
  };
  if (
    response.code !== TWO_FACTOR_ENROLLMENT_REQUIRED_CODE ||
    response.twoFASetupRequired !== true ||
    typeof response.tempToken !== 'string' ||
    !response.tempToken.trim()
  ) {
    return null;
  }

  return response.tempToken.trim();
};

/**
 * The setup token and the bearer it replaces are both tab-scoped, so a hand-off another tab
 * started does nothing for this one: once the bearer is dropped, 401s skip recovery and the tab
 * would stay on the app until reloaded. Only this tab's own navigation dedupes the hand-off.
 */
const isTabRedirectInProgress = () => {
  const startedAt = getAuthRecoveryState().lastRedirectStartedAt;
  return startedAt > 0 && Date.now() - startedAt < AUTH_REDIRECT_DEDUPE_MS;
};

const redirectToTwoFactorSetupOnce = (tempToken: string) => {
  const isDurable = persistTwoFactorSetupToken(tempToken);
  setTokenHeader(undefined);
  if (isTabRedirectInProgress()) {
    return;
  }

  const loginRedirect = endpoints.buildLoginRedirectUrl();
  const redirectTo = new URL(loginRedirect, window.location.origin).searchParams.get('redirect_to');
  const searchParams = new URLSearchParams();
  if (redirectTo) {
    searchParams.set('redirect_to', redirectTo);
  }
  const query = searchParams.toString();

  const href = `${endpoints.apiBaseUrl()}/login/2fa/setup${query ? `?${query}` : ''}`;
  setAuthRedirectStartedAt();
  window.dispatchEvent(
    new CustomEvent(AUTH_REDIRECT_EVENT, { detail: { href, inDocument: !isDurable } }),
  );
  if (isDurable) {
    window.location.href = href;
    return;
  }

  /**
   * Session storage refused the token, so only the in-memory mirror holds it and replacing the
   * document would throw it away, stranding the setup screen on its expired state. Move the router
   * instead: the history entry is the same one the hard navigation would have produced, and the
   * router picks it up either from this event or, if it has yet to mount, from the location.
   *
   * The document surviving is also why the event above reports the hand-off as in-document: the
   * session this redirect replaces would otherwise live on in whatever state the app already
   * holds, which a replaced document would have discarded.
   */
  window.history.pushState(null, '', href);
  window.dispatchEvent(new PopStateEvent('popstate'));
};

const dispatchAuthRecoveryEvent = (state: 'started' | 'finished') => {
  window.dispatchEvent(new CustomEvent(AUTH_RECOVERY_EVENT, { detail: { state } }));
};

const setRequestAuthorizationHeader = (config: AxiosRequestConfig, token: string) => {
  const headers = (config.headers ?? {}) as Record<string, string>;
  headers['Authorization'] = `Bearer ${token}`;
  config.headers = headers;
};

const isAuthRecoveryEndpoint = (url?: string) =>
  url?.includes('/api/auth/2fa') === true ||
  url?.includes('/api/auth/logout') === true ||
  url?.includes('/api/auth/refresh') === true;

const startAuthRecovery = (retryRefresh?: boolean) => {
  const state = getAuthRecoveryState();
  if (state.refreshPromise) {
    return state.refreshPromise;
  }

  const generation = state.sessionGeneration;

  dispatchAuthRecoveryEvent('started');
  const operation = refreshToken(retryRefresh)
    .then((response) => {
      assertSessionGeneration(generation);
      const setupToken = getTwoFactorSetupToken(response);
      if (setupToken) {
        redirectToTwoFactorSetupOnce(setupToken);
        return null;
      }
      const token = response?.token ?? '';
      if (!token) {
        if (
          typeof window !== 'undefined' &&
          localStorage.getItem(BROWSER_SESSION_MARKER) === 'active'
        ) {
          throw new BrowserSessionError('BROWSER_SESSION_EXPIRED');
        }
        return null;
      }
      dispatchTokenUpdatedEvent(token, generation);
      return token;
    })
    .finally(() => {
      if (state.refreshPromise === operation) {
        state.refreshPromise = null;
        dispatchAuthRecoveryEvent('finished');
      }
    });
  state.refreshPromise = operation;
  return operation;
};

const redirectToLoginOnce = () => {
  if (isAuthRedirectInProgress()) {
    return;
  }

  const href = endpoints.apiBaseUrl() + endpoints.buildLoginRedirectUrl();
  setAuthRedirectStartedAt();
  window.dispatchEvent(
    new CustomEvent(AUTH_REDIRECT_EVENT, { detail: { href, inDocument: false } }),
  );
  window.location.href = href;
};

const getBearerToken = () => {
  const authorization = axios.defaults.headers.common['Authorization'];
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    return null;
  }
  return authorization.slice('Bearer '.length);
};

const getJwtExpiryMs = (token: string) => {
  const payload = token.split('.')[1];
  if (!payload) {
    return null;
  }

  try {
    const normalizedPayload = payload.replace(/-/g, '+').replace(/_/g, '/');
    const paddedPayload = normalizedPayload.padEnd(
      normalizedPayload.length + ((4 - (normalizedPayload.length % 4)) % 4),
      '=',
    );
    const decodedPayload = JSON.parse(window.atob(paddedPayload)) as { exp?: number };
    return typeof decodedPayload.exp === 'number' ? decodedPayload.exp * 1000 : null;
  } catch {
    return null;
  }
};

const shouldRefreshBeforeRequest = (url?: string) => {
  if (isAuthRecoveryEndpoint(url) || isAuthRedirectInProgress()) {
    return false;
  }

  const token = getBearerToken();
  if (!token) {
    return false;
  }

  const expiresAt = getJwtExpiryMs(token);
  if (expiresAt == null) {
    return false;
  }

  const timeUntilExpiry = expiresAt - Date.now();
  return timeUntilExpiry > 0 && timeUntilExpiry <= TOKEN_REFRESH_BUFFER_MS;
};

const refreshBeforeRequest = async (url?: string) => {
  const state = getAuthRecoveryState();
  if (state.refreshPromise && !isAuthRecoveryEndpoint(url)) {
    return state.refreshPromise.catch(() => null);
  }

  if (!shouldRefreshBeforeRequest(url)) {
    return null;
  }

  return startAuthRecovery(false).catch(() => null);
};

const withAuthorization = (options: RequestInit | undefined, token: string | null): RequestInit => {
  const headers = new Headers(options?.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  return { ...options, headers };
};

/**
 * Enforcement reaches the SSE hooks as an error event rather than a `Response`, because the stream
 * transport is a raw `XMLHttpRequest` with neither the axios interceptor nor `_authenticatedFetch`
 * in front of it. They hand the event body here so an enrollment 403 opens setup instead of being
 * reported as a generic transport failure and retried against a condition that cannot clear.
 */
const redirectIfTwoFactorSetupPayload = (payload: unknown): boolean => {
  const setupToken = getTwoFactorSetupToken(parseSetupPayload(payload));
  if (!setupToken) {
    return false;
  }

  redirectToTwoFactorSetupOnce(setupToken);
  return true;
};

const redirectIfTwoFactorSetupRequired = async (
  response: Response,
  generation?: number,
): Promise<boolean> => {
  if (response.status !== 403) {
    return false;
  }

  const payload = await response
    .clone()
    .json()
    .catch(() => null);
  if (generation != null) assertSessionGeneration(generation);
  return redirectIfTwoFactorSetupPayload(payload);
};

async function _authenticatedFetch(url: string, options?: RequestInit): Promise<Response> {
  if (typeof window === 'undefined') {
    return fetch(url, options);
  }

  const generation = getAuthRecoveryState().sessionGeneration;
  const token = (await refreshBeforeRequest(url)) ?? getBearerToken();
  assertSessionGeneration(generation);
  const response = await fetch(url, withAuthorization(options, token));
  if (generation !== getAuthRecoveryState().sessionGeneration) {
    await response.body?.cancel().catch(() => undefined);
    throw new AuthSessionChangedError();
  }
  if (await redirectIfTwoFactorSetupRequired(response, generation)) {
    return response;
  }
  if (
    response.status !== 401 ||
    isAuthRecoveryEndpoint(url) ||
    isAuthRedirectInProgress() ||
    !getBearerToken()
  ) {
    return response;
  }

  let refreshedToken: string | null;
  try {
    refreshedToken = await startAuthRecovery(false);
  } catch (error) {
    assertSessionGeneration(generation);
    if (!notifyBrowserSessionFailure(error)) {
      redirectToLoginOnce();
    }
    return response;
  }

  assertSessionGeneration(generation);

  if (!refreshedToken) {
    redirectToLoginOnce();
    return response;
  }

  await response.body?.cancel().catch(() => undefined);
  assertSessionGeneration(generation);
  const retriedResponse = await fetch(url, withAuthorization(options, refreshedToken));
  if (generation !== getAuthRecoveryState().sessionGeneration) {
    await retriedResponse.body?.cancel().catch(() => undefined);
    throw new AuthSessionChangedError();
  }
  await redirectIfTwoFactorSetupRequired(retriedResponse, generation);
  return retriedResponse;
}

if (typeof window !== 'undefined') {
  window.addEventListener('librechat:auth-session-ending', () => {
    const state = getAuthRecoveryState();
    state.sessionGeneration++;
    state.refreshController?.abort();
    state.refreshRequestPromise = null;
    state.refreshPromise = null;
    dispatchAuthRecoveryEvent('finished');
  });
  axios.interceptors.request.use(async (config) => {
    const generation = getAuthRecoveryState().sessionGeneration;
    (config as RetryableAxiosRequestConfig)._authGeneration = generation;
    const token = await refreshBeforeRequest(config.url);
    assertSessionGeneration(generation);
    if (token) {
      setRequestAuthorizationHeader(config, token);
    }
    return config;
  });

  axios.interceptors.response.use(
    (response) => {
      const generation = (response.config as RetryableAxiosRequestConfig)._authGeneration;
      if (generation != null) assertSessionGeneration(generation);
      return response;
    },
    async (error) => {
      const originalRequest = error.config as RetryableAxiosRequestConfig | undefined;
      if (!error.response) {
        return Promise.reject(error);
      }
      if (!originalRequest) {
        return Promise.reject(error);
      }
      if (originalRequest._authGeneration != null)
        assertSessionGeneration(originalRequest._authGeneration);
      // The common refresh port owns its finite retry; interceptor recursion would deadlock it.
      if (originalRequest._authRefreshManaged) return Promise.reject(error);

      if (error.response.status === 403) {
        const setupToken = getTwoFactorSetupToken(error.response.data);
        if (setupToken) {
          redirectToTwoFactorSetupOnce(setupToken);
          return Promise.reject(error);
        }
      }

      const isRefreshRequest = originalRequest.url?.includes('/api/auth/refresh') === true;
      if (notifyBrowserSessionFailure(error)) {
        return Promise.reject(error);
      }
      if (isAuthRecoveryEndpoint(originalRequest.url) && !isRefreshRequest) {
        return Promise.reject(error);
      }

      if (isRefreshRequest && getAuthRecoveryState().refreshPromise) {
        return Promise.reject(error);
      }

      /** Skip refresh when the Authorization header has been cleared (e.g. during logout),
       *  but allow the shared link data request to proceed so private shares can still
       *  recover auth/redirect without unrelated share-page queries forcing login. */
      if (
        !axios.defaults.headers.common['Authorization'] &&
        !(
          isSharePage() &&
          (isSharedMessagesRequest(originalRequest.url, originalRequest.method) ||
            isShareForkRequest(originalRequest.url, originalRequest.method))
        )
      ) {
        return Promise.reject(error);
      }

      if (isAuthRedirectInProgress()) {
        return Promise.reject(error);
      }

      if (error.response.status === 401 && !originalRequest._retry) {
        const hasActiveRecovery = getAuthRecoveryState().refreshPromise != null;
        if (!hasActiveRecovery) {
          console.warn('401 error, refreshing token');
        }
        originalRequest._retry = true;

        try {
          const token = await startAuthRecovery(
            // Handle edge case where we get a blank screen if the initial 401 error is from a refresh token request
            isRefreshRequest,
          );
          if (originalRequest._authGeneration != null)
            assertSessionGeneration(originalRequest._authGeneration);

          if (token) {
            setRequestAuthorizationHeader(originalRequest, token);
            return await axios(originalRequest);
          }

          redirectToLoginOnce();
          return Promise.reject(error);
        } catch (refreshError) {
          if (originalRequest._authGeneration != null)
            assertSessionGeneration(originalRequest._authGeneration);
          /** A rejected refresh (stale/invalid session → 401/403) must route to
           *  login just like an empty-token refresh, otherwise the original 401
           *  surfaces to the caller (e.g. the share fork button) with no redirect. */
          if (!notifyBrowserSessionFailure(refreshError)) {
            redirectToLoginOnce();
          }
          return Promise.reject(error);
        }
      }

      return Promise.reject(error);
    },
  );
}

export default {
  enrollBrowser,
  resetBrowser,
  get: _get,
  getResponse: _getResponse,
  post: _post,
  postMultiPart: _postMultiPart,
  postTTS: _postTTS,
  put: _put,
  delete: _delete,
  deleteWithOptions: _deleteWithOptions,
  patch: _patch,
  authenticatedFetch: _authenticatedFetch,
  refreshToken,
  getAuthSessionGeneration,
  assertAuthSessionGeneration: assertSessionGeneration,
  dispatchTokenUpdatedEvent,
  redirectIfTwoFactorSetupPayload,
};
