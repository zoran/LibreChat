import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { TFilePreview } from 'librechat-data-provider';

// Actual native application/auth/UI; only the authorized file responses are synthetic.
// This test does not admit an upload or qualify a scanner, model or object store.
test('native file library inspects sources and discards a revoked preview', async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  if (!baseURL) throw new Error('An isolated presentation origin is required');
  const origin = new URL(baseURL).origin;
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.origin === origin || ['data:', 'blob:'].includes(url.protocol)
      ? route.continue()
      : route.abort();
  });
  await context.addInitScript(() => localStorage.setItem('color-theme', 'light'));
  const id = randomUUID();
  const filename = 'Synthetischer Quellenbericht.pdf';
  const first = 'Synthetische Testdaten. Die geprüfte Zahl auf Seite eins ist 42.';
  const second = 'Zweite Testseite: <script>window.sourceExecuted = true</script>';
  const text = `${first}\n\n${second}`;
  const preview: TFilePreview = {
    file_id: id,
    status: 'ready',
    text,
    textFormat: 'text',
    documentStructure: {
      version: 1,
      source: { sha256: 'a'.repeat(64), bytes: 512, mediaType: 'application/pdf' },
      extractor: { name: 'synthetic-browser-fixture', version: '1' },
      pages: [
        { number: 1, kind: 'page' },
        { number: 2, kind: 'page' },
      ],
      elements: [
        { id: 'e1', kind: 'paragraph', start: 0, end: first.length, page: 1, parentId: null },
        {
          id: 'e2',
          kind: 'paragraph',
          start: first.length + 2,
          end: text.length,
          page: 2,
          parentId: null,
        },
      ],
      quality: { status: 'partial', warnings: ['visual_content_not_extracted'] },
    },
  };
  await page.route(/\/api\/files(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: [
        {
          file_id: id,
          filename,
          type: 'application/pdf',
          bytes: 512,
          source: 's3',
          filepath: `/api/files/managed/${id}`,
          embedded: true,
          llmDeliveryPath: 'text',
          status: 'ready',
          context: 'message_attachment',
          updatedAt: '2026-10-17T00:00:00.000Z',
        },
      ],
    }),
  );
  let revoked = false;
  let previews = 0;
  await page.route(`**/api/files/${id}/preview`, (route) => {
    previews++;
    return route.fulfill(
      revoked ? { status: 404, json: { code: 'not_found' } } : { json: preview },
    );
  });
  const email = `source-${randomUUID()}@example.invalid`;
  const password = 'Synthetic-local-only-42!';
  const registered = await page.request.post('/api/auth/register', {
    data: { name: 'Source Test', email, password, confirm_password: password },
  });
  expect(registered.ok()).toBeTruthy();
  const signedIn = await page.request.post('/api/auth/login', { data: { email, password } });
  expect(signedIn.ok()).toBeTruthy();
  await page.goto('/c/new');
  await expect(
    page.getByRole('textbox', { name: 'Nachrichteneingabe', exact: true }),
  ).toBeVisible();
  if (!(await page.getByTestId('nav-user').isVisible())) {
    await page.getByRole('button', { name: 'Seitenleiste öffnen', exact: true }).click();
  }
  await page.getByTestId('nav-user').click();
  await page.getByTestId('nav-files').click();
  const library = page.getByRole('dialog', { name: 'Meine Dateien', exact: true });
  await expect(library).toBeVisible();
  const row = library.getByRole('row').filter({ hasText: filename });
  const open = row.getByRole('button', { name: /Vorschau/ });
  await open.focus();
  await open.press('Enter');
  const source = page.getByRole('region', { name: 'Dokumentquelle', exact: true });
  await expect(source).toBeVisible();
  await expect(
    source.getByText('Die Extraktion ist unvollständig.', { exact: true }),
  ).toBeVisible();
  await expect(source.getByLabel('Extrahierter Text', { exact: true })).toHaveText(first);
  await source.getByRole('button', { name: 'Weiter (Seite)', exact: true }).click();
  await expect(source.getByText('Seite 2 von 2', { exact: true })).toBeVisible();
  await expect(source.getByLabel('Extrahierter Text', { exact: true })).toHaveText(second);
  expect(await page.evaluate(() => Object.hasOwn(window, 'sourceExecuted'))).toBe(false);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('native-source-view.png') });
  await page.keyboard.press('Escape');
  await expect(source).toHaveCount(0);
  await expect(open).toBeFocused();
  const successfulRequests = previews;
  revoked = true;
  await open.press('Enter');
  await expect.poll(() => previews).toBeGreaterThan(successfulRequests);
  await expect(source).toHaveCount(0);
  await expect(page.getByText(first, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Erneut versuchen', exact: true })).toBeVisible();
});
