import { act, fireEvent, render, screen } from '@testing-library/react';
import MaintenanceNotice from '../MaintenanceNotice';

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
    global.fetch = jest.fn().mockResolvedValue(response(false));
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute('open');
    };
  });
  afterEach(() => {
    jest.useRealTimers();
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
    (fetch as jest.Mock).mockResolvedValue(response(true));
    const { container } = render(<MaintenanceNotice />);
    await act(async () => {});
    expect(container.querySelector('dialog')).toHaveAttribute('open');
  });

  it('locks an open page, retains the lock on errors, and releases only on confirmed recovery', async () => {
    const { container, unmount } = render(<MaintenanceNotice />);
    await act(async () => {});
    const dialog = container.querySelector('dialog');
    expect(dialog).not.toHaveAttribute('open');
    (fetch as jest.Mock).mockResolvedValue(response(true));
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(dialog).toHaveAttribute('open');
    expect(screen.getByRole('heading')).toHaveFocus();
    expect(fireEvent(dialog!, new Event('cancel', { cancelable: true }))).toBe(false);

    (fetch as jest.Mock).mockRejectedValue(new Error('backend unavailable'));
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(dialog).toHaveAttribute('open');
    (fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ active: false }) });
    await act(async () => {
      fireEvent.focus(window);
    });
    expect(dialog).toHaveAttribute('open');

    (fetch as jest.Mock).mockResolvedValue(response(false));
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(dialog).not.toHaveAttribute('open');
    unmount();
    const calls = (fetch as jest.Mock).mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(10000);
      fireEvent.focus(window);
    });
    expect(fetch).toHaveBeenCalledTimes(calls);
  });
});
