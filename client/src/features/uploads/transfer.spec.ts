import type { ExtendedFile } from '~/common';
import { runManagedSelection, cancelManagedSelection } from './transfer';
import { reserveUpload, sendUploadBody } from './api';

jest.mock('./api', () => ({
  reserveUpload: jest.fn(),
  sendUploadBody: jest.fn(),
  changeUpload: jest.fn().mockResolvedValue({}),
}));
const reserve = reserveUpload as jest.Mock;
const send = sendUploadBody as jest.Mock;
const file = (id: string): ExtendedFile => ({
  file_id: id,
  file: new File(['text'], 'a.txt'),
  filename: 'a.txt',
  type: 'text/plain',
  size: 4,
  progress: 0,
  managedUpload: { phase: 'selected' },
});
const setup = () => ({
  signal: new AbortController().signal,
  current: () => true,
  update: jest.fn(),
  refresh: jest.fn().mockResolvedValue(undefined),
  ready: jest
    .fn()
    .mockResolvedValue({ id: 'op', state: 'ready', attachment: { file_id: 'op', bytes: 4 } }),
  onStart: jest.fn(),
  onSuccess: jest.fn(),
  onError: jest.fn(),
  onAbort: jest.fn(),
});

describe('managed selection lifecycle', () => {
  beforeEach(() => {
    reserve.mockReset();
    send.mockReset();
  });
  it('fences a reservation response after an account or composer change', async () => {
    let finish!: (value: unknown) => void;
    reserve.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let current = true;
    const options = { ...setup(), current: () => current };
    const running = runManagedSelection([file('old')], options);
    current = false;
    const before = options.update.mock.calls.length;
    finish({ id: 'old-operation', state: 'waiting' });
    await running;
    expect(send).not.toHaveBeenCalled();
    expect(options.update).toHaveBeenCalledTimes(before);
    expect(options.onSuccess).not.toHaveBeenCalled();
  });
  it('cancels a selected later file before its bytes or reservation are sent', async () => {
    let finish!: (value: unknown) => void;
    reserve.mockResolvedValue({ id: 'op', state: 'waiting' });
    send.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const options = setup();
    const running = runManagedSelection([file('first'), file('later')], options);
    await Promise.resolve();
    await Promise.resolve();
    cancelManagedSelection('later');
    finish({ id: 'op', state: 'queued_processing' });
    await running;
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(options.onAbort).toHaveBeenCalledWith('later');
    expect(options.update).toHaveBeenCalledWith(
      'later',
      expect.objectContaining({ managedUpload: expect.objectContaining({ phase: 'cancelled' }) }),
    );
  });
  it('does not report ready at the end of a measured transfer', async () => {
    reserve.mockResolvedValue({ id: 'op', state: 'waiting' });
    send.mockImplementation(async (_id, _file, _signal, progress) => {
      progress({ loaded: 4, total: 4, percent: 100, bytesPerSecond: null, remainingSeconds: null });
      return { id: 'op', state: 'queued_processing' };
    });
    let confirm!: (value: unknown) => void;
    const options = setup();
    options.ready.mockImplementation(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
    const running = runManagedSelection([file('first')], options);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(options.onSuccess).not.toHaveBeenCalled();
    expect(options.update).toHaveBeenCalledWith(
      'first',
      expect.objectContaining({ managedUpload: expect.objectContaining({ phase: 'storing' }) }),
    );
    confirm({ id: 'op', state: 'ready', attachment: { file_id: 'op', bytes: 4 } });
    await running;
    expect(options.onSuccess).toHaveBeenCalledTimes(1);
  });
});
