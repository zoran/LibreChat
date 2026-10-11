import { act, fireEvent, render, screen } from '@testing-library/react';
import MaintenanceNotice from '../MaintenanceNotice';

const mockFetch = jest.fn();
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
let mockEnabled: boolean | undefined = true;
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { maintenanceStatusEnabled: mockEnabled } }),
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

const response = (active: boolean) => ({
  ok: true,
  redirected: false,
  json: async () => ({ version: 1, active }),
});

describe('maintenance notice', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockEnabled = true;
    mockFetch.mockReset().mockResolvedValue(response(false));
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      writable: true,
      value: mockFetch,
    });
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open');
    };
  });
  afterEach(() => {
    jest.useRealTimers();
    if (originalFetch) Object.defineProperty(globalThis, 'fetch', originalFetch);
    else Reflect.deleteProperty(globalThis, 'fetch');
  });

  it('does not poll deployments without an entry maintenance gate', async () => {
    mockEnabled = false;
    render(<MaintenanceNotice />);
    await act(async () => {
      jest.advanceTimersByTime(10000);
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows the entry notice when maintenance blocks startup configuration', async () => {
    mockEnabled = undefined;
    mockFetch.mockResolvedValue(response(true));
    const { container } = render(<MaintenanceNotice />);
    await act(async () => {});
    expect(container.querySelector('dialog')).toHaveAttribute('open');
  });

  it('locks an open page, retains the lock on errors, and releases only on confirmed recovery', async () => {
    const { container, unmount } = render(<MaintenanceNotice />);
    await act(async () => {});
    const dialog = container.querySelector('dialog');
    expect(dialog).not.toHaveAttribute('open');
    mockFetch.mockResolvedValue(response(true));
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(dialog).toHaveAttribute('open');
    expect(screen.getByRole('heading')).toHaveFocus();
    expect(fireEvent(dialog!, new Event('cancel', { cancelable: true }))).toBe(false);

    mockFetch.mockRejectedValue(new Error('backend unavailable'));
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(dialog).toHaveAttribute('open');
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ active: false }) });
    await act(async () => {
      fireEvent.focus(window);
    });
    expect(dialog).toHaveAttribute('open');

    mockFetch.mockResolvedValue(response(false));
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(dialog).not.toHaveAttribute('open');
    unmount();
    const calls = mockFetch.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(10000);
      fireEvent.focus(window);
    });
    expect(fetch).toHaveBeenCalledTimes(calls);
  });
});
