import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type {
  GenerationAdmissionInput,
  GenerationAdmissionRecord,
  GenerationAdmissionResult,
  GenerationCheckpointRecoveryEvidence,
} from '~/types/generationAdmission';
import {
  createGenerationAdmissionMethods,
  snapshotGenerationCheckpointAdmission,
} from './generationAdmission';

/** Real Mongo transactions/CAS. Evidence digests are synthetic trusted-server inputs;
 * these tests do not certify a process join or remote side-effect reconciliation. */
describe('native checkpoint generation recovery', () => {
  let mongo: MongoMemoryReplSet;
  let methods: ReturnType<typeof createGenerationAdmissionMethods>;
  const input = () =>
    ({
      tenantId: 'recovery-tenant',
      principalId: 'recovery-principal',
      clientRequestId: 'request',
      conversationId: 'conversation',
      requestFingerprint: 'a'.repeat(64),
      protocol: 'v1',
      ownerInstanceId: 'old-pod',
      processBootId: 'old-boot',
      generationEpoch: 1,
      segmentId: 'old-segment',
      continuation: {
        version: 1,
        runId: 'run',
        threadId: 'conversation',
        checkpointNamespace: 'private-root',
        graphFingerprint: 'b'.repeat(64),
        policyFingerprint: 'c'.repeat(64),
        mode: 'checkpoint-only-v1',
      },
    }) satisfies GenerationAdmissionInput;
  const evidence = (checkpointWriteRevision = 0): GenerationCheckpointRecoveryEvidence => ({
    checkpointWriteRevision,
    terminationEvidenceSha256: 'd'.repeat(64),
    effectsEvidenceSha256: 'e'.repeat(64),
  });
  const successor = {
    ownerInstanceId: 'new-pod',
    processBootId: 'new-boot',
    segmentId: 'new-segment',
  };
  const terminal = { outcome: 'completed' as const, evidenceSha256: 'f'.repeat(64) };
  const artifacts = () =>
    mongoose.connection.db!.collection<{ _id: string; owner: string }>('test_checkpoint_artifacts');
  const unwrap = <T>(result: GenerationAdmissionResult<T>): T => {
    if (!result.ok) throw new Error(`Unexpected test outcome ${result.error.code}`);
    return result.value;
  };
  async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Controlled transaction boundary missing')),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const read = async (): Promise<GenerationAdmissionRecord> => {
    const value = unwrap(await methods.getGenerationAdmission(input()));
    if (value == null) throw new Error('Expected actual stored admission');
    return value;
  };
  async function dispatch(bound: GenerationAdmissionInput = input()) {
    expect(unwrap(await methods.acquireGenerationAdmission(bound)).acquired).toBe(true);
    return unwrap(await methods.dispatchGenerationAdmission(bound));
  }
  async function uncertain(command: string) {
    await mongoose.connection.db!.admin().command({
      configureFailPoint: 'failCommand',
      mode: { times: 1 },
      data: {
        failCommands: [command],
        writeConcernError: { code: 64, errmsg: 'synthetic lost acknowledgement' },
      },
    });
  }
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      replSet: { count: 1, ip: '127.0.0.1' },
      instanceOpts: [{ args: ['--setParameter', 'enableTestCommands=1'] }],
    });
    await mongoose.connect(mongo.getUri(), { retryWrites: false, monitorCommands: true });
    methods = createGenerationAdmissionMethods(mongoose);
    await methods.ensureGenerationAdmissionIndexes();
    await artifacts().insertOne({ _id: 'initialize', owner: 'fixture' });
  }, 30_000);
  afterAll(async () => {
    try {
      await mongoose.disconnect();
    } finally {
      await mongo?.stop();
    }
  });
  beforeEach(async () => {
    await mongoose.models.GenerationAdmission.deleteMany({});
    await artifacts().deleteMany({});
  });
  afterEach(async () => {
    await mongoose.connection
      .db!.admin()
      .command({ configureFailPoint: 'failCommand', mode: 'off' });
    jest.restoreAllMocks();
  });

  const sourceInput = () => ({
    ...input(),
    continuation: { ...input().continuation, sourceBindingSha256: '1'.repeat(64) },
  });

  it('retains the source binding through immutable capture, real writes, reads and recovery', async () => {
    const supplied = sourceInput();
    const expected = sourceInput();
    const snapshot = snapshotGenerationCheckpointAdmission(supplied);
    expect(Object.isFrozen(snapshot.continuation)).toBe(true);
    const acquisition = methods.acquireGenerationAdmission(supplied);
    supplied.continuation.sourceBindingSha256 = '2'.repeat(64);
    expect(snapshot.continuation).toEqual(expected.continuation);
    expect(unwrap(await acquisition).record.continuation).toEqual(expected.continuation);
    expect(unwrap(await methods.acquireGenerationAdmission(expected)).acquired).toBe(false);
    expect(unwrap(await methods.dispatchGenerationAdmission(expected)).continuation).toEqual(
      expected.continuation,
    );
    expect(
      unwrap(
        await methods.writeGenerationCheckpoint(expected, async (session) => {
          await artifacts().insertOne(
            { _id: 'source-checkpoint', owner: 'old-segment' },
            { session },
          );
          return 'committed';
        }),
      ),
    ).toBe('committed');
    expect(await read()).toMatchObject({
      continuation: expected.continuation,
      checkpointWriteRevision: 1,
    });
    expect(
      unwrap(
        await methods.findGenerationAdmissionByEpoch({
          tenantId: expected.tenantId,
          principalId: expected.principalId,
          conversationId: expected.conversationId,
          generationEpoch: expected.generationEpoch,
        }),
      )?.continuation,
    ).toEqual(expected.continuation);
    const recovered = unwrap(
      await methods.recoverGenerationAdmission(expected, evidence(1), successor),
    );
    expect(recovered.continuation).toEqual(expected.continuation);
    expect(unwrap(await methods.dispatchGenerationAdmission(recovered)).state).toBe('dispatching');
    expect(
      unwrap(
        await methods.writeGenerationCheckpoint(recovered, async (session) => {
          await artifacts().insertOne(
            { _id: 'recovered-source-checkpoint', owner: 'new-segment' },
            { session },
          );
          return 'resumed';
        }),
      ),
    ).toBe('resumed');
    expect(await artifacts().countDocuments({})).toBe(2);
    const stale = jest.fn(async () => 'never');
    expect(await methods.writeGenerationCheckpoint(expected, stale)).toEqual({
      ok: false,
      error: { code: 'HELD' },
    });
    expect(stale).not.toHaveBeenCalled();
    expect(await read()).toMatchObject({
      continuation: expected.continuation,
      checkpointWriteRevision: 2,
    });
  });

  it.each(['changed', 'removed', 'added'] as const)(
    'rejects a %s source binding at every admission and continuation CAS',
    async (change) => {
      const original: GenerationAdmissionInput = change === 'added' ? input() : sourceInput();
      const altered =
        change === 'removed'
          ? input()
          : {
              ...input(),
              continuation: { ...input().continuation, sourceBindingSha256: '2'.repeat(64) },
            };
      unwrap(await methods.acquireGenerationAdmission(original));
      expect(await methods.acquireGenerationAdmission(altered)).toEqual({
        ok: false,
        error: { code: 'REQUEST_CONFLICT' },
      });
      expect(await methods.dispatchGenerationAdmission(altered)).toEqual({
        ok: false,
        error: { code: 'HELD' },
      });
      expect(await methods.cancelUndispatchedGenerationAdmission(altered)).toEqual({
        ok: false,
        error: { code: 'HELD' },
      });
      unwrap(await methods.dispatchGenerationAdmission(original));
      const callback = jest.fn(async () => 'never');
      expect(await methods.writeGenerationCheckpoint(altered, callback)).toEqual({
        ok: false,
        error: { code: 'HELD' },
      });
      expect(await methods.recoverGenerationAdmission(altered, evidence(), successor)).toEqual({
        ok: false,
        error: { code: 'HELD' },
      });
      expect(await methods.settleGenerationAdmission(altered, terminal)).toEqual({
        ok: false,
        error: { code: 'HELD' },
      });
      expect(callback).not.toHaveBeenCalled();
      expect(await read()).toMatchObject({
        continuation: original.continuation,
        checkpointWriteRevision: 0,
        state: 'dispatching',
      });
      unwrap(await methods.settleGenerationAdmission(original, terminal));
      expect(
        await methods.acquireGenerationAdmissionSuccessor(altered, terminal, successor),
      ).toEqual({ ok: false, error: { code: 'HELD' } });
      expect(
        unwrap(await methods.acquireGenerationAdmissionSuccessor(original, terminal, successor))
          .continuation,
      ).toEqual(original.continuation);
    },
  );

  it.each(['', 'A'.repeat(64), '1'.repeat(63), '1'.repeat(65), null, 42, {}, []])(
    'rejects malformed source binding %p before any checkpoint callback',
    async (invalid) => {
      const supplied = sourceInput();
      Object.defineProperty(supplied.continuation, 'sourceBindingSha256', { value: invalid });
      const callback = jest.fn(async () => 'never');
      expect(() => snapshotGenerationCheckpointAdmission(supplied)).toThrow(
        'Invalid generation checkpoint admission',
      );
      for (const result of [
        await methods.acquireGenerationAdmission(supplied),
        await methods.dispatchGenerationAdmission(supplied),
        await methods.cancelUndispatchedGenerationAdmission(supplied),
        await methods.settleGenerationAdmission(supplied, terminal),
        await methods.acquireGenerationAdmissionSuccessor(supplied, terminal, successor),
        await methods.writeGenerationCheckpoint(supplied, callback),
        await methods.recoverGenerationAdmission(supplied, evidence(), successor),
      ])
        expect(result).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(callback).not.toHaveBeenCalled();
      expect(await mongoose.models.GenerationAdmission.countDocuments({})).toBe(0);
    },
  );

  it('rejects a source binding accessor without invoking it at any admission entry', async () => {
    const supplied = sourceInput();
    const getter = jest.fn(() => '1'.repeat(64));
    Object.defineProperty(supplied.continuation, 'sourceBindingSha256', { get: getter });
    const callback = jest.fn(async () => 'never');
    expect(() => snapshotGenerationCheckpointAdmission(supplied)).toThrow(
      'Invalid generation checkpoint admission',
    );
    for (const result of [
      await methods.acquireGenerationAdmission(supplied),
      await methods.dispatchGenerationAdmission(supplied),
      await methods.cancelUndispatchedGenerationAdmission(supplied),
      await methods.settleGenerationAdmission(supplied, terminal),
      await methods.acquireGenerationAdmissionSuccessor(supplied, terminal, successor),
      await methods.writeGenerationCheckpoint(supplied, callback),
      await methods.recoverGenerationAdmission(supplied, evidence(), successor),
    ])
      expect(result).toEqual({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(getter).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it('rejects malformed source binding in the native Mongo schema', async () => {
    const supplied = sourceInput();
    supplied.continuation.sourceBindingSha256 = 'A'.repeat(64);
    await expect(
      mongoose.models.GenerationAdmission.create({
        ...supplied,
        state: 'admitted',
        active: true,
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ name: 'ValidationError' });
    expect(await mongoose.models.GenerationAdmission.countDocuments({})).toBe(0);
  });

  it('persists the detached immutable binding before dispatch and rejects a changed binding', async () => {
    const supplied = input();
    const expected = { ...supplied.continuation };
    const acquisition = methods.acquireGenerationAdmission(supplied);
    if (!supplied.continuation) throw new Error('Missing fixture binding');
    supplied.continuation.runId = 'mutated-after-call';
    const acquired = unwrap(await acquisition);
    expect(acquired.acquired).toBe(true);
    expect(acquired.record).toMatchObject({
      state: 'admitted',
      continuation: expected,
      checkpointWriteRevision: 0,
    });
    expect((await read()).continuation).toEqual(expected);
    expect(await methods.acquireGenerationAdmission(supplied)).toEqual({
      ok: false,
      error: { code: 'REQUEST_CONFLICT' },
    });
    expect((await methods.dispatchGenerationAdmission(supplied)).ok).toBe(false);
    expect(unwrap(await methods.dispatchGenerationAdmission(input())).state).toBe('dispatching');
  });

  it('detaches and freezes the canonical checkpoint admission before callers can mutate it', () => {
    const supplied = input();
    const snapshot = snapshotGenerationCheckpointAdmission(supplied);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.continuation)).toBe(true);
    supplied.ownerInstanceId = 'mutated-owner';
    supplied.continuation.runId = 'mutated-run';
    expect(snapshot).toMatchObject({ ownerInstanceId: 'old-pod', continuation: { runId: 'run' } });
  });

  it.each([
    'root-accessor',
    'nested-accessor',
    'root-prototype',
    'nested-prototype',
    'root-symbol',
    'nested-symbol',
  ] as const)(
    'rejects %s without executing getters or checkpoint callbacks',
    async (malformation) => {
      const supplied = input();
      const nested = malformation.startsWith('nested');
      const target = nested ? supplied.continuation : supplied;
      const getter = jest.fn(() => 'synthetic getter');
      if (malformation.endsWith('accessor'))
        Object.defineProperty(target, nested ? 'runId' : 'ownerInstanceId', { get: getter });
      else if (malformation.endsWith('prototype')) Object.setPrototypeOf(target, { foreign: true });
      else Object.defineProperty(target, Symbol('foreign'), { value: true });
      expect(() => snapshotGenerationCheckpointAdmission(supplied)).toThrow(
        'Invalid generation checkpoint admission',
      );
      const callback = jest.fn(async () => 'never');
      expect(await methods.writeGenerationCheckpoint(supplied, callback)).toEqual({
        ok: false,
        error: { code: 'INVALID_INPUT' },
      });
      expect(await methods.recoverGenerationAdmission(supplied, evidence(), successor)).toEqual({
        ok: false,
        error: { code: 'INVALID_INPUT' },
      });
      expect(getter).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();
    },
  );

  it('requires the continuation thread to match the admitted conversation before any callback', async () => {
    await dispatch();
    const supplied = input();
    supplied.continuation.threadId = 'another-conversation';
    const callback = jest.fn(async () => 'never');
    expect(() => snapshotGenerationCheckpointAdmission(supplied)).toThrow(
      'Invalid generation checkpoint admission',
    );
    expect(await methods.writeGenerationCheckpoint(supplied, callback)).toEqual({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    expect(await methods.recoverGenerationAdmission(supplied, evidence(), successor)).toEqual({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not reuse a native checkpoint namespace under another request or graph binding', async () => {
    await dispatch();
    await methods.settleGenerationAdmission(input(), terminal);
    const other = {
      ...input(),
      clientRequestId: 'other-request',
      continuation: {
        ...input().continuation,
        runId: 'other-run',
        graphFingerprint: '7'.repeat(64),
      },
    };
    expect((await methods.acquireGenerationAdmission(other)).ok).toBe(false);
    expect(await mongoose.models.GenerationAdmission.countDocuments({})).toBe(1);
  });

  it('admits one recovery winner and records interruption without inventing terminal success', async () => {
    const original = await dispatch();
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        methods.recoverGenerationAdmission(input(), evidence(), {
          ...successor,
          segmentId: `next-${i}`,
        }),
      ),
    );
    const winners = outcomes.filter((outcome) => outcome.ok);
    expect(winners).toHaveLength(1);
    const recovered = unwrap(winners[0]);
    expect(recovered).toMatchObject({
      state: 'admitted',
      active: true,
      generationEpoch: 1,
      continuation: input().continuation,
      checkpointWriteRevision: 0,
    });
    expect(recovered.terminal).toBeUndefined();
    expect(recovered.settledAt).toBeUndefined();
    expect(recovered.dispatchedAt).toBeUndefined();
    expect(recovered.predecessors ?? []).toHaveLength(0);
    expect(recovered.recoveries).toHaveLength(1);
    expect(recovered.recoveries?.[0]).toMatchObject({
      ownerInstanceId: original.ownerInstanceId,
      processBootId: original.processBootId,
      segmentId: original.segmentId,
      dispatchedAt: original.dispatchedAt,
      evidence: evidence(),
    });
    expect(recovered.recoveries?.[0]).not.toHaveProperty('terminal');
    expect((await methods.dispatchGenerationAdmission(input())).ok).toBe(false);
    expect((await methods.settleGenerationAdmission(input(), terminal)).ok).toBe(false);
    expect(unwrap(await methods.dispatchGenerationAdmission(recovered)).state).toBe('dispatching');
    expect((await methods.recoverGenerationAdmission(recovered, evidence(), input())).ok).toBe(
      false,
    );
  });

  it.each([
    'tenantId',
    'principalId',
    'clientRequestId',
    'conversationId',
    'requestFingerprint',
    'protocol',
    'ownerInstanceId',
    'processBootId',
    'segmentId',
    'generationEpoch',
    'runId',
    'threadId',
    'checkpointNamespace',
    'graphFingerprint',
    'policyFingerprint',
  ] as const)('fences recovery and checkpoint callbacks against a mismatched %s', async (field) => {
    await dispatch();
    const changed = input();
    if (field === 'generationEpoch') changed.generationEpoch += 1;
    else if (
      field === 'runId' ||
      field === 'threadId' ||
      field === 'checkpointNamespace' ||
      field === 'graphFingerprint' ||
      field === 'policyFingerprint'
    ) {
      if (!changed.continuation) throw new Error('Missing fixture binding');
      changed.continuation[field] = field.endsWith('Fingerprint') ? '9'.repeat(64) : 'other';
    } else changed[field] = field === 'requestFingerprint' ? '9'.repeat(64) : 'other';
    const callback = jest.fn(async () => 'never');
    expect((await methods.recoverGenerationAdmission(changed, evidence(), successor)).ok).toBe(
      false,
    );
    expect((await methods.writeGenerationCheckpoint(changed, callback)).ok).toBe(false);
    expect(callback).not.toHaveBeenCalled();
    expect((await read()).segmentId).toBe(input().segmentId);
  });

  it('requires the exact committed write revision and rejects the old writer before its callback', async () => {
    await dispatch();
    const saved = await methods.writeGenerationCheckpoint(input(), async (session) => {
      expect(session.inTransaction()).toBe(true);
      await artifacts().insertOne({ _id: 'first', owner: 'old' }, { session });
      return { checkpoint: 'first' };
    });
    expect(saved).toEqual({ ok: true, value: { checkpoint: 'first' } });
    expect((await read()).checkpointWriteRevision).toBe(1);
    expect((await methods.recoverGenerationAdmission(input(), evidence(0), successor)).ok).toBe(
      false,
    );
    const recovered = unwrap(
      await methods.recoverGenerationAdmission(input(), evidence(1), successor),
    );
    const callback = jest.fn(async () => 'stale');
    expect(await methods.writeGenerationCheckpoint(input(), callback)).toEqual({
      ok: false,
      error: { code: 'HELD' },
    });
    expect(callback).not.toHaveBeenCalled();
    expect((await methods.settleGenerationAdmission(input(), terminal)).ok).toBe(false);
    expect(recovered.checkpointWriteRevision).toBe(1);
    expect(await artifacts().countDocuments({})).toBe(1);
  });

  it('rejects unbound legacy, undispatched, settled, and missing-proof recovery safely', async () => {
    const { continuation: _binding, ...legacy } = input();
    await dispatch(legacy);
    const callback = jest.fn(async () => 'never');
    expect((await methods.writeGenerationCheckpoint(legacy, callback)).ok).toBe(false);
    expect((await methods.recoverGenerationAdmission(legacy, evidence(), successor)).ok).toBe(
      false,
    );
    expect(callback).not.toHaveBeenCalled();
    expect((await methods.settleGenerationAdmission(legacy, terminal)).ok).toBe(true);
    await mongoose.models.GenerationAdmission.deleteMany({});
    await methods.acquireGenerationAdmission(input());
    expect((await methods.recoverGenerationAdmission(input(), evidence(), successor)).ok).toBe(
      false,
    );
    await methods.dispatchGenerationAdmission(input());
    for (const proof of [
      { ...evidence(), terminationEvidenceSha256: '' },
      { ...evidence(), effectsEvidenceSha256: '' },
      evidence(-1),
    ]) {
      expect(await methods.recoverGenerationAdmission(input(), proof, successor)).toEqual({
        ok: false,
        error: { code: 'INVALID_INPUT' },
      });
    }
    await methods.settleGenerationAdmission(input(), terminal);
    expect((await methods.recoverGenerationAdmission(input(), evidence(), successor)).ok).toBe(
      false,
    );
  });

  it('holds a committed recovery with unknown acknowledgement instead of granting replay or read dispatch', async () => {
    await dispatch();
    // Only the acknowledgement boundary is controlled: the actual majority-write
    // completes first. Mongo's native writeConcern failpoint does not commit this pipeline.
    const collection = mongoose.models.GenerationAdmission.collection;
    const actualWrite = collection.findOneAndUpdate.bind(collection);
    jest.spyOn(collection, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
      await actualWrite(...args);
      throw new mongoose.mongo.MongoNetworkError(
        'Synthetic acknowledgement lost after actual write',
      );
    });
    expect(await methods.recoverGenerationAdmission(input(), evidence(), successor)).toEqual({
      ok: false,
      error: { code: 'OUTCOME_UNKNOWN' },
    });
    const stored = await read();
    expect(stored).toMatchObject({ ...successor, state: 'admitted', active: true });
    expect(stored.recoveries).toHaveLength(1);
    expect((await methods.recoverGenerationAdmission(input(), evidence(), successor)).ok).toBe(
      false,
    );
    expect(
      unwrap(await methods.acquireGenerationAdmission({ ...input(), ...successor })).acquired,
    ).toBe(false);
    expect((await read()).state).toBe('admitted');
    expect((await read()).dispatchedAt).toBeUndefined();
  });

  it('also holds a real native write-concern failure that leaves recovery uncommitted', async () => {
    await dispatch();
    await uncertain('findAndModify');
    expect(await methods.recoverGenerationAdmission(input(), evidence(), successor)).toEqual({
      ok: false,
      error: { code: 'OUTCOME_UNKNOWN' },
    });
    expect(await read()).toMatchObject({
      ownerInstanceId: input().ownerInstanceId,
      state: 'dispatching',
    });
    expect((await read()).recoveries ?? []).toHaveLength(0);
  });

  it('rolls back both revision and checkpoint artifacts on callback failure or duplicate-key conflict', async () => {
    await dispatch();
    await expect(
      methods.writeGenerationCheckpoint(input(), async (session) => {
        await artifacts().insertOne({ _id: 'rollback', owner: 'old' }, { session });
        throw new Error('synthetic callback failure');
      }),
    ).rejects.toMatchObject({ code: 'GENERATION_ADMISSION_STORAGE_ERROR' });
    expect(await artifacts().countDocuments({})).toBe(0);
    expect((await read()).checkpointWriteRevision).toBe(0);
    await artifacts().insertOne({ _id: 'duplicate', owner: 'existing' });
    await expect(
      methods.writeGenerationCheckpoint(input(), async (session) => {
        await artifacts().insertOne({ _id: 'duplicate', owner: 'old' }, { session });
      }),
    ).rejects.toMatchObject({ code: 'GENERATION_ADMISSION_STORAGE_ERROR' });
    expect((await read()).checkpointWriteRevision).toBe(0);
    expect(await artifacts().findOne({ _id: 'duplicate' })).toMatchObject({ owner: 'existing' });
  });

  it('serializes a held old checkpoint writer against recovery and rejects the now-stale proof', async () => {
    await dispatch();
    let entered: (() => void) | undefined;
    let release: (() => void) | undefined;
    let sent: (() => void) | undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requestSent = new Promise<void>((resolve) => {
      sent = resolve;
    });
    const client = mongoose.connection.getClient();
    const onCommand = (event: mongoose.mongo.CommandStartedEvent) => {
      if (
        event.commandName === 'findAndModify' &&
        event.command.findAndModify === mongoose.models.GenerationAdmission.collection.name
      )
        sent?.();
    };
    const writer = methods.writeGenerationCheckpoint(input(), async (session) => {
      entered?.();
      await blocked;
      await artifacts().insertOne({ _id: 'held-write', owner: 'old' }, { session });
      return 'written';
    });
    let recovery: ReturnType<typeof methods.recoverGenerationAdmission> | undefined;
    try {
      await bounded(
        Promise.race([
          inside,
          writer.then(() => {
            throw new Error('Writer ended before controlled boundary');
          }),
        ]),
      );
      client.on('commandStarted', onCommand);
      recovery = methods.recoverGenerationAdmission(input(), evidence(), successor);
      await bounded(
        Promise.race([
          requestSent,
          recovery.then(() => {
            throw new Error('Recovery returned before actual command');
          }),
        ]),
      );
    } finally {
      client.off('commandStarted', onCommand);
      release?.();
      await Promise.allSettled(recovery == null ? [writer] : [writer, recovery]);
    }
    expect(await writer).toEqual({ ok: true, value: 'written' });
    expect(await recovery).toEqual({ ok: false, error: { code: 'HELD' } });
    expect((await read()).checkpointWriteRevision).toBe(1);
    expect(await artifacts().countDocuments({ _id: 'held-write' })).toBe(1);
    expect(
      unwrap(await methods.recoverGenerationAdmission(input(), evidence(1), successor)).state,
    ).toBe('admitted');
  });
});
