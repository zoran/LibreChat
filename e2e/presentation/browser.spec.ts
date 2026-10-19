import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { emailCodeMessage } from '../../packages/api/src/auth/emailCodeMessage';
import { emailCodeLink } from '../../packages/api/src/auth/emailCodeLink';
import { seedConversations, seedMessages } from '../specs/mock/db';
import { getAccessToken } from '../specs/mock/helpers';
import { statusCases } from './status-cases';

const appTitle = 'Example Workplace';
const version = 'v1.2.3+example.1';
const userText = 'Meine Notiz über LibreChat bleibt unverändert.';
const mailAttemptId = 'a'.repeat(43);
const mailCode = '01234567';

type PresentationFixture = {
  theme: 'light' | 'dark';
  customWelcome?: string;
  emailCodeLogin?: boolean;
};

async function configureBranding(page: Page, fixture: PresentationFixture) {
  await page.addInitScript((theme) => localStorage.setItem('color-theme', theme), fixture.theme);
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const startup = await response.json();
    await route.fulfill({
      response,
      json: {
        ...startup,
        ...(fixture.emailCodeLogin
          ? {
              authMode: 'email_code',
              emailCodeEnabled: true,
              emailCodeDomains: ['example.invalid'],
            }
          : {}),
        interface: {
          ...startup.interface,
          appLogo: {
            light: 'assets/presentation-logo-light.svg',
            dark: 'assets/presentation-logo-dark.svg',
          },
          ...(fixture.customWelcome ? { customWelcome: fixture.customWelcome } : {}),
        },
      },
    });
  });
  await page.route(/\/assets\/presentation-logo-(?:light|dark)\.svg$/, async (route) => {
    const fill = route.request().url().includes('-dark.svg') ? '#ffffff' : '#202124';
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="80" viewBox="0 0 400 80"><text x="4" y="56" font-size="40" fill="${fill}">${appTitle}</text></svg>`,
    });
  });
}

async function expectThemedLogo(logo: Locator, theme: PresentationFixture['theme']) {
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute('src', `assets/presentation-logo-${theme}.svg`);
  await expect
    .poll(() =>
      logo.evaluate(
        (image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
      ),
    )
    .toBe(true);
}

async function expectReadableAuthText(text: Locator) {
  await expect(text).toBeVisible();
  await expect
    .poll(() =>
      text.evaluate((element) => {
        const parse = (color: string) => {
          const channels = color.match(/[\d.]+/g)?.map(Number);
          if (!/^rgba?\(/.test(color) || !channels || channels.length < 3) {
            throw new Error(`Expected computed RGB color, received ${color}`);
          }
          return { channels: channels.slice(0, 3), alpha: channels[3] ?? 1 };
        };
        const luminance = (channels: number[]) => {
          const [r, g, b] = channels.map((value) => {
            const channel = value / 255;
            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const foreground = parse(getComputedStyle(element).color);
        if (foreground.alpha !== 1) return 0;
        // These native auth surfaces paint a solid background on an ancestor.
        let background: number[] | undefined;
        for (let node: Element | null = element; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (Number(style.opacity) !== 1) return 0;
          if (background) continue;
          const painted = parse(style.backgroundColor);
          if (painted.alpha === 0) continue;
          if (painted.alpha !== 1 || style.backgroundImage !== 'none') return 0;
          background = painted.channels;
        }
        if (!background) throw new Error('Auth text must have a painted background');
        const a = luminance(foreground.channels);
        const b = luminance(background);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      }),
    )
    .toBeGreaterThanOrEqual(4.5);
}

async function signInFixture(page: Page) {
  const email = `presentation-${randomUUID()}@example.invalid`;
  const password = `Presentation-${randomUUID()}!`;
  const registered = await page.request.post('/api/auth/register', {
    data: { name: 'Presentation User', email, password, confirm_password: password },
  });
  expect(registered.ok()).toBeTruthy();
  const signedIn = await page.request.post('/api/auth/login', { data: { email, password } });
  expect(signedIn.ok()).toBeTruthy();
}

function responseGate() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

async function clickRenderedMailLink(page: Page, baseURL: string) {
  const trustedClient = new URL(baseURL);
  trustedClient.protocol = 'https:';
  const link = emailCodeLink(trustedClient.href, mailAttemptId, mailCode);
  const message = emailCodeMessage({ appTitle, code: mailCode, locale: 'de', link });
  if (!message.html) throw new Error('The production mail renderer must supply its link');
  await page.route('**/__presentation-mail', (route) =>
    route.fulfill({ contentType: 'text/html', body: message.html }),
  );
  await page.goto('/__presentation-mail');
  const anchor = page.getByRole('link', { name: `Mit dem Code ${mailCode} anmelden`, exact: true });
  const href = await anchor.getAttribute('href');
  expect(href).toBe(link);
  if (!href) throw new Error('Rendered mail has no link');
  const localLink = new URL(href);
  // Production requires HTTPS; only the scheme changes for this enforced HTTP loopback harness.
  localLink.protocol = new URL(baseURL).protocol;
  await anchor.evaluate((element, value) => element.setAttribute('href', value), localLink.href);
  await anchor.click();
  await expect(page).toHaveURL(new URL('login/email-code', baseURL).href);
}

async function expectSettledLanding(page: Page, greetingText: string) {
  const landing = page.getByTestId('landing');
  const logo = landing.getByRole('img', { name: appTitle, exact: true });
  const greeting = landing.getByTestId('landing-greeting').locator('.split-parent');
  const composer = page.getByTestId('composer-surface');
  await expect(greeting).toBeVisible();
  await expect(greeting.locator('.sr-only')).toHaveText(greetingText);
  await expect(composer).toBeVisible();
  // A visible paragraph box alone can still contain transparent or translated spring letters.
  await expect
    .poll(() =>
      greeting.locator('[aria-hidden="true"] > span').evaluateAll(
        (letters) =>
          letters.length > 0 &&
          letters.every((letter) => {
            const style = getComputedStyle(letter);
            const settledTransform =
              style.transform === 'none' ||
              Math.abs(new DOMMatrixReadOnly(style.transform).m42) < 0.5;
            return Number(style.opacity) >= 0.99 && settledTransform;
          }),
      ),
    )
    .toBe(true);
  let previous = '';
  let stableSamples = 0;
  await expect
    .poll(
      async () => {
        const boxes = await Promise.all([
          logo.boundingBox(),
          greeting.boundingBox(),
          composer.boundingBox(),
        ]);
        if (boxes.some((box) => box === null)) return false;
        const sample = JSON.stringify(boxes, (_key, value) =>
          typeof value === 'number' ? Math.round(value * 10) / 10 : value,
        );
        stableSamples = sample === previous ? stableSamples + 1 : 0;
        previous = sample;
        return stableSamples >= 2;
      },
      { intervals: [100, 150, 200] },
    )
    .toBe(true);
  const logoBox = await logo.boundingBox();
  const greetingBox = await greeting.boundingBox();
  const composerBox = await composer.boundingBox();
  const viewport = page.viewportSize();
  if (!logoBox || !greetingBox || !composerBox || !viewport) {
    throw new Error('Landing layout must have measurable logo, greeting, composer and viewport');
  }
  expect(
    greetingBox.y - (logoBox.y + logoBox.height),
    'Logo must clear the visible greeting',
  ).toBeGreaterThan(0);
  expect(
    composerBox.y - (greetingBox.y + greetingBox.height),
    'Greeting must clear the composer',
  ).toBeGreaterThan(0);
  for (const box of [logoBox, greetingBox, composerBox]) {
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.y).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  }
  await expectNoOverflow(page);
}

async function prepareEnglish(context: BrowserContext, baseURL: string, json: boolean) {
  await context.addCookies([{ name: 'lang', value: 'en', url: baseURL }]);
  await context.addInitScript((encoded) => {
    localStorage.setItem('lang', encoded ? JSON.stringify('en') : 'en');
    localStorage.setItem('appTitle', 'Previous LibreChat deployment');
    localStorage.setItem('navVisible', 'true');
    localStorage.setItem('chatTitleInTab', 'false');
  }, json);
  // Only the isolated application may receive browser requests; no provider/analytics fixture.
  const origin = new URL(baseURL).origin;
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin || url.protocol === 'data:' || url.protocol === 'blob:') {
      await route.continue();
    } else {
      await route.abort();
    }
  });
}

async function expectGerman(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('lang', /^de(?:-DE)?$/);
  expect(await page.evaluate(() => navigator.language)).toBe('en-US');
  expect(await page.evaluate(() => window.__LIBRECHAT_CONFIG__)).toMatchObject({
    appTitle,
    appVersion: version,
    fixedLocale: 'de-DE',
  });
}

async function expectNoOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(1);
}

async function expectCenteredLoginLayout(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  const main = page.getByRole('main');
  const heading = main.getByRole('heading', { name: 'Willkommen zurück', exact: true });
  const logo = main.getByRole('img', { name: appTitle, exact: true });
  const [mainBox, logoBox, headingBox, cardBox] = await Promise.all([
    main.boundingBox(),
    logo.boundingBox(),
    heading.boundingBox(),
    heading.locator('..').boundingBox(),
  ]);
  if (!mainBox || !logoBox || !headingBox || !cardBox) {
    throw new Error('Login must have measurable main, logo, heading and form card');
  }
  const padding = await main.evaluate((element) => {
    const style = getComputedStyle(element);
    const shell = element.parentElement;
    if (!shell) throw new Error('Login main must belong to its authentication shell');
    const shellBox = shell.getBoundingClientRect();
    const footer = shell.querySelector<HTMLElement>(':scope > [role="contentinfo"]');
    const footerBox = footer?.getBoundingClientRect();
    const footerStyle = footer && getComputedStyle(footer);
    return {
      top: parseFloat(style.paddingTop),
      bottom: parseFloat(style.paddingBottom),
      expected: matchMedia('(min-width: 640px)').matches ? 48 : 32,
      shellHeight: shellBox.height,
      viewportHeight: window.innerHeight,
      shellBottom: shellBox.bottom,
      footerTop:
        footerBox && footerStyle
          ? footerBox.top - parseFloat(footerStyle.marginTop)
          : shellBox.bottom,
      footerBottom:
        footerBox && footerStyle
          ? footerBox.bottom + parseFloat(footerStyle.marginBottom)
          : shellBox.bottom,
    };
  });
  // The shell may grow for long content; main must consume its remaining space above the footer.
  expect(padding.shellHeight).toBeGreaterThanOrEqual(padding.viewportHeight - 1);
  expect(
    Math.abs(mainBox.y + mainBox.height - padding.footerTop),
    'Login main must reach the footer or shell edge',
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(padding.footerBottom - padding.shellBottom),
    'The footer must end at the authentication shell edge',
  ).toBeLessThanOrEqual(1);
  // Center the complete logo/card block inside main; the footer is outside this region.
  const above = logoBox.y - mainBox.y;
  const below = mainBox.y + mainBox.height - (cardBox.y + cardBox.height);
  expect(
    Math.abs(above - below),
    'Logo and form must share vertical centering',
  ).toBeLessThanOrEqual(2);
  expect(above).toBeGreaterThanOrEqual(padding.expected - 1);
  expect(below).toBeGreaterThanOrEqual(padding.expected - 1);
  expect(padding.top).toBe(padding.expected);
  expect(padding.bottom).toBe(padding.expected);
  expect(
    Math.abs(headingBox.y - (logoBox.y + logoBox.height) - 40),
    'The visible heading must start approximately 40px below the logo',
  ).toBeLessThanOrEqual(1);
  for (const box of [logoBox, cardBox]) {
    expect(
      Math.abs(box.x + box.width / 2 - (mainBox.x + mainBox.width / 2)),
      'Logo and form must share horizontal centering',
    ).toBeLessThanOrEqual(1);
  }
}

async function openSettings(page: Page) {
  const account = page.getByTestId('nav-user');
  const drawer = page.locator('#mobile-drawer');
  const hasMobileDrawer = (await drawer.count()) > 0;
  const needsOpen = hasMobileDrawer
    ? (await drawer.getAttribute('inert')) !== null
    : !(await account.isVisible());
  if (needsOpen) {
    await page.getByRole('button', { name: 'Seitenleiste öffnen', exact: true }).click();
    if (hasMobileDrawer) {
      // The deferred drawer commit removes inert and hands focus to its close button.
      await expect(drawer).not.toHaveAttribute('inert', '');
      await expect(page.getByTestId('close-sidebar-button')).toBeFocused();
    }
  }
  await expect(account).toBeVisible();
  await account.focus();
  await expect(account).toBeFocused();
  await account.press('Enter');
  await expect(account).toHaveAttribute('aria-expanded', 'true');
  const settings = page.getByTestId('nav-settings');
  await expect(page.getByRole('menu').filter({ has: settings })).toBeVisible();
  await expect(settings).toBeVisible();
  await expect(settings).toHaveText('Einstellungen');
  await settings.focus();
  await expect(settings).toBeFocused();
  await settings.press('Enter');
  await expect(
    page.getByRole('dialog').getByRole('heading', { name: 'Einstellungen', exact: true }),
  ).toBeVisible();
}

test('German presentation survives old English preferences, login, settings, reload and sharing', async ({
  page,
  context,
  browser,
  baseURL,
  isMobile,
}, testInfo) => {
  if (!baseURL) throw new Error('Presentation requires its isolated baseURL');
  await prepareEnglish(context, baseURL, isMobile);
  await page.goto('/login');
  await expectGerman(page);
  await expect(page).toHaveTitle(appTitle);
  await expect(page.getByRole('heading', { name: 'Willkommen zurück', exact: true })).toBeVisible();
  const logo = page.getByRole('img', { name: appTitle, exact: true });
  await expect(logo).toBeVisible();
  await expect
    .poll(() =>
      logo.evaluate(
        (image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
      ),
    )
    .toBe(true);
  await expect(page.getByRole('form', { name: 'Anmeldeformular' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hohen Kontrast umschalten' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Wert anzeigen' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Benachrichtigungen (F8)' })).toBeAttached();
  await expectNoOverflow(page);
  await expectCenteredLoginLayout(page);
  await page.screenshot({ path: testInfo.outputPath('presentation-login.png') });

  const email = `presentation-${randomUUID()}@example.invalid`;
  const password = `Presentation-${randomUUID()}!`;
  const registered = await page.request.post('/api/auth/register', {
    data: { name: 'Presentation User', email, password, confirm_password: password },
  });
  expect(registered.ok()).toBeTruthy();
  const emailInput = page.getByRole('textbox', { name: 'E-Mail', exact: true });
  await emailInput.fill(email);
  await emailInput.press('Tab');
  const passwordInput = page.getByLabel('Passwort', { exact: true });
  await expect(passwordInput).toBeFocused();
  await passwordInput.fill(password);
  await page.getByTestId('login-button').focus();
  await page.getByTestId('login-button').press('Enter');
  await expect(page).toHaveURL(/\/c\/new$/);
  await expect(
    page.getByRole('textbox', { name: 'Nachrichteneingabe', exact: true }),
  ).toBeVisible();
  await expectGerman(page);
  await expect(page).toHaveTitle(appTitle);
  // The existing mobile layout hides its footer; the About version remains visible on both sizes.
  const footer = page.getByText(`${appTitle} ${version}`, { exact: true });
  await expect(footer).toBeAttached();
  if (!isMobile) await expect(footer).toBeVisible();

  await openSettings(page);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('tab', { name: 'Allgemein', exact: true }).click();
  await expect(dialog.getByText('Design', { exact: true })).toBeVisible();
  // The speech settings tab is also named "Sprache"; only the interface language selector is removed.
  await expect(dialog.getByRole('tabpanel').getByText('Sprache', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('combobox', { name: /Sprache|Language/ })).toHaveCount(0);
  if (isMobile) await dialog.getByRole('button', { name: 'Zurück', exact: true }).click();
  const about = dialog.getByRole('tab', { name: 'Über', exact: true });
  await about.focus();
  await about.press('Enter');
  await expect(dialog.getByText('Version', { exact: true })).toBeVisible();
  await expect(dialog.locator('dd').filter({ hasText: version })).toHaveText(version);
  await expect(
    dialog.getByRole('button', { name: 'Diagnoseinformationen kopieren', exact: true }),
  ).toBeVisible();
  await expectNoOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('presentation-about.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  const conversationId = randomUUID();
  const firstMessageId = randomUUID();
  await seedConversations(email, [
    { conversationId, title: 'LibreChat in meinem eigenen Titel', updatedAt: new Date() },
  ]);
  await seedMessages(email, conversationId, [
    {
      messageId: firstMessageId,
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      text: userText,
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: randomUUID(),
      parentMessageId: firstMessageId,
      text: 'Dies ist eine gespeicherte Testantwort ohne Modellaufruf.',
      isCreatedByUser: false,
      sender: 'Assistant',
    },
  ]);
  await page.goto(`/c/${conversationId}`);
  await expect(
    page.getByTestId('messages-view').getByText(userText, { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByTestId('messages-view').getByText(userText, { exact: true }),
  ).toBeVisible();
  await expectGerman(page);
  await expect(page).toHaveTitle(appTitle);
  await expectNoOverflow(page);

  const token = await getAccessToken(page);
  const created = await page.request.post(`/api/share/${conversationId}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {},
  });
  expect(created.ok()).toBeTruthy();
  const { shareId } = await created.json();
  expect(typeof shareId).toBe('string');

  const publicContext = await browser.newContext({
    baseURL,
    locale: 'en-US',
    viewport: page.viewportSize(),
    isMobile,
    hasTouch: isMobile,
    storageState: { cookies: [], origins: [] },
    serviceWorkers: 'block',
  });
  try {
    await prepareEnglish(publicContext, baseURL, isMobile);
    const shared = await publicContext.newPage();
    await shared.goto(`/share/${shareId}`);
    await expect(
      shared.getByTestId('messages-view').getByText(userText, { exact: true }),
    ).toBeVisible();
    await expectGerman(shared);
    await expect(shared).toHaveTitle(appTitle);
    await shared.getByRole('button', { name: 'Einstellungen', exact: true }).click();
    const sharedSettings = shared.getByRole('dialog');
    await expect(sharedSettings.getByText('Design', { exact: true })).toBeVisible();
    await expect(
      sharedSettings.getByRole('button', { name: 'Schließen', exact: true }),
    ).toBeVisible();
    await expect(sharedSettings.getByText('Sprache', { exact: true })).toHaveCount(0);
    await expect(sharedSettings.getByRole('combobox', { name: /Sprache|Language/ })).toHaveCount(0);
    await expectNoOverflow(shared);
    await shared.keyboard.press('Escape');
    await expect(sharedSettings).toBeHidden();
    await shared.reload();
    await expect(shared.getByText(userText, { exact: true })).toBeVisible();
    await expectGerman(shared);
  } finally {
    await publicContext.close();
  }
});

for (const theme of ['light', 'dark'] as const) {
  test(`email-code ${theme} label remains readable (controlled startup boundary)`, async ({
    page,
    context,
    baseURL,
    isMobile,
  }, testInfo) => {
    if (!baseURL) throw new Error('Presentation requires its isolated baseURL');
    await prepareEnglish(context, baseURL, isMobile);
    // Render the native form without requesting mail from the disabled fixture backend.
    await configureBranding(page, { theme, emailCodeLogin: true });
    await page.goto('/login');
    const form = page.getByRole('region', { name: 'Mit E-Mail-Code anmelden', exact: true });
    await expect(form.getByRole('textbox', { name: 'E-Mail-Adresse', exact: true })).toBeVisible();
    await expectThemedLogo(page.getByRole('img', { name: appTitle, exact: true }), theme);
    await expectReadableAuthText(form.locator('label').filter({ hasText: /^E-Mail-Adresse$/ }));
    await expectCenteredLoginLayout(page);
    await expectNoOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`presentation-email-code-${theme}.png`) });
    const emailInput = form.getByRole('textbox', { name: 'E-Mail-Adresse', exact: true });
    await emailInput.press('Tab');
    const requestCode = form.locator('button[type="submit"]');
    await expect(requestCode).toBeFocused();
    await requestCode.press('Shift+Tab');
    await expect(emailInput).toBeFocused();
  });

  test(`mail route resolves authentication and retains ${theme} branding through rejection and recovery (controlled auth boundary)`, async ({
    page,
    context,
    baseURL,
    isMobile,
  }, testInfo) => {
    if (!baseURL) throw new Error('Presentation requires its isolated baseURL');
    await prepareEnglish(context, baseURL, isMobile);
    await configureBranding(page, { theme });
    const refresh = responseGate();
    const verification = responseGate();
    const requests: Array<{ attemptId: string; code: string }> = [];
    await page.route('**/api/auth/refresh', async (route) => {
      await refresh.ready;
      await route.fulfill({ status: 200, json: {} });
    });
    // The harness disables email-code auth: only this endpoint boundary is simulated.
    await page.route('**/api/auth/email-code/verify', async (route) => {
      requests.push(route.request().postDataJSON());
      await verification.ready;
      await route.fulfill({ status: 400, json: { code: 'EMAIL_CODE_INVALID' } });
    });
    try {
      await clickRenderedMailLink(page, baseURL);
      await expectGerman(page);
      await expect(page).toHaveTitle(appTitle);
      await expect(page.getByRole('main')).toHaveCount(1);
      const status = page.getByRole('main').getByRole('status');
      await expect(status).toHaveText('Anmeldung wird geprüft …');
      expect(requests).toHaveLength(0);
      // The shared API client waits for auth resolution before loading startup branding.
      refresh.release();
      await expect(
        page.getByRole('heading', { name: 'Anmelden mit E-Mail-Code', exact: true }),
      ).toBeVisible();
      const logo = page.getByRole('img', { name: appTitle, exact: true });
      await expectThemedLogo(logo, theme);
      await expect(status).toHaveText('Anmeldung wird geprüft …');
      await expectNoOverflow(page);

      await expect.poll(() => requests.length).toBe(1);
      expect(requests[0]).toEqual({ attemptId: mailAttemptId, code: mailCode });
      await expect(status).toHaveText('Anmeldung wird geprüft …');
      await expectThemedLogo(logo, theme);
      // The real HTML bootstrap consumes the fragment before application resources load.
      expect(new URL(page.url()).hash).toBe('');
      expect(new URL(page.url()).search).toBe('');

      verification.release();
      const alert = page.getByRole('main').getByRole('alert');
      await expect(alert).toHaveText(
        'Dieser Link ist nicht mehr gültig. Fordere einen neuen Code an.',
      );
      await expectReadableAuthText(alert);
      await expect(status).toHaveCount(0);
      await expectThemedLogo(logo, theme);
      const recovery = page.getByRole('link', { name: 'Neuen Code anfordern', exact: true });
      await expect(recovery).toHaveAttribute('href', '/login');
      await expectNoOverflow(page);
      await page.screenshot({
        path: testInfo.outputPath(`presentation-mail-${theme}-recovery.png`),
      });
      await recovery.click();
      await expect(page).toHaveURL(/\/login$/);
      await expect(page.getByRole('form', { name: 'Anmeldeformular' })).toBeVisible();
      await expectThemedLogo(logo, theme);
      expect(requests).toHaveLength(1);
    } finally {
      refresh.release();
      verification.release();
    }
  });
}

test('branded mail route preserves signed-in account confirmation (controlled verification boundary)', async ({
  page,
  context,
  baseURL,
  isMobile,
}, testInfo) => {
  if (!baseURL) throw new Error('Presentation requires its isolated baseURL');
  await prepareEnglish(context, baseURL, isMobile);
  await configureBranding(page, { theme: 'dark' });
  await signInFixture(page);
  const requests: Array<{ attemptId: string; code: string }> = [];
  await page.route('**/api/auth/email-code/verify', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ status: 400, json: { code: 'EMAIL_CODE_INVALID' } });
  });
  await clickRenderedMailLink(page, baseURL);
  await expect(
    page.getByText(
      'Du bist bereits angemeldet. Möchtest du die Anmeldung aus dieser E-Mail verwenden?',
      {
        exact: true,
      },
    ),
  ).toBeVisible();
  await expectThemedLogo(page.getByRole('img', { name: appTitle, exact: true }), 'dark');
  const confirm = page.getByRole('main').getByRole('button', { name: 'Anmelden', exact: true });
  await expect(confirm).toBeEnabled();
  expect(requests).toHaveLength(0);
  await expectNoOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('presentation-mail-confirmation.png') });
  await confirm.click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(
    'Dieser Link ist nicht mehr gültig. Fordere einen neuen Code an.',
  );
  expect(requests).toEqual([{ attemptId: mailAttemptId, code: mailCode }]);
});

for (const centered of [true, false]) {
  test(`chat logo, settled greeting and ${centered ? 'centered' : 'bottom'} composer remain separated`, async ({
    page,
    context,
    baseURL,
    isMobile,
  }, testInfo) => {
    if (!baseURL) throw new Error('Presentation requires its isolated baseURL');
    await prepareEnglish(context, baseURL, isMobile);
    await page.addInitScript(
      (value) => localStorage.setItem('centerFormOnLanding', JSON.stringify(value)),
      centered,
    );
    const fixture: PresentationFixture = { theme: centered ? 'dark' : 'light' };
    await configureBranding(page, fixture);
    await signInFixture(page);
    const greetings = [
      'Willkommen, Presentation User.',
      'Willkommen, alexander.von-der-linden-mustermann-mit-langer-mailadresse.',
      'Guten Morgen, Presentation User. Schön, dass du da bist. Hier ist Platz für deine Fragen, Gedanken und die gemeinsame Arbeit an deinem nächsten Projekt.',
    ];
    for (const [index, greeting] of greetings.entries()) {
      fixture.customWelcome = greeting;
      await page.goto('/c/new');
      await expect(
        page.getByRole('textbox', { name: 'Nachrichteneingabe', exact: true }),
      ).toBeVisible();
      await expectThemedLogo(
        page.getByTestId('landing').getByRole('img', { name: appTitle, exact: true }),
        fixture.theme,
      );
      await expectSettledLanding(page, greeting);
      await page.screenshot({
        path: testInfo.outputPath(
          `presentation-chat-${centered ? 'centered' : 'bottom'}-${index}.png`,
        ),
      });
    }
  });
}

statusCases(configureBranding, signInFixture, prepareEnglish, expectGerman, expectNoOverflow);
