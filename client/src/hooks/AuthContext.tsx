import {
  useRef,
  useMemo,
  useState,
  useEffect,
  useContext,
  useCallback,
  createContext,
} from 'react';
import { debounce } from 'lodash';
import { useNavigate } from 'react-router-dom';
import { getDefaultStore, useAtom } from 'jotai';
import { useQueryClient } from '@tanstack/react-query';
import { useRecoilState, useSetRecoilState } from 'recoil';
import {
  apiBaseUrl,
  ErrorTypes,
  SystemRoles,
  setTokenHeader,
  isSystemRoleName,
  buildLoginRedirectUrl,
  dataService,
  request,
  enrollBrowserSession,
  isBrowserSessionEntry,
  browserSessionErrorCode,
  BROWSER_SESSION_MARKER,
  BROWSER_SESSION_EVENT,
} from 'librechat-data-provider';
import type * as t from 'librechat-data-provider';
import type { ReactNode } from 'react';
import {
  isSafeRedirect,
  getPostLoginRedirect,
  dropStoredRedirect,
  readStoredRedirect,
  clearComposerDraftStorage,
  clearRetainedFileDeletions,
  openFileDeletionRetention,
} from '~/utils';
import {
  useGetRole,
  useGetUserQuery,
  useLoginUserMutation,
  useLogoutUserMutation,
  useRefreshTokenMutation,
} from '~/data-provider';
import BrowserSession, { browserSessionState } from '~/components/Auth/BrowserSession';
import { resetChatFilterSessionAtom } from '~/components/Conversations/chatFilters';
import { TAuthConfig, TUserContext, TAuthContext, TResError } from '~/common';
import useClearStates from '~/hooks/Config/useClearStates';
import useTimeout from './useTimeout';
import store from '~/store';

const AuthContext = (import.meta.hot?.data?.__AuthContext ??
  createContext<TAuthContext | undefined>(undefined)) as React.Context<TAuthContext | undefined>;
if (import.meta.hot) {
  import.meta.hot.data.__AuthContext = AuthContext;
}

/** Client state belonging to the session that is ending. Drafts go out with the retained
 * deletions rather than being left to the next sign-in: a social sign-in returns through the
 * silent refresh and never passes the login mutation that clears them, and the browser tab keeps
 * its identity across an in-app account switch, so the account on the way out is the only place
 * that reliably sees the transition. Both are cleared together so neither can be added to an exit
 * path the other was wired into. */
const endSessionClientState = (): void => {
  getDefaultStore().set(resetChatFilterSessionAtom);
  clearRetainedFileDeletions();
  clearComposerDraftStorage();
};

const AuthContextProvider = ({
  authConfig,
  children,
}: {
  authConfig?: TAuthConfig;
  children: ReactNode;
}) => {
  const isExternalRedirectRef = useRef(false);
  const queryClient = useQueryClient();
  const clearStates = useClearStates();
  const [browserState, setBrowserStateAtom] = useAtom(browserSessionState);
  const browserStateRef = useRef<string | null>(null);
  const setBrowserState = useCallback(
    (value: string | null) => {
      browserStateRef.current = value;
      setBrowserStateAtom(value);
    },
    [setBrowserStateAtom],
  );
  const [user, setUser] = useRecoilState(store.user);
  const logoutRedirectRef = useRef<string | undefined>(undefined);
  const [token, setToken] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isAuthReady, setIsAuthReady] = useState<boolean>(authConfig?.test === true);
  const setQueriesEnabled = useSetRecoilState<boolean>(store.queriesEnabled);

  const userRoleName = user?.role ?? '';
  const isCustomRole = isAuthenticated && !!user?.role && !isSystemRoleName(user.role);

  const { data: userRole = null } = useGetRole(SystemRoles.USER, {
    enabled: !!(isAuthenticated && (user?.role ?? '')),
  });
  const { data: adminRole = null } = useGetRole(SystemRoles.ADMIN, {
    enabled: !!(isAuthenticated && user?.role === SystemRoles.ADMIN),
  });
  const { data: customRole = null } = useGetRole(isCustomRole ? userRoleName : '_', {
    enabled: isCustomRole,
  });

  const navigate = useNavigate();

  const setUserContext = useMemo(
    () =>
      debounce((userContext: TUserContext) => {
        const { token, isAuthenticated, user, redirect } = userContext;
        setUser(user);
        setToken(token);
        setTokenHeader(token);
        setIsAuthenticated(isAuthenticated);
        setIsAuthReady(true);
        if (isAuthenticated) {
          setQueriesEnabled(true);
          /** The clear on the way out latches retention shut so a DELETE that settles afterwards
           * cannot write the departing account's payload back in. This is the only place that
           * knows a new session exists to reopen it for. */
          openFileDeletionRetention();
        } else {
          /** Cleanup still queued from a failed delete belongs to the account that uploaded
           * those files, and losing the session passes through here every way it can happen: the
           * explicit logout, a silent refresh that comes back empty, and a failed user query.
           * Carrying the queue across would retry it under whoever signs in next, which the
           * ownership check rejects forever instead of cleaning anything up. */
          endSessionClientState();
        }

        const searchParams = new URLSearchParams(window.location.search);
        const postLoginRedirect = getPostLoginRedirect(searchParams);

        const logoutRedirect = logoutRedirectRef.current;
        logoutRedirectRef.current = undefined;

        const finalRedirect =
          logoutRedirect ??
          postLoginRedirect ??
          (redirect && isSafeRedirect(redirect) ? redirect : null);

        if (finalRedirect == null) {
          return;
        }

        navigate(finalRedirect, { replace: true });
      }, 50),
    [navigate, setUser, setQueriesEnabled],
  );
  const doSetError = useTimeout({ callback: (error) => setError(error as string | undefined) });

  const loginUser = useLoginUserMutation({
    onSuccess: (data: t.TLoginResponse) => {
      const { user, token, twoFAPending, tempToken } = data;
      if (twoFAPending) {
        navigate(`/login/2fa?tempToken=${tempToken}`, { replace: true });
        return;
      }
      setBrowserState(null);
      setError(undefined);
      setUserContext({ token, isAuthenticated: true, user, redirect: '/c/new' });
    },
    onError: (error: TResError | unknown) => {
      const resError = error as TResError;
      const code = resError.response?.data?.code;
      doSetError(code === ErrorTypes.AUTH_CROSS_ORIGIN ? code : resError.message);
      // Preserve a valid redirect_to across login failures so the deep link survives retries.
      // Cannot use buildLoginRedirectUrl() here — it reads the current pathname (already /login)
      // and would return plain /login, dropping the redirect_to destination.
      const redirectTo = new URLSearchParams(window.location.search).get('redirect_to');
      const loginPath =
        redirectTo && isSafeRedirect(redirectTo)
          ? `/login?redirect_to=${encodeURIComponent(redirectTo)}`
          : '/login';
      navigate(loginPath, { replace: true });
    },
  });
  const logoutUser = useLogoutUserMutation({
    onSuccess: (data) => {
      if (data.redirect) {
        /** data.redirect is the IdP's end_session_endpoint URL: an absolute URL generated
         * server-side from trusted IdP metadata (not user input), so isSafeRedirect is bypassed.
         * setUserContext is debounced (50ms) and won't fire before page unload, so clear the
         * axios Authorization header and deletion state synchronously to prevent in-flight requests. */
        isExternalRedirectRef.current = true;
        setTokenHeader(undefined);
        endSessionClientState();
        window.location.replace(data.redirect);
        return;
      }
      endSessionClientState();
      setUserContext({
        token: undefined,
        isAuthenticated: false,
        user: undefined,
        redirect: '/login',
      });
    },
    onError: (error) => {
      endSessionClientState();
      doSetError((error as Error).message);
      setUserContext({
        token: undefined,
        isAuthenticated: false,
        user: undefined,
        redirect: '/login',
      });
    },
  });
  const refreshToken = useRefreshTokenMutation();

  const logout = useCallback(
    (redirect?: string) => {
      if (user?.provider === 'browser') {
        void request
          .resetBrowser()
          .then(async () => {
            localStorage.setItem(BROWSER_SESSION_MARKER, 'paused');
            setTokenHeader(undefined);
            setQueriesEnabled(false);
            endSessionClientState();
            await queryClient.cancelQueries();
            await clearStates();
            queryClient.removeQueries();
            setBrowserState('BROWSER_SESSION_FORGOTTEN');
            setUserContext({ token: undefined, user: undefined, isAuthenticated: false });
          })
          .catch(() => {
            setBrowserState('BROWSER_SESSION_UNAVAILABLE');
          });
        return;
      }
      if (redirect) {
        logoutRedirectRef.current = redirect;
      }
      logoutUser.mutate(undefined);
    },
    [
      logoutUser,
      user?.provider,
      queryClient,
      clearStates,
      setQueriesEnabled,
      setUserContext,
      setBrowserState,
    ],
  );

  const userQuery = useGetUserQuery({ enabled: !!(token ?? '') });

  const login = (data: t.TLoginUser) => {
    loginUser.mutate(data);
  };

  const silentRefresh = useCallback(() => {
    if (browserStateRef.current && isBrowserSessionEntry(window.location.pathname, apiBaseUrl())) {
      return;
    }
    if (authConfig?.test === true) {
      return;
    }
    if (isExternalRedirectRef.current) {
      return;
    }
    refreshToken.mutate(undefined, {
      onSuccess: async (data: t.TRefreshTokenResponse | undefined) => {
        if (isExternalRedirectRef.current) {
          return;
        }
        if (
          !data?.token &&
          authConfig?.optional !== true &&
          isBrowserSessionEntry(window.location.pathname, apiBaseUrl())
        ) {
          try {
            const config = await queryClient.fetchQuery({
              queryKey: ['startupConfig', false, 'default'],
              queryFn: () => dataService.getStartupConfig(),
            });
            if (config.browserSessionEnabled) {
              setBrowserState('busy');
              data = await enrollBrowserSession({
                refresh: request.refreshToken,
                enroll: request.enrollBrowser,
              });
              setBrowserState(null);
            }
          } catch (error) {
            setBrowserState(browserSessionErrorCode(error) ?? 'BROWSER_SESSION_UNAVAILABLE');
            setIsAuthReady(true);
            return;
          }
        }
        const { user, token = '' } = data ?? {};
        if (token) {
          setBrowserState(null);
          const storedRedirect = readStoredRedirect();
          dropStoredRedirect();
          const baseUrl = apiBaseUrl();
          const rawPath = window.location.pathname;
          const strippedPath =
            baseUrl && (rawPath === baseUrl || rawPath.startsWith(baseUrl + '/'))
              ? rawPath.slice(baseUrl.length) || '/'
              : rawPath;
          const currentUrl = `${strippedPath}${window.location.search}`;
          const fallbackRedirect = isSafeRedirect(currentUrl) ? currentUrl : '/c/new';
          const redirect =
            storedRedirect && isSafeRedirect(storedRedirect) ? storedRedirect : fallbackRedirect;
          setUserContext({ user, token, isAuthenticated: true, redirect });
          return;
        }
        console.log('Token is not present. User is not authenticated.');
        endSessionClientState();
        setIsAuthReady(true);
        if (authConfig?.test === true) {
          return;
        }
        if (authConfig?.optional !== true) {
          navigate(buildLoginRedirectUrl());
        }
      },
      onError: (error) => {
        if (isExternalRedirectRef.current) {
          return;
        }
        const browserCode = browserSessionErrorCode(error);
        if (browserCode) {
          setBrowserState(browserCode);
          setIsAuthReady(true);
          return;
        }
        console.log('refreshToken mutation error:', error);
        endSessionClientState();
        setIsAuthReady(true);
        if (authConfig?.test === true) {
          return;
        }
        if (authConfig?.optional !== true) {
          navigate(buildLoginRedirectUrl());
        }
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are stable at mount; adding refreshToken causes infinite re-fire
  }, []);

  useEffect(() => {
    if (authConfig?.optional === true) {
      return;
    }
    const recovery = (event: Event) => {
      setBrowserState((event as CustomEvent<string>).detail);
      setQueriesEnabled(false);
    };
    const changed = (event: StorageEvent) => {
      if (
        event.key !== BROWSER_SESSION_MARKER ||
        event.newValue !== 'paused' ||
        user?.provider !== 'browser'
      ) {
        return;
      }
      setTokenHeader(undefined);
      setQueriesEnabled(false);
      endSessionClientState();
      setBrowserState('BROWSER_SESSION_FORGOTTEN');
      setUserContext({ token: undefined, user: undefined, isAuthenticated: false });
      void queryClient.cancelQueries().then(async () => {
        await clearStates();
        queryClient.removeQueries();
      });
    };
    window.addEventListener(BROWSER_SESSION_EVENT, recovery);
    window.addEventListener('storage', changed);
    return () => {
      window.removeEventListener(BROWSER_SESSION_EVENT, recovery);
      window.removeEventListener('storage', changed);
    };
  }, [
    authConfig?.optional,
    user?.provider,
    clearStates,
    queryClient,
    setBrowserState,
    setQueriesEnabled,
    setUserContext,
  ]);

  useEffect(() => {
    if (isExternalRedirectRef.current) {
      return;
    }
    if (userQuery.data) {
      setUser(userQuery.data);
    } else if (userQuery.isError) {
      const browserCode = browserSessionErrorCode(userQuery.error);
      if (
        authConfig?.optional !== true &&
        isBrowserSessionEntry(window.location.pathname, apiBaseUrl()) &&
        (browserCode || user?.provider === 'browser')
      ) {
        setBrowserState(browserCode ?? browserStateRef.current ?? 'BROWSER_SESSION_UNAVAILABLE');
        setQueriesEnabled(false);
        setIsAuthReady(true);
        return;
      }
      endSessionClientState();
      doSetError((userQuery.error as Error).message);
      setIsAuthReady(true);
      if (authConfig?.optional !== true) {
        navigate(buildLoginRedirectUrl(), { replace: true });
      }
    }
    if (error != null && error && isAuthenticated) {
      doSetError(undefined);
    }
    if (token == null || !token || !isAuthenticated) {
      silentRefresh();
    }
    /** `doSetError` is `useTimeout`'s inner closure, rebuilt every render, and this effect calls
     * `silentRefresh`: depending on it would re-fire the refresh mutation on every render. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    token,
    isAuthenticated,
    userQuery.data,
    userQuery.isError,
    userQuery.error,
    error,
    setUser,
    navigate,
    silentRefresh,
    setUserContext,
  ]);

  useEffect(() => {
    const handleTokenUpdate = (event: CustomEvent<string>) => {
      console.log('tokenUpdated event received event');
      setUserContext({
        token: event.detail,
        isAuthenticated: true,
        user: user,
      });
    };

    window.addEventListener('tokenUpdated', handleTokenUpdate as EventListener);

    return () => {
      window.removeEventListener('tokenUpdated', handleTokenUpdate as EventListener);
    };
  }, [setUserContext, user]);

  const memoedValue = useMemo(
    () => ({
      user,
      token,
      error,
      login,
      logout,
      setError,
      roles: {
        [SystemRoles.USER]: userRole,
        [SystemRoles.ADMIN]: adminRole,
        ...(isCustomRole && customRole ? { [userRoleName]: customRole } : {}),
      },
      isAuthenticated,
      isAuthReady,
    }),

    /** `login` is a plain function rebuilt every render, so depending on it would rebuild this
     * context value every render and re-render every consumer of auth state. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      user,
      error,
      isAuthenticated,
      isAuthReady,
      token,
      userRole,
      adminRole,
      isCustomRole,
      userRoleName,
      customRole,
    ],
  );

  return (
    <AuthContext.Provider value={memoedValue}>
      {browserState &&
      authConfig?.optional !== true &&
      isBrowserSessionEntry(window.location.pathname, apiBaseUrl()) ? (
        <BrowserSession code={browserState} onState={setBrowserState} />
      ) : (
        children
      )}
    </AuthContext.Provider>
  );
};

const useAuthContext = () => {
  const context = useContext(AuthContext);

  if (context === undefined) {
    throw new Error('useAuthContext should be used inside AuthProvider');
  }

  return context;
};

export { AuthContextProvider, useAuthContext, AuthContext };
