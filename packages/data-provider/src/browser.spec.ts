/** @jest-environment jsdom */
import type { TRefreshTokenResponse } from './types';
import {
  BROWSER_SESSION_MARKER,
  BrowserSessionError,
  enrollBrowserSession,
  isBrowserSessionEntry,
} from './browser';

describe('browser enrollment coordination and recovery', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    let queue = Promise.resolve();
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: jest.fn((_name: string, task: () => Promise<TRefreshTokenResponse>) => {
          const result = queue.then(task);
          queue = result.then(
            () => undefined,
            () => undefined,
          );
          return result;
        }),
      },
    });
  });

  it('restores the cookie published by the first tab before a second tab can enroll', async () => {
    let cookieResponse: TRefreshTokenResponse | undefined;
    const result = { token: 'native-token', user: { id: 'same-user' } } as TRefreshTokenResponse;
    const enroll = jest.fn(async () => {
      cookieResponse = result;
      return result;
    });
    const refresh = jest.fn(async () => cookieResponse);
    const responses = await Promise.all([
      enrollBrowserSession({ refresh, enroll }),
      enrollBrowserSession({ refresh, enroll }),
    ]);
    expect(enroll).toHaveBeenCalledTimes(1);
    expect(responses).toEqual([result, result]);
    expect(localStorage.getItem(BROWSER_SESSION_MARKER)).toBe('active');
    expect(localStorage.getItem(BROWSER_SESSION_MARKER)).not.toContain('same-user');
  });

  it.each([
    ['active', 'BROWSER_SESSION_EXPIRED'],
    ['paused', 'BROWSER_SESSION_FORGOTTEN'],
  ])('does not silently replace a %s workspace', async (state, code) => {
    localStorage.setItem(BROWSER_SESSION_MARKER, state);
    const enroll = jest.fn();
    await expect(enrollBrowserSession({ refresh: async () => undefined, enroll })).rejects.toEqual(
      new BrowserSessionError(code),
    );
    expect(enroll).not.toHaveBeenCalled();
  });

  it('does not interpret a failed restore as a missing identity', async () => {
    const enroll = jest.fn();
    await expect(
      enrollBrowserSession({
        refresh: async () => {
          throw new Error('offline');
        },
        enroll,
      }),
    ).rejects.toThrow('offline');
    expect(enroll).not.toHaveBeenCalled();
  });

  it('fails before enrollment when the browser cannot serialize first use', async () => {
    Object.defineProperty(navigator, 'locks', { value: undefined });
    const enroll = jest.fn();
    await expect(enrollBrowserSession({ refresh: async () => undefined, enroll })).rejects.toEqual(
      new BrowserSessionError('BROWSER_SESSION_UNSUPPORTED'),
    );
    expect(enroll).not.toHaveBeenCalled();
  });

  it.each(['/login', '/login/2fa', '/admin', '/oauth/success', '/share/id', '/register'])(
    'does not enroll on %s',
    (path) => expect(isBrowserSessionEntry(path)).toBe(false),
  );
  it('allows the employee root and conversation deep links', () => {
    expect(isBrowserSessionEntry('/')).toBe(true);
    expect(isBrowserSessionEntry('/c/a-conversation')).toBe(true);
  });
  it('preserves authentication-route exclusion behind a base path', () => {
    expect(isBrowserSessionEntry('/chat/login', '/chat')).toBe(false);
    expect(isBrowserSessionEntry('/login', '/chat')).toBe(false);
    expect(isBrowserSessionEntry('/chat/c/conversation', '/chat')).toBe(true);
  });
});
