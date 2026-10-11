/** Exercises actual facade and generation wiring without starting the application. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
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
  const start = source.indexOf('  await runAsSystem(sweepOrphanedPreviews);');
  expect(start).toBeGreaterThan(0);
  const write = {};
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const nextStartupStep = jest.fn();
  const runAsSystem = jest.fn(() => pending);
  const run = vm.runInNewContext(
    `(async () => {${source.slice(start, source.indexOf('\n', start))}\nnextStartupStep();})()`,
    { runAsSystem, sweepOrphanedPreviews: write, nextStartupStep },
  );
  expect(runAsSystem).toHaveBeenCalledWith(write);
  expect(nextStartupStep).not.toHaveBeenCalled();
  finish();
  await run;
  expect(nextStartupStep).toHaveBeenCalledTimes(1);
});
