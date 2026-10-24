jest.mock('@librechat/api', () => {
  const names = [
    'performStartupChecks',
    'initializeFileStorage',
    'initializeDeploymentSkills',
    'initializeDeploymentPlugins',
    'getDeploymentPluginSkills',
    'getDeploymentPluginHookCapabilities',
    'registerDeploymentPluginHooks',
    'hasDeploymentPluginHooks',
    'hasDeploymentPluginToolApprovalHooks',
    'setPluginHookSource',
    'loadToolApprovalHooks',
    'registerShutdownTask',
    'registerBackgroundTaskShutdown',
    'updateInterfacePermissions',
    'configureAgentEventRuntime',
    'warnOnUnreachableDeliveryPaths',
    'startCodeEnvironmentLifecycleReconciler',
    'loadManagedFileDeploymentConfiguration',
  ];
  return {
    ...Object.fromEntries(names.map((name) => [name, jest.fn()])),
    getRemainingShutdownMs: jest.fn(() => 45_000),
  };
});
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  runAsSystem: (work) => work(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('~/db', () => ({
  connectDb: jest.fn(),
  indexSync: jest.fn(async () => {}),
  modelBootstrap: { capture: jest.fn(), seal: jest.fn(async () => {}) },
}));
jest.mock('~/models', () => ({
  updateAccessPermissions: jest.fn(),
  sweepOrphanedPreviews: jest.fn(),
  getRoleByName: jest.fn(),
  seedDatabase: jest.fn(),
}));
jest.mock('../../Skills/sync', () => ({ initializeGitHubSkillSync: jest.fn() }));
jest.mock('../../Uploads', () => ({ initializeUploads: jest.fn() }));
jest.mock('../../Endpoints/agents/subagentThreadStore', () => ({
  configureSubagentTaskRouting: jest.fn(),
}));
jest.mock('../../Config', () => ({ getAppConfig: jest.fn(async () => ({})) }));
jest.mock('../../status/usage', () => ({ initializeStatusUsage: jest.fn() }));

const api = require('@librechat/api');
const models = require('~/models');
const { initializeUploads } = require('../../Uploads');
const {
  createFileLibraryMaintenance,
  fileLibraryMaintenance,
} = require('../../Files/LibraryMaintenance');
const libraryRun = jest.spyOn(fileLibraryMaintenance, 'run');
const { initializeApplicationRuntime, initializeConnectedRuntime } = require('../runtime');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

describe('web runtime trusted configuration acquisition', () => {
  let previous;
  let libraryOwner;
  const source = 'a'.repeat(40);
  const options = (controller = new AbortController()) => ({
    registry: {},
    identity: { source },
    recordOriginalPublication: jest.fn(),
    projectRoot: '/fixture',
    shutdownTeardownReserveMs: 10_000,
    signal: controller.signal,
    onFailure: jest.fn(),
  });
  beforeEach(() => {
    previous = { ...process.env };
    process.env.BUILD_COMMIT = source;
    for (const suffix of ['IMAGE_DIGEST', 'NAMESPACE_UID', 'CONFIGURATION_SHA256'])
      delete process.env[`CORTEX_RETRIEVAL_EXPECTED_${suffix}`];
    jest.clearAllMocks();
    libraryOwner = createFileLibraryMaintenance();
    libraryRun.mockImplementation((start) => libraryOwner.run(start));
    api.loadManagedFileDeploymentConfiguration.mockResolvedValue(undefined);
    initializeUploads.mockResolvedValue(undefined);
  });
  afterEach(() => {
    process.env = previous;
  });

  it('loads optional absence once before managed work and forwards the original signal', async () => {
    const input = options();
    const prepared = await initializeApplicationRuntime(input);
    expect(api.loadManagedFileDeploymentConfiguration).toHaveBeenCalledTimes(1);
    expect(api.loadManagedFileDeploymentConfiguration).toHaveBeenCalledWith({
      expected: undefined,
      signal: input.signal,
      mode: 'optional',
      onFailure: input.onFailure,
    });
    expect(models.seedDatabase).not.toHaveBeenCalled();
    expect(models.sweepOrphanedPreviews).not.toHaveBeenCalled();
    await prepared.start();
    expect(api.loadManagedFileDeploymentConfiguration.mock.invocationCallOrder[0]).toBeLessThan(
      models.seedDatabase.mock.invocationCallOrder[0],
    );
    expect(initializeUploads).toHaveBeenCalledWith(
      expect.objectContaining({
        trustedFile: undefined,
        signal: input.signal,
        onFailure: input.onFailure,
      }),
    );
  });

  it('captures trusted expectations and forwards the same immutable snapshot', async () => {
    Object.assign(process.env, {
      CORTEX_RETRIEVAL_EXPECTED_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
      CORTEX_RETRIEVAL_EXPECTED_NAMESPACE_UID: '11111111-1111-4111-8111-111111111111',
      CORTEX_RETRIEVAL_EXPECTED_CONFIGURATION_SHA256: 'c'.repeat(64),
    });
    const trustedFile = Object.freeze({ extractionPolicySha256: 'd'.repeat(64) });
    const input = options();
    api.loadManagedFileDeploymentConfiguration.mockImplementation(async ({ expected }) => {
      process.env.CORTEX_RETRIEVAL_EXPECTED_CONFIGURATION_SHA256 = 'e'.repeat(64);
      expect(expected.configurationSha256).toBe('c'.repeat(64));
      return trustedFile;
    });
    await initializeApplicationRuntime(input);
    expect(initializeUploads.mock.calls[0][0].trustedFile).toBe(trustedFile);
    expect(api.loadManagedFileDeploymentConfiguration.mock.calls[0][0].expected).toEqual({
      sourceRevision: source,
      imageDigest: `sha256:${'b'.repeat(64)}`,
      namespaceUid: '11111111-1111-4111-8111-111111111111',
      configurationSha256: 'c'.repeat(64),
    });
  });

  it('retains a failing configuration original before all managed work', async () => {
    const pending = deferred();
    const input = options();
    const failure = new Error('Known mounted configuration failure');
    api.loadManagedFileDeploymentConfiguration.mockImplementation(({ onFailure }) => {
      onFailure(failure);
      return pending.promise;
    });
    const original = initializeApplicationRuntime(input);
    let settled = false;
    void original.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await tick();
      expect(input.onFailure).toHaveBeenCalledWith(failure);
      expect(settled).toBe(false);
      expect(models.seedDatabase).not.toHaveBeenCalled();
      expect(initializeUploads).not.toHaveBeenCalled();
    } finally {
      pending.reject(failure);
    }
    await expect(original).rejects.toBe(failure);
  });

  it('pre-registers late upload cleanup and prevents later startup work after abort', async () => {
    const pending = deferred();
    const controller = new AbortController();
    const input = options(controller);
    const failure = new Error('Original startup aborted');
    const uploads = { close: jest.fn(async () => {}) };
    initializeUploads.mockReturnValue(pending.promise);
    const original = initializeApplicationRuntime(input);
    void original.catch(() => undefined);
    try {
      await tick();
      expect(initializeUploads).toHaveBeenCalledTimes(1);
      expect(api.registerShutdownTask).toHaveBeenCalledWith(
        'managed upload workers',
        expect.any(Function),
        { priority: 105 },
      );
      controller.abort(failure);
    } finally {
      pending.resolve(uploads);
    }
    await expect(original).rejects.toBe(failure);
    const cleanup = api.registerShutdownTask.mock.calls.find(
      ([name]) => name === 'managed upload workers',
    )[1];
    await cleanup();
    expect(uploads.close).toHaveBeenCalledTimes(1);
    expect(api.initializeDeploymentPlugins).not.toHaveBeenCalled();
  });

  it('captures late partial Upload models even when its original preparation rejects', async () => {
    const failure = new Error('partial upload factory');
    initializeUploads.mockRejectedValueOnce(failure);
    await expect(initializeApplicationRuntime(options())).rejects.toBe(failure);
    expect(require('~/db').modelBootstrap.capture).toHaveBeenCalledTimes(1);
  });

  it('prepares actual uploads without dispatching File or background bootstrap', async () => {
    const uploads = { start: jest.fn(), close: jest.fn() };
    initializeUploads.mockResolvedValue(uploads);
    const prepared = await initializeApplicationRuntime(options());
    expect(prepared.uploads).toBe(uploads);
    expect(models.seedDatabase).not.toHaveBeenCalled();
    expect(models.sweepOrphanedPreviews).not.toHaveBeenCalled();
    expect(api.initializeDeploymentPlugins).not.toHaveBeenCalled();
    expect(uploads.start).not.toHaveBeenCalled();
  });

  it('retains the one post-release continuation through original File sweep settlement', async () => {
    const sweep = deferred();
    models.sweepOrphanedPreviews.mockReturnValueOnce(sweep.promise);
    const prepared = await initializeApplicationRuntime(options());
    const first = prepared.start();
    const repeated = prepared.start();
    expect(repeated).toBe(first);
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    try {
      await tick();
      expect(models.seedDatabase).toHaveBeenCalledTimes(1);
      expect(models.sweepOrphanedPreviews).toHaveBeenCalledTimes(1);
      expect(libraryOwner.pauseAdmissions('native-file-hold')).toBe(true);
      expect(await libraryOwner.getMaintenanceCensus('native-file-hold')).toMatchObject({
        admissionClosed: true,
        pendingWrites: 1,
        complete: true,
      });
      expect(settled).toBe(false);
      expect(api.initializeDeploymentPlugins).not.toHaveBeenCalled();
    } finally {
      sweep.resolve();
    }
    await first;
    expect(settled).toBe(true);
    expect(await libraryOwner.getMaintenanceCensus('native-file-hold')).toMatchObject({
      admissionClosed: true,
      pendingWrites: 0,
      complete: true,
    });
    expect(api.performStartupChecks).toHaveBeenCalledTimes(1);
  });

  it('refuses a new startup File sweep during a hold and retains an unknown original failure', async () => {
    libraryOwner.pauseAdmissions('before-sweep');
    const paused = await initializeApplicationRuntime(options());
    await expect(paused.start()).rejects.toThrow('FILE_LIBRARY_QUIESCING');
    expect(models.sweepOrphanedPreviews).not.toHaveBeenCalled();
    expect(libraryOwner.resumeAdmissions('before-sweep')).toBe(true);
    const failure = new Error('Original startup File write is unconfirmed');
    models.sweepOrphanedPreviews.mockRejectedValueOnce(failure);
    const failed = await initializeApplicationRuntime(options());
    const original = failed.start();
    await expect(original).rejects.toBe(failure);
    expect(failed.start()).toBe(original);
    libraryOwner.pauseAdmissions('after-failure');
    expect(await libraryOwner.getMaintenanceCensus('after-failure')).toMatchObject({
      admissionClosed: true,
      pendingWrites: 0,
      complete: false,
    });
    expect(models.sweepOrphanedPreviews).toHaveBeenCalledTimes(1);
  });

  it('refuses dispatch after startup abort and retains a rejected original without retry', async () => {
    const controller = new AbortController();
    const prepared = await initializeApplicationRuntime(options(controller));
    const failure = new Error('Startup closed before release');
    controller.abort(failure);
    const first = prepared.start();
    await expect(first).rejects.toBe(failure);
    expect(prepared.start()).toBe(first);
    expect(models.seedDatabase).not.toHaveBeenCalled();
    expect(models.sweepOrphanedPreviews).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'])(
    'retains the first reconciliation before index dispatch: %s',
    async (outcome) => {
      const database = require('~/db');
      const reconcile = deferred();
      api.startCodeEnvironmentLifecycleReconciler.mockReturnValueOnce(reconcile.promise);
      const prepared = await initializeConnectedRuntime({ mongoose: {}, identity: { source } });
      const first = prepared.start();
      const observed = first.catch((error) => error);
      const failure = new Error('original reconciliation failed');
      try {
        await tick();
        expect(prepared.start()).toBe(first);
        expect(api.startCodeEnvironmentLifecycleReconciler).toHaveBeenCalledTimes(1);
        expect(database.indexSync).not.toHaveBeenCalled();
      } finally {
        if (outcome === 'resolve') reconcile.resolve();
        else reconcile.reject(failure);
      }
      expect(await observed).toBe(outcome === 'resolve' ? undefined : failure);
      expect(database.indexSync).toHaveBeenCalledTimes(outcome === 'resolve' ? 1 : 0);
      expect(prepared.start()).toBe(first);
    },
  );

  it('defers connected background work and retains the actual index original', async () => {
    const database = require('~/db');
    const status = { recordOriginalPublication: jest.fn() };
    require('../../status/usage').initializeStatusUsage.mockResolvedValueOnce(status);
    const index = deferred();
    database.indexSync.mockReturnValueOnce(index.promise);
    const prepared = await initializeConnectedRuntime({ mongoose: {}, identity: { source } });
    expect(prepared.statusUsage).toBe(status);
    expect(database.connectDb).toHaveBeenCalledTimes(1);
    expect(api.startCodeEnvironmentLifecycleReconciler).not.toHaveBeenCalled();
    expect(database.indexSync).not.toHaveBeenCalled();
    const sealed = deferred();
    database.modelBootstrap.seal.mockReturnValueOnce(sealed.promise);
    expect(prepared.completeBootstrap()).toBe(sealed.promise);
    sealed.resolve();
    const first = prepared.start();
    expect(prepared.start()).toBe(first);
    let settled = false;
    void first.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const failure = new Error('Original indexing failed');
    try {
      await tick();
      expect(api.startCodeEnvironmentLifecycleReconciler).toHaveBeenCalledTimes(1);
      expect(database.indexSync).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
    } finally {
      index.reject(failure);
    }
    await expect(first).rejects.toBe(failure);
    expect(prepared.start()).toBe(first);
  });
});

describe('web startup original custody', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const { EventEmitter } = require('node:events');
  const { Server } = require('node:http');
  const shutdown = jest.requireActual('../../../../../packages/api/src/app/shutdown');
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const noop = () => undefined;
  const inert = new Proxy(noop, { get: (_target, key) => (key === 'then' ? undefined : inert) });
  // Use this suite's normal Babel presets for the actual TS owner in the existing web VM fixture.
  const lifecycleSource = require('@babel/core').transformFileSync(
    path.join(__dirname, '../../../../../packages/api/src/code/lifecycle.ts'),
    {
      babelrc: false,
      configFile: false,
      presets: [
        ['@babel/preset-env', { targets: { node: 'current' } }],
        '@babel/preset-typescript',
      ],
    },
  ).code;
  function lifecycleOwner(code = {}) {
    const original = { exports: {} };
    vm.runInNewContext(lifecycleSource, {
      exports: original.exports,
      setInterval,
      clearInterval,
      require: (id) => {
        if (id === '~/cluster') return { isLeader: code.isLeader ?? (async () => false) };
        if (id === '@librechat/data-schemas')
          return {
            ...require(id),
            createMethods: () => code.methods ?? {},
          };
        if (id === './bridge')
          return jest.requireActual('../../../../../packages/api/src/code/bridge');
        return require(id);
      },
    });
    return original.exports.createCodeEnvironmentLifecycleMaintenance();
  }
  let exit;
  function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void promise.catch(noop);
    return { promise, resolve, reject };
  }
  function execute({
    application,
    release = Promise.resolve(),
    mcps = jest.fn(async () => {}),
    construct = noop,
    dependentClose,
    strategy,
    code,
    catalogStartup,
  }) {
    const app = { locals: {} };
    for (const method of ['disable', 'set', 'use', 'get', 'post', 'all'])
      app[method] = jest.fn(() => app);
    const server = new Server();
    server.address = () => ({ address: '127.0.0.1', port: 0 });
    app.listen = jest.fn((_port, _host, callback) => {
      queueMicrotask(() => {
        void callback();
      });
      return server;
    });
    const express = new Proxy(() => app, { get: () => inert });
    const maintenance = {
      identity: { source: 'a'.repeat(40) },
      admissionMiddleware: noop,
      listen: jest.fn(async () => {}),
      close: jest.fn(async () => {}),
      waitForStartupRelease: jest.fn(async () => {
        await release;
        catalog.maintenance.resumeAdmissions('startup_fixture');
      }),
    };
    const { createMCPCatalogStore } = jest.requireActual(
      '../../../../../packages/api/src/mcp/catalog/store',
    );
    const catalogValues = new Map();
    const catalogCache = {
      get: jest.fn(async (key) => catalogValues.get(key)),
      set: jest.fn(async (key, value) => {
        catalogStartup?.capture?.(require('node:async_hooks').AsyncLocalStorage.snapshot());
        await catalogStartup?.write?.promise;
        catalogValues.set(key, value);
        return true;
      }),
      delete: jest.fn(async (key) => catalogValues.delete(key)),
    };
    const catalog = createMCPCatalogStore({ cacheConfig: {}, getCache: () => catalogCache });
    const startupClient = {};
    const connection = Object.assign(new EventEmitter(), {
      db: {},
      getClient: () => startupClient,
      readyState: 0,
      close: jest.fn(async () => {}),
    });
    const databaseMongoose = { connection, models: {}, set: noop };
    databaseMongoose.connect = jest.fn(async () => {
      connection.readyState = 1;
      return databaseMongoose;
    });
    if (code?.models) Object.assign(databaseMongoose.models, code.models);
    if (code?.db) databaseMongoose.connection.db = code.db;
    databaseMongoose.Types = jest.requireActual('mongoose').Types;
    const lifecycle = lifecycleOwner(code);
    const permissions = jest
      .requireActual('../../PermissionMaintenance')
      .createPermissionMaintenance();
    // Runtime proves composition identity; actual cache admission is qualified in the App fixture.
    const mongoCache = {
      bindAuth: jest.fn(),
      stopAdmissions: noop,
      drain: async () => {},
      maintenance: {},
    };
    const retry = jest
      .requireActual('../../../../../packages/api/src/mcp/authorizationRetry')
      .createMCPAuthorizationFenceRetryService({
        storage: {
          upsert: async () => {},
          deleteVersion: async () => {},
          deferVersion: async () => {},
          list: async () => [],
        },
        getTenantId: () => undefined,
        runInRetryScope: (_retry, action) => action(),
        registerShutdown: shutdown.registerShutdownTask,
      });
    let database;
    let connected = {
      start: jest.fn(async () => {}),
      completeBootstrap: () => database.modelBootstrap.seal(),
    };
    const connectorModule = {
      getDbConnector: ({ onFailure }) =>
        (database = jest.requireActual('../../../../db/connect').createDbConnector({
          mongoose: databaseMongoose,
          env: { MONGO_URI: 'mongodb://fixture-only' },
          logger: { info: noop, error: noop },
          optionalEnabled: noop,
          instrumentMongooseQueryMetrics: noop,
          onFailure,
        })),
    };
    const api = new Proxy(
      {
        ...shutdown,
        cacheConfig: {},
        getOrdinaryS3Provider: jest.fn(() => ({ state: 'uninitialized' })),
        createAppMaintenance: jest.fn(() => {
          catalog.maintenance.pauseAdmissions('startup_fixture');
          return maintenance;
        }),
        createMetrics: () => ({ metricsMiddleware: noop, metricsRouter: noop, registry: {} }),
        waitForRedisStartup: jest.fn(async () => {}),
        fileDeletionWorkOwner: { stopAdmissions: noop, drain: noop, maintenance: {} },
        codeEnvironmentLifecycleMaintenance: lifecycle,
        mongoCacheMaintenance: mongoCache,
        startCodeEnvironmentLifecycleReconciler: (options) =>
          lifecycle.start({ ...options, ...code?.options }),
        GenerationJobManager: inert,
        createPresentation: () => ({ fixedLanguage: 'de' }),
        createSecurityHeaders: () => undefined,
      },
      { get: (target, key) => (key in target ? target[key] : inert) },
    );
    // This runtime fixture proves the real startup owner's composition; helper effects have their own suite.
    const migrationModule = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../migration.js'), 'utf8'), {
      module: migrationModule,
      require: (id) => {
        if (id === 'mongoose') return databaseMongoose;
        if (id === '~/models') return { findRoleByIdentifier: noop };
        if (id === '@librechat/api')
          return {
            checkAgentPermissionsMigration: async () => ({ totalToMigrate: 0 }),
            checkPromptPermissionsMigration: async () => ({ totalToMigrate: 0 }),
            logAgentMigrationWarning: noop,
            logPromptMigrationWarning: noop,
          };
        throw new Error(`Unexpected migration fixture dependency: ${id}`);
      },
    });
    const startupMigration = migrationModule.exports.startupMigrationMaintenance;
    const passport = new (jest.requireActual('passport').Passport)();
    const authModule = { exports: {} };
    vm.runInNewContext(
      fs.readFileSync(path.join(__dirname, '../../LegacyAuthMaintenance.js'), 'utf8'),
      {
        module: authModule,
        require: (id) => {
          if (id !== '@librechat/api') throw new Error(`Unexpected auth fixture dependency: ${id}`);
          return {
            ...jest.requireActual('../../../../../packages/api/src/auth/maintenance'),
            ...jest.requireActual('../../../../../packages/api/src/auth/sessionMaintenance'),
            mongoCacheMaintenance: mongoCache,
          };
        },
      },
    );
    const auth = { ...authModule.exports, getBrowserAuth: () => inert };
    const startupErrors = jest.fn();
    const localProcess = {
      env: { BUILD_COMMIT: 'a'.repeat(40), PORT: '0', LOG_TO_FILE: 'false' },
      execArgv: [],
      on: jest.fn(),
      exit,
    };
    const requires = {
      '@librechat/api': api,
      '@librechat/data-schemas': {
        logger: { info: noop, warn: noop, error: startupErrors },
        runAsSystem: (work) => work(),
      },
      express,
      passport,
      mongoose: databaseMongoose,
      '../db/connect': connectorModule,
      fs: { readFileSync: () => '<html><head></head><body></body></html>' },
      path,
      'module-alias': () => {},
      './services/start/runtime': {
        initializeConnectedRuntime: jest.fn(async () => {
          await database.connect();
          return connected;
        }),
        initializeApplicationRuntime: application,
      },
      './services/initializeMCPs': mcps,
      './services/Config/getCachedTools': {
        mcpCatalogMaintenance: catalog.maintenance,
        runMCPToolPublication: catalog.trackPublication,
      },
      './services/start/migration': migrationModule.exports,
      './services/Uploads': {
        uploadMaintenance: { readStorageProvider: () => ({ state: 'uninitialized' }) },
      },
      './services/Files/LibraryMaintenance': {
        fileLibraryMaintenance: createFileLibraryMaintenance(),
      },
      './services/HistoryMaintenance': {
        historyMaintenance: jest
          .requireActual('../../HistoryMaintenance')
          .createHistoryMaintenance(),
      },
      './services/LegacyAuthMaintenance': auth,
      './services/PermissionMaintenance': { permissionMaintenance: permissions },
      './services/MCPAuthorizationFenceRetry': {
        mcpAuthorizationFenceRetryMaintenance: retry.maintenance,
      },
    };
    const maintenanceModule = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../maintenance.js'), 'utf8'), {
      module: maintenanceModule,
      process: localProcess,
      require: (id) => {
        if (id !== '@librechat/api') throw new Error(`Unexpected maintenance dependency: ${id}`);
        return api;
      },
    });
    requires['./services/start/maintenance'] = maintenanceModule.exports;
    if (dependentClose || code || catalogStartup) {
      // Execute the actual startup runtime's managed Upload close registration with the real shutdown owner.
      const runtimeModules = {
        axios: {},
        '@librechat/api': api,
        '@librechat/data-schemas': requires['@librechat/data-schemas'],
        '~/models': inert,
        '../Skills/sync': inert,
        '../Files/LibraryMaintenance': requires['./services/Files/LibraryMaintenance'],
        '../Endpoints/agents/subagentThreadStore': inert,
        '../Config': {
          getAppConfig: async () => ({
            paths: { dist: '/fixture/dist', fonts: '/fixture/fonts', assets: '/fixture/assets' },
          }),
        },
        '../Uploads': {
          initializeUploads: async () => ({
            close: dependentClose,
            configureSourceReplay: noop,
            start: noop,
            router: inert,
          }),
        },
        '../status/usage': { initializeStatusUsage: async () => undefined },
      };
      const loadRuntime = () => {
        const module = { exports: {} };
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../runtime.js'), 'utf8'), {
          module,
          require: (id) =>
            id === '~/db'
              ? {
                  modelBootstrap: database.modelBootstrap,
                  connectDb: () => database.connect(),
                  indexSync: code?.indexSync ?? noop,
                }
              : runtimeModules[id],
          process: localProcess,
          AbortSignal,
        });
        return module.exports;
      };
      if (catalogStartup) {
        const { createAppConfigService } = jest.requireActual(
          '../../../../../packages/api/src/app/service',
        );
        const configValues = new Map();
        const configCache = {
          get: async (key) => configValues.get(key),
          set: async (key, value) => {
            configValues.set(key, value);
            return true;
          },
          delete: async (key) => configValues.delete(key),
        };
        const configModule = { exports: {} };
        vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../Config/app.js'), 'utf8'), {
          module: configModule,
          require: (id) => {
            if (id === 'mongoose') return databaseMongoose;
            if (id === 'librechat-data-provider') return require(id);
            if (id === '@librechat/data-schemas')
              return {
                logger: requires[id].logger,
                AppService: async () => ({
                  availableTools: {},
                  paths: {
                    dist: '/fixture/dist',
                    fonts: '/fixture/fonts',
                    assets: '/fixture/assets',
                  },
                }),
              };
            if (id === '@librechat/api') return { createAppConfigService, cacheConfig: {} };
            if (id === './getCachedTools') return catalog;
            if (id === './loadCustomConfig') return async () => ({});
            if (id === '~/cache/getLogStores') return () => configCache;
            if (id === '~/server/services/start/tools') return { loadAndFormatTools: () => ({}) };
            if (id === '~/config/paths') return {};
            if (id === '~/models') return { initializeMessageBudget: noop };
            throw new Error(`Unexpected cold config dependency: ${id}`);
          },
        });
        runtimeModules['../Config'] = configModule.exports;
      }
      if (dependentClose || catalogStartup)
        requires['./services/start/runtime'].initializeApplicationRuntime = (options) =>
          loadRuntime().initializeApplicationRuntime(options);
      if (code)
        requires['./services/start/runtime'].initializeConnectedRuntime = async (options) => {
          connected = await loadRuntime().initializeConnectedRuntime(options);
          return connected;
        };
    }
    vm.runInNewContext(
      fs.readFileSync(path.join(__dirname, '../../../index.js'), 'utf8'),
      {
        require: (id) => {
          if (id === '~/db')
            return database.modelBootstrap.construct(() => construct(databaseMongoose));
          if (id === '~/strategies') {
            // Real registrations can occur during module preparation, before public startup.
            if (strategy) passport.use(strategy);
            return {
              jwtLogin: () => ({ name: 'jwt', authenticate: noop }),
              passportLogin: () => ({ name: 'local', authenticate: noop }),
              ldapLogin: { name: 'ldap', authenticate: noop },
            };
          }
          return id in requires ? requires[id] : inert;
        },
        __dirname,
        module: { exports: {} },
        process: localProcess,
        AbortSignal,
        AbortController,
        URL,
        Buffer,
        setTimeout,
        clearTimeout,
        queueMicrotask,
      },
      { filename: 'actual-web-index.js' },
    );
    return {
      app,
      server,
      auth,
      passport,
      history: requires['./services/HistoryMaintenance'].historyMaintenance,
      lifecycle,
      permissions,
      mongoCache,
      startupMigration,
      catalog,
      catalogCache,
      retry,
      startupErrors,
      maintenance,
      api,
      connected,
      connection,
      databaseMongoose,
      get database() {
        return database;
      },
    };
  }
  beforeEach(() => {
    shutdown.__resetShutdownStateForTests();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    exit = jest.spyOn(process, 'exit').mockImplementation(noop);
  });
  afterEach(() => {
    shutdown.__resetShutdownStateForTests();
    jest.useRealTimers();
    exit.mockRestore();
  });

  it('supplies the original signal before runtime acquisition and joins a held original on shutdown', async () => {
    const pending = deferred();
    const application = jest.fn(() => pending.promise);
    const { app } = execute({ application });
    try {
      await tick();
      expect(application).toHaveBeenCalledTimes(1);
      expect(application.mock.calls[0][0].signal).toBe(shutdown.getShutdownSignal());
      void shutdown.requestGracefulShutdown('startup_failure');
      await tick();
      expect(exit).not.toHaveBeenCalled();
      expect(app.listen).not.toHaveBeenCalled();
    } finally {
      pending.reject(new Error('Original startup settled'));
    }
    await tick();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('starts the existing failure deadline before a held configuration original settles', async () => {
    const pending = deferred();
    const application = jest.fn(() => pending.promise);
    execute({ application });
    try {
      await tick();
      const { onFailure, signal } = application.mock.calls[0][0];
      expect(onFailure).toEqual(expect.any(Function));
      onFailure(new Error('Known read failure before original close'));
      expect(signal.aborted).toBe(true);
      jest.advanceTimersByTime(59_999);
      expect(exit).not.toHaveBeenCalled();
      onFailure(new Error('Repeated failure cannot renew deadline'));
      jest.advanceTimersByTime(1);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      pending.reject(new Error('Original close settled'));
      await shutdown.requestGracefulShutdown('startup_failure');
    }
  });

  it('keeps post-listen startup inside the original and never starts uploads after abort', async () => {
    const pending = deferred();
    const uploads = { start: jest.fn(), configureSourceReplay: jest.fn() };
    const application = jest.fn(async () => ({
      appConfig: {
        paths: { dist: '/fixture/dist', fonts: '/fixture/fonts', assets: '/fixture/assets' },
      },
      uploads,
      start: jest.fn(async () => {}),
    }));
    const mcps = jest.fn(() => pending.promise);
    const { app } = execute({ application, mcps });
    try {
      await tick();
      expect(app.listen).toHaveBeenCalledTimes(1);
      expect(mcps).toHaveBeenCalledTimes(1);
      void shutdown.requestGracefulShutdown('startup_failure');
      await tick();
      expect(exit).not.toHaveBeenCalled();
      expect(uploads.start).not.toHaveBeenCalled();
    } finally {
      pending.resolve();
    }
    await tick();
    expect(uploads.start).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('holds actual web dispatch until release and retains post-release bootstrap before listening', async () => {
    const release = deferred();
    const bootstrap = deferred();
    const start = jest.fn(() => bootstrap.promise);
    const application = jest.fn(async () => ({
      appConfig: {
        paths: { dist: '/fixture/dist', fonts: '/fixture/fonts', assets: '/fixture/assets' },
      },
      start,
    }));
    const { app, maintenance, api, connected } = execute({ application, release: release.promise });
    try {
      await tick();
      expect(api.createAppMaintenance).toHaveBeenCalledWith(
        expect.objectContaining({ startupAdmission: 'closed' }),
      );
      expect(maintenance.listen).toHaveBeenCalledTimes(1);
      expect(maintenance.waitForStartupRelease).toHaveBeenCalledWith(shutdown.getShutdownSignal());
      expect(connected.start).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(app.listen).not.toHaveBeenCalled();
      release.resolve();
      await tick();
      expect(connected.start).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledTimes(1);
      expect(app.listen).not.toHaveBeenCalled();
      void shutdown.requestGracefulShutdown('startup_failure');
      await tick();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      bootstrap.resolve();
    }
    await tick();
    expect(app.listen).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });
  it('joins models before exposing the private listener and publishes only its real bootstrap port', async () => {
    const original = deferred();
    const release = deferred();
    const application = jest.fn(async () => ({ appConfig: {}, start: jest.fn() }));
    const state = execute({
      application,
      release: release.promise,
      construct: (m) => {
        m.models.Pending = { $init: original.promise, init: jest.fn(() => original.promise) };
      },
    });
    try {
      await tick();
      expect(state.maintenance.listen).not.toHaveBeenCalled();
      const selected = state.api.createAppMaintenance.mock.calls[0][0];
      expect(selected.readStorageProviders()).toEqual({
        ordinaryS3: { state: 'uninitialized' },
        managedS3: { state: 'uninitialized' },
      });
      expect(selected.workOwners.databaseBootstrap).toBe(state.database.modelBootstrap.maintenance);
      expect(typeof selected.workOwners.history.getMaintenanceCensus).toBe('function');
      expect(selected.workOwners.auth).toBe(state.auth.legacyAuthMaintenance);
      expect(selected.workOwners.codeLifecycle).toBe(state.lifecycle);
      expect(selected.workOwners.permissions).toBe(state.permissions);
      expect(selected.workOwners.mcpAuthorizationRetry).toBe(state.retry.maintenance);
      expect(selected.workOwners.mongoCache).toBe(state.mongoCache.maintenance);
      expect(selected.workOwners.startupCollections).toBe(state.startupMigration.maintenance);
      expect(selected.fileDomainOwners).toEqual(
        expect.arrayContaining([
          'databaseBootstrap',
          'startupCollections',
          'fileLibrary',
          'uploads',
          'history',
        ]),
      );
      expect(state.mongoCache.bindAuth).toHaveBeenCalledTimes(1);
      expect(state.mongoCache.bindAuth).toHaveBeenCalledWith(state.auth.legacyAuthMaintenance);
      expect(state.api.createAppMaintenance).toHaveBeenCalledTimes(1);
      expect(selected.startupAdmission).toBe('closed');
      expect(selected.unqualifiedOwners).toEqual([
        'raw database commands, sessions and independent writers outside qualified owners',
        'standalone tag/share and other HTTP mutations',
        'MCP/OAuth reconnect, search indexing, code lifecycle and remaining background owners',
      ]);
      const history = selected.workOwners.history;
      expect(history.pauseAdmissions('actual-web')).toBe(true);
      expect(await history.getMaintenanceCensus('actual-web')).toMatchObject({
        admissionClosed: true,
        pendingWrites: 0,
        complete: true,
      });
      expect(selected.unqualifiedOwners.join(' ')).toContain('raw database commands');
      original.resolve();
      await tick();
      expect(state.maintenance.listen).toHaveBeenCalledTimes(1);
    } finally {
      original.resolve();
      const stopping = shutdown.requestGracefulShutdown('startup_failure');
      release.reject(new Error('fixture settled'));
      await stopping;
    }
  });

  it('preregisters custody before partial model construction and never connects to settle an aborted original', async () => {
    const original = deferred();
    const failure = new Error('partial web models');
    const state = execute({
      application: jest.fn(),
      construct: (m) => {
        m.models.Partial = { $init: original.promise, init: jest.fn(() => original.promise) };
        throw failure;
      },
    });
    try {
      await tick();
      expect(shutdown.isShutdownInProgress()).toBe(true);
      expect(state.databaseMongoose.connect).not.toHaveBeenCalled();
      expect(state.connection.close).not.toHaveBeenCalled();
      expect(state.app.listen).not.toHaveBeenCalled();
      jest.advanceTimersByTime(59_999);
      expect(exit).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      original.resolve();
    }
    await tick();
    expect(state.connection.close).not.toHaveBeenCalled();
  });

  it('never closes Mongo when actual managed Upload cleanup remains held or rejects', async () => {
    const closeOriginal = deferred();
    const release = deferred();
    const close = jest.fn(() => closeOriginal.promise);
    const state = execute({ dependentClose: close, release: release.promise });
    await tick();
    const stopping = shutdown.requestGracefulShutdown('startup_failure');
    release.reject(new Error('startup release aborted'));
    try {
      await tick();
      expect(close).toHaveBeenCalledTimes(1);
      expect(state.connection.close).not.toHaveBeenCalled();
      jest.advanceTimersByTime(59_999);
      expect(exit).not.toHaveBeenCalled();
      expect(shutdown.requestGracefulShutdown('startup_failure')).toBe(stopping);
      jest.advanceTimersByTime(1);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      closeOriginal.reject(new Error('dependent Mongo work unresolved'));
    }
    await stopping;
    expect(state.connection.close).not.toHaveBeenCalled();
  });
  it('joins actual Passport preparation, terminal descendants and history before managed Upload teardown', async () => {
    const release = deferred();
    const returned = deferred();
    const child = deferred();
    const historyOriginal = deferred();
    const close = jest.fn(async () => {});
    let complete;
    let preparationOwner;
    const authenticate = jest.fn(function (_req) {
      preparationOwner = state.auth.legacyAuthMaintenance.current();
      complete = () => this.success({ id: 'accepted-user' });
      return returned.promise;
    });
    const state = execute({
      dependentClose: close,
      release: release.promise,
      strategy: { name: 'original-auth', authenticate },
    });
    const owner = state.auth.legacyAuthMaintenance;
    let callbackOwner;
    let childWork;
    const callback = jest.fn(() => {
      callbackOwner = owner.current();
      childWork = callbackOwner?.write(() => child.promise);
    });
    const req = {};
    const res = Object.assign(new EventEmitter(), { end: jest.fn() });
    let stopping;
    let historyWork;
    try {
      await tick();
      expect(state.maintenance.waitForStartupRelease).toHaveBeenCalledTimes(1);
      expect(state.startupErrors).not.toHaveBeenCalled();
      expect(shutdown.isShutdownInProgress()).toBe(false);
      expect(state.app.listen).not.toHaveBeenCalled();
      expect(state.passport._strategy('original-auth').authenticate).not.toBe(authenticate);
      state.passport.initialize()(req, res, noop);
      owner.admissionMiddleware(req, res, () => {
        state.passport.authenticate('original-auth', { session: false }, callback)(req, res, noop);
      });
      expect(preparationOwner).toBe(owner.forRequest(req));
      historyWork = state.history.run({}, () => historyOriginal.promise);
      res.emit('close');
      stopping = shutdown.requestGracefulShutdown('startup_failure');
      release.reject(new Error('startup aborted while accepted work remains'));
      await tick();
      await expect(owner.run(undefined, jest.fn())).rejects.toThrow('APP_QUIESCING');
      expect(close).not.toHaveBeenCalled();
      expect(exit).not.toHaveBeenCalled();
      historyOriginal.resolve();
      await historyWork;
      returned.resolve();
      await tick();
      expect(callback).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      complete();
      await tick();
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callbackOwner).toBe(preparationOwner);
      expect(close).not.toHaveBeenCalled();
      child.resolve();
      await childWork;
      await stopping;
      expect(close).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      release.reject(new Error('fixture cleanup'));
      historyOriginal.resolve();
      returned.resolve();
      complete?.();
      child.resolve();
      await historyWork;
      await childWork;
      await shutdown.requestGracefulShutdown('startup_failure');
    }
  });

  it('keeps actual managed Upload cleanup blocked through the original deadline after auth uncertainty', async () => {
    const release = deferred();
    const original = deferred();
    const close = jest.fn(async () => {});
    const state = execute({
      dependentClose: close,
      release: release.promise,
    });
    await tick();
    expect(state.maintenance.waitForStartupRelease).toHaveBeenCalledTimes(1);
    expect(state.startupErrors).not.toHaveBeenCalled();
    expect(shutdown.isShutdownInProgress()).toBe(false);
    const owner = state.auth.legacyAuthMaintenance;
    const work = owner.run(undefined, (operation) => operation.write(() => original.promise));
    const observed = work.catch((error) => error);
    const stopping = shutdown.requestGracefulShutdown('startup_failure');
    release.reject(new Error('startup aborted'));
    await tick();
    expect(close).not.toHaveBeenCalled();
    const failure = new Error('original auth persistence failed');
    original.reject(failure);
    expect(await observed).toBe(failure);
    await tick();
    expect(close).not.toHaveBeenCalled();
    expect(shutdown.requestGracefulShutdown('startup_failure')).toBe(stopping);
    jest.advanceTimersByTime(59_999);
    expect(exit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(close).not.toHaveBeenCalled();
  });
  it('joins the actual first lifecycle and subsequent index originals before managed Upload teardown', async () => {
    const election = deferred();
    const indexing = deferred();
    const close = jest.fn(async () => {});
    const indexSync = jest.fn(() => indexing.promise);
    const isLeader = jest.fn(() => election.promise);
    const state = execute({ dependentClose: close, code: { isLeader, indexSync } });
    let stopping;
    try {
      await tick();
      expect(isLeader).toHaveBeenCalledTimes(1);
      expect(indexSync).not.toHaveBeenCalled();
      expect(state.api.createAppMaintenance.mock.calls[0][0].workOwners.codeLifecycle).toBe(
        state.lifecycle,
      );
      expect(state.app.listen).not.toHaveBeenCalled();
      stopping = shutdown.requestGracefulShutdown('startup_failure');
      await tick();
      await expect(state.lifecycle.start({ mongoose: state.databaseMongoose })).rejects.toThrow(
        'CODE_LIFECYCLE_ADMISSION_CLOSED',
      );
      expect(close).not.toHaveBeenCalled();
      election.resolve(false);
      await tick();
      expect(indexSync).toHaveBeenCalledTimes(1);
      expect(close).not.toHaveBeenCalled();
    } finally {
      election.resolve(false);
      indexing.resolve();
    }
    await stopping;
    expect(close).toHaveBeenCalledTimes(1);
    expect(state.app.listen).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('keeps actual teardown blocked after an absorbed lifecycle provider timeout and durable retry settlement', async () => {
    const retry = deferred();
    const close = jest.fn(async () => {});
    const id = new (jest.requireActual('mongoose').Types.ObjectId)();
    const environment = {
      _id: id,
      workerId: 'fixture-worker',
      workerPrincipal: { type: 'user' },
      baseURL: 'https://fixture.invalid',
      revocationTokenEnv: 'FIXTURE_ONLY',
    };
    const query = (value) => {
      const result = { lean: async () => value };
      for (const name of ['hint', 'sort', 'limit', 'select']) result[name] = () => result;
      return result;
    };
    const model = (methods) => {
      const original = Promise.resolve();
      return { $init: original, init: () => original, ...methods };
    };
    const updateOne = jest.fn(() => retry.promise);
    const code = {
      isLeader: async () => true,
      options: {
        readSecret: () => 'fixture-only',
        fetchImpl: jest.fn(async () => {
          throw Object.assign(new Error('unobserved remote result'), { name: 'TimeoutError' });
        }),
      },
      db: {
        collection: () => ({
          updateOne: async () => ({ matchedCount: 1 }),
          findOne: async () => ({ lastId: null, upperId: id }),
        }),
      },
      models: {
        CodeEnvironment: model({
          find: (filter) => query('registrationPendingAt' in filter ? [environment] : []),
          findOneAndUpdate: () => query(environment),
          updateOne,
          aggregate: async () => [],
        }),
        AclEntry: model({ deleteMany: async () => {} }),
        User: model({ collection: { name: 'users' } }),
      },
    };
    const state = execute({ dependentClose: close, code });
    try {
      await tick();
      expect(code.options.fetchImpl).toHaveBeenCalledTimes(1);
      expect(updateOne).toHaveBeenCalledTimes(1);
      expect(await state.lifecycle.getMaintenanceCensus(null)).toMatchObject({
        queuedContinuations: 1,
        pendingWrites: 1,
        complete: false,
      });
      const stopping = shutdown.requestGracefulShutdown('startup_failure');
      await tick();
      expect(close).not.toHaveBeenCalled();
      retry.resolve();
      await tick();
      expect(await state.lifecycle.getMaintenanceCensus(null)).toMatchObject({
        queuedContinuations: 0,
        pendingWrites: 0,
        complete: false,
      });
      expect(close).not.toHaveBeenCalled();
      expect(shutdown.requestGracefulShutdown('startup_failure')).toBe(stopping);
      jest.advanceTimersByTime(59_999);
      expect(exit).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(exit).toHaveBeenCalledWith(1);
      expect(close).not.toHaveBeenCalled();
    } finally {
      retry.resolve();
      await tick();
    }
  });
  it('cold catalog preparation settles before private listen and held startup B', async () => {
    const release = deferred();
    const write = deferred();
    const state = execute({ release: release.promise, catalogStartup: { write } });
    try {
      for (let i = 0; i < 40 && state.catalogCache.set.mock.calls.length === 0; i++) await tick();
      expect(state.startupErrors).not.toHaveBeenCalled();
      expect(state.catalogCache.set).toHaveBeenCalledTimes(1);
      expect(state.api.createAppMaintenance.mock.calls[0][0].startupAdmission).toBe('closed');
      expect(state.api.createAppMaintenance.mock.calls[0][0].unqualifiedOwners).toHaveLength(3);
      expect(state.maintenance.listen).not.toHaveBeenCalled();
      expect(state.app.listen).not.toHaveBeenCalled();
      expect(await state.catalog.maintenance.getMaintenanceCensus('startup_fixture')).toMatchObject(
        { queuedContinuations: 1, pendingWrites: 1 },
      );
      await expect(state.catalog.setCachedTools({})).rejects.toThrow('APP_QUIESCING');
      write.resolve();
      for (
        let i = 0;
        i < 40 && state.maintenance.waitForStartupRelease.mock.calls.length === 0;
        i++
      )
        await tick();
      expect(state.maintenance.listen).toHaveBeenCalledTimes(1);
      expect(state.maintenance.waitForStartupRelease).toHaveBeenCalledTimes(1);
      expect(state.app.listen).not.toHaveBeenCalled();
      expect(await state.catalog.maintenance.getMaintenanceCensus('startup_fixture')).toMatchObject(
        { queuedContinuations: 0, pendingWrites: 0, complete: true },
      );
      // B stays held: catalog shutdown does not retain the outer startup promise.
      await state.catalog.maintenance.drain();
    } finally {
      write.resolve();
      void shutdown.requestGracefulShutdown('startup_failure');
      release.resolve();
    }
    await tick();
    expect(state.app.listen).not.toHaveBeenCalled();
  });

  it('post-release MCP publication has a fresh root and rejects the old preparation context', async () => {
    const release = deferred();
    let stale;
    let state;
    const publication = deferred();
    const catalogStartup = {
      capture: (snapshot) => {
        stale ??= snapshot;
      },
    };
    const mcps = jest.fn(async () => state.catalog.setCachedTools({}));
    state = execute({
      release: release.promise,
      mcps,
      catalogStartup,
    });
    try {
      for (
        let i = 0;
        i < 40 && state.maintenance.waitForStartupRelease.mock.calls.length === 0;
        i++
      )
        await tick();
      expect(stale).toEqual(expect.any(Function));
      expect(await state.catalog.maintenance.getMaintenanceCensus('startup_fixture')).toMatchObject(
        { queuedContinuations: 0, pendingWrites: 0 },
      );
      expect(mcps).not.toHaveBeenCalled();
      catalogStartup.write = publication;
      release.resolve();
      for (let i = 0; i < 40 && state.catalogCache.set.mock.calls.length < 2; i++) await tick();
      expect(mcps).toHaveBeenCalledTimes(1);
      expect(await state.catalog.maintenance.getMaintenanceCensus(null)).toMatchObject({
        queuedContinuations: 1,
        pendingWrites: 1,
      });
      publication.resolve();
      await mcps.mock.results[0].value;
      expect(state.catalogCache.set).toHaveBeenCalledTimes(2);
      await expect(stale(() => state.catalog.setCachedTools({}))).rejects.toThrow(
        'continuation used after settlement',
      );
      expect(state.catalogCache.set).toHaveBeenCalledTimes(2);
    } finally {
      publication.resolve();
      release.resolve();
      void shutdown.requestGracefulShutdown('startup_failure');
      await tick();
    }
  });
});
