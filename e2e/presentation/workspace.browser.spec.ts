import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type {
  DocumentWorkspace,
  DocumentWorkspaceVersion,
  UploadOperation,
} from 'librechat-data-provider';

// Native default authentication, compiled WorkspaceSurface/Panel, Monaco and raw XHR run here.
// Workspace metadata, intake tickets, file bodies and approval results are explicit server
// boundary fixtures. This does not qualify the real scanner, persistence or server ACL.
test('native workspace saves, restores and protects a local draft across hiding and conflicts', async ({
  page,
  context,
  baseURL,
}, testInfo) => {
  if (!baseURL) throw new Error('An isolated presentation origin is required');
  const address = new URL(baseURL);
  if (
    address.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)
  ) {
    throw new Error('This synthetic browser flow requires an HTTP loopback origin');
  }
  const blocked: { origin: string; method: string; resourceType: string }[] = [];
  await context.route('**/*', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === address.origin || ['data:', 'blob:'].includes(url.protocol))
      return route.continue();
    blocked.push({
      origin: url.origin,
      method: request.method(),
      resourceType: request.resourceType(),
    });
    return route.abort();
  });
  await context.addInitScript(() => localStorage.setItem('color-theme', 'light'));
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = await response.json();
    await route.fulfill({
      response,
      json: { ...config, documentWorkspace: { enabled: true, eligible: true } },
    });
  });

  const id = randomUUID();
  const title = 'Synthetischer Workspace-Entwurf';
  const original = 'Synthetischer gespeicherter Entwurf.';
  const serverUpdate = 'Synthetische neuere Serverfassung.';
  let metadata: DocumentWorkspace | null = null;
  const versions = new Map<number, Buffer>();
  const operations = new Map<
    string,
    {
      operation: UploadOperation;
      baseRevision: number;
      bytes?: Buffer;
      polls: number;
      receipt?: Readonly<DocumentWorkspaceVersion>;
    }
  >();
  const counts = {
    reservations: 0,
    tickets: 0,
    bodies: 0,
    commits: 0,
    committedVersions: 0,
    receiptReplays: 0,
    content: 0,
  };
  const commitRequests: { baseRevision: number; fileId: string }[] = [];
  let conflict = false;
  const capability = 'A'.repeat(43);
  const stamp = () => new Date().toISOString();

  await page.route('**/api/workspaces**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const path = url.pathname;
    if (path === '/api/workspaces' && method === 'GET') {
      return route.fulfill({ json: { workspaces: metadata ? [metadata] : [], nextCursor: null } });
    }
    if (path === '/api/workspaces' && method === 'POST') {
      expect(request.postDataJSON()).toEqual({ format: 'markdown' });
      metadata = {
        workspaceId: id,
        title,
        format: 'markdown',
        revision: 0,
        headFileId: null,
        createdAt: stamp(),
        updatedAt: stamp(),
        expiresAt: null,
      };
      return route.fulfill({ json: metadata });
    }
    if (path === `/api/workspaces/${id}` && method === 'GET') {
      return route.fulfill({ json: metadata });
    }
    const revision = path.match(new RegExp(`^/api/workspaces/${id}/revisions/(\\d+)/content$`));
    if (revision && method === 'GET') {
      counts.content++;
      const body = versions.get(Number(revision[1]));
      if (!body) return route.fulfill({ status: 404, json: { code: 'not_found' } });
      return route.fulfill({
        contentType: 'text/plain; charset=utf-8',
        headers: { 'Cache-Control': 'no-store' },
        body,
      });
    }
    if (path === `/api/workspaces/${id}/saves` && method === 'POST') {
      counts.reservations++;
      const input = request.postDataJSON();
      expect(Object.keys(input).sort()).toEqual([
        'baseRevision',
        'declaredBytes',
        'idempotencyKey',
      ]);
      expect(input.idempotencyKey).toMatch(
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i,
      );
      if (conflict) return route.fulfill({ status: 409, json: { code: 'revision_conflict' } });
      expect(input.baseRevision).toBe(metadata?.revision);
      const operationId = randomUUID();
      const operation: UploadOperation = {
        version: 1,
        id: operationId,
        revision: 0,
        scope: { kind: 'personal' },
        mediaType: 'text/plain',
        declaredBytes: input.declaredBytes,
        state: 'waiting',
        createdAt: stamp(),
        cleanupPending: false,
        canUseInComposer: false,
        canRetryProcessing: false,
      };
      operations.set(operationId, { operation, baseRevision: input.baseRevision, polls: 0 });
      return route.fulfill({ json: operation });
    }
    const status = path.match(new RegExp(`^/api/workspaces/${id}/saves/([^/]+)$`));
    if (status && method === 'GET') {
      const entry = operations.get(status[1]);
      expect(entry?.bytes).toBeDefined();
      expect(url.searchParams.get('baseRevision')).toBe(String(entry?.baseRevision));
      entry!.polls++;
      return route.fulfill({
        json: {
          ...entry!.operation,
          state: 'ready',
          fileId: entry!.operation.id,
          cleanupPending: entry!.polls === 1,
          canUseInComposer: false,
        },
      });
    }
    if (path === `/api/workspaces/${id}/revisions` && method === 'POST') {
      counts.commits++;
      const input = request.postDataJSON();
      commitRequests.push(input);
      const entry = operations.get(input.fileId);
      expect(Object.keys(input).sort()).toEqual(['baseRevision', 'fileId']);
      expect(input.baseRevision).toBe(entry?.baseRevision);
      expect(entry?.polls).toBeGreaterThanOrEqual(2);
      expect(entry?.bytes).toBeDefined();
      if (entry!.receipt) {
        counts.receiptReplays++;
        // An exact retry returns the original immutable version, independent of the head.
        return route.fulfill({ json: entry!.receipt });
      }
      expect(input.baseRevision).toBe(metadata?.revision);
      const receipt: Readonly<DocumentWorkspaceVersion> = Object.freeze({
        workspaceId: id,
        revision: input.baseRevision + 1,
        fileId: input.fileId,
        createdAt: stamp(),
        expiresAt: new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString(),
      });
      entry!.receipt = receipt;
      metadata = {
        ...metadata!,
        revision: receipt.revision,
        headFileId: receipt.fileId,
        updatedAt: receipt.createdAt,
        expiresAt: receipt.expiresAt,
      };
      versions.set(receipt.revision, entry!.bytes!);
      counts.committedVersions++;
      // Persistence succeeded, but the client cannot know that until it reconciles.
      if (counts.committedVersions === 1) return route.abort('failed');
      return route.fulfill({ json: receipt });
    }
    throw new Error(`Unexpected synthetic workspace request: ${method} ${path}`);
  });

  await page.route('**/api/uploads/operations/**', async (route) => {
    const request = route.request();
    const match = new URL(request.url()).pathname.match(
      /^\/api\/uploads\/operations\/([^/]+)\/(intake|body)$/,
    );
    if (!match) throw new Error('Unexpected upload path in workspace fixture');
    const entry = operations.get(match[1]);
    expect(entry).toBeDefined();
    if (match[2] === 'intake') {
      counts.tickets++;
      expect(request.method()).toBe('POST');
      expect(request.postDataJSON()).toEqual({});
      return route.fulfill({
        json: {
          version: 1,
          operationId: match[1],
          capability,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
    }
    counts.bodies++;
    expect(request.method()).toBe('PUT');
    expect(request.headers()['content-type']).toBe('application/octet-stream');
    expect(request.headers()['x-upload-filename']).toBe('cortex-entwurf.txt');
    expect(request.headers()['x-upload-capability']).toBe(capability);
    const body = request.postDataBuffer();
    expect(body?.length).toBe(entry!.operation.declaredBytes);
    entry!.bytes = body!;
    return route.fulfill({ json: { ...entry!.operation, state: 'processing' } });
  });

  const email = `workspace-${randomUUID()}@example.invalid`;
  const password = 'Synthetic-local-only-42!';
  expect(
    (
      await page.request.post('/api/auth/register', {
        data: { name: 'Workspace Test', email, password, confirm_password: password },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (await page.request.post('/api/auth/login', { data: { email, password } })).ok(),
  ).toBeTruthy();

  const surface = page.locator('#document-workspace-panel');
  const toggle = page.getByRole('button', { name: 'Dokumentenarbeitsbereich', exact: true });
  const editor = surface
    .locator('.monaco-editor')
    .filter({ has: page.getByRole('textbox', { name: 'Dokumenttext', exact: true }) })
    .first();
  const save = surface.getByRole('button', { name: 'Speichern', exact: true });
  try {
    await page.goto('/c/new');
    await expect(
      page.getByRole('textbox', { name: 'Nachrichteneingabe', exact: true }),
    ).toBeVisible();
    await toggle.click();
    await expect(surface).toBeVisible();
    await surface.getByRole('button', { name: 'Neuen Entwurf erstellen', exact: true }).click();
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await expect(save).toBeDisabled();
    expect(counts.bodies).toBe(0);
    await editor.getByRole('textbox', { name: 'Dokumenttext', exact: true }).focus();
    await page.keyboard.type(original);
    await expect(editor).toContainText(original);
    await page.keyboard.press('Control+z');
    // Monaco owns the native undo boundary; one undo need not remove the whole sentence.
    await expect(editor).not.toContainText(original);
    await expect(editor).toContainText('Synthetischer gespeicherter');
    await page.keyboard.press('Control+Shift+z');
    await expect(editor).toContainText(original);
    await save.click();
    const reconcile = surface.getByRole('button', {
      name: 'Speichervorgang prüfen',
      exact: true,
    });
    await expect(reconcile).toBeVisible();
    await expect(surface.getByRole('alert')).toContainText(
      'Das Speichern konnte nicht bestätigt werden. Dein Text bleibt hier erhalten.',
    );
    await expect(save).toBeDisabled();
    expect(counts).toMatchObject({ reservations: 1, tickets: 1, bodies: 1, commits: 1 });
    expect(versions.get(1)?.toString('utf8')).toBe(original);
    await editor.getByRole('textbox', { name: 'Dokumenttext', exact: true }).focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' SPAETERER-LOKALER-TEXT');
    await expect(editor).toContainText('SPAETERER-LOKALER-TEXT');
    await page.screenshot({ path: testInfo.outputPath('native-workspace-save-unconfirmed.png') });
    await reconcile.click();
    await expect(reconcile).toHaveCount(0);
    await expect(editor).toContainText(original);
    await expect(editor).toContainText('SPAETERER-LOKALER-TEXT');
    await expect(surface.getByRole('status')).toHaveText('Nicht gespeicherte Änderungen');
    await expect(save).toBeEnabled();
    expect(counts).toMatchObject({
      reservations: 1,
      tickets: 1,
      bodies: 1,
      commits: 2,
      committedVersions: 1,
      receiptReplays: 1,
    });
    expect(commitRequests).toEqual([commitRequests[0], commitRequests[0]]);
    expect(commitRequests[0]).toEqual({ baseRevision: 0, fileId: [...operations.keys()][0] });
    expect(versions.get(1)?.toString('utf8')).toBe(original);
    await page.screenshot({ path: testInfo.outputPath('native-workspace-recovered-save.png') });

    // Only an explicit discard may replace the later local draft with the saved snapshot.
    await surface.getByRole('button', { name: 'Neu laden', exact: true }).click();
    await expect(
      surface.getByRole('button', { name: 'Änderungen behalten', exact: true }),
    ).toBeFocused();
    await surface.getByRole('button', { name: 'Gespeicherte Version laden', exact: true }).click();
    await expect(editor).toContainText(original);
    await expect(editor).not.toContainText('SPAETERER-LOKALER-TEXT');
    await expect(surface.getByRole('status')).toHaveText('Gespeichert');
    await expect(save).toBeDisabled();

    await page.reload();
    await toggle.click();
    await surface.getByRole('button', { name: title, exact: true }).click();
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await expect(editor).toContainText(original);
    expect(counts.bodies).toBe(1);
    await editor.getByRole('textbox', { name: 'Dokumenttext', exact: true }).focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' LOKALE-AENDERUNG');
    await surface.getByRole('button', { name: 'Zur Übersicht', exact: true }).click();
    await surface
      .getByRole('button', { name: 'Geöffneten Entwurf weiterbearbeiten', exact: true })
      .click();
    await expect(editor).toContainText('LOKALE-AENDERUNG');
    // The CI development bundle places its devtools toggle over this corner.
    await surface
      .getByRole('button', { name: 'Arbeitsbereich ausblenden', exact: true })
      .press('Enter');
    await expect(surface).toBeHidden();
    await expect(toggle).toBeFocused();
    await toggle.click();
    await expect(editor).toContainText('LOKALE-AENDERUNG');

    if (!testInfo.project.use.isMobile) {
      const viewport = page.viewportSize()!;
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(editor).toBeVisible();
      await expect(editor).toContainText('LOKALE-AENDERUNG');
      await page.screenshot({ path: testInfo.outputPath('native-workspace-mobile-resize.png') });
      await page.setViewportSize(viewport);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath('native-workspace-local-draft.png') });
    const titleLines = await surface
      .getByRole('heading', { name: title, exact: true })
      .evaluate((heading) => {
        const lineHeight = Number.parseFloat(getComputedStyle(heading).lineHeight);
        return heading.getBoundingClientRect().height / lineHeight;
      });
    expect(
      titleLines,
      'The editor actions must leave a readable title on a narrow screen',
    ).toBeLessThanOrEqual(3);

    const compareToggle = surface.getByRole('button', { name: 'Version vergleichen', exact: true });
    const comparison = surface.getByRole('region', { name: 'Versionen vergleichen', exact: true });
    await compareToggle.click();
    await expect(
      comparison.getByRole('spinbutton', { name: 'Gespeicherte Version', exact: true }),
    ).toBeFocused();
    await comparison.getByRole('button', { name: 'Vergleich laden', exact: true }).click();
    await expect(comparison.locator('.monaco-diff-editor')).toBeVisible();
    await expect(comparison).toContainText('Gespeicherte Version 1');
    await expect(comparison.locator('.monaco-diff-editor')).toContainText('LOKALE-AENDERUNG');
    const snapshotInput = comparison.getByRole('textbox', {
      name: 'Lokaler Entwurf beim Start des Vergleichs',
      exact: true,
    });
    await snapshotInput.focus();
    await page.keyboard.type('NICHT-SCHREIBBAR');
    await expect(comparison.locator('.monaco-diff-editor')).not.toContainText('NICHT-SCHREIBBAR');
    await expect(editor).not.toContainText('NICHT-SCHREIBBAR');
    await editor.getByRole('textbox', { name: 'Dokumenttext', exact: true }).focus();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' NEUER-LOKALER-STAND');
    await expect(comparison.getByRole('status')).toContainText(
      'Dein Entwurf hat sich inzwischen geändert.',
    );
    await expect(comparison.locator('.monaco-diff-editor')).not.toContainText(
      'NEUER-LOKALER-STAND',
    );
    await comparison.getByRole('button', { name: 'Vergleich laden', exact: true }).click();
    await expect(comparison.locator('.monaco-diff-editor')).toContainText('NEUER-LOKALER-STAND');
    await expect(comparison.getByRole('status')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('native-workspace-version-comparison.png') });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
    ).toBeLessThanOrEqual(1);
    await snapshotInput.press('Escape');
    await expect(comparison).toHaveCount(0);
    await expect(compareToggle).toBeFocused();
    await expect(editor).toContainText('NEUER-LOKALER-STAND');
    const beforeComparisonUndo = await editor.locator('.view-lines').innerText();
    await editor.getByRole('textbox', { name: 'Dokumenttext', exact: true }).focus();
    await page.keyboard.press('Control+z');
    // Compare the real visible state; Monaco decides which native edit group is undone.
    await expect
      .poll(() => editor.locator('.view-lines').innerText())
      .not.toBe(beforeComparisonUndo);
    await expect(editor).toContainText(original);
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(() => editor.locator('.view-lines').innerText()).toBe(beforeComparisonUndo);
    expect(counts).toMatchObject({ reservations: 1, tickets: 1, bodies: 1, commits: 2 });

    metadata = { ...metadata!, revision: 2, headFileId: randomUUID(), updatedAt: stamp() };
    versions.set(2, Buffer.from(serverUpdate));
    conflict = true;
    await save.click();
    await expect(surface.getByRole('alert')).toContainText(
      'Es gibt inzwischen eine andere gespeicherte Version.',
    );
    await expect(editor).toContainText('LOKALE-AENDERUNG');
    await expect(save).toBeDisabled();
    await editor.getByRole('textbox', { name: 'Dokumenttext', exact: true }).focus();
    await page.keyboard.press('Control+s');
    expect(counts.reservations).toBe(2);
    expect(counts.bodies).toBe(1);
    const contentReads = counts.content;
    await surface.getByRole('button', { name: 'Neu laden', exact: true }).click();
    await expect(
      surface.getByRole('button', { name: 'Änderungen behalten', exact: true }),
    ).toBeFocused();
    expect(counts.content).toBe(contentReads);
    await surface.getByRole('button', { name: 'Änderungen behalten', exact: true }).click();
    await expect(editor).toContainText('LOKALE-AENDERUNG');
    await surface.getByRole('button', { name: 'Neu laden', exact: true }).click();
    await surface.getByRole('button', { name: 'Gespeicherte Version laden', exact: true }).click();
    await expect(editor).toContainText(serverUpdate);
    await expect(editor).not.toContainText('LOKALE-AENDERUNG');
    await expect(save).toBeDisabled();
    await compareToggle.click();
    await comparison
      .getByRole('spinbutton', { name: 'Gespeicherte Version', exact: true })
      .fill('1');
    await comparison.getByRole('button', { name: 'Vergleich laden', exact: true }).click();
    await expect(comparison.locator('.monaco-diff-editor')).toBeVisible();
    await expect(comparison).toContainText('Gespeicherte Version 1');
    await expect(editor).toContainText(serverUpdate);
    versions.delete(1);
    await comparison.getByRole('button', { name: 'Vergleich laden', exact: true }).click();
    await expect(comparison.getByRole('alert')).toHaveText(
      'Diese Version ist nicht mehr verfügbar. Dein Entwurf bleibt geöffnet.',
    );
    await expect(comparison.locator('.monaco-diff-editor')).toHaveCount(0);
    await expect(editor).toContainText(serverUpdate);
    await expect(save).toBeDisabled();
    await comparison.getByRole('button', { name: 'Vergleich schließen', exact: true }).click();
    expect(counts).toMatchObject({ reservations: 2, tickets: 1, bodies: 1, commits: 2 });
    await page.screenshot({ path: testInfo.outputPath('native-workspace-reconciled.png') });
  } finally {
    await testInfo.attach('workspace-server-boundary-fixtures', {
      body: JSON.stringify(
        {
          scope: 'synthetic workspace/intake server boundary; native auth, UI, Monaco and XHR',
          counts,
          commitRequests,
          blocked,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    expect
      .soft(blocked, 'The workspace must not request an external editor, model or service')
      .toEqual([]);
  }
});
