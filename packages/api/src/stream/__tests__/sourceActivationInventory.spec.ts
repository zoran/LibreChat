import type { Redis } from 'ioredis';
import type { SerializableJobData } from '../interfaces/IJobStore';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';
import { RedisJobStore } from '../implementations/RedisJobStore';

jest.mock('~/cache/redisTelemetry', () => ({
  RedisUseCases: { GENERATION_STREAM: 'generation_stream' },
  instrumentIORedisClient: (client: unknown) => client,
}));

const options = () => ({
  originalDeadline: new Date(Date.now() + 60_000).toISOString(),
  targetBindingSha256: 'a'.repeat(64),
});
const legacy = (source = false): SerializableJobData => ({
  streamId: 'private-legacy-stream',
  userId: 'private-user',
  tenantId: 'tenant',
  createdAt: 1,
  status: 'complete',
  syncSent: false,
  userMessage: { messageId: 'message', text: 'private body' },
  ...(source && { sourceRetention: { sourceFileIds: ['private-file'], sourceExpiresAt: 2 } }),
});

function jobs(store: InMemoryJobStore): Map<string, SerializableJobData> {
  return (store as unknown as { jobs: Map<string, SerializableJobData> }).jobs;
}

function redisFixture(rows: Record<string, string[]> = {}) {
  const redis = {
    options: { keyPrefix: '', commandTimeout: 2000 },
    isCluster: false,
    eval: jest.fn(async (_script: string, keys: number, ...args: Array<string | number>) => {
      if (keys === 0) return ['0', Object.keys(rows).filter((key) => key.startsWith('stream:{'))];
      return rows[String(args[0])] ?? ['none'];
    }),
  };
  return { redis, store: new RedisJobStore(redis as unknown as Redis) };
}

describe('finite initial source population at the existing stream owner', () => {
  it('finds an expired legacy source job even when the new replay intent index is empty', async () => {
    const store = new InMemoryJobStore();
    const row = legacy(true);
    jobs(store).set(row.streamId, row);
    expect(await store.listSourceReplayIntents()).toEqual([]);
    const before = structuredClone(row);
    const result = await store.inspectInitialSourcePopulation(options());
    expect(result).toMatchObject({
      complete: true,
      adapter: 'memory',
      saturatedCounts: { sourceJobs: 1, replayIntents: 0, recoveryCopies: 0 },
    });
    expect(jobs(store).get(row.streamId)).toEqual(before);
    expect(JSON.stringify(result)).not.toMatch(/private-(legacy-stream|user|file)|private body/);
    expect(result.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('allows bounded ordinary source-free jobs without starting cleanup or rewriting them', async () => {
    const store = new InMemoryJobStore();
    const row = legacy();
    jobs(store).set(row.streamId, row);
    const result = await store.inspectInitialSourcePopulation(options());
    expect(result).toMatchObject({
      schema: 1,
      owner: 'generation-stream',
      complete: true,
      saturatedCounts: { sourceJobs: 0, replayIntents: 0, recoveryCopies: 0 },
    });
    expect((store as unknown as { cleanupInterval: unknown }).cleanupInterval).toBeNull();
    expect(jobs(store).get(row.streamId)).toEqual(row);
  });

  it('counts retained source recovery independently of job existence or expiry', async () => {
    const store = new InMemoryJobStore();
    const parked = (
      store as unknown as {
        parkedSteers: Map<string, { payload: string; expiresAt: number }>;
      }
    ).parkedSteers;
    const value = {
      payload: JSON.stringify({
        userId: 'private-owner',
        steers: [
          { userId: 'private-owner', text: 'copied source', files: [{ file_id: 'private-file' }] },
        ],
      }),
      expiresAt: 1,
    };
    parked.set('orphan', value);
    const result = await store.inspectInitialSourcePopulation(options());
    expect(result.saturatedCounts.recoveryCopies).toBe(1);
    expect(parked.get('orphan')).toBe(value);
    expect(JSON.stringify(result)).not.toContain('copied source');
  });

  it('fails incomplete on an expired deadline and excessive retained jobs rather than returning zero', async () => {
    const store = new InMemoryJobStore();
    await expect(
      store.inspectInitialSourcePopulation({
        ...options(),
        originalDeadline: new Date(Date.now() - 1).toISOString(),
      }),
    ).rejects.toThrow(/inventory/i);
    for (let i = 0; i < 4097; i++) jobs(store).set(String(i), { ...legacy(), streamId: String(i) });
    await expect(store.inspectInitialSourcePopulation(options())).rejects.toThrow(/inventory/i);
    expect(jobs(store).size).toBe(4097);
  });

  it('finds source fields outside an empty Redis intent index using only read commands', async () => {
    const { store, redis } = redisFixture({
      'stream:{private-legacy-stream}:job': [
        'hash',
        'streamId',
        'private-legacy-stream',
        'userId',
        'private-user',
        'createdAt',
        '1',
        'status',
        'complete',
        'sourceRetention',
        JSON.stringify(legacy(true).sourceRetention),
      ],
    });
    const result = await store.inspectInitialSourcePopulation(options());
    expect(result).toMatchObject({
      adapter: 'redis',
      complete: true,
      saturatedCounts: { sourceJobs: 1, replayIntents: 0, recoveryCopies: 0 },
    });
    expect(JSON.stringify(result)).not.toContain('private-');
    const commands = redis.eval.mock.calls.flatMap(([script]) =>
      [...script.matchAll(/redis\.call\(['"]([A-Z]+)['"]/g)].map((match) => match[1]),
    );
    expect(commands.length).toBeGreaterThan(0);
    const allowed = new Set([
      'SCAN',
      'TYPE',
      'HLEN',
      'HKEYS',
      'HSTRLEN',
      'HGET',
      'STRLEN',
      'GET',
      'LLEN',
      'LINDEX',
      'XLEN',
      'XRANGE',
      'EXISTS',
    ]);
    expect(commands.every((command) => allowed.has(command))).toBe(true);
  });

  it('rejects unknown stream suffixes, orphan replay and a nonterminating bounded scan', async () => {
    for (const rows of [
      { 'stream:{orphan}:unknown-future-copy': ['string', '{}'] },
      { 'stream:{orphan}:chunks': ['stream', JSON.stringify({ text: 'unclassified old text' })] },
      {
        'stream:{ordinary}:job': [
          'hash',
          'streamId',
          'ordinary',
          'userId',
          'owner',
          'createdAt',
          '1',
          'status',
          'complete',
          'futureSourceCopy',
          '{}',
        ],
      },
    ]) {
      await expect(
        redisFixture(rows).store.inspectInitialSourcePopulation(options()),
      ).rejects.toThrow(/inventory/i);
    }
    const { store, redis } = redisFixture();
    redis.eval.mockImplementation(async (_script, keys) => (keys === 0 ? ['1', []] : ['none']));
    await expect(store.inspectInitialSourcePopulation(options())).rejects.toThrow(/inventory/i);
    expect(redis.eval.mock.calls.length).toBeLessThanOrEqual(514);
  });

  it('does not substitute a local or cluster adapter for complete shared Redis evidence', async () => {
    const { redis } = redisFixture();
    redis.isCluster = true;
    const store = new RedisJobStore(redis as unknown as Redis);
    await expect(store.inspectInitialSourcePopulation(options())).rejects.toThrow(/inventory/i);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('inspects serialized final-event file bindings but does not classify ordinary quoted chat as a file', async () => {
    const store = new InMemoryJobStore();
    const row = legacy();
    row.userMessage!.quotes = ['Discuss files and sourceFileIds as ordinary text'];
    row.userMessage!.quoteSourceRefs = [{ messageId: 'ordinary-message' }];
    jobs(store).set(row.streamId, row);
    expect((await store.inspectInitialSourcePopulation(options())).saturatedCounts.sourceJobs).toBe(
      0,
    );
    row.finalEvent = JSON.stringify({
      requestMessage: { files: [{ file_id: 'old-private-file' }] },
    });
    expect((await store.inspectInitialSourcePopulation(options())).saturatedCounts.sourceJobs).toBe(
      1,
    );
  });

  it('rejects malformed legacy metadata and oversized values without an empty fallback', async () => {
    const store = new InMemoryJobStore();
    const row = legacy();
    jobs(store).set(row.streamId, {
      ...row,
      userMessage: 'invalid',
    } as unknown as SerializableJobData);
    await expect(store.inspectInitialSourcePopulation(options())).rejects.toThrow(/inventory/i);
    jobs(store).set(row.streamId, { ...row, finalEvent: 'x'.repeat(1024 * 1024 + 1) });
    await expect(store.inspectInitialSourcePopulation(options())).rejects.toThrow(/inventory/i);
  });

  it('scans the literal configured prefix and passes unprefixed EVAL keys exactly once', async () => {
    const { redis, store } = redisFixture();
    redis.options.keyPrefix = 'cortex[1]:';
    redis.eval.mockImplementation(async (_script, count, ...args) => {
      if (count === 0) return ['0', ['cortex[1]:stream:{ordinary}:job']];
      if (String(args[0]) === 'stream:{ordinary}:job') {
        return [
          'hash',
          'streamId',
          'ordinary',
          'userId',
          'owner',
          'createdAt',
          '1',
          'status',
          'complete',
          'sender',
          '[Assistant]',
        ];
      }
      return ['none'];
    });
    const result = await store.inspectInitialSourcePopulation(options());
    expect(result.saturatedCounts).toEqual({ sourceJobs: 0, replayIntents: 0, recoveryCopies: 0 });
    expect(redis.eval.mock.calls[0][3]).toBe('cortex\\[1\\]:stream:{*}:*');
    expect(redis.eval.mock.calls.filter((call) => call[1] === 1).map((call) => call[2])).toEqual(
      expect.arrayContaining(['stream:{ordinary}:job', 'stream:source-replay:v1']),
    );
  });

  it.each(['memory', 'redis'] as const)(
    'uses the common canonical ISO-Z timestamp DTO for %s',
    async (adapter) => {
      const store = adapter === 'memory' ? new InMemoryJobStore() : redisFixture().store;
      const input = options();
      const before = Date.now();
      const result = await store.inspectInitialSourcePopulation(input);
      expect(result.originalDeadline).toBe(input.originalDeadline);
      for (const field of ['originalDeadline', 'observedFrom', 'observedThrough'] as const) {
        const value = result[field];
        expect(typeof value).toBe('string');
        expect(value).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
        expect(new Date(Date.parse(value)).toISOString()).toBe(value);
      }
      expect(Date.parse(result.observedFrom)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(result.observedThrough)).toBeGreaterThanOrEqual(
        Date.parse(result.observedFrom),
      );
      expect(Date.parse(result.observedThrough)).toBeLessThan(Date.parse(input.originalDeadline));
    },
  );

  it('rejects numeric, coerced and noncanonical deadline inputs before reading either adapter', async () => {
    const invalid = [
      Date.now() + 60_000,
      new Date(Date.now() + 60_000),
      { toString: () => options().originalDeadline },
      '2099-01-01T00:00:00Z',
      '2099-01-01T00:00:00.000+00:00',
      '2099-02-30T00:00:00.000Z',
    ];
    const { store: redisStore, redis } = redisFixture();
    for (const store of [new InMemoryJobStore(), redisStore]) {
      for (const originalDeadline of invalid) {
        await expect(
          store.inspectInitialSourcePopulation({
            ...options(),
            originalDeadline: originalDeadline as never,
          }),
        ).rejects.toThrow(/inventory/i);
      }
    }
    expect(redis.eval).not.toHaveBeenCalled();
  });
});
