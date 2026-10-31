const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');

const FIXTURE_INDEX_HTML =
  '<!DOCTYPE html><html><head><title>LibreChat</title></head><body><div id="root"></div></body></html>';

describe('Telemetry wiring', () => {
  const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

  it('loads credentials before telemetry and other server imports', () => {
    const firstStatements = source
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 2);

    expect(firstStatements).toEqual([
      "require('../config/credentials');",
      "const telemetry = require('./telemetry');",
    ]);
  });

  it('mounts telemetry middleware after static assets and before routes', () => {
    const telemetryMiddlewareIndex = source.indexOf('app.use(telemetry.telemetryMiddleware);');
    const staticAssetsIndex = source.indexOf('app.use(staticCache(appConfig.paths.assets));');
    const apiRoutesIndex = source.indexOf("app.use('/api/auth'");

    expect(telemetryMiddlewareIndex).toBeGreaterThan(-1);
    expect(staticAssetsIndex).toBeGreaterThan(-1);
    expect(apiRoutesIndex).toBeGreaterThan(-1);
    expect(staticAssetsIndex).toBeLessThan(telemetryMiddlewareIndex);
    expect(telemetryMiddlewareIndex).toBeLessThan(apiRoutesIndex);
  });

  it('mounts telemetry error middleware before ErrorController', () => {
    const telemetryErrorMiddlewareIndex = source.indexOf(
      'app.use(telemetry.telemetryErrorMiddleware);',
    );
    const errorControllerIndex = source.indexOf('app.use(ErrorController);');

    expect(telemetryErrorMiddlewareIndex).toBeGreaterThan(-1);
    expect(errorControllerIndex).toBeGreaterThan(-1);
    expect(telemetryErrorMiddlewareIndex).toBeLessThan(errorControllerIndex);
  });

  it('captures agent ingress before parsing and creates its recorder before auth routes', () => {
    const ingressIndex = source.indexOf(
      "app.use('/api/agents/chat', agentStartupIngressMiddleware);",
    );
    const jsonParserIndex = source.indexOf(
      "app.use(excludeRumBodyParser(express.json({ limit: '3mb' })));",
    );
    const recorderIndex = source.indexOf(
      "app.use('/api/agents/chat', agentStartupTelemetryMiddleware);",
    );
    const tracingIndex = source.indexOf('app.use(telemetry.telemetryMiddleware);');
    const agentsRouteIndex = source.indexOf("app.use('/api/agents', routes.agents);");

    expect(ingressIndex).toBeGreaterThan(-1);
    expect(recorderIndex).toBeGreaterThan(-1);
    expect(jsonParserIndex).toBeGreaterThan(-1);
    expect(ingressIndex).toBeLessThan(jsonParserIndex);
    expect(tracingIndex).toBeLessThan(recorderIndex);
    expect(recorderIndex).toBeLessThan(agentsRouteIndex);
  });
});

describe('Startup readiness wiring', () => {
  const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const runtimeSource = fs.readFileSync(path.join(__dirname, 'services/start/runtime.js'), 'utf8');
  const maintenanceSource = fs.readFileSync(
    path.join(__dirname, 'services/start/maintenance.js'),
    'utf8',
  );

  it('starts code-environment lifecycle reconciliation only after Mongo connects', () => {
    expect(runtimeSource.indexOf('await connectDb();')).toBeLessThan(
      runtimeSource.indexOf('startCodeEnvironmentLifecycleReconciler({ mongoose });'),
    );
    expect(
      runtimeSource.match(/startCodeEnvironmentLifecycleReconciler\(\{ mongoose \}\);/g),
    ).toHaveLength(1);
    const connected = source.indexOf('await initializeConnectedRuntime({');
    const released = source.indexOf('await maintenance.waitForStartupRelease(startupSignal);');
    const start = source.indexOf('await connected.start();');
    expect(connected).toBeGreaterThan(-1);
    expect(released).toBeGreaterThan(connected);
    expect(start).toBeGreaterThan(released);
    expect(source.indexOf('const server = app.listen')).toBeGreaterThan(start);
  });

  it('configures social logins with the app config loaded at startup in both server entries', () => {
    const experimental = fs.readFileSync(path.join(__dirname, 'experimental.js'), 'utf8');

    for (const [name, contents] of [
      ['index.js', source],
      ['experimental.js', experimental],
    ]) {
      const appConfigIndex = contents.indexOf(
        name === 'index.js'
          ? 'const { appConfig, uploads } = application;'
          : 'const appConfig = await getAppConfig(',
      );
      const socialLoginsIndex = contents.indexOf('await configureSocialLogins(app, appConfig);');

      expect([name, appConfigIndex > -1]).toEqual([name, true]);
      expect([name, socialLoginsIndex > appConfigIndex]).toEqual([name, true]);
    }
  });

  it('awaits the shared Redis client before startup cache access', () => {
    const redisReadyIndex = source.indexOf('await waitForRedisStartup();');
    const connectDbIndex = source.indexOf('await initializeConnectedRuntime({');
    const appConfigIndex = source.indexOf('await initializeApplicationRuntime({');
    expect(runtimeSource).toContain('await getAppConfig({ baseOnly: true });');

    expect(redisReadyIndex).toBeGreaterThan(-1);
    expect(connectDbIndex).toBeGreaterThan(redisReadyIndex);
    expect(appConfigIndex).toBeGreaterThan(redisReadyIndex);
  });

  it('configures generation streams before the server accepts requests', () => {
    const streamConfigIndex = source.indexOf('configureGenerationStreams();');
    const listenIndex = source.indexOf('const server = app.listen');
    const postListenMcpIndex = source.indexOf('await initializeMCPs();');

    expect(streamConfigIndex).toBeGreaterThan(-1);
    expect(listenIndex).toBeGreaterThan(-1);
    expect(postListenMcpIndex).toBeGreaterThan(-1);
    expect(streamConfigIndex).toBeLessThan(listenIndex);
    expect(streamConfigIndex).toBeLessThan(postListenMcpIndex);
  });

  it('configures subagent task routing before the server accepts requests', () => {
    const routingIndex = runtimeSource.indexOf(
      'await configureSubagentTaskRouting(appConfig?.endpoints?.agents?.subagentActivity);',
    );
    const listenIndex = source.indexOf('const server = app.listen');

    expect(routingIndex).toBeGreaterThan(-1);
    expect(source.indexOf('await application.start();')).toBeLessThan(listenIndex);
  });

  it('registers generation stream cleanup with the graceful shutdown coordinator', () => {
    const shutdownRegistrationIndex = maintenanceSource.indexOf(
      "registerShutdownTask('generation job manager'",
    );
    const listenIndex = source.indexOf('const server = app.listen');

    expect(shutdownRegistrationIndex).toBeGreaterThan(-1);
    expect(source.indexOf('await configureGenerationStreams();')).toBeLessThan(listenIndex);
  });

  it('registers background task draining with the graceful shutdown coordinator', () => {
    const registrationIndex = runtimeSource.indexOf('registerBackgroundTaskShutdown({');
    const listenIndex = source.indexOf('const server = app.listen');

    expect(registrationIndex).toBeGreaterThan(-1);
    expect(source.indexOf('await application.start();')).toBeLessThan(listenIndex);
    expect(runtimeSource).toContain(
      'interruptGraceMs: appConfig?.endpoints?.agents?.backgroundTasks?.shutdownInterruptGraceMs',
    );
  });

  it('configures HTTP timeouts before graceful shutdown handling', () => {
    const listenIndex = source.indexOf('const server = app.listen');
    const timeoutConfigIndex = source.indexOf('configureServerTimeouts(server);');
    const shutdownIndex = source.indexOf(
      'setupGracefulShutdown(server, { deferHttpCloseUntilPreDrain: true });',
    );

    expect(listenIndex).toBeGreaterThan(-1);
    expect(timeoutConfigIndex).toBeGreaterThan(-1);
    expect(shutdownIndex).toBeGreaterThan(-1);
    expect(listenIndex).toBeLessThan(timeoutConfigIndex);
    expect(timeoutConfigIndex).toBeLessThan(shutdownIndex);
  });

  it('registers security headers ahead of the health endpoints in both server entries', () => {
    const experimental = fs.readFileSync(path.join(__dirname, 'experimental.js'), 'utf8');

    for (const [name, contents] of [
      ['index.js', source],
      ['experimental.js', experimental],
    ]) {
      const headersIndex = contents.indexOf('const securityHeaders = createSecurityHeaders();');
      const healthIndex = contents.indexOf("app.get('/health'");

      expect([name, headersIndex > -1]).toEqual([name, true]);
      expect([name, healthIndex > -1]).toEqual([name, true]);
      expect([name, headersIndex < healthIndex]).toEqual([name, true]);
    }
  });

  it('mounts the chat-start readiness gate before agent routes', () => {
    const readinessGateIndex = source.indexOf(
      "app.use('/api/agents/chat', rejectChatStartsUntilReady);",
    );
    const agentsRouteIndex = source.indexOf("app.use('/api/agents', routes.agents);");

    expect(readinessGateIndex).toBeGreaterThan(-1);
    expect(agentsRouteIndex).toBeGreaterThan(-1);
    expect(readinessGateIndex).toBeLessThan(agentsRouteIndex);
  });

  it('awaits durable trigger delivery before reporting readiness', () => {
    const triggerDeliveryIndex = source.indexOf('await initializeAgentTriggerService(');
    const readyIndex = source.indexOf('serverReady = true;');

    expect(triggerDeliveryIndex).toBeGreaterThan(-1);
    expect(readyIndex).toBeGreaterThan(triggerDeliveryIndex);
  });
});

describe('Server Configuration', () => {
  jest.setTimeout(30_000);

  let mongoServer;
  let app;
  let fixture;
  let directory;

  beforeAll(async () => {
    directory = createFixtureDirectory();
    fs.mkdirSync(path.join(directory, 'mongo'));
    mongoServer = await MongoMemoryServer.create({
      instance: { dbPath: path.join(directory, 'mongo') },
    });
    fixture = await createAppFixture(directory, mongoServer.getUri(), {
      CUSTOM_FOOTER: 'Operator policy footer',
    });
    app = fixture.app;
    await fixture.ready();
  });

  afterAll(async () => {
    try {
      if (fixture) assert.deepEqual(await fixture.stop(), { code: 0, signal: null });
    } finally {
      if (!fixture || fixture.joined) {
        await mongoServer?.stop();
        if (directory) fs.rmSync(directory, { recursive: true });
      }
    }
  });

  it('should return OK for /health', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.text).toBe('OK');
  });

  it('should set baseline security headers on health checks', async () => {
    const response = await request(app).get('/health');

    expect(response.headers['strict-transport-security']).toBe('max-age=31536000');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('should set baseline security headers on the index page without a CSP', async () => {
    const response = await request(app).get('/');

    expect(response.status).toBe(200);
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBeUndefined();
    expect(response.headers['content-security-policy-report-only']).toBeUndefined();
  });

  it('should not cache index page', async () => {
    const response = await request(app).get('/');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
    expect(response.headers['pragma']).toBe('no-cache');
    expect(response.headers['expires']).toBe('0');
  });

  it('should return 404 JSON for undefined API routes', async () => {
    const response = await request(app).get('/api/nonexistent');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: 'Endpoint not found' });
  });

  it('should return 404 JSON for nested undefined API routes', async () => {
    const response = await request(app).get('/api/nonexistent/nested/path');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: 'Endpoint not found' });
  });

  it('should return 404 JSON for non-GET methods on undefined API routes', async () => {
    const post = await request(app).post('/api/nonexistent');
    expect(post.status).toBe(404);
    expect(post.body).toEqual({ message: 'Endpoint not found' });

    const del = await request(app).delete('/api/nonexistent');
    expect(del.status).toBe(404);
    expect(del.body).toEqual({ message: 'Endpoint not found' });
  });

  it('should return 404 JSON for the /api root path', async () => {
    const response = await request(app).get('/api');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ message: 'Endpoint not found' });
  });

  it('should serve SPA HTML for non-API unmatched routes', async () => {
    const response = await request(app).get('/this/does/not/exist');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/html/);
  });

  it('should gate React Query Devtools config in SPA HTML by debug header', async () => {
    const defaultResponse = await request(app).get('/this/does/not/exist');
    const debugResponse = await request(app)
      .get('/this/does/not/exist')
      .set('x-librechat-enable-query-devtools', '1');
    const directIndexResponse = await request(app)
      .get('/index.html')
      .set('x-librechat-enable-query-devtools', '1');

    expect(defaultResponse.status).toBe(200);
    expect(defaultResponse.headers.vary).toContain('x-librechat-enable-query-devtools');
    expect(defaultResponse.text).not.toContain('enableQueryDevtools');

    expect(debugResponse.status).toBe(200);
    expect(debugResponse.headers.vary).toContain('x-librechat-enable-query-devtools');
    expect(debugResponse.text).toContain('window.__LIBRECHAT_CONFIG__');
    expect(debugResponse.text).toContain('data-librechat-query-devtools="true"');
    expect(debugResponse.text).toContain('"enableQueryDevtools":true');

    expect(directIndexResponse.status).toBe(200);
    expect(directIndexResponse.headers.vary).toContain('x-librechat-enable-query-devtools');
    expect(directIndexResponse.text).toContain('window.__LIBRECHAT_CONFIG__');
    expect(directIndexResponse.text).toContain('data-librechat-query-devtools="true"');
    expect(directIndexResponse.text).toContain('"enableQueryDevtools":true');
  });

  it('serves the configured-footer answer with the shell', async () => {
    const [fallbackResponse, indexResponse] = await Promise.all([
      request(app).get('/this/does/not/exist'),
      request(app).get('/index.html'),
    ]);

    for (const response of [fallbackResponse, indexResponse]) {
      expect(response.status).toBe(200);
      expect(response.text).toContain('window.__LIBRECHAT_CONFIG__');
      expect(response.text).toContain('"hasConfiguredFooter":true');
    }
  });

  it('should return 500 for unknown errors via ErrorController', async () => {
    // Testing the error handling here on top of unit tests to ensure the middleware is correctly integrated

    await fixture.command('database-error', true);

    try {
      const response = await request(app).post('/api/auth/login').send({
        email: 'test@example.com',
        password: 'password123',
      });

      expect(response.status).toBe(500);
      expect(response.text).toBe('An unknown error occurred.');
    } finally {
      await fixture.command('database-error', false);
    }
  });
});

/** Keep pending originals outside the canonical hook's automatically removed child root. */
function createFixtureDirectory() {
  const canonical = process.env.UPLOAD_TEST_TMPDIR;
  if (!canonical || !path.isAbsolute(canonical))
    throw new Error('Canonical upload fixture owner is required');
  const parent = path.dirname(canonical);
  const owner = fs.lstatSync(canonical);
  const info = fs.lstatSync(parent);
  const uid = process.getuid?.();
  if (
    !owner.isDirectory() ||
    owner.isSymbolicLink() ||
    fs.realpathSync(canonical) !== canonical ||
    owner.uid !== uid ||
    (owner.mode & 0o777) !== 0o700 ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    fs.realpathSync(parent) !== parent ||
    info.dev !== owner.dev ||
    (info.uid !== uid && info.uid !== 0) ||
    ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)
  )
    throw new Error('Canonical fixture parent identity is unavailable');
  return fs.mkdtempSync(path.join(parent, 'web-fixture-'));
}

/** Use the actual Vite manifest source without requiring a client build or executing its config. */
function readClientManifestFixture() {
  const ts = require('typescript');
  const file = path.resolve(__dirname, '../../client/vite.config.ts');
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let manifest;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'VitePWA'
    ) {
      manifest = node.arguments[0]?.properties?.find(
        (property) =>
          ts.isPropertyAssignment(property) && property.name.getText(source) === 'manifest',
      )?.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const value = (node) => {
    if (node && ts.isStringLiteral(node)) return node.text;
    if (node && ts.isArrayLiteralExpression(node)) return node.elements.map(value);
    if (node && ts.isObjectLiteralExpression(node))
      return Object.fromEntries(
        node.properties.map((property) => {
          if (
            !ts.isPropertyAssignment(property) ||
            (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))
          )
            throw new Error('Canonical client manifest must use literal fixture inputs');
          return [property.name.text, value(property.initializer)];
        }),
      );
    throw new Error('Canonical client manifest must use literal fixture inputs');
  };
  return JSON.stringify(value(manifest));
}

/** Own the real application process, its exact startup hold and its terminal close event. */
async function createAppFixture(directory, mongoUri, environment = {}) {
  const { spawn } = require('node:child_process');
  const { randomUUID } = require('node:crypto');
  const { createServer } = require('node:net');
  const availablePort = async () => {
    const listener = createServer();
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    const port = listener.address().port;
    await new Promise((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    return port;
  };
  const port = await availablePort();
  let maintenancePort;
  do {
    maintenancePort = await availablePort();
  } while (maintenancePort === port);
  const token = randomUUID().replaceAll('-', '');
  const podUid = randomUUID();
  const source = 'a'.repeat(40);
  const configPath = path.join(directory, 'librechat.yaml');
  fs.writeFileSync(configPath, 'version: 1.3.3\ncache: false\n', { mode: 0o600 });
  for (const name of ['uploads', 'dist', 'fonts', 'assets', 'images']) {
    fs.mkdirSync(path.join(directory, name));
  }
  fs.writeFileSync(path.join(directory, 'dist', 'index.html'), FIXTURE_INDEX_HTML);
  fs.writeFileSync(
    path.join(directory, 'dist', 'manifest.webmanifest'),
    readClientManifestFixture(),
  );
  const child = spawn(process.execPath, ['-e', `(${runFixtureApplication.toString()})()`], {
    cwd: directory,
    env: {
      NODE_ENV: 'test',
      CI: 'true',
      TMPDIR: directory,
      UPLOAD_TEST_TMPDIR: directory,
      CONFIG_PATH: configPath,
      LOG_TO_FILE: 'false',
      AUTH_MODE: 'default',
      ALLOW_EMAIL_LOGIN: 'true',
      JWT_SECRET: 'test',
      JWT_REFRESH_SECRET: 'test',
      CREDS_KEY: '0123456789abcdef'.repeat(4),
      CREDS_IV: '0123456789abcdef'.repeat(2),
      MONGO_URI: mongoUri,
      HOST: '127.0.0.1',
      PORT: String(port),
      POD_UID: podUid,
      BUILD_COMMIT: source,
      LIBRECHAT_MAINTENANCE_TOKEN: token,
      LIBRECHAT_MAINTENANCE_PORT: String(maintenancePort),
      FIXTURE_ROOT: directory,
      FIXTURE_ENTRY: path.join(__dirname, 'index.js'),
      ...environment,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let childError;
  child.once('error', (error) => {
    childError = error;
  });
  const commands = new Map();
  let output = '';
  child.stdout.on('data', (data) => {
    output = (output + data).slice(-16384);
  });
  child.stderr.on('data', (data) => {
    output = (output + data).slice(-16384);
  });
  const identity = (pid) => ({
    pid,
    startTicks: fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop().split(' ')[19],
    bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
  });
  let original;
  try {
    original = identity(child.pid);
  } catch (error) {
    childError = error;
  }
  const provenanceFile = path.join(directory, 'application-child.json');
  const provenance = {
    ...original,
    parentPid: process.pid,
    entry: path.join(__dirname, 'index.js'),
    podUid,
    source,
    checkpoint: 'Actual application close after graceful SIGTERM',
    cancellation: 'Only this child after exact PID/startTicks/bootId verification',
  };
  fs.writeFileSync(provenanceFile, JSON.stringify(provenance), { mode: 0o600 });
  let joined = false;
  const closed = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      joined = true;
      for (const pending of commands.values())
        pending.reject(new Error(`Application exited before command acknowledgement: ${output}`));
      commands.clear();
      const result = { code, signal };
      fs.writeFileSync(provenanceFile, JSON.stringify({ ...provenance, closed: result }));
      resolve(result);
    });
  });
  child.on('message', (message) => {
    if (message?.type === 'fixture-gated') {
      if (original) child.send({ type: 'fixture-start' });
      else child.disconnect();
    }
    if (message?.type === 'fixture-ack') {
      const pending = commands.get(message.id);
      commands.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error));
      else pending?.resolve();
    }
  });
  let released = false;
  const app = `http://127.0.0.1:${port}`;
  return {
    app,
    get joined() {
      return joined;
    },
    command(type, value) {
      if (joined || child.exitCode !== null || child.signalCode !== null)
        return Promise.reject(new Error('Application exited before fixture command'));
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        commands.set(id, { resolve, reject });
        child.send({ type, value, id }, (error) => {
          if (error) {
            commands.delete(id);
            reject(error);
          }
        });
      });
    },
    async ready() {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (childError || joined)
          throw new Error(`Application startup failed: ${childError || output}`);
        try {
          if (!released) {
            const status = await request(`http://127.0.0.1:${maintenancePort}`)
              .get('/status')
              .set('Authorization', `Bearer ${token}`)
              .timeout(500);
            const held = status.body;
            if (
              status.status === 200 &&
              held.identity?.podUid === podUid &&
              held.identity?.source === source &&
              held.revision === 1 &&
              held.requestId === `startup_${held.identity.incarnation}`
            ) {
              const release = await request(`http://127.0.0.1:${maintenancePort}`)
                .post('/cancel')
                .set('Authorization', `Bearer ${token}`)
                .send({
                  requestId: held.requestId,
                  identity: held.identity,
                  expectedRevision: held.revision,
                })
                .timeout(500);
              if (
                release.status !== 200 ||
                release.body.revision !== 2 ||
                release.body.requestId !== null
              )
                throw new Error('Actual startup release was not acknowledged');
              released = true;
            }
          }
          if (released && (await request(app).get('/health').timeout(500)).status === 200) return;
        } catch (error) {
          if (error.message === 'Actual startup release was not acknowledged') throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      throw new Error(`App did not become healthy within 10 seconds.\n${output}`);
    },
    async stop() {
      if (!joined && child.exitCode === null && child.signalCode === null) {
        if (!original) {
          if (child.connected) child.disconnect();
          return closed;
        }
        if (JSON.stringify(identity(child.pid)) !== JSON.stringify(original))
          throw new Error('Application child identity changed; refusing signal');
        child.kill('SIGTERM');
      }
      return closed;
    },
  };
}

/** Child-only fixture inputs; startup, model graph, maintenance and shutdown stay real. */
function runFixtureApplication() {
  process.once('message', (message) => {
    if (message?.type !== 'fixture-start') throw new Error('Missing fixture process admission');
    const path = require('node:path');
    const fixtureRequire = require('node:module').createRequire(process.env.FIXTURE_ENTRY);
    const paths = fixtureRequire('../config/paths');
    for (const name of ['uploads', 'dist', 'fonts', 'assets', 'imageOutput']) {
      paths[name] = path.join(process.env.FIXTURE_ROOT, name === 'imageOutput' ? 'images' : name);
    }
    fixtureRequire(process.env.FIXTURE_ENTRY);
    let originalFindOne;
    process.on('message', (command) => {
      if (!command.id) return;
      try {
        if (command.type === 'metrics-secret') {
          if (command.value === null) delete process.env.METRICS_SECRET;
          else process.env.METRICS_SECRET = command.value;
        } else if (command.type === 'database-error') {
          const User = fixtureRequire('mongoose').models.User;
          if (command.value) {
            originalFindOne = User.findOne;
            User.findOne = () => {
              throw new Error('MongoDB operation failed');
            };
          } else if (originalFindOne) {
            User.findOne = originalFindOne;
            originalFindOne = undefined;
          }
        } else throw new Error('Unknown fixture command');
        process.send({ type: 'fixture-ack', id: command.id });
      } catch (error) {
        process.send({ type: 'fixture-ack', id: command.id, error: error.message });
      }
    });
  });
  process.send({ type: 'fixture-gated' });
}
