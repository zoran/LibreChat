/** Custom welcome templates keep the original profile; only the scheduled greeting uses this. */
export function emailCodeGreeting(user?: { provider?: string; name?: string } | null) {
  if (user?.provider !== 'email_code') return user?.name;
  return user.name?.trim().split(/\s+/)[0] || undefined;
}
