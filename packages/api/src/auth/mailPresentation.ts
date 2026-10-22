/** Shared presentation only: callers supply renderer-owned, escaped content and footer fragments. */
export const MAIL_FONT_FAMILY = 'Arial,Helvetica,sans-serif';

export function escapeMailHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
}

export function mailPalette(embeddedLogo?: boolean): { accent: string; highlight: string } {
  return embeddedLogo
    ? { accent: '#007F87', highlight: '#E8F7F8' }
    : { accent: '#FF003A', highlight: '#FFF0F3' };
}

export function mailPresentation(input: {
  appTitle: string;
  subject: string;
  language: 'de' | 'en';
  embeddedLogo?: boolean;
  content: string;
  footer: string;
}): string {
  const fontFamily = MAIL_FONT_FAMILY;
  const { accent } = mailPalette(input.embeddedLogo);
  const logo = input.embeddedLogo
    ? `<img src="cid:application-logo@local" width="300" alt="${escapeMailHtml(input.appTitle)}" style="display:block;width:300px;max-width:100%;height:auto;border:0;margin:0 auto;">`
    : '';
  return `<!doctype html>
<html lang="${input.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeMailHtml(input.subject)}</title></head>
<body style="margin:0;padding:0;background:#F2F3F5;color:#202124;font-family:${fontFamily};line-height:1.6;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#F2F3F5;font-family:${fontFamily};"><tr><td align="center" style="padding:24px 12px;font-family:${fontFamily};">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;table-layout:fixed;background:#FFFFFF;border:1px solid #D9DDE2;border-radius:16px;font-family:${fontFamily};">
<tr><td align="center" style="padding:24px;background:#202124;border-top:4px solid ${accent};border-radius:16px 16px 0 0;color:#FFFFFF;font-family:${fontFamily};font-size:20px;font-weight:bold;text-align:center;overflow-wrap:anywhere;word-break:break-word;">${logo || escapeMailHtml(input.appTitle)}</td></tr>
<tr><td style="padding:28px 24px;font-family:${fontFamily};overflow-wrap:anywhere;word-break:break-word;">
${input.content}
</td></tr><tr><td style="padding:20px 24px;border-top:1px solid #D9DDE2;color:#4A4F57;font-family:${fontFamily};font-size:14px;overflow-wrap:anywhere;">${input.footer}</td></tr>
</table></td></tr></table></body></html>`;
}
