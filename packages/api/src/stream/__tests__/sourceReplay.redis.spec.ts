/** Actual Lua evidence uses only a primary-owned disposable Unix-socket Redis fixture. */
/* eslint jest/expect-expect: ["warn", { "assertFunctionNames": ["expect", "exerciseSourceMetadataPrefix", "exercisePreboundSourceFailure"] }] */
// These imported sequence helpers assert quota custody, retained payloads and joined cleanup.
import Redis from 'ioredis';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  exerciseSourceMetadataPrefix,
  exercisePreboundSourceFailure,
} from './sourceReplaySequence.helper';
import { createSourceReplayIntent, SOURCE_REPLAY_LIMITS } from '../internal/sourceBudget';
import { RedisJobStore } from '../implementations/RedisJobStore';

jest.mock('~/cache/redisTelemetry', () => ({
  RedisUseCases: { GENERATION_STREAM: 'generation_stream' },
  instrumentIORedisClient: (client: unknown) => client,
}));

const socket = process.env.UPLOAD_REPLAY_TEST_REDIS_SOCKET;
const suite = socket ? describe : describe.skip;
suite('source replay actual Redis mutations', () => {
  let redis: Redis;
  let store: RedisJobStore;
  const prefix = `source-replay-test:${randomUUID()}:`;
  beforeAll(async () => {
    if (!socket || !isAbsolute(socket))
      throw new Error('An absolute disposable Unix socket is required');
    redis = new Redis({
      path: socket,
      keyPrefix: prefix,
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      connectTimeout: 1000,
    });
    await redis.connect();
    store = new RedisJobStore(redis);
  });
  afterAll(async () => {
    // This fixture is disposable and private to this suite. Never delete a fleet key.
    if (redis) {
      const keys = await redis.keys(`${prefix}*`);
      if (keys.length)
        await redis.eval(
          "return redis.call('DEL', unpack(KEYS))",
          keys.length,
          ...keys.map((key) => key.slice(prefix.length)),
        );
      redis.disconnect();
    }
  });

  async function create() {
    const stream = randomUUID();
    const job = await store.createJob(stream, 'user', undefined, 'tenant', {
      providerExecutionId: 'segment',
    });
    return { job, intent: createSourceReplayIntent(job, ['file'], Date.now() + 60_000) };
  }

  it('retains the exact intent across terminal TTL and refuses hash overwrite', async () => {
    const { job, intent } = await create();
    await store.prepareSourceReplay(intent);
    await store.commitSourceReplay(intent);
    await store.updateJob(
      job.streamId,
      { status: 'error', completedAt: Date.now(), providerDrained: true },
      job.createdAt,
    );
    expect(await redis.ttl(`stream:{${job.streamId}}:job`)).toBe(-1);
    await expect(store.createJob(job.streamId, 'user')).rejects.toMatchObject({
      code: 'document_source_unavailable',
    });
    expect(await store.purgeSourceRetention(job.streamId, job.createdAt)).toBe(true);
    expect(await store.acknowledgeSourceReplayRelease(intent)).toBe(true);
  });

  it('rejects oversized updates and events before changing any retained payload', async () => {
    const { job, intent } = await create();
    await store.prepareSourceReplay(intent);
    await store.commitSourceReplay(intent);
    await expect(
      store.updateJob(
        job.streamId,
        { error: 'x'.repeat(SOURCE_REPLAY_LIMITS.jobBytes) },
        job.createdAt,
      ),
    ).rejects.toBeDefined();
    expect((await store.getJob(job.streamId))?.error).toBeUndefined();
    expect(
      await store.appendChunk(
        job.streamId,
        { event: 'text', data: 'x'.repeat(SOURCE_REPLAY_LIMITS.eventBytes) },
        job.createdAt,
      ),
    ).toBe(false);
    expect(await redis.xlen(`stream:{${job.streamId}}:chunks`)).toBe(0);
    await store.updateJob(job.streamId, { status: 'error', providerDrained: true }, job.createdAt);
    await store.purgeSourceRetention(job.streamId, job.createdAt);
    await store.acknowledgeSourceReplayRelease(intent);
  });

  it('adopts exact existing key, stream ID, field and value bytes without rewriting the prefix', async () => {
    const { job, intent } = await create();
    const key = `stream:{${job.streamId}}:chunks`;
    const event = JSON.stringify({ event: 'on_run_step', data: { id: 'step', label: 'ä' } });
    const id = await redis.xadd(key, '*', 'event', event);
    await store.prepareSourceReplay(intent);
    expect((await store.getJob(job.streamId))?.sourceReplayChunkBytes).toBe(
      Buffer.byteLength(prefix + key) + Buffer.byteLength(id! + 'event' + event),
    );
    expect(await redis.xlen(key)).toBe(1);
    await store.updateJob(job.streamId, { status: 'error', providerDrained: true }, job.createdAt);
    await store.purgeSourceRetention(job.streamId, job.createdAt);
    await store.acknowledgeSourceReplayRelease(intent);
  });

  it('rejects oversized bootstrap payload without changing the job, prefix or intent index', async () => {
    const { job, intent } = await create();
    const key = `stream:{${job.streamId}}:chunks`;
    await redis.xadd(key, '*', 'event', 'x'.repeat(SOURCE_REPLAY_LIMITS.bootstrapBytes));
    const before = await redis.hgetall(`stream:{${job.streamId}}:job`);
    await expect(store.prepareSourceReplay(intent)).rejects.toMatchObject({
      code: 'document_capacity_exceeded',
    });
    expect(await redis.hgetall(`stream:{${job.streamId}}:job`)).toEqual(before);
    expect(await redis.xlen(key)).toBe(1);
    expect(await store.listSourceReplayIntents()).toEqual([]);
    await store.deleteJob(job.streamId, job.createdAt);
  });

  it('runs the actual manager metadata-before-bind sequence against Redis and refunds its joined error', async () => {
    await exerciseSourceMetadataPrefix(store, true);
    store = new RedisJobStore(redis);
  });

  it('never persists prebound initial text before quota and retries unknown cancellation through existing cleanup', async () => {
    await exercisePreboundSourceFailure(store, true);
    store = new RedisJobStore(redis);
  });

  it('admits exactly32 simultaneous unresolved source epochs under one Redis authority', async () => {
    const jobs = await Promise.all(Array.from({ length: 33 }, create));
    const results = await Promise.allSettled(
      jobs.map(({ intent }) => store.prepareSourceReplay(intent)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(32);
    expect(await store.listSourceReplayIntents()).toHaveLength(32);
  });
});
