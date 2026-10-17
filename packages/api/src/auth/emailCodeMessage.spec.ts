import { JSDOM } from 'jsdom';
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
    image.remove();
    expect(document.body.textContent).toContain(input.appTitle);
    expect(document.querySelector('a')!.textContent).toBe(input.code);
    expect(document.querySelector('a')!.href).toBe(link);
    expect(message.text).toContain(input.code);
    expect(message.text).toContain(link);
    expect(document.querySelectorAll('script,iframe,link,object')).toHaveLength(0);
  });
  it('keeps selectable digits and the exact trusted fragment link in both alternatives', () => {
    const message = emailCodeMessage(input);
    const document = new JSDOM(message.html).window.document;
    expect(document.documentElement.lang).toBe('de');
    expect(message.subject).toBe('Dein Anmeldecode für Example Portal');
    expect(document.querySelector('h1')!.textContent).toBe('Dein Anmeldecode');
    const anchor = document.querySelector('a')!;
    expect(anchor.textContent).toBe(input.code);
    expect(anchor.getAttribute('href')).toBe(link);
    expect(anchor.getAttribute('aria-label')).toContain(input.code);
    expect(message.text).toContain(link);
    const instruction = 'Gib diesen Code auf der Anmeldeseite ein:';
    expect(anchor.previousElementSibling?.textContent).toBe(instruction);
    expect(message.text.indexOf(instruction)).toBeLessThan(message.text.indexOf(input.code));
    expect(message.text.indexOf('Alternativ')).toBeGreaterThan(message.text.indexOf(input.code));
    expect(document.body.textContent).toContain('Alternativ kannst du den Code anklicken.');
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
      document.querySelectorAll('script, form, iframe, img, link, style, input, object'),
    ).toHaveLength(0);
    expect(document.querySelectorAll('a')).toHaveLength(1);
  });

  it('escapes configured titles and attributes without creating markup or resource loads', () => {
    const title = '<img src="https://evil.test/pixel"> & \'Portal\'';
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
