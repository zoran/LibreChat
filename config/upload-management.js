/** Finite internal initial-empty activation; UploadStore remains the only accounting writer. */
'use strict';

const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const fs = require('node:fs');

const INPUT_LIMIT = 16 * 1024;
const OUTPUT_LIMIT = 16 * 1024;
const RESOURCE_KEYS = ['originalBytes', 'objectBytes', 'textBytes', 'recordBytes', 'bundles'];
const TARGET_KEYS = [
  'sourceRevision',
  'imageDigest',
  'namespaceUid',
  'mongoReplicaSet',
  'mongoDatabase',
  'storageDeploymentId',
  'storageStoreId',
  'bucket',
  'coordination',
];
const SNAPSHOT_KEYS = [
  'storeId',
  'revision',
  'observedAt',
  'ledgerTotals',
  'baseline',
  'initialInventory',
];
const COMMON_KEYS = [
  'schema',
  'owner',
  'observedFrom',
  'observedThrough',
  'originalDeadline',
  'targetBindingSha256',
  'complete',
  'saturatedCounts',
  'evidenceSha256',
];
const BUCKETS = ['cortex-managed-uploads', 'cortex-qualification'];
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ERROR_CODES = new Set([
  'INVALID_INPUT',
  'INPUT_TIMEOUT',
  'TARGET_MISMATCH',
  'NONEMPTY',
  'INCOMPLETE',
  'EXPIRED',
  'UNAVAILABLE',
  'UNKNOWN_COMMIT',
]);

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
function requireValue(condition, code = 'INVALID_INPUT') {
  if (!condition) throw failure(code);
}
function object(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function shape(value, keys) {
  requireValue(
    object(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)),
  );
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value))
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
function digest(value) {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}
function timestamp(value) {
  requireValue(typeof value === 'string' && value.length === 24);
  const parsed = Date.parse(value);
  requireValue(Number.isSafeInteger(parsed) && new Date(parsed).toISOString() === value);
  return parsed;
}
function zeroFields(value, keys, saturated = false) {
  shape(value, keys);
  for (const key of keys) {
    requireValue(
      Number.isSafeInteger(value[key]) && value[key] >= 0 && (!saturated || value[key] <= 1),
    );
    requireValue(value[key] === 0, 'NONEMPTY');
  }
}
function boundedNames(value, pattern) {
  requireValue(
    Array.isArray(value) &&
      value.length > 0 &&
      value.length <= 32 &&
      new Set(value).size === value.length &&
      value.every((entry) => typeof entry === 'string' && pattern.test(entry)),
  );
}
function isHash(value) {
  return typeof value === 'string' && SHA.test(value);
}
function validateTarget(target) {
  shape(target, TARGET_KEYS);
  requireValue(
    TARGET_KEYS.filter((key) => key !== 'coordination').every(
      (key) => typeof target[key] === 'string',
    ),
  );
  requireValue(
    /^[a-f0-9]{40}$/.test(target.sourceRevision) &&
      /^sha256:[a-f0-9]{64}$/.test(target.imageDigest) &&
      UUID.test(target.namespaceUid) &&
      NAME.test(target.mongoReplicaSet) &&
      /^[A-Za-z0-9_-]{1,63}$/.test(target.mongoDatabase) &&
      NAME.test(target.storageDeploymentId) &&
      NAME.test(target.storageStoreId) &&
      target.bucket === BUCKETS[0],
  );
  shape(target.coordination, ['sentinelName', 'database', 'keyPrefix']);
  requireValue(
    typeof target.coordination.sentinelName === 'string' &&
      typeof target.coordination.keyPrefix === 'string' &&
      /^[A-Za-z0-9_-]{1,128}$/.test(target.coordination.sentinelName) &&
      target.coordination.database === 0 &&
      /^[A-Za-z0-9._:-]{0,128}::$/.test(target.coordination.keyPrefix),
  );
}
function validateSnapshot(snapshot, envelope, now) {
  shape(snapshot, SNAPSHOT_KEYS);
  requireValue(
    typeof snapshot.storeId === 'string' &&
      UUID.test(snapshot.storeId) &&
      Number.isSafeInteger(snapshot.revision) &&
      snapshot.revision >= 0,
  );
  const observed = timestamp(snapshot.observedAt);
  const deadline = timestamp(envelope.originalDeadline);
  requireValue(observed <= now && observed <= deadline && deadline - observed <= 300_000);
  zeroFields(snapshot.ledgerTotals, RESOURCE_KEYS);
  zeroFields(snapshot.baseline, RESOURCE_KEYS);
  zeroFields(snapshot.initialInventory, ['operations', 'files', 'sourceMessages'], true);
}
function validateProducer(value, owner, envelope, observedAt, now, storageGateways) {
  let extra;
  let keys;
  if (owner === 'generation-stream') {
    extra = ['adapter'];
    keys = ['sourceJobs', 'replayIntents', 'recoveryCopies'];
  } else if (owner === 'agent-checkpoints') {
    extra = ['configurationSha256'];
    keys = ['recoveryCopies'];
  } else if (owner === 'object-storage') {
    extra = ['measuredBytes', 'storageBindingSha256', 'buckets', 'gateways'];
    keys = ['objects', 'multipartUploads', 'versions', 'deleteMarkers'];
  } else {
    extra = ['measuredBytes', 'volumeEvidenceSha256', 'eligibleHosts', 'podUids'];
    keys = ['heldAttempts', 'stagedCopies', 'unresolvedWriters'];
  }
  shape(value, [...COMMON_KEYS, ...extra]);
  requireValue(value.schema === 1 && value.owner === owner);
  requireValue(
    value.targetBindingSha256 === digest(envelope.target) &&
      value.originalDeadline === envelope.originalDeadline,
    'TARGET_MISMATCH',
  );
  const from = timestamp(value.observedFrom);
  const through = timestamp(value.observedThrough);
  requireValue(
    from >= timestamp(observedAt) &&
      from <= through &&
      through <= timestamp(envelope.originalDeadline) &&
      through <= now,
  );
  requireValue(isHash(value.evidenceSha256));
  zeroFields(value.saturatedCounts, keys, true);
  requireValue(value.complete === true, 'INCOMPLETE');
  if (owner === 'generation-stream') requireValue(value.adapter === 'redis', 'INCOMPLETE');
  if (owner === 'agent-checkpoints') requireValue(isHash(value.configurationSha256));
  if (owner === 'object-storage') {
    zeroFields(value.measuredBytes, ['objectBytes', 'multipartBytes', 'versionBytes']);
    requireValue(
      isHash(value.storageBindingSha256) && canonical(value.buckets) === canonical(BUCKETS),
    );
    const { validateUploadActivationGateways } = require('@librechat/api/upload-activation');
    validateUploadActivationGateways(value.gateways, storageGateways, BUCKETS);
  }
  if (owner === 'librechat-staging') {
    zeroFields(value.measuredBytes, ['heldBytes', 'stagedBytes']);
    requireValue(isHash(value.volumeEvidenceSha256));
    boundedNames(value.eligibleHosts, /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/);
    boundedNames(value.podUids, UUID);
  }
}
function snapshotFrom(preparation) {
  return Object.fromEntries(SNAPSHOT_KEYS.map((key) => [key, preparation[key]]));
}
function validateEnvelope(envelope, now = Date.now(), gatewayContext) {
  const { parseUploadActivationGatewayContext } = require('@librechat/api/upload-activation');
  const storageGateways = parseUploadActivationGatewayContext(gatewayContext);
  requireValue(Number.isSafeInteger(now) && object(envelope));
  requireValue(envelope.action === 'prepare' || envelope.action === 'activate');
  shape(envelope, [
    'schema',
    'action',
    'target',
    'originalDeadline',
    ...(envelope.action === 'activate' ? ['preparation', 'inventory'] : []),
  ]);
  requireValue(envelope.schema === 1);
  validateTarget(envelope.target);
  const deadline = timestamp(envelope.originalDeadline);
  if (envelope.action === 'prepare') {
    requireValue(deadline > now && deadline - now <= 300_000, 'EXPIRED');
    return envelope;
  }
  shape(envelope.preparation, [...SNAPSHOT_KEYS, 'replayInventory', 'checkpointInventory']);
  const snapshot = snapshotFrom(envelope.preparation);
  validateSnapshot(snapshot, envelope, now);
  validateProducer(
    envelope.preparation.replayInventory,
    'generation-stream',
    envelope,
    snapshot.observedAt,
    now,
  );
  validateProducer(
    envelope.preparation.checkpointInventory,
    'agent-checkpoints',
    envelope,
    snapshot.observedAt,
    now,
  );
  shape(envelope.inventory, ['storage', 'staging']);
  validateProducer(
    envelope.inventory.storage,
    'object-storage',
    envelope,
    snapshot.observedAt,
    now,
    storageGateways,
  );
  validateProducer(
    envelope.inventory.staging,
    'librechat-staging',
    envelope,
    snapshot.observedAt,
    now,
  );
  return envelope;
}
function decodeObject(bytes) {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    requireValue(object(value));
    return value;
  } catch {
    throw failure('INVALID_INPUT');
  }
}
function readEnvelope(input, { timeoutMs = 5000 } = {}) {
  requireValue(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 5000);
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.off('data', data);
      input.off('end', end);
      input.off('error', failed);
      input.off('close', closed);
      if (error) {
        input.destroy();
        reject(error);
      } else resolve(value);
    };
    const data = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > INPUT_LIMIT) finish(failure('INVALID_INPUT'));
      else chunks.push(bytes);
    };
    const end = () => {
      try {
        finish(undefined, decodeObject(Buffer.concat(chunks, size)));
      } catch (error) {
        finish(error);
      }
    };
    const failed = () => finish(failure('INVALID_INPUT'));
    const closed = () => {
      if (!input.readableEnded) failed();
    };
    const timer = setTimeout(() => finish(failure('INPUT_TIMEOUT')), timeoutMs);
    input.on('data', data);
    input.once('end', end);
    input.once('error', failed);
    input.once('close', closed);
  });
}
function activationProof(envelope) {
  const snapshot = envelope.preparation;
  return {
    storeId: snapshot.storeId,
    revision: snapshot.revision,
    baseline: { ...snapshot.baseline },
    inventoryEvidenceId: 'sha256:' + digest(envelope),
    observedAt: snapshot.observedAt,
    historyCopiesAccounted: true,
    admission: 'initial-empty',
    originalDeadline: envelope.originalDeadline,
  };
}
async function runActivation(envelope, ports = {}) {
  const now = ports.now ?? Date.now;
  validateEnvelope(envelope, now(), ports.storageGateways);
  const expiredReplay =
    envelope.action === 'activate' && timestamp(envelope.originalDeadline) <= now();
  const deadline = expiredReplay
    ? now() + 15_000
    : Math.min(timestamp(envelope.originalDeadline), now() + 30_000);
  const controller = new AbortController();
  // Two seconds of this same finite window are reserved for joining owned client closure.
  const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - now() - 2000));
  const live = () => requireValue(!controller.signal.aborted && now() < deadline - 2000, 'EXPIRED');
  let runtime;
  let attempted = false;
  let result;
  let operationError;
  let failed = false;
  try {
    runtime = await ports.open(envelope.target, {
      deadline,
      expiredReplay,
      signal: controller.signal,
    });
    live();
    validateTarget(runtime.target);
    requireValue(digest(runtime.target) === digest(envelope.target), 'TARGET_MISMATCH');
    if (envelope.action === 'prepare') {
      await runtime.repository.initialize();
      live();
      const snapshot = await runtime.repository.reconciliationSnapshot(now());
      live();
      validateSnapshot(snapshot, envelope, now());
      const observations = await inspectCurrent(runtime, envelope, snapshot.observedAt, now, live);
      result = {
        schema: 1,
        status: 'prepared',
        target: envelope.target,
        originalDeadline: envelope.originalDeadline,
        preparation: { ...snapshot, ...observations },
      };
    } else {
      requireValue(
        runtime.configurationSha256 ===
          envelope.preparation.checkpointInventory.configurationSha256,
        'TARGET_MISMATCH',
      );
      if (!expiredReplay) {
        await inspectCurrent(runtime, envelope, envelope.preparation.observedAt, now, live);
        live();
      }
      const proof = activationProof(envelope);
      attempted = true;
      await runtime.repository.activateReconciled(proof, now());
      live();
      result = {
        schema: 1,
        status: 'active',
        storeId: proof.storeId,
        preparationRevision: proof.revision,
        observedAt: new Date(now()).toISOString(),
        originalDeadline: envelope.originalDeadline,
        proofSha256: digest(proof),
        evidenceSha256: digest(envelope),
      };
    }
  } catch (error) {
    failed = true;
    operationError = error;
  }
  try {
    if (runtime) await runtime.close();
  } catch {
    failed = true;
    operationError = failure(attempted ? 'UNKNOWN_COMMIT' : 'UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
  if (failed) {
    if (attempted) throw failure('UNKNOWN_COMMIT');
    throw operationError && ERROR_CODES.has(operationError.code)
      ? operationError
      : failure('UNAVAILABLE');
  }
  return result;
}
async function inspectCurrent(runtime, envelope, observedAt, now, live) {
  const options = {
    originalDeadline: envelope.originalDeadline,
    targetBindingSha256: digest(envelope.target),
  };
  const replayInventory = await runtime.inspectReplay(options);
  live();
  validateProducer(replayInventory, 'generation-stream', envelope, observedAt, now());
  const checkpointInventory = await runtime.inspectCheckpoints(options);
  live();
  validateProducer(checkpointInventory, 'agent-checkpoints', envelope, observedAt, now());
  requireValue(
    isHash(runtime.configurationSha256) &&
      checkpointInventory.configurationSha256 === runtime.configurationSha256,
    'TARGET_MISMATCH',
  );
  return { replayInventory, checkpointInventory };
}

function publicContext(value, limit = INPUT_LIMIT) {
  requireValue(
    typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= limit,
    'TARGET_MISMATCH',
  );
  try {
    return decodeObject(Buffer.from(value));
  } catch {
    throw failure('TARGET_MISMATCH');
  }
}
function readTrust(filename) {
  requireValue(typeof filename === 'string' && filename.length > 0, 'UNAVAILABLE');
  let fd;
  try {
    fd = fs.openSync(filename, 'r');
    const stat = fs.fstatSync(fd);
    requireValue(stat.isFile() && stat.size > 0 && stat.size <= 65536, 'UNAVAILABLE');
    const bytes = Buffer.alloc(65537);
    let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (read === 0) break;
      count += read;
    }
    requireValue(count > 0 && count <= 65536, 'UNAVAILABLE');
    return bytes.subarray(0, count).toString('utf8');
  } catch {
    throw failure('UNAVAILABLE');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
/** One-shot adapter: same existing custody, no application cache, manager, listener or cleanup startup. */
async function openRuntime(expected, { deadline, expiredReplay, signal }, env) {
  const target = publicContext(env.CORTEX_UPLOAD_ACTIVATION_TARGET);
  validateTarget(target);
  requireValue(digest(target) === digest(expected), 'TARGET_MISMATCH');
  const cfg = publicContext(env.CORTEX_UPLOAD_ACTIVATION_CHECKPOINTER, 2048);
  requireValue(
    Object.keys(cfg).every((key) =>
      ['type', 'ttl', 'checkpointCollectionName', 'checkpointWritesCollectionName'].includes(key),
    ),
    'TARGET_MISMATCH',
  );
  requireValue(
    (cfg.type === undefined || ['mongo', 'memory'].includes(cfg.type)) &&
      (cfg.ttl === undefined || (Number.isSafeInteger(cfg.ttl) && cfg.ttl > 0)) &&
      ['checkpointCollectionName', 'checkpointWritesCollectionName'].every(
        (key) =>
          cfg[key] === undefined ||
          (typeof cfg[key] === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(cfg[key])),
      ),
    'TARGET_MISMATCH',
  );
  const { parseSharedState } = require('librechat-data-provider');
  const shared = parseSharedState(env);
  requireValue(shared.mode === 'sentinel', 'TARGET_MISMATCH');
  requireValue(!(env.REDIS_KEY_PREFIX_VAR && env.REDIS_KEY_PREFIX), 'TARGET_MISMATCH');
  const prefix = (env[env.REDIS_KEY_PREFIX_VAR ?? ''] || env.REDIS_KEY_PREFIX || '') + '::';
  requireValue(
    shared.name === target.coordination.sentinelName &&
      target.coordination.database === 0 &&
      target.coordination.keyPrefix === prefix,
    'TARGET_MISMATCH',
  );
  requireValue(typeof env.MONGO_URI === 'string' && env.MONGO_URI.length > 0, 'UNAVAILABLE');
  const mongoose = require('mongoose');
  const { createModels, createUploadManagementRepository } = require('@librechat/data-schemas');
  const {
    RedisJobStore,
    resolveCheckpointerConfig,
    inspectInitialCheckpointPopulation,
  } = require('@librechat/api/upload-activation');
  const currentConfig = resolveCheckpointerConfig(cfg);
  const configurationSha256 = digest(currentConfig);
  let redis;
  let closing;
  let store;
  const ignoreError = () => {};
  mongoose.connection.on('error', ignoreError);
  const close = () => {
    if (!closing)
      closing = (async () => {
        signal.removeEventListener('abort', abort);
        let ended;
        const redisClosed =
          !redis || redis.status === 'end'
            ? Promise.resolve()
            : new Promise((resolve) => {
                ended = resolve;
                redis.once('end', ended);
                redis.disconnect(false);
              });
        const closed = Promise.all([redisClosed, mongoose.connection.close(true)]);
        try {
          await new Promise((resolve, reject) => {
            const timeout = setTimeout(
              () => reject(failure('UNAVAILABLE')),
              Math.max(1, Math.min(2000, deadline - Date.now())),
            );
            closed.then(resolve, reject).finally(() => clearTimeout(timeout));
          });
        } finally {
          if (ended) redis.off('end', ended);
          mongoose.connection.off('error', ignoreError);
        }
      })();
    return closing;
  };
  const abort = () => {
    void close().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  const remaining = () => {
    requireValue(!signal.aborted && Date.now() < deadline, 'EXPIRED');
    return Math.max(1, Math.min(2000, deadline - Date.now()));
  };
  try {
    const bound = remaining();
    mongoose.set('strictQuery', true);
    await mongoose.connect(env.MONGO_URI, {
      maxPoolSize: 2,
      minPoolSize: 0,
      maxConnecting: 1,
      serverSelectionTimeoutMS: bound,
      connectTimeoutMS: bound,
      socketTimeoutMS: bound,
      waitQueueTimeoutMS: bound,
      autoIndex: false,
      autoCreate: false,
      bufferCommands: false,
    });
    remaining();
    const hello = await mongoose.connection.db
      .admin()
      .command({ hello: 1 }, { maxTimeMS: remaining() });
    requireValue(
      hello.setName === target.mongoReplicaSet && mongoose.connection.name === target.mongoDatabase,
      'TARGET_MISMATCH',
    );
    createModels(mongoose);
    const repository = createUploadManagementRepository(mongoose);
    if (!expiredReplay) {
      const Redis = require('ioredis');
      redis = new Redis({
        sentinels: shared.endpoints,
        name: shared.name,
        role: 'master',
        username: shared.username,
        password: shared.password,
        sentinelUsername: shared.sentinelUsername,
        sentinelPassword: shared.sentinelPassword,
        enableTLSForSentinelMode: true,
        tls: { ca: readTrust(shared.caPath), rejectUnauthorized: true },
        sentinelTLS: { ca: readTrust(shared.sentinelCaPath), rejectUnauthorized: true },
        db: 0,
        keyPrefix: prefix,
        lazyConnect: true,
        enableOfflineQueue: false,
        autoResendUnfulfilledCommands: false,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
        sentinelRetryStrategy: () => null,
        connectTimeout: remaining(),
        commandTimeout: remaining(),
      });
      redis.on('error', ignoreError);
      await redis.connect();
      remaining();
      store = new RedisJobStore(redis);
    }
    return {
      target,
      configurationSha256,
      repository,
      close,
      inspectReplay: (options) => {
        requireValue(store, 'UNAVAILABLE');
        return store.inspectInitialSourcePopulation(options);
      },
      inspectCheckpoints: (options) =>
        inspectInitialCheckpointPopulation({ ...options, currentConfig }),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
async function writeResult(output, result) {
  const bytes = canonical(result) + '\n';
  requireValue(Buffer.byteLength(bytes, 'utf8') <= OUTPUT_LIMIT, 'UNAVAILABLE');
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      output.off('error', failed);
      error ? reject(failure('UNAVAILABLE')) : resolve();
    };
    const failed = () => finish(true);
    const timer = setTimeout(failed, 2000);
    output.once('error', failed);
    output.write(bytes, finish);
  });
}
async function main({
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  open,
  now = Date.now,
} = {}) {
  let result;
  let exitCode = 0;
  try {
    const envelope = await readEnvelope(input);
    result = await runActivation(envelope, {
      now,
      storageGateways: env.CORTEX_UPLOAD_ACTIVATION_STORAGE_GATEWAYS,
      open: open ?? ((target, options) => openRuntime(target, options, env)),
    });
  } catch (error) {
    const code = error && ERROR_CODES.has(error.code) ? error.code : 'UNAVAILABLE';
    result = { schema: 1, status: code === 'UNKNOWN_COMMIT' ? 'pending' : 'error', code };
    exitCode = 1;
  }
  await writeResult(output, result);
  return exitCode;
}

module.exports = {
  INPUT_LIMIT,
  readEnvelope,
  validateEnvelope,
  runActivation,
  main,
  canonical,
  digest,
};
if (require.main === module) {
  // Supported logger settings keep this one-shot JSON protocol free of application/file logging.
  process.env.LOG_TO_FILE = 'false';
  process.env.CONSOLE_LOG_LEVEL = 'silent';
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
