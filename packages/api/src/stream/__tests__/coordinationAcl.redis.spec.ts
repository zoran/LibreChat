/** Actual stream/cache consumers under the rendered coordination APP ACL, on a disposable socket only. */
import Redis from 'ioredis';
import { Keyv } from 'keyv';
import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createClient } from '@keyv/redis';
import { RedisEventTransport } from '../implementations/RedisEventTransport';
import { createSourceReplayIntent } from '../internal/sourceBudget';
import { RedisJobStore } from '../implementations/RedisJobStore';
import { consumeCacheEntry } from '~/cache/consume';

// Match the production CommonJS interop; the actual Keyv adapter and GETDEL remain exercised.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const KeyvRedis = require('@keyv/redis').default as typeof import('@keyv/redis').default;

jest.mock('~/cache/redisTelemetry', () => ({
  RedisUseCases: { GENERATION_STREAM: 'generation_stream' },
  instrumentIORedisClient: (client: unknown) => client,
  observeRedisOperation: (
    _engine: unknown,
    _namespace: unknown,
    _operation: unknown,
    run: () => unknown,
  ) => run(),
}));

const socket = process.env.COORDINATION_ACL_TEST_SOCKET;
const suite = socket ? describe : describe.skip;
// Public synthetic fixture value, never a deployment credential.
const password = 'coordination-acl-disposable-fixture';
const prefix = 'cortex-chat::';

suite('rendered coordination ACL with actual e3 consumers', () => {
  const clients: Redis[] = [];
  let controller: Redis;
  let app: Redis;
  let rawApp: Redis;
  let store: RedisJobStore;

  async function connect(username: 'fixture' | 'app', keyPrefix = ''): Promise<Redis> {
    const client = new Redis({
      path: socket!,
      username,
      ...(username === 'app' && { password }),
      keyPrefix,
      lazyConnect: true,
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      connectTimeout: 1000,
      commandTimeout: 2000,
    });
    clients.push(client);
    await client.connect();
    return client;
  }

  beforeAll(async () => {
    if (!socket || !isAbsolute(socket) || !lstatSync(socket).isSocket()) {
      throw new Error('An explicitly admitted disposable Unix socket is required');
    }
    controller = await connect('fixture');
    app = await connect('app', prefix);
    rawApp = await connect('app');
  });
  beforeEach(async () => {
    // Only the synthetic controller can reset this private, nonpersistent fixture.
    await controller.flushdb();
    store = new RedisJobStore(app); // No initialize(), manager startup or cleanup timer.
  });
  afterAll(() => {
    for (const client of clients) client.disconnect();
  });

  async function create() {
    return store.createJob(randomUUID(), 'owner', undefined, 'tenant', {
      providerExecutionId: 'segment',
      generationProtocolVersion: 2,
    });
  }

  it('enumerates an empty account-cleanup intent index and runs empty recovery CAS', async () => {
    expect(await store.listSourceReplayIntents()).toEqual([]);
    expect(
      await store.purgeFileSourceRecovery('empty', { userId: 'owner', tenantId: 'tenant' }, [
        'file-a',
      ]),
    ).toBe(true);
  });

  it.each([
    { userId: 'foreign', tenantId: 'tenant' },
    { userId: 'owner', tenantId: 'foreign' },
    { userId: 'owner', tenantId: 'tenant' },
  ])('recovery CAS preserves foreign owner contents when purging as %j', async (owner) => {
    const job = await create();
    const item = {
      steerId: 'steer',
      createdAt: Date.now(),
      text: 'retained question',
      files: [{ file_id: 'file-a' }, { file_id: 'file-b' }],
    };
    const parked = { userId: 'owner', tenantId: 'tenant', steers: [item] };
    await store.parkSteers(job.streamId, JSON.stringify(parked), job.createdAt);
    const receiptKey = `stream:{${job.streamId}}:steer-receipts`;
    const receipts = {
      own: JSON.stringify({ userId: 'owner', tenantId: 'tenant', item }),
      otherUser: JSON.stringify({ userId: 'different-user', tenantId: 'tenant', item }),
      otherTenant: JSON.stringify({ userId: 'owner', tenantId: 'different-tenant', item }),
    };
    await app.hset(receiptKey, receipts);
    const parkedKey = `stream:{${job.streamId}}:parked`;
    const before = await app.get(parkedKey);
    expect(await store.purgeFileSourceRecovery(job.streamId, owner, ['file-a'])).toBe(true);
    const rows = await app.hgetall(receiptKey);
    expect(rows.otherUser).toBe(receipts.otherUser);
    expect(rows.otherTenant).toBe(receipts.otherTenant);
    if (owner.userId !== 'owner' || owner.tenantId !== 'tenant') {
      expect(await app.get(parkedKey)).toBe(before);
      expect(rows).toEqual(receipts);
    } else {
      const expected = { ...item, files: [{ file_id: 'file-b' }] };
      expect(JSON.parse((await app.get(parkedKey))!).steers).toEqual([expected]);
      expect(JSON.parse(rows.own).item).toEqual(expected);
    }
    expect((await store.getJob(job.streamId))?.createdAt).toBe(job.createdAt);
  });

  it('adopts existing metadata and runsteps, renews a full subscriber set, then releases retained source custody', async () => {
    const job = await create();
    const key = `stream:{${job.streamId}}`;
    const event = JSON.stringify({ event: 'on_run_step', data: { id: 'step' } });
    const chunkId = await app.xadd(`${key}:chunks`, '*', 'event', event);
    const runsteps = JSON.stringify({ step: { id: 'step' } });
    await app.set(`${key}:runsteps`, runsteps);
    const leases = `${key}:subscriber-leases:${job.createdAt}`;
    const expires = Date.now() + 60_000;
    await app.zadd(
      leases,
      ...Array.from({ length: 64 }, (_, i) => [expires, `subscriber-${i}`]).flat(),
    );
    const intent = createSourceReplayIntent(job, ['file-a'], Date.now() + 60_000);
    await store.prepareSourceReplay(intent);
    await store.commitSourceReplay(intent);
    expect(await store.listSourceReplayIntents()).toEqual([
      expect.objectContaining({ streamId: job.streamId }),
    ]);
    expect(await app.get(`${key}:runsteps`)).toBe(runsteps);
    expect(await app.xrange(`${key}:chunks`, '-', '+')).toEqual([[chunkId, ['event', event]]]);
    expect(
      await store.claimFirstSubscriber(
        job.streamId,
        job.createdAt,
        Date.now(),
        'subscriber-0',
        expires + 1,
      ),
    ).toBe(true);
    expect(await app.zscore(leases, 'subscriber-0')).toBe(String(expires + 1));
    expect(
      await store.claimFirstSubscriber(
        job.streamId,
        job.createdAt,
        Date.now(),
        'overflow',
        expires,
      ),
    ).toBe(false);
    expect(await app.zcard(leases)).toBe(64);
    await store.revokeSourceRetention(job.streamId, job.createdAt);
    const revoked = await app.hget(`${key}:job`, 'sourceRetentionRevokedAt');
    expect(revoked).toMatch(/^\d+$/);
    await store.revokeSourceRetention(job.streamId, job.createdAt);
    expect(await app.hget(`${key}:job`, 'sourceRetentionRevokedAt')).toBe(revoked);
    await store.updateJob(job.streamId, { status: 'error', providerDrained: true }, job.createdAt);
    expect(await app.ttl(`${key}:job`)).toBe(-1);
    expect(await store.purgeSourceRetention(job.streamId, job.createdAt)).toBe(true);
    expect(await store.acknowledgeSourceReplayRelease(intent)).toBe(true);
    expect(await store.listSourceReplayIntents()).toEqual([]);
    expect(await app.exists(`${key}:chunks`, `${key}:runsteps`)).toBe(0);
  });

  it('evicts an actual replay prefix through the existing transport at its item bound', async () => {
    const subscriber = await connect('app');
    const transport = new RedisEventTransport(app, subscriber);
    const streamId = randomUUID();
    const limits = { items: 2, bytes: 4096, ttlMs: 60_000 };
    try {
      for (let i = 0; i < 3; i++) {
        await transport.emitReplayableChunk(streamId, { text: `part-${i}` }, limits, {
          id: `event-${i}`,
        });
      }
      const retained = (await app.lrange(`stream:{${streamId}}:activity-backlog`, 0, -1)).map(
        (row) => JSON.parse(row),
      );
      expect(retained).toEqual([
        expect.objectContaining({ seq: 1, data: { text: 'part-1' } }),
        expect.objectContaining({ seq: 2, data: { text: 'part-2' } }),
      ]);
    } finally {
      transport.destroy();
    }
  });

  it('rearms schedule retention through the real job update and membership revision', async () => {
    const job = await create();
    const key = `stream:{${job.streamId}}:job`;
    await store.updateJob(job.streamId, { preserveForScheduleReconcile: true }, job.createdAt);
    const revision = Number(await app.hget(key, '__scheduleMembershipRevision'));
    expect(revision).toBeGreaterThan(0);
    await store.updateJob(job.streamId, { preserveForScheduleReconcile: true }, job.createdAt);
    expect(Number(await app.hget(key, '__scheduleMembershipRevision'))).toBe(revision + 1);
    expect(await app.ttl(key)).toBe(-1);
  });

  it('inspects actual hash/string/list/stream inventory without changing source-free history', async () => {
    const job = await create();
    const key = `stream:{${job.streamId}}`;
    const runsteps = JSON.stringify({ step: { id: 'step' } });
    const recovery = JSON.stringify({
      userId: 'owner',
      tenantId: 'tenant',
      steerId: 'steer',
      text: 'ordinary question',
    });
    await app.set(`${key}:runsteps`, runsteps);
    await app.rpush(`${key}:steers`, recovery);
    await app.xadd(
      `${key}:chunks`,
      '*',
      'event',
      JSON.stringify({ event: 'text', data: 'ordinary' }),
    );
    const before = await app.hgetall(`${key}:job`);
    const result = await store.inspectInitialSourcePopulation({
      originalDeadline: new Date(Date.now() + 30_000).toISOString(),
      targetBindingSha256: 'a'.repeat(64),
    });
    expect(result).toMatchObject({
      adapter: 'redis',
      complete: true,
      saturatedCounts: { sourceJobs: 0, replayIntents: 0, recoveryCopies: 0 },
    });
    expect(await app.hgetall(`${key}:job`)).toEqual(before);
    expect(await app.get(`${key}:runsteps`)).toBe(runsteps);
    expect(await app.lrange(`${key}:steers`, 0, -1)).toEqual([recovery]);
    expect(await app.xlen(`${key}:chunks`)).toBe(1);
  });

  it('consumes an actual Keyv entry exactly once through the atomic cache consumer', async () => {
    const client = createClient({
      username: 'app',
      password,
      socket: { path: socket!, reconnectStrategy: false, connectTimeout: 1000 },
      disableOfflineQueue: true,
    });
    client.on('error', () => {});
    const adapter = new KeyvRedis(client, { throwOnErrors: true });
    const cache = new Keyv(adapter, { namespace: 'exchange', throwOnErrors: true });
    adapter.namespace = 'cortex-chat';
    adapter.keyPrefixSeparator = '::';
    try {
      await client.connect();
      await cache.set('one-use', { synthetic: true }, 10_000);
      expect(await consumeCacheEntry(cache, 'one-use')).toEqual({ synthetic: true });
      expect(await consumeCacheEntry(cache, 'one-use')).toBeUndefined();
    } finally {
      if (client.isOpen) client.destroy();
    }
  });

  it('keeps foreign keys/channels and administrative or unneeded subcommands denied', async () => {
    await controller.set('foreign::private', 'untouched');
    await expect(rawApp.get('foreign::private')).rejects.toThrow(/NOPERM/);
    await expect(rawApp.getdel('foreign::private')).rejects.toThrow(/NOPERM/);
    await expect(
      rawApp.eval("return redis.call('GET', KEYS[1])", 1, 'foreign::private'),
    ).rejects.toThrow(/NOPERM/);
    await expect(
      rawApp.eval("return redis.call('GET', ARGV[1])", 0, 'foreign::private'),
    ).rejects.toThrow(/permission|NOPERM/i);
    await expect(app.publish('foreign:events', 'synthetic')).rejects.toThrow(/NOPERM/);
    await expect(rawApp.subscribe('foreign:events')).rejects.toThrow(/NOPERM/);
    for (const command of [
      ['CONFIG', 'GET', '*'],
      ['ACL', 'WHOAMI'],
      ['FLUSHALL'],
      ['KEYS', '*'],
      ['XGROUP', 'DESTROY', `${prefix}stream:{empty}:chunks`, 'group'],
      ['XINFO', 'STREAM', `${prefix}stream:{empty}:chunks`],
    ]) {
      await expect(rawApp.call(command[0], ...command.slice(1))).rejects.toThrow(/NOPERM/);
    }
    expect(await controller.get('foreign::private')).toBe('untouched');
  });
});
