/** Login policy/presentation adapter over the shared bounded SMTP submission owner. */
import { randomUUID } from 'node:crypto';
import type { MailConfig, MailDependencies } from '../mail/submission';
import type { EmailCodeSender } from './emailCode.types';
import {
  qualificationMailbox,
  recipientAllowed,
  type EmailCodeQualificationMailbox,
} from './emailRecipientPolicy';
import {
  createBoundedMailSubmission,
  snapshotMailConfig as snapshotSharedConfig,
} from '../mail/submission';
import { emailCodeLink, mailClientUrl } from './emailCodeLink';
import { emailCodeMessage } from './emailCodeMessage';

export interface EmailCodeMailConfig extends MailConfig {
  qualification?: EmailCodeQualificationMailbox;
  clientUrl?: string;
}
// Existing public names retain one implementation and migrate their runtime consumer together.
export type {
  MailDependencies as EmailCodeMailDependencies,
  MailMessage as EmailCodeMailMessage,
  MailTransport as EmailCodeMailTransport,
  SMTPOptions as EmailCodeSMTPOptions,
} from '../mail/submission';

/** No transport diagnostics, mailboxes, credentials or codes cross this error boundary. */
class SubmissionUnavailable extends Error {
  readonly code = 'EMAIL_CODE_UNAVAILABLE';
  constructor() {
    super('Email-code submission unavailable');
  }
}
function invalidMailConfig(): never {
  throw new Error('Invalid email-code SMTP configuration');
}
function snapshotMailConfig(value: unknown): EmailCodeMailConfig {
  try {
    const shared = snapshotSharedConfig(value);
    const input = value as EmailCodeMailConfig;
    let qualification: EmailCodeQualificationMailbox | undefined;
    if (input.qualification !== undefined) {
      const row = input.qualification;
      if (
        !row ||
        typeof row.email !== 'string' ||
        !Number.isSafeInteger(row.notAfter) ||
        row.notAfter % 1000 !== 0
      )
        return invalidMailConfig();
      qualification = qualificationMailbox({
        EMAIL_CODE_QUALIFICATION_MAILBOX: row.email,
        EMAIL_CODE_QUALIFICATION_NOT_AFTER: String(row.notAfter / 1000),
      });
    }
    return Object.freeze({
      ...shared,
      ...(qualification ? { qualification } : {}),
      ...(input.clientUrl === undefined ? {} : { clientUrl: mailClientUrl(input.clientUrl) }),
    });
  } catch {
    return invalidMailConfig();
  }
}

/** Public configuration only; callers obtain password/CA from the deployment's existing secret owner. */
export function getEmailCodeMailConfig(
  env: Record<string, string | undefined>,
  allowedDomains: readonly string[],
): EmailCodeMailConfig | undefined {
  if (env.EMAIL_CODE_ENABLED !== 'true') return undefined;
  const password = env.EMAIL_CODE_SMTP_PASSWORD;
  const ca = env.EMAIL_CODE_SMTP_CA;
  const hostsJSON = env.EMAIL_CODE_SMTP_HOSTS;
  const explicit = [
    password,
    ca,
    hostsJSON,
    env.EMAIL_CODE_SMTP_USERNAME,
    env.EMAIL_CODE_SMTP_FROM,
    env.EMAIL_CODE_SMTP_TLS_SERVERNAME,
  ];
  if (explicit.every((value) => value == null || value === '')) return undefined;
  if (typeof hostsJSON !== 'string' || hostsJSON.length > 1024) return invalidMailConfig();
  let hosts: unknown;
  try {
    hosts = JSON.parse(hostsJSON) as unknown;
  } catch {
    return invalidMailConfig();
  }
  return snapshotMailConfig({
    hosts,
    username: env.EMAIL_CODE_SMTP_USERNAME,
    password,
    ca,
    servername: env.EMAIL_CODE_SMTP_TLS_SERVERNAME,
    from: env.EMAIL_CODE_SMTP_FROM,
    appTitle: env.APP_TITLE == null || env.APP_TITLE === '' ? 'LibreChat' : env.APP_TITLE,
    allowedDomains,
    qualification: qualificationMailbox(env),
    supportText: env.EMAIL_CODE_SUPPORT_TEXT,
    ...(env.DOMAIN_CLIENT ? { clientUrl: env.DOMAIN_CLIENT } : {}),
  });
}

/** Login retains its code, qualification, expiry and sanitized resolve/reject contract. */
export function createBoundedEmailCodeSender(
  inputConfig: EmailCodeMailConfig,
  deps: MailDependencies,
): EmailCodeSender {
  const config = snapshotMailConfig(inputConfig);
  const submission = createBoundedMailSubmission(config, deps);
  return {
    async sendCode(input) {
      if (
        !/^[^\s@<>]+@[^\s@<>]+$/.test(input.email) ||
        input.email.length > 254 ||
        !recipientAllowed(input.email, config.allowedDomains, config.qualification) ||
        !/^\d{8}$/.test(input.code) ||
        input.expiresInMinutes !== 10
      )
        throw new SubmissionUnavailable();
      const email = input.email;
      const link = config.clientUrl
        ? emailCodeLink(config.clientUrl, input.attemptId, input.code)
        : undefined;
      const qualifiedOnly = !config.allowedDomains.includes(
        email.slice(email.lastIndexOf('@') + 1),
      );
      const outcome = await submission.submit({
        recipient: email,
        submissionId: input.attemptId ?? randomUUID(),
        content: emailCodeMessage({
          appTitle: config.appTitle,
          code: input.code,
          locale: input.locale,
          link,
          embeddedLogo: Boolean(config.logoPng && link),
          supportText: config.supportText,
        }),
        embeddedLogo: Boolean(config.logoPng && link),
        authorizeHandoff: () =>
          recipientAllowed(email, config.allowedDomains, config.qualification),
        ...(qualifiedOnly ? { authorizationExpiresAt: config.qualification!.notAfter } : {}),
      });
      if (
        outcome.state !== 'accepted' ||
        !recipientAllowed(email, config.allowedDomains, config.qualification)
      )
        throw new SubmissionUnavailable();
    },
  };
}
