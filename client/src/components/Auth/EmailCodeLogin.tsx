import { useCallback, useEffect, useId, useRef, useState } from 'react';
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

const cooldownStorageKey = 'librechat-email-code-cooldowns';
const sendCooldownMs = 60_000;
const maxCooldownMs = 3_600_000;
const requestActions = ['send', 'verify', 'guest'] as const;
type RequestAction = (typeof requestActions)[number];
type Cooldowns = Record<RequestAction, number>;

/** Only bounded deadlines survive reloads; email addresses, codes and challenges stay in memory. */
function readCooldowns(): Cooldowns {
  const cooldowns: Cooldowns = { send: 0, verify: 0, guest: 0 };
  const now = Date.now();
  try {
    const saved = JSON.parse(localStorage.getItem(cooldownStorageKey) ?? 'null');
    for (const action of requestActions) {
      const until = saved?.[action];
      if (Number.isSafeInteger(until) && until > now && until <= now + maxCooldownMs) {
        cooldowns[action] = until;
      }
    }
  } catch {
    // A blocked or corrupt store must not break sign-in; the mounted handler still has its guard.
  }
  return cooldowns;
}

/** Own request admission and visible cooldowns for every action in the email-code login flow. */
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
  const [cooldowns, setCooldowns] = useState<Cooldowns>(readCooldowns);
  const [now, setNow] = useState(Date.now);
  const cooldownsRef = useRef(cooldowns);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const controller = useRef<AbortController>();
  const codeInput = useRef<HTMLInputElement>(null);
  const id = useId();

  const syncCooldowns = useCallback((action?: RequestAction, until = 0) => {
    const saved = readCooldowns();
    const next = { ...cooldownsRef.current };
    const timestamp = Date.now();
    for (const kind of requestActions) {
      next[kind] = Math.max(next[kind], saved[kind]);
    }
    if (action && Number.isFinite(until) && until > timestamp) {
      next[action] = Math.max(next[action], Math.min(Math.ceil(until), timestamp + maxCooldownMs));
      try {
        localStorage.setItem(cooldownStorageKey, JSON.stringify(next));
      } catch {
        // Keep enforcing the in-memory deadline when browser storage is unavailable.
      }
    }
    cooldownsRef.current = next;
    setCooldowns(next);
    setNow(timestamp);
    return next;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      controller.current?.abort();
      controller.current = undefined;
      inFlight.current = false;
    };
  }, []);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === cooldownStorageKey || event.key === null) syncCooldowns();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [syncCooldowns]);
  useEffect(() => {
    if (challenge) codeInput.current?.focus();
  }, [challenge]);
  const hasCountdown = !!challenge || requestActions.some((action) => cooldowns[action] > now);
  useEffect(() => {
    if (!hasCountdown) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasCountdown]);
  const secondsLeft = (action: RequestAction) =>
    Math.max(0, Math.ceil((cooldowns[action] - now) / 1000));
  const sendSeconds = secondsLeft('send');
  const verifySeconds = secondsLeft('verify');
  const guestSeconds = secondsLeft('guest');
  const minutesLeft = challenge
    ? Math.max(0, Math.ceil((Date.parse(challenge.expiresAt) - now) / 60_000))
    : 10;

  const run = async (kind: RequestAction, action: (signal: AbortSignal) => Promise<void>) => {
    if (!mounted.current || inFlight.current || syncCooldowns()[kind] > Date.now()) return;
    inFlight.current = true;
    const current = ++generation.current;
    const requestController = new AbortController();
    controller.current = requestController;
    if (kind === 'send') syncCooldowns('send', Date.now() + sendCooldownMs);
    setBusy(true);
    setError(undefined);
    try {
      await action(requestController.signal);
    } catch (cause) {
      if (current !== generation.current || requestController.signal.aborted) return;
      if (cause instanceof EmailCodeRequestError && cause.retryAfter > 0) {
        syncCooldowns(kind, Date.now() + cause.retryAfter * 1000);
      }
      const key =
        cause instanceof EmailCodeRequestError &&
        Object.prototype.hasOwnProperty.call(errorKeys, cause.code)
          ? errorKeys[cause.code]
          : undefined;
      if (cause instanceof EmailCodeRequestError && cause.code === 'BROWSER_SESSION_EXPIRED')
        setGuestExpired(true);
      setError(key ?? 'com_auth_email_code_unavailable');
    } finally {
      if (current === generation.current) {
        inFlight.current = false;
        controller.current = undefined;
        setBusy(false);
      }
    }
  };
  const finish = async (data: TLoginResponse, signal: AbortSignal) => {
    if (signal.aborted || !data.token || !data.user) return;
    await completeAuthentication(data.token, data.user);
    if (!signal.aborted) onComplete?.();
  };
  const requestCode = () =>
    run('send', async (signal) => {
      const next = await emailCodeRequest<EmailCodeChallengeResponse>(
        'email-code/request',
        {
          email,
          ...(challenge ? { attemptId: challenge.attemptId } : {}),
        },
        signal,
      );
      if (!signal.aborted) {
        syncCooldowns('send', Date.parse(next.resendAt));
        setChallenge(next);
        setCode('');
      }
    });

  const blockedSeconds = challenge ? verifySeconds : sendSeconds;
  let submitLabel = localize(challenge ? 'com_auth_email_code_verify' : 'com_auth_email_code_send');
  if (busy) {
    submitLabel = localize('com_auth_email_code_working');
  } else if (blockedSeconds > 0) {
    submitLabel = challenge
      ? `${submitLabel} (${localize('com_ui_duration_seconds', { 0: String(blockedSeconds) })})`
      : localize('com_auth_email_code_resend_wait', { 0: String(blockedSeconds) });
  }
  let guestLabel = localize(
    guestExpired ? 'com_auth_browser_new' : 'com_auth_email_code_choice_guest',
  );
  if (busy) {
    guestLabel = localize('com_auth_email_code_working');
  } else if (guestSeconds > 0) {
    guestLabel += ` (${localize('com_ui_duration_seconds', { 0: String(guestSeconds) })})`;
  }
  const pendingStatus = busy && (
    <p role="status" className="text-text-secondary flex items-center justify-center gap-2 text-sm">
      <Spinner className="shrink-0" />
      <span>{localize('com_auth_email_code_working')}</span>
    </p>
  );

  if (step === 'choice') {
    return (
      <section className="space-y-4" aria-label={localize('com_auth_email_code_choice')}>
        <Button
          className="w-full"
          disabled={busy}
          onClick={() => {
            if (!inFlight.current) setStep('email');
          }}
        >
          {localize('com_auth_email_code_choice_email')}
        </Button>
        <Button
          className="w-full"
          variant="outline"
          disabled={busy || guestSeconds > 0}
          onClick={() =>
            run('guest', async (signal) => {
              if (guestExpired) await emailCodeRequest('browser/reset', {}, signal);
              if (signal.aborted) return;
              await finish(await emailCodeRequest<TLoginResponse>('guest', {}, signal), signal);
            })
          }
        >
          {guestLabel}
        </Button>
        <p className="text-text-secondary text-sm">{localize('com_auth_email_code_guest_help')}</p>
        {pendingStatus}
        {error && (
          <p role="alert" className="text-status-error">
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
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            if (!challenge) void requestCode();
            else
              void run('verify', async (signal) =>
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
                {localize('com_auth_email_code_sent')}{' '}
                {localize('com_auth_email_link_remaining', { 0: String(minutesLeft) })}
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
          <Button className="w-full" type="submit" disabled={busy || blockedSeconds > 0}>
            {submitLabel}
          </Button>
          {challenge && (
            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                variant="outline"
                disabled={busy || sendSeconds > 0}
                onClick={() => void requestCode()}
              >
                {sendSeconds > 0
                  ? localize('com_auth_email_code_resend_wait', { 0: String(sendSeconds) })
                  : localize('com_auth_email_code_resend')}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  if (inFlight.current) return;
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
      {pendingStatus}
      {error && (
        <p role="alert" className="text-status-error">
          {localize(error)}
        </p>
      )}
      {config.authMode === 'transition' && !emailOnly && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            if (!inFlight.current) setStep('choice');
          }}
        >
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
