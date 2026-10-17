import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { SourceCoverage, TFilePreview } from 'librechat-data-provider';
import { seedConversations, seedMessages, withMongo } from '../specs/mock/db';
import { getAccessToken } from '../specs/mock/helpers';

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

// Synthetic stored metadata exercises the native presentation only. Trusted producer,
// write authorization, source retention and deletion are covered by their actual owner tests.
test('native answers keep prepared source coverage local across reload and removal', async ({
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
  const email = `coverage-${randomUUID()}@example.invalid`;
  const password = 'Synthetic-local-only-42!';
  expect(
    (
      await page.request.post('/api/auth/register', {
        data: { name: 'Coverage Test', email, password, confirm_password: password },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (await page.request.post('/api/auth/login', { data: { email, password } })).ok(),
  ).toBeTruthy();
  const conversationId = randomUUID();
  const userMessageId = randomUUID();
  const responseMessageId = randomUUID();
  const secondUserMessageId = randomUUID();
  const secondResponseId = randomUUID();
  const lastUserMessageId = randomUUID();
  const coverage: SourceCoverage = {
    version: 1,
    stage: 'prepared',
    scope: 'retained_sources',
    entries: [
      {
        file_id: randomUUID(),
        source: { kind: 'message', id: userMessageId },
        coverage: { unit: 'utf16', start: 0, end: 50, total: 100, complete: false },
        extraction: 'not_assessed',
      },
      {
        file_id: randomUUID(),
        source: { kind: 'steer', id: randomUUID() },
        coverage: { unit: 'utf16', start: 0, end: 80, total: 80, complete: true },
        extraction: 'not_assessed',
      },
    ],
  };
  await seedConversations(email, [
    { conversationId, title: 'Quellenabdeckung im Chat', updatedAt: new Date() },
  ]);
  await seedMessages(email, conversationId, [
    {
      messageId: userMessageId,
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      text: 'Synthetischer Vergleichsauftrag.',
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: responseMessageId,
      parentMessageId: userMessageId,
      text: 'Gespeicherte Testantwort mit begrenztem Quelltext.',
      content: [{ type: 'text', text: 'Gespeicherte Testantwort mit begrenztem Quelltext.' }],
      isCreatedByUser: false,
      sender: 'Assistant',
    },
    {
      messageId: secondUserMessageId,
      parentMessageId: responseMessageId,
      text: 'Prüfe denselben Text noch einmal.',
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: secondResponseId,
      parentMessageId: secondUserMessageId,
      text: 'Weitere gespeicherte Antwort im klassischen Textformat.',
      isCreatedByUser: false,
      sender: 'Assistant',
    },
    {
      messageId: lastUserMessageId,
      parentMessageId: secondResponseId,
      text: 'Eine Folgefrage ohne Quellen.',
      isCreatedByUser: true,
      sender: 'User',
    },
    {
      messageId: randomUUID(),
      parentMessageId: lastUserMessageId,
      text: 'Diese Antwort hat keinen Quellennachweis.',
      isCreatedByUser: false,
      sender: 'Assistant',
    },
  ]);
  await withMongo(async (db) => {
    // User metadata is deliberately hostile UI input; it is not an authorized production write.
    const messages = db.collection('messages');
    await messages.updateMany(
      { conversationId, messageId: { $in: [userMessageId, responseMessageId, secondResponseId] } },
      { $set: { metadata: { sourceCoverage: coverage } } },
    );
  });
  let previewRequests = 0;
  page.on('request', (request) => {
    if (/\/api\/files\/[^/]+\/preview/.test(new URL(request.url()).pathname)) previewRequests++;
  });
  await page.goto(`/c/${conversationId}`);
  await expect(
    page.getByText('Diese Antwort hat keinen Quellennachweis.', { exact: true }),
  ).toBeVisible();
  const summary = page.locator('summary').filter({ hasText: /^Vorbereiteter Quelltext$/ });
  await expect(summary).toHaveCount(2);
  const prepared = summary.first();
  await prepared.scrollIntoViewIfNeeded();
  await prepared.focus();
  await prepared.press('Enter');
  const details = prepared.locator('..');
  await expect(details).toHaveAttribute('open', '');
  await expect(details.getByText(/Teil des verfügbaren Textes vorbereitet/)).toBeVisible();
  await expect(details.getByText(/Gesamter verfügbarer Text vorbereitet/)).toBeVisible();
  await expect(details).toContainText(/50\s*%/);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('native-answer-source-coverage.png') });
  await page.reload();
  await expect(summary).toHaveCount(2);
  await summary.last().click();
  await expect(summary.last().locator('..')).toContainText(/50\s*%/);
  await prepared.click();
  await expect(details).toContainText(/50\s*%/);
  expect(previewRequests).toBe(0);

  const token = await getAccessToken(page);
  const shared = await page.request.post(`/api/share/${conversationId}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {},
  });
  expect(shared.ok()).toBeTruthy();
  const { shareId } = await shared.json();
  await page.goto(`/share/${shareId}`);
  await expect(
    page.getByText('Gespeicherte Testantwort mit begrenztem Quelltext.', { exact: true }),
  ).toBeVisible();
  await expect(summary).toHaveCount(0);

  await withMongo((db) =>
    db
      .collection('messages')
      .updateMany(
        { conversationId, messageId: { $in: [responseMessageId, secondResponseId] } },
        { $unset: { metadata: '' } },
      ),
  );
  await page.goto(`/c/${conversationId}`);
  await expect(
    page.getByText('Gespeicherte Testantwort mit begrenztem Quelltext.', { exact: true }),
  ).toBeVisible();
  await expect(summary).toHaveCount(0);
  expect(previewRequests).toBe(0);
});

// Real native project/auth/picker UI; file metadata and approved-source responses below
// are synthetic backend fixtures, not uploads or claims about scanner/RAG authorization.
test('native project sources and picker preview exact files without attaching', async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  if (!baseURL) throw new Error('An isolated presentation origin is required');
  const origin = new URL(baseURL).origin;
  const externalRequests: string[] = [];
  const mutations: string[] = [];
  const previews: string[] = [];
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) {
      return route.continue();
    }
    externalRequests.push(url.href);
    return route.abort();
  });
  await context.addInitScript(() => localStorage.setItem('color-theme', 'light'));
  await page.route(
    (url) => url.pathname === '/api/config',
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), ragEnabled: true } });
    },
  );
  const filename = `${'Synthetischer langer Quellenname '.repeat(6)}.txt`;
  const attachedIds = [randomUUID(), randomUUID()];
  const pickerIds = [randomUUID(), randomUUID()];
  const unavailableId = randomUUID();
  await page.route(/\/api\/projects\/[^/]+\/files(?:\/[^/?]+)?(?:\?.*)?$/, (route) => {
    if (route.request().method() !== 'GET') {
      mutations.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
      return route.abort();
    }
    if (new URL(route.request().url()).pathname.endsWith('/available')) {
      return route.fulfill({
        json: {
          files: pickerIds.map((file_id) => ({
            file_id,
            filename,
            type: 'text/plain',
            bytes: 128,
            source: 's3',
            embedded: true,
            context: 'message_attachment',
            llmDeliveryPath: 'text',
            status: 'ready',
            updatedAt: '2026-10-17T00:00:00.000Z',
          })),
          nextCursor: null,
        },
      });
    }
    return route.fulfill({
      json: [
        ...attachedIds.map((file_id) => ({
          file_id,
          filename,
          availability: 'ready',
          type: 'text/plain',
          bytes: 128,
          llmDeliveryPath: 'text',
        })),
        {
          file_id: unavailableId,
          filename: 'Nicht verfügbare Quelle.txt',
          availability: 'unavailable',
        },
      ],
    });
  });
  for (const fileId of [...attachedIds, ...pickerIds]) {
    await page.route(`**/api/files/${fileId}/preview`, (route) => {
      previews.push(fileId);
      return route.fulfill({
        json: {
          file_id: fileId,
          status: 'ready',
          textFormat: 'text',
          text: `Synthetischer freigegebener Quelltext ${fileId}`,
        } satisfies TFilePreview,
      });
    });
  }
  const email = `project-source-${randomUUID()}@example.invalid`;
  const password = 'Synthetic-local-only-42!';
  expect(
    (
      await page.request.post('/api/auth/register', {
        data: { name: 'Project Source Test', email, password, confirm_password: password },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (await page.request.post('/api/auth/login', { data: { email, password } })).ok(),
  ).toBeTruthy();
  await page.goto('/projects');
  await page.getByRole('button', { name: 'Neues Projekt', exact: true }).first().click();
  const create = page.getByRole('dialog');
  await create
    .getByRole('textbox', { name: 'Projektname', exact: true })
    .fill('Synthetische Projektquellen');
  await create.getByRole('button', { name: 'Projekt erstellen', exact: true }).click();
  const resources = page.getByRole('region', { name: 'Dateien', exact: true });
  await expect(resources).toBeVisible();
  await expect(
    resources.getByRole('button', { name: 'Vorschau von Nicht verfügbare Quelle.txt' }),
  ).toHaveCount(0);
  const projectOpen = resources
    .getByRole('button', { name: `Vorschau von ${filename}`, exact: true })
    .nth(1);
  await expect(projectOpen).toHaveAttribute('title', filename);
  await projectOpen.focus();
  await projectOpen.press('Enter');
  const preview = page.getByRole('dialog', { name: filename, exact: true });
  await expect(
    preview.getByText(`Synthetischer freigegebener Quelltext ${attachedIds[1]}`, { exact: true }),
  ).toBeVisible();
  expect(previews).toEqual([attachedIds[1]]);
  expect(mutations).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('native-project-source.png') });
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(projectOpen).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('native-project-resources.png') });
  const addFiles = resources.getByRole('button', { name: 'Dateien hinzufügen', exact: true });
  await addFiles.click();
  await page.getByRole('menuitem', { name: 'Aus deinen Dateien auswählen', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Aus deinen Dateien auswählen', exact: true });
  await expect(picker).toBeVisible();
  const pickerOpen = picker
    .getByRole('button', { name: `Vorschau von ${filename}`, exact: true })
    .nth(1);
  await pickerOpen.focus();
  await pickerOpen.press('Enter');
  await expect(
    preview.getByText(`Synthetischer freigegebener Quelltext ${pickerIds[1]}`, { exact: true }),
  ).toBeVisible();
  expect(previews).toEqual([attachedIds[1], pickerIds[1]]);
  expect(mutations).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('native-project-picker-source.png') });
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(picker).toBeVisible();
  await expect(pickerOpen).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(addFiles).toBeFocused();
  expect(mutations).toEqual([]);
  expect(externalRequests).toEqual([]);
  await testInfo.attach('synthetic-backend-boundary', {
    body: JSON.stringify({
      previews,
      mutations,
      externalRequests,
      backend: 'synthetic file responses; actual native auth/project/UI',
    }),
    contentType: 'application/json',
  });
});
