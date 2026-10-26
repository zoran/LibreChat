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

/** Redeem real email clicks automatically, preserving the current session until verification succeeds. */
export default function EmailCodeLanding() {
  const localize = useLocalize();
  const { data: startupConfig, isFetching, error: startupConfigError } = useGetStartupConfig();
  const auth = useAuthContext();
  const current = useRef(auth);
  current.current = auth;
  const attempted = useRef(false);
  const [state, setState] = useState<'idle' | 'working' | 'invalid'>('idle');
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
        ...(emailCodeLink.linkProof ? { linkProof: emailCodeLink.linkProof } : {}),
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
    if (emailCodeLink?.activated && auth.authResolution.status === 'resolved') void redeem();
  }, [auth.authResolution, redeem]);
  const unavailable = auth.authResolution.status === 'unavailable';
  const invalid = !emailCodeLink || state === 'invalid';
  let content: ReactNode;
  if (invalid || unavailable) {
    content = (
      <p role="alert" className="text-status-error text-sm leading-6">
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
          {localize('com_auth_email_link_confirm')}
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
            {!auth.isAuthenticated && !emailCodeLink?.linkProof && (
              <p className="text-text-secondary text-sm leading-6">
                {localize('com_auth_email_link_browser')}
              </p>
            )}
            <Button asChild variant="outline" className="w-full">
              <Link to={auth.isAuthenticated ? '/c/new' : '/login'}>
                {localize(auth.isAuthenticated ? 'com_ui_continue' : 'com_auth_email_link_new')}
              </Link>
            </Button>
          </div>
        )}
      </div>
    </AuthLayout>
  );
}
