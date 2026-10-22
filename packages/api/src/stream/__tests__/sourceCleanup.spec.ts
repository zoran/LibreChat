import { createGenerationCleanupPort, sourceActorSettlementMatches } from '../sourceCleanup';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';
import { createSourceReplayIntent } from '../internal/sourceBudget';

const scope = {
  userId: 'user',
  tenantId: 'tenant',
  revocationId: 'file-claim',
  sourceFileIds: ['file'],
};

async function fixture() {
  const store = new InMemoryJobStore();
  const job = await store.createJob('stream', 'user', undefined, 'tenant', {
    providerExecutionId: 'provider',
  });
  const intent = createSourceReplayIntent(job, ['file', 'other'], Date.now() + 60_000);
  await store.prepareSourceReplay(intent);
  await store.commitSourceReplay(intent);
  const transport = {
    emitAbortConfirmed: jest.fn(async () => true),
    purgeSourceRetention: jest.fn(async () => undefined),
    hasProviderDrain: jest.fn(async () => false),
  };
  const port = createGenerationCleanupPort({ store, transport });
  const page = await port.capture(scope);
  return { store, job, intent, transport, port, target: page.targets[0] };
}

describe('generation source cleanup control', () => {
  it('captures metadata without revocation and preserves the exact principal/epoch/provider', async () => {
    const { store, job, target, port } = await fixture();
    expect(target).toEqual({
      schema: 1,
      scope,
      streamId: 'stream',
      createdAt: job.createdAt,
      providerExecutionId: 'provider',
    });
    expect((await store.getJob('stream'))?.sourceRetentionRevokedAt).toBeUndefined();
    expect((await port.capture({ ...scope, tenantId: 'other' })).targets).toEqual([]);
    await port.close();
    await expect(port.capture(scope)).rejects.toThrow('closed');
  });

  it('never treats abort ACK or provider drain as actor/local-cleanup settlement', async () => {
    const { store, job, transport, port, target } = await fixture();
    expect((await port.reconcile(target)).state).toBe('pending');
    expect(transport.emitAbortConfirmed).toHaveBeenCalledWith('stream', job.createdAt);
    await store.updateJob('stream', { status: 'aborted', providerDrained: true }, job.createdAt);
    expect(await port.reconcile(target)).toMatchObject({
      state: 'unknown',
      reason: 'actor_settlement_unproven',
    });
  });

  it('requires the actual actor receipt, terminal barriers, replay release and confirmed purges', async () => {
    const { store, job, intent, port, target } = await fixture();
    await port.reconcile(target);
    await store.updateJob(
      'stream',
      { status: 'aborted', providerDrained: true, terminalPersistencePending: true },
      job.createdAt,
    );
    const row = (await store.getJob('stream'))!;
    const receipt = {
      schema: 1 as const,
      streamId: 'stream',
      createdAt: job.createdAt,
      providerExecutionId: 'provider',
      sourceRetentionRevokedAt: row.sourceRetentionRevokedAt!,
      sourceFileIds: ['file', 'other'],
      localCopiesAbsent: true as const,
    };
    expect(await store.recordSourceActorSettlement(receipt)).toBe(false);
    await store.updateJob('stream', { terminalPersistencePending: false }, job.createdAt);
    expect(
      await store.recordSourceActorSettlement({ ...receipt, providerExecutionId: 'wrong' }),
    ).toBe(false);
    expect(await store.recordSourceActorSettlement(receipt)).toBe(true);
    expect((await port.reconcile(target)).state).toBe('pending');
    expect(await store.acknowledgeSourceReplayRelease(intent)).toBe(true);
    const result = await port.reconcile(target);
    expect(result).toMatchObject({
      state: 'settled',
      evidence: {
        actor: receipt,
        providerDrained: true,
        sourcePurged: true,
        recoveryPurged: true,
        replayReleased: true,
      },
    });
    expect(sourceActorSettlementMatches((await store.getJob('stream'))!, receipt)).toBe(true);
  });

  it('does not revoke a replacement provider or adopt a missing actor', async () => {
    const { store, job, port, target, transport } = await fixture();
    await store.updateJob('stream', { providerExecutionId: 'next' }, job.createdAt);
    expect(await port.reconcile(target)).toMatchObject({
      state: 'unknown',
      reason: 'provider_replaced',
    });
    expect((await store.getJob('stream'))?.sourceRetentionRevokedAt).toBeUndefined();
    expect(transport.emitAbortConfirmed).not.toHaveBeenCalled();
    expect(await port.reconcile({ ...target, createdAt: job.createdAt - 1 })).toMatchObject({
      state: 'unknown',
      reason: 'generation_replaced',
    });
  });

  it('protects actor receipts from ordinary metadata updates and incomplete source bindings', async () => {
    const { store, job } = await fixture();
    await store.revokeSourceRetention('stream', job.createdAt);
    await store.updateJob('stream', { status: 'aborted', providerDrained: true }, job.createdAt);
    const row = (await store.getJob('stream'))!;
    const receipt = {
      schema: 1 as const,
      streamId: 'stream',
      createdAt: job.createdAt,
      providerExecutionId: 'provider',
      sourceRetentionRevokedAt: row.sourceRetentionRevokedAt!,
      sourceFileIds: ['file'],
      localCopiesAbsent: true as const,
    };
    expect(await store.recordSourceActorSettlement(receipt)).toBe(false);
    await store.updateJob('stream', { sourceActorSettlement: receipt }, job.createdAt);
    expect((await store.getJob('stream'))?.sourceActorSettlement).toBeUndefined();
  });

  it('retains uncertain control replies and bounds concurrent work while close joins custody', async () => {
    const { store, port, target } = await fixture();
    jest.spyOn(store, 'revokeSourceRetention').mockRejectedValueOnce(new Error('lost Redis reply'));
    expect(await port.reconcile(target)).toMatchObject({
      state: 'unknown',
      reason: 'generation_control_unavailable',
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = store.captureSourceCleanupPage.bind(store);
    jest.spyOn(store, 'captureSourceCleanupPage').mockImplementation(async (owner, cursor) => {
      await blocked;
      return original(owner, cursor);
    });
    const calls = Array.from({ length: 4 }, () => port.capture(scope));
    await expect(port.capture(scope)).rejects.toThrow('busy');
    let closed = false;
    const closing = port.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await Promise.all([...calls, closing]);
    expect(closed).toBe(true);
  });

  it('keeps recovery without historical actor custody incomplete and refuses an unbound provider', async () => {
    const { store, port, target } = await fixture();
    jest
      .spyOn(store, 'captureSourceCleanupPage')
      .mockResolvedValueOnce({ jobs: [], complete: true, unresolvedRecovery: true });
    expect(await port.capture(scope)).toEqual({
      targets: [],
      cursor: undefined,
      complete: false,
      reason: 'recovery_identity_unavailable',
    });
    expect(await port.reconcile({ ...target, providerExecutionId: null })).toMatchObject({
      state: 'unknown',
      reason: 'provider_identity_unavailable',
    });
  });
});
