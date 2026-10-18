import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { GenerationAdmissionInput } from '~/types/generationAdmission';
import { createGenerationAdmissionModel } from '~/models/generationAdmission';
import { createGenerationAdmissionMethods } from './generationAdmission';

/** Real isolated indexes/CAS, with native failpoints for uncertain committed acknowledgements. */
describe('durable generation admission', () => {
  let mongo: MongoMemoryReplSet;
  let methods: ReturnType<typeof createGenerationAdmissionMethods>;
  const input: GenerationAdmissionInput = {
    tenantId: 'tenant',
    principalId: 'principal',
    clientRequestId: 'request',
    conversationId: 'conversation',
    requestFingerprint: 'a'.repeat(64),
    protocol: 'v1',
    ownerInstanceId: 'pod',
    processBootId: 'boot',
    generationEpoch: 1,
    segmentId: 'segment',
  };
  const terminal = { outcome: 'completed' as const, evidenceSha256: 'b'.repeat(64) };
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
  });
  async function uncertain(command: string) {
    await mongoose.connection.db!.admin().command({
      configureFailPoint: 'failCommand',
      mode: { times: 1 },
      data: {
        failCommands: [command],
        writeConcernError: { code: 64, errmsg: 'injected uncertain acknowledgement' },
      },
    });
  }
  const preparation = () => {
    const { generationEpoch: _epoch, segmentId: _segment, ...identity } = input;
    return { ...identity, preparationAttemptId: 'exact-native-claim-token' };
  };
  const continuation = () => ({
    version: 1 as const,
    mode: 'checkpoint-only-v1' as const,
    runId: 'run',
    threadId: input.conversationId,
    checkpointNamespace: 'private-namespace',
    graphFingerprint: 'c'.repeat(64),
    policyFingerprint: 'd'.repeat(64),
    sourceBindingSha256: 'e'.repeat(64),
  });
  it('holds preparation without inventing an epoch and admits only the exact completed attempt', async () => {
    const attempt = preparation();
    expect((await methods.beginGenerationPreparation!(attempt)).ok).toBe(true);
    const held = await mongoose.models.GenerationAdmission.findOne({}).lean();
    expect(held).toMatchObject({
      state: 'preparing',
      preparationAttemptId: attempt.preparationAttemptId,
    });
    expect(held).not.toHaveProperty('generationEpoch');
    expect(held).not.toHaveProperty('segmentId');
    expect(await methods.getGenerationAdmission(input)).toEqual({
      ok: false,
      error: { code: 'HELD' },
    });
    expect((await methods.acquireGenerationAdmission(input)).ok).toBe(false);
    expect((await methods.completeGenerationPreparation!(attempt, continuation())).ok).toBe(true);
    expect(
      (
        await methods.acquireGenerationAdmission(
          { ...input, continuation: continuation() },
          { ...attempt, preparationAttemptId: 'other' },
        )
      ).ok,
    ).toBe(false);
    const admitted = await methods.acquireGenerationAdmission(
      { ...input, continuation: continuation() },
      attempt,
    );
    expect(admitted.ok && admitted.value.acquired).toBe(true);
    expect(
      (await methods.dispatchGenerationAdmission({ ...input, continuation: continuation() })).ok,
    ).toBe(true);
  });
  it.each(['begin', 'complete'] as const)(
    'retains a lost %s preparation acknowledgement across fresh method instances',
    async (stage) => {
      const attempt = preparation();
      if (stage === 'complete') await methods.beginGenerationPreparation!(attempt);
      await uncertain(stage === 'begin' ? 'insert' : 'findAndModify');
      const result =
        stage === 'begin'
          ? await methods.beginGenerationPreparation!(attempt)
          : await methods.completeGenerationPreparation!(attempt, continuation());
      expect(result).toEqual({ ok: false, error: { code: 'OUTCOME_UNKNOWN' } });
      const fresh = createGenerationAdmissionMethods(mongoose);
      expect(await fresh.getGenerationAdmission(input)).toEqual({
        ok: false,
        error: { code: 'HELD' },
      });
      expect(
        (
          await fresh.beginGenerationPreparation!({
            ...attempt,
            preparationAttemptId: 'replacement',
          })
        ).ok,
      ).toBe(false);
      expect((await fresh.acquireGenerationAdmission(input)).ok).toBe(false);
      expect((await fresh.dispatchGenerationAdmission(input)).ok).toBe(false);
      expect(await mongoose.models.GenerationAdmission.countDocuments({ active: true })).toBe(1);
    },
  );
  it('acquires once across concurrent owners and returns plain same-request receipts', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        methods.acquireGenerationAdmission({ ...input, ownerInstanceId: `pod${i}` }),
      ),
    );
    expect(results.filter((r) => r.ok && r.value.acquired)).toHaveLength(1);
    expect(results.every((r) => r.ok)).toBe(true);
    const record = await methods.getGenerationAdmission(input);
    expect(record.ok && record.value).not.toHaveProperty('_id');
    expect(await mongoose.models.GenerationAdmission.countDocuments({})).toBe(1);
  });
  it('serializes distinct requests in a conversation but isolates tenant and principal', async () => {
    expect((await methods.acquireGenerationAdmission(input)).ok).toBe(true);
    expect(
      await methods.acquireGenerationAdmission({ ...input, clientRequestId: 'different' }),
    ).toEqual({ ok: false, error: { code: 'CONVERSATION_ACTIVE' } });
    expect((await methods.acquireGenerationAdmission({ ...input, principalId: 'other' })).ok).toBe(
      true,
    );
    expect((await methods.acquireGenerationAdmission({ ...input, tenantId: 'other' })).ok).toBe(
      true,
    );
    expect(await methods.getGenerationAdmission({ ...input, tenantId: 'absent' })).toEqual({
      ok: true,
      value: null,
    });
  });
  it.each(['conversationId', 'requestFingerprint', 'protocol'] as const)(
    'rejects request reuse with changed %s',
    async (field) => {
      await methods.acquireGenerationAdmission(input);
      expect(
        await methods.acquireGenerationAdmission({
          ...input,
          [field]: field === 'requestFingerprint' ? 'c'.repeat(64) : 'different',
        }),
      ).toEqual({ ok: false, error: { code: 'REQUEST_CONFLICT' } });
    },
  );
  it('authorizes only one dispatch and fences every owner and segment field', async () => {
    await methods.acquireGenerationAdmission(input);
    for (const field of ['ownerInstanceId', 'processBootId', 'segmentId'] as const) {
      expect((await methods.dispatchGenerationAdmission({ ...input, [field]: 'wrong' })).ok).toBe(
        false,
      );
    }
    expect((await methods.dispatchGenerationAdmission({ ...input, generationEpoch: 2 })).ok).toBe(
      false,
    );
    const results = await Promise.all(
      Array.from({ length: 10 }, () => methods.dispatchGenerationAdmission(input)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(
      (await methods.acquireGenerationAdmission({ ...input, ownerInstanceId: 'replacement' })).ok,
    ).toBe(true);
    expect(
      (await methods.dispatchGenerationAdmission({ ...input, ownerInstanceId: 'replacement' })).ok,
    ).toBe(false);
  });
  it('retains uncertain acquisition and never permits duplicate dispatch', async () => {
    await uncertain('insert');
    expect(await methods.acquireGenerationAdmission(input)).toEqual({
      ok: false,
      error: { code: 'OUTCOME_UNKNOWN' },
    });
    const replay = await methods.acquireGenerationAdmission(input);
    expect(replay.ok && replay.value.acquired).toBe(false);
  });
  it('holds a dispatch whose write committed but acknowledgement failed', async () => {
    await methods.acquireGenerationAdmission(input);
    await uncertain('findAndModify');
    expect(await methods.dispatchGenerationAdmission(input)).toEqual({
      ok: false,
      error: { code: 'OUTCOME_UNKNOWN' },
    });
    expect((await methods.dispatchGenerationAdmission(input)).ok).toBe(false);
    expect(
      (await methods.acquireGenerationAdmission({ ...input, clientRequestId: 'new' })).ok,
    ).toBe(false);
    const row = await methods.getGenerationAdmission(input);
    expect(row.ok && row.value?.state).toBe('dispatching');
  });
  it('releases only the exact dispatched segment after terminal evidence', async () => {
    await methods.acquireGenerationAdmission(input);
    expect((await methods.settleGenerationAdmission(input, terminal)).ok).toBe(false);
    await methods.dispatchGenerationAdmission(input);
    expect(
      (await methods.settleGenerationAdmission({ ...input, segmentId: 'wrong' }, terminal)).ok,
    ).toBe(false);
    expect((await methods.settleGenerationAdmission(input, terminal)).ok).toBe(true);
    expect(
      (await methods.acquireGenerationAdmission({ ...input, clientRequestId: 'new' })).ok,
    ).toBe(true);
    expect((await methods.dispatchGenerationAdmission(input)).ok).toBe(false);
  });
  it('does not report known settlement after an uncertain terminal acknowledgement', async () => {
    await methods.acquireGenerationAdmission(input);
    await methods.dispatchGenerationAdmission(input);
    await uncertain('findAndModify');
    expect(await methods.settleGenerationAdmission(input, terminal)).toEqual({
      ok: false,
      error: { code: 'OUTCOME_UNKNOWN' },
    });
    expect((await methods.dispatchGenerationAdmission(input)).ok).toBe(false);
  });
  it('requires exact settled proof and admits only one concurrent successor', async () => {
    const next = { ownerInstanceId: 'next-pod', processBootId: 'next-boot', segmentId: 'next' };
    await methods.acquireGenerationAdmission(input);
    expect((await methods.acquireGenerationAdmissionSuccessor(input, terminal, next)).ok).toBe(
      false,
    );
    await methods.dispatchGenerationAdmission(input);
    expect((await methods.acquireGenerationAdmissionSuccessor(input, terminal, next)).ok).toBe(
      false,
    );
    await methods.settleGenerationAdmission(input, terminal);
    expect(
      (
        await methods.acquireGenerationAdmissionSuccessor(
          input,
          { ...terminal, evidenceSha256: 'c'.repeat(64) },
          next,
        )
      ).ok,
    ).toBe(false);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        methods.acquireGenerationAdmissionSuccessor(input, terminal, {
          ...next,
          segmentId: `next${i}`,
        }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const winner = results.find((result) => result.ok);
    if (!winner?.ok) throw new Error('Missing successor');
    expect(winner.value.predecessors).toEqual([
      expect.objectContaining({
        ownerInstanceId: input.ownerInstanceId,
        segmentId: input.segmentId,
        terminal,
      }),
    ]);
    expect(winner.value.clientRequestId).toBe(input.clientRequestId);
    expect(winner.value.generationEpoch).toBe(input.generationEpoch);
    expect((await methods.dispatchGenerationAdmission(input)).ok).toBe(false);
    expect((await methods.dispatchGenerationAdmission(winner.value)).ok).toBe(true);
    await methods.settleGenerationAdmission(winner.value, terminal);
    expect(
      (await methods.acquireGenerationAdmissionSuccessor(winner.value, terminal, input)).ok,
    ).toBe(false);
  });
  it('keeps successor acquisition uncertain and preserves another active request', async () => {
    const next = { ownerInstanceId: 'next', processBootId: 'boot2', segmentId: 'segment2' };
    await methods.acquireGenerationAdmission(input);
    await methods.dispatchGenerationAdmission(input);
    await methods.settleGenerationAdmission(input, terminal);
    await methods.acquireGenerationAdmission({ ...input, clientRequestId: 'other' });
    expect(await methods.acquireGenerationAdmissionSuccessor(input, terminal, next)).toEqual({
      ok: false,
      error: { code: 'CONVERSATION_ACTIVE' },
    });
    const other = { ...input, clientRequestId: 'other' };
    await methods.dispatchGenerationAdmission(other);
    await methods.settleGenerationAdmission(other, terminal);
    await uncertain('findAndModify');
    expect(await methods.acquireGenerationAdmissionSuccessor(input, terminal, next)).toEqual({
      ok: false,
      error: { code: 'OUTCOME_UNKNOWN' },
    });
    expect((await methods.acquireGenerationAdmissionSuccessor(input, terminal, next)).ok).toBe(
      false,
    );
    const stored = await methods.getGenerationAdmission(input);
    expect(stored.ok && stored.value?.predecessors).toHaveLength(1);
  });
  it('does not expire unresolved work or expose database failure details', async () => {
    const Model = createGenerationAdmissionModel(mongoose);
    const indexes = await Model.listIndexes();
    expect(indexes.some((index) => 'expireAfterSeconds' in index)).toBe(false);
    await methods.acquireGenerationAdmission(input);
    const spy = jest.spyOn(Model, 'create').mockRejectedValueOnce(new Error('secret query text'));
    await expect(
      methods.acquireGenerationAdmission({ ...input, tenantId: 'other' }),
    ).rejects.toThrow('Generation admission storage unavailable');
    spy.mockRestore();
    expect(
      (await methods.acquireGenerationAdmission({ ...input, clientRequestId: 'new' })).ok,
    ).toBe(false);
  });
  it('cancels only the exact admitted owner and keeps dispatched outcomes active', async () => {
    await methods.acquireGenerationAdmission(input);
    expect(await methods.countUnsettledGenerationAdmissions('pod')).toEqual({ ok: true, value: 1 });
    expect(
      (await methods.cancelUndispatchedGenerationAdmission({ ...input, processBootId: 'other' }))
        .ok,
    ).toBe(false);
    expect((await methods.cancelUndispatchedGenerationAdmission(input)).ok).toBe(true);
    expect(await methods.countUnsettledGenerationAdmissions('pod')).toEqual({ ok: true, value: 0 });
    const next = { ...input, clientRequestId: 'next', generationEpoch: 2 };
    await methods.acquireGenerationAdmission(next);
    await methods.dispatchGenerationAdmission(next);
    expect((await methods.cancelUndispatchedGenerationAdmission(next)).ok).toBe(false);
    expect(await methods.countUnsettledGenerationAdmissions('pod')).toEqual({ ok: true, value: 1 });
  });
  it('binds epoch lookup to trusted tenant, principal and conversation and rejects ambiguity', async () => {
    await methods.acquireGenerationAdmission(input);
    expect((await methods.findGenerationAdmissionByEpoch(input)).ok).toBe(true);
    expect(await methods.findGenerationAdmissionByEpoch({ ...input, tenantId: 'foreign' })).toEqual(
      { ok: true, value: null },
    );
    expect(
      await methods.findGenerationAdmissionByEpoch({ ...input, principalId: 'foreign' }),
    ).toEqual({ ok: true, value: null });
    await methods.cancelUndispatchedGenerationAdmission(input);
    await methods.acquireGenerationAdmission({ ...input, clientRequestId: 'different' });
    expect(await methods.findGenerationAdmissionByEpoch(input)).toEqual({
      ok: false,
      error: { code: 'HELD' },
    });
  });
  it('does not acknowledge an uncertain committed cancellation', async () => {
    await methods.acquireGenerationAdmission(input);
    await uncertain('findAndModify');
    expect(await methods.cancelUndispatchedGenerationAdmission(input)).toEqual({
      ok: false,
      error: { code: 'OUTCOME_UNKNOWN' },
    });
    expect((await methods.dispatchGenerationAdmission(input)).ok).toBe(false);
  });
  it('rejects malformed identities and terminal evidence before writing', async () => {
    expect((await methods.acquireGenerationAdmission({ ...input, principalId: '' })).ok).toBe(
      false,
    );
    expect((await methods.acquireGenerationAdmission({ ...input, generationEpoch: NaN })).ok).toBe(
      false,
    );
    expect(
      (await methods.settleGenerationAdmission(input, { ...terminal, evidenceSha256: 'bad' })).ok,
    ).toBe(false);
    expect(await mongoose.models.GenerationAdmission.countDocuments({})).toBe(0);
  });
});
