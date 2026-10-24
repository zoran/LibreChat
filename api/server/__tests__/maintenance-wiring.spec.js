jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/** Exercises actual facade and generation wiring without starting the application. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const runtimeSource = fs.readFileSync(path.join(__dirname, '../services/start/runtime.js'), 'utf8');
const maintenanceSource = fs.readFileSync(
  path.join(__dirname, '../services/start/maintenance.js'),
  'utf8',
);
const noop = () => undefined;
const facade = () => ({
  pauseAdmissions: jest.fn(),
  resumeAdmissions: jest.fn(),
  getMaintenanceCensus: jest.fn(),
  stopAdmissions: jest.fn(),
  drain: jest.fn(),
});
function maintenanceInputs(overrides = {}) {
  return {
    browserMaintenance: facade(),
    scheduleMaintenance: facade(),
    agentTriggerMaintenance: facade(),
    agentQueuedTurnMaintenance: facade(),
    skillSyncMaintenance: facade(),
    fileLibraryMaintenance: facade(),
    uploadMaintenance: facade(),
    databaseBootstrap: facade(),
    legacyAuthMaintenance: facade(),
    historyMaintenance: facade(),
    permissionMaintenance: facade(),
    mcpAuthorizationFenceRetryMaintenance: facade(),
    mcpCatalogMaintenance: facade(),
    mongoCacheMaintenance: { ...facade(), maintenance: facade() },
    startupMigrationMaintenance: { ...facade(), maintenance: facade() },
    startupReady: () => true,
    startupSignal: new AbortController().signal,
    shutdownTeardownReserveMs: 10_000,
    agentEventMethods: {},
    recordExpiredScheduleApproval: noop,
    resumeAgentEventDetachedAction: noop,
    ...overrides,
  };
}
function loadMaintenance(overrides = {}) {
  const api = {
    cacheConfig: { SHARED_STATE: {} },
    fileDeletionWorkOwner: { ...facade(), maintenance: facade() },
    codeEnvironmentLifecycleMaintenance: facade(),
    createAppMaintenance: jest.fn(() => ({ identity: {} })),
    initializeMaintenanceGeneration: jest.fn(),
    createStreamServices: () => ({}),
    isEnabled: () => false,
    createAgentEventTerminalHandler: jest.fn(),
    registerShutdownTask: jest.fn(),
    GenerationJobManager: {
      configure: noop,
      configureGenerationAdmission: noop,
      setApprovalExpiredHandler: noop,
      setTerminalHostActionHandler: noop,
      initialize: noop,
    },
    ...overrides,
  };
  const module = { exports: {} };
  vm.runInNewContext(maintenanceSource, {
    module,
    process: { env: {} },
    require: (id) => {
      if (id !== '@librechat/api') throw new Error(`Unexpected maintenance dependency: ${id}`);
      return api;
    },
  });
  return { ...module.exports, api };
}
function loadRuntime(initializeUploads, appConfig = {}) {
  const api = new Proxy({}, { get: (target, key) => (target[key] ??= jest.fn()) });
  const modules = {
    axios: {},
    '@librechat/data-schemas': { runAsSystem: (run) => run() },
    '@librechat/api': api,
    '~/db': { modelBootstrap: { capture: noop } },
    '~/models': { seedDatabase: jest.fn(), sweepOrphanedPreviews: jest.fn() },
    '../Skills/sync': { initializeGitHubSkillSync: jest.fn() },
    '../Uploads': { initializeUploads },
    '../Files/LibraryMaintenance': require('../services/Files/LibraryMaintenance'),
    '../Endpoints/agents/subagentThreadStore': { configureSubagentTaskRouting: jest.fn() },
    '../Config': { getAppConfig: jest.fn().mockResolvedValue(appConfig) },
    '../status/usage': {},
  };
  const module = { exports: {} };
  vm.runInNewContext(runtimeSource, {
    module,
    process: { env: {} },
    AbortSignal,
    require(id) {
      if (!(id in modules)) throw new Error(`Unexpected startup dependency: ${id}`);
      return modules[id];
    },
  });
  return { ...module.exports, api, modules };
}

test('gives uploads the same process identity as native application maintenance', async () => {
  const identity = Object.freeze({ incarnation: 'native-process' });
  const initializeUploads = jest.fn();
  const recordOriginalPublication = jest.fn();
  const signal = new AbortController().signal;
  const onFailure = jest.fn();
  expect(source).toContain('identity: maintenance.identity,');
  expect(source).toContain('onFailure: failStartup,');
  await loadRuntime(initializeUploads).initializeApplicationRuntime({
    registry: 'registry',
    identity,
    recordOriginalPublication,
    signal,
    onFailure,
  });
  expect(initializeUploads).toHaveBeenCalledWith({
    registry: 'registry',
    identity,
    recordOriginalPublication,
    signal,
    trustedFile: undefined,
    onFailure,
  });
});

test('binds the declared File owners and configures Generation without an App census callback', async () => {
  const input = maintenanceInputs();
  const { api, createWebMaintenance, registerWebMaintenanceShutdown } = loadMaintenance();
  registerWebMaintenanceShutdown(input);
  const result = createWebMaintenance(input);
  expect(api.createAppMaintenance).toHaveBeenCalledTimes(1);
  const deps = api.createAppMaintenance.mock.calls[0][0];
  for (const method of ['pauseAdmissions', 'resumeAdmissions', 'getMaintenanceCensus']) {
    deps.workOwners.browser[method]('op');
    expect(input.browserMaintenance[method]).toHaveBeenCalledWith('op');
  }
  expect(deps.workOwners).toMatchObject({
    schedules: input.scheduleMaintenance,
    triggers: input.agentTriggerMaintenance,
    queuedTurns: input.agentQueuedTurnMaintenance,
    skillSync: input.skillSyncMaintenance,
    fileDeletion: api.fileDeletionWorkOwner.maintenance,
    fileLibrary: input.fileLibraryMaintenance,
    uploads: input.uploadMaintenance,
    databaseBootstrap: input.databaseBootstrap,
    auth: input.legacyAuthMaintenance,
    history: input.historyMaintenance,
    codeLifecycle: api.codeEnvironmentLifecycleMaintenance,
    permissions: input.permissionMaintenance,
    mcpAuthorizationRetry: input.mcpAuthorizationFenceRetryMaintenance,
    mongoCache: input.mongoCacheMaintenance.maintenance,
    startupCollections: input.startupMigrationMaintenance.maintenance,
    mcpCatalog: input.mcpCatalogMaintenance,
  });
  for (const [key, owner] of Object.entries({
    uploads: input.uploadMaintenance,
    auth: input.legacyAuthMaintenance,
    history: input.historyMaintenance,
    codeLifecycle: api.codeEnvironmentLifecycleMaintenance,
    permissions: input.permissionMaintenance,
    mcpAuthorizationRetry: input.mcpAuthorizationFenceRetryMaintenance,
    mongoCache: input.mongoCacheMaintenance.maintenance,
    startupCollections: input.startupMigrationMaintenance.maintenance,
    mcpCatalog: input.mcpCatalogMaintenance,
  }))
    expect(deps.workOwners[key]).toBe(owner);
  expect(deps.unqualifiedOwners).toHaveLength(3);
  await result.configureGenerationStreams();
  const configured = api.initializeMaintenanceGeneration.mock.calls[0][0];
  expect(configured.identity).toBe(result.maintenance.identity);
  expect(configured).not.toHaveProperty('externalCensus');
  expect(deps.fileDomainOwners).toEqual([
    'browser',
    'schedules',
    'triggers',
    'queuedTurns',
    'skillSync',
    'fileDeletion',
    'fileLibrary',
    'uploads',
    'databaseBootstrap',
    'history',
    'startupCollections',
  ]);
  const tasks = api.registerShutdownTask.mock.calls;
  expect(tasks.map(([name]) => name)).toEqual([
    'file deletion admission',
    'file deletion settlement',
    'file library admission',
    'file library settlement',
    'history admission',
    'history settlement',
    'authentication admission',
    'authentication settlement',
    'code lifecycle admission',
    'code lifecycle settlement',
    'permission admission',
    'permission settlement',
    'Mongo cache admission',
    'Mongo cache settlement',
    'startup collection admission',
    'startup collection settlement',
    'MCP catalog admission',
    'MCP catalog settlement',
    'generation job manager prepare',
    'generation job manager settlement',
    'generation job manager',
  ]);
  for (const [index, owner] of [
    [2, input.fileLibraryMaintenance],
    [4, input.historyMaintenance],
    [6, input.legacyAuthMaintenance],
    [8, api.codeEnvironmentLifecycleMaintenance],
    [10, input.permissionMaintenance],
    [12, input.mongoCacheMaintenance],
    [14, input.startupMigrationMaintenance],
    [16, input.mcpCatalogMaintenance],
  ]) {
    tasks[index][1]();
    tasks[index + 1][1]();
    expect(owner.stopAdmissions).toHaveBeenCalledTimes(1);
    expect(owner.drain).toHaveBeenCalledTimes(1);
    expect(tasks[index][2]).toEqual({ phase: 'pre-drain', priority: 110 });
    expect(tasks[index + 1][2]).toEqual({ phase: 'pre-drain', priority: 90 });
  }
  expect(source).toContain(
    'routes.auth.browserMaintenance.pauseAdmissions !== browserMaintenance.pauseAdmissions',
  );
});

test('web runtime initializes existing owners without importing or starting a File timer', async () => {
  const appConfig = {};
  const initializeUploads = jest.fn().mockResolvedValue(undefined);
  const { initializeApplicationRuntime, api, modules } = loadRuntime(initializeUploads, appConfig);
  const identity = { incarnation: 'web' };
  const signal = new AbortController().signal;
  const onFailure = jest.fn();
  const prepared = await initializeApplicationRuntime({
    identity,
    projectRoot: '/unused',
    signal,
    onFailure,
  });
  expect(prepared.appConfig).toBe(appConfig);
  expect(prepared.uploads).toBeUndefined();
  expect(initializeUploads).toHaveBeenCalledWith({
    registry: undefined,
    identity,
    recordOriginalPublication: undefined,
    trustedFile: undefined,
    signal,
    onFailure,
  });
  expect(modules['~/models'].sweepOrphanedPreviews).not.toHaveBeenCalled();
  await prepared.start();
  expect(modules['~/models'].sweepOrphanedPreviews).toHaveBeenCalledTimes(1);
  expect(api.initializeFileStorage).toHaveBeenCalledWith(appConfig);
});

test('cluster startup and replacement leave retention scheduling to Housekeeping', async () => {
  const { EventEmitter } = require('node:events');
  const clusterSource = fs.readFileSync(path.join(__dirname, '../experimental.js'), 'utf8');
  const start = clusterSource.indexOf('if (cluster.isMaster) {');
  const end = clusterSource.indexOf('} else {\n  /**\n   * Worker process', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const worker = (id) =>
    Object.assign(new EventEmitter(), {
      id,
      process: { pid: id },
      isConnected: () => true,
      send: jest.fn(),
      kill: jest.fn(),
    });
  const first = worker(1);
  const second = worker(2);
  const cluster = Object.assign(new EventEmitter(), {
    isMaster: true,
    workers: { 1: first, 2: second },
    fork: jest.fn(),
  });
  const process = Object.assign(new EventEmitter(), { pid: 0, exit: jest.fn() });
  vm.runInNewContext(clusterSource.slice(start, end + 1), {
    cluster,
    process,
    workers: 2,
    flushRedisCache: jest.fn().mockResolvedValue(undefined),
    logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
    wrapLogMessage: (message) => message,
    CLUSTER_FORCE_EXIT_MS: 10_000,
    setTimeout: jest.fn(),
  });
  await Promise.resolve();
  expect(cluster.fork).toHaveBeenCalledTimes(2);
  for (const current of [first, second]) {
    cluster.emit('online', current);
    cluster.emit('listening', current);
  }
  delete cluster.workers[1];
  cluster.emit('exit', first, 1, null);
  expect(cluster.fork).toHaveBeenCalledTimes(3);
  expect(first.send).not.toHaveBeenCalled();
  expect(second.send).not.toHaveBeenCalled();
  process.emit('SIGTERM');
  expect(second.send).toHaveBeenCalledWith(
    { type: 'cluster-shutdown', deadlineAt: expect.any(Number) },
    expect.any(Function),
  );
  expect(second.kill).not.toHaveBeenCalled();
  second.emit('message', { type: 'cluster-shutdown-ack' });
  expect(second.kill).toHaveBeenCalledTimes(1);
});

test('establishes auth admission before Passport and session setup', () => {
  const admission = source.indexOf('app.use(authAdmissionMiddleware);');
  expect(admission).toBeGreaterThan(0);
  expect(admission).toBeLessThan(source.indexOf('app.use(passport.initialize());'));
  expect(admission).toBeLessThan(source.indexOf('await configureSocialLogins(app, appConfig);'));
});

test('joins the actual orphan-preview boot write before further startup', async () => {
  const statement = 'await fileLibraryMaintenance.run(() => runAsSystem(sweepOrphanedPreviews));';
  const start = runtimeSource.indexOf(statement);
  expect(start).toBeGreaterThan(0);
  const { createFileLibraryMaintenance } = require('../services/Files/LibraryMaintenance');
  const fileLibraryMaintenance = createFileLibraryMaintenance();
  const write = {};
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const nextStartupStep = jest.fn();
  const runAsSystem = jest.fn(() => pending);
  const run = vm.runInNewContext(
    `(async () => {${runtimeSource.slice(start, runtimeSource.indexOf('\n', start))}\nnextStartupStep();})()`,
    { fileLibraryMaintenance, runAsSystem, sweepOrphanedPreviews: write, nextStartupStep },
  );
  try {
    // The real maintenance owner dispatches the original in a promise continuation.
    await Promise.resolve();
    expect(runAsSystem).toHaveBeenCalledWith(write);
    expect(nextStartupStep).not.toHaveBeenCalled();
  } finally {
    finish();
    try {
      await run;
    } finally {
      await fileLibraryMaintenance.drain();
    }
  }
  expect(nextStartupStep).toHaveBeenCalledTimes(1);
});

/** A fresh process must register its real models before the first actual method consumer.
 * Only transport/startup adapters are inert: no Mongo, credentials, search or background work.
 * The DB module, OAuth consumer, api/models and both schema factories execute their real bytes.
 */
test.each(['index', 'runtime'])('registers models before %s startup consumers', async (entry) => {
  const mongoose = require('mongoose');
  const schema = jest.requireActual('@librechat/data-schemas');
  const api = jest.requireActual('@librechat/api');
  const instance = new mongoose.Mongoose();
  instance.set('autoIndex', false);
  instance.set('autoCreate', false);
  // Disconnected fixture: Mongoose reads connection config before base options in Model.init.
  Object.assign(instance.connection.config, {
    autoCreate: false,
    autoIndex: false,
    autoSearchIndex: false,
  });
  const apiRoot = path.dirname(path.dirname(require.resolve('~/models')));
  const trace = [];
  const cache = new Map();
  const noop = () => {};
  const connectDb = jest.fn(async () => trace.push('connect'));
  const indexSync = jest.fn(async () => trace.push('indexSync'));
  const lifecycle = jest.fn(() => trace.push('reconciler'));
  const usage = jest.fn(async () => {
    trace.push('usage');
    return { recordOriginalPublication: noop };
  });
  const connector = jest.requireActual('../../db/connect').createDbConnector({
    mongoose: instance,
    env: { MONGO_URI: 'mongodb://fixture-only' },
    instrumentMongooseQueryMetrics: noop,
    optionalEnabled: noop,
    logger: { info: noop, error: noop },
  });
  const inertAdapters = new Set();
  function load(name) {
    if (cache.has(name)) return cache.get(name).exports;
    const module = { exports: {} };
    cache.set(name, module);
    trace.push(name);
    let contents;
    if (name === 'server/index.js') contents = source;
    else if (name === 'server/services/start/runtime.js') contents = runtimeSource;
    else if (name === 'server/services/start/maintenance.js') contents = maintenanceSource;
    else contents = fs.readFileSync(path.join(apiRoot, name), 'utf8');
    if (name === 'server/index.js') {
      const end = "const agentEventMethods = require('~/models');";
      expect(contents).toContain(end);
      const begin = contents.indexOf("  database = require('../db/connect')");
      contents = `let database; const failStartup = () => {};\n${contents.slice(begin, contents.indexOf(end) + end.length)}`;
    }
    const localRequire = (id) => {
      if (id === 'mongoose') return instance;
      if (id === '@librechat/data-schemas') return schema;
      if (id === '@librechat/api')
        return { ...api, startCodeEnvironmentLifecycleReconciler: lifecycle };
      if (id === '../db/connect') return { getDbConnector: () => connector };
      if (id === './services/LegacyAuthMaintenance') return { installAuthPassport: noop };
      if (id === './services/start/maintenance')
        return load('server/services/start/maintenance.js');
      if (id === '~/db') return load('db/index.js');
      if (id === '~/models') return load('models/index.js');
      if (id === './services/initializeOAuthReconnectManager')
        return load('server/services/initializeOAuthReconnectManager.js');
      if (id === './services/start/runtime') return load('server/services/start/runtime.js');
      if (name === 'db/index.js' && id === './connect')
        return { connectDb, getDbConnector: () => connector };
      if (name === 'db/index.js' && id === './indexSync') {
        expect(instance.models.Message).toBeDefined();
        expect(instance.models.Conversation).toBeDefined();
        return indexSync;
      }
      if (id === '../status/usage') return { initializeStatusUsage: usage };
      if (id === 'fs') return fs;
      if (id === 'path') return path;
      if (id === 'librechat-data-provider') return require('librechat-data-provider');
      // Credentials/telemetry, HTTP middleware, cache and remote service adapters are not started.
      inertAdapters.add(`${name}:${id}`);
      return noop;
    };
    const execute = vm.runInNewContext(
      `(function(require,module,exports,__dirname){${contents}\n})`,
      { passport: {} },
      { filename: path.join(apiRoot, name) },
    );
    execute(localRequire, module, module.exports, path.dirname(path.join(apiRoot, name)));
    return module.exports;
  }
  const target = entry === 'index' ? 'server/index.js' : 'server/services/start/runtime.js';
  const result = load(target);
  expect(trace.indexOf('db/index.js')).toBeGreaterThan(-1);
  expect(trace.indexOf('db/index.js')).toBeLessThan(trace.indexOf('models/index.js'));
  expect(trace.filter((name) => name === 'db/index.js')).toHaveLength(1);
  expect(instance.models.Role).toBeDefined();
  expect(typeof cache.get('models/index.js').exports.findToken).toBe('function');
  expect(connectDb).not.toHaveBeenCalled();
  expect(indexSync).not.toHaveBeenCalled();
  expect(inertAdapters.size).toBeGreaterThan(0);
  if (entry === 'runtime') {
    const connected = await result.initializeConnectedRuntime({
      mongoose: instance,
      identity: { incarnation: 'test' },
    });
    expect(connectDb).toHaveBeenCalledTimes(1);
    expect(trace).not.toContain('reconciler');
    await connected.start();
    expect(
      trace.filter((name) => ['connect', 'usage', 'reconciler', 'indexSync'].includes(name)),
    ).toEqual(['connect', 'usage', 'reconciler', 'indexSync']);
  }
  await connector.modelBootstrap.join();
  await connector.close();
});

test.each(['index.js', 'experimental.js'])(
  'joins actual foreground File shutdown tasks in %s',
  async (entry) => {
    const { createFileDeletionWorkOwner } = jest.requireActual(
      '../../../packages/api/src/files/deletion',
    );
    const fileDeletionWorkOwner = createFileDeletionWorkOwner();
    const tasks = [];
    const registerShutdownTask = (name, fn, options) => {
      if (name.startsWith('file deletion ')) tasks.push({ name, fn, ...options });
    };
    if (entry === 'index.js') {
      loadMaintenance({
        fileDeletionWorkOwner,
        registerShutdownTask,
      }).registerWebMaintenanceShutdown(maintenanceInputs());
    } else {
      const entrySource = fs.readFileSync(path.join(__dirname, '..', entry), 'utf8');
      const statements = entrySource.match(
        /registerShutdownTask\('file deletion (?:admission|settlement)'[\s\S]*?\n\s*}\);/g,
      );
      expect(statements).toHaveLength(2);
      vm.runInNewContext(statements.join('\n'), { fileDeletionWorkOwner, registerShutdownTask });
    }
    expect(tasks.map(({ phase, priority }) => ({ phase, priority }))).toEqual([
      { phase: 'pre-drain', priority: 110 },
      { phase: 'pre-drain', priority: 90 },
    ]);
    let finish;
    const write = new Promise((resolve) => {
      finish = resolve;
    });
    const operation = fileDeletionWorkOwner.run((scope) => scope.effect(() => write));
    tasks[0].fn();
    await expect(fileDeletionWorkOwner.run(async () => undefined)).rejects.toThrow(
      'FILE_DELETION_QUIESCING',
    );
    const drain = tasks[1].fn();
    let drained = false;
    void drain.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    expect(drain).toBe(fileDeletionWorkOwner.drain());
    finish();
    await operation;
    await drain;
  },
);

test('foreground File shutdown retains original deletion through the actual shutdown coordinator', async () => {
  const { Server } = require('node:http');
  const { createFileDeletionWorkOwner } = jest.requireActual(
    '../../../packages/api/src/files/deletion',
  );
  const shutdown = jest.requireActual('../../../packages/api/src/app/shutdown');
  const fileDeletionWorkOwner = createFileDeletionWorkOwner();
  shutdown.__resetShutdownStateForTests();
  jest.useFakeTimers();
  const exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
  const previous = new Set(process.listeners('SIGTERM'));
  let finish;
  const write = new Promise((resolve) => {
    finish = resolve;
  });
  const operation = fileDeletionWorkOwner.run((scope) => scope.effect(() => write));
  const teardown = jest.fn();
  try {
    loadMaintenance({
      fileDeletionWorkOwner,
      registerShutdownTask: shutdown.registerShutdownTask,
    }).registerWebMaintenanceShutdown(maintenanceInputs());
    shutdown.registerShutdownTask(
      'generation prepare',
      async () => {
        await expect(fileDeletionWorkOwner.run(async () => undefined)).rejects.toThrow(
          'FILE_DELETION_QUIESCING',
        );
      },
      { phase: 'pre-drain', priority: 100 },
    );
    shutdown.registerShutdownTask('storage teardown', teardown, { priority: 105 });
    shutdown.setupGracefulShutdown(new Server());
    const signal = process.listeners('SIGTERM').find((listener) => !previous.has(listener));
    signal('SIGTERM');
    await jest.advanceTimersByTimeAsync(1000);
    expect(shutdown.getShutdownSignal().aborted).toBe(true);
    expect(shutdown.getRemainingShutdownMs()).toBe(59000);
    expect(teardown).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(await fileDeletionWorkOwner.maintenance.getMaintenanceCensus(null)).toMatchObject({
      pendingWrites: 1,
    });
    finish();
    await operation;
    await jest.advanceTimersByTimeAsync(0);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  } finally {
    finish();
    await operation;
    shutdown.__resetShutdownStateForTests();
    exit.mockRestore();
    jest.useRealTimers();
  }
});

test('generation shutdown wiring retains deferred pre-drain custody and the original budget', async () => {
  const { Server } = require('node:http');
  const shutdown = jest.requireActual('../../../packages/api/src/app/shutdown');
  const setups = source.match(/setupGracefulShutdown\((?:null|server)(?:, [^;]+)?\);/g);
  expect(setups).toHaveLength(2);
  const GenerationJobManager = {
    prepareForShutdown: jest.fn(),
    awaitGenerationSettlements: jest.fn(),
    destroy: jest.fn(),
  };
  let reject;
  const original = new Promise((_, fail) => {
    reject = fail;
  });
  GenerationJobManager.awaitGenerationSettlements.mockReturnValue(original);
  const teardown = jest.fn();
  shutdown.__resetShutdownStateForTests();
  jest.useFakeTimers();
  const exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined);
  const previous = new Set(process.listeners('SIGTERM'));
  try {
    const context = {
      server: new Server(),
      GenerationJobManager,
      setupGracefulShutdown: shutdown.setupGracefulShutdown,
      registerShutdownTask: shutdown.registerShutdownTask,
      getRemainingShutdownMs: shutdown.getRemainingShutdownMs,
      SHUTDOWN_TEARDOWN_RESERVE_MS: 10_000,
    };
    vm.runInNewContext(
      setups.find((line) => line.includes('(null')),
      context,
    );
    vm.runInNewContext(
      setups.find((line) => line.includes('(server')),
      context,
    );
    const composition = loadMaintenance({
      ...context,
      GenerationJobManager: {
        configure: noop,
        configureGenerationAdmission: noop,
        setApprovalExpiredHandler: noop,
        setTerminalHostActionHandler: noop,
        initialize: noop,
        ...GenerationJobManager,
      },
    }).createWebMaintenance(maintenanceInputs());
    await composition.configureGenerationStreams();
    shutdown.registerShutdownTask('storage teardown', teardown, { priority: 105 });
    const signal = process.listeners('SIGTERM').find((listener) => !previous.has(listener));
    signal('SIGTERM');
    await jest.advanceTimersByTimeAsync(10);
    expect(GenerationJobManager.prepareForShutdown).toHaveBeenCalledTimes(1);
    expect(GenerationJobManager.awaitGenerationSettlements).toHaveBeenCalledWith(50_000);
    expect(teardown).not.toHaveBeenCalled();
    reject(new Error('original generation unconfirmed'));
    await jest.advanceTimersByTimeAsync(10);
    expect(GenerationJobManager.destroy).not.toHaveBeenCalled();
    expect(teardown).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(shutdown.getRemainingShutdownMs()).toBe(59_980);
    await jest.advanceTimersByTimeAsync(59_980);
    expect(exit).toHaveBeenCalledWith(1);
    expect(teardown).not.toHaveBeenCalled();
  } finally {
    reject(new Error('fixture settled'));
    await original.catch(() => undefined);
    shutdown.__resetShutdownStateForTests();
    exit.mockRestore();
    jest.useRealTimers();
  }
});
