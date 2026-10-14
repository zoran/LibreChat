import type { SourceReplayJob, SourceReplayStore } from '../internal/sourceReplayLifecycle';
import type { SourceReplayIntent, SourceReplayQuota } from '../internal/sourceBudget';
import { SourceReplayLifecycle } from '../internal/sourceReplayLifecycle';

function fixture() {
  const log: string[] = [];
  let intent: SourceReplayIntent | undefined;
  const job: SourceReplayJob = {
    streamId: 'stream',
    userId: 'user',
    tenantId: 'tenant',
    createdAt: 123,
    status: 'running',
    providerDrained: false,
  };
  const store: SourceReplayStore = {
    getJob: async () => job,
    prepareSourceReplay: async (next) => {
      log.push('intent');
      intent = next;
      job.sourceReplayIntent = next;
      return next;
    },
    commitSourceReplay: async () => {
      log.push('commit');
      job.sourceReplayHeld = true;
      return true;
    },
    listSourceReplayIntents: async () => (intent ? [intent] : []),
    revokeSourceRetention: async () => {
      log.push('revoke');
      job.sourceRetentionRevokedAt = 999;
      return true;
    },
    purgeSourceRetention: async () => {
      log.push('purge');
      job.sourceRetentionPurged = true;
      return true;
    },
    acknowledgeSourceReplayRelease: async () => {
      log.push('ack');
      intent = undefined;
      return true;
    },
  };
  const quota: SourceReplayQuota = {
    reserveFileSourceCopies: jest.fn(async () => {
      log.push('reserve');
      return intent!.receipt;
    }),
    releaseFileSourceCopies: jest.fn(async () => {
      log.push('release');
    }),
  };
  const purgeTransport = jest.fn(
    async (_stream: string, _epoch: number, _options?: { silent?: boolean }) => {
      log.push('transport');
    },
  );
  const lifecycle = new SourceReplayLifecycle(store, purgeTransport, { quota });
  const bind = () => lifecycle.bind('stream', 123, ['file'], Date.now() + 60_000);
  const stop = () => {
    job.status = 'error';
    job.providerDrained = true;
  };
  return { log, job, store, quota, purgeTransport, lifecycle, bind, stop };
}

describe('source replay settlement', () => {
  it('persists cleanup identity before reserve, then binds and rechecks live File ownership', async () => {
    const f = fixture();
    await f.bind();
    expect(f.log.slice(0, 4)).toEqual(['intent', 'reserve', 'commit', 'reserve']);
    expect(f.quota.reserveFileSourceCopies).toHaveBeenCalledWith(
      { userId: 'user', tenantId: 'tenant' },
      expect.objectContaining({ sourceFileIds: ['file'], bytes: 28 * 1024 * 1024 }),
    );
  });

  it('retains the pre-reserve intent when Mongo outcome is unknown and later fences cancellation', async () => {
    const f = fixture();
    jest.mocked(f.quota.reserveFileSourceCopies).mockRejectedValueOnce(new Error('unknown'));
    await expect(f.bind()).rejects.toMatchObject({ code: 'document_source_unavailable' });
    expect(await f.store.listSourceReplayIntents()).toHaveLength(1);
    f.stop();
    await f.lifecycle.sweep();
    expect(f.log.indexOf('release')).toBeGreaterThan(f.log.indexOf('purge'));
    expect(await f.store.listSourceReplayIntents()).toHaveLength(0);
  });

  it('never refunds a running, undrained, pending-persistence or replaced generation', async () => {
    for (const state of [
      { status: 'running', providerDrained: true },
      { status: 'error', providerDrained: false },
      { status: 'error', providerDrained: undefined },
      { status: 'error', providerDrained: true, terminalPersistencePending: true },
      { status: 'error', providerDrained: true, createdAt: 124 },
    ]) {
      const f = fixture();
      await f.bind();
      Object.assign(f.job, state);
      await f.lifecycle.sweep();
      expect(f.quota.releaseFileSourceCopies).not.toHaveBeenCalled();
      expect(await f.store.listSourceReplayIntents()).toHaveLength(1);
    }
  });

  it('refunds an ordinary joined error only after purge and silently retires transport copies', async () => {
    const f = fixture();
    await f.bind();
    f.stop();
    await f.lifecycle.sweep();
    expect(f.log.slice(-4)).toEqual(['transport', 'purge', 'release', 'ack']);
    expect(f.purgeTransport).toHaveBeenCalledWith('stream', 123, { silent: true });
  });

  it('keeps a purged receipt across failed refund and retries without duplicating content', async () => {
    const f = fixture();
    await f.bind();
    f.stop();
    jest.mocked(f.quota.releaseFileSourceCopies).mockRejectedValueOnce(new Error('unknown'));
    await f.lifecycle.sweep();
    expect(f.job.sourceRetentionPurged).toBe(true);
    expect(await f.store.listSourceReplayIntents()).toHaveLength(1);
    await f.lifecycle.sweep();
    expect(await f.store.listSourceReplayIntents()).toHaveLength(0);
    expect(f.quota.releaseFileSourceCopies).toHaveBeenCalledTimes(2);
  });

  it('revokes an exposed binding when the post-bind File recheck fails', async () => {
    const f = fixture();
    jest
      .mocked(f.quota.reserveFileSourceCopies)
      .mockImplementationOnce(async () => (await f.store.listSourceReplayIntents())[0].receipt)
      .mockRejectedValueOnce(new Error('File deleted'));
    await expect(f.bind()).rejects.toMatchObject({ code: 'document_source_unavailable' });
    expect(f.job.sourceRetentionRevokedAt).toBeDefined();
    expect(f.quota.releaseFileSourceCopies).not.toHaveBeenCalled();
  });
});
