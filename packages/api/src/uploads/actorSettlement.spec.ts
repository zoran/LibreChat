/** Real local journal/filesystem evidence; repository transport failure remains an unknown ACK. */
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { UploadCleanupTask } from 'librechat-data-provider';
import { createUploadActorSettlement } from './actorSettlement';
import { createUploadAttemptJournal } from './attempts';
const worker = { hostId: 'host-a', instanceId: 'process-a' };
const task: UploadCleanupTask & { actorWriterStopped: boolean } = {
  operationId: 'owned',
  generation: 2,
  attemptGeneration: 1,
  principal: { tenantId: 'tenant-a', userId: 'user-a', authentication: 'verified-email' },
  worker,
  state: 'failed',
  writerStopped: false,
  actorWriterStopped: false,
  localCopiesAbsent: false,
};
describe('exact local upload actor settlement', () => {
  let root: string;
  beforeEach(async () => {
    if (!process.env.UPLOAD_TEST_TMPDIR) throw new Error('Explicit private fixture root required');
    root = await mkdtemp(path.join(process.env.UPLOAD_TEST_TMPDIR, 'actor-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  function fixture(row = task) {
    const journal = createUploadAttemptJournal(worker);
    const repository = {
      cleanupForWorker: jest.fn().mockResolvedValue({ tasks: [row], cursor: row.operationId }),
      confirmActorCleanup: jest.fn().mockImplementation(async (_worker, proof) => ({
        ...row,
        ...proof,
        actorWriterStopped: proof.writerStopped,
      })),
      settlePromotion: jest.fn(),
    };
    const documents = { cancel: jest.fn().mockResolvedValue({ writerStopped: false }) };
    const owner = createUploadActorSettlement({
      repository,
      documents,
      attempts: journal.attempts,
      worker,
      stagingRoot: root,
      now: () => 1234,
    } as never);
    return { owner, repository, journal, documents };
  }
  it('persists local stop/removal without claiming object or history deletion', async () => {
    const f = fixture();
    const attempt = f.journal.attempts.begin(jest.fn());
    attempt.bind({ ...worker, operationId: 'owned', generation: 2 });
    await mkdir(path.join(root, 'owned.2'));
    await writeFile(path.join(root, 'owned.2', 'original'), 'isolated fixture');
    attempt.settle({ writerStopped: true, localCopiesAbsent: false });
    expect(await f.owner.reconcile(new AbortController().signal)).toMatchObject({ settled: 1 });
    expect(f.repository.confirmActorCleanup).toHaveBeenCalledWith(
      worker,
      {
        operationId: 'owned',
        generation: 2,
        writerStopped: true,
        localWriterStopped: true,
        localCopiesAbsent: true,
      },
      1234,
    );
    expect(await f.journal.close(new AbortController().signal)).toEqual({ complete: true });
    f.repository.cleanupForWorker.mockResolvedValue({ tasks: [], cursor: null });
    expect(await f.owner.reconcile(new AbortController().signal)).toEqual({
      scanned: 0,
      settled: 0,
      pending: 0,
    });
  });
  it('persists local-only join while preserving the original unknown storage history', async () => {
    const f = fixture();
    const attempt = f.journal.attempts.begin(jest.fn());
    attempt.bind({ ...worker, operationId: 'owned', generation: 2 });
    await mkdir(path.join(root, 'owned.2'));
    await writeFile(path.join(root, 'owned.2', 'original'), 'private unknown-upload fixture');
    attempt.settle({
      writerStopped: false,
      localWriterStopped: true,
      localCopiesAbsent: false,
      storageOutcome: 'unknown',
    });
    expect(await f.owner.reconcile(new AbortController().signal)).toMatchObject({
      settled: 0,
      pending: 1,
    });
    expect(f.repository.confirmActorCleanup).toHaveBeenCalledWith(
      worker,
      expect.objectContaining({
        writerStopped: false,
        localWriterStopped: true,
        localCopiesAbsent: true,
      }),
      1234,
    );
    expect(await f.journal.close(AbortSignal.abort())).toEqual({ complete: false });
  });
  it('retries a lost durable acknowledgement using the same real journal proof', async () => {
    const f = fixture();
    const abort = jest.fn();
    const attempt = f.journal.attempts.begin(abort);
    attempt.bind({ ...worker, operationId: 'owned', generation: 2 });
    attempt.settle({ writerStopped: true, localCopiesAbsent: true });
    f.repository.confirmActorCleanup.mockRejectedValueOnce(new Error('ack lost'));
    expect(await f.owner.reconcile(new AbortController().signal)).toMatchObject({
      pending: 1,
      settled: 0,
    });
    expect(await f.owner.reconcile(new AbortController().signal)).toMatchObject({ settled: 1 });
    expect(f.repository.confirmActorCleanup).toHaveBeenCalledTimes(2);
    expect(abort).not.toHaveBeenCalled();
  });
  it('does not erase staging when its local writer is absent from this incarnation', async () => {
    const f = fixture();
    await mkdir(path.join(root, 'owned.2'));
    const file = path.join(root, 'owned.2', 'original');
    await writeFile(file, 'must remain');
    expect(await f.owner.reconcile(new AbortController().signal)).toMatchObject({
      pending: 1,
      settled: 0,
    });
    expect(f.repository.confirmActorCleanup).toHaveBeenCalledWith(
      worker,
      expect.objectContaining({ writerStopped: false, localCopiesAbsent: false }),
      1234,
    );
    expect(await readFile(file, 'utf8')).toBe('must remain');
    expect(f.documents.cancel).not.toHaveBeenCalled();
  });
  it('keeps an unknown object writer unknown while retaining actual local absence', async () => {
    const f = fixture();
    const attempt = f.journal.attempts.begin(jest.fn());
    attempt.bind({ ...worker, operationId: 'owned', generation: 2 });
    attempt.settle({ writerStopped: true, localCopiesAbsent: true, storageOutcome: 'unknown' });
    expect(await f.owner.reconcile(new AbortController().signal)).toMatchObject({
      pending: 1,
      settled: 0,
    });
    expect(f.repository.confirmActorCleanup).toHaveBeenCalledWith(
      worker,
      expect.objectContaining({ writerStopped: false, localCopiesAbsent: true }),
      1234,
    );
    expect(await f.journal.close(new AbortController().signal)).toEqual({ complete: false });
  });
  it('refuses foreign and unfenced actor rows without invoking local cleanup', async () => {
    for (const row of [
      { ...task, worker: { ...worker, instanceId: 'other-process' } },
      { ...task, state: 'processing' as const },
    ]) {
      const f = fixture(row);
      expect(await f.owner.reconcile(new AbortController().signal)).toMatchObject({ pending: 1 });
      expect(f.repository.confirmActorCleanup).not.toHaveBeenCalled();
      expect(f.documents.cancel).not.toHaveBeenCalled();
    }
  });
  it('uses already durable exact actor proof without requiring the lost memory journal', async () => {
    const f = fixture({ ...task, actorWriterStopped: true, localCopiesAbsent: true });
    expect(await f.owner.reconcile(new AbortController().signal)).toMatchObject({ settled: 1 });
    expect(f.repository.confirmActorCleanup).toHaveBeenCalledWith(
      worker,
      expect.objectContaining({ writerStopped: true, localCopiesAbsent: true }),
      1234,
    );
  });
});
