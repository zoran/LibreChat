/** Retention presentation and purpose adapter; File owns verified recipients and current claims. */
import type { MailConfig, MailDependencies, SubmissionOutcome } from '../mail/submission';
import type { ExpiryMessageInput } from './expiryMessage';
import { createBoundedMailSubmission, singleMailbox, snapshotMailConfig } from '../mail/submission';
import { mailClientUrl } from '../auth/emailCodeLink';
import { expiryMessage } from './expiryMessage';

export type { SubmissionOutcome as RetentionMailOutcome } from '../mail/submission';

/** Deployment must bind a dedicated retention principal/Secret; login credentials are not a fallback. */
export interface RetentionMailConfig extends MailConfig {
  purpose: 'retention';
  clientUrl?: string;
}
export interface RetentionMailInput {
  recipient: string;
  /** Stable execution identity, hashed into Message-ID; does not promise SMTP deduplication. */
  submissionId: string;
  notice: Pick<ExpiryMessageInput, 'offsetDays' | 'asOf' | 'timezone' | 'late' | 'files'>;
  /** Final observed domain admission, not an atomic SMTP/database transaction or durable reservation. */
  authorizeHandoff: (signal: AbortSignal) => boolean | Promise<boolean>;
  signal?: AbortSignal;
}
export interface RetentionMailSender {
  sendReminder(input: RetentionMailInput): Promise<SubmissionOutcome>;
}
function invalidConfig(): never {
  throw new Error('Invalid retention SMTP configuration');
}
function snapshotConfig(value: RetentionMailConfig): RetentionMailConfig {
  try {
    if (value?.purpose !== 'retention') return invalidConfig();
    return Object.freeze({
      ...snapshotMailConfig(value),
      purpose: 'retention' as const,
      ...(value.clientUrl === undefined ? {} : { clientUrl: mailClientUrl(value.clientUrl) }),
    });
  } catch {
    return invalidConfig();
  }
}

/** No EMAIL_CODE_* / EMAIL_* fallback; explicit activation requires the complete dedicated config. */
export function getRetentionMailConfig(
  env: Record<string, string | undefined>,
  allowedDomains: readonly string[],
): RetentionMailConfig | undefined {
  if (env.RETENTION_MAIL_ENABLED !== 'true') return undefined;
  try {
    const hostsJSON = env.RETENTION_SMTP_HOSTS;
    if (typeof hostsJSON !== 'string' || hostsJSON.length > 1024) return invalidConfig();
    return snapshotConfig({
      purpose: 'retention',
      hosts: JSON.parse(hostsJSON),
      username: env.RETENTION_SMTP_USERNAME!,
      password: env.RETENTION_SMTP_PASSWORD!,
      ca: env.RETENTION_SMTP_CA!,
      servername: env.RETENTION_SMTP_TLS_SERVERNAME!,
      from: env.RETENTION_SMTP_FROM!,
      appTitle: env.APP_TITLE == null || env.APP_TITLE === '' ? 'LibreChat' : env.APP_TITLE,
      allowedDomains,
      supportText: env.RETENTION_MAIL_SUPPORT_TEXT,
      ...(env.DOMAIN_CLIENT ? { clientUrl: env.DOMAIN_CLIENT } : {}),
    });
  } catch {
    return invalidConfig();
  }
}

/** One bounded batch; the File owner handles oversize splitting, durable outcomes and stale work. */
export function createBoundedRetentionMailSender(
  inputConfig: RetentionMailConfig,
  deps: MailDependencies,
): RetentionMailSender {
  const config = snapshotConfig(inputConfig);
  const submission = createBoundedMailSubmission(config, deps);
  return {
    async sendReminder(input) {
      if (
        !singleMailbox(input.recipient) ||
        !config.allowedDomains.includes(
          input.recipient.slice(input.recipient.lastIndexOf('@') + 1),
        ) ||
        typeof input.authorizeHandoff !== 'function'
      )
        return { state: 'notAccepted', reason: 'invalid' };
      try {
        // Explicit projection excludes caller-provided branding, links, headers and attachments.
        const content = expiryMessage({
          appTitle: config.appTitle,
          clientUrl: config.clientUrl,
          embeddedLogo: Boolean(config.logoPng),
          supportText: config.supportText,
          offsetDays: input.notice.offsetDays,
          asOf: input.notice.asOf,
          timezone: input.notice.timezone,
          late: input.notice.late,
          files: input.notice.files,
        });
        return submission.submit({
          recipient: input.recipient,
          submissionId: input.submissionId,
          content,
          embeddedLogo: Boolean(config.logoPng),
          authorizeHandoff: input.authorizeHandoff,
          signal: input.signal,
        });
      } catch {
        return { state: 'notAccepted', reason: 'invalid' };
      }
    },
  };
}
