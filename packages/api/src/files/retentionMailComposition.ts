/** Retention factory behavior lives in TypeScript; application wiring supplies config and runtime ports. */
import type { RetentionMailSender } from './retentionMailSender';
import type { MailDependencies } from '../mail/submission';
import { createBoundedRetentionMailSender, getRetentionMailConfig } from './retentionMailSender';

export interface RetentionMailRuntime {
  readLogo(name: string | undefined): Buffer | undefined;
  createMailDependencies(): MailDependencies;
}
export function composeRetentionMailSender(
  environment: Record<string, string | undefined>,
  allowedDomains: readonly string[],
  runtime: RetentionMailRuntime,
): RetentionMailSender | undefined {
  const config = getRetentionMailConfig(environment, allowedDomains);
  if (!config) return undefined;
  return createBoundedRetentionMailSender(
    { ...config, logoPng: runtime.readLogo(environment.RETENTION_MAIL_LOGO_FILE) },
    runtime.createMailDependencies(),
  );
}
