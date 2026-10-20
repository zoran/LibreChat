/** Pure mail presentation; the sender owns validation, trusted link construction and transport. */
export function emailCodeMessage(input: {
  appTitle: string;
  code: string;
  locale?: string;
  link?: string;
  embeddedLogo?: boolean;
  supportText?: string;
}): { subject: string; text: string; html?: string } {
  const { appTitle, code, link, supportText } = input;
  const german = input.locale === 'de';
  const subject = german ? `Dein Anmeldecode für ${appTitle}` : `Your ${appTitle} sign-in code`;
  const heading = german ? 'Dein Anmeldecode' : 'Your sign-in code';
  const instruction = german
    ? 'Gib diesen Code auf der Anmeldeseite ein:'
    : 'Enter this code on the sign-in page:';
  const validity = german
    ? 'Der Code ist zehn Minuten gültig.'
    : 'The code is valid for ten minutes.';
  const alternative = german
    ? 'Alternativ kannst du diesen Link öffnen:'
    : 'You can also open this link:';
  const ignore = german
    ? 'Wenn du diese Anmeldung nicht angefordert hast, ignoriere diese E-Mail.'
    : 'If you did not request this sign-in, you can ignore this email.';
  const text = [
    subject,
    `${instruction}\n\n${code}`,
    validity,
    ...(link ? [alternative, link] : []),
    ignore,
    ...(supportText ? [supportText] : []),
  ].join('\n\n');
  if (!link) return { subject, text };
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
    );
  const fontFamily = 'Arial,Helvetica,sans-serif';
  const accent = input.embeddedLogo ? '#007F87' : '#FF003A';
  const codeBackground = input.embeddedLogo ? '#E8F7F8' : '#FFF0F3';
  const logo = input.embeddedLogo
    ? `<img src="cid:application-logo@local" width="300" alt="${escape(appTitle)}" style="display:block;width:300px;max-width:100%;height:auto;border:0;margin:0 auto;">`
    : '';
  const html = `<!doctype html>
<html lang="${german ? 'de' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(subject)}</title></head>
<body style="margin:0;padding:0;background:#F2F3F5;color:#202124;font-family:${fontFamily};line-height:1.6;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;background:#F2F3F5;font-family:${fontFamily};"><tr><td align="center" style="padding:24px 12px;font-family:${fontFamily};">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="width:100%;max-width:600px;table-layout:fixed;background:#FFFFFF;border:1px solid #D9DDE2;border-radius:16px;font-family:${fontFamily};">
<tr><td align="center" style="padding:24px;background:#202124;border-top:4px solid ${accent};border-radius:16px 16px 0 0;color:#FFFFFF;font-family:${fontFamily};font-size:20px;font-weight:bold;text-align:center;overflow-wrap:anywhere;word-break:break-word;">${logo || escape(appTitle)}</td></tr>
<tr><td style="padding:28px 24px;font-family:${fontFamily};overflow-wrap:anywhere;word-break:break-word;">
<h1 style="margin:0 0 16px;font-family:${fontFamily};font-size:26px;line-height:1.3;color:#202124;">${heading}</h1>
<p style="margin:0 0 16px;font-family:${fontFamily};font-size:16px;">${instruction}</p>
<p style="display:inline-block;margin:0;max-width:100%;box-sizing:border-box;padding:12px 16px;border:1px solid #D9DDE2;border-radius:8px;background:${codeBackground};color:#202124;font-family:${fontFamily};font-size:28px;font-weight:bold;line-height:1.5;letter-spacing:2px;user-select:all;overflow-wrap:anywhere;word-break:break-all;">${escape(code)}</p>
<p style="margin:12px 0 24px;font-family:${fontFamily};font-size:16px;color:#4A4F57;">${validity}</p>
<p style="margin:0 0 8px;font-family:${fontFamily};font-size:14px;color:#4A4F57;">${alternative}</p>
<a style="font-family:${fontFamily};font-size:14px;line-height:1.5;color:#4A4F57;text-decoration:underline;overflow-wrap:anywhere;word-break:break-all;" href="${escape(link)}">${escape(link)}</a>
</td></tr><tr><td style="padding:20px 24px;border-top:1px solid #D9DDE2;color:#4A4F57;font-family:${fontFamily};font-size:14px;overflow-wrap:anywhere;">${ignore}${supportText ? `<p style="margin:12px 0 0;font-family:${fontFamily};">${escape(supportText)}</p>` : ''}</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}
