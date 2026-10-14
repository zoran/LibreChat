import { atom } from 'jotai';
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
  const busy = code === 'busy';
  const canStart = code === 'BROWSER_SESSION_EXPIRED' || code === 'BROWSER_SESSION_FORGOTTEN';
  let messageKey:
    | 'com_auth_browser_expired'
    | 'com_auth_browser_unavailable'
    | 'com_auth_browser_unsupported' = 'com_auth_browser_unavailable';
  if (canStart) {
    messageKey = 'com_auth_browser_expired';
  } else if (code === 'BROWSER_SESSION_UNSUPPORTED') {
    messageKey = 'com_auth_browser_unsupported';
  }
  const start = async () => {
    if (!window.isSecureContext || !navigator.locks) {
      onState('BROWSER_SESSION_UNSUPPORTED');
      return;
    }
    onState('busy');
    try {
      await navigator.locks.request('librechat.browser.enrollment', async () => {
        await request.resetBrowser();
        localStorage.setItem(BROWSER_SESSION_MARKER, 'paused');
        await clearStates();
        await request.enrollBrowser();
        localStorage.setItem(BROWSER_SESSION_MARKER, 'active');
      });
      window.location.assign(`${apiBaseUrl()}/c/new`);
    } catch {
      onState('BROWSER_SESSION_UNAVAILABLE');
    }
  };
  if (authMode.data && authMode.data.authMode !== 'default')
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
        {busy ? (
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
