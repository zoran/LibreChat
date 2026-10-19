import { act, fireEvent, render, screen } from '@testing-library/react';
import MaintenanceNotice from '../MaintenanceNotice';

const mockFetch = jest.fn();
const mockReload = jest.fn();
// Substitute only jsdom's native navigation boundary; keep the actual Location and URL.
const locationImplementation = Object.getOwnPropertySymbols(window.location)
  .map((symbol) => Reflect.get(window.location, symbol))
  .find((value) => typeof value?.reload === 'function');
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
let mockEnabled: boolean | undefined = true;
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { maintenanceStatusEnabled: mockEnabled } }),
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

const response = (active: boolean, operationId?: string) => ({
  ok: true,
  redirected: false,
  json: async () => ({ version: 1, active, ...(operationId ? { operationId } : {}) }),
});

describe('maintenance notice', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockEnabled = true;
    mockReload.mockReset();
    window.history.replaceState(null, '', '/c/new');
    jest.spyOn(locationImplementation, 'reload').mockImplementation(mockReload);
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
    jest.restoreAllMocks();
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
  it.each(['/status', '/status/'])(
    'reloads %s once after an observed operation is released',
    async (pathname) => {
      const href = `${window.location.origin}${pathname}?view=infrastructure#cpu-2`;
      window.history.replaceState(null, '', href);
      mockFetch.mockResolvedValue(response(true, 'status-v2.2026-10-19'));
      const { container } = render(<MaintenanceNotice />);
      await act(async () => {});
      expect(container.querySelector('dialog')).toHaveAttribute('open');
      expect(mockReload).not.toHaveBeenCalled();

      mockFetch.mockResolvedValue(response(false));
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(mockReload).toHaveBeenCalledTimes(1);
      expect(mockReload).toHaveBeenCalledWith();
      expect(window.location.href).toBe(href);
      // Keep the lock until navigation commits, including a cancelled browser unload.
      expect(container.querySelector('dialog')).toHaveAttribute('open');
      const calls = mockFetch.mock.calls.length;
      await act(async () => {
        jest.advanceTimersByTime(15000);
        fireEvent.focus(window);
        fireEvent(document, new Event('visibilitychange'));
      });
      expect(mockReload).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledTimes(calls);
    },
  );

  it('does not reload an initially idle Status page or another app page', async () => {
    window.history.replaceState(null, '', '/status');
    const view = render(<MaintenanceNotice />);
    await act(async () => {});
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(mockReload).not.toHaveBeenCalled();
    window.history.replaceState(null, '', '/c/retained-draft');
    mockFetch.mockResolvedValue(response(true, 'same-operation'));
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    mockFetch.mockResolvedValue(response(false));
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(view.container.querySelector('dialog')).not.toHaveAttribute('open');
    expect(mockReload).not.toHaveBeenCalled();
    window.history.replaceState(null, '', '/status');
    await act(async () => {
      fireEvent.focus(window);
    });
    expect(mockReload).not.toHaveBeenCalled();
  });

  it.each([undefined, '_invalid', 'x'.repeat(64), 'operation\n'])(
    'does not arm a reload from an invalid operation identity %s',
    async (operationId) => {
      window.history.replaceState(null, '', '/status');
      mockFetch.mockResolvedValue(response(true, operationId));
      render(<MaintenanceNotice />);
      await act(async () => {});
      mockFetch.mockResolvedValue(response(false));
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(mockReload).not.toHaveBeenCalled();
    },
  );

  it('retains an observed Status lock on failed, redirected or invalid release reads', async () => {
    window.history.replaceState(null, '', '/status');
    mockFetch.mockResolvedValue(response(true, 'release-operation'));
    const view = render(<MaintenanceNotice />);
    await act(async () => {});
    for (const next of [
      { ...response(false), ok: false },
      { ...response(false), redirected: true },
      { ok: true, redirected: false, json: async () => ({ version: 2, active: false }) },
      { ok: true, redirected: false, json: async () => ({ version: 1, active: 'false' }) },
    ]) {
      mockFetch.mockResolvedValue(next);
      await act(async () => {
        jest.advanceTimersByTime(5000);
      });
      expect(view.container.querySelector('dialog')).toHaveAttribute('open');
      expect(mockReload).not.toHaveBeenCalled();
    }
    mockFetch.mockRejectedValue(new Error('network lost'));
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(view.container.querySelector('dialog')).toHaveAttribute('open');
    expect(mockReload).not.toHaveBeenCalled();
    mockFetch.mockResolvedValue(response(false));
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(mockReload).toHaveBeenCalledTimes(1);
  });
});
