const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

describe('Experimental server configuration', () => {
  const source = fs.readFileSync(path.join(__dirname, 'experimental.js'), 'utf8');

  it('configures HTTP timeouts for each cluster worker server', () => {
    const listenIndex = source.indexOf('const server = app.listen');
    const timeoutConfigIndex = source.indexOf('configureServerTimeouts(server);');

    expect(listenIndex).toBeGreaterThan(-1);
    expect(timeoutConfigIndex).toBeGreaterThan(-1);
    expect(listenIndex).toBeLessThan(timeoutConfigIndex);
  });

  it('lets each worker drain registered services before cluster shutdown', () => {
    const listenIndex = source.indexOf('const server = app.listen');
    const gracefulShutdownIndex = source.indexOf('setupGracefulShutdown(server);');

    expect(gracefulShutdownIndex).toBeGreaterThan(-1);
    expect(listenIndex).toBeLessThan(gracefulShutdownIndex);
    expect(source).toContain('if (shuttingDown) {');
    expect(source).toMatch(/if \(shuttingDown\) \{[\s\S]*?return;[\s\S]*?Starting a new worker/);
  });

  it("drains background tasks within the primary's cluster shutdown deadline", () => {
    expect(source).toMatch(
      /registerBackgroundTaskShutdown\(\{[\s\S]*?getBudgetMs: clusterShutdownBudgetMs,[\s\S]*?\}\);/,
    );
    expect(source).toMatch(
      /const clusterShutdownBudgetMs = \(\) =>\s*getClusterShutdownBudgetMs\(\{\s*deadlineAt: clusterShutdownDeadlineAt,\s*forceExitMs: CLUSTER_FORCE_EXIT_MS,\s*\}\);/,
    );
    expect(source).toMatch(
      /const destroyGenerationJobManager = \(\) => \{\s*const budgetMs = clusterShutdownBudgetMs\(\);/,
    );
  });

  it('starts approval expiry after installing the scheduled-run callback', () => {
    const handlerIndex = source.indexOf(
      'GenerationJobManager.setApprovalExpiredHandler(recordExpiredScheduleApproval);',
    );
    const initializeIndex = source.indexOf('GenerationJobManager.initialize();');

    expect(handlerIndex).toBeGreaterThan(-1);
    expect(initializeIndex).toBeGreaterThan(handlerIndex);
  });

  it('starts erasure-only schedule maintenance after connecting to Mongo, once per worker', () => {
    const connectIndex = source.indexOf('await connectDb();');
    const sweepIndex = source.indexOf('initializeScheduleErasureSweep();');

    expect(connectIndex).toBeGreaterThan(-1);
    expect(sweepIndex).toBeGreaterThan(-1);
    // Mongo must be up before the sweep reads soft-deleted rows.
    expect(sweepIndex).toBeGreaterThan(connectIndex);
    // Idempotent guard lives in the service; started exactly once from this entrypoint.
    expect(source.match(/initializeScheduleErasureSweep\(\);/g)).toHaveLength(1);
  });

  it('starts code-environment lifecycle reconciliation after Mongo connects in each worker', () => {
    const connectIndex = source.indexOf('await connectDb();');
    const reconcileIndex = source.indexOf('startCodeEnvironmentLifecycleReconciler({ mongoose });');
    const listenIndex = source.indexOf('const server = app.listen');

    expect(connectIndex).toBeGreaterThan(-1);
    expect(reconcileIndex).toBeGreaterThan(connectIndex);
    expect(listenIndex).toBeGreaterThan(reconcileIndex);
    expect(
      source.match(/startCodeEnvironmentLifecycleReconciler\(\{ mongoose \}\);/g),
    ).toHaveLength(1);
  });

  it.each(['resolved', 'rejected'])(
    'retains the first lifecycle reconciliation before worker startup advances: %s',
    async (outcome) => {
      const start = source.indexOf('const startServer = async () => {');
      const boundary = source.indexOf('/** Background index sync', start);
      expect(start).toBeGreaterThan(-1);
      expect(boundary).toBeGreaterThan(start);
      let resolveOriginal, rejectOriginal, markEntered;
      const original = new Promise((resolve, reject) => {
        resolveOriginal = resolve;
        rejectOriginal = reject;
      });
      const entered = new Promise((resolve) => {
        markEntered = resolve;
      });
      const failure = new Error('original lifecycle reconciliation failed');
      const advance = jest.fn();
      const run = vm.runInNewContext(
        `${source.slice(start, boundary)}
return advance();
}; startServer;`,
        {
          process: { pid: 1 },
          logger: { info: jest.fn() },
          mongoose: {},
          waitForKeyvRedisClient: jest.fn().mockResolvedValue(undefined),
          connectDb: jest.fn().mockResolvedValue(undefined),
          startCodeEnvironmentLifecycleReconciler: jest.fn(() => {
            markEntered();
            return original;
          }),
          advance,
        },
      );
      const pending = run().then(
        () => ({ succeeded: true }),
        (error) => ({ error }),
      );
      try {
        await Promise.race([
          entered,
          pending.then(() => {
            throw new Error('startup returned before lifecycle reconciliation');
          }),
        ]);
        expect(advance).not.toHaveBeenCalled();
        if (outcome === 'resolved') {
          resolveOriginal();
          expect(await pending).toEqual({ succeeded: true });
          expect(advance).toHaveBeenCalledTimes(1);
        } else {
          rejectOriginal(failure);
          expect(await pending).toEqual({ error: failure });
          expect(advance).not.toHaveBeenCalled();
        }
      } finally {
        resolveOriginal();
        await pending;
      }
    },
  );

  it('never arms the full schedule engine in a clustered worker', () => {
    // The clustered entrypoint runs erasure-only maintenance: arming the engine here
    // would claim/fire/absence-reconcile runs whose peer generations it cannot see.
    expect(source).not.toContain('initializeScheduleEngine(');
  });

  it('runs cross-tenant startup work in the system context', () => {
    expect(source).toContain('await runAsSystem(seedDatabase);');
    expect(source).toMatch(
      /await runAsSystem\(async \(\) => \{\s+await performStartupChecks\(appConfig\);\s+await updateInterfacePerms/,
    );
  });

  it('configures routed subagent controls before a worker accepts requests', () => {
    const redisReadyIndex = source.indexOf('await waitForKeyvRedisClient();');
    const routingIndex = source.indexOf(
      'await configureSubagentTaskRouting(baseAppConfig?.endpoints?.agents?.subagentActivity);',
    );
    const listenIndex = source.indexOf('const server = app.listen');

    expect(redisReadyIndex).toBeGreaterThan(-1);
    expect(routingIndex).toBeGreaterThan(redisReadyIndex);
    expect(listenIndex).toBeGreaterThan(routingIndex);
  });

  it('projects base-only event rollout barriers before accepting requests', () => {
    const baseConfigIndex = source.indexOf(
      'const baseAppConfig = await getAppConfig({ baseOnly: true });',
    );
    const eventRuntimeIndex = source.indexOf(
      'configureAgentEventRuntime(baseAppConfig?.endpoints?.agents?.eventDriven);',
    );
    const listenIndex = source.indexOf('const server = app.listen');

    expect(baseConfigIndex).toBeGreaterThan(-1);
    expect(eventRuntimeIndex).toBeGreaterThan(baseConfigIndex);
    expect(listenIndex).toBeGreaterThan(eventRuntimeIndex);
  });

  it('passes the same idle recovery policy to both server startup paths', () => {
    const standard = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    for (const [entrypoint, config] of [
      [source, 'baseAppConfig'],
      [standard, 'appConfig'],
    ]) {
      const start = entrypoint.indexOf('await initializeAgentTriggerService({');
      expect(start).toBeGreaterThan(-1);
      const call = entrypoint.slice(start, entrypoint.indexOf('});', start));
      expect(call).toContain(`idlePolling: ${config}?.endpoints?.agents?.eventDriven?.idlePolling`);
    }
  });

  it('matches the standard server pre-authentication tenant routes', () => {
    expect(source).toContain("app.use('/oauth', preAuthTenantMiddleware, routes.oauth);");
    expect(source).toContain("app.use('/api/auth', preAuthTenantMiddleware, routes.auth);");
    expect(source).toContain(
      "app.use('/api/config', preAuthTenantMiddleware, optionalJwtAuth, routes.config);",
    );
    expect(source).toContain("app.use('/api/share', preAuthTenantMiddleware, routes.share);");
  });
});
