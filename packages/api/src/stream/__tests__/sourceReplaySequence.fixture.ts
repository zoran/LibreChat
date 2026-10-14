import { randomUUID } from 'node:crypto';
import type { SourceReplayQuota } from '../internal/sourceBudget';
import type { IJobStoreV2 } from '../interfaces/IJobStore';
import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';
import { GenerationJobManagerClass } from '../GenerationJobManager';

/** Real manager event ordering with the assigned store, no provider or background timer. */
export async function exerciseSourceMetadataPrefix(
  store: IJobStoreV2,
  isRedis: boolean,
): Promise<void> {
  const streamId = randomUUID();
  const manager = new GenerationJobManagerClass();
  manager.configure({
    jobStore: store,
    eventTransport: new InMemoryEventTransport(),
    isRedis,
    cleanupOnComplete: false,
  });
  const reserve = jest.fn(
    async (
      _owner: Parameters<SourceReplayQuota['reserveFileSourceCopies']>[0],
      input: Parameters<SourceReplayQuota['reserveFileSourceCopies']>[1],
    ) => {
      const job = await store.getJob(streamId);
      expect(job?.sourceReplayIntent?.receipt.reservationId).toBe(input.reservationId);
      expect(await store.listSourceReplayIntents!()).toEqual(
        expect.arrayContaining([job!.sourceReplayIntent]),
      );
      return job!.sourceReplayIntent!.receipt;
    },
  );
  const release = jest.fn(async () => {
    expect(await store.getJob(streamId)).toMatchObject({
      providerDrained: true,
      sourceRetentionPurged: true,
    });
  });
  manager.configureSourceReplay({
    quota: { reserveFileSourceCopies: reserve, releaseFileSourceCopies: release },
  });
  try {
    const job = await manager.createJob(streamId, 'user', undefined, { trustedTenantId: 'tenant' });
    const providerId = job.metadata.providerExecutionId!;
    expect(await manager.beginProviderExecution(streamId, job.createdAt, providerId)).toBe(true);
    await manager.emitChunk(
      streamId,
      {
        event: 'on_run_step',
        data: {
          id: 'step',
          index: 0,
          type: 'message_creation',
          stepDetails: { type: 'message_creation', message_creation: { message_id: 'answer' } },
        },
      },
      { durable: true, expectedCreatedAt: job.createdAt },
    );
    // SDK metadata precedes its handleChatModelStart source-projection callback.
    expect(
      await manager.bindSourceRetention(streamId, job.createdAt, {
        sourceFileIds: ['file'],
        sourceExpiresAt: new Date(Date.now() + 60_000),
      }),
    ).toBe(true);
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(await store.getJob(streamId)).toMatchObject({
      sourceReplayHeld: true,
      providerDrained: false,
    });
    await manager.emitChunk(
      streamId,
      {
        event: 'on_message_delta',
        data: { id: 'answer', delta: { content: [{ type: 'text', text: 'bounded answer' }] } },
      },
      { durable: true, expectedCreatedAt: job.createdAt },
    );
    await manager.completeJob(streamId, 'Provider finished with an error', job.createdAt);
    expect(release).not.toHaveBeenCalled();
    await manager.markProviderExecutionDrained(streamId, job.createdAt, providerId);
    expect(release).toHaveBeenCalledTimes(1);
    expect(await store.listSourceReplayIntents!()).toEqual([]);
  } finally {
    await manager.destroy({ settlementBudgetMs: 0 });
  }
}

/** Failure after intent but before a confirmed Mongo reply must keep discoverable cleanup. */
export async function exercisePreboundSourceFailure(
  store: IJobStoreV2,
  isRedis: boolean,
): Promise<void> {
  const streamId = randomUUID();
  const manager = new GenerationJobManagerClass();
  manager.configure({
    jobStore: store,
    eventTransport: new InMemoryEventTransport(),
    isRedis,
    cleanupOnComplete: false,
  });
  const reserve = jest.fn(async () => {
    const placeholder = await store.getJob(streamId);
    expect(placeholder?.sourceReplayIntent).toBeDefined();
    expect(placeholder?.userMessage).toBeUndefined();
    expect(placeholder?.mcpRequestBody).toBeUndefined();
    throw new Error('Mongo outcome unknown');
  });
  const release = jest.fn(async (): Promise<void> => {
    throw new Error('Mongo cancellation unavailable');
  });
  manager.configureSourceReplay({
    quota: { reserveFileSourceCopies: reserve, releaseFileSourceCopies: release },
  });
  try {
    await expect(
      manager.createJob(streamId, 'user', undefined, {
        trustedTenantId: 'tenant',
        initialMetadata: {
          sourceRetention: {
            sourceFileIds: ['file'],
            sourceExpiresAt: new Date(Date.now() + 60_000),
          },
          userMessage: { messageId: 'user-message', text: 'retained excerpt' },
        },
      }),
    ).rejects.toMatchObject({ code: 'document_source_unavailable' });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(await store.listSourceReplayIntents!()).toHaveLength(1);
    expect((await store.getJob(streamId))?.userMessage).toBeUndefined();
    release.mockImplementation(async () => undefined);
    await (manager as unknown as { cleanup(): Promise<void> }).cleanup();
    expect(await store.listSourceReplayIntents!()).toEqual([]);
  } finally {
    await manager.destroy({ settlementBudgetMs: 0 });
  }
}
