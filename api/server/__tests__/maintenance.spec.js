/** Verifies the actual startup composition without loading credentials, databases or listeners. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

test.each(['ready', 'rejected'])(
  'startup waits for the cache owner before any dependent work: %s',
  async (result) => {
    const entry = source.indexOf('const startServer = async () => {');
    const start = source.indexOf('startupSignal.throwIfAborted();', entry);
    const end = source.indexOf('  const { metricsMiddleware', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    let ready;
    let rejected;
    const pending = new Promise((resolve, reject) => {
      ready = resolve;
      rejected = reject;
    });
    const waitForRedisStartup = jest.fn(() => pending);
    const entered = jest.fn();
    const startup = vm.runInNewContext(
      `(async () => { ${source.slice(start, end)} entered(); })();`,
      {
        startupSignal: new AbortController().signal,
        waitForRedisStartup,
        waitForKeyvRedisClient: jest.fn().mockResolvedValue(undefined),
        entered,
      },
    );
    const outcome = startup.catch((error) => error);
    await new Promise(setImmediate);
    expect(entered).not.toHaveBeenCalled();
    expect(waitForRedisStartup).toHaveBeenCalledTimes(1);
    if (result === 'ready') {
      ready();
      await outcome;
      expect(entered).toHaveBeenCalledTimes(1);
    } else {
      const failure = new Error('shared Redis startup unavailable');
      rejected(failure);
      expect(await outcome).toBe(failure);
      expect(entered).not.toHaveBeenCalled();
    }
  },
);

test('startup supplies existing owner ports and routes readiness through maintenance only', async () => {
  const owner = {
    closeGenerationAdmission: jest.fn(),
    reopenGenerationAdmission: jest.fn(),
    getGenerationAdmissionCensus: jest.fn(),
    getGenerationRuntimeHealth: jest.fn(),
  };
  const create = jest.fn(() => ({}));
  const ping = jest.fn();
  const shared = jest.fn();
  const history = {};
  const lifecycle = {};
  const mongoCache = { maintenance: {} };
  const startupMigration = { maintenance: {} };
  const catalog = {};
  const module = { exports: {} };
  const api = {
    createAppMaintenance: create,
    getOrdinaryS3Provider: jest.fn(() => ({ state: 'uninitialized' })),
    fileDeletionWorkOwner: { maintenance: {} },
    codeEnvironmentLifecycleMaintenance: lifecycle,
    cacheConfig: { SHARED_STATE: { mode: 'sentinel' }, USE_REDIS: true },
    GenerationJobManager: owner,
    probeMaintenanceRedis: shared,
    probeMaintenanceDatabase: (db) => db.ping(),
    keyvRedisClient: {},
    ioredisClient: {},
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../services/start/maintenance.js'), 'utf8'),
    { module, process: { env: {} }, require: () => api },
  );
  module.exports.createWebMaintenance({
    browserMaintenance: {},
    uploadMaintenance: { readStorageProvider: () => ({ state: 'disabled' }) },
    historyMaintenance: history,
    mongoCacheMaintenance: mongoCache,
    startupMigrationMaintenance: startupMigration,
    mcpCatalogMaintenance: catalog,
    mongoose: { connection: { db: { admin: () => ({ ping }) } } },
    startupReady: () => true,
  });
  expect(create).toHaveBeenCalledTimes(1);
  const deps = create.mock.calls[0][0];
  expect(deps.startupAdmission).toBe('closed');
  expect(deps.readStorageProviders()).toEqual({
    ordinaryS3: { state: 'uninitialized' },
    managedS3: { state: 'disabled' },
  });
  expect(deps.workOwners.history).toBe(history);
  expect(deps.workOwners.codeLifecycle).toBe(lifecycle);
  expect(deps.workOwners.mongoCache).toBe(mongoCache.maintenance);
  expect(deps.workOwners.startupCollections).toBe(startupMigration.maintenance);
  expect(deps.workOwners.mcpCatalog).toBe(catalog);
  expect(deps.unqualifiedOwners).toEqual([
    'raw database commands, sessions and independent writers outside qualified owners',
    'standalone tag/share and other HTTP mutations',
    'MCP/OAuth reconnect, search indexing, code lifecycle and remaining background owners',
  ]);
  deps.generation.closeGenerationAdmission('request');
  deps.generation.getGenerationAdmissionCensus();
  deps.generation.getGenerationRuntimeHealth();
  deps.probeDatabase();
  deps.probeSharedState();
  expect(owner.closeGenerationAdmission).toHaveBeenCalledWith('request');
  expect(owner.getGenerationAdmissionCensus).toHaveBeenCalledTimes(1);
  expect(owner.getGenerationRuntimeHealth).toHaveBeenCalledTimes(1);
  expect(ping).toHaveBeenCalledTimes(1);
  expect(shared).toHaveBeenCalledWith({
    required: true,
    cache: api.keyvRedisClient,
    commands: api.ioredisClient,
  });
  expect(deps.startupReady()).toBe(true);
  expect(source).toContain("app.get('/readyz', maintenance.readinessHandler)");
  expect(source).toContain("app.get('/livez', (_req, res) => res.status(200).send('OK'))");
  expect(source).toContain('const rejectChatStartsUntilReady = maintenance.admissionMiddleware');
  expect(source.indexOf('await maintenance.listen()')).toBeGreaterThan(
    source.indexOf('  await configureGenerationStreams();'),
  );
  expect(source).toContain("app.use('/api', maintenance.mutationMiddleware)");
  expect(source.indexOf("app.use('/api', maintenance.mutationMiddleware)")).toBeLessThan(
    source.indexOf("app.use('/api/schedules'"),
  );
  expect(source).not.toMatch(/app\.(?:use|get|post)\(['"]\/(?:api\/)?maintenance/);
  expect(source).toContain("registerShutdownTask('private maintenance listener'");
});

test('startup renders configured presentation before hydration from the existing loaded configuration', () => {
  const api = require('@librechat/api');
  const start = source.indexOf('  const indexPath =');
  const end = source.indexOf("  app.get('/health'", start);
  const html =
    '<html lang="en-US"><head><title>LibreChat</title>' +
    '<meta name="description" content="LibreChat description" /></head><body></body></html>';
  const manifest = JSON.stringify({ name: 'LibreChat', short_name: 'LibreChat', start_url: '.' });
  const send = vm.runInNewContext(`${source.slice(start, end)}; sendIndexHtml`, {
    fs: { readFileSync: (file) => (file.endsWith('manifest.webmanifest') ? manifest : html) },
    path,
    appConfig: {
      paths: { dist: '/dist' },
      interfaceConfig: { fixedLocale: 'de-DE', appVersion: 'v1.2.3+example.1' },
    },
    process: { env: { APP_TITLE: 'Example Workplace' } },
    createPresentation: api.createPresentation,
    injectConfiguredFooterBootstrap: api.injectConfiguredFooterBootstrap,
    createCspPolicy: () => null,
    shellCacheHeaders: api.shellCacheHeaders,
    escapeHtmlAttribute: api.escapeHtmlAttribute,
    maybeInjectQueryDevtoolsBootstrap: (value) => value,
    QUERY_DEVTOOLS_HEADER: 'x-query-devtools',
  });
  let body;
  const response = {
    set: jest.fn(),
    vary: jest.fn(),
    type: jest.fn(),
    send: (value) => {
      body = value;
    },
  };
  send({ cookies: { lang: 'en-US' }, headers: { 'accept-language': 'en-US' } }, response);
  expect(body).toContain('<title>Example Workplace</title>');
  expect(body).toContain('<html lang="de-DE">');
  expect(body).toContain('"appVersion":"v1.2.3+example.1"');
  expect(response.type).toHaveBeenCalledWith('html');
});

test('startup registers the runtime manifest before static assets can return the compiled defaults', () => {
  const start = source.indexOf("  app.get('/index.html'");
  const end = source.indexOf('  if (telemetry.enabled)', start);
  const events = [];
  const manifestHandler = jest.fn();
  vm.runInNewContext(source.slice(start, end), {
    app: {
      get: (...args) => events.push(['get', ...args]),
      use: (...args) => events.push(['use', ...args]),
    },
    sendIndexHtml: jest.fn(),
    presentation: { manifestHandler },
    staticCache: (directory) => directory,
    appConfig: { paths: { dist: '/dist', fonts: '/fonts', assets: '/assets' } },
  });
  const manifestIndex = events.findIndex((event) => event[1] === '/manifest.webmanifest');
  expect(manifestIndex).toBeGreaterThan(-1);
  expect(events[manifestIndex]).toEqual(['get', '/manifest.webmanifest', manifestHandler]);
  expect(manifestIndex).toBeLessThan(events.findIndex((event) => event[0] === 'use'));
});
