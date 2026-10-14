import {
  SOURCE_REPLAY_LIMITS,
  SourceReplayError,
  assertSourceJobSize,
  canReleaseSourceReplay,
  createSourceReplayIntent,
  sourceChunkBytes,
  sourceHashBytes,
} from '../internal/sourceBudget';

const identity = { streamId: 'stream', userId: 'user', tenantId: 'tenant', createdAt: 123 };
const intent = () => createSourceReplayIntent(identity, ['file-b', 'file-a'], 999);

describe('document-source replay liability', () => {
  it('reserves the approved category sum and leaves a strict shared-Redis source share', () => {
    expect(SOURCE_REPLAY_LIMITS.reservedBytes).toBe(
      SOURCE_REPLAY_LIMITS.jobBytes +
        SOURCE_REPLAY_LIMITS.chunkBytes +
        SOURCE_REPLAY_LIMITS.runStepBytes,
    );
    expect(SOURCE_REPLAY_LIMITS.epochs * SOURCE_REPLAY_LIMITS.reservedBytes).toBe(
      896 * 1024 * 1024,
    );
  });

  it('binds the receipt to the immutable tenant, owner, stream and generation epoch', () => {
    const original = intent();
    expect(original.receipt).toMatchObject({
      fileId: 'file-a',
      bytes: 28 * 1024 * 1024,
      state: 'held',
    });
    expect(original.receipt.reservationId).toMatch(/^[a-f0-9]{64}$/);
    expect(
      createSourceReplayIntent(
        { ...identity, text: 'private' } as typeof identity,
        ['file-a', 'file-b'],
        999,
      ),
    ).not.toHaveProperty('text');
    expect(createSourceReplayIntent(identity, ['file-a', 'file-a', 'file-b'], 999)).toEqual(
      original,
    );
    for (const change of [
      { userId: 'other' },
      { tenantId: 'other' },
      { streamId: 'other' },
      { createdAt: 124 },
    ]) {
      expect(
        createSourceReplayIntent({ ...identity, ...change }, ['file-a'], 999).receipt.reservationId,
      ).not.toBe(original.receipt.reservationId);
    }
  });

  it('rejects ambiguous or unbounded identity and source lists before reservation', () => {
    for (const ids of [
      [],
      [''],
      Array.from({ length: 65 }, (_, i) => `file-${i}`),
      ['x'.repeat(129)],
    ]) {
      expect(() => createSourceReplayIntent(identity, ids, 999)).toThrow(SourceReplayError);
    }
    expect(() => createSourceReplayIntent({ ...identity, createdAt: NaN }, ['file'], 999)).toThrow(
      SourceReplayError,
    );
    expect(() => createSourceReplayIntent(identity, ['file'], Infinity)).toThrow(SourceReplayError);
  });

  it('counts UTF-8 key, field and serialized value bytes without charging old overwrites', () => {
    const fields = { name: 'ä', finalEvent: '{"text":"€"}' };
    expect(sourceHashBytes('key', fields)).toBe(
      Buffer.byteLength('keynameäfinalEvent{"text":"€"}'),
    );
    expect(sourceHashBytes('key', { ...fields, finalEvent: '{}' })).toBe(
      Buffer.byteLength('keynameäfinalEvent{}'),
    );
  });

  it('bounds the serialized hash while retaining the fixed metadata allowance', () => {
    const available = SOURCE_REPLAY_LIMITS.jobBytes - SOURCE_REPLAY_LIMITS.metadataBytes;
    expect(() => assertSourceJobSize('k', { v: 'x'.repeat(available - 2) })).not.toThrow();
    expect(() => assertSourceJobSize('k', { v: 'x'.repeat(available - 1) })).toThrow(
      SourceReplayError,
    );
  });

  it('counts each XADD field, a full stream ID allowance and the exact event encoding', () => {
    expect(sourceChunkBytes('{"text":"ä"}')).toBe(Buffer.byteLength('{"text":"ä"}') + 46);
  });

  it('requires the same epoch, confirmed provider stop and completed durable purge before refund', () => {
    const held = intent();
    const stopped = {
      createdAt: identity.createdAt,
      status: 'error',
      providerDrained: true,
      sourceRetentionPurged: true,
    };
    expect(canReleaseSourceReplay(held, stopped)).toBe(true);
    for (const override of [
      { createdAt: 124 },
      { status: 'running' },
      { status: 'requires_action' },
      { providerDrained: false },
      { providerDrained: undefined },
      { sourceRetentionPurged: false },
      { terminalPersistencePending: true },
      { terminalHostActionPending: true },
    ])
      expect(canReleaseSourceReplay(held, { ...stopped, ...override })).toBe(false);
    expect(canReleaseSourceReplay(held, null)).toBe(false);
  });
});
