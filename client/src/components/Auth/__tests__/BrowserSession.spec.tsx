import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { request } from 'librechat-data-provider';
import { StrictMode } from 'react';
import BrowserSession from '../BrowserSession';

let mockMode: any;
const mockClearStates = jest.fn();
jest.mock('~/hooks/Auth/useAuthMode', () => ({
  __esModule: true,
  default: () => mockMode,
  emailCodeRequest: jest.fn(),
}));
jest.mock('~/hooks/useLocalize', () => () => (key: string) => key);
jest.mock('~/hooks/Config/useClearStates', () => () => mockClearStates);
jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ completeAuthentication: jest.fn() }),
}));
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    request: { ...actual.request, resetBrowser: jest.fn(), enrollBrowser: jest.fn() },
  };
});
const config = (authMode: string) => ({
  authMode,
  emailCodeEnabled: true,
  guestEnabled: false,
  emailCodeDomains: ['employees.example.test'],
});
beforeEach(() => {
  mockMode = { isSuccess: false, isLoading: true, isError: false, data: undefined };
  mockClearStates.mockReset().mockResolvedValue(undefined);
  (request.resetBrowser as jest.Mock).mockReset().mockResolvedValue(undefined);
  (request.enrollBrowser as jest.Mock)
    .mockReset()
    .mockRejectedValue(new Error('end inert fixture before navigation'));
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: jest.fn(async (_name, action) => action()) },
  });
});

it.each(['BROWSER_SESSION_EXPIRED', 'BROWSER_SESSION_FORGOTTEN'])(
  'keeps %s closed until discovery positively confirms default',
  (code) => {
    const { rerender } = render(<BrowserSession code={code} onState={jest.fn()} />);
    expect(screen.queryByRole('button', { name: 'com_auth_browser_new' })).not.toBeInTheDocument();
    for (const data of [undefined, config('default'), config('unknown')]) {
      mockMode = { isSuccess: false, isLoading: false, isError: true, data };
      rerender(<BrowserSession code={code} onState={jest.fn()} />);
      expect(
        screen.queryByRole('button', { name: 'com_auth_browser_new' }),
      ).not.toBeInTheDocument();
      expect(screen.getByText('com_auth_browser_unavailable')).toBeInTheDocument();
    }
    expect(request.resetBrowser).not.toHaveBeenCalled();
    expect(request.enrollBrowser).not.toHaveBeenCalled();
  },
);

it('renders the real direct email form after mandatory-mode discovery', () => {
  mockMode = { isSuccess: true, isError: false, isLoading: false, data: config('email_code') };
  render(<BrowserSession code="BROWSER_SESSION_EXPIRED" onState={jest.fn()} />);
  expect(screen.getByLabelText('com_auth_email_code_email')).toHaveAttribute('type', 'email');
  expect(screen.getByRole('button', { name: 'com_auth_email_code_send' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'com_auth_browser_new' })).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'com_auth_email_code_choice_guest' }),
  ).not.toBeInTheDocument();
});

it('preserves confirmed default recovery', async () => {
  mockMode = { isSuccess: true, isError: false, isLoading: false, data: config('default') };
  render(
    <StrictMode>
      <BrowserSession code="BROWSER_SESSION_FORGOTTEN" onState={jest.fn()} />
    </StrictMode>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'com_auth_browser_new' }));
  await waitFor(() => expect(request.enrollBrowser).toHaveBeenCalledTimes(1));
  expect(request.resetBrowser).toHaveBeenCalledTimes(1);
});

it('rejects a successfully fetched unknown mode instead of treating it as default', () => {
  mockMode = { isSuccess: true, isError: false, isLoading: false, data: config('unknown') };
  render(<BrowserSession code="BROWSER_SESSION_FORGOTTEN" onState={jest.fn()} />);
  expect(screen.getByText('com_auth_browser_unavailable')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'com_auth_browser_new' })).not.toBeInTheDocument();
});

it.each(['lock', 'clear'])(
  'rechecks mode after waiting for %s before recovery writes',
  async (boundary) => {
    mockMode = { isSuccess: true, isError: false, isLoading: false, data: config('default') };
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    if (boundary === 'lock')
      (navigator.locks.request as jest.Mock).mockImplementation(async (_name, action) => {
        await paused;
        return action();
      });
    else mockClearStates.mockReturnValue(paused);
    const { rerender } = render(
      <BrowserSession code="BROWSER_SESSION_EXPIRED" onState={jest.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'com_auth_browser_new' }));
    if (boundary === 'clear') await waitFor(() => expect(mockClearStates).toHaveBeenCalledTimes(1));
    mockMode = { isSuccess: true, isError: false, isLoading: false, data: config('email_code') };
    rerender(<BrowserSession code="BROWSER_SESSION_EXPIRED" onState={jest.fn()} />);
    await act(async () => {
      resume();
      await paused;
    });
    expect(request.enrollBrowser).not.toHaveBeenCalled();
    if (boundary === 'lock') expect(request.resetBrowser).not.toHaveBeenCalled();
  },
);
