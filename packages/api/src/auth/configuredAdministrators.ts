import type { ConfiguredAdministratorPolicy } from '@librechat/data-schemas';
import { emailCodeAddressSchema } from './emailCodeAddress';

/** Server-only control-plane configuration; never part of the public auth DTO or JWT. */
export function getConfiguredAdministratorPolicy(
  env: NodeJS.ProcessEnv = process.env,
): ConfiguredAdministratorPolicy | undefined {
  const raw = env.PLATFORM_ADMIN_EMAILS_JSON;
  const revisionText = env.PLATFORM_ADMIN_POLICY_REVISION;
  if (raw === undefined && revisionText === undefined) return undefined;
  const invalid = () => new Error('Invalid configured platform administrator policy');
  if (
    raw === undefined ||
    raw.length > 32_768 ||
    revisionText === undefined ||
    !/^[1-9][0-9]*$/.test(revisionText)
  )
    throw invalid();
  const revision = Number(revisionText);
  const tenantId = env.EMAIL_CODE_TENANT_ID ?? '';
  if (
    !Number.isSafeInteger(revision) ||
    tenantId === '__SYSTEM__' ||
    !/^[a-zA-Z0-9_.-]{1,128}$/.test(tenantId)
  )
    throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (!Array.isArray(parsed) || parsed.length > 64) throw invalid();
  const emails: string[] = [];
  for (const value of parsed) {
    const address = emailCodeAddressSchema.safeParse(value);
    if (
      !address.success ||
      address.data !== value ||
      !/^[a-z0-9][a-z0-9._+-]*@bwi\.de$/.test(address.data) ||
      Buffer.byteLength(address.data, 'utf8') > 254 ||
      emails.includes(address.data)
    )
      throw invalid();
    emails.push(address.data);
  }
  return Object.freeze({ revision, tenantId, emails: Object.freeze(emails.sort()) });
}
