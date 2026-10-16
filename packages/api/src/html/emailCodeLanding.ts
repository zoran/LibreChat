/** Navigation metadata permits convenience, never authentication. GET does not redeem a code. */
export function emailCodeLandingHtml(html: string, headers: Record<string, unknown>): string {
  const activated =
    headers['sec-fetch-mode'] === 'navigate' &&
    headers['sec-fetch-dest'] === 'document' &&
    headers['sec-fetch-user'] === '?1' &&
    !headers.purpose &&
    !headers['sec-purpose'];
  return html
    .replace(/<html\b/, `<html data-email-click-navigation="${activated}"`)
    .replace(/<script\b[^>]*data-lc-rum-bootstrap="true"[^>]*>[\s\S]*?<\/script>/gi, '');
}
