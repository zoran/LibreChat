import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createGenerationAdmissionMethods } from '@librechat/data-schemas';
import { RedisEventTransport } from '../implementations/RedisEventTransport';
import { GenerationJobManagerClass } from '../GenerationJobManager';
import { generationRequestBinding } from '../generationAdmission';

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
  function manager(instance = 'pod') {
    const m = new GenerationJobManagerClass({ cleanupOnComplete: false });
    m.configureGenerationAdmission({
      required: true,
      methods,
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
  it('resumes only a proven settled predecessor and preserves the request identity', async () => {
    const m = manager();
    const job = await m.createJob('conversation', 'principal', 'conversation', {
      ...options(),
      trustedTenantId: 'tenant',
    });
    const first = job.metadata.providerExecutionId!;
    expect(await m.beginProviderExecution(job.streamId, job.createdAt, first)).toBe(true);
    await m.completeJob(job.streamId, undefined, job.createdAt);
    expect(await m.settleGenerationExecution(job.streamId, job.createdAt, first)).toBe(true);
    await m
      .getJobStore()
      .updateJob(
        job.streamId,
        { status: 'running', providerExecutionId: 'resume', providerDrained: true },
        job.createdAt,
      );
    expect(await m.beginProviderExecution(job.streamId, job.createdAt, 'resume', true)).toBe(true);
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
      predecessors: [{ segmentId: first }],
    });
    expect(await m.beginProviderExecution(job.streamId, job.createdAt, 'resume', true)).toBe(false);
    expect(await m.cancelGenerationInitialization(job.streamId, job.createdAt, 'resume')).toBe(
      false,
    );
    await m.completeJob(job.streamId, undefined, job.createdAt);
    expect(await m.settleGenerationExecution(job.streamId, job.createdAt, 'resume')).toBe(true);
  });
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
