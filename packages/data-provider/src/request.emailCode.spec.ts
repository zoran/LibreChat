/** @jest-environment jsdom */
import axios from 'axios';
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { getTokenHeader, setTokenHeader } from './headers-helpers';
import request from './request';

const response = (
  config: InternalAxiosRequestConfig,
  data: unknown = { token: 'fresh' },
): AxiosResponse => ({
  data,
  config,
  status: 200,
  statusText: 'OK',
  headers: {},
});
const conflict = (config: InternalAxiosRequestConfig) =>
  Object.assign(new Error('refresh replaced'), {
    config,
    response: { ...response(config, { code: 'REFRESH_REPLACED' }), status: 409 },
  });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const nextTask = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

describe('serialized refresh and session generation', () => {
  const originalAdapter = axios.defaults.adapter;
  const originalFetch = global.fetch;
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
  beforeEach(() => {
    delete (window as Window & { __librechatAuthRecovery?: unknown }).__librechatAuthRecovery;
    localStorage.clear();
    setTokenHeader(undefined);
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  });
  afterEach(() => {
    axios.defaults.adapter = originalAdapter;
    global.fetch = originalFetch;
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
    else Reflect.deleteProperty(navigator, 'locks');
    jest.restoreAllMocks();
  });

  it('coalesces callers in this tab and uses the origin-scoped Web Lock when supported', async () => {
    const lock = jest.fn(async (_name, _options, action) => action());
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: lock } });
    const adapter = jest.fn(async (config) => response(config));
    axios.defaults.adapter = adapter;
    const first = request.refreshToken();
    const second = request.refreshToken();
    expect(first).toBe(second);
    await expect(first).resolves.toMatchObject({ token: 'fresh' });
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(lock).toHaveBeenCalledWith(
      expect.stringMatching(/^librechat:refresh:/),
      expect.objectContaining({ mode: 'exclusive', signal: expect.any(AbortSignal) }),
      expect.any(Function),
    );
  });

  it('retries REFRESH_REPLACED exactly once without an interceptor recovery loop', async () => {
    let calls = 0;
    const adapter = jest.fn(async (config) => {
      if (++calls === 1) throw conflict(config);
      return response(config);
    });
    axios.defaults.adapter = adapter;
    await expect(request.refreshToken()).resolves.toMatchObject({ token: 'fresh' });
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it('stops after a second conflict', async () => {
    const adapter = jest.fn(async (config) => {
      throw conflict(config);
    });
    axios.defaults.adapter = adapter;
    await expect(request.refreshToken()).rejects.toMatchObject({ response: { status: 409 } });
    expect(adapter).toHaveBeenCalledTimes(2);
  });

  it('aborts and rejects a delayed refresh after the identity boundary', async () => {
    const pending = deferred<AxiosResponse>();
    let captured!: InternalAxiosRequestConfig;
    axios.defaults.adapter = async (config) => {
      captured = config;
      return pending.promise;
    };
    const refresh = request.refreshToken();
    const rejected = await expect(refresh).rejects.toMatchObject({ code: 'AUTH_SESSION_CHANGED' });
    await nextTask();
    window.dispatchEvent(
      new CustomEvent('librechat:auth-session-ending', { detail: { generation: 1 } }),
    );
    expect(captured.signal?.aborted).toBe(true);
    pending.resolve(response(captured, { token: 'old-identity-token' }));
    await rejected;
    expect(getTokenHeader()).toBeUndefined();
  });

  it('does not deliver an old axios response into the next session', async () => {
    const pending = deferred<AxiosResponse>();
    let captured!: InternalAxiosRequestConfig;
    axios.defaults.adapter = async (config) => {
      captured = config;
      return pending.promise;
    };
    const operation = request.get('/api/test-private-state');
    const rejected = await expect(operation).rejects.toMatchObject({
      code: 'AUTH_SESSION_CHANGED',
    });
    await nextTask();
    window.dispatchEvent(new Event('librechat:auth-session-ending'));
    pending.resolve(response(captured, { private: 'old state' }));
    await rejected;
  });

  it('rejects delayed external token publication captured before the identity boundary', () => {
    const generation = request.getAuthSessionGeneration();
    const listener = jest.fn();
    window.addEventListener('tokenUpdated', listener);
    try {
      window.dispatchEvent(new Event('librechat:auth-session-ending'));
      expect(() => request.assertAuthSessionGeneration(generation)).toThrow(
        'Authentication session changed',
      );
      expect(() => request.dispatchTokenUpdatedEvent('old-token', generation)).toThrow(
        'Authentication session changed',
      );
      expect(listener).not.toHaveBeenCalled();
      expect(getTokenHeader()).toBeUndefined();
    } finally {
      window.removeEventListener('tokenUpdated', listener);
    }
  });

  it('cancels an old authenticatedFetch body instead of returning it after a session change', async () => {
    const pending = deferred<Response>();
    global.fetch = jest.fn(() => pending.promise);
    const cancel = jest.fn(async () => undefined);
    const operation = request.authenticatedFetch('/api/test-private-state');
    const rejected = await expect(operation).rejects.toMatchObject({
      code: 'AUTH_SESSION_CHANGED',
    });
    await nextTask();
    window.dispatchEvent(new Event('librechat:auth-session-ending'));
    pending.resolve({ status: 200, body: { cancel } } as unknown as Response);
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
