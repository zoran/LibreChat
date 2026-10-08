import { isAxiosError } from 'axios';
import type { TRefreshTokenResponse } from './types';

/** Only a non-secret lifecycle marker; never a user ID or authenticator. */
export const BROWSER_SESSION_MARKER = 'librechat.browser.state';
export const BROWSER_SESSION_EVENT = 'librechat.browser.recovery';

export class BrowserSessionError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export function browserSessionErrorCode(error: unknown): string | undefined {
  let code: string | undefined;
  if (error instanceof BrowserSessionError) {
    code = error.code;
  } else if (isAxiosError<{ code?: string }>(error)) {
    code = error.response?.data?.code;
  }
  return typeof code === 'string' && code.startsWith('BROWSER_SESSION_') ? code : undefined;
}

export function notifyBrowserSessionFailure(error: unknown): boolean {
  const code = browserSessionErrorCode(error);
  if (!code || typeof window === 'undefined') {
    return false;
  }
  window.dispatchEvent(new CustomEvent(BROWSER_SESSION_EVENT, { detail: code }));
  return true;
}

/** Invoke only after refresh found no credential and the server advertised this optional feature. */
export async function enrollBrowserSession({
  refresh,
  enroll,
}: {
  refresh: () => Promise<TRefreshTokenResponse | undefined>;
  enroll: () => Promise<TRefreshTokenResponse>;
}): Promise<TRefreshTokenResponse> {
  if (!window.isSecureContext || !navigator.locks) {
    throw new BrowserSessionError('BROWSER_SESSION_UNSUPPORTED');
  }
  return navigator.locks.request('librechat.browser.enrollment', async () => {
    // Another tab may have published its cookie while this one waited for the lock.
    const restored = await refresh();
    if (restored?.token) {
      return restored;
    }
    let marker: string | null;
    try {
      marker = localStorage.getItem(BROWSER_SESSION_MARKER);
      localStorage.setItem(BROWSER_SESSION_MARKER, marker ?? 'new');
    } catch {
      throw new BrowserSessionError('BROWSER_SESSION_UNSUPPORTED');
    }
    if (marker === 'paused') {
      throw new BrowserSessionError('BROWSER_SESSION_FORGOTTEN');
    }
    if (marker === 'active') {
      throw new BrowserSessionError('BROWSER_SESSION_EXPIRED');
    }
    const result = await enroll();
    localStorage.setItem(BROWSER_SESSION_MARKER, 'active');
    return result;
  });
}

export function isBrowserSessionEntry(path: string, base = ''): boolean {
  const relative =
    base && (path === base || path.startsWith(`${base}/`)) ? path.slice(base.length) || '/' : path;
  return !/^\/(login|register|verify|forgot-password|reset-password|admin|oauth|share)(\/|$)/.test(
    relative,
  );
}
