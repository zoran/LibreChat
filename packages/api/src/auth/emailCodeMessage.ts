import {
  escapeMailHtml as escape,
  MAIL_FONT_FAMILY,
  mailPalette,
  mailPresentation,
} from './mailPresentation';

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
  const fontFamily = MAIL_FONT_FAMILY;
  const { highlight: codeBackground } = mailPalette(input.embeddedLogo);
  const content = `<h1 style="margin:0 0 16px;font-family:${fontFamily};font-size:26px;line-height:1.3;color:#202124;">${heading}</h1>
<p style="margin:0 0 16px;font-family:${fontFamily};font-size:16px;">${instruction}</p>
<p style="display:inline-block;margin:0;max-width:100%;box-sizing:border-box;padding:12px 16px;border:1px solid #D9DDE2;border-radius:8px;background:${codeBackground};color:#202124;font-family:${fontFamily};font-size:28px;font-weight:bold;line-height:1.5;letter-spacing:2px;user-select:all;overflow-wrap:anywhere;word-break:break-all;">${escape(code)}</p>
<p style="margin:12px 0 24px;font-family:${fontFamily};font-size:16px;color:#4A4F57;">${validity}</p>
<p style="margin:0 0 8px;font-family:${fontFamily};font-size:14px;color:#4A4F57;">${alternative}</p>
<a style="font-family:${fontFamily};font-size:14px;line-height:1.5;color:#4A4F57;text-decoration:underline;overflow-wrap:anywhere;word-break:break-all;" href="${escape(link)}">${escape(link)}</a>`;
  const html = mailPresentation({
    appTitle,
    subject,
    language: german ? 'de' : 'en',
    embeddedLogo: input.embeddedLogo,
    content,
    footer: `${ignore}${supportText ? `<p style="margin:12px 0 0;font-family:${fontFamily};">${escape(supportText)}</p>` : ''}`,
  });
  return { subject, text, html };
}
