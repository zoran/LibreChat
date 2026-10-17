import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { EmailCodeChallengeResponse, EmailCodeConfig } from 'librechat-data-provider';
import { EmailCodeRequestError } from '~/hooks/Auth/useAuthMode';
import EmailCodeLogin from '../EmailCodeLogin';

const mockRequest = jest.fn();
const mockCompleteAuthentication = jest.fn();
jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ completeAuthentication: mockCompleteAuthentication }),
}));
jest.mock('~/hooks/Auth/useAuthMode', () => ({
  ...jest.requireActual('~/hooks/Auth/useAuthMode'),
  emailCodeRequest: (...args: unknown[]) => mockRequest(...args),
}));
jest.mock(
  '~/hooks/useLocalize',
  () => () => (key: string, values?: Record<string, string>) =>
    values?.[0] === undefined ? key : `${key} ${values[0]}`,
);

const config: EmailCodeConfig = {
  authMode: 'email_code',
  emailCodeEnabled: true,
  emailCodeDomains: ['bwi.de'],
};
const signedIn = { token: 'accepted-token', user: { provider: 'email_code' } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function challenge(resendDelay = 60000): EmailCodeChallengeResponse {
  return {
    attemptId: 'a'.repeat(43),
    resendAt: new Date(Date.now() + resendDelay).toISOString(),
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  };
}

const emailInput = () => screen.getByRole('textbox', { name: 'com_auth_email_code_email' });
const codeInput = () => screen.getByRole('textbox', { name: 'com_auth_email_code_code' });
const form = () => emailInput().closest('form') as HTMLFormElement;
const submitButton = () => form().querySelector('button[type="submit"]') as HTMLButtonElement;
const button = (name: string) => screen.getByRole('button', { name });
const enterEmail = (email = 'employee@bwi.de') =>
  fireEvent.change(emailInput(), { target: { value: email } });
const enterCode = () => fireEvent.change(codeInput(), { target: { value: '01234567' } });

async function submit() {
  // Submitting the form deliberately bypasses a disabled button. The handler must enforce limits.
  await act(async () => {
    fireEvent.submit(form());
  });
}

async function repeatedSubmit() {
  await act(async () => {
    for (let index = 0; index < 3; index++) {
      form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
  });
}

async function advance(milliseconds: number) {
  await act(async () => {
    jest.advanceTimersByTime(milliseconds);
  });
}

function expectWorking() {
  const status = screen
    .getAllByRole('status')
    .find((node) => node.textContent?.includes('com_auth_email_code_working'));
  expect(status).toBeVisible();
  for (const control of screen.getAllByRole('button')) expect(control).toBeDisabled();
}

async function sendChallenge(resendDelay = 60000) {
  mockRequest.mockResolvedValueOnce(challenge(resendDelay));
  enterEmail();
  await submit();
  expect(codeInput()).toBeEnabled();
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-17T00:00:00Z'));
  localStorage.clear();
  sessionStorage.clear();
  mockRequest.mockReset();
  mockCompleteAuthentication.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  jest.clearAllTimers();
  jest.useRealTimers();
  localStorage.clear();
  sessionStorage.clear();
});

it('owns a send synchronously across same-tick submissions and exposes a busy form', async () => {
  const pending = deferred<EmailCodeChallengeResponse>();
  mockRequest.mockReturnValueOnce(pending.promise);
  render(<EmailCodeLogin config={config} />);
  enterEmail();
  await repeatedSubmit();
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(mockRequest).toHaveBeenCalledWith(
    'email-code/request',
    { email: 'employee@bwi.de' },
    expect.any(AbortSignal),
  );
  expectWorking();
  expect(form()).toHaveAttribute('aria-busy', 'true');
  expect(emailInput()).toBeDisabled();
  await act(async () => pending.resolve(challenge()));
  expect(form()).toHaveAttribute('aria-busy', 'false');
  expect(codeInput()).toBeEnabled();
});

it('keeps the minimum send cooldown after a failed request and guards direct submits until expiry', async () => {
  mockRequest.mockRejectedValueOnce(new Error('network unavailable'));
  render(<EmailCodeLogin config={config} />);
  enterEmail();
  await submit();
  expect(screen.getByRole('alert')).toHaveTextContent('com_auth_email_code_unavailable');
  expect(submitButton()).toBeDisabled();
  expect(submitButton()).toHaveTextContent('60');
  await submit();
  await advance(59000);
  await submit();
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(submitButton()).toHaveTextContent('1');
  await advance(1000);
  expect(submitButton()).toBeEnabled();
  mockRequest.mockResolvedValueOnce(challenge());
  await submit();
  expect(mockRequest).toHaveBeenCalledTimes(2);
});

it('preserves the later server send deadline across changing email and restoring persisted storage', async () => {
  const first = render(<EmailCodeLogin config={config} />);
  await sendChallenge(90000);
  fireEvent.click(button('com_auth_email_code_change_email'));
  enterEmail('another@bwi.de');
  await submit();
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(submitButton()).toBeDisabled();

  const persisted = Object.entries(localStorage);
  expect(persisted.length).toBeGreaterThan(0);
  for (const [, value] of persisted) {
    const deadlines = Object.values(JSON.parse(value));
    expect(deadlines.length).toBeGreaterThan(0);
    expect(
      deadlines.every((deadline) => typeof deadline === 'number' && Number.isFinite(deadline)),
    ).toBe(true);
  }
  expect(JSON.stringify(persisted)).not.toMatch(/employee@|another@|01234567|accepted-token/);
  first.unmount();
  localStorage.clear();
  for (const [key, value] of persisted) localStorage.setItem(key, value);
  render(<EmailCodeLogin config={config} />);
  enterEmail();
  await advance(89000);
  await submit();
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(submitButton()).toBeDisabled();
  await advance(1000);
  expect(submitButton()).toBeEnabled();
  mockRequest.mockResolvedValueOnce(challenge());
  await submit();
  expect(mockRequest).toHaveBeenCalledTimes(2);
});

it('honors a send Retry-After longer than the local minimum even after remount', async () => {
  mockRequest.mockRejectedValueOnce(new EmailCodeRequestError('EMAIL_CODE_THROTTLED', 120));
  const first = render(<EmailCodeLogin config={config} />);
  enterEmail();
  await submit();
  expect(submitButton()).toHaveTextContent('120');
  first.unmount();
  render(<EmailCodeLogin config={config} />);
  enterEmail();
  await advance(119000);
  await submit();
  expect(mockRequest).toHaveBeenCalledTimes(1);
  await advance(1000);
  mockRequest.mockResolvedValueOnce(challenge());
  await submit();
  expect(mockRequest).toHaveBeenCalledTimes(2);
});

it('verifies an already received code during send cooldown with one pending authentication', async () => {
  const pending = deferred<typeof signedIn>();
  const authentication = deferred<void>();
  const onComplete = jest.fn();
  mockCompleteAuthentication.mockReturnValueOnce(authentication.promise);
  render(<EmailCodeLogin config={config} onComplete={onComplete} />);
  await sendChallenge();
  expect(button('com_auth_email_code_resend_wait 60')).toBeDisabled();
  enterCode();
  mockRequest.mockReturnValueOnce(pending.promise);
  await repeatedSubmit();
  expect(mockRequest).toHaveBeenCalledTimes(2);
  expect(mockRequest).toHaveBeenLastCalledWith(
    'email-code/verify',
    { attemptId: 'a'.repeat(43), code: '01234567' },
    expect.any(AbortSignal),
  );
  expectWorking();
  expect(emailInput()).toBeDisabled();
  expect(codeInput()).toBeDisabled();
  await act(async () => pending.resolve(signedIn));
  expect(mockCompleteAuthentication).toHaveBeenCalledWith(signedIn.token, signedIn.user);
  expectWorking();
  expect(onComplete).not.toHaveBeenCalled();
  await act(async () => authentication.resolve());
  expect(onComplete).toHaveBeenCalledTimes(1);
});

it('honors verification Retry-After in the submit handler without blocking an available resend', async () => {
  render(<EmailCodeLogin config={config} />);
  await sendChallenge();
  await advance(60000);
  enterCode();
  mockRequest.mockRejectedValueOnce(new EmailCodeRequestError('EMAIL_CODE_THROTTLED', 10));
  await submit();
  expect(submitButton()).toBeDisabled();
  expect(submitButton()).toHaveTextContent('10');
  expect(button('com_auth_email_code_resend')).toBeEnabled();
  await submit();
  await advance(9000);
  await submit();
  expect(mockRequest).toHaveBeenCalledTimes(2);
  await advance(1000);
  mockRequest.mockResolvedValueOnce(signedIn);
  await submit();
  expect(mockRequest).toHaveBeenCalledTimes(3);
  expect(mockCompleteAuthentication).toHaveBeenCalledTimes(1);
});

it('guards rapid guest actions, exposes their busy state, and honors their separate retry deadline', async () => {
  const pending = deferred<typeof signedIn>();
  mockRequest.mockReturnValueOnce(pending.promise);
  render(<EmailCodeLogin config={{ ...config, authMode: 'transition' }} />);
  const guest = button('com_auth_email_code_choice_guest');
  await act(async () => {
    guest.click();
    guest.click();
    guest.click();
  });
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(mockRequest).toHaveBeenCalledWith('guest', {}, expect.any(AbortSignal));
  expectWorking();
  await act(async () => pending.reject(new EmailCodeRequestError('EMAIL_CODE_THROTTLED', 5)));
  expect(guest).toBeDisabled();
  expect(guest).toHaveTextContent('5');
  expect(button('com_auth_email_code_choice_email')).toBeEnabled();
  await advance(4000);
  fireEvent.click(guest);
  expect(mockRequest).toHaveBeenCalledTimes(1);
  await advance(1000);
  expect(guest).toBeEnabled();
  mockRequest.mockResolvedValueOnce(signedIn);
  fireEvent.click(guest);
  await act(async () => {});
  expect(mockRequest).toHaveBeenCalledTimes(2);
  expect(mockCompleteAuthentication).toHaveBeenCalledTimes(1);
});

it('ignores a stale verification after unmount while a replacement instance completes normally', async () => {
  const stale = deferred<typeof signedIn>();
  const oldComplete = jest.fn();
  const old = render(<EmailCodeLogin config={config} onComplete={oldComplete} />);
  await sendChallenge();
  enterCode();
  mockRequest.mockReturnValueOnce(stale.promise);
  await submit();
  const oldSignal = mockRequest.mock.calls[1][2] as AbortSignal;
  old.unmount();
  expect(oldSignal.aborted).toBe(true);
  render(<EmailCodeLogin config={config} />);
  await act(async () => stale.resolve(signedIn));
  expect(mockCompleteAuthentication).not.toHaveBeenCalled();
  expect(oldComplete).not.toHaveBeenCalled();
  expect(
    screen.queryByRole('textbox', { name: 'com_auth_email_code_code' }),
  ).not.toBeInTheDocument();
  await advance(60000);
  await sendChallenge();
  enterCode();
  mockRequest.mockResolvedValueOnce(signedIn);
  await submit();
  expect(mockCompleteAuthentication).toHaveBeenCalledTimes(1);
});
