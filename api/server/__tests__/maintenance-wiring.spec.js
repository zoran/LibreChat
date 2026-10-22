jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

/** Exercises actual facade and generation wiring without starting the application. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const runtimeSource = fs.readFileSync(path.join(__dirname, '../services/start/runtime.js'), 'utf8');
test('gives uploads the same process identity as native application maintenance', async () => {
  const identity = Object.freeze({ incarnation: 'native-process' });
  const initializeUploads = jest.fn();
  const statement = runtimeSource.match(/const uploads = await initializeUploads\([^;]+;/)?.[0];
  const recordOriginalPublication = jest.fn();
  expect(source).toContain('identity: maintenance.identity,');
  expect(statement).toBeDefined();
  await vm.runInNewContext(`(async () => {${statement}})()`, {
    registry: 'registry',
    identity,
    recordOriginalPublication,
    initializeUploads,
  });
  expect(initializeUploads).toHaveBeenCalledWith({
    registry: 'registry',
    identity,
    recordOriginalPublication,
  });
});

test('wires all actual work facades, late browser load, and the same external census', async () => {
  const facade = () => ({
    pauseAdmissions: jest.fn(),
    resumeAdmissions: jest.fn(),
    getMaintenanceCensus: jest.fn(),
  });
  const browser = facade();
  const uploads = facade();
  const context = {
    process: { env: {} },
    cacheConfig: { SHARED_STATE: {} },
    serverReady: true,
    startupSignal: { throwIfAborted: jest.fn() },
    scheduleMaintenance: facade(),
    agentTriggerMaintenance: facade(),
    agentQueuedTurnMaintenance: facade(),
    skillSyncMaintenance: facade(),
    fileDeletionWorkOwner: { maintenance: facade() },
    fileLibraryMaintenance: facade(),
    getUploadRuntime: jest.fn(() => ({ maintenance: uploads })),
    legacyAuthMaintenance: facade(),
    createAppMaintenance: jest.fn(() => ({ externalCensus: jest.fn(), identity: {} })),
  };
  const start = source.indexOf('let browserMaintenance;');
  vm.runInNewContext(
    source.slice(start, source.indexOf('const rejectChatStartsUntilReady', start)),
    context,
  );
  const deps = context.createAppMaintenance.mock.calls[0][0];
  expect(() => deps.workOwners.browser.pauseAdmissions('early')).toThrow();
  // Assign in the original lexical context, matching the real delayed route-load point.
  context.routes = { auth: { browserMaintenance: browser } };
  vm.runInNewContext(
    source.match(/browserMaintenance = routes.auth.browserMaintenance;/)[0],
    context,
  );
  for (const method of ['pauseAdmissions', 'resumeAdmissions', 'getMaintenanceCensus']) {
    deps.workOwners.browser[method]('op');
    expect(browser[method]).toHaveBeenCalledWith('op');
  }
  expect(Object.keys(deps.workOwners)).toEqual([
    'browser',
    'schedules',
    'triggers',
    'queuedTurns',
    'skillSync',
    'fileDeletion',
    'fileLibrary',
    'uploads',
    'auth',
  ]);
  expect(deps.workOwners.skillSync).toBe(context.skillSyncMaintenance);
  expect(deps.workOwners.fileDeletion).toBe(context.fileDeletionWorkOwner.maintenance);
  expect(deps.workOwners.fileLibrary).toBe(context.fileLibraryMaintenance);
  for (const method of ['pauseAdmissions', 'resumeAdmissions', 'getMaintenanceCensus']) {
    const result = method === 'getMaintenanceCensus' ? Promise.resolve({ complete: false }) : false;
    uploads[method].mockReturnValue(result);
    expect(deps.workOwners.uploads[method]('op')).toBe(result);
    expect(uploads[method]).toHaveBeenCalledWith('op');
  }
  expect(deps.workOwners.auth).toBe(context.legacyAuthMaintenance);
  expect(deps.workOwners).not.toHaveProperty('history');
  expect(deps.unqualifiedOwners).toContain(
    'history request completion is not exhaustively measured',
  );
  expect(deps.unqualifiedOwners.join(' ')).toMatch(
    /authentication.*standalone tag\/share.*background/,
  );
  const initialize = jest.fn();
  const begin = source.indexOf('  await initializeMaintenanceGeneration({');
  const end = source.indexOf('\n  const streamServices', begin);
  await vm.runInNewContext(`(async () => {${source.slice(begin, end)}})()`, {
    ...context,
    initializeMaintenanceGeneration: initialize,
    agentEventMethods: {},
    GenerationJobManager: {},
    maintenance: context.createAppMaintenance.mock.results[0].value,
  });
  expect(initialize.mock.calls[0][0].externalCensus).toBe(
    context.createAppMaintenance.mock.results[0].value.externalCensus,
  );
  expect(source.indexOf('browserMaintenance = routes.auth.browserMaintenance')).toBeGreaterThan(
    source.indexOf("const routes = require('./routes')"),
  );
});

test('web runtime initializes existing owners without importing or starting a File timer', async () => {
  const appConfig = {};
  const api = new Proxy(
    {},
    {
      get(target, key) {
        return (target[key] ??= jest.fn());
      },
    },
  );
  const initializeUploads = jest.fn().mockResolvedValue(undefined);
  const modules = {
    axios: {},
    '@librechat/data-schemas': { runAsSystem: (run) => run() },
    '@librechat/api': api,
    '~/db': {},
    '~/models': { seedDatabase: jest.fn(), sweepOrphanedPreviews: jest.fn() },
    '../Skills/sync': { initializeGitHubSkillSync: jest.fn() },
    '../Uploads': { initializeUploads },
    '../Endpoints/agents/subagentThreadStore': { configureSubagentTaskRouting: jest.fn() },
    '../Config': { getAppConfig: jest.fn().mockResolvedValue(appConfig) },
    '../status/usage': {},
  };
  const module = { exports: {} };
  vm.runInNewContext(runtimeSource, {
    module,
    require(id) {
      if (!(id in modules)) throw new Error(`Unexpected startup dependency: ${id}`);
      return modules[id];
    },
  });
  const identity = { incarnation: 'web' };
  await expect(
    module.exports.initializeApplicationRuntime({ identity, projectRoot: '/unused' }),
  ).resolves.toEqual({ appConfig, uploads: undefined });
  expect(initializeUploads).toHaveBeenCalledWith({
    registry: undefined,
    identity,
    recordOriginalPublication: undefined,
  });
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
  const start = runtimeSource.indexOf('  await runAsSystem(sweepOrphanedPreviews);');
  expect(start).toBeGreaterThan(0);
  const write = {};
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const nextStartupStep = jest.fn();
  const runAsSystem = jest.fn(() => pending);
  const run = vm.runInNewContext(
    `(async () => {${runtimeSource.slice(start, runtimeSource.indexOf('\n', start))}\nnextStartupStep();})()`,
    { runAsSystem, sweepOrphanedPreviews: write, nextStartupStep },
  );
  expect(runAsSystem).toHaveBeenCalledWith(write);
  expect(nextStartupStep).not.toHaveBeenCalled();
  finish();
  await run;
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
  const inertAdapters = new Set();
  function load(name) {
    if (cache.has(name)) return cache.get(name).exports;
    const module = { exports: {} };
    cache.set(name, module);
    trace.push(name);
    let contents;
    if (name === 'server/index.js') contents = source;
    else if (name === 'server/services/start/runtime.js') contents = runtimeSource;
    else contents = fs.readFileSync(path.join(apiRoot, name), 'utf8');
    if (name === 'server/index.js') {
      const end = "const agentEventMethods = require('~/models');";
      expect(contents).toContain(end);
      contents = contents.slice(0, contents.indexOf(end) + end.length);
    }
    const localRequire = (id) => {
      if (id === 'mongoose') return instance;
      if (id === '@librechat/data-schemas') return schema;
      if (id === '@librechat/api')
        return { ...api, startCodeEnvironmentLifecycleReconciler: lifecycle };
      if (id === '~/db') return load('db/index.js');
      if (id === '~/models') return load('models/index.js');
      if (id === './services/initializeOAuthReconnectManager')
        return load('server/services/initializeOAuthReconnectManager.js');
      if (id === './services/start/runtime') return load('server/services/start/runtime.js');
      if (name === 'db/index.js' && id === './connect') return { connectDb };
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
      {},
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
    await result.initializeConnectedRuntime({
      mongoose: instance,
      identity: { incarnation: 'test' },
    });
    expect(connectDb).toHaveBeenCalledTimes(1);
    expect(
      trace.filter((name) => ['connect', 'usage', 'reconciler', 'indexSync'].includes(name)),
    ).toEqual(['connect', 'usage', 'reconciler', 'indexSync']);
  }
});

test.each(['index.js', 'experimental.js'])(
  'joins actual foreground File shutdown tasks in %s',
  async (entry) => {
    const { createFileDeletionWorkOwner } = jest.requireActual(
      '../../../packages/api/src/files/deletion',
    );
    const fileDeletionWorkOwner = createFileDeletionWorkOwner();
    const entrySource = fs.readFileSync(path.join(__dirname, '..', entry), 'utf8');
    const tasks = [];
    const statements = entrySource.match(
      /registerShutdownTask\('file deletion (?:admission|settlement)'[\s\S]*?\n\s*}\);/g,
    );
    expect(statements).toHaveLength(2);
    vm.runInNewContext(statements.join('\n'), {
      fileDeletionWorkOwner,
      registerShutdownTask: (name, fn, options) => tasks.push({ name, fn, ...options }),
    });
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
    const statements = source.match(
      /registerShutdownTask\('file deletion (?:admission|settlement)'[\s\S]*?\n\s*}\);/g,
    );
    vm.runInNewContext(statements.join('\n'), {
      fileDeletionWorkOwner,
      registerShutdownTask: shutdown.registerShutdownTask,
    });
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
