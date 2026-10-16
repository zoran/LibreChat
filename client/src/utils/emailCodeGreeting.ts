/** Custom welcome templates keep the original profile; only the scheduled greeting uses this. */
export function emailCodeGreeting(user?: { provider?: string; name?: string } | null) {
  if (user?.provider !== 'email_code') return user?.name;
  const firstName = user.name?.trim().split(/\s+/)[0];
  return firstName ? firstName.replace(/^./u, (initial) => initial.toUpperCase()) : undefined;
}
