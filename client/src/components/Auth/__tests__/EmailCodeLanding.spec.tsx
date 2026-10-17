import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { ThemeContext } from '@librechat/client';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { TStartupConfig } from 'librechat-data-provider';
import EmailCodeLanding from '../EmailCodeLanding';

let mockAuth: any;
let mockLinkAvailable: boolean;
let mockStartup: {
  data: Partial<TStartupConfig> | undefined;
  isFetching: boolean;
  error: unknown;
};
const mockRequest = jest.fn();
const mockLink = { attemptId: 'a'.repeat(43), code: '01234567', activated: true };
const configuredLogo = '/assets/cortex-wordmark-dark.svg?v=fixture';
jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => mockAuth }));
jest.mock('~/hooks/Auth/useAuthMode', () => ({
  emailCodeRequest: (...args: unknown[]) => mockRequest(...args),
}));
jest.mock('~/common/emailCodeLink', () => ({
  get emailCodeLink() {
    return mockLinkAvailable ? mockLink : null;
  },
}));
jest.mock('~/hooks/useLocalize', () => () => (key: string) => key);
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => mockStartup,
  useGetBannerQuery: () => ({ data: null, isLoading: false, isError: false }),
}));
// Keep the actual auth layout and logo: losing the configured identity on this route is the
// regression. Mock only remote configuration and identity boundaries, not their rendered result.
const view = () => (
  <RecoilRoot>
    <ThemeContext.Provider
      value={{
        theme: 'dark',
        resolvedMode: 'dark',
        highContrast: false,
        setTheme: jest.fn(),
        setThemeRGB: jest.fn(),
        setThemeDefinition: jest.fn(),
        setThemeName: jest.fn(),
        resetTheme: jest.fn(),
      }}
    >
      <MemoryRouter>
        <EmailCodeLanding />
      </MemoryRouter>
    </ThemeContext.Provider>
  </RecoilRoot>
);
const continueButton = () => screen.getByRole('button', { name: 'com_auth_email_link_continue' });
const recoveryLink = () => screen.getByRole('link', { name: 'com_auth_email_link_new' });
const landingAlert = () => within(screen.getByRole('main')).getByRole('alert');
beforeEach(() => {
  mockRequest.mockReset();
  mockLink.activated = true;
  mockLinkAvailable = true;
  mockStartup = {
    data: {
      appTitle: 'BWI Cortex',
      authMode: 'email_code',
      interface: {
        appLogo: { light: '/assets/cortex-wordmark.svg?v=fixture', dark: configuredLogo },
      },
    } as Partial<TStartupConfig>,
    isFetching: false,
    error: null,
  };
  mockAuth = {
    authResolution: { status: 'pending', generation: 0 },
    isAuthenticated: false,
    isAuthGenerationCurrent: (g: number) => g === mockAuth.authResolution.generation,
    completeAuthentication: jest.fn(),
  };
  mockRequest.mockResolvedValue({ token: 'token', user: { provider: 'email_code' } });
});
it('keeps configured branding while resolution waits and offers recovery when discovery fails', () => {
  const { rerender } = render(view());
  expect(screen.getAllByRole('main')).toHaveLength(1);
  expect(
    screen.getByRole('heading', { level: 1, name: 'com_auth_email_link_title' }),
  ).toBeVisible();
  expect(screen.getByRole('img', { name: 'BWI Cortex' })).toHaveAttribute('src', configuredLogo);
  expect(screen.getByRole('status')).toHaveTextContent('com_auth_email_link_working');
  expect(mockRequest).not.toHaveBeenCalled();
  mockAuth.authResolution.status = 'unavailable';
  rerender(view());
  expect(landingAlert()).toHaveTextContent('com_auth_email_link_unavailable');
  expect(recoveryLink()).toHaveAttribute('href', '/login');
  expect(screen.getByRole('img', { name: 'BWI Cortex' })).toHaveAttribute('src', configuredLogo);
  expect(mockRequest).not.toHaveBeenCalled();
});
it('auto-completes a confirmed anonymous click once while branding is still loading', async () => {
  mockAuth.authResolution.status = 'resolved';
  mockStartup.data = undefined;
  mockStartup.isFetching = true;
  const { rerender } = render(view());
  await waitFor(() => expect(mockAuth.completeAuthentication).toHaveBeenCalledTimes(1));
  rerender(view());
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(mockRequest).toHaveBeenCalledWith('email-code/verify', {
    attemptId: mockLink.attemptId,
    code: mockLink.code,
  });
});
it.each(['email_code', 'local', 'openid'])(
  'confirms every authenticated non-guest (%s) before POST',
  async (provider) => {
    mockAuth.authResolution.status = 'resolved';
    mockAuth.isAuthenticated = true;
    mockAuth.user = { provider };
    render(view());
    expect(mockRequest).not.toHaveBeenCalled();
    fireEvent.click(continueButton());
    await waitFor(() => expect(mockRequest).toHaveBeenCalledTimes(1));
  },
);
it('prefetch requires confirmation and stale completion cannot switch identity', async () => {
  mockAuth.authResolution.status = 'resolved';
  mockLink.activated = false;
  let finish!: (value: unknown) => void;
  mockRequest.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(view());
  expect(mockRequest).not.toHaveBeenCalled();
  fireEvent.click(continueButton());
  mockAuth.authResolution = { status: 'resolved', generation: 1 };
  finish({ token: 'late', user: { provider: 'email_code' } });
  await waitFor(() => expect(landingAlert()).toHaveTextContent('com_auth_email_link_invalid'));
  expect(mockAuth.completeAuthentication).not.toHaveBeenCalled();
  expect(recoveryLink()).toHaveAttribute('href', '/login');
});
it('keeps the logo and recovery action when the code request fails', async () => {
  mockAuth.authResolution.status = 'resolved';
  mockRequest.mockRejectedValueOnce(new Error('code rejected'));
  render(view());
  await waitFor(() => expect(landingAlert()).toHaveTextContent('com_auth_email_link_invalid'));
  expect(screen.getByRole('img', { name: 'BWI Cortex' })).toHaveAttribute('src', configuredLogo);
  expect(recoveryLink()).toHaveAttribute('href', '/login');
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(mockAuth.completeAuthentication).not.toHaveBeenCalled();
});
it('offers recovery without redeeming an absent link even when startup configuration failed', () => {
  mockAuth.authResolution.status = 'resolved';
  mockLinkAvailable = false;
  mockStartup.data = undefined;
  mockStartup.error = new Error('configuration unavailable');
  render(view());
  expect(landingAlert()).toHaveTextContent('com_auth_email_link_invalid');
  expect(recoveryLink()).toHaveAttribute('href', '/login');
  expect(mockRequest).not.toHaveBeenCalled();
  expect(mockAuth.completeAuthentication).not.toHaveBeenCalled();
});
