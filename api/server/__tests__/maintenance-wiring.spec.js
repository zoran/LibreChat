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
  const context = {
    process: { env: {} },
    cacheConfig: { SHARED_STATE: {} },
    serverReady: true,
    scheduleMaintenance: facade(),
    agentTriggerMaintenance: facade(),
    agentQueuedTurnMaintenance: facade(),
    skillSyncMaintenance: facade(),
    expiredFileSweepMaintenance: facade(),
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
    'fileRetention',
    'uploads',
    'auth',
  ]);
  expect(deps.workOwners.skillSync).toBe(context.skillSyncMaintenance);
  expect(deps.workOwners.fileRetention).toBe(context.expiredFileSweepMaintenance);
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
