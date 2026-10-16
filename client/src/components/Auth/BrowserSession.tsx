import { atom } from 'jotai';
import { useEffect, useRef } from 'react';
import { Button, Spinner } from '@librechat/client';
import { apiBaseUrl, BROWSER_SESSION_MARKER, request } from 'librechat-data-provider';
import useClearStates from '~/hooks/Config/useClearStates';
import useAuthMode from '~/hooks/Auth/useAuthMode';
import useLocalize from '~/hooks/useLocalize';
import EmailCodeLogin from './EmailCodeLogin';

/** Feature-owned recovery state; no authenticator or user identity is persisted here. */
export const browserSessionState = atom<string | null>(null);

export default function BrowserSession({
  code,
  onState,
}: {
  code: string;
  onState: (code: string) => void;
}) {
  const localize = useLocalize();
  const clearStates = useClearStates();
  const authMode = useAuthMode();
  const confirmedMode =
    authMode.isSuccess && !authMode.isError ? authMode.data?.authMode : undefined;
  const defaultMode = useRef(false);
  defaultMode.current = confirmedMode === 'default';
  useEffect(() => {
    defaultMode.current = confirmedMode === 'default';
    return () => {
      defaultMode.current = false;
    };
  }, [confirmedMode]);
  const busy = code === 'busy';
  const canStart =
    confirmedMode === 'default' &&
    (code === 'BROWSER_SESSION_EXPIRED' || code === 'BROWSER_SESSION_FORGOTTEN');
  let messageKey:
    | 'com_auth_browser_expired'
    | 'com_auth_browser_unavailable'
    | 'com_auth_browser_unsupported' = 'com_auth_browser_unavailable';
  if (canStart) {
    messageKey = 'com_auth_browser_expired';
  } else if (confirmedMode === 'default' && code === 'BROWSER_SESSION_UNSUPPORTED') {
    messageKey = 'com_auth_browser_unsupported';
  }
  const start = async () => {
    if (!defaultMode.current || !canStart) return;
    if (!window.isSecureContext || !navigator.locks) {
      onState('BROWSER_SESSION_UNSUPPORTED');
      return;
    }
    onState('busy');
    try {
      const enrolled = await navigator.locks.request('librechat.browser.enrollment', async () => {
        if (!defaultMode.current) return false;
        await request.resetBrowser();
        if (!defaultMode.current) return false;
        localStorage.setItem(BROWSER_SESSION_MARKER, 'paused');
        await clearStates();
        if (!defaultMode.current) return false;
        await request.enrollBrowser();
        if (!defaultMode.current) return false;
        localStorage.setItem(BROWSER_SESSION_MARKER, 'active');
        return true;
      });
      if (enrolled && defaultMode.current) window.location.assign(`${apiBaseUrl()}/c/new`);
    } catch {
      onState('BROWSER_SESSION_UNAVAILABLE');
    }
  };
  if (authMode.data && (confirmedMode === 'email_code' || confirmedMode === 'transition'))
    return (
      <main className="bg-surface-primary flex min-h-screen items-center justify-center p-6">
        <div className="text-text-primary w-full max-w-md">
          <EmailCodeLogin config={authMode.data} />
        </div>
      </main>
    );
  return (
    <main className="bg-surface-primary flex min-h-screen items-center justify-center p-6">
      <section className="text-text-primary w-full max-w-md space-y-4" aria-live="polite">
        <h1 className="text-xl font-semibold">{localize('com_auth_browser_title')}</h1>
        {authMode.isLoading || (busy && confirmedMode === 'default') ? (
          <Spinner />
        ) : (
          <>
            <p>{localize(messageKey)}</p>
            {canStart && <Button onClick={start}>{localize('com_auth_browser_new')}</Button>}
            <Button variant="outline" onClick={() => window.location.reload()}>
              {localize('com_ui_retry')}
            </Button>
          </>
        )}
      </section>
    </main>
  );
}
