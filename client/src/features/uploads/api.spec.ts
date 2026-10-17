import { request } from 'librechat-data-provider';
import { readUploadSnapshot, reserveUpload, sendUploadBody } from './api';

jest.mock('librechat-data-provider', () => ({
  apiBaseUrl: () => '',
  getTokenHeader: () => 'Bearer verified',
  request: { authenticatedFetch: jest.fn() },
}));

class BrowserTransfer {
  static last: BrowserTransfer;
  upload = { onprogress: undefined as undefined | ((event: { loaded: number }) => void) };
  onload?: () => void;
  onerror?: () => void;
  ontimeout?: () => void;
  onabort?: () => void;
  responseText = '{}';
  status = 200;
  timeout = 0;
  open = jest.fn();
  setRequestHeader = jest.fn();
  send = jest.fn();
  abort = () => this.onabort?.();
  constructor() {
    BrowserTransfer.last = this;
  }
}
describe('browser upload transport', () => {
  const OriginalXHR = global.XMLHttpRequest;
  beforeEach(() => {
    jest.useFakeTimers();
    global.XMLHttpRequest = BrowserTransfer as unknown as typeof XMLHttpRequest;
  });
  afterEach(() => {
    global.XMLHttpRequest = OriginalXHR;
    jest.useRealTimers();
  });
  it('removes stale throughput/ETA during a stalled transfer without new progress events', async () => {
    const progress = jest.fn();
    const operation = sendUploadBody(
      'one',
      new File(['x'.repeat(10000)], 'a.txt'),
      new AbortController().signal,
      progress,
    );
    const xhr = BrowserTransfer.last;
    for (const loaded of [1000, 2000, 3000]) {
      jest.advanceTimersByTime(600);
      xhr.upload.onprogress?.({ loaded });
    }
    expect(progress.mock.calls.at(-1)?.[0].remainingSeconds).not.toBeNull();
    jest.advanceTimersByTime(4000);
    expect(progress.mock.calls.at(-1)?.[0].remainingSeconds).toBeNull();
    expect(progress.mock.calls.at(-1)?.[0].loaded).toBe(3000);
    xhr.onload?.();
    await operation;
    expect(jest.getTimerCount()).toBe(0);
  });
  it('sends once and preserves unknown network failure instead of replaying the body', async () => {
    const operation = sendUploadBody(
      'one',
      new File(['text'], 'a.txt'),
      new AbortController().signal,
      jest.fn(),
    );
    BrowserTransfer.last.onerror?.();
    await expect(operation).rejects.toMatchObject({ code: 'unavailable' });
    expect(BrowserTransfer.last.send).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('carries the original Unicode name only in bounded transient body metadata', async () => {
    const filename = 'Prüfung – Quellen 2026.txt';
    const operation = sendUploadBody(
      'one',
      new File(['text'], filename),
      new AbortController().signal,
      jest.fn(),
    );
    const xhr = BrowserTransfer.last;
    expect(xhr.open).toHaveBeenCalledWith('PUT', '/api/uploads/operations/one/body');
    expect(xhr.setRequestHeader).toHaveBeenCalledWith(
      'X-Upload-Filename',
      encodeURIComponent(filename),
    );
    xhr.onload?.();
    await operation;
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('managed snapshot admission boundary', () => {
  const respond = (body: object, status = 200) => {
    const read = jest
      .fn()
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(JSON.stringify(body)) })
      .mockResolvedValueOnce({ done: true });
    (request.authenticatedFetch as jest.Mock).mockResolvedValueOnce({
      ok: status === 200,
      status,
      body: { getReader: () => ({ read, cancel: jest.fn().mockResolvedValue(undefined) }) },
    });
  };

  it.each([true, false, null])('preserves the explicit admission value %s', async (value) => {
    respond({ operations: [], admissionsPaused: value });
    expect((await readUploadSnapshot()).admissionsPaused).toBe(value);
  });

  it.each([undefined, 'false', 0, {}, []])(
    'does not infer open admission from %s',
    async (value) => {
      respond({ operations: [{ id: 'retained' }], admissionsPaused: value });
      expect(await readUploadSnapshot()).toMatchObject({
        operations: [{ id: 'retained' }],
        admissionsPaused: null,
      });
    },
  );

  it('preserves the server pause error and never automatically replays a reservation', async () => {
    respond({ code: 'admission_paused' }, 503);
    await expect(
      reserveUpload(
        {
          mediaType: 'text/plain',
          declaredBytes: 4,
          idempotencyKey: '00000000-0000-4000-8000-000000000001',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'admission_paused', status: 503 });
    expect(request.authenticatedFetch).toHaveBeenCalledTimes(1);
  });
});
