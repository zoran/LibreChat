import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createGenerationAdmissionMethods } from '@librechat/data-schemas';
import type { GenerationCheckpointBinding } from '@librechat/data-schemas';
import type { CreateGenerationJobOptions } from '../GenerationJobManager';
import type { SerializableJobData } from '../interfaces/IJobStore';
import { buildPendingAction, buildToolApprovalPayload } from '~/agents/hitl/policy';
import { RedisEventTransport } from '../implementations/RedisEventTransport';
import { GenerationJobManagerClass } from '../GenerationJobManager';
import { generationRequestBinding } from '../generationAdmission';
import { createCheckpointNamespace } from '../checkpoints';

describe('generation owner durable integration', () => {
  let mongo: MongoMemoryReplSet;
  const managers: GenerationJobManagerClass[] = [];
  let methods: ReturnType<typeof createGenerationAdmissionMethods>;
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      replSet: { count: 1, ip: '127.0.0.1' },
      instanceOpts: [{ args: ['--setParameter', 'enableTestCommands=1'] }],
    });
    await mongoose.connect(mongo.getUri(), { retryWrites: false });
    methods = createGenerationAdmissionMethods(mongoose);
    await methods.ensureGenerationAdmissionIndexes();
  }, 30_000);
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });
  beforeEach(async () => {
    await mongoose.models.GenerationAdmission.deleteMany({});
  });
  afterEach(async () => {
    await mongoose.connection
      .db!.admin()
      .command({ configureFailPoint: 'failCommand', mode: 'off' });
    for (const manager of managers.splice(0)) await manager.destroy();
  });
  function manager(instance = 'pod', ownerMethods = methods) {
    const m = new GenerationJobManagerClass({ cleanupOnComplete: false });
    m.configureGenerationAdmission({
      required: true,
      methods: ownerMethods,
      ownerInstanceId: instance,
      processBootId: 'boot',
      externalCensus: async () => ({ queuedContinuations: 0, pendingWrites: 0, complete: true }),
    });
    managers.push(m);
    return m;
  }
  const options = () => ({
    generationAdmission: generationRequestBinding('request', { text: 'hello' }),
  });
  const checkpoint = (): GenerationCheckpointBinding => ({
    version: 1,
    runId: 'initial-run',
    threadId: 'conversation',
    checkpointNamespace: createCheckpointNamespace('principal', 'tenant'),
    graphFingerprint: 'a'.repeat(64),
    policyFingerprint: 'b'.repeat(64),
    mode: 'checkpoint-only-v1',
    sourceBindingSha256: 'c'.repeat(64),
  });
  const checkpointOptions = (): CreateGenerationJobOptions => ({
    ...options(),
    trustedTenantId: 'tenant',
    checkpointContinuation: checkpoint(),
  });

  it('consumes only its acknowledged preparation and blocks claim takeover and generic release', async () => {
    const m = manager();
    const binding = options().generationAdmission!;
    const claim = await m.claimGeneration(
      'principal',
      'request',
      'conversation',
      'conversation',
      2,
      binding,
    );
    const existingClaimToken = claim.existing!.claimToken!;
    const source = jest.fn(async () => ({
      ...checkpoint(),
      checkpointNamespace: createCheckpointNamespace('principal'),
    }));
    const preparation = await m.prepareCheckpointGeneration(
      'principal',
      'conversation',
      binding,
      existingClaimToken,
      source,
    );
    const fresh = manager('replacement');
    await expect(
      fresh.claimGeneration('principal', 'request', 'conversation', 'conversation', 2, binding),
    ).rejects.toThrow();
    await expect(
      m.takeoverGeneration('principal', 'request', 'conversation', claim.existing!),
    ).rejects.toThrow();
    await expect(
      m.releaseGeneration('principal', 'request', 'conversation', claim.existing!),
    ).rejects.toThrow();
    await expect(
      m.createJob('conversation', 'principal', 'conversation', {
        generationAdmission: binding,
        checkpointContinuation: preparation.continuation,
        generationPreparation: { ...preparation },
        idempotencyClientRequestId: 'request',
        idempotencyClaimToken: existingClaimToken,
      }),
    ).rejects.toThrow();
    const job = await m.createJob('conversation', 'principal', 'conversation', {
      generationAdmission: binding,
      checkpointContinuation: preparation.continuation,
      generationPreparation: preparation,
      idempotencyClientRequestId: 'request',
      idempotencyClaimToken: existingClaimToken,
    });
    expect(
      await m.beginProviderExecution(
        job.streamId,
        job.createdAt,
        job.metadata.providerExecutionId!,
      ),
    ).toBe(true);
    expect(source).toHaveBeenCalledTimes(1);
    expect(await mongoose.models.GenerationAdmission.findOne({}).lean()).toMatchObject({
      state: 'dispatching',
      generationEpoch: job.createdAt,
      segmentId: job.metadata.providerExecutionId,
    });
  });

  it.each(['begin', 'complete', 'source'] as const)(
    'holds an uncertain %s preparation across retry, takeover and cleanup',
    async (stage) => {
      const committedReplyLost = async <T>(operation: () => Promise<T>): Promise<T> => {
        const value = await operation();
        expect(value).toMatchObject({ ok: true });
        throw new Error('injected lost response after actual preparation commit');
      };
      const m = manager('pod', {
        ...methods,
        ...(stage === 'begin'
          ? {
              beginGenerationPreparation: (input) =>
                committedReplyLost(() => methods.beginGenerationPreparation!(input)),
            }
          : {}),
        ...(stage === 'complete'
          ? {
              completeGenerationPreparation: (input, binding) =>
                committedReplyLost(() => methods.completeGenerationPreparation!(input, binding)),
            }
          : {}),
      });
      const binding = options().generationAdmission!;
      const claim = await m.claimGeneration(
        'principal',
        'request',
        'conversation',
        'conversation',
        2,
        binding,
      );
      const source = jest.fn(async () => {
        if (stage === 'source') throw new Error('source capture outcome unknown');
        return { ...checkpoint(), checkpointNamespace: createCheckpointNamespace('principal') };
      });
      await expect(
        m.prepareCheckpointGeneration(
          'principal',
          'conversation',
          binding,
          claim.existing!.claimToken!,
          source,
        ),
      ).rejects.toThrow();
      expect(source).toHaveBeenCalledTimes(stage === 'begin' ? 0 : 1);
      expect(await mongoose.models.GenerationAdmission.countDocuments({ active: true })).toBe(1);
      const fresh = manager('replacement');
      await expect(
        fresh.claimGeneration('principal', 'request', 'conversation', 'conversation', 2, binding),
      ).rejects.toThrow();
      await expect(
        m.takeoverGeneration('principal', 'request', 'conversation', claim.existing!),
      ).rejects.toThrow();
      await expect(
        m.releaseGeneration('principal', 'request', 'conversation', claim.existing!),
      ).rejects.toThrow();
      expect(await m.getJobStore().getJob('conversation')).toBeNull();
    },
  );

  it('enrolls the actual native epoch, segment and namespace before checkpoint dispatch', async () => {
    const m = manager();
    const input = checkpointOptions();
    const job = await m.createJob('conversation', 'principal', 'conversation', input);
    expect(job.metadata).toMatchObject({
      generationProtocolVersion: 2,
      checkpointNamespace: input.checkpointContinuation!.checkpointNamespace,
    });
    const identity = {
      tenantId: 'tenant',
      principalId: 'principal',
      conversationId: 'conversation',
      generationEpoch: job.createdAt,
      segmentId: job.metadata.providerExecutionId,
      ownerInstanceId: 'pod',
      processBootId: 'boot',
      continuation: input.checkpointContinuation,
    };
    expect(await mongoose.models.GenerationAdmission.findOne({}).lean()).toMatchObject({
      ...identity,
      state: 'admitted',
      active: true,
    });
    await m.updateMetadata(
      job.streamId,
      { checkpointNamespace: createCheckpointNamespace('principal', 'tenant') },
      job.createdAt,
    );
    expect(await m.getJobStore().getJob(job.streamId)).toMatchObject({
      checkpointNamespace: input.checkpointContinuation!.checkpointNamespace,
      providerDrained: true,
    });
    expect(
      await m.beginProviderExecution(
        job.streamId,
        job.createdAt,
        job.metadata.providerExecutionId!,
      ),
    ).toBe(true);
    expect(await mongoose.models.GenerationAdmission.findOne({}).lean()).toMatchObject({
      ...identity,
      state: 'dispatching',
      active: true,
    });
  });

  it('captures continuation, request and tenant before the replay check yields', async () => {
    const m = manager();
    const input = checkpointOptions();
    const expected = {
      continuation: { ...input.checkpointContinuation! },
      ...input.generationAdmission!,
      tenantId: 'tenant',
    };
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const checking = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const get = methods.getGenerationAdmission;
    jest.spyOn(methods, 'getGenerationAdmission').mockImplementationOnce(async (query) => {
      entered();
      await barrier;
      return get(query);
    });
    const creating = m.createJob('conversation', 'principal', 'conversation', input);
    await checking;
    Object.assign(input.checkpointContinuation!, {
      runId: 'changed',
      threadId: 'changed',
      checkpointNamespace: createCheckpointNamespace('other', 'other'),
      graphFingerprint: 'd'.repeat(64),
      policyFingerprint: 'e'.repeat(64),
      sourceBindingSha256: 'f'.repeat(64),
    });
    Object.assign(input.generationAdmission!, {
      clientRequestId: 'changed',
      requestFingerprint: 'f'.repeat(64),
    });
    input.generationAdmission = generationRequestBinding('replaced', { text: 'changed' });
    input.checkpointContinuation = checkpoint();
    input.trustedTenantId = 'other';
    input.initialMetadata = { generationProtocolVersion: 1 };
    release();
    const job = await creating;
    expect(job.metadata.checkpointNamespace).toBe(expected.continuation.checkpointNamespace);
    expect(await mongoose.models.GenerationAdmission.findOne({}).lean()).toMatchObject({
      ...expected,
      generationEpoch: job.createdAt,
      segmentId: job.metadata.providerExecutionId,
    });
    expect(
      await m.beginProviderExecution(
        job.streamId,
        job.createdAt,
        job.metadata.providerExecutionId!,
      ),
    ).toBe(true);
  });

  it.each(['option', 'binding', 'request'] as const)(
    'rejects a checkpoint %s accessor without invoking it or creating a job',
    async (field) => {
      const m = manager();
      const input = checkpointOptions();
      const getter = jest.fn(() => 'untrusted');
      if (field === 'option')
        Object.defineProperty(input, 'checkpointContinuation', { get: getter });
      if (field === 'binding')
        Object.defineProperty(input.checkpointContinuation!, 'runId', { get: getter });
      if (field === 'request')
        Object.defineProperty(input.generationAdmission!, 'clientRequestId', { get: getter });
      const create = jest.spyOn(m.getJobStore(), 'createJob');
      const acquire = jest.spyOn(methods, 'acquireGenerationAdmission');
      await expect(m.createJob('conversation', 'principal', 'conversation', input)).rejects.toThrow(
        /checkpoint binding/,
      );
      expect(getter).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
    },
  );

  it.each([
    'foreign owner',
    'foreign tenant',
    'wrong thread',
    'wrong conversation',
    'legacy protocol',
    'missing request',
    'optional admission',
    'schedule',
    'agent event',
    'schedule reconciliation',
    'recovered steer',
  ])('rejects %s before native creation or admission', async (reason) => {
    const m = manager();
    const input = checkpointOptions();
    let conversation = 'conversation';
    if (reason === 'foreign owner')
      input.checkpointContinuation = {
        ...checkpoint(),
        checkpointNamespace: createCheckpointNamespace('other', 'tenant'),
      };
    if (reason === 'foreign tenant') input.trustedTenantId = 'other';
    if (reason === 'wrong thread')
      input.checkpointContinuation = { ...checkpoint(), threadId: 'other' };
    if (reason === 'wrong conversation') conversation = 'other';
    if (reason === 'legacy protocol') input.initialMetadata = { generationProtocolVersion: 1 };
    if (reason === 'missing request') delete input.generationAdmission;
    if (reason === 'optional admission')
      m.configureGenerationAdmission({
        required: false,
        methods,
        ownerInstanceId: 'pod',
        processBootId: 'boot',
      });
    if (reason === 'schedule') input.initialMetadata = { scheduleId: 'schedule' };
    if (reason === 'agent event') input.initialMetadata = { agentEventDeliveryKey: 'event' };
    if (reason === 'schedule reconciliation')
      input.initialMetadata = { preserveForScheduleReconcile: true };
    if (reason === 'recovered steer') input.recoveredSteerId = 'steer';
    const create = jest.spyOn(m.getJobStore(), 'createJob');
    const acquire = jest.spyOn(methods, 'acquireGenerationAdmission');
    await expect(m.createJob('conversation', 'principal', conversation, input)).rejects.toThrow(
      /checkpoint binding/,
    );
    expect(create).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(await mongoose.models.GenerationAdmission.countDocuments({})).toBe(0);
  });

  it('recovers a lost native creation reply only with the captured checkpoint namespace', async () => {
    const m = manager();
    const input = checkpointOptions();
    const store = m.getJobStore();
    const create = store.createJob.bind(store);
    jest.spyOn(store, 'createJob').mockImplementationOnce(async (...args) => {
      await create(...args);
      throw new Error('lost create reply');
    });
    const job = await m.createJob('conversation', 'principal', 'conversation', input);
    expect(await store.getJob(job.streamId)).toMatchObject({
      createdAt: job.createdAt,
      checkpointNamespace: input.checkpointContinuation!.checkpointNamespace,
    });
    expect(await mongoose.models.GenerationAdmission.findOne({}).lean()).toMatchObject({
      continuation: input.checkpointContinuation,
      generationEpoch: job.createdAt,
      segmentId: job.metadata.providerExecutionId,
    });
    expect(
      await m.beginProviderExecution(
        job.streamId,
        job.createdAt,
        job.metadata.providerExecutionId!,
      ),
    ).toBe(true);
  });

  it.each([
    ['namespace', false],
    ['namespace', true],
    ['protocol', false],
    ['protocol', true],
  ] as const)(
    'rejects an adapter that ignores the %s binding (lost reply: %s)',
    async (field, lostReply) => {
      const m = manager();
      const input = checkpointOptions();
      const store = m.getJobStore();
      const create = store.createJob.bind(store);
      jest.spyOn(store, 'createJob').mockImplementationOnce(async (...args) => {
        args[13] = undefined;
        if (field === 'protocol') args[4] = { ...args[4], generationProtocolVersion: 1 };
        const job = await create(...args);
        if (lostReply) throw new Error('lost create reply');
        return job;
      });
      await expect(
        m.createJob('conversation', 'principal', 'conversation', input),
      ).rejects.toThrow();
      const stored = await store.getJob('conversation');
      expect(stored).toMatchObject({ status: 'error', providerDrained: true });
      expect(stored!.checkpointNamespace).not.toBe(
        input.checkpointContinuation!.checkpointNamespace,
      );
      expect(await mongoose.models.GenerationAdmission.countDocuments({})).toBe(0);
      expect(
        await m.beginProviderExecution(
          'conversation',
          stored!.createdAt,
          stored!.providerExecutionId!,
        ),
      ).toBe(false);
    },
  );

  it.each(['another creation attempt', 'a superseding generation'])(
    'does not recover %s after a lost checkpoint creation reply',
    async (reason) => {
      const m = manager();
      const input = checkpointOptions();
      const store = m.getJobStore();
      const create = store.createJob.bind(store);
      const acquire = jest.spyOn(methods, 'acquireGenerationAdmission');
      jest.spyOn(store, 'createJob').mockImplementationOnce(async (...args) => {
        if (reason === 'a superseding generation') await create(...args);
        args[10] = 'another-creation-attempt';
        args[4] = { ...args[4], providerExecutionId: 'another-provider-segment' };
        if (reason === 'a superseding generation')
          args[13] = createCheckpointNamespace('principal', 'tenant');
        await create(...args);
        throw new Error('lost create reply');
      });
      await expect(m.createJob('conversation', 'principal', 'conversation', input)).rejects.toThrow(
        'lost create reply',
      );
      expect(acquire).not.toHaveBeenCalled();
      expect(await mongoose.models.GenerationAdmission.countDocuments({})).toBe(0);
      const stored = await store.getJob('conversation');
      expect(stored).toMatchObject({
        status: 'running',
        providerExecutionId: 'another-provider-segment',
        providerDrained: true,
      });
      expect(
        await m.beginProviderExecution(
          'conversation',
          stored!.createdAt,
          stored!.providerExecutionId!,
        ),
      ).toBe(false);
    },
  );

  it('retains an unknown checkpoint enrollment as an unresolved obligation and denies dispatch', async () => {
    const m = manager();
    const input = checkpointOptions();
    const acquire = methods.acquireGenerationAdmission;
    jest.spyOn(methods, 'acquireGenerationAdmission').mockImplementationOnce(async (identity) => {
      await acquire(identity);
      return { ok: false, error: { code: 'OUTCOME_UNKNOWN', message: 'lost admission reply' } };
    });
    await expect(m.createJob('conversation', 'principal', 'conversation', input)).rejects.toThrow(
      'held',
    );
    const stored = await m.getJobStore().getJob('conversation');
    expect(stored).toMatchObject({
      status: 'running',
      checkpointNamespace: input.checkpointContinuation!.checkpointNamespace,
    });
    expect(
      await m.beginProviderExecution(
        'conversation',
        stored!.createdAt,
        stored!.providerExecutionId!,
      ),
    ).toBe(false);
    expect((await m.getGenerationAdmissionCensus()).unresolved).toBe(1);
    expect(await mongoose.models.GenerationAdmission.findOne({}).lean()).toMatchObject({
      continuation: input.checkpointContinuation,
      state: 'admitted',
      active: true,
    });
  });
  it('never invokes a second provider when Redis job and claim projections are lost', async () => {
    const first = manager();
    const peer = manager('peer');
    const provider = jest.fn(async () => 'answer');
    const job = await first.createJob('conversation', 'principal', 'conversation', options());
    if (
      await first.beginProviderExecution(
        job.streamId,
        job.createdAt,
        job.metadata.providerExecutionId!,
      )
    ) {
      await provider();
    }
    await expect(
      peer.createJob('conversation', 'principal', 'conversation', options()),
    ).rejects.toThrow('held');
    expect(provider).toHaveBeenCalledTimes(1);
    expect((await first.getGenerationAdmissionCensus()).unresolved).toBe(1);
  });
  it('holds uncertain committed dispatch without invoking a provider or reporting drained', async () => {
    const m = manager();
    const provider = jest.fn();
    const job = await m.createJob('conversation', 'principal', 'conversation', options());
    await mongoose.connection.db!.admin().command({
      configureFailPoint: 'failCommand',
      mode: { times: 1 },
      data: {
        failCommands: ['findAndModify'],
        writeConcernError: { code: 64, errmsg: 'unknown' },
      },
    });
    if (
      await m.beginProviderExecution(job.streamId, job.createdAt, job.metadata.providerExecutionId!)
    )
      provider();
    expect(provider).not.toHaveBeenCalled();
    await m.completeJob(job.streamId, undefined, job.createdAt);
    expect(
      await m.settleGenerationExecution(
        job.streamId,
        job.createdAt,
        job.metadata.providerExecutionId!,
      ),
    ).toBe(false);
    expect((await m.getGenerationAdmissionCensus()).unresolved).toBeGreaterThan(0);
  });
  it.each([
    ['complete', 'completed'],
    ['error', 'failed'],
    ['aborted', 'cancelled'],
  ] as const)('persists native %s execution as %s', async (status, outcome) => {
    const m = manager();
    const job = await m.createJob('conversation', 'principal', 'conversation', {
      ...options(),
      trustedTenantId: 'tenant',
    });
    const segment = job.metadata.providerExecutionId!;
    expect(await m.beginProviderExecution(job.streamId, job.createdAt, segment)).toBe(true);
    if (status === 'aborted') {
      expect((await m.abortJob(job.streamId, { expectedCreatedAt: job.createdAt })).success).toBe(
        true,
      );
    } else {
      expect(
        await m.completeJob(
          job.streamId,
          status === 'error' ? 'provider failed' : undefined,
          job.createdAt,
        ),
      ).toBe(true);
    }
    expect(await m.getJobStatus(job.streamId)).toBe(status);
    expect(await m.settleGenerationExecution(job.streamId, job.createdAt, segment)).toBe(true);
    const record = await methods.findGenerationAdmissionByEpoch({
      tenantId: 'tenant',
      principalId: 'principal',
      conversationId: 'conversation',
      generationEpoch: job.createdAt,
    });
    expect(record.ok && record.value).toMatchObject({
      state: 'settled',
      terminal: { outcome, evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(await m.getJobStatus(job.streamId)).toBe(status);
    expect(await m.getGenerationAdmissionCensus()).toMatchObject({
      providerExecutions: 0,
      unresolved: 0,
      complete: true,
    });
  });
  it.each(['running', 'unknown'])('holds a %s status before provider drain', async (status) => {
    const m = manager();
    const job = await m.createJob('conversation', 'principal', 'conversation', options());
    const segment = job.metadata.providerExecutionId!;
    expect(await m.beginProviderExecution(job.streamId, job.createdAt, segment)).toBe(true);
    // A persisted unknown status must not be interpreted as a successful segment.
    await m
      .getJobStore()
      .updateJob(job.streamId, { status: status as SerializableJobData['status'] }, job.createdAt);
    expect(await m.settleGenerationExecution(job.streamId, job.createdAt, segment)).toBe(false);
    expect(await m.getJobStore().getJob(job.streamId)).toMatchObject({ providerDrained: false });
    expect(await mongoose.models.GenerationAdmission.findOne({}).lean()).toMatchObject({
      state: 'dispatching',
      active: true,
    });
    expect((await m.getGenerationAdmissionCensus()).unresolved).toBe(1);
  });
  it.each(['terminalPersistencePending', 'terminalHostActionPending'] as const)(
    'holds a terminal error while %s remains unresolved',
    async (pending) => {
      const m = manager();
      const job = await m.createJob('conversation', 'principal', 'conversation', options());
      const segment = job.metadata.providerExecutionId!;
      expect(await m.beginProviderExecution(job.streamId, job.createdAt, segment)).toBe(true);
      expect(await m.completeJob(job.streamId, 'provider failed', job.createdAt)).toBe(true);
      await m.getJobStore().updateJob(job.streamId, { [pending]: true }, job.createdAt);
      expect(await m.settleGenerationExecution(job.streamId, job.createdAt, segment)).toBe(false);
      expect(await mongoose.models.GenerationAdmission.findOne({}).lean()).toMatchObject({
        state: 'dispatching',
        active: true,
      });
      await m.getJobStore().updateJob(job.streamId, { [pending]: false }, job.createdAt);
      expect(await m.settleGenerationExecution(job.streamId, job.createdAt, segment)).toBe(true);
      expect(await mongoose.models.GenerationAdmission.findOne({}).lean()).toMatchObject({
        state: 'settled',
        terminal: { outcome: 'failed' },
      });
    },
  );
  it('holds the admission when the provider drain is not acknowledged', async () => {
    const m = manager();
    const job = await m.createJob('conversation', 'principal', 'conversation', options());
    const segment = job.metadata.providerExecutionId!;
    expect(await m.beginProviderExecution(job.streamId, job.createdAt, segment)).toBe(true);
    await m.completeJob(job.streamId, 'provider failed', job.createdAt);
    jest.spyOn(m.getJobStore(), 'markProviderExecutionDrained').mockResolvedValueOnce(false);
    expect(await m.settleGenerationExecution(job.streamId, job.createdAt, segment)).toBe(false);
    expect(await mongoose.models.GenerationAdmission.findOne({}).lean()).toMatchObject({
      state: 'dispatching',
      active: true,
    });
    expect((await m.getGenerationAdmissionCensus()).unresolved).toBe(1);
  });
  it.each(['running', 'complete', 'error', 'aborted'] as const)(
    'preserves ordinary %s execution drain when durable admission is disabled',
    async (status) => {
      const m = new GenerationJobManagerClass({ cleanupOnComplete: false });
      managers.push(m);
      const job = await m.createJob('conversation', 'principal', 'conversation');
      const segment = job.metadata.providerExecutionId!;
      expect(await m.beginProviderExecution(job.streamId, job.createdAt, segment)).toBe(true);
      if (status === 'aborted') {
        await m.abortJob(job.streamId, { expectedCreatedAt: job.createdAt });
      } else if (status !== 'running') {
        await m.completeJob(
          job.streamId,
          status === 'error' ? 'provider failed' : undefined,
          job.createdAt,
        );
      }
      expect(await m.settleGenerationExecution(job.streamId, job.createdAt, segment)).toBe(true);
      expect(await m.getJobStore().getJob(job.streamId)).toMatchObject({
        status,
        providerDrained: true,
      });
      expect(await mongoose.models.GenerationAdmission.countDocuments({})).toBe(0);
    },
  );
  it('does not settle or drain before real trailing writes finish', async () => {
    const m = manager();
    const job = await m.createJob('conversation', 'principal', 'conversation', options());
    await m.beginProviderExecution(job.streamId, job.createdAt, job.metadata.providerExecutionId!);
    const provider = jest.fn(async () => 'answer');
    await provider();
    await m.completeJob(job.streamId, undefined, job.createdAt);
    let finish!: () => void;
    const late = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const settlement = m.settleGenerationExecution(
      job.streamId,
      job.createdAt,
      job.metadata.providerExecutionId!,
      [late],
    );
    m.closeGenerationAdmission('maintenance');
    expect((await m.getGenerationAdmissionCensus()).unresolved).toBe(1);
    finish();
    expect(await settlement).toBe(true);
    expect(await m.getGenerationAdmissionCensus()).toMatchObject({
      admissionClosed: true,
      initializing: 0,
      providerExecutions: 0,
      unresolved: 0,
      complete: true,
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('failed trailing history cannot become durable settlement via generic tracker cleanup', async () => {
    const m = manager();
    const job = await m.createJob('conversation', 'principal', 'conversation', options());
    await m.beginProviderExecution(job.streamId, job.createdAt, job.metadata.providerExecutionId!);
    await m.completeJob(job.streamId, undefined, job.createdAt);
    expect(
      await m.settleGenerationExecution(
        job.streamId,
        job.createdAt,
        job.metadata.providerExecutionId!,
        [Promise.reject(new Error('history failed'))],
      ),
    ).toBe(false);
    m.abandonProviderExecution(job.streamId, job.createdAt, job.metadata.providerExecutionId!);
    expect((await m.getGenerationAdmissionCensus()).unresolved).toBe(1);
  });
  it('retains rejected original writes even when the caller logs and resolves them', async () => {
    const m = manager();
    const job = await m.createJob('conversation', 'principal', 'conversation', options());
    const segment = job.metadata.providerExecutionId!;
    await m.beginProviderExecution(job.streamId, job.createdAt, segment);
    const logged = m
      .observeGenerationWrite(
        job.streamId,
        job.createdAt,
        segment,
        Promise.reject(new Error('title failed')),
      )
      .catch(() => undefined);
    await logged;
    await m.completeJob(job.streamId, undefined, job.createdAt);
    expect(await m.settleGenerationExecution(job.streamId, job.createdAt, segment, [logged])).toBe(
      false,
    );
    expect((await m.getGenerationAdmissionCensus()).unresolved).toBe(1);
  });
  it('releases exact never-dispatched admission and fences new initialization synchronously', async () => {
    const m = manager();
    const job = await m.createJob('conversation', 'principal', 'conversation', options());
    expect(await m.cancelGenerationInitialization(job.streamId, job.createdAt, 'wrong')).toBe(
      false,
    );
    expect(
      await m.cancelGenerationInitialization(
        job.streamId,
        job.createdAt,
        job.metadata.providerExecutionId!,
      ),
    ).toBe(true);
    expect(m.closeGenerationAdmission('owner')).toBe(true);
    expect(m.reopenGenerationAdmission('wrong')).toBe(false);
    await expect(m.createJob('other', 'principal', 'other', options())).rejects.toThrow('held');
    expect((await m.getGenerationAdmissionCensus()).unresolved).toBe(0);
  });
  it('selected mode refuses missing ports and cannot invent external queue coverage', async () => {
    const m = manager();
    m.configureGenerationAdmission({
      required: true,
      ownerInstanceId: 'pod',
      processBootId: 'boot',
    });
    await expect(
      m.createJob('conversation', 'principal', 'conversation', options()),
    ).rejects.toThrow('held');
    expect((await m.getGenerationAdmissionCensus()).complete).toBe(false);
    expect(await m.getGenerationRuntimeHealth()).toBe(false);
  });
  it('observes initialization admitted before closure and rejects later work without a race', async () => {
    const m = manager();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquire = methods.acquireGenerationAdmission;
    const spy = jest
      .spyOn(methods, 'acquireGenerationAdmission')
      .mockImplementationOnce(async (input) => {
        await barrier;
        return acquire(input);
      });
    const creating = m.createJob('conversation', 'principal', 'conversation', options());
    while (!spy.mock.calls.length) await new Promise((resolve) => setImmediate(resolve));
    m.closeGenerationAdmission('maintenance');
    expect((await m.getGenerationAdmissionCensus()).initializing).toBe(1);
    await expect(m.createJob('other', 'principal', 'other', options())).rejects.toThrow('held');
    release();
    const job = await creating;
    spy.mockRestore();
    expect(
      await m.beginProviderExecution(
        job.streamId,
        job.createdAt,
        job.metadata.providerExecutionId!,
      ),
    ).toBe(false);
    await m.completeJob(job.streamId, undefined, job.createdAt);
    expect(
      await m.settleGenerationExecution(
        job.streamId,
        job.createdAt,
        job.metadata.providerExecutionId!,
      ),
    ).toBe(true);
    expect(await m.getGenerationAdmissionCensus()).toMatchObject({
      initializing: 0,
      unresolved: 0,
      complete: true,
    });
  });
  it.each(['complete', 'requires_action'] as const)(
    'resumes only a proven %s predecessor and preserves the request identity',
    async (status) => {
      const m = manager();
      const job = await m.createJob('conversation', 'principal', 'conversation', {
        ...options(),
        trustedTenantId: 'tenant',
      });
      const first = job.metadata.providerExecutionId!;
      expect(await m.beginProviderExecution(job.streamId, job.createdAt, first)).toBe(true);
      const action = buildPendingAction(
        buildToolApprovalPayload([
          { name: 'shell', arguments: { command: 'ls' }, tool_call_id: 'call_approval' },
        ]),
        {
          streamId: job.streamId,
          conversationId: 'conversation',
          runId: 'run',
          responseMessageId: 'response',
        },
      );
      if (status === 'requires_action') {
        expect(
          await m.approvals.pause(job.streamId, action, {
            expectedCreatedAt: job.createdAt,
            persistencePending: true,
          }),
        ).toBe(true);
        expect(await m.settleGenerationExecution(job.streamId, job.createdAt, first)).toBe(false);
        expect(
          await m.approvals.finishPausePersistence(job.streamId, action.actionId, job.createdAt),
        ).toBe(true);
      } else {
        await m.completeJob(job.streamId, undefined, job.createdAt);
      }
      expect(await m.settleGenerationExecution(job.streamId, job.createdAt, first)).toBe(true);
      expect(await m.getJobStatus(job.streamId)).toBe(status);
      if (status === 'requires_action') {
        expect(await m.getJobStore().getJob(job.streamId)).toMatchObject({ pendingAction: action });
        expect(
          await m.approvals.resolve(
            job.streamId,
            action.actionId,
            { providerExecutionId: 'resume', providerDrained: true },
            job.createdAt,
          ),
        ).toBe(true);
      } else {
        await m
          .getJobStore()
          .updateJob(
            job.streamId,
            { status: 'running', providerExecutionId: 'resume', providerDrained: true },
            job.createdAt,
          );
        // A raw store rewrite cannot reacquire the completed manager's native ownership.
        expect(await m.beginProviderExecution(job.streamId, job.createdAt, 'resume', true)).toBe(
          false,
        );
        expect(await m.getJobStore().getJob(job.streamId)).toMatchObject({ providerDrained: true });
        const retained = await methods.findGenerationAdmissionByEpoch({
          tenantId: 'tenant',
          principalId: 'principal',
          conversationId: 'conversation',
          generationEpoch: job.createdAt,
        });
        expect(retained.ok && retained.value).toMatchObject({ state: 'settled', segmentId: first });
        return;
      }
      expect(await m.beginProviderExecution(job.streamId, job.createdAt, 'resume', true)).toBe(
        true,
      );
      const record = await methods.findGenerationAdmissionByEpoch({
        tenantId: 'tenant',
        principalId: 'principal',
        conversationId: 'conversation',
        generationEpoch: job.createdAt,
      });
      expect(record.ok && record.value).toMatchObject({
        clientRequestId: 'request',
        segmentId: 'resume',
        state: 'dispatching',
        predecessors: [{ segmentId: first, terminal: { outcome: 'completed' } }],
      });
      expect(await m.beginProviderExecution(job.streamId, job.createdAt, 'resume', true)).toBe(
        false,
      );
      expect(await m.cancelGenerationInitialization(job.streamId, job.createdAt, 'resume')).toBe(
        false,
      );
      await m.completeJob(job.streamId, undefined, job.createdAt);
      expect(await m.settleGenerationExecution(job.streamId, job.createdAt, 'resume')).toBe(true);
    },
  );
  it('hashes stable exact payloads and preserves real subscriber readiness', () => {
    expect(generationRequestBinding('r', { a: 1, b: 2 })).toEqual(
      generationRequestBinding('r', { b: 2, a: 1 }),
    );
    expect(generationRequestBinding('r', { a: 2 })).not.toEqual(
      generationRequestBinding('r', { a: 1 }),
    );
    const fixture = {
      publisher: { status: 'ready' },
      subscriber: { status: 'ready' },
      channelSubscriptions: new Map([['events', { phase: 'active' }]]),
    };
    expect(RedisEventTransport.prototype.isGenerationTransportReady.call(fixture)).toBe(true);
    fixture.subscriber.status = 'reconnecting';
    expect(RedisEventTransport.prototype.isGenerationTransportReady.call(fixture)).toBe(false);
    fixture.subscriber.status = 'ready';
    fixture.channelSubscriptions.set('events', { phase: 'pending' });
    expect(RedisEventTransport.prototype.isGenerationTransportReady.call(fixture)).toBe(false);
  });
});

describe('external work census composition', () => {
  it('forwards the actual application callback through startup and counts it once', async () => {
    const { createAppMaintenance, initializeMaintenanceGeneration } = await import(
      '../../app/maintenance'
    );
    const { GenerationAdmissionCoordinator } = await import('../generationAdmission');
    const coordinator = new GenerationAdmissionCoordinator();
    const methods = createGenerationAdmissionMethods(mongoose);
    const ensure = jest
      .spyOn(methods, 'ensureGenerationAdmissionIndexes')
      .mockResolvedValue(undefined);
    jest
      .spyOn(methods, 'countUnsettledGenerationAdmissions')
      .mockResolvedValue({ ok: true, value: 0 });
    let closed = false;
    let complete = true;
    let queued = 2;
    let writes = 3;
    let generationWrites = 5;
    const app = createAppMaintenance({
      env: {},
      requiredSharedState: false,
      startupReady: () => true,
      probeDatabase: async () => true,
      probeSharedState: async () => true,
      workOwners: {
        actualOwner: {
          pauseAdmissions: () => {
            closed = true;
            return true;
          },
          resumeAdmissions: () => {
            closed = false;
            return true;
          },
          getMaintenanceCensus: async () => ({
            admissionClosed: closed,
            queuedContinuations: queued,
            pendingWrites: writes,
            complete,
          }),
        },
      },
      unqualifiedOwners: [],
      generation: {
        closeGenerationAdmission: (id) => coordinator.close(id),
        reopenGenerationAdmission: (id) => coordinator.reopen(id),
        getGenerationAdmissionCensus: () =>
          coordinator.census({
            providerExecutions: 0,
            pendingWrites: generationWrites,
            activeStreams: 0,
          }),
        getGenerationRuntimeHealth: async () => true,
      },
    });
    await initializeMaintenanceGeneration({
      required: true,
      methods,
      identity: app.identity,
      externalCensus: app.externalCensus,
      configure: (config) => coordinator.configure(config),
    });
    expect(ensure).toHaveBeenCalledTimes(1);
    app.operation('begin', {
      requestId: 'maintenance',
      expectedRevision: 0,
      identity: app.identity,
    });
    expect(await app.status()).toMatchObject({
      known: true,
      phase: 'quiescing',
      census: { queuedContinuations: 2, pendingWrites: 8 },
    });
    queued = 0;
    writes = 0;
    generationWrites = 0;
    expect(await app.status()).toMatchObject({ known: true, phase: 'drained' });
    complete = false;
    expect((await app.status()).known).toBe(false);
  });
});
