/** Status cases registered by browser.spec.ts; the existing presentation owner supplies the app. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { BrowserContext, Locator, Page, TestInfo } from '@playwright/test';
import { readStatusSnapshot, STATUS_LIMITS } from 'librechat-data-provider';
import type { StatusNode } from 'librechat-data-provider';

const stateNames = {
  healthy: 'Verfügbar',
  degraded: 'Eingeschränkt',
  unknown: 'Unbekannt',
  stale: 'Veraltet',
  disabled: 'Nicht eingerichtet',
  unavailable: 'Nicht erreichbar',
  disagreement: 'Widersprüchlich',
};

function controlledSnapshot() {
  // Recorded inventory topology; seven assessments and one missing role are deliberate fixtures.
  // The browser clock starts at this observation time and keeps advancing; no native health claim.
  const text = readFileSync(path.join(__dirname, 'status.inventory.fixture.json'), 'utf8');
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(STATUS_LIMITS.maxBytes);
  const snapshot = readStatusSnapshot(JSON.parse(text));
  if (!snapshot)
    throw new Error('The controlled Status fixture must pass the current public reader');
  expect(snapshot.version).toBe(2);
  expect(snapshot.nodes).toHaveLength(164);
  expect(snapshot.nodes.filter((node) => node.identity.kind === 'host')).toHaveLength(14);
  return snapshot;
}

async function settled(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

async function box(locator: Locator) {
  const value = await locator.boundingBox();
  if (!value) throw new Error(`Expected measurable element: ${locator}`);
  return value;
}

type Box = Awaited<ReturnType<typeof box>>;
function contains(outer: Box, inner: Box, margin = 0) {
  expect(inner.x - margin).toBeGreaterThanOrEqual(outer.x - 1);
  expect(inner.y - margin).toBeGreaterThanOrEqual(outer.y - 1);
  expect(inner.x + inner.width + margin).toBeLessThanOrEqual(outer.x + outer.width + 1);
  expect(inner.y + inner.height + margin).toBeLessThanOrEqual(outer.y + outer.height + 1);
}

function disjoint(a: Box, b: Box) {
  const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  expect(
    Math.min(overlapX, overlapY),
    'Search and closed controls must not cover each other',
  ).toBeLessThanOrEqual(0);
}

async function recordGeometry(page: Page, testInfo: TestInfo, name: string) {
  await settled(page);
  await expectGraphLayout(page);
  const result = await page.locator('.cortex-status').evaluate((root) => {
    const rect = (element: Element | null) => element?.getBoundingClientRect().toJSON() ?? null;
    return {
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      workspace: rect(root.querySelector('.cortex-status-workspace')),
      graphPane: rect(root.querySelector('.cortex-status-graph-pane')),
      svg: rect(root.querySelector('.cortex-status-scene')),
      canvas: rect(root.querySelector('.cortex-status-canvas')),
      search: rect(root.querySelector('.cortex-status-search')),
      controls: rect(root.querySelector('.cortex-status-controls')),
      inspector: rect(root.querySelector('.cortex-status-inspector')),
      focused: document.activeElement?.getAttribute('data-node-id'),
      nodes: [...root.querySelectorAll<SVGGElement>('.cortex-status-node:not(.is-context)')].map(
        (node) => ({
          id: node.dataset.nodeId,
          bounds: rect(node),
          badge: rect(node.querySelector('[data-compact-role]')),
          leader: rect(
            root.querySelector(`[data-role-leader-for="${CSS.escape(node.dataset.nodeId!)}"]`),
          ),
          outline: getComputedStyle(node).outline,
          outlineOffset: getComputedStyle(node).outlineOffset,
          focusVisible: node.matches(':focus-visible'),
        }),
      ),
      limits:
        'DOM geometry and computed focus styles accompany the screenshot; raster outline/occlusion review remains required.',
    };
  });
  await testInfo.attach(`${name}-geometry`, {
    body: Buffer.from(JSON.stringify(result, null, 2)),
    contentType: 'application/json',
  });
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

async function expectReadableLabels(page: Page, labels: Locator) {
  const measured = await labels.evaluateAll((elements) =>
    elements.map((element) => {
      const text = element as SVGTextElement;
      const matrix = text.getScreenCTM();
      if (!matrix) throw new Error('Visible role text needs a screen transform');
      return {
        text: text.textContent,
        pixels: parseFloat(getComputedStyle(text).fontSize) * Math.hypot(matrix.c, matrix.d),
        bounds: text.getBoundingClientRect().toJSON(),
        textLength: text.getComputedTextLength(),
        unobscured: (() => {
          const bounds = text.getBoundingClientRect();
          const hit = document.elementFromPoint(
            bounds.x + bounds.width / 2,
            bounds.y + bounds.height / 2,
          );
          return hit?.closest('[data-node-id]') === text.closest('[data-node-id]');
        })(),
      };
    }),
  );
  const canvas = await box(page.locator('.cortex-status-canvas'));
  for (const label of measured) {
    expect(label.pixels, `Readable screen font for ${label.text}`).toBeGreaterThanOrEqual(11.9);
    expect(label.textLength).toBeGreaterThan(0);
    expect(label.unobscured, `Role text ${label.text} must not be hidden under controls`).toBe(
      true,
    );
    contains(canvas, label.bounds);
  }
}

async function expectSeparatedBadges(page: Page, labels: Locator) {
  const canvas = await box(page.locator('.cortex-status-canvas'));
  const badges = await labels.evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().toJSON()),
  );
  for (let i = 0; i < badges.length; i++) {
    contains(canvas, badges[i]);
    for (let j = i + 1; j < badges.length; j++) {
      const a = badges[i],
        b = badges[j];
      const dx = Math.max(a.x - b.right, b.x - a.right, 0);
      const dy = Math.max(a.y - b.bottom, b.y - a.bottom, 0);
      expect(
        Math.hypot(dx, dy),
        'Compact resource badges need visible separation',
      ).toBeGreaterThanOrEqual(5);
    }
  }
}

async function expectCompactRoles(page: Page) {
  const scene = page.locator('.cortex-status-scene');
  await expect(scene).toHaveCount(1);
  const labels = scene.locator('[data-compact-role] [data-screen-label]');
  await expect(labels).toHaveCount(15); // Fourteen hosts and the existing Kubernetes cluster.
  await expectReadableLabels(page, labels);
  for (const [kind, label] of [
    ['cpu', 'CPU'],
    ['gpu', 'GPU'],
    ['unknown', '?'],
    ['kubernetes', 'Kubernetes-Cluster'],
  ]) {
    const badge = scene.locator(`[data-compact-role]:has([data-role-icon="${kind}"])`).first();
    await expect(badge.locator('[data-screen-label]')).toHaveText(label);
    await expect(badge.locator('[data-frame]').first()).toBeVisible();
  }
  await expectSeparatedBadges(page, scene.locator('[data-compact-role]'));
}

async function expectStates(page: Page) {
  const paths = new Set<string>();
  for (const [state, german] of Object.entries(stateNames)) {
    const legend = page.locator(`[data-legend-state="${state}"]`);
    await expect(legend).toBeVisible();
    await expect(legend).toContainText(german);
    const graph = page
      .locator(
        `.cortex-status-node:not(.is-context)[data-state="${state}"]:has([data-compact-role])`,
      )
      .first();
    await expect(graph).toHaveAccessibleName(new RegExp(german));
    const symbol = graph.locator(`[data-screen-state="${state}"]`);
    await expect(symbol).toBeVisible();
    const symbolBox = await box(symbol);
    expect(symbolBox.width).toBeGreaterThanOrEqual(9.9);
    expect(symbolBox.height).toBeGreaterThanOrEqual(9.9);
    const artwork = await symbol.locator('path').getAttribute('d');
    expect(artwork).toBeTruthy();
    expect(await legend.locator('path').getAttribute('d')).toBe(artwork);
    expect(
      await symbol.locator('path').evaluate((element) => {
        const style = getComputedStyle(element);
        return style.stroke !== 'none' && parseFloat(style.strokeWidth) > 0;
      }),
    ).toBe(true);
    paths.add(artwork!);
  }
  expect(paths.size, 'Seven states must have distinct non-color artwork').toBe(7);
}

async function searchWithKeyboard(page: Page, node: StatusNode, query = node.label) {
  const search = page.getByRole('textbox', { name: 'Komponente suchen', exact: true });
  await search.fill(query);
  const result = page.getByRole('region', { name: 'Suchergebnisse' }).getByRole('button');
  await expect(result).toHaveCount(1);
  await search.press('Tab');
  await expect(result).toBeFocused();
  await result.press('Enter');
  const graphNode = page.locator(`[data-node-id="${node.id}"]`);
  await expect(graphNode).toBeFocused();
  await expect(graphNode).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Suchergebnisse' })).toHaveCount(0);
  await expect(search).toHaveValue('');
  await expect(
    page
      .getByRole('complementary', { name: 'Komponentendetails' })
      .getByRole('heading', { name: node.label, exact: true }),
  ).toBeVisible();
  return graphNode;
}

const kubernetesRoles = {
  cluster: 'Kubernetes-Cluster',
  api_server: 'API-Server',
  controller_manager: 'Controller-Manager',
  scheduler: 'Scheduler',
  etcd: 'Clusterdatenspeicher',
  kubelet: 'Knotenagent',
  container_runtime: 'Containerlaufzeit',
  network: 'Clusternetzwerk',
  dns: 'Cluster-DNS',
};

async function expectGraphLayout(page: Page) {
  const pane = await box(page.locator('.cortex-status-graph-pane'));
  const canvas = await box(page.locator('.cortex-status-canvas'));
  const svg = await box(page.locator('.cortex-status-scene'));
  const search = await box(page.locator('.cortex-status-search'));
  const controls = await box(page.locator('.cortex-status-controls'));
  for (const region of [canvas, search, controls]) contains(pane, region);
  contains(canvas, svg);
  contains(svg, canvas);
  disjoint(search, canvas);
  disjoint(controls, canvas);
  disjoint(search, controls);
}

async function expectKubernetesLabels(page: Page) {
  await page.locator('.cortex-status-canvas').scrollIntoViewIfNeeded();
  await settled(page);
  const roles = page.locator('.cortex-status-node:not(.is-context)[data-resource^="kubernetes-"]');
  const labels = roles.locator('[data-compact-role] [data-screen-label]');
  await expect(labels).toHaveCount(9);
  expect((await labels.allTextContents()).sort()).toEqual(Object.values(kubernetesRoles).sort());
  await expectReadableLabels(page, labels);
  await expectSeparatedBadges(page, page.locator('.cortex-status-scene [data-compact-role]'));
}

async function expectRoleSelection(page: Page, nodes: StatusNode[]) {
  const kubernetes = nodes.filter((node) => node.classification?.kind === 'kubernetes');
  expect(kubernetes.map((node) => node.classification!.role).sort()).toEqual(
    Object.keys(kubernetesRoles).sort(),
  );
  await page.getByRole('button', { name: 'Infrastruktur', exact: true }).click();
  const scene = page.locator('.cortex-status-scene');
  await expect(scene).toHaveCount(1);
  await expectKubernetesLabels(page);
  const targets: { node: StatusNode; label: string }[] = [];
  for (const [role, label] of Object.entries(kubernetesRoles)) {
    const node = kubernetes.find((item) => item.classification?.role === role)!;
    const graphNode = scene.locator(`[data-node-id="${node.id}"]`);
    await expect(graphNode).toHaveAttribute('data-resource', `kubernetes-${role}`);
    await expect(graphNode).toHaveAttribute('tabindex', '0');
    await expect(graphNode).toHaveAccessibleName(new RegExp(label));
    targets.push({ node, label });
  }
  for (const [role, label] of [
    ['cpu', 'CPU-Server'],
    ['gpu', 'GPU-Server'],
  ]) {
    const node = nodes.find(
      (item) => item.classification?.kind === 'server' && item.classification.role === role,
    );
    if (!node) throw new Error(`Controlled inventory requires a ${role} server`);
    targets.push({ node, label });
  }
  for (const { node, label } of targets) {
    // Full existing description uniquely selects the cluster despite its shared name prefix.
    const selected = await searchWithKeyboard(page, node, `${node.label} · ${label}`);
    await expect(selected).toHaveAccessibleName(new RegExp(label));
    await expect(scene).toHaveCount(1);
    const inspector = page.getByRole('complementary', { name: 'Komponentendetails' });
    await expect(
      inspector.locator('dd').filter({ hasText: new RegExp(`^${label}$`) }),
    ).toBeVisible();
    await inspector.getByRole('button', { name: 'Details schließen' }).click();
    await expect(inspector).toHaveCount(0);
    await expect(scene).toBeFocused();
  }
  await page.getByRole('button', { name: 'Gesamtübersicht', exact: true }).click();
}

async function capturePresets(page: Page, testInfo: TestInfo, name: string, selected: Locator) {
  const scene = page.locator('.cortex-status-scene');
  const before = await scene
    .locator('[data-node-id]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-node-id')).sort());
  for (const [key, label] of [
    ['infrastructure', 'Infrastruktur'],
    ['processing', 'KI-Verarbeitung'],
    ['overview', 'Gesamtübersicht'],
  ]) {
    const preset = page.getByRole('button', { name: label, exact: true });
    await preset.click();
    await expect(preset).toHaveAttribute('aria-pressed', 'true');
    await expect(scene).toHaveCount(1);
    await expect(selected).toHaveAttribute('aria-pressed', 'true');
    expect(
      await scene
        .locator('[data-node-id]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-node-id')).sort()),
    ).toEqual(before);
    if (key === 'infrastructure') await expectKubernetesLabels(page);
    await recordGeometry(page, testInfo, `${name}-preset-${key}`);
  }
}

async function expectFocusBounds(page: Page, node: Locator) {
  await expect(node).toBeFocused();
  const style = await node.evaluate((element) => {
    const computed = getComputedStyle(element);
    return {
      visible: element.matches(':focus-visible'),
      style: computed.outlineStyle,
      width: parseFloat(computed.outlineWidth),
      offset: parseFloat(computed.outlineOffset),
    };
  });
  expect(style.visible).toBe(true);
  expect(style.style).not.toBe('none');
  expect(style.width).toBeGreaterThanOrEqual(2);
  // Measure the semantic focus owner; its decorative sibling is checked separately.
  contains(
    await box(page.locator('.cortex-status-canvas')),
    await box(node),
    style.width + style.offset,
  );
}

async function expectLeaderAttachment(page: Page, node: Locator) {
  const id = await node.getAttribute('data-node-id');
  const leader = page.locator(`.cortex-status-scene [data-role-leader-for="${id}"]`);
  await expect(leader).toHaveCount(1);
  await expect(leader).toHaveAttribute('aria-hidden', 'true');
  expect(await leader.getAttribute('tabindex')).toBeNull();
  expect(await leader.getAttribute('role')).toBeNull();
  await expect(leader).toHaveCSS('pointer-events', 'none');
  await expect(node.locator('[data-role-leader-for]')).toHaveCount(0);
  const geometry = await leader.evaluate((element, resourceId) => {
    const line = element as SVGPathElement;
    const resource = line.ownerSVGElement!.querySelector<SVGGElement>(
      `[data-node-id="${CSS.escape(resourceId!)}"]`,
    )!;
    const badge = resource.querySelector<SVGGElement>('[data-compact-role]')!;
    const lineMatrix = line.getScreenCTM(),
      nodeMatrix = resource.getScreenCTM(),
      badgeMatrix = badge.getScreenCTM();
    if (!lineMatrix || !nodeMatrix || !badgeMatrix)
      throw new Error('Leader needs connected screen transforms');
    const point = (p: DOMPoint, m: DOMMatrix) => p.matrixTransform(m);
    const start = point(line.getPointAtLength(0), lineMatrix);
    const end = point(line.getPointAtLength(line.getTotalLength()), lineMatrix);
    const origin = point(new DOMPoint(92, 44), nodeMatrix);
    const anchor = point(new DOMPoint(0, 0), badgeMatrix);
    return {
      originError: Math.hypot(start.x - origin.x, start.y - origin.y),
      endpointError: Math.hypot(end.x - anchor.x, end.y - anchor.y),
    };
  }, id);
  expect(geometry.originError).toBeLessThanOrEqual(1);
  expect(geometry.endpointError).toBeLessThanOrEqual(1);
}

async function pan(page: Page, scene: Locator, dx: number, mobile: boolean) {
  const start = await scene.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    for (const fraction of [0.5, 0.25, 0.75]) {
      const point = { x: bounds.right - 8, y: bounds.top + bounds.height * fraction };
      const hit = document.elementFromPoint(point.x, point.y);
      if (hit?.closest('.cortex-status-scene') && !hit.closest('[role="button"]')) return point;
    }
    throw new Error('The rendered scene must expose a reachable pan surface');
  });
  const before = await scene.locator(':scope > g').getAttribute('transform');
  if (mobile) {
    // Chromium's actual touch input reaches React pointer handlers; no synthetic DOM dispatch.
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ ...start, id: 1 }],
      });
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: start.x + dx, y: start.y, id: 1 }],
      });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally {
      await cdp
        .send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
        .catch(() => undefined);
      await cdp.detach();
    }
  } else {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    try {
      await page.mouse.move(start.x + dx, start.y, { steps: 4 });
    } finally {
      await page.mouse.up();
    }
  }
  await expect(scene.locator(':scope > g')).not.toHaveAttribute('transform', before!);
}

async function phoneControls(page: Page, target: StatusNode) {
  const pane = page.locator('.cortex-status-graph-pane');
  const canvas = page.locator('.cortex-status-canvas');
  const controls = page.locator('.cortex-status-controls');
  const search = page.locator('.cortex-status-search');
  const summary = controls.locator('summary');
  await expect(summary).toHaveAccessibleName('Ressourcenliste');
  await controls.scrollIntoViewIfNeeded();
  await expectGraphLayout(page);
  contains(await box(pane), await box(controls));
  disjoint(await box(search), await box(controls));
  for (const control of await controls.locator('button, summary').all()) {
    expect((await box(control)).height).toBeGreaterThanOrEqual(43);
  }
  await summary.focus();
  await summary.press('Enter');
  await expect(controls.locator('details')).toHaveAttribute('open', '');
  const list = controls.locator('.cortex-status-results');
  contains(await box(pane), await box(list));
  disjoint(await box(canvas), await box(list));
  expect((await box(list)).height).toBeGreaterThanOrEqual(44);
  expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  const choice = list.getByRole('button', {
    name: `${target.label} · Servertyp unbekannt`,
    exact: true,
  });
  await choice.scrollIntoViewIfNeeded();
  contains(await box(list), await box(choice));
  await choice.focus();
  await choice.press('Enter');
  await expect(page.locator(`[data-node-id="${target.id}"]`)).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await summary.focus();
  await summary.press('Enter');
  await expect(controls.locator('details')).not.toHaveAttribute('open', '');
  // Also exercise the native disclosure's pointer path after keyboard selection.
  await summary.tap();
  await expect(controls.locator('details')).toHaveAttribute('open', '');
  await summary.tap();
  await expect(controls.locator('details')).not.toHaveAttribute('open', '');
}

export function statusCases(
  configureBranding: (page: Page, fixture: { theme: 'light' | 'dark' }) => Promise<void>,
  signInFixture: (page: Page) => Promise<void>,
  prepareEnglish: (context: BrowserContext, baseURL: string, json: boolean) => Promise<void>,
  expectGerman: (page: Page) => Promise<void>,
  expectNoOverflow: (page: Page) => Promise<void>,
) {
  for (const theme of ['light', 'dark'] as const) {
    test(`Cortex Status v2 ${theme} layout, state cues and keyboard remain usable`, async ({
      page,
      context,
      baseURL,
      isMobile,
    }, testInfo) => {
      if (!baseURL) throw new Error('Status presentation requires the existing loopback app');
      const snapshot = controlledSnapshot();
      const cpu = snapshot.nodes.find(
        (node) => node.classification?.kind === 'server' && node.classification.role === 'cpu',
      )!;
      const unknown = snapshot.nodes.find(
        (node) => node.identity.kind === 'host' && !node.classification,
      )!;
      const pageErrors: string[] = [];
      const network: { url: string; failure?: string | null; status?: number }[] = [];
      const onError = (error: Error) => pageErrors.push(error.message);
      page.on('pageerror', onError);
      page.on('requestfailed', (request) =>
        network.push({ url: request.url(), failure: request.failure()?.errorText }),
      );
      page.on('response', (response) => {
        if (response.status() >= 400)
          network.push({ url: response.url(), status: response.status() });
      });
      await prepareEnglish(context, baseURL, theme === 'dark');
      await configureBranding(page, { theme });
      await signInFixture(page);
      await page.clock.setSystemTime(new Date(snapshot.generatedAt * 1000));
      await page.route('**/api/status/access', (route) =>
        route.fulfill({ json: { allowed: true } }),
      );
      await page.route(/\/api\/status(?:\?.*)?$/, (route) => route.fulfill({ json: snapshot }));
      const scene = page.locator('.cortex-status-scene');
      const inspector = page.getByRole('complementary', { name: 'Komponentendetails' });
      try {
        const sizes = isMobile
          ? [
              { width: 390, height: 844 },
              { width: 390, height: 700 },
            ]
          : [
              { width: 1280, height: 900 },
              { width: 768, height: 900 },
            ];
        for (const size of sizes) {
          await page.setViewportSize(size);
          await page.goto('/status');
          await expect(page).toHaveURL(/\/status$/);
          await expect(page.getByRole('heading', { name: 'Status', exact: true })).toBeVisible();
          await expectGerman(page);
          await expect(page.locator('html')).toHaveClass(new RegExp(`(?:^|\\s)${theme}(?:\\s|$)`));
          const logo = page.locator('.cortex-status-toolbar img');
          await expect(logo).toHaveAccessibleName('Example Workplace');
          await expect(logo).toHaveAttribute('src', `assets/presentation-logo-${theme}.svg`);
          await expect
            .poll(() => logo.evaluate((element) => (element as HTMLImageElement).naturalWidth))
            .toBeGreaterThan(0);
          await expect(scene.locator('[data-node-id]')).toHaveCount(snapshot.nodes.length);
          expect(
            await scene
              .locator('[data-node-id]')
              .evaluateAll((nodes) =>
                nodes.map((node) => node.getAttribute('data-node-id')).sort(),
              ),
          ).toEqual(snapshot.nodes.map((node) => node.id).sort());
          await expect(scene.locator('.cortex-status-edge')).toHaveCount(snapshot.edges.length);
          await settled(page);
          await expectNoOverflow(page);
          await expectCompactRoles(page);
          await expectStates(page);
          const name = `status-${theme}-${size.width}x${size.height}`;
          await recordGeometry(page, testInfo, `${name}-overview`);
          if (size === sizes[0]) await expectRoleSelection(page, snapshot.nodes);

          const selected = await searchWithKeyboard(page, cpu);
          await searchWithKeyboard(page, cpu); // Re-selecting the same resource must also retain focus.
          await settled(page);
          await expectFocusBounds(page, selected);
          await selected.press('Tab');
          await expect(selected).not.toBeFocused();
          expect(
            await page.evaluate(() => {
              const active = document.activeElement;
              return (
                active?.isConnected &&
                active !== document.body &&
                active?.closest('.cortex-status') !== null
              );
            }),
          ).toBe(true);
          await selected.focus();
          await recordGeometry(page, testInfo, `${name}-selected`);
          await page.getByRole('button', { name: 'Infrastruktur', exact: true }).click();
          await expect(
            page.getByRole('button', { name: 'Infrastruktur', exact: true }),
          ).toHaveAttribute('aria-pressed', 'true');
          await expect(selected).toHaveAttribute('aria-pressed', 'true');
          await page
            .locator('.cortex-status-controls')
            .getByRole('button', { name: 'Zurück', exact: true })
            .click();
          await expect(
            page.getByRole('button', { name: 'Gesamtübersicht', exact: true }),
          ).toHaveAttribute('aria-pressed', 'true');
          await expect(selected).toHaveAttribute('aria-pressed', 'true');
          await capturePresets(page, testInfo, name, selected);
          if (isMobile) {
            await phoneControls(page, unknown);
            await recordGeometry(page, testInfo, `${name}-phone-controls`);
          }
          const close = inspector.getByRole('button', { name: 'Details schließen' });
          await close.focus();
          await close.press('Escape');
          await expect(inspector).toHaveCount(0);
          await expect(scene).toBeFocused();
        }

        await page.emulateMedia({ reducedMotion: 'reduce' });
        const selected = await searchWithKeyboard(page, cpu);
        await expect(selected).toHaveCSS('transition-duration', '0s');
        await expect(selected).toHaveCSS('animation-duration', '0s');
        const camera = scene.locator(':scope > g');
        const before = await camera.getAttribute('transform');
        await scene.focus();
        await scene.press('ArrowRight');
        await expect(camera).not.toHaveAttribute('transform', before!);
        const panned = await camera.getAttribute('transform');
        await scene.press('+');
        await expect(camera).not.toHaveAttribute('transform', panned!);
        const zoomed = await camera.getAttribute('transform');
        await page.getByRole('button', { name: 'Verkleinern', exact: true }).click();
        await expect(camera).not.toHaveAttribute('transform', zoomed!);
        await page.getByRole('button', { name: 'Einpassen', exact: true }).click();
        await settled(page);
        const anchor = await selected.evaluate((element) => {
          const matrix = (element as SVGGraphicsElement).getScreenCTM();
          if (!matrix) throw new Error('Selected node must have a screen transform');
          return new DOMPoint(92, 44).matrixTransform(matrix).x;
        });
        const canvas = await box(page.locator('.cortex-status-canvas'));
        await pan(page, scene, canvas.x + 7 - anchor, isMobile);
        await scene.focus();
        await scene.press('Tab'); // Restore keyboard modality before checking the selected outline.
        await selected.focus();
        await settled(page);
        await expectLeaderAttachment(page, selected);
        await expectFocusBounds(page, selected);
        await recordGeometry(
          page,
          testInfo,
          `status-${theme}-edge-focus-${isMobile ? 'phone' : 'desktop'}`,
        );
        await expectNoOverflow(page);
        expect(pageErrors, 'Unexpected product page errors').toEqual([]);
        expect(
          network.filter(
            (item) =>
              new URL(item.url).origin === new URL(baseURL).origin &&
              (item.status !== undefined || (item.failure && item.failure !== 'net::ERR_ABORTED')),
          ),
          'Unexpected local application network errors',
        ).toEqual([]);
      } catch (error) {
        await page
          .screenshot({ path: testInfo.outputPath(`status-${theme}-original-failure.png`) })
          .catch(() => undefined);
        throw error;
      } finally {
        await testInfo.attach(`status-${theme}-observations`, {
          body: Buffer.from(
            JSON.stringify(
              {
                fixture: 'controlled strict-v2 inventory; access and snapshot intercepted',
                observationTime: snapshot.generatedAt,
                nodeCount: snapshot.nodes.length,
                pageErrors,
                network,
                theme,
                project: testInfo.project.name,
                renderingAcceptance:
                  'Requires successful execution and primary review of the original screenshots.',
              },
              null,
              2,
            ),
          ),
          contentType: 'application/json',
        });
        page.off('pageerror', onError);
      }
    });
  }
}
