/** Finite internal admission control. The existing UploadCounter repository owns all policy writes. */
'use strict';

const { TextDecoder } = require('node:util');

const LIMIT = 16 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DOMAIN_CODES = new Set(['invalid_request', 'not_ready', 'unavailable', 'migration_conflict']);
const LOCAL_CODES = new Set([
  'INVALID_INPUT',
  'INPUT_TIMEOUT',
  'TARGET_MISMATCH',
  'EXPIRED',
  'UNAVAILABLE',
  'UNKNOWN_COMMIT',
]);

function failure(code) {
  return Object.assign(new Error(code), { name: 'UploadAdmissionCommandError', code });
}
function requireValue(condition, code = 'INVALID_INPUT') {
  if (!condition) throw failure(code);
}
function shape(value, keys) {
  requireValue(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)),
  );
}
function timestamp(value) {
  requireValue(typeof value === 'string' && value.length === 24);
  const result = Date.parse(value);
  requireValue(Number.isSafeInteger(result) && new Date(result).toISOString() === value);
  return result;
}
function targetOf(value) {
  shape(value, ['mongoReplicaSet', 'mongoDatabase']);
  const { mongoReplicaSet, mongoDatabase } = value;
  requireValue(
    typeof mongoReplicaSet === 'string' &&
      NAME.test(mongoReplicaSet) &&
      typeof mongoDatabase === 'string' &&
      /^[A-Za-z0-9_-]{1,63}$/.test(mongoDatabase),
  );
  return Object.freeze({ mongoReplicaSet, mongoDatabase });
}
function sameTarget(a, b) {
  return a.mongoReplicaSet === b.mongoReplicaSet && a.mongoDatabase === b.mongoDatabase;
}
function policyOf(value) {
  try {
    shape(value, ['storeId', 'revision', 'paused']);
    const { storeId, revision, paused } = value;
    requireValue(
      typeof storeId === 'string' &&
        NAME.test(storeId) &&
        Number.isSafeInteger(revision) &&
        revision >= 0 &&
        typeof paused === 'boolean',
    );
    return { storeId, revision, paused };
  } catch {
    throw failure('UNAVAILABLE');
  }
}

/** Copy the closed public request before awaiting any external work. No caller clock is accepted. */
function validateEnvelope(value, now) {
  requireValue(Number.isSafeInteger(now) && now >= 0);
  const action = value?.action;
  requireValue(action === 'status' || action === 'set');
  shape(
    value,
    action === 'set' ? ['schema', 'action', 'target', 'command'] : ['schema', 'action', 'target'],
  );
  requireValue(value.schema === 1);
  const target = targetOf(value.target);
  if (action === 'status') return Object.freeze({ schema: 1, action, target });
  shape(value.command, ['storeId', 'expectedRevision', 'paused', 'originalDeadline']);
  const { storeId, expectedRevision, paused, originalDeadline } = value.command;
  requireValue(
    typeof storeId === 'string' &&
      NAME.test(storeId) &&
      Number.isSafeInteger(expectedRevision) &&
      expectedRevision >= 0 &&
      expectedRevision < Number.MAX_SAFE_INTEGER &&
      typeof paused === 'boolean',
  );
  requireValue(timestamp(originalDeadline) - now <= 300_000);
  const command = Object.freeze({ storeId, expectedRevision, paused, originalDeadline });
  return Object.freeze({ schema: 1, action, target, command });
}

function decode(bytes) {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
    return value;
  } catch {
    throw failure('INVALID_INPUT');
  }
}
function readEnvelope(input) {
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
      if (size > LIMIT) finish(failure('INVALID_INPUT'));
      else chunks.push(bytes);
    };
    const end = () => {
      try {
        finish(undefined, decode(Buffer.concat(chunks, size)));
      } catch (error) {
        finish(error);
      }
    };
    const failed = () => finish(failure('INVALID_INPUT'));
    const closed = () => {
      if (!input.readableEnded) failed();
    };
    const timer = setTimeout(() => finish(failure('INPUT_TIMEOUT')), 5000);
    input.on('data', data);
    input.once('end', end);
    input.once('error', failed);
    input.once('close', closed);
  });
}

function deadlineOf(request, started, now) {
  if (request.action === 'status') return { deadline: started + 30_000, expiredReplay: false };
  const original = timestamp(request.command.originalDeadline);
  const expiredReplay = original <= now;
  return {
    deadline: expiredReplay ? started + 15_000 : Math.min(original, started + 30_000),
    expiredReplay,
  };
}
function whileLive(promise, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const aborted = () => finish(reject, failure('EXPIRED'));
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', aborted);
      callback(value);
    };
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
    if (signal.aborted) aborted();
  });
}
function boundedClose(close, milliseconds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(failure('UNAVAILABLE')), Math.max(1, milliseconds));
    Promise.resolve()
      .then(close)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}
function domainError(error) {
  return error?.name === 'UploadManagementError' && DOMAIN_CODES.has(error.code);
}
function publicCode(error) {
  if (domainError(error)) return error.code;
  if (
    error?.name === 'UploadAdmissionCommandError' &&
    (LOCAL_CODES.has(error.code) || DOMAIN_CODES.has(error.code))
  )
    return error.code;
  return 'UNAVAILABLE';
}

/** One finite invocation; transport expiry is never evidence that a dispatched mutation rolled back. */
async function runAdmission(value, ports = {}) {
  const now = ports.now ?? Date.now;
  const entered = now();
  const request = validateEnvelope(value, entered);
  const started = ports.invocationStart ?? entered;
  requireValue(Number.isSafeInteger(started) && started >= 0 && started <= entered);
  const { deadline, expiredReplay } = deadlineOf(request, started, entered);
  requireValue(typeof ports.open === 'function', 'UNAVAILABLE');
  requireValue(entered < deadline - 2000, 'EXPIRED');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadline - entered - 2000);
  const live = () => requireValue(!controller.signal.aborted && now() < deadline - 2000, 'EXPIRED');
  let runtime;
  let opening;
  let dispatched = false;
  let result;
  let error;
  try {
    opening = Promise.resolve(
      ports.open(request.target, { deadline, expiredReplay, signal: controller.signal }),
    );
    runtime = await whileLive(opening, controller.signal);
    live();
    requireValue(sameTarget(targetOf(runtime.target), request.target), 'TARGET_MISMATCH');
    const method =
      request.action === 'set'
        ? runtime.repository?.setAdmissionPolicy
        : runtime.repository?.getAdmissionPolicy;
    requireValue(
      typeof method === 'function' && typeof runtime.close === 'function',
      'UNAVAILABLE',
    );
    live();
    let pending;
    if (request.action === 'set') {
      dispatched = true;
      pending = method.call(runtime.repository, request.command);
    } else pending = method.call(runtime.repository);
    const policy = policyOf(await whileLive(pending, controller.signal));
    live();
    if (request.action === 'set') {
      requireValue(
        policy.storeId === request.command.storeId &&
          policy.revision === request.command.expectedRevision + 1 &&
          policy.paused === request.command.paused,
        'UNAVAILABLE',
      );
    }
    result = {
      schema: 1,
      action: request.action,
      policy,
      observedAt: new Date(now()).toISOString(),
    };
  } catch (caught) {
    error = failure(dispatched && !domainError(caught) ? 'UNKNOWN_COMMIT' : publicCode(caught));
  } finally {
    clearTimeout(timer);
    // The concrete adapter observes abort even while connect/hello is pending.
    controller.abort();
    try {
      const close = runtime
        ? () => runtime.close()
        : async () => {
            const late = await opening?.catch(() => undefined);
            if (late) await late.close();
          };
      await boundedClose(close, Math.min(2000, deadline - now()));
      requireValue(now() <= deadline, 'EXPIRED');
    } catch {
      error = failure(dispatched ? 'UNKNOWN_COMMIT' : 'UNAVAILABLE');
    }
  }
  if (error) throw error;
  return result;
}

/** Own only this Mongo client. The independent native target must match actual connected topology. */
async function openRuntime(expected, { deadline, signal }, env) {
  let target;
  try {
    requireValue(typeof env.CORTEX_UPLOAD_ADMISSION_TARGET === 'string');
    requireValue(Buffer.byteLength(env.CORTEX_UPLOAD_ADMISSION_TARGET, 'utf8') <= LIMIT);
    target = targetOf(decode(Buffer.from(env.CORTEX_UPLOAD_ADMISSION_TARGET, 'utf8')));
    requireValue(sameTarget(target, targetOf(expected)));
  } catch {
    throw failure('TARGET_MISMATCH');
  }
  requireValue(
    typeof env.MONGO_URI === 'string' && env.MONGO_URI.length > 0 && env.MONGO_URI.length <= LIMIT,
    'UNAVAILABLE',
  );
  requireValue(!signal.aborted && Date.now() < deadline - 2000, 'EXPIRED');
  const { Mongoose } = require('mongoose');
  const mongoose = new Mongoose();
  let closing;
  const ignored = () => {};
  mongoose.connection.on('error', ignored);
  const close = () => {
    if (!closing) {
      signal.removeEventListener('abort', abort);
      closing = boundedClose(
        () => mongoose.connection.close(true),
        Math.min(2000, deadline - Date.now()),
      ).finally(() => mongoose.connection.off('error', ignored));
    }
    return closing;
  };
  const abort = () => {
    void close().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  const remaining = () => {
    requireValue(!signal.aborted && Date.now() < deadline - 2000, 'EXPIRED');
    return Math.max(1, Math.min(2000, deadline - Date.now() - 2000));
  };
  try {
    const bound = remaining();
    mongoose.set('strictQuery', true);
    await whileLive(
      mongoose.connect(env.MONGO_URI, {
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
      }),
      signal,
    );
    remaining();
    const hello = await whileLive(
      mongoose.connection.db.admin().command({ hello: 1 }, { maxTimeMS: remaining() }),
      signal,
    );
    requireValue(
      hello.setName === target.mongoReplicaSet && mongoose.connection.name === target.mongoDatabase,
      'TARGET_MISMATCH',
    );
    remaining();
    const { createModels, createUploadManagementRepository } = require('@librechat/data-schemas');
    createModels(mongoose);
    const repository = createUploadManagementRepository(mongoose);
    return { target, repository, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function writeResult(output, result, milliseconds) {
  const text = JSON.stringify(result) + '\n';
  requireValue(Buffer.byteLength(text, 'utf8') <= LIMIT, 'UNAVAILABLE');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      output.off('error', failed);
      error ? reject(failure('UNAVAILABLE')) : resolve();
    };
    const failed = () => finish(true);
    const timer = setTimeout(failed, Math.max(1, Math.min(2000, milliseconds)));
    output.once('error', failed);
    try {
      output.write(text, finish);
    } catch {
      finish(true);
    }
  });
}
async function main({
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  open,
  now = Date.now,
} = {}) {
  const invocationStart = now();
  let deadline = invocationStart + 30_000;
  let result;
  let exitCode = 0;
  try {
    const request = validateEnvelope(await readEnvelope(input), now());
    deadline = deadlineOf(request, invocationStart, now()).deadline;
    result = await runAdmission(request, {
      now,
      invocationStart,
      open: open ?? ((target, options) => openRuntime(target, options, env)),
    });
  } catch (error) {
    const code = publicCode(error);
    result = { schema: 1, status: code === 'UNKNOWN_COMMIT' ? 'pending' : 'error', code };
    exitCode = 1;
  }
  await writeResult(output, result, deadline - now());
  return exitCode;
}

module.exports = { readEnvelope, validateEnvelope, runAdmission, openRuntime, main };
if (require.main === module) {
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
