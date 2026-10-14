/** Atomic source-only bounds and cleanup evidence inside the existing Redis job owner. */
import { SOURCE_REPLAY_LIMITS as L } from './sourceBudget';

export const SOURCE_REPLAY_INDEX = 'stream:source-replay:v1';

/** Prospective retained hash size; a replacement is counted once, never as append traffic. */
export const SOURCE_HASH_BUDGET_LUA = `
local function sourceHashFits(key, updates, clear, force)
  if not force and redis.call('HEXISTS', key, 'sourceReplayIntent') == 0 then return true end
  local overwritten = {}
  for _, field in ipairs(clear or {}) do overwritten[field] = true end
  local size = #key local count = 0 local incoming = {}
  for i = 1, #updates, 2 do
    incoming[updates[i]] = updates[i+1]
    overwritten[updates[i]] = true
  end
  for field, value in pairs(incoming) do size = size + #field + #value count = count + 1 end
  local fields = redis.call('HKEYS', key)
  if #fields > 512 then return false end
  for _, field in ipairs(fields) do
    if not overwritten[field] then size = size + #field + redis.call('HSTRLEN', key, field) count = count + 1 end
  end
  return count <= 512 and size <= ${L.jobBytes - L.metadataBytes}
end
`;

/** The caller commits these counters only after every other append fence has passed. */
export const SOURCE_CHUNK_BUDGET_LUA = `
local function sourceChunkBudget(job, events)
  if redis.call('HEXISTS', job, 'sourceReplayIntent') == 0 then return true, 0, 0 end
  if redis.call('HGET', job, 'sourceReplayHeld') ~= '1' then return false, 0, 0 end
  local bytes = tonumber(redis.call('HGET', job, 'sourceReplayChunkBytes') or '-1')
  local count = tonumber(redis.call('HGET', job, 'sourceReplayChunkEntries') or '-1')
  if not bytes or bytes < 0 or not count or count < 0 then return false, 0, 0 end
  for _, event in ipairs(events) do
    if #event > ${L.eventBytes} then return false, 0, 0 end
    bytes = bytes + #event + 46
    count = count + 1
  end
  if bytes > ${L.chunkBytes} or count > ${L.chunkEntries} then return false, 0, 0 end
  return true, bytes, count
end
local function commitSourceChunkBudget(job, bytes, count)
  if count > 0 then redis.call('HSET', job, 'sourceReplayChunkBytes', bytes, 'sourceReplayChunkEntries', count) end
end
`;

/** KEYS job,chunks,runsteps,steers,claimed,parked,receipts,index,activityBacklog,
 * activityBytes,activityPublication,subscriberLeases. ARGV intent JSON. */
export const PREPARE_SOURCE_REPLAY_LUA =
  SOURCE_HASH_BUDGET_LUA +
  `
local next = cjson.decode(ARGV[1])
local job = KEYS[1]
if redis.call('HGET', job, 'createdAt') ~= tostring(next.createdAt)
  or redis.call('HGET', job, 'userId') ~= next.userId
  or (redis.call('HGET', job, 'tenantId') or '') ~= (next.tenantId or '')
  or redis.call('HGET', job, 'status') ~= 'running'
  or redis.call('HEXISTS', job, 'sourceRetentionRevokedAt') == 1
  or redis.call('HEXISTS', job, 'sourceRetentionPurged') == 1 then return -1 end
local now = redis.call('TIME')
if next.sourceExpiresAt <= tonumber(now[1])*1000 + math.floor(tonumber(now[2])/1000) then return -1 end
if redis.call('HEXISTS', job, 'scheduleId') == 1
  or redis.call('HEXISTS', job, 'recoveredSteerId') == 1
  or redis.call('HEXISTS', job, 'eventActorInvocationId') == 1
  or redis.call('HEXISTS', job, 'agentEventDeliveryKey') == 1
  or redis.call('HGET', job, 'preserveForScheduleReconcile') == '1'
  or redis.call('HGET', job, 'terminalHostActionPending') == '1' then return -3 end
for i = 4, 7 do if redis.call('EXISTS', KEYS[i]) == 1 then return -3 end end
for i = 9, 11 do if redis.call('EXISTS', KEYS[i]) == 1 then return -3 end end
if redis.call('ZCARD', KEYS[12]) > 64 then return -2 end
for _,member in ipairs(redis.call('ZRANGE', KEYS[12], 0, -1)) do if #member > 128 then return -2 end end
local previous = redis.call('HGET', job, 'sourceReplayIntent')
local held = redis.call('HGET', job, 'sourceReplayHeld') or '0'
local bytes = redis.call('HGET', job, 'sourceReplayChunkBytes') or tostring(#KEYS[2])
local entries = redis.call('HGET', job, 'sourceReplayChunkEntries') or '0'
if previous then
  local prior = cjson.decode(previous)
  if prior.receipt.reservationId ~= next.receipt.reservationId then return -1 end
  next.receipt = prior.receipt
  next.sourceExpiresAt = math.min(next.sourceExpiresAt, prior.sourceExpiresAt)
  local ids = {} local merged = {}
  for _, id in ipairs(prior.sourceFileIds) do ids[id] = true end
  for _, id in ipairs(next.sourceFileIds) do ids[id] = true end
  for id in pairs(ids) do merged[#merged+1] = id end
  if #merged > 64 then return -2 end
  table.sort(merged) next.sourceFileIds = merged
else
  -- SDK run metadata may precede the first model admission callback. Adopt
  -- exactly this bounded prefix in the same intent transaction, before Mongo.
  if redis.call('XLEN', KEYS[2]) > ${L.bootstrapEntries} then return -2 end
  if redis.call('EXISTS', KEYS[2]) == 1 and #redis.call('XINFO', 'GROUPS', KEYS[2]) > 0 then return -3 end
  local rows = redis.call('XRANGE', KEYS[2], '-', '+', 'COUNT', ${L.bootstrapEntries})
  bytes = #KEYS[2] entries = #rows
  for _,row in ipairs(rows) do
    if #row[2] ~= 2 or row[2][1] ~= 'event' then return -3 end
    bytes = bytes + #row[1] + #row[2][1] + #row[2][2]
    if bytes > ${L.bootstrapBytes} then return -2 end
  end
  local runBytes = 0
  if redis.call('EXISTS', KEYS[3]) == 1 then runBytes = #KEYS[3] + redis.call('STRLEN', KEYS[3]) end
  if bytes + runBytes > ${L.bootstrapBytes} then return -2 end
  bytes = tostring(bytes) entries = tostring(entries)
end
if redis.call('HEXISTS', KEYS[8], next.receipt.reservationId) == 0
  and redis.call('HLEN', KEYS[8]) >= ${L.epochs} then return -2 end
local encoded = cjson.encode(next)
if #encoded > ${L.intentBytes} then return -2 end
local source = cjson.encode({sourceFileIds=next.sourceFileIds, sourceExpiresAt=next.sourceExpiresAt})
local fields = {'sourceReplayIntent',encoded,'sourceReplayHeld',held,
  'sourceReplayChunkBytes',bytes,'sourceReplayChunkEntries',entries,
  'sourceRetention',source,'sourceRetentionExpiresAt',tostring(next.sourceExpiresAt)}
if not sourceHashFits(job, fields, {}, true) then return -2 end
redis.call('HSET', KEYS[8], next.receipt.reservationId, encoded)
redis.call('HSET', job, unpack(fields))
redis.call('PERSIST', job)
return encoded
`;

/** KEYS job,index. ARGV expected intent JSON. Only a durable File reserve permits writes. */
export const COMMIT_SOURCE_REPLAY_LUA = `
local next = cjson.decode(ARGV[1])
local raw = redis.call('HGET', KEYS[1], 'sourceReplayIntent')
if not raw or redis.call('HGET', KEYS[1], 'createdAt') ~= tostring(next.createdAt)
  or redis.call('HGET', KEYS[1], 'status') ~= 'running'
  or redis.call('HEXISTS', KEYS[1], 'sourceRetentionRevokedAt') == 1
  or redis.call('HEXISTS', KEYS[1], 'sourceRetentionPurged') == 1 then return 0 end
local held = cjson.decode(raw)
local now = redis.call('TIME')
if held.receipt.reservationId ~= next.receipt.reservationId
  or held.receipt.fileId ~= next.receipt.fileId
  or held.receipt.bytes ~= next.receipt.bytes
  or held.sourceExpiresAt <= tonumber(now[1])*1000 + math.floor(tonumber(now[2])/1000)
  or redis.call('HEXISTS', KEYS[2], held.receipt.reservationId) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'sourceReplayHeld', '1')
return 1
`;

/** Called only after File's majority-committed idempotent refund/cancellation returns. */
export const ACK_SOURCE_REPLAY_LUA = `
local intent = cjson.decode(ARGV[1])
if redis.call('HGET', KEYS[1], 'createdAt') ~= tostring(intent.createdAt)
  or redis.call('HGET', KEYS[1], 'userId') ~= intent.userId
  or (redis.call('HGET', KEYS[1], 'tenantId') or '') ~= (intent.tenantId or '')
  or redis.call('HGET', KEYS[1], 'sourceRetentionPurged') ~= '1'
  or redis.call('HGET', KEYS[1], 'providerDrained') ~= '1'
  or redis.call('HGET', KEYS[1], 'terminalPersistencePending') == '1'
  or redis.call('HGET', KEYS[1], 'terminalHostActionPending') == '1' then return 0 end
local status = redis.call('HGET', KEYS[1], 'status')
if status ~= 'error' and status ~= 'complete' and status ~= 'aborted' then return 0 end
local raw = redis.call('HGET', KEYS[1], 'sourceReplayIntent')
if raw and cjson.decode(raw).receipt.reservationId ~= intent.receipt.reservationId then return 0 end
redis.call('HDEL', KEYS[2], intent.receipt.reservationId)
redis.call('HDEL', KEYS[1], 'sourceReplayIntent', 'sourceReplayHeld', 'sourceReplayChunkBytes', 'sourceReplayChunkEntries')
local ttl = tonumber(ARGV[2])
if ttl > 0 then redis.call('EXPIRE', KEYS[1], ttl) else redis.call('DEL', KEYS[1]) end
return 1
`;
