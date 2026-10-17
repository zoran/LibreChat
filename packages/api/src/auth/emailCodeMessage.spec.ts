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
    const anchor = document.querySelector('a')!;
    expect(anchor.textContent).toBe(input.code);
    expect(anchor.getAttribute('href')).toBe(link);
    expect(anchor.getAttribute('aria-label')).toContain(input.code);
    expect(message.text).toContain(link);
    const instruction = 'Geben Sie diesen Code auf der Anmeldeseite ein:';
    expect(anchor.previousElementSibling?.textContent).toBe(instruction);
    expect(message.text.indexOf(instruction)).toBeLessThan(message.text.indexOf(input.code));
    expect(message.text.indexOf('Alternativ')).toBeGreaterThan(message.text.indexOf(input.code));
    expect(message.text).toContain('im selben Browser');
    expect(document.body.textContent).toContain('denselben Browser');
    expect(message.text).toContain('zehn Minuten');
    expect(new URL(anchor.href).search).toBe('');
    expect(
      document.querySelectorAll('script, form, iframe, img, link, style, input, object'),
    ).toHaveLength(0);
    expect(document.querySelectorAll('a')).toHaveLength(1);
  });

  it('escapes configured titles and attributes without creating markup or resource loads', () => {
    const title = '<img src="https://evil.test/pixel"> & \'Portal\'';
    const message = emailCodeMessage({ ...input, appTitle: title });
    const document = new JSDOM(message.html).window.document;
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('title')!.textContent).toBe(message.subject);
    expect(document.body.textContent).toContain(title);
    expect(document.querySelector('a')!.href).toBe(link);
    expect(message.text).toContain(title);
  });

  it('retains the English fallback and plain-text-only configuration', () => {
    const english = emailCodeMessage({ ...input, locale: 'en' });
    expect(english.subject).toBe('Your Example Portal sign-in code');
    expect(english.html).toContain('lang="en"');
    expect(english.text).toContain('ten minutes');
    const plain = emailCodeMessage({ ...input, link: undefined });
    expect(plain.html).toBeUndefined();
    expect(plain.text).toContain('01234567');
    expect(plain.text).not.toContain('anklicken');
  });
});
