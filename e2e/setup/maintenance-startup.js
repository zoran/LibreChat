/** Owns the isolated E2E child's real private startup hold; production admission stays unchanged. */
const { execFileSync } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const STARTUP_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5000;
const MAXIMUM_RESPONSE_BYTES = 65_536;
const INCARNATION = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

async function prepareMaintenanceStartup() {
  const source = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.resolve(__dirname, '../..'),
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 128,
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(source)) {
    throw new Error('[e2e] Application source identity is unavailable');
  }
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
  const env = {
    LIBRECHAT_MAINTENANCE_TOKEN: randomBytes(32).toString('base64url'),
    LIBRECHAT_MAINTENANCE_PORT: String(port),
    POD_UID: randomUUID(),
    BUILD_COMMIT: source,
  };
  return { env, port };
}

function readMaintenance(startup, pathname, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: startup.port,
        path: pathname,
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${startup.env.LIBRECHAT_MAINTENANCE_TOKEN}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          reject(new Error(`[e2e] Private startup ${pathname} returned ${response.statusCode}`));
          return;
        }
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > MAXIMUM_RESPONSE_BYTES) {
            response.destroy(new Error('[e2e] Private startup response exceeded its bound'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', reject);
        response.once('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new Error('[e2e] Private startup response is invalid'));
          }
        });
      },
    );
    request.once('error', reject);
    const timer = setTimeout(
      () => request.destroy(new Error('[e2e] Private startup request timed out')),
      REQUEST_TIMEOUT_MS,
    );
    request.once('close', () => clearTimeout(timer));
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function requireOwnedChild(child) {
  if (!Number.isSafeInteger(child.pid) || child.exitCode !== null || child.signalCode !== null) {
    throw new Error('[e2e] Owned application child ended before startup release');
  }
}

async function releaseMaintenanceStartup(startup, child) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let status;
  while (Date.now() < deadline) {
    requireOwnedChild(child);
    try {
      status = await readMaintenance(startup, '/status');
      break;
    } catch (error) {
      if (error.code !== 'ECONNREFUSED') {
        throw error;
      }
      await delay(50);
    }
  }
  const identity = status?.identity;
  if (
    !identity ||
    Object.keys(identity).sort().join(',') !== 'incarnation,podUid,source' ||
    identity.podUid !== startup.env.POD_UID ||
    identity.source !== startup.env.BUILD_COMMIT ||
    !INCARNATION.test(identity.incarnation) ||
    status.requestId !== `startup_${identity.incarnation}` ||
    status.revision !== 1 ||
    !['quiescing', 'drained'].includes(status.phase)
  ) {
    throw new Error('[e2e] Owned application startup hold is unconfirmed');
  }
  requireOwnedChild(child);
  const released = await readMaintenance(startup, '/cancel', {
    requestId: status.requestId,
    identity,
    expectedRevision: status.revision,
  });
  requireOwnedChild(child);
  if (
    JSON.stringify(released.identity) !== JSON.stringify(identity) ||
    released.requestId !== null ||
    released.revision !== 2 ||
    released.phase !== 'running'
  ) {
    throw new Error('[e2e] Owned application startup release is unconfirmed');
  }
}

module.exports = { prepareMaintenanceStartup, releaseMaintenanceStartup };
