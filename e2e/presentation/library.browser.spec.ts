import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Locator, Page, TestInfo } from '@playwright/test';
import { FileContext, FileSources } from 'librechat-data-provider';
import type { FileLibraryItem, FileLibraryPage, FileLibraryUpdate } from 'librechat-data-provider';
import de from '../../client/src/locales/de/translation.json';

// The existing presentation owner supplies native local authentication and the compiled UI.
// Library metadata, original deletion and project membership below are explicit HTTP boundary
// fixtures. These cases do not qualify storage, server ACL, production flags or real email.
const cursor = '0123456789abcdef01234567';
const projectId = '0123456789abcdef01234568';
const stamp = '2026-10-17T00:00:00.000Z';
const label = (key: keyof typeof de, value: string | number) =>
  de[key].replace('{{0}}', String(value));
const button = (scope: Page | Locator, name: string) =>
  scope.getByRole('button', { name, exact: true });
const checkbox = (scope: Locator, file: FileLibraryItem) =>
  scope.getByRole('checkbox', {
    name: label('com_library_select_file', file.filename),
    exact: true,
  });

function files(count: number): FileLibraryItem[] {
  return Array.from({ length: count }, (_, index) => ({
    file_id: randomUUID(),
    filename: `Nachweis-${String(index + 1).padStart(2, '0')}.txt`,
    type: 'text/plain',
    bytes: 128,
    source: FileSources.local,
    context: FileContext.message_attachment,
    createdAt: stamp,
    updatedAt: stamp,
    expiredAt: null,
    status: 'ready',
    embedded: true,
    filepath: `/api/files/download/synthetic-${index}`,
    user: 'synthetic-library-owner',
    object: 'file',
    usage: 0,
    llmDeliveryPath: 'text',
    library: { tags: [], archivedAt: null, revision: 0 },
  }));
}

async function prepare(
  page: Page,
  context: BrowserContext,
  baseURL: string | undefined,
  theme: 'light' | 'dark',
) {
  if (!baseURL) throw new Error('An isolated presentation origin is required');
  const origin = new URL(baseURL);
  if (
    origin.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) ||
    origin.username ||
    origin.password
  ) {
    throw new Error('Synthetic library authentication requires an HTTP loopback origin');
  }
  const blocked: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin.origin || ['data:', 'blob:'].includes(url.protocol)) {
      return route.continue();
    }
    blocked.push(`${route.request().method()} ${url.origin}`);
    return route.abort();
  });
  await context.addInitScript((value) => localStorage.setItem('color-theme', value), theme);
  await page.emulateMedia({ colorScheme: theme });
  const email = `library-${randomUUID()}@example.invalid`;
  const password = 'Synthetic-local-only-42!';
  expect(
    (
      await page.request.post('/api/auth/register', {
        data: { name: 'Library Test', email, password, confirm_password: password },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (await page.request.post('/api/auth/login', { data: { email, password } })).ok(),
  ).toBeTruthy();
  return { blocked, errors };
}

async function catalog(
  page: Page,
  rows: FileLibraryItem[],
  project: object | null = null,
  resolve?: (query: URLSearchParams) => FileLibraryPage,
) {
  const reads: Record<string, string>[] = [];
  await page.route('**/api/files/library?**', async (route) => {
    expect(route.request().method()).toBe('GET');
    const query = new URL(route.request().url()).searchParams;
    reads.push(Object.fromEntries(query));
    expect(Number(query.get('limit'))).toBe(25);
    const archive = query.get('archive');
    const visible = rows.filter((file) =>
      archive === 'all' ? true : Boolean(file.library.archivedAt) === (archive === 'archived'),
    );
    await route.fulfill({
      json: resolve?.(query) ?? { files: visible, nextCursor: null },
    });
  });
  await page.route(/\/api\/projects(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { projects: project ? [project] : [], nextCursor: null } }),
  );
  return reads;
}

async function openPersonalLibrary(page: Page) {
  const account = page.getByTestId('nav-user');
  const drawer = page.locator('#mobile-drawer');
  const hasMobileDrawer = (await drawer.count()) > 0;
  const needsOpen = hasMobileDrawer
    ? (await drawer.getAttribute('inert')) !== null
    : !(await account.isVisible());
  if (needsOpen) {
    await button(page, de.com_nav_open_sidebar).first().click();
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
  const myFiles = page.getByRole('menuitem', { name: de.com_nav_my_files, exact: true });
  await expect(page.getByRole('menu').filter({ has: myFiles })).toBeVisible();
  await expect(myFiles).toBeVisible();
  await myFiles.focus();
  await expect(myFiles).toBeFocused();
  await myFiles.press('Enter');
  const dialog = page.getByRole('dialog', { name: de.com_nav_my_files, exact: true });
  await expect(dialog).toBeVisible();
  await expect(button(dialog, de.com_library_refresh)).toBeEnabled();
  return { dialog, account };
}

async function attach(
  testInfo: TestInfo,
  observation: { blocked: string[]; errors: string[] },
  evidence: object,
) {
  await testInfo.attach('library-http-boundaries', {
    body: JSON.stringify(
      {
        scope: 'Native local auth and compiled UI; synthetic library/project HTTP storage boundary',
        ...observation,
        ...evidence,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
  expect.soft(observation.blocked, 'No external model, email or service requests').toEqual([]);
  expect.soft(observation.errors, 'No browser execution errors').toEqual([]);
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`native library ${theme}`, () => {
    test('server paging, tag conflict draft and reversible archive', async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      const observation = await prepare(page, context, baseURL, theme);
      const rows = files(2);
      const first = rows[0];
      const updates: FileLibraryUpdate[] = [];
      const reads = await catalog(page, rows, null, (query) => {
        if (query.get('search') === 'gefiltert') {
          // Authorization filtering can produce an empty page before a valid later cursor.
          return query.has('cursor')
            ? { files: [first], nextCursor: null }
            : { files: [], nextCursor: cursor };
        }
        return {
          files: rows.filter(
            (file) => Boolean(file.library.archivedAt) === (query.get('archive') === 'archived'),
          ),
          nextCursor: null,
        };
      });
      await page.route(`**/api/files/${first.file_id}/library`, async (route) => {
        expect(route.request().method()).toBe('PATCH');
        const update: FileLibraryUpdate = route.request().postDataJSON();
        updates.push(update);
        if (updates.length === 1) {
          expect(update).toEqual({ expectedRevision: 0, tags: ['Entwurf', 'Prüfung'] });
          first.library = { tags: ['Serverfassung'], archivedAt: null, revision: 1 };
          return route.fulfill({ status: 409, json: { code: 'revision_conflict' } });
        }
        expect(update.expectedRevision).toBe(first.library.revision);
        let archivedAt = first.library.archivedAt;
        if (update.archived !== undefined) archivedAt = update.archived ? stamp : null;
        first.library = {
          tags: update.tags ?? first.library.tags,
          archivedAt,
          revision: first.library.revision + 1,
        };
        return route.fulfill({ json: first.library });
      });
      try {
        await page.goto('/c/new');
        await expect(
          page.getByRole('textbox', { name: 'Nachrichteneingabe', exact: true }),
        ).toBeVisible();
        const { dialog, account } = await openPersonalLibrary(page);
        await checkbox(dialog, rows[1]).click();
        await dialog.getByLabel(de.com_library_search, { exact: true }).fill('gefiltert');
        await button(dialog, de.com_library_apply).click();
        await expect(dialog.getByText(de.com_files_no_results, { exact: true })).toBeVisible();
        await expect(button(dialog, de.com_library_next)).toBeEnabled();
        await button(dialog, de.com_library_next).click();
        await expect(checkbox(dialog, first)).not.toBeChecked();
        expect(reads.at(-1)).toMatchObject({ search: 'gefiltert', cursor, limit: '25' });
        await expect(button(dialog, de.com_library_previous)).toBeEnabled();
        await dialog.getByLabel(de.com_library_search, { exact: true }).fill('');
        await button(dialog, de.com_library_apply).click();
        await expect(button(dialog, de.com_library_previous)).toBeDisabled();
        await checkbox(dialog, first).click();
        await button(dialog, de.com_library_edit_tags).click();
        const draft = dialog.getByRole('textbox', {
          name: label('com_library_edit_tags_for', first.filename),
          exact: true,
        });
        await draft.fill('Entwurf\nPrüfung');
        await button(dialog, de.com_ui_save).click();
        await expect(dialog.getByRole('alert')).toHaveText(de.com_library_tags_conflict);
        await expect(draft).toHaveValue('Entwurf\nPrüfung');
        await expect(button(dialog, de.com_ui_save)).toBeDisabled();
        await expect(
          dialog.getByText(label('com_library_current_tags', 'Serverfassung')),
        ).toBeVisible();
        expect(updates).toHaveLength(1);
        await page.screenshot({ path: testInfo.outputPath('library-tag-conflict.png') });
        await button(dialog, de.com_library_reviewed).click();
        await button(dialog, de.com_ui_save).click();
        await expect(draft).toHaveCount(0);
        expect(updates[1]).toEqual({ expectedRevision: 1, tags: ['Entwurf', 'Prüfung'] });
        await button(dialog, de.com_library_archive).click();
        await expect(checkbox(dialog, first)).toHaveCount(0);
        await dialog.getByLabel(de.com_library_view, { exact: true }).selectOption('archived');
        await button(dialog, de.com_library_apply).click();
        await checkbox(dialog, first).click();
        await button(dialog, de.com_library_restore).click();
        await expect(checkbox(dialog, first)).toHaveCount(0);
        await dialog.getByLabel(de.com_library_view, { exact: true }).selectOption('active');
        await button(dialog, de.com_library_apply).click();
        await expect(checkbox(dialog, first)).toBeVisible();
        expect(first.library).toEqual({
          tags: ['Entwurf', 'Prüfung'],
          archivedAt: null,
          revision: 4,
        });
        expect(updates.slice(2)).toEqual([
          { expectedRevision: 2, archived: true },
          { expectedRevision: 3, archived: false },
        ]);
        await dialog.getByLabel(de.com_library_search, { exact: true }).focus();
        for (let step = 0; step < 6; step++) {
          await page.keyboard.press('Shift+Tab');
          expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(
            true,
          );
        }
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
        ).toBeLessThanOrEqual(1);
        await page.screenshot({ path: testInfo.outputPath('library-restored.png') });
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(account).toBeFocused();
      } finally {
        await attach(testInfo, observation, { reads, updates });
      }
    });

    test('native project picker retains partial selection and reconciles an unknown write', async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      const observation = await prepare(page, context, baseURL, theme);
      const rows = files(3);
      const project = {
        _id: projectId,
        name: 'Synthetisches Bibliotheksprojekt',
        description: '',
        instructions: '',
        file_ids: [] as string[],
        conversationCount: 0,
        fileCount: 0,
        createdAt: stamp,
        updatedAt: stamp,
      };
      const posts: string[] = [];
      const membershipReads: string[] = [];
      let denyReads = false;
      let retryAllowed = false;
      const reads = await catalog(page, rows, project);
      await page.route('**/api/config', async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...(await response.json()), ragEnabled: true } });
      });
      await page.route(new RegExp(`/api/projects/${projectId}(?:/files)?$`), async (route) => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (request.method() === 'POST') {
          const { file_id: fileId } = request.postDataJSON();
          expect(request.postDataJSON()).toEqual({ file_id: fileId });
          posts.push(fileId);
          if (fileId === rows[1].file_id && !retryAllowed) {
            return route.fulfill({ status: 409, json: { message: 'Synthetic known refusal' } });
          }
          project.file_ids = [...new Set([...project.file_ids, fileId])];
          project.fileCount = project.file_ids.length;
          if (fileId === rows[2].file_id && !retryAllowed) {
            denyReads = true;
            return route.abort('failed');
          }
          return route.fulfill({ json: project });
        }
        expect(request.method()).toBe('GET');
        membershipReads.push(pathname);
        if (denyReads)
          return route.fulfill({ status: 503, json: { message: 'Synthetic unavailable read' } });
        return route.fulfill({
          json: pathname.endsWith('/files')
            ? rows
                .filter((file) => project.file_ids.includes(file.file_id))
                .map((file) => ({
                  file_id: file.file_id,
                  filename: file.filename,
                  type: file.type,
                  bytes: file.bytes,
                  availability: 'ready',
                }))
            : project,
        });
      });
      try {
        await page.goto(`/projects/${projectId}`);
        await button(page, de.com_ui_project_add_files).click();
        await page
          .getByRole('menuitem', { name: de.com_ui_project_choose_file, exact: true })
          .click();
        const dialog = page.getByRole('dialog', {
          name: de.com_ui_project_choose_file,
          exact: true,
        });
        await expect(dialog).toBeVisible();
        await expect(
          dialog.getByRole('combobox', { name: de.com_library_project_choose, exact: true }),
        ).toHaveCount(0);
        await dialog
          .getByRole('checkbox', { name: de.com_library_select_page, exact: true })
          .click();
        await button(dialog, de.com_library_project_add).click();
        await expect(button(dialog, de.com_library_project_reconcile)).toBeEnabled();
        await expect(button(dialog, de.com_library_project_add)).toBeDisabled();
        await expect(checkbox(dialog, rows[0])).not.toBeChecked();
        await expect(checkbox(dialog, rows[1])).toBeChecked();
        await expect(checkbox(dialog, rows[2])).toBeChecked();
        expect(posts).toEqual(rows.map((file) => file.file_id));
        await page.screenshot({ path: testInfo.outputPath('library-project-unknown.png') });
        denyReads = false;
        await button(dialog, de.com_library_project_reconcile).click();
        await expect(button(dialog, de.com_library_project_reconcile)).toHaveCount(0);
        await expect(checkbox(dialog, rows[2])).not.toBeChecked();
        await expect(checkbox(dialog, rows[1])).toBeChecked();
        expect(posts).toHaveLength(3);
        retryAllowed = true;
        await button(dialog, de.com_library_project_retry).click();
        await expect(checkbox(dialog, rows[1])).not.toBeChecked();
        expect(posts).toEqual([...rows.map((file) => file.file_id), rows[1].file_id]);
        expect(new Set(project.file_ids)).toEqual(new Set(rows.map((file) => file.file_id)));
        await page.screenshot({ path: testInfo.outputPath('library-project-reconciled.png') });
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(button(page, de.com_ui_project_add_files)).toBeVisible();
      } finally {
        await attach(testInfo, observation, { reads, posts, membershipReads });
      }
    });

    test('selected originals use bounded batches and stop after an unknown delete outcome', async ({
      page,
      context,
      baseURL,
    }, testInfo) => {
      const observation = await prepare(page, context, baseURL, theme);
      const rows = files(22);
      const original = [...rows];
      const batches: string[][] = [];
      const reads = await catalog(page, rows);
      await page.route(/\/api\/files\/?$/, async (route) => {
        if (route.request().method() !== 'DELETE') return route.fallback();
        const body = route.request().postDataJSON();
        const ids = body.files.map((file: { file_id: string }) => file.file_id) as string[];
        expect(Object.keys(body)).toEqual(['files']);
        expect(ids.length).toBeLessThanOrEqual(10);
        batches.push(ids);
        if (batches.length === 2) return route.abort('failed');
        const failedFileIds = [original[0].file_id];
        const deletedFileIds = ids.filter((id) => !failedFileIds.includes(id));
        for (let index = rows.length - 1; index >= 0; index--) {
          if (deletedFileIds.includes(rows[index].file_id)) rows.splice(index, 1);
        }
        return route.fulfill({ json: { deletedFileIds, failedFileIds } });
      });
      try {
        await page.goto('/c/new');
        await expect(
          page.getByRole('textbox', { name: 'Nachrichteneingabe', exact: true }),
        ).toBeVisible();
        let { dialog } = await openPersonalLibrary(page);
        await dialog
          .getByRole('checkbox', { name: de.com_library_select_page, exact: true })
          .click();
        await button(dialog, de.com_ui_delete).click();
        await expect(
          dialog.getByText(label('com_library_delete_confirm', 22), { exact: true }),
        ).toBeVisible();
        expect(batches).toHaveLength(0);
        await button(dialog, de.com_library_delete_originals).click();
        await expect(
          dialog.getByText(de.com_library_action_uncertain, { exact: true }),
        ).toBeVisible();
        await expect(button(dialog, de.com_library_refresh)).toBeEnabled();
        expect(batches.map((batch) => batch.length)).toEqual([10, 10]);
        expect(batches.flat()).toEqual(original.slice(0, 20).map((file) => file.file_id));
        for (const file of rows) await expect(checkbox(dialog, file)).toBeChecked();
        await expect(dialog.getByRole('checkbox')).toHaveCount(14);
        await button(dialog, de.com_library_refresh).click();
        await expect(button(dialog, de.com_library_refresh)).toBeEnabled();
        expect(batches).toHaveLength(2);
        await page.screenshot({ path: testInfo.outputPath('library-delete-unconfirmed.png') });
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        ({ dialog } = await openPersonalLibrary(page));
        await expect(dialog.getByRole('checkbox')).toHaveCount(14);
        await expect(button(dialog, de.com_ui_delete)).toBeDisabled();
        expect(batches).toHaveLength(2);
        expect(rows.map((file) => file.file_id)).toEqual([
          original[0].file_id,
          ...original.slice(10).map((file) => file.file_id),
        ]);
      } finally {
        await attach(testInfo, observation, { reads, batches });
      }
    });
  });
}
