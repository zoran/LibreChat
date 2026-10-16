import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { TLoginResponse } from 'librechat-data-provider';
import { useAuthContext } from '~/hooks/AuthContext';
import { emailCodeRequest } from '~/hooks/Auth/useAuthMode';
import { emailCodeLink } from '~/common/emailCodeLink';
import useLocalize from '~/hooks/useLocalize';

export default function EmailCodeLanding() {
  const localize = useLocalize();
  const auth = useAuthContext();
  const current = useRef(auth);
  current.current = auth;
  const attempted = useRef(false);
  const [state, setState] = useState<'idle' | 'working' | 'invalid'>('idle');
  const needsConfirmation = auth.isAuthenticated && auth.user?.provider !== 'browser';
  const redeem = useCallback(async () => {
    const context = current.current;
    const generation = context.authResolution.generation;
    if (
      attempted.current ||
      !emailCodeLink ||
      context.authResolution.status !== 'resolved' ||
      !context.isAuthGenerationCurrent(generation)
    )
      return;
    attempted.current = true;
    setState('working');
    try {
      const response = await emailCodeRequest<TLoginResponse>('email-code/verify', {
        attemptId: emailCodeLink.attemptId,
        code: emailCodeLink.code,
      });
      if (
        !current.current.isAuthGenerationCurrent(generation) ||
        current.current.authResolution.status !== 'resolved'
      )
        return setState('invalid');
      if (!response.token || !response.user) return setState('invalid');
      await current.current.completeAuthentication(response.token, response.user);
    } catch {
      setState('invalid');
    }
  }, []);
  useEffect(() => {
    if (emailCodeLink?.activated && auth.authResolution.status === 'resolved' && !needsConfirmation)
      void redeem();
  }, [auth.authResolution, needsConfirmation, redeem]);
  const unavailable = auth.authResolution.status === 'unavailable';
  const invalid = !emailCodeLink || state === 'invalid';
  return (
    <main className="mx-auto max-w-md space-y-4 p-6" aria-labelledby="email-link-title">
      <h1 id="email-link-title">{localize('com_auth_email_link_title')}</h1>
      {invalid ? (
        <p role="alert">{localize('com_auth_email_link_invalid')}</p>
      ) : unavailable ? (
        <p role="alert">{localize('com_auth_email_link_unavailable')}</p>
      ) : auth.authResolution.status === 'pending' || state === 'working' ? (
        <p role="status">{localize('com_auth_email_link_working')}</p>
      ) : (
        <>
          <p>
            {localize(
              needsConfirmation ? 'com_auth_email_link_switch' : 'com_auth_email_link_confirm',
            )}
          </p>
          <button className="btn btn-primary" onClick={() => void redeem()}>
            {localize('com_auth_email_link_continue')}
          </button>
        </>
      )}
      {(invalid || unavailable) && (
        <>
          <p>{localize('com_auth_email_link_browser')}</p>
          <Link to="/login">{localize('com_auth_email_link_new')}</Link>
        </>
      )}
    </main>
  );
}
