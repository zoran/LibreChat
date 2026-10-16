import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test('served shell and manifest use configured presentation and the built worker does not cache it', async ({
  request,
}) => {
  const response = await request.get('/login', {
    headers: { 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'lang=en' },
  });
  expect(response.ok()).toBeTruthy();
  const html = await response.text();
  expect(html).toContain('<title>Example Workplace</title>');
  expect(html).toMatch(/<html\b[^>]*\blang="de-DE"/);
  expect(html).toContain('data-librechat-presentation="true"');
  expect(html).toContain('"appTitle":"Example Workplace"');
  expect(html).toContain('"appVersion":"v1.2.3+example.1"');
  expect(html).toContain('"fixedLocale":"de-DE"');

  const startup = await request.get('/api/config');
  expect(startup.ok()).toBeTruthy();
  expect(await startup.json()).toMatchObject({
    appTitle: 'Example Workplace',
    appVersion: 'v1.2.3+example.1',
    fixedLocale: 'de-DE',
  });

  const responseManifest = await request.get('/manifest.webmanifest');
  expect(responseManifest.ok()).toBeTruthy();
  expect(responseManifest.headers()['cache-control']).toContain('no-store');
  const manifest = await responseManifest.json();
  expect(manifest).toMatchObject({
    name: 'Example Workplace',
    short_name: 'Example Workplace',
    lang: 'de-DE',
    icons: [{ src: 'assets/favicon-32x32.png', sizes: '32x32', type: 'image/png' }],
  });
  const built = JSON.parse(
    await fs.readFile(path.resolve(__dirname, '../../client/dist/manifest.webmanifest'), 'utf8'),
  );
  for (const key of ['start_url', 'scope', 'display']) {
    expect(manifest[key]).toEqual(built[key]);
  }
  const icon = await request.get('/assets/favicon-32x32.png');
  expect(icon.ok()).toBeTruthy();
  const png = await icon.body();
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([32, 32]);

  const worker = await fs.readFile(path.resolve(__dirname, '../../client/dist/sw.js'), 'utf8');
  expect(worker).toContain('precacheAndRoute');
  expect(worker).not.toContain('manifest.webmanifest');
  expect(worker).not.toMatch(/assets\/(?:favicon|icon-|apple-touch-icon|maskable-icon)/);
});
