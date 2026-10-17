import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { Page, Response } from '@playwright/test';
import { seedConversations, seedMessages, withMongo } from '../specs/mock/db';

const title = 'Synthetischer Arbeitsentwurf';
const isSave = (response: Response) =>
  response.request().method() === 'POST' && response.url().includes('/api/messages/artifact/');

async function openEditor(page: Page, conversationId: string) {
  await page.goto(`/c/${conversationId}`);
  await page
    .getByRole('main')
    .getByRole('button', { name: new RegExp(title) })
    .click();
  const panel = page.locator('#artifact-viewer');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('aria-label', title);
  await expect(panel).toHaveAttribute('role', /^(dialog|region)$/);
  const code = panel.getByRole('radio', { name: 'Code', exact: true });
  await expect(code).toBeVisible();
  await expect(code).toBeEnabled();
  await code.click();
  await expect(code).toBeChecked();
  const editor = panel.locator('#artifacts-code .monaco-editor').first();
  await expect(editor).toBeVisible({ timeout: 30_000 });
  return { panel, editor };
}

// Actual native authentication, artifact route, Mongo persistence and compiled editor.
// Only the initial conversation is synthetic; no model request, upload or live system.
test('native artifact edits retain a stale tab draft until explicit reconciliation', async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  if (!baseURL) throw new Error('An isolated presentation origin is required');
  const origin = new URL(baseURL).origin;
  const blockedOutsideOriginRequests: {
    origin: string;
    method: string;
    resourceType: string;
  }[] = [];
  await context.route('**/*', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) {
      return route.continue();
    }
    // Record attempted external dependencies without content, query strings or credentials.
    blockedOutsideOriginRequests.push({
      origin: url.origin,
      method: request.method(),
      resourceType: request.resourceType(),
    });
    return route.abort();
  });
  await context.addInitScript(() => localStorage.setItem('color-theme', 'light'));
  const email = `artifact-${randomUUID()}@example.invalid`;
  const password = 'Synthetic-local-only-42!';
  expect(
    (
      await page.request.post('/api/auth/register', {
        data: { name: 'Artifact Test', email, password, confirm_password: password },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (await page.request.post('/api/auth/login', { data: { email, password } })).ok(),
  ).toBeTruthy();
  const conversationId = randomUUID();
  const userMessageId = randomUUID();
  const messageId = randomUUID();
  const text = `:::artifact{identifier="synthetic-draft" type="text/plain" title="${title}"}
Synthetischer Grundtext.
:::`;
  await seedConversations(email, [{ conversationId, title, updatedAt: new Date() }]);
  await seedMessages(email, conversationId, [
    {
      messageId: userMessageId,
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      text: 'Synthetischer Auftrag für einen Arbeitsentwurf.',
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId,
      parentMessageId: userMessageId,
      text,
      isCreatedByUser: false,
      sender: 'Assistant',
    },
  ]);
  const secondPage = await context.newPage();
  try {
    const first = await openEditor(page, conversationId);
    const second = await openEditor(secondPage, conversationId);
    await first.editor.click();
    await page.keyboard.press('Control+End');
    const [firstSave] = await Promise.all([
      page.waitForResponse(isSave),
      page.keyboard.type(' ERSTE-FASSUNG'),
    ]);
    expect(firstSave.status()).toBe(200);
    expect(firstSave.request().postDataJSON()).toMatchObject({ expectedVersion: 0 });
    const firstSaved = (await firstSave.json()) as { __v: number };
    expect(firstSaved.__v).toBe(1);

    let secondAttempts = 0;
    secondPage.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/messages/artifact/')) {
        secondAttempts++;
      }
    });
    await second.editor.click();
    await secondPage.keyboard.press('Control+End');
    const [conflict] = await Promise.all([
      secondPage.waitForResponse(isSave),
      secondPage.keyboard.type(' MEIN-ENTWURF'),
    ]);
    expect(conflict.status()).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'MESSAGE_VERSION_CONFLICT' });
    await expect(second.panel.locator('#artifacts-code')).toContainText('MEIN-ENTWURF');
    const attemptsAtConflict = secondAttempts;
    await secondPage.waitForTimeout(1_200);
    expect(secondAttempts).toBe(attemptsAtConflict);
    const beforeDecision = await withMongo((db) =>
      db.collection('messages').findOne({ messageId }, { projection: { text: 1, __v: 1 } }),
    );
    expect(beforeDecision?.text).toContain('ERSTE-FASSUNG');
    expect(beforeDecision?.text).not.toContain('MEIN-ENTWURF');
    expect(beforeDecision?.__v).toBe(1);

    // Accessible labels are shared with the actual German conflict UI.
    await second.panel
      .getByRole('button', { name: 'Gespeicherten Stand vergleichen', exact: true })
      .click();
    await expect(second.panel.getByText('ERSTE-FASSUNG', { exact: false }).first()).toBeVisible();
    await expect(second.panel.getByText('MEIN-ENTWURF', { exact: false }).first()).toBeVisible();
    expect(
      await secondPage.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await secondPage.screenshot({ path: testInfo.outputPath('native-artifact-conflict.png') });
    const [resolved] = await Promise.all([
      secondPage.waitForResponse(isSave),
      second.panel
        .getByRole('button', { name: 'Meinen Entwurf auf diesen Stand anwenden', exact: true })
        .click(),
    ]);
    expect(resolved.status()).toBe(200);
    expect(resolved.request().postDataJSON()).toMatchObject({ expectedVersion: firstSaved.__v });
    expect((await resolved.json()).__v).toBe(2);
    const stored = await withMongo((db) =>
      db.collection('messages').findOne({ messageId }, { projection: { text: 1, __v: 1 } }),
    );
    expect(stored?.__v).toBe(2);
    expect(stored?.text).toContain('MEIN-ENTWURF');
    expect(stored?.text).not.toContain('ERSTE-FASSUNG');
    const restored = await openEditor(secondPage, conversationId);
    await expect(restored.panel.locator('#artifacts-code')).toContainText('MEIN-ENTWURF');
  } finally {
    await secondPage.close();
    await testInfo.attach('blocked-outside-origin-requests', {
      body: JSON.stringify(blockedOutsideOriginRequests, null, 2),
      contentType: 'application/json',
    });
    expect
      .soft(
        blockedOutsideOriginRequests,
        'The native editor must not attempt an external Monaco CDN or Sandpack fallback',
      )
      .toEqual([]);
  }
});
