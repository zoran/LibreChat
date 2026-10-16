import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import EmailCodeLanding from '../EmailCodeLanding';

let mockAuth: any;
const mockRequest = jest.fn();
const mockLink = { attemptId: 'a'.repeat(43), code: '01234567', activated: true };
jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => mockAuth }));
jest.mock('~/hooks/Auth/useAuthMode', () => ({
  emailCodeRequest: (...args: unknown[]) => mockRequest(...args),
}));
jest.mock('~/common/emailCodeLink', () => ({
  get emailCodeLink() {
    return mockLink;
  },
}));
jest.mock('~/hooks/useLocalize', () => () => (key: string) => key);
const view = () => (
  <MemoryRouter>
    <EmailCodeLanding />
  </MemoryRouter>
);
beforeEach(() => {
  mockRequest.mockReset();
  mockLink.activated = true;
  mockAuth = {
    authResolution: { status: 'pending', generation: 0 },
    isAuthenticated: false,
    isAuthGenerationCurrent: (g: number) => g === mockAuth.authResolution.generation,
    completeAuthentication: jest.fn(),
  };
  mockRequest.mockResolvedValue({ token: 'token', user: { provider: 'email_code' } });
});
it('waits for confirmed resolution; discovery errors never redeem', async () => {
  const { rerender } = render(view());
  expect(mockRequest).not.toHaveBeenCalled();
  mockAuth.authResolution.status = 'unavailable';
  rerender(view());
  expect(screen.getByRole('alert')).toHaveTextContent('com_auth_email_link_unavailable');
  expect(mockRequest).not.toHaveBeenCalled();
});
it('auto-completes a confirmed anonymous click once', async () => {
  mockAuth.authResolution.status = 'resolved';
  const { rerender } = render(view());
  await waitFor(() => expect(mockAuth.completeAuthentication).toHaveBeenCalledTimes(1));
  rerender(view());
  expect(mockRequest).toHaveBeenCalledTimes(1);
});
it.each(['email_code', 'local', 'openid'])(
  'confirms every authenticated non-guest (%s) before POST',
  async (provider) => {
    mockAuth.authResolution.status = 'resolved';
    mockAuth.isAuthenticated = true;
    mockAuth.user = { provider };
    render(view());
    expect(mockRequest).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button'));
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
  fireEvent.click(screen.getByRole('button'));
  mockAuth.authResolution = { status: 'resolved', generation: 1 };
  finish({ token: 'late', user: { provider: 'email_code' } });
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent('com_auth_email_link_invalid'),
  );
  expect(mockAuth.completeAuthentication).not.toHaveBeenCalled();
});
