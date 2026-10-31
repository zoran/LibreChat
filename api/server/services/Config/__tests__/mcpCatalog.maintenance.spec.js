/** Actual initializer registrations, cache service and sole store; only external ports are controlled. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { CacheKeys } = require('librechat-data-provider');
const catalog = jest.requireActual('@librechat/api');
const publications = catalog;
const { createMCPToolCacheService } = catalog;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
const tick = () => new Promise(setImmediate);
async function until(predicate) {
  for (let i = 0; i < 40; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('Catalog callback original was not dispatched');
}
function load(file, dependencies) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), {
    module,
    process: { env: { JWT_SECRET: 'fixture-only' } },
    require: (id) => {
      if (Object.hasOwn(dependencies, id)) return dependencies[id];
      throw new Error(`Unexpected catalog fixture dependency: ${id}`);
    },
  });
  return module.exports;
}
function fixture() {
  const values = new Map();
  const f = { config: { command: 'fixture', args: [] }, read: undefined, write: undefined };
  const cache = Object.assign(new EventEmitter(), {
    get: jest.fn(async (key) => values.get(key)),
    set: jest.fn(async (key, value) => {
      await f.write?.promise;
      values.set(key, value);
      return true;
    }),
    delete: jest.fn(async (key) => values.delete(key)),
  });
  const registry = {
    getServerConfig: jest.fn(async () => {
      await f.read?.promise;
      return f.config;
    }),
    getAllServerConfigs: async () => ({ server: f.config }),
    isAppServerConfig: async () => true,
    getAllowedDomains: () => undefined,
    getAllowedAddresses: () => undefined,
    reset: jest.fn(async () => {
      f.config = undefined;
    }),
  };
  const store = load('../getCachedTools.js', {
    'librechat-data-provider': { CacheKeys },
    '@librechat/api': { ...catalog, cacheConfig: {}, mcpConfig: {} },
    '~/cache/getLogStores': () => cache,
  });
  const service = load('../mcp.js', {
    '@librechat/api': {
      createMCPToolCacheService,
      MCPServersRegistry: { getInstance: () => registry },
    },
    './getCachedTools': store,
  });
  const startup = load('../../initializeMCPs.js', {
    mongoose: {},
    '@librechat/data-schemas': {
      logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    },
    'librechat-data-provider': require('librechat-data-provider'),
    '@librechat/api': {
      ...publications,
      registerShutdownTask: jest.fn(),
      getDeploymentPluginMcpServers: () => ({}),
      createMCPAppBindingCodec: () => ({}),
    },
    './Config': {
      ...service,
      getAppConfig: async () => ({ mcpConfig: {}, availableTools: {} }),
      invalidateCachedTools: store.invalidateCachedTools,
    },
    './MCPAuthorizationFenceRetry': { startMCPAuthorizationFenceRetryWorker: jest.fn() },
    './Config/mcp': service,
    '~/config': {
      createMCPServersRegistry: jest.fn(),
      createMCPManager: async () => ({ disconnectAppServers: async () => {} }),
    },
  });
  return Object.assign(f, { cache, registry, store, service, startup });
}
afterEach(() => {
  publications.setMCPToolsChangedHandler(null);
  publications.setMCPToolsChangedGenerationHandler(null);
  publications.setMCPToolsChangedGenerationRenewalHandler(null);
  publications.setMCPToolsChangedRevisionHandler(null);
});

test('registered tools callback retains its actual cache write through pause and drain', async () => {
  const f = fixture();
  await f.startup();
  f.cache.set.mockClear();
  f.write = deferred();
  const original = publications.notifyMCPToolsChanged({
    serverName: 'server',
    tools: [],
    serverConfig: f.config,
    publicationRevision: '1',
  });
  await until(() => f.cache.set.mock.calls.length > 0);
  f.store.mcpCatalogMaintenance.pauseAdmissions('catalog');
  let drained = false;
  const drain = f.store.mcpCatalogMaintenance.drain().then(() => {
    drained = true;
  });
  try {
    expect(await f.store.mcpCatalogMaintenance.getMaintenanceCensus('catalog')).toMatchObject({
      queuedContinuations: 1,
      pendingWrites: 1,
    });
    expect(drained).toBe(false);
    await expect(f.service.syncStaticTools({})).rejects.toThrow('APP_QUIESCING');
  } finally {
    f.write.resolve();
  }
  await original;
  await drain;
  expect(drained).toBe(true);
});

test('service config lookup is retained before the eventual cache write', async () => {
  const f = fixture();
  f.read = deferred();
  const original = f.service.updateMCPServerTools({
    serverName: 'server',
    tools: [],
    publicationRevision: '1',
  });
  await until(() => f.registry.getServerConfig.mock.calls.length > 0);
  f.store.mcpCatalogMaintenance.pauseAdmissions('catalog');
  try {
    expect(await f.store.mcpCatalogMaintenance.getMaintenanceCensus('catalog')).toMatchObject({
      queuedContinuations: 1,
      pendingWrites: 0,
    });
    expect(f.cache.set).not.toHaveBeenCalled();
  } finally {
    f.read.resolve();
  }
  await original;
  expect(f.cache.set).toHaveBeenCalledTimes(1);
  await f.store.mcpCatalogMaintenance.drain();
});

test('registered publication preserves its write failure before notification retry normalization', async () => {
  const f = fixture();
  await f.startup();
  f.write = deferred();
  const failure = new Error('publication write failed');
  f.write.reject(failure);
  await publications.notifyMCPToolsChanged({
    serverName: 'server',
    tools: [],
    serverConfig: f.config,
    publicationRevision: '1',
  });
  f.store.mcpCatalogMaintenance.pauseAdmissions('catalog');
  expect(await f.store.mcpCatalogMaintenance.getMaintenanceCensus('catalog')).toMatchObject({
    complete: false,
  });
  await expect(f.store.mcpCatalogMaintenance.drain()).rejects.toMatchObject({ cause: failure });
});

test('actual reinitialization retains the detached refresh publication after its caller returns', async () => {
  const { MCPManager, MCPConnection, MCPServersRegistry } = catalog;
  const f = fixture();
  await f.startup();
  await f.store.getMCPToolsCacheGeneration({ userId: 'user', serverName: 'server' });
  f.registry.resolveAllowlists = async () => ({ useSSRFProtection: false });
  const suppliedConfig = f.config;
  let connection, ping, capabilities, initialSnapshot, refresh;
  // The real factory constructs the connection; only its external transport is controlled.
  const transport = jest
    .spyOn(MCPConnection.prototype, 'connect')
    .mockImplementation(async function () {
      connection = this;
      ping = jest.spyOn(this.client, 'ping').mockResolvedValue({});
      capabilities = jest.spyOn(this.client, 'getServerCapabilities').mockReturnValue({});
      initialSnapshot = jest.spyOn(this, 'fetchOrderedToolsSnapshot').mockResolvedValue({
        tools: [],
        complete: true,
        orderingUnavailable: true,
      });
      refresh = jest.spyOn(this, 'refreshToolList');
      this.emit('connectionChange', 'connected');
    });
  const registry = jest.spyOn(MCPServersRegistry, 'getInstance').mockReturnValue(f.registry);
  const manager = new MCPManager();
  let drain;
  try {
    // Empty startup still executes the real initializer and installs its real repository.
    await manager.initialize({});
    expect(f.registry.reset).toHaveBeenCalledTimes(1);
    expect(await f.registry.getServerConfig('server')).toBeUndefined();
    f.config = suppliedConfig;
    const repository = manager.appConnections;
    expect(repository).not.toBeNull();
    // Register the actual repository's toolsChanged -> notifyMCPToolsChanged continuation.
    expect(await repository.get('server', { refreshTools: false })).toBe(connection);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(ping).toHaveBeenCalledTimes(1);
    const reinitializer = load('../../Tools/mcp.js', {
      '@librechat/data-schemas': {
        logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      },
      '@librechat/api': catalog,
      'librechat-data-provider': require('librechat-data-provider'),
      '~/config': {
        getMCPServersRegistry: () => f.registry,
        getMCPManager: () => manager,
      },
      '~/models': {},
      '~/server/services/GraphTokenService': {},
      '~/server/services/OboTokenService': {},
      '~/server/services/OboPolicyService': { createOboTrustChecker: () => undefined },
      '~/server/services/Config': {
        ...f.service,
        invalidateCachedTools: f.store.invalidateCachedTools,
      },
      '~/cache': { getLogStores: () => f.cache },
      '~/server/services/MCPAuthorizationFenceRetry': {},
    });
    f.cache.set.mockClear();
    f.write = deferred();
    const result = await reinitializer.reinitMCPServer({
      user: { id: 'user' },
      serverName: 'server',
      serverConfig: f.config,
      flowManager: {},
    });
    expect(result).toMatchObject({ success: true, tools: [] });
    expect(initialSnapshot).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await refresh.mock.results[0].value;
    await until(() => f.cache.set.mock.calls.length > 0);
    expect(f.cache.set).toHaveBeenCalledWith(
      expect.stringContaining('tools:mcp:app:'),
      expect.objectContaining({ publicationRevision: expect.any(String), tools: {} }),
      expect.any(Number),
    );
    f.store.mcpCatalogMaintenance.pauseAdmissions('catalog');
    let drained = false;
    drain = f.store.mcpCatalogMaintenance.drain().then(() => {
      drained = true;
    });
    expect(await f.store.mcpCatalogMaintenance.getMaintenanceCensus('catalog')).toMatchObject({
      queuedContinuations: 1,
      pendingWrites: 1,
    });
    expect(drained).toBe(false);
    await expect(f.service.syncStaticTools({})).rejects.toThrow('APP_QUIESCING');
    f.write.resolve();
    await drain;
    expect(await f.store.mcpCatalogMaintenance.getMaintenanceCensus('catalog')).toMatchObject({
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
  } finally {
    f.write?.resolve();
    await manager.disconnectAppServers();
    await (drain ?? f.store.mcpCatalogMaintenance.drain());
    ping?.mockRestore();
    capabilities?.mockRestore();
    initialSnapshot?.mockRestore();
    refresh?.mockRestore();
    transport.mockRestore();
    registry.mockRestore();
  }
});
