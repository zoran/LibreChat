/** Trusted deployment policy shared by authentication and its existing SMTP sender. */
export interface EmailCodeQualificationMailbox {
  readonly email: string;
  /** Absolute Unix milliseconds; expiry never renews on an application restart. */
  readonly notAfter: number;
}

export function qualificationMailbox(
  env: Record<string, string | undefined>,
): EmailCodeQualificationMailbox | undefined {
  const email = env.EMAIL_CODE_QUALIFICATION_MAILBOX ?? '';
  const expiry = env.EMAIL_CODE_QUALIFICATION_NOT_AFTER ?? '';
  if (!email && !expiry) return undefined;
  if (
    email.length > 254 ||
    !/^[a-z0-9][a-z0-9._+-]*@[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,63}$/.test(email) ||
    !/^[1-9][0-9]{9}$/.test(expiry)
  )
    throw new Error('Invalid email-code qualification policy');
  const notAfter = Number(expiry) * 1000;
  return Object.freeze({ email, notAfter });
}

/** Check the clock at each authority boundary; an exact exception never admits a domain. */
export function recipientAllowed(
  email: string,
  domains: readonly string[],
  qualification: EmailCodeQualificationMailbox | undefined,
  now: number = Date.now(),
): boolean {
  if (email !== email.trim().toLowerCase() || !/^[^\s@<>]+@[^\s@<>]+$/.test(email)) return false;
  return (
    domains.includes(email.slice(email.lastIndexOf('@') + 1)) ||
    (qualification !== undefined && qualification.email === email && now < qualification.notAfter)
  );
}
