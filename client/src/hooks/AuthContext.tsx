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
  clearTwoFactorSetupToken,
  persistTwoFactorSetupToken,
  TWO_FACTOR_FEDERATED_LOGIN_BLOCKED_CODE,
} from 'librechat-data-provider';
import type * as t from 'librechat-data-provider';
import type { ReactNode } from 'react';
import {
  isSafeRedirect,
  getPostLoginRedirect,
  clearPostLoginRedirect,
  persistRedirectToSession,
  clearComposerDraftStorage,
  clearRetainedFileDeletions,
  openFileDeletionRetention,
  isRequiredTwoFactorSetupRoute,
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
import { resetFacetsAtom } from '~/components/Conversations/facets';
import { GuestEmailEntry } from '~/components/Auth/EmailCodeLogin';
import useClearStates from '~/hooks/Config/useClearStates';
import useAuthMode from '~/hooks/Auth/useAuthMode';
import useLocalize from '~/hooks/useLocalize';
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
  getDefaultStore().set(resetFacetsAtom);
  clearRetainedFileDeletions();
  clearComposerDraftStorage();
};

/** Consumers abort active work synchronously and fence late callbacks with this tab-local value. */
const notifySessionEnding = (generation: number): void => {
  window.dispatchEvent(
    new CustomEvent('librechat:auth-session-ending', { detail: { generation } }),
  );
};
/**
 * Only recognized codes override the HTTP status used by the login error translation.
 */
const getLoginErrorText = (error: TResError): string | undefined => {
  const code = error?.response?.data?.code;
  return code === ErrorTypes.AUTH_CROSS_ORIGIN || code === TWO_FACTOR_FEDERATED_LOGIN_BLOCKED_CODE
    ? code
    : error?.message;
};

const AuthContextProvider = ({
  authConfig,
  children,
}: {
  authConfig?: TAuthConfig;
  children: ReactNode;
}) => {
  const isExternalRedirectRef = useRef(false);
  const sessionGeneration = useRef(0);
  const refreshPending = useRef(false);
  const authMode = useAuthMode(authConfig?.test !== true);
  const localize = useLocalize();
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
  const [logoutFailure, setLogoutFailure] = useState(false);
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
          /**
           * Any accepted full-auth response supersedes a staged enrollment, whichever path minted
           * it. The setup endpoints trust the stored bearer independently of the session, so a
           * token left behind here would let this user finish the previous one's enrollment.
           */
          clearTwoFactorSetupToken();
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

        const logoutRedirect = logoutRedirectRef.current;
        logoutRedirectRef.current = undefined;

        /** Callers resolve the post-login destination, so it is consumed exactly once per sign-in. */
        const finalRedirect =
          logoutRedirect ?? (redirect && isSafeRedirect(redirect) ? redirect : null);

        if (finalRedirect == null) {
          return;
        }

        navigate(finalRedirect, { replace: true });
      }, 50),
    [navigate, setUser, setQueriesEnabled],
  );
  useEffect(() => () => setUserContext.cancel(), [setUserContext]);

  const setErrorAfterTimeout = useCallback(
    (error: string | number | boolean | null) => setError(error as string | undefined),
    [],
  );
  const doSetError = useTimeout({ callback: setErrorAfterTimeout });

  const { mutate: loginMutate } = useLoginUserMutation({
    onSuccess: (data: t.TLoginResponse) => {
      const { user, token, twoFAPending, twoFASetupRequired, tempToken } = data;
      /**
       * A sign-in supersedes whatever enrollment the tab was holding. An abandoned setup token
       * outlives the screen that staged it, so leaving it here would let the next visitor to the
       * setup route finish the previous user's enrollment and take the tab as them.
       */
      clearTwoFactorSetupToken();
      if (twoFASetupRequired) {
        const redirectTo = new URLSearchParams(window.location.search).get('redirect_to');
        if (redirectTo) {
          persistRedirectToSession(redirectTo);
        }
        persistTwoFactorSetupToken(tempToken ?? '');
        navigate('/login/2fa/setup', { replace: true });
        return;
      }
      if (twoFAPending) {
        navigate(`/login/2fa?tempToken=${tempToken}`, { replace: true });
        return;
      }
      setBrowserState(null);
      setError(undefined);
      const redirect =
        getPostLoginRedirect(new URLSearchParams(window.location.search)) ?? '/c/new';
      setUserContext({ token, isAuthenticated: true, user, redirect });
    },
    onError: (error: TResError | unknown) => {
      clearTwoFactorSetupToken();
      doSetError(getLoginErrorText(error as TResError));
      // Preserve a valid redirect_to across login failures so the deep link survives retries.
      // Cannot use buildLoginRedirectUrl() here: it reads the current pathname (already /login)
      // and would return plain /login, dropping the redirect_to destination.
      const redirectTo = new URLSearchParams(window.location.search).get('redirect_to');
      const loginPath =
        redirectTo && isSafeRedirect(redirectTo)
          ? `/login?redirect_to=${encodeURIComponent(redirectTo)}`
          : '/login';
      navigate(loginPath, { replace: true });
    },
  });
  const { mutate: logoutMutate } = useLogoutUserMutation({
    onSuccess: (data) => {
      setLogoutFailure(false);
      if (user?.provider === 'email_code') {
        void settleCortexSession('/login');
        return;
      }
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
      if (user?.provider === 'email_code') {
        // The server did not acknowledge revocation; keep the current identity and allow retry.
        setLogoutFailure(true);
        window.dispatchEvent(new CustomEvent('librechat:auth-session-continued'));
        return;
      }
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
      setLogoutFailure(false);
      sessionGeneration.current++;
      notifySessionEnding(sessionGeneration.current);
      clearPostLoginRedirect();
      clearTwoFactorSetupToken();
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
      logoutMutate(undefined);
    },
    [
      logoutMutate,
      user?.provider,
      queryClient,
      clearStates,
      setQueriesEnabled,
      setUserContext,
      setBrowserState,
    ],
  );

  /** A document boundary cancels old feeds/transfers and prevents late work reaching the new user. */
  const settleCortexSession = useCallback(
    async (destination: string) => {
      sessionGeneration.current++;
      notifySessionEnding(sessionGeneration.current);
      isExternalRedirectRef.current = true;
      setUserContext.cancel();
      setTokenHeader(undefined);
      setQueriesEnabled(false);
      endSessionClientState();
      setUser(undefined);
      setToken(undefined);
      setIsAuthenticated(false);
      // A rejected cleanup must not strand a page with the previous identity still mounted.
      await Promise.allSettled([queryClient.cancelQueries()]);
      await Promise.allSettled([clearStates()]);
      queryClient.removeQueries();
      try {
        localStorage.setItem('librechat.auth.revision', crypto.randomUUID());
      } catch {
        /* Storage may be disabled. */
      }
      window.location.assign(
        `${apiBaseUrl()}${isSafeRedirect(destination) ? destination : '/c/new'}`,
      );
    },
    [clearStates, queryClient, setQueriesEnabled, setUser, setUserContext],
  );

  const completeAuthentication = useCallback(
    async (authenticatedToken: string, authenticatedUser: t.TUser) => {
      const redirect =
        getPostLoginRedirect(new URLSearchParams(window.location.search)) ?? '/c/new';
      if (authenticatedUser.provider === 'email_code' || authenticatedUser.provider === 'browser') {
        clearTwoFactorSetupToken();
        setBrowserState(null);
        await settleCortexSession(redirect);
        return;
      }
      /** The enrollment credential has done its job; do not leave it live in the tab. */
      clearTwoFactorSetupToken();
      setUser(authenticatedUser);
      setToken(authenticatedToken);
      setTokenHeader(authenticatedToken);
      setIsAuthenticated(true);
      setIsAuthReady(true);
      setQueriesEnabled(true);
      openFileDeletionRetention();
      navigate(redirect, { replace: true });
    },
    [navigate, setQueriesEnabled, setUser, setBrowserState, settleCortexSession],
  );

  /**
   * The enrollment hand-off normally replaces the document, which discards the session it is
   * redirecting away from. Where session storage is blocked it has to keep the document instead,
   * so this provider stays mounted and that session survives: the user query stays enabled and
   * navigates to the login page the moment it fails, taking the user off the very screen the
   * server is demanding they complete. Land on the state a replaced document would have left, and
   * leave the setup token alone, since the in-memory mirror is then its only copy.
   */
  const clearAuthenticationForRedirect = useCallback(() => {
    sessionGeneration.current++;
    notifySessionEnding(sessionGeneration.current);
    endSessionClientState();
    setUser(undefined);
    setToken(undefined);
    setIsAuthenticated(false);
  }, [setUser]);

  const userQuery = useGetUserQuery({ enabled: !!(token ?? '') });

  const login = useCallback(
    (data: t.TLoginUser) => {
      loginMutate(data);
    },
    [loginMutate],
  );

  const silentRefresh = useCallback(() => {
    if (refreshPending.current) return;
    if (browserStateRef.current && isBrowserSessionEntry(window.location.pathname, apiBaseUrl())) {
      return;
    }
    if (authConfig?.test === true) {
      return;
    }
    if (isExternalRedirectRef.current) {
      return;
    }
    const generation = sessionGeneration.current;
    refreshPending.current = true;
    refreshToken.mutate(undefined, {
      onSettled: () => {
        refreshPending.current = false;
      },
      onSuccess: async (data: t.TRefreshTokenResponse | undefined) => {
        if (isExternalRedirectRef.current || generation !== sessionGeneration.current) {
          return;
        }
        if (
          !data?.token &&
          data?.twoFASetupRequired !== true &&
          authConfig?.optional !== true &&
          isBrowserSessionEntry(window.location.pathname, apiBaseUrl())
        ) {
          try {
            const config = await queryClient.fetchQuery({
              queryKey: ['startupConfig', false, 'default'],
              queryFn: () => dataService.getStartupConfig(),
            });
            if (generation !== sessionGeneration.current) return;
            if (config.browserSessionEnabled && (config.authMode ?? 'default') === 'default') {
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
        if (generation !== sessionGeneration.current || isExternalRedirectRef.current) return;
        const { user, token = '', twoFASetupRequired, tempToken } = data ?? {};
        if (twoFASetupRequired && tempToken) {
          persistTwoFactorSetupToken(tempToken);
          /**
           * Already on the setup route, reached by an enforcement redirect that parked the
           * destination in the query. Replacing the route again would drop that query, and the
           * route itself is not a safe redirect to bank, so enrollment would end at `/c/new`.
           */
          if (isRequiredTwoFactorSetupRoute()) {
            return;
          }
          const baseUrl = apiBaseUrl();
          const rawPath = window.location.pathname;
          const strippedPath =
            baseUrl && (rawPath === baseUrl || rawPath.startsWith(baseUrl + '/'))
              ? rawPath.slice(baseUrl.length) || '/'
              : rawPath;
          const currentUrl = `${strippedPath}${window.location.search}${window.location.hash}`;
          persistRedirectToSession(currentUrl);
          navigate('/login/2fa/setup', { replace: true });
          return;
        }
        if (token) {
          setBrowserState(null);
          const baseUrl = apiBaseUrl();
          const rawPath = window.location.pathname;
          const strippedPath =
            baseUrl && (rawPath === baseUrl || rawPath.startsWith(baseUrl + '/'))
              ? rawPath.slice(baseUrl.length) || '/'
              : rawPath;
          const currentUrl = `${strippedPath}${window.location.search}`;
          const fallbackRedirect = isSafeRedirect(currentUrl) ? currentUrl : '/c/new';
          const redirect =
            getPostLoginRedirect(new URLSearchParams(window.location.search)) ?? fallbackRedirect;
          setUserContext({ user, token, isAuthenticated: true, redirect });
          return;
        }
        console.log('Token is not present. User is not authenticated.');
        endSessionClientState();
        setIsAuthReady(true);
        if (authConfig?.test === true) {
          return;
        }
        if (isRequiredTwoFactorSetupRoute()) {
          return;
        }
        if (authConfig?.optional !== true) {
          navigate(buildLoginRedirectUrl());
        }
      },
      onError: (error) => {
        if (isExternalRedirectRef.current || generation !== sessionGeneration.current) {
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
        if (isRequiredTwoFactorSetupRoute()) {
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
    if (authMode.data?.authMode === 'default' || !authMode.data) return;
    const changed = (event: StorageEvent) => {
      if (event.key !== 'librechat.auth.revision') return;
      // Do not rebroadcast: the cookie selection is shared, but no identity is stored in this event.
      sessionGeneration.current++;
      notifySessionEnding(sessionGeneration.current);
      isExternalRedirectRef.current = true;
      setUserContext.cancel();
      setTokenHeader(undefined);
      setQueriesEnabled(false);
      endSessionClientState();
      void queryClient
        .cancelQueries()
        .then(() => clearStates())
        .finally(() => {
          queryClient.removeQueries();
          window.location.assign(`${apiBaseUrl()}/c/new`);
        });
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [authMode.data, clearStates, queryClient, setQueriesEnabled, setUserContext]);

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
    doSetError,
  ]);

  useEffect(() => {
    const handleTokenUpdate = (event: CustomEvent<string>) => {
      if (isExternalRedirectRef.current) {
        setTokenHeader(undefined);
        return;
      }
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

  useEffect(() => {
    const handleAuthRedirect = (event: CustomEvent<{ inDocument?: boolean }>) => {
      if (event.detail?.inDocument !== true) {
        return;
      }
      clearAuthenticationForRedirect();
    };

    window.addEventListener('authRedirectStarted', handleAuthRedirect as EventListener);

    return () => {
      window.removeEventListener('authRedirectStarted', handleAuthRedirect as EventListener);
    };
  }, [clearAuthenticationForRedirect]);

  const memoedValue = useMemo(
    () => ({
      user,
      token,
      error,
      login,
      logout,
      completeAuthentication,
      setError,
      roles: {
        [SystemRoles.USER]: userRole,
        [SystemRoles.ADMIN]: adminRole,
        ...(isCustomRole && customRole ? { [userRoleName]: customRole } : {}),
      },
      isAuthenticated,
      isAuthReady,
    }),

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
      login,
      logout,
      completeAuthentication,
    ],
  );

  const content =
    browserState &&
    authConfig?.optional !== true &&
    isBrowserSessionEntry(window.location.pathname, apiBaseUrl()) ? (
      <BrowserSession code={browserState} onState={setBrowserState} />
    ) : (
      children
    );
  return (
    <AuthContext.Provider value={memoedValue}>
      {logoutFailure ||
      (authMode.data?.authMode === 'transition' &&
        user?.provider === 'browser' &&
        isAuthenticated &&
        !browserState) ? (
        <div className="flex h-full min-h-0 flex-col">
          {logoutFailure && (
            <p role="alert" className="text-status-error-strong px-4 py-2 text-sm">
              {localize('com_auth_email_code_logout_failed')}
            </p>
          )}
          {authMode.data?.authMode === 'transition' &&
            user?.provider === 'browser' &&
            isAuthenticated &&
            !browserState && <GuestEmailEntry config={authMode.data} />}
          <div className="min-h-0 flex-1">{content}</div>
        </div>
      ) : (
        content
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
