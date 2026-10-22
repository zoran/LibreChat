/** Untrusted recovery messages must not manufacture authority or combine unrelated stop evidence. */
import type {
  UploadIntakeLocalSettlement,
  UploadIntakeRecovery,
  UploadIntakeRecoveryBinding,
} from './upload-intake-recovery';
import {
  readUploadIntakeLocalSettlement,
  readUploadIntakeRecovery,
  readUploadIntakeRecoveryBinding,
} from './upload-intake-recovery';

const operationId = '11111111-1111-4111-8111-111111111111';
const scope = () => ({
  version: 1 as const,
  operationId,
  transferGeneration: 7,
  worker: { hostId: 'intake-host', instanceId: 'intake-pod' },
});
const execution = () => ({
  version: 2 as const,
  custody: { kind: 'none' as const },
  attemptId: `${operationId}.7`,
  instanceId: '22222222-2222-4222-8222-222222222222',
  executionId: '33333333-3333-4333-8333-333333333333',
  expiresAt: '2026-10-17T04:00:00.000Z',
});
const scanner = () => ({
  execution: execution(),
  writerStopped: true,
  transientDataRemoved: true,
});
const binding = (): UploadIntakeRecoveryBinding => ({
  ...scope(),
  capabilitySha256: 'a'.repeat(64),
});
const recovery = (): UploadIntakeRecovery => ({
  ...scope(),
  closed: true,
  acknowledged: true,
  storageOutcome: 'durable',
  appWriterStopped: true,
  promotion: {
    promotionId: '44444444-4444-4444-8444-444444444444',
    worker: { hostId: 'app-host', instanceId: 'app-pod' },
  },
  securityExecution: execution(),
  securitySettlement: scanner(),
});
const local = (): UploadIntakeLocalSettlement => ({
  ...scope(),
  localWriterStopped: true,
  localCopiesAbsent: true,
  securitySettlement: scanner(),
});
const readers: {
  name: string;
  create: () => Record<string, unknown>;
  read: (value: unknown) => unknown;
}[] = [
  { name: 'binding', create: binding, read: readUploadIntakeRecoveryBinding },
  { name: 'recovery', create: recovery, read: readUploadIntakeRecovery },
  { name: 'local settlement', create: local, read: readUploadIntakeLocalSettlement },
];

describe('private intake recovery contract', () => {
  it.each(readers)(
    'copies the complete $name wire shape without normalizing it',
    ({ create, read }) => {
      const input = create();
      const before = JSON.stringify(input);
      const result = read(Object.freeze(input));
      expect(result).toEqual(input);
      expect(result).not.toBe(input);
      expect(read(JSON.parse(before))).toEqual(input);
      expect(read(Object.assign(Object.create(null), input))).toEqual(input);
      expect(JSON.stringify(input)).toBe(before);
    },
  );

  it.each(readers)(
    'refuses extra, inherited, hidden and accessor $name fields',
    ({ create, read }) => {
      const input = create();
      const getter = jest.fn(() => 1);
      const accessor = { ...input };
      Object.defineProperty(accessor, 'version', { enumerable: true, get: getter });
      const hidden = { ...input };
      Object.defineProperty(hidden, 'version', { enumerable: false });
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();
      for (const value of [
        null,
        [],
        true,
        'recovery',
        { ...input, extra: true },
        { ...input, filename: 'private.txt' },
        { ...input, capability: 'private' },
        { ...input, [Symbol('extra')]: true },
        Object.create(input),
        accessor,
        hidden,
        revoked.proxy,
      ])
        expect(read(value)).toBeNull();
      for (const key of Object.keys(input)) {
        if (['promotion', 'securityExecution', 'securitySettlement'].includes(key)) continue;
        const missing = { ...input };
        delete missing[key];
        expect(read(missing)).toBeNull();
      }
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it.each(readers)(
    'enforces the existing identifier and generation limits for $name',
    ({ create, read }) => {
      for (const patch of [
        { version: 2 },
        ...[0, -1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '7'].map(
          (transferGeneration) => ({ transferGeneration }),
        ),
        ...['', 'x'.repeat(129), ' op ', 'op\n', 'op/part'].map((operationId) => ({ operationId })),
        ...[
          null,
          { hostId: 'host', instanceId: '' },
          { hostId: 'x'.repeat(129), instanceId: 'pod' },
          { hostId: 'host', instanceId: 'pod\n' },
          { hostId: 'host', instanceId: 'pod', extra: true },
        ].map((worker) => ({ worker })),
      ])
        expect(read({ ...create(), ...patch })).toBeNull();
    },
  );

  it('accepts the exact intake upper bounds without inventing a UUID requirement for workers', () => {
    const input = {
      ...binding(),
      operationId: 'x'.repeat(128),
      transferGeneration: Number.MAX_SAFE_INTEGER,
      worker: { hostId: 'H_.-'.repeat(32), instanceId: 'I_.-'.repeat(32) },
    };
    expect(readUploadIntakeRecoveryBinding(input)).toEqual(input);
  });

  it.each(['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), `${'a'.repeat(63)}\n`, null])(
    'rejects a malformed capability digest %j',
    (capabilitySha256) =>
      expect(readUploadIntakeRecoveryBinding({ ...binding(), capabilitySha256 })).toBeNull(),
  );

  it('returns independent nested snapshots in both directions', () => {
    const input = recovery();
    const result = readUploadIntakeRecovery(input)!;
    input.worker.hostId = 'changed';
    input.promotion!.worker.instanceId = 'changed';
    input.securityExecution!.expiresAt = '2000-01-01T00:00:00.000Z';
    input.securitySettlement!.execution.attemptId = 'changed.1';
    input.securitySettlement!.writerStopped = false;
    expect(result).toEqual(recovery());
    expect(() => {
      result.securitySettlement!.execution.executionId = '55555555-5555-4555-8555-555555555555';
    }).toThrow(TypeError);
    expect(result.securityExecution).toEqual(execution());
    expect(input.securitySettlement!.execution.executionId).toBe(execution().executionId);
    const localInput = local();
    const localResult = readUploadIntakeLocalSettlement(localInput)!;
    localInput.securitySettlement!.execution.instanceId = 'changed';
    localInput.worker.hostId = 'changed';
    expect(localResult).toEqual(local());
    const bindingInput = binding();
    const bindingResult = readUploadIntakeRecoveryBinding(bindingInput)!;
    bindingInput.worker.hostId = 'changed';
    expect(bindingResult).toEqual(binding());
  });

  it.each([
    ['worker', (value: UploadIntakeRecovery) => value.worker],
    ['promotion', (value: UploadIntakeRecovery) => value.promotion!],
    ['promotion worker', (value: UploadIntakeRecovery) => value.promotion!.worker],
    ['execution', (value: UploadIntakeRecovery) => value.securityExecution!],
    ['settlement', (value: UploadIntakeRecovery) => value.securitySettlement!],
    ['settlement execution', (value: UploadIntakeRecovery) => value.securitySettlement!.execution],
  ] as const)('refuses hidden behavior and extra data in nested %s', (_name, select) => {
    const getter = jest.fn(() => 'private');
    for (const corruption of ['getter', 'symbol', 'extra', 'non-enumerable']) {
      const input = recovery();
      const target = select(input);
      const key = Object.keys(target)[0];
      if (corruption === 'getter')
        Object.defineProperty(target, key, { enumerable: true, get: getter });
      else if (corruption === 'non-enumerable')
        Object.defineProperty(target, key, { enumerable: false });
      else if (corruption === 'symbol') Object.assign(target, { [Symbol('extra')]: true });
      else Object.assign(target, { extra: true });
      expect(readUploadIntakeRecovery(input)).toBeNull();
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(['not_started', 'absent', 'durable', 'unknown'] as const)(
    'preserves %s with exactly the corresponding App-writer stop evidence',
    (storageOutcome) => {
      const input = {
        ...recovery(),
        acknowledged: false,
        storageOutcome,
        appWriterStopped: storageOutcome !== 'unknown',
      };
      expect(readUploadIntakeRecovery(input)).toEqual(input);
      expect(
        readUploadIntakeRecovery({ ...input, appWriterStopped: !input.appWriterStopped }),
      ).toBeNull();
    },
  );

  it('does not confuse local-only completion with recovery or original deletion', () => {
    const input = local();
    input.localCopiesAbsent = false;
    input.securitySettlement!.writerStopped = false;
    expect(readUploadIntakeLocalSettlement(input)).toEqual(input);
    expect(readUploadIntakeRecovery(input)).toBeNull();
    expect(readUploadIntakeLocalSettlement(recovery())).toBeNull();
    for (const patch of [
      { localWriterStopped: false },
      { localCopiesAbsent: 1 },
      { appWriterStopped: true },
      { storageOutcome: 'absent' },
      { originalAbsent: true },
      { acknowledged: true },
    ])
      expect(readUploadIntakeLocalSettlement({ ...input, ...patch })).toBeNull();
  });

  it('represents a closed never-started attempt without fabricated scanner or promotion fields', () => {
    const input = {
      ...scope(),
      closed: true,
      acknowledged: true,
      storageOutcome: 'not_started',
      appWriterStopped: true,
    };
    expect(readUploadIntakeRecovery(input)).toEqual(input);
    expect(
      readUploadIntakeLocalSettlement({
        ...scope(),
        localWriterStopped: true,
        localCopiesAbsent: true,
      }),
    ).not.toBeNull();
    for (const key of ['promotion', 'securityExecution', 'securitySettlement'])
      expect(readUploadIntakeRecovery({ ...input, [key]: undefined })).toBeNull();
    expect(
      readUploadIntakeLocalSettlement({ ...local(), securitySettlement: undefined }),
    ).toBeNull();
  });

  it('rejects invalid discriminators and premature acknowledgements', () => {
    for (const patch of [
      { closed: false },
      { closed: 1 },
      { acknowledged: 'true' },
      { appWriterStopped: 1 },
      { storageOutcome: 'deleted' },
      { storageOutcome: 'unknown', appWriterStopped: false },
    ])
      expect(readUploadIntakeRecovery({ ...recovery(), ...patch })).toBeNull();
  });

  it.each([
    '',
    '44444444-4444-1444-8444-444444444444',
    '44444444-4444-4444-7444-444444444444',
    'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    '44444444-4444-4444-8444-444444444444\n',
  ])('rejects an invalid promotion UUID %j', (promotionId) => {
    const input = recovery();
    input.promotion!.promotionId = promotionId;
    expect(readUploadIntakeRecovery(input)).toBeNull();
  });

  it.each([
    { attemptId: `${operationId}.8` },
    { attemptId: 'other.7' },
    { instanceId: '55555555-5555-4555-8555-555555555555' },
    { executionId: '55555555-5555-4555-8555-555555555555' },
    { expiresAt: '2026-10-17T04:00:01.000Z' },
  ])('refuses to combine a different scanner execution %j', (patch) => {
    const input = recovery();
    Object.assign(input.securitySettlement!.execution, patch);
    expect(readUploadIntakeRecovery(input)).toBeNull();
  });

  it('binds both scanner fields to the original operation and transfer generation', () => {
    for (const attemptId of ['other.7', `${operationId}.8`]) {
      const input = recovery();
      input.securityExecution!.attemptId = attemptId;
      input.securitySettlement!.execution.attemptId = attemptId;
      expect(readUploadIntakeRecovery(input)).toBeNull();
      expect(
        readUploadIntakeLocalSettlement({
          ...local(),
          securitySettlement: input.securitySettlement,
        }),
      ).toBeNull();
    }
    const orphan = recovery();
    delete orphan.securityExecution;
    expect(readUploadIntakeRecovery(orphan)).toBeNull();
    const invalid = recovery();
    invalid.securityExecution!.expiresAt = '2026-02-30T00:00:00.000Z';
    invalid.securitySettlement!.execution.expiresAt = invalid.securityExecution!.expiresAt;
    expect(readUploadIntakeRecovery(invalid)).toBeNull();
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
  ])(
    'keeps incomplete scanner stop=%s removal=%s pending instead of acknowledging it',
    (writerStopped, transientDataRemoved) => {
      const input = recovery();
      Object.assign(input.securitySettlement!, { writerStopped, transientDataRemoved });
      expect(readUploadIntakeRecovery(input)).toBeNull();
      input.acknowledged = false;
      expect(readUploadIntakeRecovery(input)).toEqual(input);
    },
  );

  it('requires a complete scanner settlement for acknowledgement but leaves pending evidence representable', () => {
    const input = recovery();
    delete input.securitySettlement;
    expect(readUploadIntakeRecovery(input)).toBeNull();
    input.acknowledged = false;
    expect(readUploadIntakeRecovery(input)).toEqual(input);
    expect(readUploadIntakeRecovery({ ...recovery(), acknowledged: false })).not.toBeNull();
  });
});

describe('persisted owner cleanup receipt recovery shape', () => {
  const value = () => {
    const owner = {
      protocol: 1 as const,
      requestId: 'request',
      generation: '7',
      authorityBindingSHA256: 'a'.repeat(64),
      acceptedObjectSHA256: 'b'.repeat(64),
      bucket: 'private-bucket',
      key: `managed-uploads/user/${operationId}.7__original`,
    };
    return {
      ...recovery(),
      storageOutcome: 'unknown' as const,
      cleanupReceipt: {
        binding: owner,
        receipt: {
          ...owner,
          state: 'durable_delete_complete' as const,
          obligationId: 'obligation',
          aggregateRevision: '1',
          proofSHA256: 'c'.repeat(64),
        },
        receiptSHA256: 'd'.repeat(64),
        consumerCommitId: 'commit',
      },
    };
  };
  it('copies a receipt-qualified unknown history without turning it into a durable PUT', () => {
    const input = value();
    const result = readUploadIntakeRecovery(input)!;
    expect(result.storageOutcome).toBe('unknown');
    expect(result.acknowledged).toBe(true);
    input.cleanupReceipt.receipt.proofSHA256 = 'e'.repeat(64);
    expect(result.cleanupReceipt!.receipt.proofSHA256).toBe('c'.repeat(64));
  });
  it.each([
    'foreign-generation',
    'foreign-key',
    'binding',
    'namespace',
    'extra',
    'missing-commit',
    'scanner',
  ])('rejects %s receipt observations', (change) => {
    const input = value();
    if (change === 'foreign-generation') input.cleanupReceipt.binding.generation = '8';
    if (change === 'foreign-key')
      input.cleanupReceipt.binding.key = 'managed-uploads/user/other.7__original';
    if (change === 'binding') input.cleanupReceipt.receipt.requestId = 'different';
    if (change === 'namespace')
      Object.assign(input.cleanupReceipt.receipt, { state: 'namespace_absent' });
    if (change === 'extra') Object.assign(input.cleanupReceipt, { localWriterStopped: true });
    if (change === 'missing-commit')
      delete (input.cleanupReceipt as Partial<typeof input.cleanupReceipt>).consumerCommitId;
    if (change === 'scanner') input.securitySettlement!.transientDataRemoved = false;
    expect(readUploadIntakeRecovery(input)).toBeNull();
  });
  it('rejects nested receipt getters without invoking them', () => {
    const input = value();
    const getter = jest.fn(() => '1');
    Object.defineProperty(input.cleanupReceipt.receipt, 'aggregateRevision', {
      enumerable: true,
      get: getter,
    });
    expect(readUploadIntakeRecovery(input)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });
});
