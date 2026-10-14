import { useEffect, useId, useRef, useState } from 'react';
import {
  Button,
  Input,
  Spinner,
  OGDialog,
  OGDialogTrigger,
  OGDialogContent,
  OGDialogHeader,
  OGDialogTitle,
  OGDialogDescription,
} from '@librechat/client';
import type {
  EmailCodeConfig,
  EmailCodeChallengeResponse,
  TLoginResponse,
} from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { emailCodeRequest, EmailCodeRequestError } from '~/hooks/Auth/useAuthMode';
import { useAuthContext } from '~/hooks/AuthContext';
import useLocalize from '~/hooks/useLocalize';

const errorKeys: Record<string, TranslationKeys> = {
  EMAIL_CODE_INVALID: 'com_auth_email_code_invalid',
  EMAIL_CODE_INVALID_REQUEST: 'com_auth_email_code_invalid_email',
  EMAIL_CODE_DOMAIN_NOT_ALLOWED: 'com_auth_email_code_domain',
  EMAIL_CODE_THROTTLED: 'com_auth_email_code_throttled',
  EMAIL_CODE_ACCOUNT_CONFLICT: 'com_auth_email_code_account_conflict',
  BROWSER_SESSION_EXPIRED: 'com_auth_browser_expired',
};

export default function EmailCodeLogin({
  config,
  emailOnly = false,
  onComplete,
}: {
  config: EmailCodeConfig;
  emailOnly?: boolean;
  onComplete?: () => void;
}) {
  const localize = useLocalize();
  const { completeAuthentication } = useAuthContext();
  const [step, setStep] = useState<'choice' | 'email'>(
    emailOnly || config.authMode === 'email_code' ? 'email' : 'choice',
  );
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<EmailCodeChallengeResponse>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TranslationKeys>();
  const [guestExpired, setGuestExpired] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const generation = useRef(0);
  const controller = useRef<AbortController>();
  const codeInput = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(
    () => () => {
      generation.current++;
      controller.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!challenge) return;
    codeInput.current?.focus();
    const update = () =>
      setSeconds(Math.max(0, Math.ceil((Date.parse(challenge.resendAt) - Date.now()) / 1000)));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [challenge]);

  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    if (busy) return;
    const current = ++generation.current;
    controller.current?.abort();
    controller.current = new AbortController();
    setBusy(true);
    setError(undefined);
    try {
      await action(controller.current.signal);
    } catch (cause) {
      if (current !== generation.current || controller.current.signal.aborted) return;
      const key =
        cause instanceof EmailCodeRequestError &&
        Object.prototype.hasOwnProperty.call(errorKeys, cause.code)
          ? errorKeys[cause.code]
          : undefined;
      if (cause instanceof EmailCodeRequestError && cause.code === 'BROWSER_SESSION_EXPIRED')
        setGuestExpired(true);
      setError(key ?? 'com_auth_email_code_unavailable');
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  const finish = async (data: TLoginResponse, signal: AbortSignal) => {
    if (signal.aborted || !data.token || !data.user) return;
    await completeAuthentication(data.token, data.user);
    if (!signal.aborted) onComplete?.();
  };
  const requestCode = () =>
    run(async (signal) => {
      const next = await emailCodeRequest<EmailCodeChallengeResponse>(
        'email-code/request',
        {
          email,
          ...(challenge ? { attemptId: challenge.attemptId } : {}),
        },
        signal,
      );
      if (!signal.aborted) {
        setChallenge(next);
        setCode('');
      }
    });

  if (step === 'choice') {
    return (
      <section className="space-y-4" aria-label={localize('com_auth_email_code_choice')}>
        <Button className="w-full" disabled={busy} onClick={() => setStep('email')}>
          {localize('com_auth_email_code_choice_email')}
        </Button>
        <Button
          className="w-full"
          variant="outline"
          disabled={busy}
          onClick={() =>
            run(async (signal) => {
              if (guestExpired) await emailCodeRequest('browser/reset', {}, signal);
              await finish(await emailCodeRequest<TLoginResponse>('guest', {}, signal), signal);
            })
          }
        >
          {localize(guestExpired ? 'com_auth_browser_new' : 'com_auth_email_code_choice_guest')}
        </Button>
        <p className="text-text-secondary text-sm">{localize('com_auth_email_code_guest_help')}</p>
        {busy && <Spinner />}
        {error && (
          <p role="alert" className="text-status-error-strong">
            {localize(error)}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="space-y-4" aria-label={localize('com_auth_email_code_title')}>
      {!config.emailCodeEnabled ? (
        <p role="status">{localize('com_auth_email_code_unavailable')}</p>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!challenge) void requestCode();
            else
              void run(async (signal) =>
                finish(
                  await emailCodeRequest<TLoginResponse>(
                    'email-code/verify',
                    {
                      attemptId: challenge.attemptId,
                      code,
                    },
                    signal,
                  ),
                  signal,
                ),
              );
          }}
        >
          <div className="space-y-2">
            <label htmlFor={`${id}-email`} className="block text-sm font-medium">
              {localize('com_auth_email_code_email')}
            </label>
            <Input
              id={`${id}-email`}
              type="email"
              autoComplete="email"
              maxLength={254}
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={busy || !!challenge}
              aria-describedby={`${id}-domains`}
            />
            <p id={`${id}-domains`} className="text-text-secondary text-sm">
              {localize('com_auth_email_code_domains', { 0: config.emailCodeDomains.join(', ') })}
            </p>
          </div>
          {challenge && (
            <div className="space-y-2">
              <p role="status" className="text-sm">
                {localize('com_auth_email_code_sent')}
              </p>
              <label htmlFor={`${id}-code`} className="block text-sm font-medium">
                {localize('com_auth_email_code_code')}
              </label>
              <Input
                ref={codeInput}
                id={`${id}-code`}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{8}"
                minLength={8}
                maxLength={8}
                required
                value={code}
                disabled={busy}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 8))}
              />
            </div>
          )}
          <Button className="w-full" type="submit" disabled={busy}>
            {busy
              ? localize('com_auth_email_code_working')
              : localize(challenge ? 'com_auth_email_code_verify' : 'com_auth_email_code_send')}
          </Button>
          {challenge && (
            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                variant="outline"
                disabled={busy || seconds > 0}
                onClick={() => void requestCode()}
              >
                {seconds > 0
                  ? localize('com_auth_email_code_resend_wait', { 0: String(seconds) })
                  : localize('com_auth_email_code_resend')}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setChallenge(undefined);
                  setCode('');
                  setError(undefined);
                }}
              >
                {localize('com_auth_email_code_change_email')}
              </Button>
            </div>
          )}
        </form>
      )}
      {error && (
        <p role="alert" className="text-status-error-strong">
          {localize(error)}
        </p>
      )}
      {config.authMode === 'transition' && !emailOnly && (
        <Button variant="outline" disabled={busy} onClick={() => setStep('choice')}>
          {localize('com_auth_email_code_back')}
        </Button>
      )}
    </section>
  );
}

/** Existing guests retain the chat while choosing whether to verify an email identity. */
export function GuestEmailEntry({ config }: { config: EmailCodeConfig }) {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  return (
    <OGDialog open={open} onOpenChange={setOpen}>
      <div className="border-border-light bg-surface-secondary flex flex-wrap items-center justify-center gap-2 border-b px-3 py-2 text-sm">
        <span>{localize('com_auth_email_code_guest_banner')}</span>
        <OGDialogTrigger asChild>
          <Button variant="outline">{localize('com_auth_email_code_choice_email')}</Button>
        </OGDialogTrigger>
      </div>
      <OGDialogContent className="w-11/12 max-w-md">
        <OGDialogHeader>
          <OGDialogTitle>{localize('com_auth_email_code_title')}</OGDialogTitle>
          <OGDialogDescription>{localize('com_auth_email_code_guest_help')}</OGDialogDescription>
        </OGDialogHeader>
        {open && <EmailCodeLogin config={config} emailOnly onComplete={() => setOpen(false)} />}
        <Button variant="outline" onClick={() => setOpen(false)}>
          {localize('com_auth_email_code_close')}
        </Button>
      </OGDialogContent>
    </OGDialog>
  );
}
