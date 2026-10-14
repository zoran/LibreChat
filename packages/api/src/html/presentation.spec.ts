/** Verifies public presentation before hydration and the runtime-owned PWA manifest. */
import express from 'express';
import request from 'supertest';
import { Constants } from 'librechat-data-provider';
import { createPresentation, resolvePresentation } from './presentation';
import { injectConfiguredFooterBootstrap } from './footer';
import { applyCspNonce } from '~/security/csp';

const HTML =
  '<!doctype html><html lang="en-US"><head><base href="/work/" />' +
  '<meta name="description" content="LibreChat - original description" />' +
  '<title>LibreChat</title></head><body><script type="module" src="assets/app.js"></script></body></html>';
const manifest = {
  name: 'LibreChat',
  short_name: 'LibreChat',
  description: 'LibreChat description',
  start_url: '.',
  display: 'standalone',
  theme_color: '#009688',
  icons: [{ src: 'assets/upstream.png', sizes: '192x192', type: 'image/png' }],
};
const interfaceConfig = {
  fixedLocale: 'de-DE',
  appVersion: 'v0.8.8+bwi.1',
  pwaIcons: [{ src: 'assets/logo.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
};
const source = { appTitle: 'BWI Cortex', interfaceConfig };

it('resolves exactly the public fields with upstream defaults and no manifest disclosure', () => {
  expect(resolvePresentation({})).toEqual({ appTitle: 'LibreChat', appVersion: Constants.VERSION });
  expect(resolvePresentation(source)).toEqual({
    appTitle: 'BWI Cortex',
    appVersion: 'v0.8.8+bwi.1',
    fixedLocale: 'de-DE',
  });
});

it('uses the same title, version and fixed language in the first document before any app code', () => {
  const owner = createPresentation({
    ...source,
    html: HTML,
    manifestRaw: JSON.stringify(manifest),
  });
  const html = owner.render('en-US');
  expect(html).toContain('<html lang="de-DE">');
  expect(html).toContain('<title>BWI Cortex</title>');
  expect(html).toContain('name="description" content="BWI Cortex"');
  expect(html).toContain('"appTitle":"BWI Cortex"');
  expect(html).toContain('"appVersion":"v0.8.8+bwi.1"');
  expect(html).toContain('"fixedLocale":"de-DE"');
  expect(html.indexOf('window.__LIBRECHAT_CONFIG__')).toBeLessThan(html.indexOf('assets/app.js'));
  expect(html).toContain('<base href="/work/"');
});

it('composes with the existing footer bootstrap and CSP without revealing unrelated interface data', () => {
  const html = createPresentation({
    ...source,
    html: injectConfiguredFooterBootstrap(HTML, { customFooter: 'Example' }),
    manifestRaw: JSON.stringify(manifest),
  }).render('en');
  const stamped = applyCspNonce(html, 'test-nonce');
  expect(stamped).toContain('"hasConfiguredFooter":true');
  expect(stamped).toContain('nonce="test-nonce" data-librechat-presentation="true"');
  expect(stamped).not.toContain('pwaIcons');
  expect(stamped).not.toContain('assets/logo.svg');
});

it('escapes hostile title and language text without script or replacement expansion', () => {
  const title = '$&</title><script>bad()</script>"&';
  const html = createPresentation({
    html: HTML,
    manifestRaw: JSON.stringify(manifest),
    appTitle: title,
  }).render('en" onload="bad()');
  expect(html).not.toContain('<script>bad()');
  expect(html).toContain('$&amp;&lt;/title&gt;&lt;script&gt;bad()&lt;/script&gt;&quot;&amp;');
  expect(html).toContain('lang="en&quot; onload=&quot;bad()"');
  expect(html).toContain('\\u003c/script>');
});

it('keeps an unconfigured document description and request language behavior', () => {
  const html = createPresentation({ html: HTML, manifestRaw: JSON.stringify(manifest) }).render(
    'fr',
  );
  expect(html).toContain('<title>LibreChat</title>');
  expect(html).toContain('content="LibreChat - original description"');
  expect(html).toContain('<html lang="fr">');
  expect(html).not.toContain('"fixedLocale"');
});

it('serves a configured manifest derived from the actual artifact without mutating its other fields', async () => {
  const owner = createPresentation({
    ...source,
    html: HTML,
    manifestRaw: JSON.stringify(manifest),
  });
  const app = express();
  app.get('/manifest.webmanifest', owner.manifestHandler);
  const response = await request(app).get('/manifest.webmanifest');
  expect(response.statusCode).toBe(200);
  expect(response.headers['content-type']).toMatch(/^application\/manifest\+json/);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(JSON.parse(response.text)).toEqual({
    ...manifest,
    name: 'BWI Cortex',
    short_name: 'BWI Cortex',
    description: 'BWI Cortex',
    lang: 'de-DE',
    icons: interfaceConfig.pwaIcons,
  });
  expect(manifest.name).toBe('LibreChat');
});

it('preserves the unconfigured manifest artifact', async () => {
  const app = express();
  app.get(
    '/manifest.webmanifest',
    createPresentation({
      html: HTML,
      manifestRaw: JSON.stringify(manifest),
    }).manifestHandler,
  );
  expect(JSON.parse((await request(app).get('/manifest.webmanifest')).text)).toEqual(manifest);
});

it.each(['null', '[]', '{broken', ' '.repeat(65537)])(
  'rejects missing, malformed or oversized built manifest data',
  (manifestRaw) => {
    expect(() => createPresentation({ html: HTML, manifestRaw })).toThrow();
  },
);
