import { QueryClient } from '@tanstack/react-query';
import { acquireUploadLive } from './live';
import { readUploadSnapshot } from './api';

jest.mock('./api', () => ({ uploadsUrl: '/api/uploads', readUploadSnapshot: jest.fn() }));
jest.mock('librechat-data-provider', () => ({ getTokenHeader: () => 'Bearer session' }));
const streams: {
  listeners: Record<string, (event?: unknown) => void>;
  close: jest.Mock;
  stream: jest.Mock;
}[] = [];
jest.mock('sse.js', () => ({
  SSE: class {
    listeners: Record<string, (event?: unknown) => void> = {};
    close = jest.fn(() => this.listeners.readystatechange?.({ readyState: 2 }));
    stream = jest.fn();
    addEventListener(name: string, listener: (event?: unknown) => void) {
      this.listeners[name] = listener;
    }

    constructor() {
      streams.push(this);
    }
  },
}));
const read = readUploadSnapshot as jest.Mock;
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe('authenticated upload live lifecycle', () => {
  let client: QueryClient;
  const key = ['managed-uploads', 'tenant', 'user'];
  beforeEach(() => {
    jest.useFakeTimers();
    streams.length = 0;
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    read.mockResolvedValue({ version: 1, operations: [], usage: {} });
    client = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: 0 } } });
  });
  afterEach(() => {
    client.clear();
    jest.useRealTimers();
  });
  it('shares a stream and coalesces hints instead of querying per subscriber or event', async () => {
    const first = acquireUploadLive(client, key);
    const second = acquireUploadLive(client, key);
    await flush();
    expect(streams).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 100; i++) streams[0].listeners.change();
    jest.advanceTimersByTime(4_999);
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    first();
    expect(streams[0].close).not.toHaveBeenCalled();
    second();
    expect(streams[0].close).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(120_000);
    await flush();
    expect(streams).toHaveLength(1);
  });
  it('reconciles on reconnect and avoids duplicate timers when closing emits a state change', async () => {
    const stop = acquireUploadLive(client, key);
    await flush();
    streams[0].listeners.error();
    streams[0].listeners.error();
    jest.advanceTimersByTime(15_000);
    await flush();
    expect(streams).toHaveLength(2);
    expect(read).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    jest.advanceTimersByTime(119_000);
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    stop();
  });
  it('aborts an old identity before its pending response or hints can repopulate the cache', async () => {
    let finish!: (value: unknown) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const stop = acquireUploadLive(client, key);
    window.dispatchEvent(new CustomEvent('librechat:auth-session-ending'));
    finish({ version: 1, operations: [{ id: 'private-old' }] });
    await flush();
    expect(client.getQueryData(key)).toBeUndefined();
    expect(streams).toHaveLength(0);
    jest.advanceTimersByTime(120_000);
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    stop();
  });
  it('requires a fresh snapshot before restarting after a failed logout', async () => {
    const stop = acquireUploadLive(client, key);
    await flush();
    window.dispatchEvent(new CustomEvent('librechat:auth-session-ending'));
    expect(streams[0].close).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(streams).toHaveLength(1);
    window.dispatchEvent(new CustomEvent('librechat:auth-session-continued'));
    jest.advanceTimersByTime(0);
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(streams).toHaveLength(2);
    expect(client.getQueryData(key)).toEqual({ version: 1, operations: [], usage: {} });
    stop();
  });
});
