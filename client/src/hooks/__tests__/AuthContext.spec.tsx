/**
 * @jest-environment @happy-dom/jest-environment
 */
import React from 'react';
import { RecoilRoot } from 'recoil';
import { getDefaultStore } from 'jotai';
import { MemoryRouter } from 'react-router-dom';
import { render, act, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  request,
  LocalStorageKeys,
  BROWSER_SESSION_EVENT,
  BrowserSessionError,
} from 'librechat-data-provider';
import type { TAuthConfig } from '~/common';
import {
  chatFilterStatusAtom,
  chatFilterTagsAtom,
  chatSortAtom,
  resetChatFilterSessionAtom,
} from '~/components/Conversations/chatFilters';
import { browserSessionState } from '~/components/Auth/BrowserSession';
import { AuthContextProvider, useAuthContext } from '../AuthContext';
import { SESSION_KEY } from '~/utils';

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

const mockApiBaseUrl = jest.fn(() => '');
const mockStartupConfig = jest.fn(async () => ({ browserSessionEnabled: false }));
const mockEnrollBrowserSession = jest.fn();

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  setTokenHeader: jest.fn(),
  apiBaseUrl: () => mockApiBaseUrl(),
  dataService: {
    ...jest.requireActual('librechat-data-provider').dataService,
    getStartupConfig: () => mockStartupConfig(),
  },
  enrollBrowserSession: (...args: unknown[]) => mockEnrollBrowserSession(...args),
}));

let mockCapturedLoginOptions: {
  onSuccess: (...args: unknown[]) => void;
  onError: (...args: unknown[]) => void;
};

let mockCapturedLogoutOptions: {
  onSuccess: (...args: unknown[]) => void;
  onError: (...args: unknown[]) => void;
};

const mockRefreshMutate = jest.fn();

jest.mock('~/data-provider', () => ({
  useLoginUserMutation: jest.fn(
    (options: {
      onSuccess: (...args: unknown[]) => void;
      onError: (...args: unknown[]) => void;
    }) => {
      mockCapturedLoginOptions = options;
      return { mutate: jest.fn() };
    },
  ),
  useLogoutUserMutation: jest.fn(
    (options: {
      onSuccess: (...args: unknown[]) => void;
      onError: (...args: unknown[]) => void;
    }) => {
      mockCapturedLogoutOptions = options;
      return { mutate: jest.fn() };
    },
  ),
  useRefreshTokenMutation: jest.fn(() => ({ mutate: mockRefreshMutate })),
  useGetUserQuery: jest.fn(() => ({
    data: undefined,
    isError: false,
    error: null,
  })),
  useGetRole: jest.fn(() => ({ data: null })),
  useListRoles: jest.fn(() => ({ data: undefined })),
}));

const authConfig: TAuthConfig = { loginRedirect: '/login', test: true };

function TestConsumer() {
  const ctx = useAuthContext();
  return (
    <div
      data-testid="consumer"
      data-authenticated={ctx.isAuthenticated}
      data-auth-ready={ctx.isAuthReady}
      data-error={ctx.error ?? ''}
      data-roles={JSON.stringify(ctx.roles ?? {})}
    />
  );
}

function renderProvider() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <MemoryRouter>
          <AuthContextProvider authConfig={authConfig}>
            <TestConsumer />
          </AuthContextProvider>
        </MemoryRouter>
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

/** Renders without test:true so silentRefresh actually runs */
function renderProviderLive() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <MemoryRouter>
          <AuthContextProvider authConfig={{ loginRedirect: '/login' }}>
            <TestConsumer />
          </AuthContextProvider>
        </MemoryRouter>
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

function renderOptionalProvider() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <MemoryRouter>
          <AuthContextProvider authConfig={{ loginRedirect: '/login', optional: true }}>
            <TestConsumer />
          </AuthContextProvider>
        </MemoryRouter>
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

describe('AuthContextProvider — test mode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is ready without starting silent refresh', () => {
    const { getByTestId } = renderProvider();

    expect(getByTestId('consumer')).toHaveAttribute('data-auth-ready', 'true');
    expect(mockRefreshMutate).not.toHaveBeenCalled();
  });
});

describe('AuthContextProvider — optional browser access', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    getDefaultStore().set(browserSessionState, null);
    mockApiBaseUrl.mockReturnValue('');
    mockStartupConfig.mockResolvedValue({ browserSessionEnabled: false });
    window.history.replaceState({}, '', '/c/retained-conversation');
  });
  afterEach(() => {
    getDefaultStore().set(browserSessionState, null);
    jest.useRealTimers();
  });

  it('keeps normal login behavior when the feature is disabled', async () => {
    renderProviderLive();
    await act(async () => {
      await mockRefreshMutate.mock.calls[0][1].onSuccess(undefined);
    });
    expect(mockEnrollBrowserSession).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/login?redirect_to=%2Fc%2Fretained-conversation');
  });

  it('opens the existing requested route with the browser principal', async () => {
    mockStartupConfig.mockResolvedValue({ browserSessionEnabled: true });
    mockEnrollBrowserSession.mockResolvedValue({
      token: 'browser-token',
      user: { id: 'browser-1', provider: 'browser', role: 'USER' },
    });
    const { getByTestId } = renderProviderLive();
    await act(async () => {
      await mockRefreshMutate.mock.calls[0][1].onSuccess(undefined);
      jest.advanceTimersByTime(100);
    });
    expect(getByTestId('consumer')).toHaveAttribute('data-authenticated', 'true');
    expect(mockNavigate).toHaveBeenCalledWith('/c/retained-conversation', { replace: true });
  });

  it('shows explicit recovery instead of login or a new identity after expiry', async () => {
    mockStartupConfig.mockResolvedValue({ browserSessionEnabled: true });
    mockEnrollBrowserSession.mockRejectedValue(new BrowserSessionError('BROWSER_SESSION_EXPIRED'));
    const { queryByTestId } = renderProviderLive();
    await act(async () => {
      await mockRefreshMutate.mock.calls[0][1].onSuccess(undefined);
    });
    expect(getDefaultStore().get(browserSessionState)).toBe('BROWSER_SESSION_EXPIRED');
    expect(queryByTestId('consumer')).toBeNull();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('allows a real administrator login to leave browser recovery', () => {
    renderProvider();
    act(() => {
      getDefaultStore().set(browserSessionState, 'BROWSER_SESSION_FORGOTTEN');
    });
    act(() => {
      mockCapturedLoginOptions.onSuccess({
        token: 'admin-token',
        user: { id: 'admin', role: 'ADMIN', provider: 'local' },
      });
      jest.advanceTimersByTime(100);
    });
    expect(getDefaultStore().get(browserSessionState)).toBeNull();
  });

  it('keeps browser recovery when a user query fails after the refresh failure', async () => {
    const mockUserQuery = jest.requireMock('~/data-provider').useGetUserQuery;
    renderProviderLive();
    await act(async () => {
      await mockRefreshMutate.mock.calls[0][1].onSuccess({
        token: 'browser-token',
        user: { id: 'browser-1', provider: 'browser', role: 'USER' },
      });
      jest.advanceTimersByTime(100);
    });
    mockNavigate.mockClear();
    try {
      mockUserQuery.mockReturnValue({ data: undefined, isError: true, error: new Error('401') });
      act(() => {
        window.dispatchEvent(
          new CustomEvent(BROWSER_SESSION_EVENT, { detail: 'BROWSER_SESSION_EXPIRED' }),
        );
      });
      expect(getDefaultStore().get(browserSessionState)).toBe('BROWSER_SESSION_EXPIRED');
      expect(mockNavigate).not.toHaveBeenCalled();
    } finally {
      mockUserQuery.mockReturnValue({ data: undefined, isError: false, error: null });
    }
  });

  it('clears the departing workspace drafts before explicitly enrolling its replacement', async () => {
    const draftKey = `${LocalStorageKeys.TEXT_DRAFT}previous`;
    localStorage.setItem(draftKey, 'private previous draft');
    const secure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
    const locks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: (_name: string, callback: () => Promise<void>) => callback() },
    });
    jest.spyOn(request, 'resetBrowser').mockResolvedValue(undefined);
    const enroll = jest.spyOn(request, 'enrollBrowser').mockImplementation(async () => {
      expect(localStorage.getItem(draftKey)).toBeNull();
      return { token: 'new', user: { id: 'new' } } as Awaited<
        ReturnType<typeof request.enrollBrowser>
      >;
    });
    jest.spyOn(window.location, 'assign').mockImplementation(() => undefined);
    try {
      const { getAllByRole } = renderProvider();
      act(() => {
        window.dispatchEvent(
          new CustomEvent(BROWSER_SESSION_EVENT, { detail: 'BROWSER_SESSION_EXPIRED' }),
        );
      });
      await act(async () => {
        fireEvent.click(getAllByRole('button')[0]);
      });
      expect(enroll).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'isSecureContext', secure ?? { value: undefined });
      Object.defineProperty(navigator, 'locks', locks ?? { value: undefined });
      localStorage.removeItem(draftKey);
    }
  });
});

describe('AuthContextProvider — login onError redirect handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.history.replaceState({}, '', '/login');
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('preserves a valid redirect_to param across login failure', () => {
    window.history.replaceState({}, '', '/login?redirect_to=%2Fc%2Fabc123');

    renderProvider();

    act(() => {
      mockCapturedLoginOptions.onError({ message: 'Invalid credentials' });
    });

    expect(mockNavigate).toHaveBeenCalledWith('/login?redirect_to=%2Fc%2Fabc123', {
      replace: true,
    });
  });

  it('drops redirect_to when it contains an absolute URL (open-redirect prevention)', () => {
    window.history.replaceState({}, '', '/login?redirect_to=https%3A%2F%2Fevil.com');

    renderProvider();

    act(() => {
      mockCapturedLoginOptions.onError({ message: 'Invalid credentials' });
    });

    expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
  });

  it('drops redirect_to when it points to /login (recursive redirect prevention)', () => {
    window.history.replaceState({}, '', '/login?redirect_to=%2Flogin');

    renderProvider();

    act(() => {
      mockCapturedLoginOptions.onError({ message: 'Invalid credentials' });
    });

    expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
  });

  it('navigates to plain /login when no redirect_to param exists', () => {
    renderProvider();

    act(() => {
      mockCapturedLoginOptions.onError({ message: 'Server error' });
    });

    expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
  });

  it('surfaces the cross-origin rejection code instead of the HTTP status message', () => {
    jest.useFakeTimers();
    const { getByTestId } = renderProvider();

    act(() => {
      mockCapturedLoginOptions.onError({
        message: 'Request failed with status code 403',
        response: { data: { message: 'Cross-site request rejected', code: 'auth_cross_origin' } },
      });
      jest.advanceTimersByTime(400);
    });

    expect(getByTestId('consumer')).toHaveAttribute('data-error', 'auth_cross_origin');
    jest.useRealTimers();
  });

  it('keeps the HTTP status message for other rejections that carry a code', () => {
    jest.useFakeTimers();
    const { getByTestId } = renderProvider();

    act(() => {
      mockCapturedLoginOptions.onError({
        message: 'Request failed with status code 429',
        response: { data: { message: 'Too many login attempts', code: 'something_else' } },
      });
      jest.advanceTimersByTime(400);
    });

    expect(getByTestId('consumer')).toHaveAttribute(
      'data-error',
      'Request failed with status code 429',
    );
    jest.useRealTimers();
  });

  it('preserves redirect_to with query params and hash', () => {
    const target = '/c/abc123?model=gpt-4#section';
    window.history.replaceState({}, '', `/login?redirect_to=${encodeURIComponent(target)}`);

    renderProvider();

    act(() => {
      mockCapturedLoginOptions.onError({ message: 'Invalid credentials' });
    });

    const navigatedUrl = mockNavigate.mock.calls[0][0] as string;
    const params = new URLSearchParams(navigatedUrl.split('?')[1]);
    expect(decodeURIComponent(params.get('redirect_to')!)).toBe(target);
  });
});

describe('AuthContextProvider — logout onSuccess/onError handling', () => {
  const mockSetTokenHeader = jest.requireMock('librechat-data-provider').setTokenHeader;

  beforeEach(() => {
    jest.clearAllMocks();
    window.history.replaceState({}, '', '/c/some-chat');
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('calls window.location.replace and setTokenHeader(undefined) when redirect is present', () => {
    const replaceSpy = jest.spyOn(window.location, 'replace').mockImplementation(() => {});

    renderProvider();

    act(() => {
      mockCapturedLogoutOptions.onSuccess({
        message: 'Logout successful',
        redirect: 'https://idp.example.com/logout?id_token_hint=abc',
      });
    });

    expect(replaceSpy).toHaveBeenCalledWith('https://idp.example.com/logout?id_token_hint=abc');
    expect(mockSetTokenHeader).toHaveBeenCalledWith(undefined);
  });
  it('resets account-scoped chat filters at the logout session boundary', () => {
    const jotaiStore = getDefaultStore();
    jotaiStore.set(chatFilterStatusAtom, 'archived');
    jotaiStore.set(chatFilterTagsAtom, ['legacy-bookmark']);
    jotaiStore.set(chatSortAtom, { field: 'title', direction: 'asc' });

    renderProvider();

    act(() => {
      mockCapturedLogoutOptions.onSuccess({ message: 'Logout successful' });
    });

    expect(jotaiStore.get(chatFilterStatusAtom)).toBe('active');
    expect(jotaiStore.get(chatFilterTagsAtom)).toEqual([]);
    expect(jotaiStore.get(chatSortAtom)).toEqual({ field: 'title', direction: 'asc' });
    jotaiStore.set(resetChatFilterSessionAtom);
  });

  it('does not call window.location.replace when redirect is absent', async () => {
    const replaceSpy = jest.spyOn(window.location, 'replace').mockImplementation(() => {});

    renderProvider();

    act(() => {
      mockCapturedLogoutOptions.onSuccess({ message: 'Logout successful' });
    });

    expect(replaceSpy).not.toHaveBeenCalled();
  });

  it('does not trigger silentRefresh after OIDC redirect', () => {
    const replaceSpy = jest.spyOn(window.location, 'replace').mockImplementation(() => {});

    renderProviderLive();
    mockRefreshMutate.mockClear();

    act(() => {
      mockCapturedLogoutOptions.onSuccess({
        message: 'Logout successful',
        redirect: 'https://idp.example.com/logout?id_token_hint=abc',
      });
    });

    expect(replaceSpy).toHaveBeenCalled();
    expect(mockRefreshMutate).not.toHaveBeenCalled();
  });
});

describe('AuthContextProvider — silentRefresh post-login redirect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('navigates to stored sessionStorage redirect after successful token refresh', () => {
    jest.useFakeTimers();
    sessionStorage.setItem(SESSION_KEY, '/c/new?endpoint=bedrock&model=claude-sonnet-4-6');

    renderProviderLive();

    expect(mockRefreshMutate).toHaveBeenCalledTimes(1);
    const [, refreshOptions] = mockRefreshMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (data: unknown) => void },
    ];

    act(() => {
      refreshOptions.onSuccess({ user: { id: '1', role: 'USER' }, token: 'new-token' });
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });

    expect(mockNavigate).toHaveBeenCalledWith('/c/new?endpoint=bedrock&model=claude-sonnet-4-6', {
      replace: true,
    });
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
    jest.useRealTimers();
  });

  it('navigates to current URL when no stored redirect exists', () => {
    jest.useFakeTimers();
    window.history.replaceState({}, '', '/c/new');

    renderProviderLive();

    expect(mockRefreshMutate).toHaveBeenCalledTimes(1);
    const [, refreshOptions] = mockRefreshMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (data: unknown) => void },
    ];

    act(() => {
      refreshOptions.onSuccess({ user: { id: '1', role: 'USER' }, token: 'new-token' });
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });

    expect(mockNavigate).toHaveBeenCalledWith('/c/new', { replace: true });
    jest.useRealTimers();
  });

  it('does not re-trigger silentRefresh after successful redirect', () => {
    jest.useFakeTimers();
    sessionStorage.setItem(SESSION_KEY, '/c/abc?endpoint=bedrock');

    renderProviderLive();

    expect(mockRefreshMutate).toHaveBeenCalledTimes(1);
    const [, refreshOptions] = mockRefreshMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (data: unknown) => void },
    ];
    mockRefreshMutate.mockClear();

    act(() => {
      refreshOptions.onSuccess({ user: { id: '1', role: 'USER' }, token: 'new-token' });
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/c/abc?endpoint=bedrock', { replace: true });
    expect(mockRefreshMutate).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('falls back to current URL for unsafe stored redirect', () => {
    jest.useFakeTimers();
    window.history.replaceState({}, '', '/c/new');
    sessionStorage.setItem(SESSION_KEY, 'https://evil.com/steal');

    renderProviderLive();

    expect(mockRefreshMutate).toHaveBeenCalledTimes(1);
    const [, refreshOptions] = mockRefreshMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (data: unknown) => void },
    ];

    act(() => {
      refreshOptions.onSuccess({ user: { id: '1', role: 'USER' }, token: 'new-token' });
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });

    expect(mockNavigate).toHaveBeenCalledWith('/c/new', { replace: true });
    expect(mockNavigate).not.toHaveBeenCalledWith('https://evil.com/steal', expect.anything());
    expect(sessionStorage.getItem(SESSION_KEY)).toBeNull();
    jest.useRealTimers();
  });
});

describe('AuthContextProvider — optional authentication', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.history.replaceState({}, '', '/share/share-1');
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('keeps a public route visible when no refresh token exists', () => {
    renderOptionalProvider();

    const [, refreshOptions] = mockRefreshMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (data: unknown) => void },
    ];
    act(() => {
      refreshOptions.onSuccess(undefined);
    });

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="consumer"]')).toHaveAttribute(
      'data-auth-ready',
      'true',
    );
  });

  it('keeps a public route visible when session refresh fails', () => {
    renderOptionalProvider();

    const [, refreshOptions] = mockRefreshMutate.mock.calls[0] as [
      unknown,
      { onError: (error: unknown) => void },
    ];
    act(() => {
      refreshOptions.onError(new Error('No session'));
    });

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="consumer"]')).toHaveAttribute(
      'data-auth-ready',
      'true',
    );
  });
});

describe('AuthContextProvider — silentRefresh subdirectory deployment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
    mockApiBaseUrl.mockReturnValue('/chat');
  });

  afterEach(() => {
    mockApiBaseUrl.mockReturnValue('');
    sessionStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('strips base path from window.location.pathname before navigating (prevents /chat/chat doubling)', () => {
    jest.useFakeTimers();
    window.history.replaceState({}, '', '/chat/c/abc123?model=gpt-4');

    renderProviderLive();

    expect(mockRefreshMutate).toHaveBeenCalledTimes(1);
    const [, refreshOptions] = mockRefreshMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (data: unknown) => void },
    ];

    act(() => {
      refreshOptions.onSuccess({ user: { id: '1', role: 'USER' }, token: 'new-token' });
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });

    expect(mockNavigate).toHaveBeenCalledWith('/c/abc123?model=gpt-4', { replace: true });
    expect(mockNavigate).not.toHaveBeenCalledWith(
      expect.stringContaining('/chat/c/'),
      expect.anything(),
    );
    jest.useRealTimers();
  });

  it('falls back to root when window.location.pathname equals the base path', () => {
    jest.useFakeTimers();
    window.history.replaceState({}, '', '/chat');

    renderProviderLive();

    const [, refreshOptions] = mockRefreshMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (data: unknown) => void },
    ];

    act(() => {
      refreshOptions.onSuccess({ user: { id: '1', role: 'USER' }, token: 'new-token' });
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });

    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
    jest.useRealTimers();
  });
});

describe('AuthContextProvider — logout error handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.history.replaceState({}, '', '/c/some-chat');
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('clears auth state on logout error without external redirect', () => {
    jest.useFakeTimers();
    const replaceSpy = jest.spyOn(window.location, 'replace').mockImplementation(() => {});
    const { getByTestId } = renderProvider();

    act(() => {
      mockCapturedLogoutOptions.onError(new Error('Logout failed'));
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });

    expect(replaceSpy).not.toHaveBeenCalled();
    expect(getByTestId('consumer').getAttribute('data-authenticated')).toBe('false');
    jest.useRealTimers();
  });
});

describe('AuthContextProvider — custom role detection and fetching', () => {
  const mockUseGetRole = jest.requireMock('~/data-provider').useGetRole;
  const staffPermissions = {
    name: 'STAFF',
    permissions: { PROMPTS: { USE: true, CREATE: false } },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('calls useGetRole with the custom role name and enabled: true for custom role users', () => {
    jest.useFakeTimers();

    renderProviderLive();

    const [, refreshOptions] = mockRefreshMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (data: unknown) => void },
    ];

    act(() => {
      refreshOptions.onSuccess({ user: { id: '1', role: 'STAFF' }, token: 'tok' });
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });

    const staffCalls = mockUseGetRole.mock.calls.filter(([name]: [string]) => name === 'STAFF');
    expect(staffCalls.length).toBeGreaterThan(0);
    const lastStaffCall = staffCalls[staffCalls.length - 1];
    expect(lastStaffCall[1]).toEqual(expect.objectContaining({ enabled: true }));

    jest.useRealTimers();
  });

  it('calls useGetRole with enabled: false for USER role users', () => {
    jest.useFakeTimers();

    renderProviderLive();

    const [, refreshOptions] = mockRefreshMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (data: unknown) => void },
    ];

    act(() => {
      refreshOptions.onSuccess({ user: { id: '1', role: 'USER' }, token: 'tok' });
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });

    const sentinelCalls = mockUseGetRole.mock.calls.filter(([name]: [string]) => name === '_');
    expect(sentinelCalls.length).toBeGreaterThan(0);
    for (const call of sentinelCalls) {
      expect(call[1]).toEqual(expect.objectContaining({ enabled: false }));
    }

    jest.useRealTimers();
  });

  it('calls useGetRole with enabled: false for ADMIN role users', () => {
    jest.useFakeTimers();

    renderProviderLive();

    const [, refreshOptions] = mockRefreshMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (data: unknown) => void },
    ];

    act(() => {
      refreshOptions.onSuccess({ user: { id: '1', role: 'ADMIN' }, token: 'tok' });
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });

    const sentinelCalls = mockUseGetRole.mock.calls.filter(([name]: [string]) => name === '_');
    expect(sentinelCalls.length).toBeGreaterThan(0);
    for (const call of sentinelCalls) {
      expect(call[1]).toEqual(expect.objectContaining({ enabled: false }));
    }

    jest.useRealTimers();
  });

  it('includes custom role data in the roles context map when loaded', () => {
    jest.useFakeTimers();
    mockUseGetRole.mockImplementation((name: string, opts?: { enabled?: boolean }) => {
      if (name === 'STAFF' && opts?.enabled) {
        return { data: staffPermissions };
      }
      return { data: null };
    });

    const { getByTestId } = renderProviderLive();

    const [, refreshOptions] = mockRefreshMutate.mock.calls[0] as [
      unknown,
      { onSuccess: (data: unknown) => void },
    ];

    act(() => {
      refreshOptions.onSuccess({ user: { id: '1', role: 'STAFF' }, token: 'tok' });
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });

    const rolesAttr = getByTestId('consumer').getAttribute('data-roles') ?? '{}';
    const roles = JSON.parse(rolesAttr);
    expect(roles).toHaveProperty('STAFF');
    expect(roles.STAFF).toEqual(staffPermissions);

    mockUseGetRole.mockReturnValue({ data: null });
    jest.useRealTimers();
  });
});
