const https = require('node:https');
const { isIP } = require('node:net');
const { LIMITS } = require('./cache');

const PATHS = ['/v1/status-projection', '/v1/status-rule-health'];
function readObserverConfig(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 1024)
    throw Error('STATUS_OBSERVER_CONFIG');
  const rows = JSON.parse(value);
  if (
    !Array.isArray(rows) ||
    rows.length !== 2 ||
    new Set(rows.map((row) => row.id)).size !== 2 ||
    rows.some(
      (row) =>
        !row ||
        Object.keys(row).sort().join(',') !== 'host,id,servername' ||
        !/^lx-s-bwi-cpu-[23]$/.test(row.id) ||
        row.servername !== row.id ||
        isIP(row.host) !== 4,
    )
  ) {
    throw Error('STATUS_OBSERVER_CONFIG');
  }
  return rows;
}
/** Two fixed requests share the absolute refresh deadline and one preparse byte budget. */
async function readObserver(
  observer,
  { tls, signal: outer, request = https.request, record = () => {} },
) {
  const started = performance.now();
  let bytes = 0;
  let outcome = 'failure';
  let timedOut = false;
  async function read(path) {
    outer.throwIfAborted();
    const perRequest = AbortSignal.timeout(LIMITS.observerMs);
    const signal = AbortSignal.any([outer, perRequest]);
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: observer.host,
          servername: observer.servername,
          port: 9447,
          path,
          method: 'GET',
          agent: false,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
          ca: tls.ca,
          cert: tls.cert,
          key: tls.key,
          headers: { Accept: 'application/json' },
          signal,
        },
        (response) => {
          const chunks = [];
          const fail = (error) => {
            response.destroy();
            req.destroy(error);
            reject(error);
          };
          if (
            response.statusCode !== 200 ||
            !/^application\/json(?:;|$)/i.test(response.headers['content-type'] ?? '')
          ) {
            fail(Error('STATUS_OBSERVER_RESPONSE'));
            return;
          }
          const declared = response.headers['content-length'];
          if (
            declared !== undefined &&
            (!/^\d+$/.test(String(declared)) || Number(declared) > LIMITS.observerBytes - bytes)
          ) {
            fail(Error('STATUS_OBSERVER_BOUND'));
            return;
          }
          response.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > LIMITS.observerBytes) {
              fail(Error('STATUS_OBSERVER_BOUND'));
              return;
            }
            chunks.push(chunk);
          });
          response.once('aborted', () => reject(Error('STATUS_OBSERVER_TRUNCATED')));
          response.once('error', reject);
          response.once('end', () => {
            if (!response.complete) reject(Error('STATUS_OBSERVER_TRUNCATED'));
            else resolve(Buffer.concat(chunks));
          });
        },
      );
      req.once('error', (error) => {
        timedOut ||= perRequest.aborted;
        reject(error);
      });
      req.end();
    });
  }
  try {
    const projection = await read(PATHS[0]);
    const ruleHealth = await read(PATHS[1]);
    outer.throwIfAborted();
    outcome = 'success';
    return { observerId: observer.id, projection, ruleHealth, receivedAt: Date.now() / 1000 };
  } finally {
    if (outer.aborted || timedOut) outcome = timedOut ? 'timeout' : 'aborted';
    record('observer', outcome, (performance.now() - started) / 1000, bytes);
  }
}
module.exports = { PATHS, readObserverConfig, readObserver };
