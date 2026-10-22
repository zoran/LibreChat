// Resolve the real schema owner once for source and prebuilt API consumers. No operation is mocked.
jest.mock('@librechat/data-schemas', () => jest.requireActual('../index'));
import type { HousekeepingJobRecord } from '../models/housekeepingJob';
import type { CounterRow } from './uploadManagementStore';
import { actualFileCleanup } from '../../tests/fileRetrieval/fileRetrievalApp';
import { boundGeneration, boundedAbort } from '../../tests/fileRetrieval/fileRetrievalGeneration';
import fixture from '../../../data-provider/src/__fixtures__/managed-retrieval-v1.json';
const settledGeneration = {
  revokeFileSourceGenerations: async () => ({ complete: true, pending: [] }),
};

it('actual trusted reconciliation issuer migrates a nonRAG legacy row and actual App deletion completes', async () => {
  const test = await actualFileCleanup(settledGeneration);
  try {
    await test.reconcile();
    const reconciled = await test.file();
    expect(reconciled.managedRetrieval!.revision).toBeNull();
    expect(reconciled.managedRetrieval!.legacy!.missingEvidence).toEqual(['revision']);
    const global =
      await test.accepted.db.models.UploadCounter.findById('global').lean<CounterRow>();
    expect(global!.value).not.toHaveProperty('reconciliationFence');
    expect(await test.remove()).toEqual({ deletedFileIds: [], failedFileIds: ['source-a'] });
    expect((await test.file()).deletionCompletedAt).toBeUndefined();
    expect(await test.consumer.work.maintenance.getMaintenanceCensus(null)).toMatchObject({
      pendingWrites: 0,
      queuedContinuations: 0,
      complete: true,
    });
    await test.cleanup();
    expect(await test.remove()).toEqual({ deletedFileIds: ['source-a'], failedFileIds: [] });
    const completed = await test.file();
    expect(completed.deletionCompletedAt).toBeInstanceOf(Date);
    expect(completed.managedRetrieval!.inventoryReceipt!.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(completed).not.toHaveProperty('text');
    expect(completed.retentionCleanup!.lifecycle!.derivatives).toMatchObject({
      retrieval: 'complete',
      checkpoints: 'complete',
      messages: 'complete',
    });
    const progress = completed.retentionCleanup!;
    expect(
      await test.accepted.db.models.HousekeepingJob.findById(
        progress.jobId,
      ).lean<HousekeepingJobRecord>(),
    ).toMatchObject({
      state: 'settled',
      claim: null,
      execution: { phase: 'complete', receiptRef: progress.lifecycle!.completionRef },
    });
    const deleted = await test.accepted.db.models.HousekeepingJob.findById(
      progress.jobId,
    ).lean<HousekeepingJobRecord>();
    await test.accepted.db.models.HousekeepingJob.deleteOne({ _id: progress.jobId });
    expect(await test.remove()).toEqual({ deletedFileIds: [], failedFileIds: ['source-a'] });
    await test.accepted.db.models.HousekeepingJob.collection.insertOne(deleted! as never);
    expect(await test.remove()).toEqual({ deletedFileIds: ['source-a'], failedFileIds: [] });
  } finally {
    await test.accepted.close();
  }
});

it('interrupted prepare/cleanup acknowledgement retains durable inventory evidence and retry finalizes', async () => {
  const test = await actualFileCleanup(settledGeneration);
  try {
    await test.reconcile();
    const receipt = (await test.file()).managedRetrieval!.inventoryReceipt;
    expect(await test.remove()).toEqual({ deletedFileIds: [], failedFileIds: ['source-a'] });
    await test.cleanup(true);
    expect(await test.remove()).toEqual({ deletedFileIds: [], failedFileIds: ['source-a'] });
    expect((await test.file()).deletionCompletedAt).toBeUndefined();
    expect((await test.file()).managedRetrieval!.inventoryReceipt).toEqual(receipt);
    await test.resume();
    expect(await test.remove()).toEqual({ deletedFileIds: ['source-a'], failedFileIds: [] });
    expect(await test.remove()).toEqual({ deletedFileIds: ['source-a'], failedFileIds: [] });
  } finally {
    await test.accepted.close();
  }
});

it('actual incomplete generation settlement remains discoverable until retry after genuine inventory', async () => {
  const identity = { ...fixture.revisionInput.owner, userId: '507f1f77bcf86cd799439011' };
  const generation = await boundGeneration(true, identity);
  const test = await actualFileCleanup(generation.manager);
  const revoke = jest.spyOn(generation.manager, 'revokeFileSourceGenerations');
  let deletion: Promise<unknown> | undefined;
  try {
    deletion = test.remove();
    void deletion.catch(() => undefined);
    await boundedAbort(generation.aborted);
    expect(await generation.drain()).toBe(true);
    await expect(deletion).rejects.toThrow('Document source');
    expect(await revoke.mock.results[0].value).toEqual({
      complete: false,
      pending: [{ streamId: generation.target.streamId, createdAt: generation.target.createdAt }],
    });
    expect(
      (await generation.store.getJob(generation.target.streamId))?.sourceRetentionPurged,
    ).not.toBe(true);
    expect(await generation.manager.getResumeState(generation.target.streamId)).toBeNull();
    expect((await test.file()).text).toBe(fixture.revisionInput.document.text);
    expect((await test.file()).retentionCleanup).toBeUndefined();
    generation.releasePurge();
    await test.reconcile();
    expect(await test.remove()).toEqual({ deletedFileIds: [], failedFileIds: ['source-a'] });
    expect((await generation.store.getJob(generation.target.streamId))?.sourceRetentionPurged).toBe(
      true,
    );
    await test.cleanup();
    expect(await test.remove()).toEqual({ deletedFileIds: ['source-a'], failedFileIds: [] });
    expect((await test.file()).retentionCleanup!.lifecycle!.storage!.state).toBe('consumed');
    expect((await test.file()).deletionCompletedAt).toBeInstanceOf(Date);
  } finally {
    generation.releasePurge();
    revoke.mockRestore();
    await generation.drain();
    await deletion?.catch(() => undefined);
    await generation.manager.destroy();
    await test.accepted.close();
  }
});
