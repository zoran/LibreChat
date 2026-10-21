const fs = require('node:fs/promises');
const { createStatusCache, LIMITS, assertWitness } = require('./cache');
const { readObserverConfig, readObserver } = require('./observer');
const { createProjector, healthDeadline } = require('./projection');
const { mergeStatusUsage } = require('./usage');

const MOUNT = '/etc/cortex-status-projection';
async function readBounded(path, maxBytes, signal) {
  signal.throwIfAborted();
  const handle = await fs.open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw Error('STATUS_CONFIG_BOUND');
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    signal.throwIfAborted();
    if (offset > maxBytes) throw Error('STATUS_CONFIG_BOUND');
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
/** Construction has no file/network side effects. Caller capability middleware runs first. */
function createStatusService({
  client,
  readStatusSnapshot,
  encodeStatusSnapshot,
  STATUS_METRICS,
  readUsage,
  record = () => {},
  env = process.env,
  readFile = readBounded,
  observe = readObserver,
  now = () => Date.now() / 1000,
}) {
  const projector = createProjector({ readStatusSnapshot, encodeStatusSnapshot, STATUS_METRICS });
  const cache = createStatusCache({
    client,
    record,
    load: async (signal) => {
      const observers = readObserverConfig(env.CORTEX_STATUS_OBSERVERS_JSON);
      const asOfMs = Math.floor(now()) * 1000;
      // The runtime retains original database reads even if this cache waiter aborts.
      const usage = readUsage
        ? Promise.resolve()
            .then(() => readUsage({ asOfMs, signal }))
            .catch(() => null)
        : null;
      const [topology, ca, cert, key] = await Promise.all([
        readFile(`${MOUNT}/topology.json`, LIMITS.dtoBytes, signal),
        ...['ca.crt', 'tls.crt', 'tls.key'].map((name) =>
          readFile(`${MOUNT}/${name}`, 65536, signal),
        ),
      ]);
      signal.throwIfAborted();
      const seed = readStatusSnapshot(JSON.parse(topology.toString('utf8')));
      if (!seed) throw Error('STATUS_TOPOLOGY_INVALID');
      const responses = await Promise.all(
        observers.map((observer) =>
          observe(observer, { tls: { ca, cert, key }, signal, record }).catch(() => null),
        ),
      );
      const usageResult = usage ? await usage : null;
      signal.throwIfAborted();
      const capturedAt = now();
      const snapshot = projector.project(seed, responses, capturedAt);
      const admitted = new Set(
        snapshot.sources
          .filter((source) => source.kind === 'prometheus')
          .map((source) => source.observerId),
      );
      const deadlines = responses
        .filter((response) => response && admitted.has(response.observerId))
        .map((response) => healthDeadline(response.ruleHealth, capturedAt));
      if (readUsage) {
        const usageDeadline = mergeStatusUsage(snapshot, usageResult, asOfMs);
        if (usageDeadline !== null) deadlines.push(usageDeadline);
      }
      const wire = encodeStatusSnapshot(snapshot);
      if (!readStatusSnapshot(wire)) throw Error('STATUS_DTO_INVALID');
      return {
        body: JSON.stringify(wire),
        validUntil: deadlines.length ? Math.min(...deadlines) : null,
      };
    },
  });
  return async (signal) => {
    signal?.throwIfAborted();
    if (env.CORTEX_STATUS_ENABLED !== 'true') throw Error('STATUS_DISABLED');
    const result = await cache(signal);
    signal?.throwIfAborted();
    const snapshot = projector.age(readStatusSnapshot(JSON.parse(result.body)), now());
    if (
      snapshot.sources.some((source) => source.kind === 'prometheus') &&
      result.validUntilMs === null
    ) {
      throw Error('STATUS_CACHE_INVALID');
    }
    const body = JSON.stringify(encodeStatusSnapshot(snapshot));
    assertWitness(result.validUntilMs);
    return { body, validUntilMs: result.validUntilMs };
  };
}
module.exports = { createStatusService, readBounded, MOUNT };
