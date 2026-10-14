import { QueryClient } from '@tanstack/react-query';
import { acquireUploadLive, readManagedUploadSnapshot, getUploadAdmission } from './live';
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
    read.mockResolvedValue({ version: 1, operations: [], usage: {}, admissionsPaused: false });
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, cacheTime: Infinity } },
      logger: { log: console.log, warn: console.warn, error: jest.fn() },
    });
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
    expect(client.getQueryData(key)).toEqual({
      version: 1,
      operations: [],
      usage: {},
      admissionsPaused: false,
    });
    stop();
  });

  it('isolates two guest accounts with no tenant when the old response arrives after reset', async () => {
    const oldKey = ['managed-uploads', '', 'guest-old'];
    const newKey = ['managed-uploads', '', 'guest-new'];
    let finishOld!: (value: unknown) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    const stopOld = acquireUploadLive(client, oldKey);
    window.dispatchEvent(new CustomEvent('librechat:auth-session-ending'));
    stopOld();
    read.mockResolvedValueOnce({
      version: 1,
      operations: [{ id: 'new-private' }],
      usage: {},
      admissionsPaused: false,
    });
    const stopNew = acquireUploadLive(client, newKey);
    await flush();
    finishOld({
      version: 1,
      operations: [{ id: 'old-private' }],
      usage: {},
      admissionsPaused: true,
    });
    await flush();
    expect(client.getQueryData(oldKey)).toBeUndefined();
    expect(client.getQueryData(newKey)).toMatchObject({
      operations: [{ id: 'new-private' }],
      admissionsPaused: false,
    });
    expect(streams).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(2);
    stopNew();
    expect(streams[0].close).toHaveBeenCalledTimes(1);
  });

  const admission = () =>
    client.getQueryData<{ admissionsPaused: boolean | null }>(key)?.admissionsPaused;
  const status = (value: boolean | null, index = streams.length - 1) =>
    streams[index].listeners.status?.({ data: JSON.stringify({ admissionsPaused: value }) });
  const refresh = () =>
    client.fetchQuery(key, ({ signal }) => readManagedUploadSnapshot(client, key, signal), {
      staleTime: 0,
      retry: false,
    });

  it('applies status without fetching or rejuvenating file data and preserves a refetch error', async () => {
    const stop = acquireUploadLive(client, key);
    await flush();
    const updatedAt = client.getQueryState(key)!.dataUpdatedAt;
    jest.advanceTimersByTime(1000);
    status(true);
    expect(admission()).toBe(true);
    expect(client.getQueryState(key)!.dataUpdatedAt).toBe(updatedAt);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockRejectedValueOnce(new Error('offline'));
    await expect(refresh()).rejects.toThrow('offline');
    expect(admission()).toBeNull();
    status(false);
    expect(admission()).toBe(false);
    expect(client.getQueryState(key)!.status).toBe('error');
    expect(client.getQueryState(key)!.dataUpdatedAt).toBe(updatedAt);
    stop();
  });

  it.each([
    '{}',
    '[]',
    '{"admissionsPaused":"false"}',
    '{"admissionsPaused":false,"extra":true}',
    'null',
    '{',
    ' '.repeat(129),
  ])('treats an invalid closed status frame as unknown: %s', async (data) => {
    const stop = acquireUploadLive(client, key);
    await flush();
    status(false);
    streams[0].listeners.status?.({ data });
    expect(admission()).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    stop();
  });

  it('lets a newer status defeat an older HTTP success while still accepting file data', async () => {
    const stop = acquireUploadLive(client, key);
    await flush();
    let finish!: (value: unknown) => void;
    read.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const pending = refresh();
    status(true);
    finish({ operations: [{ id: 'new-file' }], admissionsPaused: false });
    await pending;
    expect(admission()).toBe(true);
    expect(client.getQueryData(key)).toMatchObject({ operations: [{ id: 'new-file' }] });
    stop();
  });

  it('does not let an older HTTP failure erase a newer status', async () => {
    const stop = acquireUploadLive(client, key);
    await flush();
    let fail!: (error: Error) => void;
    read.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)));
    const pending = refresh();
    status(false);
    fail(new Error('late failure'));
    await expect(pending).rejects.toThrow('late failure');
    expect(admission()).toBe(false);
    expect(client.getQueryState(key)!.status).toBe('error');
    stop();
  });

  it('expires a missing live heartbeat once, rejects old callbacks and reuses reconnect scheduling', async () => {
    const stop = acquireUploadLive(client, key);
    await flush();
    status(false);
    jest.advanceTimersByTime(19_999);
    expect(admission()).toBe(false);
    jest.advanceTimersByTime(1);
    expect(admission()).toBeNull();
    expect(streams[0].close).toHaveBeenCalledTimes(1);
    status(false, 0);
    expect(admission()).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(15_000);
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(streams).toHaveLength(2);
    stop();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('expires readiness during a held hint fetch without starting another fetch', async () => {
    const stop = acquireUploadLive(client, key);
    await flush();
    status(false);
    let finish!: (value: unknown) => void;
    read.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    streams[0].listeners.change();
    jest.advanceTimersByTime(5000);
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(15_000);
    expect(admission()).toBeNull();
    jest.advanceTimersByTime(15_000);
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    finish({ operations: [], admissionsPaused: false });
    await flush();
    expect(admission()).toBeNull();
    stop();
  });

  it('keeps fresh HTTP fallback through 60-second SSE retries without false unknown intervals', async () => {
    const stop = acquireUploadLive(client, key);
    await flush();
    for (const delay of [15_000, 30_000, 45_000, 60_000]) {
      streams.at(-1)!.listeners.error();
      jest.advanceTimersByTime(delay - 1);
      expect(admission()).toBe(false);
      jest.advanceTimersByTime(1);
      await flush();
      expect(admission()).toBe(false);
    }
    expect(read).toHaveBeenCalledTimes(5);
    stop();
  });

  it('does not renew an HTTP lease when its reconnect read is held', async () => {
    const stop = acquireUploadLive(client, key);
    await flush();
    let finish!: (value: unknown) => void;
    read.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    streams[0].listeners.error();
    jest.advanceTimersByTime(15_000);
    await flush();
    jest.advanceTimersByTime(59_999);
    expect(admission()).toBe(false);
    jest.advanceTimersByTime(1);
    expect(admission()).toBeNull();
    expect(getUploadAdmission(client, key)).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
    finish({ operations: [], admissionsPaused: false });
    await flush();
    expect(admission()).toBeNull();
    stop();
  });

  it('invalidates a failed stream observation without resurrecting its superseded HTTP status', async () => {
    const stop = acquireUploadLive(client, key);
    await flush();
    status(true);
    streams[0].listeners.error();
    expect(admission()).toBeNull();
    status(false, 0);
    expect(admission()).toBeNull();
    stop();
  });

  it('keeps a newer independent HTTP observation after a stream failure', async () => {
    const stop = acquireUploadLive(client, key);
    await flush();
    status(true);
    await refresh();
    streams[0].listeners.error();
    expect(admission()).toBe(false);
    stop();
  });

  it('makes hidden mode unknown and cannot revive an old response after visibility changes', async () => {
    const stop = acquireUploadLive(client, key);
    await flush();
    let finish!: (value: unknown) => void;
    read.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const pending = refresh();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(admission()).toBeNull();
    status(false, 0);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    finish({ operations: [], admissionsPaused: false });
    await pending;
    expect(admission()).toBeNull();
    jest.advanceTimersByTime(0);
    await flush();
    expect(admission()).toBe(false);
    stop();
  });
});
