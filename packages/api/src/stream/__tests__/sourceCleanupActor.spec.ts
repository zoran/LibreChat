import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '../GenerationJobManager';
import { createSourceReplayIntent } from '../internal/sourceBudget';

type ActorTestView = {
  cleanup(): Promise<void>;
  sourceCleanupFlights: Set<Promise<void>>;
  runtimeState: Map<
    string,
    {
      abortController: AbortController;
      earlyEventBuffer: unknown[];
      sourceCleanupHandlers?: Set<() => void>;
    }
  >;
};
async function fixture() {
  const store = new InMemoryJobStore();
  const transport = new InMemoryEventTransport();
  const manager = new GenerationJobManagerClass();
  manager.configure({
    jobStore: store,
    eventTransport: transport,
    isRedis: false,
    cleanupOnComplete: true,
  });
  manager.initialize();
  const job = await manager.createJob('source-actor', 'user', undefined, {
    trustedTenantId: 'tenant',
  });
  const persisted = (await store.getJob(job.streamId))!;
  const intent = createSourceReplayIntent(persisted, ['file'], Date.now() + 60_000);
  await store.prepareSourceReplay(intent);
  await store.commitSourceReplay(intent);
  return { store, manager, job: persisted, view: manager as unknown as ActorTestView };
}

describe('actual generation source actor', () => {
  it('cancels observed owners beyond the four terminal slots and settles the queued actor', async () => {
    const { store, manager, job, view } = await fixture();
    const jobs = [job];
    for (let i = 0; i < 4; i++) {
      const created = await manager.createJob(`queued-${i}`, 'user', undefined, {
        trustedTenantId: 'tenant',
      });
      const stored = (await store.getJob(created.streamId))!;
      const intent = createSourceReplayIntent(stored, ['file'], Date.now() + 60_000);
      await store.prepareSourceReplay(intent);
      await store.commitSourceReplay(intent);
      jobs.push(stored);
    }
    const controllers = jobs.map((row) => view.runtimeState.get(row.streamId)!.abortController);
    try {
      for (const row of jobs) {
        expect(
          await manager.beginProviderExecution(
            row.streamId,
            row.createdAt,
            row.providerExecutionId!,
          ),
        ).toBe(true);
        await store.revokeSourceRetention(row.streamId, row.createdAt);
      }
      await view.cleanup();
      for (const controller of controllers) expect(controller.signal.aborted).toBe(true);
      expect(view.sourceCleanupFlights.size).toBe(4);
      for (const row of jobs)
        await manager.markProviderExecutionDrained(
          row.streamId,
          row.createdAt,
          row.providerExecutionId!,
        );
      for (let i = 0; i < 5 && view.sourceCleanupFlights.size; i++)
        await Promise.all([...view.sourceCleanupFlights]);
      for (const row of jobs)
        expect((await store.getJob(row.streamId))?.sourceActorSettlement?.localCopiesAbsent).toBe(
          true,
        );
    } finally {
      for (const row of jobs)
        await manager.markProviderExecutionDrained(
          row.streamId,
          row.createdAt,
          row.providerExecutionId!,
        );
      await manager.destroy();
    }
  });

  // Slow unresolved receipts must not let earlier actors monopolize every owner-loop round.
  it('gives a waiting actor the next slot across two slow unresolved retry rounds', async () => {
    const { store, manager, job, view } = await fixture();
    const jobs = [job];
    for (let i = 0; i < 4; i++) {
      const created = await manager.createJob(`fair-${i}`, 'user', undefined, {
        trustedTenantId: 'tenant',
      });
      const stored = (await store.getJob(created.streamId))!;
      const intent = createSourceReplayIntent(stored, ['file'], Date.now() + 60_000);
      await store.prepareSourceReplay(intent);
      await store.commitSourceReplay(intent);
      jobs.push(stored);
    }
    const delayed = new Set(jobs.slice(0, 4).map((row) => row.streamId));
    const attempts = new Map<string, number>();
    const releases: Array<() => void> = [];
    let stopping = false;
    const original = store.recordSourceActorSettlement.bind(store);
    jest.spyOn(store, 'recordSourceActorSettlement').mockImplementation(async (receipt) => {
      const attempt = (attempts.get(receipt.streamId) ?? 0) + 1;
      attempts.set(receipt.streamId, attempt);
      if (!stopping && delayed.has(receipt.streamId) && attempt <= 2) {
        await new Promise<void>((resolve) => releases.push(resolve));
        return false;
      }
      return original(receipt);
    });
    const waitFor = async (ready: () => boolean) => {
      for (let i = 0; i < 100 && !ready(); i++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(ready()).toBe(true);
    };
    try {
      for (const row of jobs) {
        expect(
          await manager.beginProviderExecution(
            row.streamId,
            row.createdAt,
            row.providerExecutionId!,
          ),
        ).toBe(true);
        await store.revokeSourceRetention(row.streamId, row.createdAt);
        await manager.markProviderExecutionDrained(
          row.streamId,
          row.createdAt,
          row.providerExecutionId!,
        );
      }
      await view.cleanup();
      await waitFor(() => releases.length === 4);
      expect(view.sourceCleanupFlights.size).toBe(4);
      const firstRound = [...view.sourceCleanupFlights];
      // Advance the real owner loop while its four earlier attempts still own their slots.
      await view.cleanup();
      releases[0]();
      await Promise.race(firstRound);
      await waitFor(() => (attempts.get(jobs[4].streamId) ?? 0) > 0 || releases.length > 4);
      expect((await store.getJob(jobs[4].streamId))?.sourceActorSettlement).toMatchObject({
        createdAt: jobs[4].createdAt,
        providerExecutionId: jobs[4].providerExecutionId,
        localCopiesAbsent: true,
      });
      expect(view.sourceCleanupFlights.size).toBeLessThanOrEqual(4);
      for (const release of releases.slice(1, 4)) release();
      await waitFor(() => releases.length === 8);
      expect(view.sourceCleanupFlights.size).toBe(4);
      for (const row of jobs.slice(0, 4)) {
        expect(attempts.get(row.streamId)).toBe(2);
        expect((await store.getJob(row.streamId))?.sourceActorSettlement).toBeUndefined();
      }
      // A second round change must retain custody while those retries are still unresolved.
      await view.cleanup();
      for (const release of releases.slice(4)) release();
      for (let i = 0; i < 5 && view.sourceCleanupFlights.size; i++)
        await Promise.all([...view.sourceCleanupFlights]);
      for (const row of jobs)
        expect((await store.getJob(row.streamId))?.sourceActorSettlement?.localCopiesAbsent).toBe(
          true,
        );
      for (const row of jobs.slice(0, 4)) expect(attempts.get(row.streamId)).toBe(3);
    } finally {
      stopping = true;
      for (const release of releases) release();
      for (const row of jobs)
        await manager.markProviderExecutionDrained(
          row.streamId,
          row.createdAt,
          row.providerExecutionId!,
        );
      for (let i = 0; i < 5 && view.sourceCleanupFlights.size; i++)
        await Promise.all([...view.sourceCleanupFlights]);
      await manager.destroy();
    }
  });

  it('recovers a lost wakeup through the owner loop and waits for real provider drain/local cleanup', async () => {
    const { store, manager, job, view } = await fixture();
    const abort = jest.spyOn(manager, 'abortJob');
    const runtime = view.runtimeState.get(job.streamId)!;
    runtime.earlyEventBuffer.push({ text: 'private source bytes' });
    const localCleanup = jest.fn();
    runtime.sourceCleanupHandlers = new Set([localCleanup]);
    try {
      expect(
        await manager.beginProviderExecution(job.streamId, job.createdAt, job.providerExecutionId!),
      ).toBe(true);
      await store.revokeSourceRetention(job.streamId, job.createdAt);
      await view.cleanup();
      expect(runtime.abortController.signal.aborted).toBe(true);
      expect((await store.getJob(job.streamId))?.sourceActorSettlement).toBeUndefined();
      expect(abort).toHaveBeenCalledWith(
        job.streamId,
        expect.objectContaining({ expectedCreatedAt: job.createdAt, awaitProviderDrain: true }),
      );
      await manager.markProviderExecutionDrained(
        job.streamId,
        job.createdAt,
        job.providerExecutionId!,
      );
      await Promise.all([...view.sourceCleanupFlights]);
      expect((await store.getJob(job.streamId))?.sourceActorSettlement).toMatchObject({
        streamId: job.streamId,
        createdAt: job.createdAt,
        providerExecutionId: job.providerExecutionId,
        sourceFileIds: ['file'],
        localCopiesAbsent: true,
      });
      expect(localCleanup).toHaveBeenCalled();
      expect(runtime.earlyEventBuffer).toEqual([]);
    } finally {
      await manager.markProviderExecutionDrained(
        job.streamId,
        job.createdAt,
        job.providerExecutionId!,
      );
      await manager.destroy();
    }
  });

  it('does not issue actor evidence for a facade that only observed another owner', async () => {
    const { store, manager, job } = await fixture();
    const observer = new GenerationJobManagerClass();
    observer.configure({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    await observer.getJob(job.streamId);
    await store.revokeSourceRetention(job.streamId, job.createdAt);
    try {
      await (observer as unknown as ActorTestView).cleanup();
      expect((await store.getJob(job.streamId))?.sourceActorSettlement).toBeUndefined();
      expect((await store.getJob(job.streamId))?.status).toBe('running');
    } finally {
      await manager.markProviderExecutionDrained(
        job.streamId,
        job.createdAt,
        job.providerExecutionId!,
      );
      await manager.destroy();
    }
  });

  it('retries a lost actor receipt on the existing owner loop after the runtime finalizer retired it', async () => {
    const { store, manager, job, view } = await fixture();
    const write = jest
      .spyOn(store, 'recordSourceActorSettlement')
      .mockRejectedValueOnce(new Error('reply lost'));
    await store.revokeSourceRetention(job.streamId, job.createdAt);
    await manager.markProviderExecutionDrained(
      job.streamId,
      job.createdAt,
      job.providerExecutionId!,
    );
    try {
      await view.cleanup();
      await Promise.all([...view.sourceCleanupFlights]);
      expect(write).toHaveBeenCalledTimes(1);
      expect((await store.getJob(job.streamId))?.sourceActorSettlement).toBeUndefined();
      await view.cleanup();
      await Promise.all([...view.sourceCleanupFlights]);
      expect(write).toHaveBeenCalledTimes(2);
      expect((await store.getJob(job.streamId))?.sourceActorSettlement).toMatchObject({
        localCopiesAbsent: true,
      });
    } finally {
      await manager.destroy();
    }
  });

  it('keeps store custody when the shutdown budget expires with an actor write still in flight', async () => {
    const { store, manager, job, view } = await fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = store.recordSourceActorSettlement.bind(store);
    const writing = jest
      .spyOn(store, 'recordSourceActorSettlement')
      .mockImplementation(async (receipt) => {
        await blocked;
        return original(receipt);
      });
    const destroy = jest.spyOn(store, 'destroy');
    await store.revokeSourceRetention(job.streamId, job.createdAt);
    await manager.markProviderExecutionDrained(
      job.streamId,
      job.createdAt,
      job.providerExecutionId!,
    );
    try {
      await view.cleanup();
      for (let i = 0; i < 50 && !writing.mock.calls.length; i++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(writing).toHaveBeenCalled();
      await expect(manager.destroy({ settlementBudgetMs: 1 })).rejects.toThrow('shutdown_pending');
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      release();
      await Promise.all([...view.sourceCleanupFlights]);
      await manager.destroy();
    }
  });

  it('fences a provider replacement at the actual abort CAS', async () => {
    const { store, manager, job } = await fixture();
    const transition = store.transitionStatusAndDrainSteers.bind(store);
    jest.spyOn(store, 'transitionStatusAndDrainSteers').mockImplementationOnce(async (id, args) => {
      await store.updateJob(id, { providerExecutionId: 'successor' }, job.createdAt);
      return transition(id, args);
    });
    try {
      const result = await manager.abortJob(job.streamId, {
        expectedCreatedAt: job.createdAt,
        expectedProviderExecutionId: job.providerExecutionId,
        awaitProviderDrain: true,
      });
      expect(result).toMatchObject({ success: false, failureReason: 'generation_replaced' });
      expect((await store.getJob(job.streamId))?.status).toBe('running');
    } finally {
      await manager.markProviderExecutionDrained(job.streamId, job.createdAt, 'successor');
      await manager.destroy();
    }
  });
});
