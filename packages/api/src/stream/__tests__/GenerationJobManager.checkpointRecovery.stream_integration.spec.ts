/** Manager admission/start boundaries with real Mongo; durable store/process cases share this owner. */
import Redis from 'ioredis';
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createGenerationAdmissionMethods,
  snapshotGenerationCheckpointAdmission,
  tenantStorage,
} from '@librechat/data-schemas';
import type { GenerationAdmissionInput } from '@librechat/data-schemas';
import type { GenerationJobManagerOptions } from '../GenerationJobManager';
import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';
import { RedisEventTransport } from '../implementations/RedisEventTransport';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '../GenerationJobManager';
import { prepareSourceReplayForTest } from './helpers/sourceReplay';
import { generationRequestBinding } from '../generationAdmission';
import { RedisJobStore } from '../implementations/RedisJobStore';
import { createCheckpointNamespace } from '../checkpoints';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('manager checkpoint recovery start gates', () => {
  let mongo: MongoMemoryReplSet;
  let methods: ReturnType<typeof createGenerationAdmissionMethods>;
  const managers: Array<{
    manager: GenerationJobManagerClass;
    store: NonNullable<GenerationJobManagerOptions['jobStore']>;
    transport: NonNullable<GenerationJobManagerOptions['eventTransport']>;
    held: boolean;
    originals: Promise<void>[];
    releases: Array<() => void>;
  }> = [];
  const clients: Redis[] = [];
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: '127.0.0.1' } });
    await mongoose.connect(mongo.getUri(), { retryWrites: false });
    methods = createGenerationAdmissionMethods(mongoose);
    await methods.ensureGenerationAdmissionIndexes();
  }, 30_000);
  beforeEach(async () => {
    await mongoose.models.GenerationAdmission.deleteMany({});
  });
  afterEach(async () => {
    const fixtures = managers.splice(0).reverse();
    jest.restoreAllMocks();
    for (const fixture of fixtures) for (const release of fixture.releases) release();
    const results = await Promise.allSettled(
      fixtures.map(async (fixture) => {
        const { manager, store, transport } = fixture;
        await Promise.all(fixture.originals);
        await Promise.allSettled(
          [...manager['openProviderExecutions'].values()].flatMap((entry) =>
            [entry.drain, entry.settlement].filter((original) => original !== undefined),
          ),
        );
        async function assertCustodyAndDestroy(): Promise<void> {
          const custody = manager['durableAdmission'].getLocalCustody();
          expect(custody.pending).toBe(0);
          if (fixture.held) {
            expect(custody.unresolved).toBeGreaterThan(0);
            expect((await manager.getGenerationAdmissionCensus()).pendingWrites).toBe(0);
            // The synthetic terminated predecessor/unknown native outcome remains
            // held. Closing owned test resources is not positive maintenance proof.
          } else {
            expect(custody.unresolved).toBe(0);
            expect((await manager.getGenerationAdmissionCensus()).providerExecutions).toBe(0);
            await manager.destroy({ settlementBudgetMs: 1_000 });
          }
        }
        const outcome = await Promise.allSettled([assertCustodyAndDestroy()]);
        // An expired observer never authorizes disposal of the retained shutdown original.
        const shutdown = await Promise.allSettled([manager['shutdownSettlement']]);
        const prepare = await Promise.allSettled([
          Promise.resolve().then(() => manager.prepareForShutdown()),
        ]);
        const subscribers = await Promise.allSettled([manager['drainSubscriberCleanups']()]);
        const resources = await Promise.allSettled([
          store.destroy(),
          Promise.resolve().then(() => transport.destroy()),
        ]);
        const failures = [...outcome, ...shutdown, ...prepare, ...subscribers, ...resources].filter(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (failures.length)
          throw Object.assign(
            new Error(failures.map((result) => String(result.reason)).join('\n')),
            { errors: failures.map((result) => result.reason) },
          );
      }),
    );
    // Always close every captured connection, even if a manager assertion or
    // resource destructor failed. Await actual local socket closure.
    const connections = await Promise.allSettled(
      clients.splice(0).map(
        (client) =>
          new Promise<void>((resolve) => {
            if (client.status === 'end') return resolve();
            client.once('end', resolve);
            client.disconnect();
          }),
      ),
    );
    const failures = [...results, ...connections].filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length)
      throw Object.assign(
        new Error(
          'Checkpoint fixture disposal failed:\n' +
            failures.map((result) => String(result.reason)).join('\n'),
        ),
        { errors: failures.map((result) => result.reason) },
      );
  });
  afterAll(async () => {
    const disconnected = await Promise.allSettled([mongoose.disconnect()]);
    const stopped = await Promise.allSettled([mongo?.stop()]);
    const failures = [...disconnected, ...stopped].filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length)
      throw Object.assign(new Error(failures.map((result) => String(result.reason)).join('\n')), {
        errors: failures.map((result) => result.reason),
      });
  });
  function owner(services: GenerationJobManagerOptions = {}, boot = 'manager-boot') {
    const store = services.jobStore ?? new InMemoryJobStore({ ttlAfterComplete: 0, maxJobs: 1000 });
    const transport = services.eventTransport ?? new InMemoryEventTransport();
    const manager = new GenerationJobManagerClass({
      ...services,
      jobStore: store,
      eventTransport: transport,
      cleanupOnComplete: false,
    });
    manager.configureGenerationAdmission({
      required: true,
      methods,
      ownerInstanceId: 'manager-pod',
      processBootId: boot,
    });
    managers.push({ manager, store, transport, held: false, originals: [], releases: [] });
    return manager;
  }
  function retain<T>(
    manager: GenerationJobManagerClass,
    original: Promise<T>,
    release: () => void,
  ): Promise<T> {
    const fixture = managers.find((entry) => entry.manager === manager)!;
    fixture.releases.push(release);
    fixture.originals.push(
      original.then(
        () => undefined,
        () => undefined,
      ),
    );
    return original;
  }
  function preserveHeld(manager: GenerationJobManagerClass): void {
    expect(manager['durableAdmission'].getLocalCustody().unresolved).toBeGreaterThan(0);
    managers.find((entry) => entry.manager === manager)!.held = true;
  }
  async function finish(
    manager: GenerationJobManagerClass,
    job: Awaited<ReturnType<GenerationJobManagerClass['createJob']>>,
    segment = job.metadata.providerExecutionId!,
  ): Promise<void> {
    expect(await manager.completeJob(job.streamId, undefined, job.createdAt)).toBe(true);
    expect(await manager.settleGenerationExecution(job.streamId, job.createdAt, segment)).toBe(
      true,
    );
  }
  const options = () => ({
    generationAdmission: generationRequestBinding('request', { text: 'hello' }),
  });

  it('does not poison Redis-compatible provider state while native admission is HELD', async () => {
    const entered = deferred();
    const release = deferred();
    const acquire = methods.acquireGenerationAdmission.bind(methods);
    jest.spyOn(methods, 'acquireGenerationAdmission').mockImplementation(async (...args) => {
      const result = await acquire(...args);
      entered.resolve();
      await release.promise;
      return result;
    });
    const manager = owner();
    const creating = retain(
      manager,
      manager.createJob('held-start', 'owner', 'held-start', options()),
      release.resolve,
    );
    try {
      await entered.promise;
      const stored = (await manager.getJobStore().getJob('held-start'))!;
      const start = jest.spyOn(manager.getJobStore(), 'beginProviderExecution');
      expect(
        await manager.beginProviderExecution(
          'held-start',
          stored.createdAt,
          stored.providerExecutionId!,
        ),
      ).toBe(false);
      expect(start).not.toHaveBeenCalled();
      expect(await manager.getJobStore().getJob('held-start')).toMatchObject({
        providerDrained: true,
      });
    } finally {
      release.resolve();
      await creating;
    }
    const job = await creating;
    expect(
      await manager.beginProviderExecution(
        job.streamId,
        job.createdAt,
        job.metadata.providerExecutionId!,
      ),
    ).toBe(true);
    await finish(manager, job);
  });

  it.each(
    ['first job read', 'Redis start', 'Mongo authorize', 'final job read'].flatMap((boundary) =>
      [
        'abort',
        'shutdown',
        'ownership lost',
        'runtime replaced',
        'terminal status',
        'source revoked',
      ].map((failure) => [boundary, failure]),
    ),
  )('refuses provider execution at %s after %s', async (boundary, failure) => {
    const entered = deferred();
    const release = deferred();
    const manager = owner();
    const job = await manager.createJob('abort-start', 'owner', 'abort-start', options());
    const wait = async <T>(result: T): Promise<T> => {
      entered.resolve();
      await release.promise;
      return result;
    };
    const store = manager.getJobStore();
    if (failure === 'source revoked')
      await prepareSourceReplayForTest(store, (await store.getJob(job.streamId))!);
    if (boundary === 'Mongo authorize') {
      const dispatch = methods.dispatchGenerationAdmission.bind(methods);
      jest
        .spyOn(methods, 'dispatchGenerationAdmission')
        .mockImplementation(async (...args) => wait(await dispatch(...args)));
    } else if (boundary === 'Redis start') {
      const start = store.beginProviderExecution.bind(store);
      jest
        .spyOn(store, 'beginProviderExecution')
        .mockImplementation(async (...args) => wait(await start(...args)));
    } else {
      let reads = 0;
      const get = store.getJob.bind(store);
      jest.spyOn(store, 'getJob').mockImplementation(async (...args) => {
        const result = await get(...args);
        return ++reads === (boundary === 'first job read' ? 1 : 3) ? wait(result) : result;
      });
    }
    const starting = retain(
      manager,
      manager.beginProviderExecution(
        job.streamId,
        job.createdAt,
        job.metadata.providerExecutionId!,
      ),
      release.resolve,
    );
    try {
      await entered.promise;
      if (failure === 'abort') job.abortController.abort();
      if (failure === 'shutdown') manager.prepareForShutdown();
      if (failure === 'ownership lost') manager['ownedJobs'].delete(job.streamId);
      if (failure === 'runtime replaced') {
        const runtime = manager['runtimeState'].get(job.streamId)!;
        manager['runtimeState'].set(job.streamId, { ...runtime });
      }
      if (failure === 'terminal status')
        await manager.getJobStore().transitionStatus(job.streamId, {
          from: 'running',
          to: 'aborted',
          expectCreatedAt: job.createdAt,
          expectProviderExecutionId: job.metadata.providerExecutionId,
        });
      if (failure === 'source revoked') {
        expect(await store.revokeSourceRetention!(job.streamId, job.createdAt)).toBe(true);
        expect((await store.getJob(job.streamId))!.sourceRetentionRevokedAt).toEqual(
          expect.any(Number),
        );
      }
    } finally {
      release.resolve();
    }
    expect(await starting).toBe(false);
    expect((await manager.getGenerationAdmissionCensus()).providerExecutions).toBe(
      boundary === 'first job read' ? 0 : 1,
    );
    if (boundary === 'first job read') {
      expect(
        await manager.cancelGenerationInitialization(
          job.streamId,
          job.createdAt,
          job.metadata.providerExecutionId!,
        ),
      ).toBe(true);
      return;
    }
    // The true provider caller still owns drain, even though this start returned false.
    expect(
      await manager.markProviderExecutionDrained(
        job.streamId,
        job.createdAt,
        job.metadata.providerExecutionId!,
      ),
    ).toBe(true);
    expect((await manager.getGenerationAdmissionCensus()).providerExecutions).toBe(0);
    expect((await manager.getGenerationAdmissionCensus()).unresolved).toBe(1);
    preserveHeld(manager);
  });
  it('keeps an uncertain provider mutation open until exact drain and never retries it', async () => {
    const manager = owner();
    const job = await manager.createJob('uncertain-start', 'owner', 'uncertain-start', options());
    const store = manager.getJobStore();
    const start = store.beginProviderExecution.bind(store);
    const spy = jest
      .spyOn(store, 'beginProviderExecution')
      .mockImplementationOnce(async (...args) => {
        expect(await start(...args)).toBe(true);
        throw new Error('Lost provider-start acknowledgment');
      });
    await expect(
      manager.beginProviderExecution(
        job.streamId,
        job.createdAt,
        job.metadata.providerExecutionId!,
      ),
    ).rejects.toThrow('Lost provider-start acknowledgment');
    expect(await store.getJob(job.streamId)).toMatchObject({ providerDrained: false });
    expect((await manager.getGenerationAdmissionCensus()).providerExecutions).toBe(1);
    expect(
      await manager.beginProviderExecution(
        job.streamId,
        job.createdAt,
        job.metadata.providerExecutionId!,
      ),
    ).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(
      await manager.markProviderExecutionDrained(
        job.streamId,
        job.createdAt,
        job.metadata.providerExecutionId!,
      ),
    ).toBe(true);
    expect((await manager.getGenerationAdmissionCensus()).providerExecutions).toBe(0);
    expect((await manager.getGenerationAdmissionCensus()).unresolved).toBe(1);
    preserveHeld(manager);
  });
  // These adoption fault cases use actual Mongo/Valkey with controlled death/effect ports.
  // Only continuation.process.integration supplies actual predecessor OS termination evidence.
  async function recoveryFixture(withSource = false) {
    const uri = new URL(process.env.CONTINUATION_REDIS_URI ?? '');
    if (uri.protocol !== 'redis:' || uri.hostname !== '127.0.0.1' || uri.username || uri.password)
      throw new Error('An owned loopback Valkey/Redis service is required');
    const prefix = `${process.env.REDIS_KEY_PREFIX}${randomUUID()}:`;
    const native = async (boot: string) => {
      const publisher = new Redis(uri.href, {
        keyPrefix: prefix,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      });
      const subscriber = publisher.duplicate();
      clients.push(publisher, subscriber);
      await Promise.all([publisher.ping(), subscriber.ping()]);
      const store = new RedisJobStore(publisher);
      const transport = new RedisEventTransport(publisher, subscriber);
      const manager = owner({ jobStore: store, eventTransport: transport }, boot);
      return { manager, store, transport };
    };
    const predecessor = await native('old-boot');
    const successor = await native('next-boot');
    const binding = generationRequestBinding(randomUUID(), { text: 'hello' });
    if (!binding) throw new Error('Missing fixture request binding');
    const stream = randomUUID();
    const job = await tenantStorage.run({ tenantId: 'tenant' }, async () => {
      const claim = await predecessor.manager.claimGeneration(
        'owner',
        binding.clientRequestId,
        stream,
        stream,
        2,
        binding,
      );
      expect(claim.claimed).toBe(true);
      return predecessor.manager.createJob(stream, 'owner', stream, {
        trustedTenantId: 'tenant',
        generationAdmission: binding,
        idempotencyClientRequestId: binding.clientRequestId,
        idempotencyClaimToken: claim.existing!.claimToken,
        checkpointContinuation: {
          version: 1,
          mode: 'checkpoint-only-v1',
          runId: randomUUID(),
          threadId: stream,
          checkpointNamespace: createCheckpointNamespace('owner', 'tenant'),
          graphFingerprint: 'a'.repeat(64),
          policyFingerprint: 'b'.repeat(64),
        },
      });
    });
    if (withSource)
      await prepareSourceReplayForTest(
        predecessor.store,
        (await predecessor.store.getJob(stream))!,
      );
    expect(
      await predecessor.manager.beginProviderExecution(
        stream,
        job.createdAt,
        job.metadata.providerExecutionId!,
      ),
    ).toBe(true);
    const row = await methods.getGenerationAdmission({
      tenantId: 'tenant',
      principalId: 'owner',
      clientRequestId: binding.clientRequestId,
    });
    if (!row.ok || !row.value) throw new Error('Missing actual predecessor admission');
    const prior = snapshotGenerationCheckpointAdmission(row.value);
    // This fixture models a terminated process through a synthetic proof. Its
    // old manager must never manufacture a successful graceful shutdown proof.
    preserveHeld(predecessor.manager);
    const ports = {
      authorize: async () => true,
      confirmTerminatedOwner: async (input: GenerationAdmissionInput) => ({
        predecessor: input,
        terminationEvidenceSha256: 'c'.repeat(64),
      }),
      reconcileEffects: async (input: GenerationAdmissionInput) => ({
        predecessor: input,
        checkpointWriteRevision: 0,
        effectsEvidenceSha256: 'd'.repeat(64),
      }),
    };
    return { ...successor, job, prior, ports, segment: randomUUID() };
  }

  it.each(['principal', 'tenant', 'namespace', 'request', 'epoch', 'provider', 'profile'])(
    'rejects a mismatched recovery %s before durable mutation',
    async (mismatch) => {
      const { manager, store, job, prior, ports, segment } = await recoveryFixture();
      if (!prior.continuation) throw new Error('Missing fixture checkpoint continuation');
      const invalid = { ...prior, continuation: { ...prior.continuation } };
      if (mismatch === 'principal') invalid.principalId = 'foreign';
      if (mismatch === 'tenant') invalid.tenantId = 'foreign';
      if (mismatch === 'namespace')
        invalid.continuation.checkpointNamespace = createCheckpointNamespace('owner', 'tenant');
      if (mismatch === 'request') invalid.clientRequestId = randomUUID();
      if (mismatch === 'epoch') invalid.generationEpoch++;
      if (mismatch === 'provider') invalid.segmentId = randomUUID();
      if (mismatch === 'profile')
        await store.updateJob(job.streamId, { scheduleId: 'unsupported' }, job.createdAt);
      const before = await store.getJob(job.streamId);
      if (mismatch === 'profile') expect(before!.scheduleId).toBe('unsupported');
      const recover = jest.spyOn(methods, 'recoverGenerationAdmission');
      const cas = jest.spyOn(store, 'transitionStatus');
      expect(
        await manager.recoverCheckpointGeneration(job.streamId, invalid, segment, ports),
      ).toBeUndefined();
      expect(recover).not.toHaveBeenCalled();
      expect(cas).not.toHaveBeenCalled();
      expect(await store.getJob(job.streamId)).toEqual(before);
      expect(await methods.getGenerationAdmission(prior)).toMatchObject({
        ok: true,
        value: { state: 'dispatching', processBootId: 'old-boot', segmentId: prior.segmentId },
      });
    },
  );

  it('keeps recovery HELD before the real CAS acknowledgment, then starts exactly once', async () => {
    const { manager, store, job, prior, ports, segment } = await recoveryFixture();
    const entered = deferred();
    const release = deferred();
    const transition = store.transitionStatus.bind(store);
    jest.spyOn(store, 'transitionStatus').mockImplementationOnce(async (...args) => {
      const result = await transition(...args);
      entered.resolve();
      await release.promise;
      return result;
    });
    const start = jest.spyOn(store, 'beginProviderExecution');
    const recovering = retain(
      manager,
      manager.recoverCheckpointGeneration(job.streamId, prior, segment, ports),
      release.resolve,
    );
    try {
      await entered.promise;
      expect(await store.getJob(job.streamId)).toMatchObject({
        providerExecutionId: segment,
        providerDrained: true,
        createdAt: job.createdAt,
      });
      expect(await manager.beginProviderExecution(job.streamId, job.createdAt, segment, true)).toBe(
        false,
      );
      expect(start).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    expect(await recovering).toBeDefined();
    expect(await manager.beginProviderExecution(job.streamId, job.createdAt, segment)).toBe(true);
    expect(await manager.beginProviderExecution(job.streamId, job.createdAt, segment)).toBe(false);
    expect(start).toHaveBeenCalledTimes(1);
    await finish(manager, job, segment);
  });

  it.each([
    'store false',
    'lost CAS reply',
    'membership failure',
    'shutdown',
    'source revoked',
    'conflicting ownership',
    'abort after coordinator reply',
  ])('holds actual Mongo/Valkey adoption after %s without another dispatch', async (failure) => {
    const { manager, store, job, prior, ports, segment } = await recoveryFixture(
      failure === 'source revoked',
    );
    const transition = store.transitionStatus.bind(store);
    if (failure === 'store false')
      jest.spyOn(store, 'transitionStatus').mockResolvedValueOnce(false);
    if (['lost CAS reply', 'shutdown', 'source revoked'].includes(failure)) {
      jest.spyOn(store, 'transitionStatus').mockImplementationOnce(async (...args) => {
        const result = await transition(...args);
        expect(result).toBe(true);
        if (failure === 'lost CAS reply') throw new Error('Lost acknowledged native CAS');
        if (failure === 'shutdown') manager.prepareForShutdown();
        if (failure === 'source revoked') {
          expect(await store.revokeSourceRetention(job.streamId, job.createdAt)).toBe(true);
          expect((await store.getJob(job.streamId))!.sourceRetentionRevokedAt).toEqual(
            expect.any(Number),
          );
        }
        return result;
      });
    }
    if (failure === 'membership failure') {
      jest
        .spyOn(
          store as unknown as { reconcileJobMembership: () => Promise<unknown> },
          'reconcileJobMembership',
        )
        .mockRejectedValueOnce(new Error('Membership write unavailable'));
    }
    if (failure === 'conflicting ownership')
      manager['ownedJobs'].set(job.streamId, job.createdAt + 1);
    if (failure === 'abort after coordinator reply') {
      const coordinator = manager['durableAdmission'];
      const recover = coordinator.recoverCheckpoint.bind(coordinator);
      jest.spyOn(coordinator, 'recoverCheckpoint').mockImplementationOnce(async (...args) => {
        const receipt = await recover(...args);
        expect(receipt).toBeDefined();
        manager['runtimeState'].get(job.streamId)!.abortController.abort();
        return receipt;
      });
    }
    expect(
      await manager.recoverCheckpointGeneration(job.streamId, prior, segment, ports),
    ).toBeUndefined();
    const start = jest.spyOn(store, 'beginProviderExecution');
    expect(await manager.beginProviderExecution(job.streamId, job.createdAt, segment, true)).toBe(
      false,
    );
    expect(start).not.toHaveBeenCalled();
    expect(await store.getJob(job.streamId)).toMatchObject({
      createdAt: job.createdAt,
      providerExecutionId: failure === 'store false' ? prior.segmentId : segment,
    });
    expect(await methods.getGenerationAdmission(prior)).toMatchObject({
      ok: true,
      value: { state: 'admitted', active: true, segmentId: segment },
    });
    expect((await manager.getGenerationAdmissionCensus()).unresolved).toBe(1);
    if (failure === 'conflicting ownership')
      expect(manager['ownedJobs'].get(job.streamId)).toBe(job.createdAt + 1);
    preserveHeld(manager);
  });

  it.each(['pending existing runtime', 'abort', 'runtime replacement', 'newer generation'])(
    'requires the exact completed native abort subscription after %s',
    async (failure) => {
      const { manager, store, transport, job, prior, ports, segment } = await recoveryFixture();
      const entered = deferred();
      const release = deferred();
      const subscribe = transport.onAbort.bind(transport);
      jest.spyOn(transport, 'onAbort').mockImplementationOnce(async (...args) => {
        const unsubscribe = await subscribe(...args);
        entered.resolve();
        await release.promise;
        return unsubscribe;
      });
      const cas = jest.spyOn(store, 'transitionStatus');
      const pending =
        failure === 'pending existing runtime'
          ? retain(manager, manager.getJob(job.streamId), release.resolve)
          : undefined;
      if (pending) await entered.promise;
      const recovering = retain(
        manager,
        manager.recoverCheckpointGeneration(job.streamId, prior, segment, ports),
        release.resolve,
      );
      let replacement;
      try {
        await entered.promise;
        const runtime = manager['runtimeState'].get(job.streamId)!;
        if (failure === 'abort') runtime.abortController.abort();
        if (failure === 'runtime replacement') {
          replacement = { ...runtime };
          manager['runtimeState'].set(job.streamId, replacement);
        }
        if (failure === 'newer generation') {
          const stored = await store.createJob(job.streamId, 'owner', job.streamId, 'tenant', {
            providerExecutionId: randomUUID(),
            providerDrained: true,
          });
          expect(stored.createdAt).toBeGreaterThan(job.createdAt);
          await manager.getJob(job.streamId);
          replacement = manager['runtimeState'].get(job.streamId)!;
          expect(replacement.abortController.signal.aborted).toBe(false);
          expect(typeof replacement.abortUnsubscribe).toBe('function');
        }
        if (pending) expect(await recovering).toBeUndefined();
      } finally {
        release.resolve();
      }
      await pending;
      expect(await recovering).toBeUndefined();
      expect(cas).not.toHaveBeenCalled();
      expect(await manager.beginProviderExecution(job.streamId, job.createdAt, segment)).toBe(
        false,
      );
      if (replacement) {
        expect(manager['runtimeState'].get(job.streamId)).toBe(replacement);
        expect(replacement.abortController.signal.aborted).toBe(false);
        if (failure === 'newer generation')
          expect(typeof replacement.abortUnsubscribe).toBe('function');
      }
      expect(await methods.getGenerationAdmission(prior)).toMatchObject({
        ok: true,
        value: { state: 'admitted', active: true, segmentId: segment },
      });
      preserveHeld(manager);
    },
  );
});
