/** Verifies the actual startup composition without loading credentials, databases or listeners. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

test.each(['ready', 'rejected'])(
  'startup waits for the cache owner before any dependent work: %s',
  async (result) => {
    const start = source.indexOf('const startServer = async () => {');
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
    const startup = vm.runInNewContext(`${source.slice(start, end)} entered(); }; startServer();`, {
      waitForRedisStartup,
      waitForKeyvRedisClient: jest.fn().mockResolvedValue(undefined),
      entered,
    });
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
  const start = source.indexOf('const maintenance = createAppMaintenance(');
  const end = source.indexOf('const rejectChatStartsUntilReady', start);
  expect(start).toBeGreaterThan(0);
  const owner = {
    closeGenerationAdmission: jest.fn(),
    reopenGenerationAdmission: jest.fn(),
    getGenerationAdmissionCensus: jest.fn(),
    getGenerationRuntimeHealth: jest.fn(),
  };
  const create = jest.fn(() => ({}));
  const ping = jest.fn();
  const shared = jest.fn();
  vm.runInNewContext(source.slice(start, end), {
    createAppMaintenance: create,
    browserMaintenance: {},
    scheduleMaintenance: {},
    agentTriggerMaintenance: {},
    agentQueuedTurnMaintenance: {},
    skillSyncMaintenance: {},
    expiredFileSweepMaintenance: {},
    legacyAuthMaintenance: {},
    process: { env: {} },
    cacheConfig: { SHARED_STATE: { mode: 'sentinel' }, USE_REDIS: true },
    GenerationJobManager: owner,
    mongoose: { connection: { db: { admin: () => ({ ping }) } } },
    probeMaintenanceRedis: shared,
    probeMaintenanceDatabase: (db) => db.ping(),
    keyvRedisClient: {},
    ioredisClient: {},
    serverReady: true,
  });
  const deps = create.mock.calls[0][0];
  expect(deps.workOwners).not.toHaveProperty('history');
  expect(deps.unqualifiedOwners).toContain(
    'history request completion is not exhaustively measured',
  );
  deps.generation.closeGenerationAdmission('request');
  deps.generation.getGenerationAdmissionCensus();
  deps.generation.getGenerationRuntimeHealth();
  deps.probeDatabase();
  deps.probeSharedState();
  expect(owner.closeGenerationAdmission).toHaveBeenCalledWith('request');
  expect(owner.getGenerationAdmissionCensus).toHaveBeenCalledTimes(1);
  expect(owner.getGenerationRuntimeHealth).toHaveBeenCalledTimes(1);
  expect(ping).toHaveBeenCalledTimes(1);
  expect(shared).toHaveBeenCalledWith(expect.objectContaining({ required: true }));
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
