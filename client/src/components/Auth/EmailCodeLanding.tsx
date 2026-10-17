import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Spinner } from '@librechat/client';
import type { TLoginResponse } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { emailCodeRequest } from '~/hooks/Auth/useAuthMode';
import { emailCodeLink } from '~/common/emailCodeLink';
import AuthLayout from '~/components/Auth/AuthLayout';
import { useGetStartupConfig } from '~/data-provider';
import { useAuthContext } from '~/hooks/AuthContext';
import useLocalize from '~/hooks/useLocalize';

/** Share the branded auth shell while retaining this link's explicit account-switch confirmation. */
export default function EmailCodeLanding() {
  const localize = useLocalize();
  const { data: startupConfig, isFetching, error: startupConfigError } = useGetStartupConfig();
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
  let content: ReactNode;
  if (invalid || unavailable) {
    content = (
      <p role="alert" className="text-status-error-strong text-sm leading-6">
        {localize(invalid ? 'com_auth_email_link_invalid' : 'com_auth_email_link_unavailable')}
      </p>
    );
  } else if (auth.authResolution.status === 'pending' || state === 'working') {
    content = (
      <div
        role="status"
        className="text-text-secondary flex items-center justify-center gap-3 text-sm leading-6"
      >
        <Spinner className="shrink-0" />
        <p>{localize('com_auth_email_link_working')}</p>
      </div>
    );
  } else {
    content = (
      <>
        <p className="text-text-secondary text-sm leading-6">
          {localize(
            needsConfirmation ? 'com_auth_email_link_switch' : 'com_auth_email_link_confirm',
          )}
        </p>
        <Button className="w-full" onClick={() => void redeem()}>
          {localize('com_auth_email_link_continue')}
        </Button>
      </>
    );
  }
  return (
    <AuthLayout
      header={localize('com_auth_email_link_title')}
      isFetching={isFetching}
      startupConfig={startupConfig}
      startupConfigError={startupConfigError}
      pathname="/login/email-code"
      error={null}
    >
      <div className="text-text-primary space-y-4 text-center">
        {content}
        {(invalid || unavailable) && (
          <div className="space-y-4">
            <p className="text-text-secondary text-sm leading-6">
              {localize('com_auth_email_link_browser')}
            </p>
            <Button asChild variant="outline" className="w-full">
              <Link to="/login">{localize('com_auth_email_link_new')}</Link>
            </Button>
          </div>
        )}
      </div>
    </AuthLayout>
  );
}
