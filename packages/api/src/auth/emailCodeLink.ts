/** Only deployment configuration supplies the origin; never an HTTP Host or redirect parameter. */
export function mailClientUrl(input: unknown): string {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('Invalid mail client URL');
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('Invalid mail client URL');
  return url.href.replace(/\/?$/, '/');
}

export function emailCodeLink(
  clientUrl: string,
  attemptId: string | undefined,
  code: string,
  linkProof?: string,
): string {
  if (!attemptId || !/^[A-Za-z0-9_-]{43}$/.test(attemptId) || !/^\d{8}$/.test(code))
    throw new Error('Invalid email-code link');
  if (linkProof !== undefined && !/^[a-f0-9]{64}$/.test(linkProof))
    throw new Error('Invalid email-code link');
  const url = new URL('login/email-code', mailClientUrl(clientUrl));
  url.hash = `attemptId=${attemptId}&code=${code}${linkProof ? `&proof=${linkProof}` : ''}`;
  return url.href;
}
