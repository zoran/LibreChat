import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { seedConversations, seedMessages } from '../specs/mock/db';
import { getAccessToken } from '../specs/mock/helpers';

const appTitle = 'Example Workplace';
const version = 'v1.2.3+example.1';
const userText = 'Meine Notiz über LibreChat bleibt unverändert.';

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

async function openSettings(page: Page) {
  if (!(await page.getByTestId('nav-user').isVisible())) {
    await page.getByRole('button', { name: 'Seitenleiste öffnen', exact: true }).click();
  }
  await page.getByTestId('nav-user').focus();
  await page.getByTestId('nav-user').press('Enter');
  const settings = page.getByTestId('nav-settings');
  await expect(settings).toHaveText('Einstellungen');
  await settings.focus();
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
  await page.screenshot({ path: testInfo.outputPath('presentation-login.png') });

  const email = `presentation-${randomUUID()}@example.invalid`;
  const password = 'Local-fixture-only-42!';
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
