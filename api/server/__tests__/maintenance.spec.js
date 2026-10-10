/** Verifies the actual startup composition without loading credentials, databases or listeners. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');

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
