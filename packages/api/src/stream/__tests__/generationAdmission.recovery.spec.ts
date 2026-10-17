import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createGenerationAdmissionMethods } from '@librechat/data-schemas';
import type { GenerationAdmissionInput, GenerationAdmissionMethods } from '@librechat/data-schemas';
import type { GenerationCheckpointRecoveryPorts } from '../generationAdmission';
import { GenerationAdmissionCoordinator } from '../generationAdmission';
import { getDurableAgentCheckpointer } from '~/agents/checkpointer';
import { createCheckpointNamespace } from '../checkpoints';

// Real Mongo admission and factory; only server-owned ACL/termination/effects
// evidence is controlled here. The separate two-process proof supplies actual joins.
describe('native checkpoint recovery coordinator', () => {
  let mongo: MongoMemoryReplSet;
  let methods: GenerationAdmissionMethods;
  const idle = { providerExecutions: 0, pendingWrites: 0, activeStreams: 0 };
  const checkpointNamespace = createCheckpointNamespace('owner', 'tenant');
  const scope = () => ({
    userId: 'owner',
    tenantId: 'tenant',
    threadId: 'conversation',
    checkpointNamespace,
  });
  const input = (): GenerationAdmissionInput => ({
    tenantId: 'tenant',
    principalId: 'owner',
    clientRequestId: 'request',
    conversationId: 'conversation',
    requestFingerprint: 'a'.repeat(64),
    protocol: '2',
    ownerInstanceId: 'old-pod',
    processBootId: 'old-boot',
    generationEpoch: 7,
    segmentId: 'old-segment',
    continuation: {
      version: 1,
      mode: 'checkpoint-only-v1',
      runId: 'response',
      threadId: 'conversation',
      checkpointNamespace: scope().checkpointNamespace,
      graphFingerprint: 'b'.repeat(64),
      policyFingerprint: 'c'.repeat(64),
    },
  });
  const ports = (): GenerationCheckpointRecoveryPorts => ({
    authorize: jest.fn(async () => true),
    confirmTerminatedOwner: jest.fn(async (predecessor) => ({
      predecessor,
      terminationEvidenceSha256: 'd'.repeat(64),
    })),
    reconcileEffects: jest.fn(async (predecessor) => ({
      predecessor,
      checkpointWriteRevision: 0,
      effectsEvidenceSha256: 'e'.repeat(64),
    })),
  });
  function coordinator(owner = 'new-pod') {
    const value = new GenerationAdmissionCoordinator();
    value.configure({
      required: true,
      methods,
      ownerInstanceId: owner,
      processBootId: 'new-boot',
      externalCensus: async () => ({ queuedContinuations: 0, pendingWrites: 0, complete: true }),
    });
    return value;
  }
  async function seed() {
    expect((await methods.acquireGenerationAdmission(input())).ok).toBe(true);
    expect((await methods.dispatchGenerationAdmission(input())).ok).toBe(true);
  }
  const dispatch = (owner: GenerationAdmissionCoordinator, segment: string) =>
    owner.authorize('conversation', 7, segment, 'owner', 'tenant', 'conversation', false);
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, ip: '127.0.0.1' } });
    await mongoose.connect(mongo.getUri(), { retryWrites: false });
    methods = createGenerationAdmissionMethods(mongoose);
    await methods.ensureGenerationAdmissionIndexes();
  }, 30_000);
  beforeEach(async () => {
    await mongoose.models.GenerationAdmission.deleteMany({});
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });

  it('admits only the acknowledged recovery winner and dispatches through the existing owner', async () => {
    await seed();
    const owners = [coordinator('new-a'), coordinator('new-b')];
    const results = await Promise.all(
      owners.map((owner, i) =>
        owner.recoverCheckpoint('conversation', input(), `next-${i}`, ports()),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results.findIndex(Boolean);
    expect(await dispatch(owners[1 - winner], `next-${1 - winner}`)).toBe(false);
    expect(await dispatch(owners[winner], `next-${winner}`)).toBe(true);
    expect(await dispatch(owners[winner], `next-${winner}`)).toBe(false);
    expect((await methods.dispatchGenerationAdmission(input())).ok).toBe(false);
    const row = await methods.getGenerationAdmission(input());
    expect(row).toMatchObject({
      ok: true,
      value: {
        state: 'dispatching',
        active: true,
        continuation: input().continuation,
        recoveries: [{ segmentId: 'old-segment' }],
      },
    });
    if (row.ok) expect(row.value?.terminal).toBeUndefined();
    expect(Object.isFrozen(results[winner])).toBe(true);
    expect(Object.isFrozen(results[winner]?.continuation)).toBe(true);
    await expect(
      getDurableAgentCheckpointer(scope(), undefined, results[winner]),
    ).resolves.toBeDefined();
    await expect(getDurableAgentCheckpointer(scope(), undefined, input())).rejects.toThrow(
      'active dispatch',
    );
  });

  it.each([
    'alive',
    'effects unknown',
    'access revoked',
    'foreign termination',
    'foreign effects',
    'malformed termination',
    'malformed effects',
    'invalid revision',
    'stale revision',
  ])('holds %s without a new dispatch', async (failure) => {
    await seed();
    const owner = coordinator();
    const proof = ports();
    if (failure === 'alive') proof.confirmTerminatedOwner = async () => null;
    if (failure === 'effects unknown') proof.reconcileEffects = async () => null;
    if (failure === 'access revoked') proof.authorize = async () => false;
    if (failure === 'foreign termination')
      proof.confirmTerminatedOwner = async () => ({
        predecessor: { ...input(), processBootId: 'foreign' },
        terminationEvidenceSha256: 'd'.repeat(64),
      });
    if (failure === 'foreign effects')
      proof.reconcileEffects = async () => ({
        predecessor: {
          ...input(),
          continuation: { ...input().continuation!, policyFingerprint: 'f'.repeat(64) },
        },
        checkpointWriteRevision: 0,
        effectsEvidenceSha256: 'e'.repeat(64),
      });
    if (failure === 'malformed termination')
      proof.confirmTerminatedOwner = async () => ({
        predecessor: input(),
        terminationEvidenceSha256: 'invalid',
      });
    if (failure === 'malformed effects')
      proof.reconcileEffects = async () => ({
        predecessor: input(),
        checkpointWriteRevision: 0,
        effectsEvidenceSha256: 'invalid',
      });
    if (failure === 'invalid revision' || failure === 'stale revision')
      proof.reconcileEffects = async () => ({
        predecessor: input(),
        checkpointWriteRevision: failure === 'invalid revision' ? NaN : 1,
        effectsEvidenceSha256: 'e'.repeat(64),
      });
    expect(await owner.recoverCheckpoint('conversation', input(), 'next', proof)).toBeUndefined();
    expect(await dispatch(owner, 'next')).toBe(false);
    expect(await methods.getGenerationAdmission(input())).toMatchObject({
      ok: true,
      value: {
        ownerInstanceId: 'old-pod',
        processBootId: 'old-boot',
        segmentId: 'old-segment',
        state: 'dispatching',
      },
    });
    expect((await owner.census(idle)).unresolved).toBe(0);
  });

  it('snapshots enrollment and nested continuation before the real acquire yields', async () => {
    const owner = coordinator();
    const binding = input().continuation!;
    const acquire = methods.acquireGenerationAdmission;
    const spy = jest
      .spyOn(methods, 'acquireGenerationAdmission')
      .mockImplementationOnce(async (received) => {
        expect(Object.isFrozen(received)).toBe(true);
        expect(Object.isFrozen(received.continuation)).toBe(true);
        (binding as { runId: string }).runId = 'mutated';
        await Promise.resolve();
        return acquire(received);
      });
    await owner.enroll(
      'conversation',
      7,
      'next',
      'owner',
      'tenant',
      'conversation',
      2,
      { clientRequestId: 'request', requestFingerprint: 'a'.repeat(64) },
      binding,
    );
    spy.mockRestore();
    expect(await methods.getGenerationAdmission(input())).toMatchObject({
      ok: true,
      value: { continuation: { runId: 'response' } },
    });
    expect(await dispatch(owner, 'next')).toBe(true);
  });

  it('snapshots predecessor and proof ports before awaits and revalidates access last', async () => {
    await seed();
    const owner = coordinator();
    const supplied = input();
    const proof = ports();
    const order: string[] = [];
    proof.confirmTerminatedOwner = async (received) => {
      order.push('terminated');
      expect(Object.isFrozen(received.continuation)).toBe(true);
      supplied.segmentId = 'changed';
      supplied.continuation = { ...supplied.continuation!, runId: 'changed' };
      proof.authorize = async () => false;
      return { predecessor: received, terminationEvidenceSha256: 'd'.repeat(64) };
    };
    proof.reconcileEffects = async (received) => {
      order.push('effects');
      return {
        predecessor: received,
        checkpointWriteRevision: 0,
        effectsEvidenceSha256: 'e'.repeat(64),
      };
    };
    proof.authorize = async () => {
      order.push('authorized');
      return true;
    };
    const recovered = await owner.recoverCheckpoint('conversation', supplied, 'next', proof);
    expect(recovered?.continuation?.runId).toBe('response');
    expect(order).toEqual(['terminated', 'effects', 'authorized']);
  });

  it('never grants or retries an unknown committed CAS and keeps it visible in drain', async () => {
    await seed();
    const owner = coordinator();
    const recover = methods.recoverGenerationAdmission;
    const spy = jest
      .spyOn(methods, 'recoverGenerationAdmission')
      .mockImplementationOnce(async (...args) => {
        expect((await recover(...args)).ok).toBe(true);
        return { ok: false, error: { code: 'OUTCOME_UNKNOWN' } };
      });
    expect(await owner.recoverCheckpoint('conversation', input(), 'next', ports())).toBeUndefined();
    expect(await owner.recoverCheckpoint('conversation', input(), 'next', ports())).toBeUndefined();
    expect(await dispatch(owner, 'next')).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await owner.census(idle)).unresolved).toBe(1);
    spy.mockRestore();
  });

  it('holds a thrown CAS without exposing storage errors or dropping the obligation', async () => {
    await seed();
    const owner = coordinator();
    const spy = jest
      .spyOn(methods, 'recoverGenerationAdmission')
      .mockRejectedValueOnce(new Error('private transport failure'));
    expect(await owner.recoverCheckpoint('conversation', input(), 'next', ports())).toBeUndefined();
    expect(await dispatch(owner, 'next')).toBe(false);
    expect((await owner.census(idle)).unresolved).toBe(1);
    spy.mockRestore();
  });

  it('tracks pending evidence, prevents duplicate callbacks and honors admission closure', async () => {
    await seed();
    const owner = coordinator();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const proof = ports();
    proof.confirmTerminatedOwner = jest.fn(async (predecessor) => {
      await barrier;
      return { predecessor, terminationEvidenceSha256: 'd'.repeat(64) };
    });
    const recovering = owner.recoverCheckpoint('conversation', input(), 'next', proof);
    expect((await owner.census(idle)).initializing).toBe(1);
    expect(await owner.recoverCheckpoint('conversation', input(), 'next', proof)).toBeUndefined();
    expect(proof.confirmTerminatedOwner).toHaveBeenCalledTimes(1);
    owner.close('maintenance');
    release();
    expect(await recovering).toBeUndefined();
    expect(proof.authorize).not.toHaveBeenCalled();
    expect((await owner.census(idle)).initializing).toBe(0);
    expect(await methods.getGenerationAdmission(input())).toMatchObject({
      ok: true,
      value: { state: 'dispatching', segmentId: 'old-segment' },
    });
  });

  it('retains a late acknowledged owner during closure for real cancellation, never dispatch', async () => {
    await seed();
    const owner = coordinator();
    const recover = methods.recoverGenerationAdmission;
    const spy = jest
      .spyOn(methods, 'recoverGenerationAdmission')
      .mockImplementationOnce(async (...args) => {
        const result = await recover(...args);
        owner.close('maintenance');
        return result;
      });
    expect(await owner.recoverCheckpoint('conversation', input(), 'next', ports())).toBeUndefined();
    expect(await dispatch(owner, 'next')).toBe(false);
    expect((await owner.census(idle)).unresolved).toBe(1);
    expect(await owner.cancel('conversation', 7, 'next')).toBe(true);
    expect((await owner.census(idle)).unresolved).toBe(0);
    spy.mockRestore();
  });

  it('refuses malformed/foreign/disabled/local-live recovery before calling proof ports', async () => {
    await seed();
    const owner = coordinator();
    const proof = ports();
    for (const [stream, predecessor, segment] of [
      ['other', input(), 'next'],
      ['conversation', { ...input(), continuation: undefined }, 'next'],
      ['conversation', input(), 'old-segment'],
      [
        'conversation',
        { ...input(), ownerInstanceId: 'new-pod', processBootId: 'new-boot' },
        'next',
      ],
    ] as const)
      expect(await owner.recoverCheckpoint(stream, predecessor, segment, proof)).toBeUndefined();
    const disabled = new GenerationAdmissionCoordinator();
    expect(
      await disabled.recoverCheckpoint('conversation', input(), 'next', proof),
    ).toBeUndefined();
    expect(proof.confirmTerminatedOwner).not.toHaveBeenCalled();
  });

  it('requires actual dispatch for a bound factory while preserving isolated raw storage callers', async () => {
    expect((await methods.acquireGenerationAdmission(input())).ok).toBe(true);
    await expect(getDurableAgentCheckpointer(scope(), undefined, input())).rejects.toThrow(
      'active dispatch',
    );
    await expect(getDurableAgentCheckpointer(scope())).resolves.toBeDefined();
    await expect(
      getDurableAgentCheckpointer({ ...scope(), userId: 'foreign' }, undefined, input()),
    ).rejects.toThrow();
    expect((await methods.dispatchGenerationAdmission(input())).ok).toBe(true);
    await expect(getDurableAgentCheckpointer(scope(), undefined, input())).resolves.toBeDefined();
  });
});
