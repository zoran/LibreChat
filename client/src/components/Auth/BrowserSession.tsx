import { atom } from 'jotai';
import { Button, Spinner } from '@librechat/client';
import { apiBaseUrl, BROWSER_SESSION_MARKER, request } from 'librechat-data-provider';
import useClearStates from '~/hooks/Config/useClearStates';
import useLocalize from '~/hooks/useLocalize';

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
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-primary p-6">
      <section className="w-full max-w-md space-y-4 text-text-primary" aria-live="polite">
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
