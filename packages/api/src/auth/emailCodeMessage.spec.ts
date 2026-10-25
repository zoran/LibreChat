import { JSDOM } from 'jsdom';
import { MAIL_MOBILE_STYLES } from './mailPresentation';
import { emailCodeMessage } from './emailCodeMessage';
import { emailCodeLink } from './emailCodeLink';

const link = emailCodeLink('https://portal.example.test/chat/', 'a'.repeat(43), '01234567');
const input = { appTitle: 'Example Portal', code: '01234567', locale: 'de', link };

describe('email-code message presentation', () => {
  it('embeds a CID logo while retaining usable text and login when images are hidden', () => {
    const message = emailCodeMessage({ ...input, embeddedLogo: true });
    const document = new JSDOM(message.html).window.document;
    const image = document.querySelector('img')!;
    expect(image.getAttribute('src')).toBe('cid:application-logo@local');
    expect(image.alt).toBe(input.appTitle);
    expect(image.width).toBe(300);
    expect(image.style.maxWidth).toBe('100%');
    expect(image.style.marginLeft).toBe('auto');
    expect(image.style.marginRight).toBe('auto');
    expect(image.closest('td')!.getAttribute('align')).toBe('center');
    image.remove();
    expect(document.body.textContent).not.toContain(input.appTitle);
    expect(document.body.textContent).toContain(input.code);
    expect(document.querySelector('a')!.textContent).toBe(link);
    expect(document.querySelector('a')!.href).toBe(link);
    expect(message.text).toContain(input.code);
    expect(message.text).toContain(link);
    expect(document.querySelectorAll('script,iframe,link,object')).toHaveLength(0);
  });
  it('keeps unlinked selectable digits above the complete trusted fragment link', () => {
    const message = emailCodeMessage(input);
    const document = new JSDOM(message.html).window.document;
    expect(document.documentElement.lang).toBe('de');
    expect(message.subject).toBe('Dein Anmeldecode für Example Portal');
    expect(document.querySelector('h1')!.textContent).toBe('Dein Anmeldecode');
    const code = Array.from(document.querySelectorAll('p')).find(
      (paragraph) => paragraph.textContent === input.code,
    )!;
    expect(code).toBeDefined();
    expect(code.closest('a')).toBeNull();
    expect(code.querySelector('a')).toBeNull();
    expect(code.style.userSelect).toBe('all');
    expect(code.style.fontFamily).toMatch(/^Arial\s*,\s*Helvetica\s*,\s*sans-serif$/);
    const anchor = document.querySelector('a')!;
    expect(anchor.textContent).toBe(link);
    expect(anchor.getAttribute('href')).toBe(link);
    expect(anchor.hasAttribute('aria-label')).toBe(false);
    expect(code.compareDocumentPosition(anchor) & 4).toBe(4);
    expect(message.text).toContain(link);
    const instruction = 'Gib diesen Code auf der Anmeldeseite ein:';
    expect(code.previousElementSibling?.textContent).toBe(instruction);
    expect(message.text.indexOf(instruction)).toBeLessThan(message.text.indexOf(input.code));
    expect(message.text.indexOf('Alternativ')).toBeGreaterThan(message.text.indexOf(input.code));
    expect(document.body.textContent).toContain('Alternativ kannst du diesen Link öffnen:');
    expect(document.body.textContent).not.toContain('Code anklicken');
    expect(message.text).toContain('Alternativ kannst du diesen Link öffnen:');
    expect(message.text).toContain(
      'Wenn du diese Anmeldung nicht angefordert hast, ignoriere diese E-Mail.',
    );
    expect(message.text.match(/zehn Minuten/g)).toHaveLength(1);
    expect(document.body.textContent!.match(/zehn Minuten/g)).toHaveLength(1);
    expect(message.text).not.toMatch(/Browser|\b(?:Sie|Ihr|Ihre|Ihnen)\b/);
    expect(document.body.textContent).not.toMatch(/Browser|\b(?:Sie|Ihr|Ihre|Ihnen)\b/);
    expect(new URL(anchor.href).search).toBe('');
    expect(
      document.querySelectorAll('script, form, iframe, img, link, input, object'),
    ).toHaveLength(0);
    const styles = document.querySelectorAll('style');
    expect(styles).toHaveLength(1);
    expect(styles[0].parentElement).toBe(document.head);
    expect(styles[0].textContent).toBe(MAIL_MOBILE_STYLES);
    expect(styles[0].textContent).not.toMatch(/url\s*\(|@import|https?:/i);
    expect(document.documentElement.getAttribute('style')).toContain('text-size-adjust:100%');
    expect(document.body.getAttribute('style')).toContain('text-size-adjust:100%');
    expect(document.querySelector('.mail-heading')).toBe(document.querySelector('h1'));
    expect(document.querySelector('.mail-code')).toBe(code);
    expect(code.style.fontSize).toBe('28px');
    expect(document.querySelector('h1')!.style.fontSize).toBe('26px');
    expect(document.querySelectorAll('a')).toHaveLength(1);
  });

  it('retains the full long URL and one Arial font stack throughout the message', () => {
    const longLink = emailCodeLink(
      `https://portal.example.test/${'workspace/'.repeat(30)}`,
      'a'.repeat(43),
      input.code,
    );
    const message = emailCodeMessage({ ...input, link: longLink });
    const document = new JSDOM(message.html).window.document;
    const anchor = document.querySelector('a')!;
    expect(anchor.textContent).toBe(longLink);
    expect(anchor.getAttribute('href')).toBe(longLink);
    expect(anchor.style.overflowWrap).toBe('anywhere');
    expect(anchor.style.wordBreak).toBe('break-all');
    expect(message.text).toContain(longLink);
    for (const element of document.querySelectorAll<HTMLElement>('body,table,td,h1,p,a')) {
      expect(element.style.fontFamily).toMatch(/^Arial\s*,\s*Helvetica\s*,\s*sans-serif$/);
    }
  });

  it('escapes configured titles and attributes without creating markup or resource loads', () => {
    const title =
      '<img src="https://evil.test/pixel"> & \'Portal\' <style>@import "https://evil.test/css";</style>';
    const supportText = 'Fragen an <img src="https://evil.test/help"> & "Support".';
    const message = emailCodeMessage({ ...input, appTitle: title, supportText });
    const document = new JSDOM(message.html).window.document;
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('title')!.textContent).toBe(message.subject);
    expect(document.body.textContent).toContain(title);
    expect(document.querySelector('a')!.href).toBe(link);
    expect(message.text).toContain(title);
    expect(document.body.textContent).toContain(supportText);
    expect(message.text).toContain(supportText);
    expect(document.querySelectorAll('style')).toHaveLength(1);
    expect(document.querySelector('style')!.textContent).toBe(MAIL_MOBILE_STYLES);
    expect(document.querySelectorAll('script,iframe,img,link,object')).toHaveLength(0);
  });

  it.each([link, undefined])('includes only the configured help with link %s', (configuredLink) => {
    const supportText = 'Bei Fragen hilft dir das Portal-Team weiter.';
    const message = emailCodeMessage({ ...input, link: configuredLink, supportText });
    expect(message.text.split(supportText)).toHaveLength(2);
    expect(message.text.endsWith(supportText)).toBe(true);
    if (configuredLink) {
      const document = new JSDOM(message.html).window.document;
      expect(document.body.textContent!.split(supportText)).toHaveLength(2);
      expect(
        Array.from(document.querySelectorAll('p')).filter(
          (paragraph) => paragraph.textContent === supportText,
        ),
      ).toHaveLength(1);
    } else {
      expect(message.html).toBeUndefined();
    }
    const unconfigured = emailCodeMessage({ ...input, link: configuredLink });
    expect(unconfigured.text).not.toContain('Portal-Team');
    expect(unconfigured.html ?? '').not.toContain('Portal-Team');
  });

  it('retains the English fallback and plain-text-only configuration', () => {
    const english = emailCodeMessage({ ...input, locale: 'en' });
    expect(english.subject).toBe('Your Example Portal sign-in code');
    expect(english.html).toContain('lang="en"');
    expect(english.text.match(/ten minutes/g)).toHaveLength(1);
    expect(english.html!.match(/ten minutes/g)).toHaveLength(1);
    expect(english.text).not.toMatch(/browser/i);
    expect(english.html).not.toMatch(/browser/i);
    const plain = emailCodeMessage({ ...input, link: undefined });
    expect(plain.html).toBeUndefined();
    expect(plain.text).toContain('01234567');
    expect(plain.text).not.toContain('anklicken');
    expect(plain.text).not.toMatch(/Browser|Alternativ/);
  });
});
