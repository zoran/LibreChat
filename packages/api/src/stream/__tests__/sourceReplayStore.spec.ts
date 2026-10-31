/* eslint jest/expect-expect: ["warn", { "assertFunctionNames": ["expect", "exerciseSourceMetadataPrefix", "exercisePreboundSourceFailure"] }] */
// These imported sequence helpers assert quota custody, retained payloads and joined cleanup.
import {
  exerciseSourceMetadataPrefix,
  exercisePreboundSourceFailure,
} from './sourceReplaySequence.helper';
import { createSourceReplayIntent, SOURCE_REPLAY_LIMITS } from '../internal/sourceBudget';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';

async function create(store: InMemoryJobStore, streamId = 'stream') {
  const job = await store.createJob(streamId, 'user', undefined, 'tenant', {
    providerExecutionId: 'provider',
  });
  const intent = createSourceReplayIntent(job, ['file'], Date.now() + 60_000);
  return { job, intent };
}

describe('source replay job-store boundaries', () => {
  it('never persists prebound initial text before quota and retries unknown cancellation through existing cleanup', async () => {
    await exercisePreboundSourceFailure(new InMemoryJobStore(), false);
  });

  it('adopts SDK metadata emitted before the model-source callback and settles the joined error', async () => {
    await exerciseSourceMetadataPrefix(new InMemoryJobStore(), false);
  });
  it('atomically limits unresolved source epochs while allowing source-free jobs', async () => {
    const store = new InMemoryJobStore();
    const all = await Promise.all(
      Array.from({ length: 33 }, (_, i) => create(store, `stream-${i}`)),
    );
    const results = await Promise.allSettled(
      all.map(({ intent }) => store.prepareSourceReplay(intent)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(32);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await store.listSourceReplayIntents()).toHaveLength(32);
    await expect(create(store, 'ordinary')).resolves.toBeDefined();
  });

  it('keeps a held error receipt past normal TTL and forbids replacement before settlement', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 1 });
    const { job, intent } = await create(store);
    await store.prepareSourceReplay(intent);
    await store.commitSourceReplay(intent);
    await store.updateJob(
      'stream',
      { status: 'error', completedAt: Date.now() - 10_000, providerDrained: true },
      job.createdAt,
    );
    await store.cleanup();
    expect(await store.getJob('stream')).toMatchObject({ createdAt: job.createdAt });
    await expect(create(store)).rejects.toMatchObject({ code: 'document_source_unavailable' });
    expect(await store.listSourceReplayIntents()).toHaveLength(1);
  });

  it('does not admit source writes before commit or after purge, and never trusts a wrong epoch', async () => {
    const store = new InMemoryJobStore();
    const { job, intent } = await create(store);
    await store.prepareSourceReplay(intent);
    expect(
      await store.appendChunk('stream', { event: 'text', data: 'private' }, job.createdAt),
    ).toBe(false);
    expect(await store.commitSourceReplay({ ...intent, createdAt: job.createdAt + 1 })).toBe(false);
    expect(await store.commitSourceReplay(intent)).toBe(true);
    expect(
      await store.appendChunk('stream', { event: 'text', data: 'private' }, job.createdAt),
    ).toBe(true);
    await store.updateJob(
      'stream',
      { status: 'error', completedAt: Date.now(), providerDrained: true },
      job.createdAt,
    );
    expect(await store.purgeSourceRetention('stream', job.createdAt)).toBe(true);
    expect(await store.appendChunk('stream', { event: 'text', data: 'late' }, job.createdAt)).toBe(
      false,
    );
    expect(await store.acknowledgeSourceReplayRelease(intent)).toBe(true);
    expect(await store.listSourceReplayIntents()).toHaveLength(0);
  });

  it('rejects a job update larger than its category before replacing the retained value', async () => {
    const store = new InMemoryJobStore();
    const { job, intent } = await create(store);
    await store.prepareSourceReplay(intent);
    await store.commitSourceReplay(intent);
    const old = (await store.getJob('stream'))?.error;
    await expect(
      store.updateJob(
        'stream',
        { error: 'x'.repeat(SOURCE_REPLAY_LIMITS.jobBytes) },
        job.createdAt,
      ),
    ).rejects.toMatchObject({ code: 'document_capacity_exceeded' });
    expect((await store.getJob('stream'))?.error).toBe(old);
  });

  it('requires affirmative provider stop; the legacy terminal timeout cannot release source jobs', async () => {
    const store = new InMemoryJobStore();
    const { job, intent } = await create(store);
    await store.prepareSourceReplay(intent);
    await store.commitSourceReplay(intent);
    await store.updateJob(
      'stream',
      {
        status: 'error',
        completedAt: Date.now() - 60_000,
        providerDrained: false,
        terminalHostActionPending: true,
      },
      job.createdAt,
    );
    await store.getTerminalHostActionJobs();
    expect((await store.getJob('stream'))?.providerDrained).toBe(false);
    expect(await store.purgeSourceRetention('stream', job.createdAt)).toBe(false);
    expect(await store.acknowledgeSourceReplayRelease(intent)).toBe(false);
  });
});
