import { sendUploadBody } from './api';

jest.mock('librechat-data-provider', () => ({
  apiBaseUrl: () => '',
  getTokenHeader: () => 'Bearer verified',
  request: {},
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
    const failure = await expect(operation).rejects.toMatchObject({ code: 'unavailable' });
    BrowserTransfer.last.onerror?.();
    await failure;
    expect(BrowserTransfer.last.send).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
});
