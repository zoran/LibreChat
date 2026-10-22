import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  createRedisGenerationCleanupPort,
  createOwnedRedisGenerationCleanup,
} from '../../generation-cleanup';
import { RedisEventTransport } from '../implementations/RedisEventTransport';
import { GenerationJobManagerClass } from '../GenerationJobManager';
import { createSourceReplayIntent } from '../internal/sourceBudget';
import { RedisJobStore } from '../implementations/RedisJobStore';

jest.mock('~/cache/redisTelemetry', () => ({
  RedisUseCases: { GENERATION_STREAM: 'generation_stream' },
  instrumentIORedisClient: (client: unknown) => client,
}));
const socket = process.env.UPLOAD_REPLAY_TEST_REDIS_SOCKET;
const suite = socket ? describe : describe.skip;
suite('generation cleanup actual Redis custody', () => {
  let publisher: Redis;
  const prefix = `source-cleanup:${randomUUID()}:`;
  const clients: Redis[] = [];
  async function client() {
    const redis = new Redis({
      path: socket!,
      keyPrefix: prefix,
      lazyConnect: true,
      enableOfflineQueue: false,
      commandTimeout: 1000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      connectTimeout: 1000,
    });
    clients.push(redis);
    await redis.connect();
    return redis;
  }
  beforeAll(async () => {
    publisher = await client();
  });
  afterAll(() => {
    for (const redis of clients) redis.disconnect();
  });

  it('dispatches the real actor from the existing abort subscription without an owner-loop tick', async () => {
    const store = new RedisJobStore(publisher);
    const transport = new RedisEventTransport(publisher, await client());
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: store,
      eventTransport: transport,
      isRedis: true,
      cleanupOnComplete: true,
    });
    const created = await manager.createJob(randomUUID(), 'awake-owner');
    const job = (await store.getJob(created.streamId))!;
    const intent = createSourceReplayIntent(job, ['awake-source'], Date.now() + 60_000);
    await store.prepareSourceReplay(intent);
    await store.commitSourceReplay(intent);
    const controlTransport = new RedisEventTransport(publisher, await client());
    const view = manager as unknown as { sourceCleanupFlights: Set<Promise<void>> };
    try {
      expect(
        await manager.beginProviderExecution(job.streamId, job.createdAt, job.providerExecutionId!),
      ).toBe(true);
      await store.revokeSourceRetention(job.streamId, job.createdAt);
      expect(await controlTransport.emitAbortConfirmed(job.streamId, job.createdAt)).toBe(true);
      expect((await store.getSourceReplayJob(job.streamId))?.sourceActorSettlement).toBeUndefined();
      await manager.markProviderExecutionDrained(
        job.streamId,
        job.createdAt,
        job.providerExecutionId!,
      );
      for (let i = 0; i < 50 && !view.sourceCleanupFlights.size; i++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      await Promise.all([...view.sourceCleanupFlights]);
      expect(
        (await store.getSourceReplayJob(job.streamId))?.sourceActorSettlement?.localCopiesAbsent,
      ).toBe(true);
    } finally {
      await manager.markProviderExecutionDrained(
        job.streamId,
        job.createdAt,
        job.providerExecutionId!,
      );
      controlTransport.destroy();
      await manager.destroy();
    }
  });

  it('uses real receipt CAS/codecs/purge allowlists, preserving exact provider and revocation fences', async () => {
    const store = new RedisJobStore(publisher);
    const job = await store.createJob(randomUUID(), 'user', undefined, 'tenant', {
      providerExecutionId: 'provider',
    });
    const intent = createSourceReplayIntent(job, ['file'], Date.now() + 60_000);
    await store.prepareSourceReplay(intent);
    await store.commitSourceReplay(intent);
    await store.revokeSourceRetention(job.streamId, job.createdAt);
    await store.updateJob(
      job.streamId,
      { status: 'aborted', providerDrained: true, terminalHostActionPending: true },
      job.createdAt,
    );
    const row = (await store.getSourceReplayJob(job.streamId))!;
    const receipt = {
      schema: 1 as const,
      streamId: job.streamId,
      createdAt: job.createdAt,
      providerExecutionId: 'provider',
      sourceRetentionRevokedAt: row.sourceRetentionRevokedAt!,
      sourceFileIds: ['file'],
      localCopiesAbsent: true as const,
    };
    expect(await store.recordSourceActorSettlement(receipt)).toBe(false);
    await store.updateJob(job.streamId, { terminalHostActionPending: false }, job.createdAt);
    expect(
      await store.recordSourceActorSettlement({
        ...receipt,
        sourceRetentionRevokedAt: receipt.sourceRetentionRevokedAt + 1,
      }),
    ).toBe(false);
    await store.updateJob(job.streamId, { sourceActorSettlement: receipt }, job.createdAt);
    expect((await store.getSourceReplayJob(job.streamId))?.sourceActorSettlement).toBeUndefined();
    expect(await store.recordSourceActorSettlement(receipt)).toBe(true);
    expect(await store.purgeSourceRetention(job.streamId, job.createdAt)).toBe(true);
    expect((await store.getSourceReplayJob(job.streamId))?.sourceActorSettlement).toEqual(receipt);
    expect((await store.getJob(job.streamId))?.sourceActorSettlement).toEqual(receipt);
    expect(
      await store.recordSourceActorSettlement({ ...receipt, providerExecutionId: 'replacement' }),
    ).toBe(false);
  });

  it('recovers dropped PUBSUB on the actual owner and keeps ACK distinct from independent actor proof', async () => {
    const store = new RedisJobStore(publisher);
    const actorSubscriber = await client();
    const transport = new RedisEventTransport(publisher, actorSubscriber);
    const manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: store,
      eventTransport: transport,
      isRedis: true,
      cleanupOnComplete: true,
    });
    manager.initialize();
    const created = await manager.createJob(randomUUID(), 'owner', undefined, {
      trustedTenantId: 'tenant',
    });
    const job = (await store.getJob(created.streamId))!;
    const intent = createSourceReplayIntent(job, ['source'], Date.now() + 60_000);
    await store.prepareSourceReplay(intent);
    await store.commitSourceReplay(intent);
    await actorSubscriber.unsubscribe();
    const port = createRedisGenerationCleanupPort({ publisher, subscriber: await client() });
    const scope = {
      userId: 'owner',
      tenantId: 'tenant',
      revocationId: 'claim',
      sourceFileIds: ['source'],
    };
    const page = await port.capture(scope);
    const target = page.targets.find((entry) => entry.streamId === job.streamId)!;
    const view = manager as unknown as {
      cleanup(): Promise<void>;
      sourceCleanupFlights: Set<Promise<void>>;
    };
    try {
      expect(
        await manager.beginProviderExecution(job.streamId, job.createdAt, job.providerExecutionId!),
      ).toBe(true);
      expect(await port.reconcile(target)).toMatchObject({
        state: 'pending',
        reason: 'actor_terminal_obligations',
      });
      await view.cleanup();
      expect((await store.getSourceReplayJob(job.streamId))?.sourceActorSettlement).toBeUndefined();
      await manager.markProviderExecutionDrained(
        job.streamId,
        job.createdAt,
        job.providerExecutionId!,
      );
      await Promise.all([...view.sourceCleanupFlights]);
      expect(
        (await store.getSourceReplayJob(job.streamId))?.sourceActorSettlement?.localCopiesAbsent,
      ).toBe(true);
      expect(await store.acknowledgeSourceReplayRelease(intent)).toBe(true);
      expect(await port.reconcile(target)).toMatchObject({
        state: 'settled',
        evidence: { abortAcknowledged: false, providerDrained: true },
      });
    } finally {
      await manager.markProviderExecutionDrained(
        job.streamId,
        job.createdAt,
        job.providerExecutionId!,
      );
      await port.close();
      await manager.destroy();
    }
  }, 20_000);

  it('keeps source recovery inventory incomplete and refuses oversized compact-index replies', async () => {
    const store = new RedisJobStore(publisher);
    const owner = `owner-${randomUUID()}`;
    const stream = randomUUID();
    // Use the same membership constructor through ordinary create, then retain a predecessor receipt.
    const job = await store.createJob(stream, owner, undefined, undefined, {
      providerExecutionId: 'provider',
    });
    await publisher.hset(
      `stream:{${stream}}:steer-receipts`,
      'receipt',
      JSON.stringify({
        userId: owner,
        generationCreatedAt: job.createdAt - 1,
        item: { files: [{ file_id: 'file' }] },
      }),
    );
    const page = await store.captureSourceCleanupPage({
      userId: owner,
      revocationId: 'claim',
      sourceFileIds: ['file'],
    });
    expect(page.unresolvedRecovery).toBe(true);
    const crowded = `crowded-${randomUUID()}`;
    for (let i = 0; i < 140; i++) await store.createJob(String(900000 + i), crowded);
    await expect(
      store.captureSourceCleanupPage({
        userId: crowded,
        revocationId: 'claim',
        sourceFileIds: ['file'],
      }),
    ).rejects.toThrow('page_overflow');
  });
});

const resourceURI = process.env.HOUSEKEEPING_RESOURCE_REDIS_URI;
(resourceURI ? describe : describe.skip)('owned resource Redis acquisition', () => {
  const env = () => ({
    USE_REDIS: 'true',
    REDIS_URI: resourceURI,
    REDIS_KEY_PREFIX: `owned-${randomUUID()}`,
  });
  it('uses two actual dedicated clients and waits for their end events on one original close', async () => {
    const created: Redis[] = [];
    const original = Redis.prototype.connect;
    const spy = jest.spyOn(Redis.prototype, 'connect').mockImplementation(function (this: Redis) {
      created.push(this);
      return original.call(this);
    });
    const resources = await createOwnedRedisGenerationCleanup(env());
    try {
      expect(created).toHaveLength(2);
      expect(created[0]).not.toBe(created[1]);
      expect(created.map((client) => client.options.enableOfflineQueue)).toEqual([false, false]);
      expect(created[0].options.keyPrefix).toBe(created[1].options.keyPrefix);
      const scope = {
        userId: 'isolated',
        revocationId: 'revocation',
        sourceFileIds: ['file'],
      };
      const firstPage = await resources.port.capture(scope);
      expect(firstPage).toEqual({ targets: [], cursor: '1:0', complete: false });
      expect(await resources.port.capture(scope, firstPage.cursor)).toEqual({
        targets: [],
        cursor: undefined,
        complete: true,
      });
      const closing = resources.close();
      expect(resources.close()).toBe(closing);
      await closing;
      expect(created.map((client) => client.status)).toEqual(['end', 'end']);
      await expect(
        resources.port.capture({
          userId: 'isolated',
          revocationId: 'revocation',
          sourceFileIds: ['file'],
        }),
      ).rejects.toThrow('generation_cleanup_closed');
    } finally {
      await resources.close();
      spy.mockRestore();
    }
  });
  it('settles the first actual acquisition when the second acquisition rejects', async () => {
    const created: Redis[] = [];
    const original = Redis.prototype.connect;
    const spy = jest.spyOn(Redis.prototype, 'connect').mockImplementation(function (this: Redis) {
      created.push(this);
      return created.length === 2
        ? Promise.reject(new Error('selected second connection failure'))
        : original.call(this);
    });
    try {
      await expect(createOwnedRedisGenerationCleanup(env())).rejects.toThrow(
        'generation_cleanup_acquisition_failed',
      );
      expect(created).toHaveLength(2);
      expect(created.map((client) => client.status)).toEqual(['end', 'end']);
    } finally {
      for (const client of created) if (client.status !== 'end') client.disconnect();
      spy.mockRestore();
    }
  });
  it('rejects an already aborted acquisition and conflicting transport without creating clients', async () => {
    const spy = jest.spyOn(Redis.prototype, 'connect');
    const controller = new AbortController();
    controller.abort();
    await expect(createOwnedRedisGenerationCleanup(env(), controller.signal)).rejects.toThrow(
      'aborted',
    );
    await expect(
      createOwnedRedisGenerationCleanup({ ...env(), USE_REDIS_CLUSTER: 'true' }),
    ).rejects.toThrow('shared_redis_required');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('owned resource Redis URI guard', () => {
  it.each(['?commandTimeout=0&enableOfflineQueue=true', '#configuration'])(
    'rejects option-bearing URI %s before acquisition',
    async (suffix) => {
      const spy = jest
        .spyOn(Redis.prototype, 'connect')
        .mockRejectedValue(new Error('unexpected resource acquisition'));
      await expect(
        createOwnedRedisGenerationCleanup({
          USE_REDIS: 'true',
          REDIS_URI: `redis://127.0.0.1:1/2${suffix}`,
        }),
      ).rejects.toThrow('generation_cleanup_invalid_redis_transport');
      expect(spy).not.toHaveBeenCalled();
    },
  );
});
