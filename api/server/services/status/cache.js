const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const LIMITS = Object.freeze({
  overallMs: 5000,
  observerMs: 2000,
  cacheMs: 30000,
  observerBytes: 2 * 1024 * 1024,
  dtoBytes: 512 * 1024,
  measurements: 2048,
  waiters: 64,
});
const KEYS = [
  '{cortex-status-v1}:snapshot',
  '{cortex-status-v1}:lease',
  '{cortex-status-v1}:waiters',
];
// All three keys share the existing Redis client's hash slot and namespace prefix.
const CLAIM = `-- cortex-status-claim-v1
local time=redis.call('TIME'); local now=time[1]*1000+math.floor(time[2]/1000)
redis.call('ZREMRANGEBYSCORE',KEYS[3],'-inf',now)
local cached=redis.call('GET',KEYS[1]); if cached then return {'cached',cached} end
if not redis.call('ZSCORE',KEYS[3],ARGV[1]) and redis.call('ZCARD',KEYS[3])>=64 then return {'busy'} end
redis.call('ZADD',KEYS[3],now+5000,ARGV[1]); redis.call('PEXPIRE',KEYS[3],5000)
if redis.call('SET',KEYS[2],ARGV[1],'NX','PX',5000) then return {'leader'} end
return {'wait'}
`;
const PUBLISH = `-- cortex-status-publish-v1
if redis.call('GET',KEYS[2])~=ARGV[1] then return 0 end
if string.len(ARGV[2])>524352 then return 0 end
local witness=tonumber(ARGV[3]); if not witness or witness<0 or witness~=math.floor(witness) then return 0 end
local envelope=cjson.decode(ARGV[2])
if (witness==0 and envelope.validUntilMs~=cjson.null) or (witness>0 and envelope.validUntilMs~=witness) then return 0 end
local time=redis.call('TIME'); local now=time[1]*1000+math.floor(time[2]/1000)
if witness>0 and witness<=now then return -1 end
local expires=now+30000; if witness>0 then expires=math.min(expires,witness) end
redis.call('SET',KEYS[1],ARGV[2],'PXAT',expires); redis.call('DEL',KEYS[2]); return 1
`;
const RELEASE = `-- cortex-status-release-v1
redis.call('ZREM',KEYS[3],ARGV[1])
if redis.call('GET',KEYS[2])==ARGV[1] then redis.call('DEL',KEYS[2]) end
return 1
`;
function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
function assertWitness(validUntilMs) {
  if (validUntilMs === null) return;
  if (!Number.isSafeInteger(validUntilMs) || validUntilMs < 1)
    throw failure('STATUS_CACHE_INVALID');
  if (Date.now() >= validUntilMs) throw failure('STATUS_HEALTH_STALE');
}
function checkedEnvelope(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > LIMITS.dtoBytes + 64)
    throw failure('STATUS_CACHE_INVALID');
  const envelope = JSON.parse(raw);
  if (envelope.ok !== true || !envelope.value || typeof envelope.value !== 'object')
    throw failure('STATUS_UNAVAILABLE');
  const value = JSON.stringify(envelope.value);
  if (Buffer.byteLength(value) > LIMITS.dtoBytes) throw failure('STATUS_TOO_LARGE');
  assertWitness(envelope.validUntilMs);
  return { body: value, validUntilMs: envelope.validUntilMs };
}
async function bounded(promise, signal) {
  signal.throwIfAborted();
  let abort;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        abort = () => reject(signal.reason ?? failure('STATUS_ABORTED'));
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

/** Shared Redis lease is the sole refresh authority. Missing shared state never falls back locally. */
function createStatusCache({ client, load, record = () => {} }) {
  const ready = () => {
    if (
      !client ||
      client.status !== 'ready' ||
      client.options?.enableOfflineQueue !== false ||
      client.options?.autoResendUnfulfilledCommands !== false
    )
      throw failure('STATUS_SHARED_STATE_UNAVAILABLE');
  };
  async function refresh(requestSignal, deadline) {
    const started = performance.now();
    const token = randomUUID();
    const signal = requestSignal ? AbortSignal.any([requestSignal, deadline]) : deadline;
    let result = 'failure';
    let claimed = false;
    const command = async (script, ...args) => {
      ready();
      signal.throwIfAborted();
      return bounded(client.eval(script, 3, ...KEYS, token, ...args), signal);
    };
    try {
      for (;;) {
        const reply = await command(CLAIM);
        claimed = true;
        if (reply[0] === 'cached') {
          const value = checkedEnvelope(reply[1]);
          result = 'cached';
          return value;
        }
        if (reply[0] === 'busy') throw failure('STATUS_BUSY');
        if (reply[0] === 'leader') {
          try {
            const loaded = await bounded(
              Promise.resolve().then(() => load(signal)),
              signal,
            );
            const value = typeof loaded === 'string' ? loaded : loaded?.body;
            signal.throwIfAborted();
            if (typeof value !== 'string' || Buffer.byteLength(value) > LIMITS.dtoBytes)
              throw failure('STATUS_TOO_LARGE');
            const validUntilMs =
              typeof loaded === 'string' || loaded.validUntil === null
                ? null
                : Math.floor(loaded.validUntil * 1000);
            assertWitness(validUntilMs);
            const envelope = JSON.stringify({ ok: true, value: JSON.parse(value), validUntilMs });
            const published = await command(PUBLISH, envelope, validUntilMs ?? 0);
            if (published === -1) throw failure('STATUS_HEALTH_STALE');
            if (published !== 1) throw failure('STATUS_LEASE_LOST');
            const resultValue = checkedEnvelope(envelope);
            result = 'refreshed';
            return resultValue;
          } catch (error) {
            // One bounded negative cache prevents a failed fleet query from becoming a waiter retry storm.
            if (!signal.aborted)
              await command(PUBLISH, JSON.stringify({ ok: false, validUntilMs: null }), 0).catch(
                () => {},
              );
            throw error;
          }
        }
        if (reply[0] !== 'wait') throw failure('STATUS_CACHE_INVALID');
        await delay(100, undefined, { signal });
      }
    } catch (error) {
      if (signal.aborted) result = requestSignal?.aborted ? 'aborted' : 'timeout';
      else if (error.code === 'STATUS_BUSY') result = 'busy';
      throw error;
    } finally {
      // TTL is an independent final backstop. Release cannot extend the original request deadline.
      if (claimed && client?.status === 'ready' && !deadline.aborted) {
        await bounded(client.eval(RELEASE, 3, ...KEYS, token), deadline).catch(() => {});
      }
      record('snapshot', result, (performance.now() - started) / 1000);
    }
  }
  return async function snapshot(requestSignal) {
    const deadline = AbortSignal.timeout(LIMITS.overallMs);
    const result = await refresh(requestSignal, deadline);
    deadline.throwIfAborted();
    requestSignal?.throwIfAborted();
    // The release in refresh's finally may itself be delayed: check after it has settled.
    assertWitness(result.validUntilMs);
    return result;
  };
}
module.exports = {
  createStatusCache,
  LIMITS,
  CLAIM,
  PUBLISH,
  RELEASE,
  checkedEnvelope,
  assertWitness,
};
