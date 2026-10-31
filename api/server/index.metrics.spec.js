const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');

const FIXTURE_INDEX_HTML =
  '<!DOCTYPE html><html><head><title>LibreChat</title></head><body><div id="root"></div></body></html>';

describe('Server metrics route', () => {
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
      METRICS_SECRET: 'test-secret',
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

  afterEach(async () => {
    if (fixture && !fixture.joined) await fixture.command('metrics-secret', 'test-secret');
  });

  it('returns 401 at /metrics when METRICS_SECRET is unset', async () => {
    await fixture.command('metrics-secret', null);
    const response = await request(app).get('/metrics');
    expect(response.status).toBe(401);
  });

  it('returns 401 at /metrics when no token provided', async () => {
    await fixture.command('metrics-secret', 'test-secret');

    const response = await request(app).get('/metrics');

    expect(response.status).toBe(401);
  });

  it('returns 401 at /metrics when wrong token provided', async () => {
    await fixture.command('metrics-secret', 'test-secret');

    const response = await request(app).get('/metrics').set('Authorization', 'Bearer wrong-token');

    expect(response.status).toBe(401);
  });

  it('returns 401 at /metrics when the bearer scheme is omitted', async () => {
    await fixture.command('metrics-secret', 'test-secret');

    const response = await request(app).get('/metrics').set('Authorization', 'test-secret');

    expect(response.status).toBe(401);
  });

  it('returns 401 at /metrics for non-bearer auth schemes', async () => {
    await fixture.command('metrics-secret', 'test-secret');

    const response = await request(app).get('/metrics').set('Authorization', 'Basic test-secret');

    expect(response.status).toBe(401);
  });

  it('exposes Prometheus metrics at /metrics with correct bearer token', async () => {
    await fixture.command('metrics-secret', 'test-secret');

    const response = await request(app).get('/metrics').set('Authorization', 'Bearer test-secret');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/plain/);
    expect(response.text).toMatch(/^# HELP /m);
    expect(response.text).toMatch(/^# TYPE /m);
  });

  it('accepts lowercase bearer scheme at /metrics', async () => {
    await fixture.command('metrics-secret', 'test-secret');

    const response = await request(app).get('/metrics').set('Authorization', 'bearer test-secret');

    expect(response.status).toBe(200);
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
