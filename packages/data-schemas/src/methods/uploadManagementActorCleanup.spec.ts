/** Real replica-set evidence for exact actor settlement without storage/history/quota effects. */
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readUploadPromotionRecord } from 'librechat-data-provider';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { StoredUpload } from './uploadManagementStore';
import { useUploadStructureFixture } from '../../specs/fixtures/uploadManagement.structure.fixture';
import { createUploadActorSettlement } from '../../../api/src/uploads/actorSettlement';
import { createUploadAttemptJournal } from '../../../api/src/uploads/attempts';
import { createUploadManagementRepository } from './uploadManagement';

describe('durable Upload actor cleanup', () => {
  const f = useUploadStructureFixture();
  async function failed() {
    const lease = await f.processing();
    await f.repository.fail(lease, 'processing_failed', f.now + 1);
    return lease;
  }
  const row = () => f.db.models.UploadOperation.findById('structure').lean<StoredUpload>();
  it('discovers only fenced work of the exact incarnation with a bounded cursor', async () => {
    const lease = await f.processing();
    expect((await f.repository.cleanupForWorker(f.worker)).tasks).toEqual([]);
    await f.repository.fail(lease, 'processing_failed', f.now + 1);
    const batch = await f.repository.cleanupForWorker(f.worker, { limit: 1 });
    expect(batch.tasks).toHaveLength(1);
    expect(batch.tasks[0]).toMatchObject({
      operationId: 'structure',
      generation: lease.generation,
      worker: f.worker,
    });
    expect(
      (await f.repository.cleanupForWorker({ ...f.worker, instanceId: 'replacement' })).tasks,
    ).toEqual([]);
    expect(
      (await f.repository.cleanupForWorker(f.worker, { limit: 1, cursor: batch.cursor })).tasks,
    ).toHaveLength(1);
    await expect(f.repository.cleanupForWorker(f.worker, { limit: 101 })).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
  it('rejects forged actor/generation and active work without changing the durable row', async () => {
    const lease = await f.processing();
    const proof = {
      operationId: lease.operationId,
      generation: lease.generation,
      writerStopped: true,
      localCopiesAbsent: true,
    };
    await expect(f.repository.confirmActorCleanup(f.worker, proof, f.now)).rejects.toMatchObject({
      code: 'not_ready',
    });
    await f.repository.fail(lease, 'processing_failed', f.now + 1);
    const before = await row();
    await expect(
      f.repository.confirmActorCleanup({ ...f.worker, instanceId: 'other' }, proof, f.now + 2),
    ).rejects.toMatchObject({ code: 'lease_lost' });
    await expect(
      f.repository.confirmActorCleanup(
        f.worker,
        { ...proof, generation: lease.generation + 1 },
        f.now + 2,
      ),
    ).rejects.toMatchObject({ code: 'lease_lost' });
    expect(await row()).toEqual(before);
  });
  it('acknowledges replay across repository instances without deleting original/text or resetting debit', async () => {
    const lease = await failed();
    const before = await row();
    const usage = await f.repository.usage(f.user, f.now + 2);
    const proof = {
      operationId: lease.operationId,
      generation: lease.generation,
      writerStopped: true,
      localCopiesAbsent: true,
    };
    const second = createUploadManagementRepository(f.db, { securityPolicySha256: f.policy });
    await Promise.all([
      f.repository.confirmActorCleanup(f.worker, proof, f.now + 2),
      second.confirmActorCleanup(f.worker, proof, f.now + 2),
    ]);
    const after = await row();
    expect(after).toMatchObject({
      writerStopped: true,
      stagingHeld: false,
      originalBytes: before!.originalBytes,
      textBytes: before!.textBytes,
      acceptedAt: before!.acceptedAt,
      expiresAt: before!.expiresAt,
    });
    expect(after!.originalRemoved).toBe(before!.originalRemoved);
    expect(await f.repository.usage(f.user, f.now + 2)).toEqual(usage);
    expect((await second.cleanupForWorker(f.worker)).tasks).toEqual([]);
  });
  it('persists local absence while an unknown writer remains outstanding', async () => {
    const lease = await failed();
    await f.repository.confirmActorCleanup(
      f.worker,
      {
        operationId: lease.operationId,
        generation: lease.generation,
        writerStopped: false,
        localCopiesAbsent: true,
      },
      f.now + 2,
    );
    const raw = await row();
    expect(raw!.actorSettlement).toMatchObject({
      worker: f.worker,
      writerStopped: false,
      localCopiesAbsent: true,
    });
    expect(raw!.writerStopped).not.toBe(true);
    expect(raw!.stagingHeld).toBe(true);
    expect((await f.repository.cleanupForWorker(f.worker)).tasks[0]).toMatchObject({
      actorWriterStopped: false,
      writerStopped: false,
      localCopiesAbsent: true,
    });
  });
  it('persists local proof independently of scanner settlement and never adopts a stale receipt', async () => {
    const lease = await failed();
    await f.db.models.UploadOperation.updateOne(
      { _id: 'structure' },
      { $unset: { securitySettlement: 1 } },
    );
    const result = await f.repository.confirmActorCleanup(
      f.worker,
      {
        operationId: lease.operationId,
        generation: lease.generation,
        writerStopped: true,
        localCopiesAbsent: true,
      },
      f.now + 2,
    );
    expect(result).toMatchObject({
      actorWriterStopped: true,
      writerStopped: false,
      localCopiesAbsent: true,
    });
    expect((await row())!.stagingHeld).toBe(true);
    const replacement = { ...f.worker, instanceId: 'replacement' };
    await f.db.models.UploadOperation.updateOne(
      { _id: 'structure' },
      {
        $set: {
          worker: replacement,
          workerGeneration: lease.generation + 1,
        },
      },
    );
    expect((await f.repository.cleanupForWorker(replacement)).tasks[0]).toMatchObject({
      actorWriterStopped: false,
      localCopiesAbsent: false,
    });
  });
  it('discovers the distinct promotion owner without relabelling the original actor', async () => {
    const lease = await failed();
    const raw = await row();
    const app = { hostId: 'app-host', instanceId: 'app-promotion' };
    const promotion = readUploadPromotionRecord({
      version: 1,
      promotionId: '11111111-1111-4111-8111-111111111111',
      lease: {
        operationId: 'structure',
        tenantId: f.user.tenantId,
        userId: f.user.userId,
        generation: raw!.attemptGeneration,
        kind: 'transfer',
        ...f.worker,
        expiresAt: new Date(f.now + 60000).toISOString(),
      },
      worker: app,
      integrity: raw!.original!.integrity,
      approval: raw!.securityApproval,
      metadata: { filename: 'fixture.txt' },
      state: 'writing',
      writerStopped: false,
      receipt: raw!.original,
    });
    expect(promotion).not.toBeNull();
    await f.db.models.UploadOperation.updateOne({ _id: 'structure' }, { $set: { promotion } });
    const batch = await f.repository.cleanupForWorker(app);
    expect(batch.tasks[0]).toMatchObject({
      worker: f.worker,
      generation: lease.generation,
      promotion: { worker: app, lease: { generation: raw!.attemptGeneration } },
    });
    await expect(
      f.repository.confirmActorCleanup(
        app,
        {
          operationId: 'structure',
          generation: lease.generation,
          writerStopped: true,
          localCopiesAbsent: true,
        },
        f.now + 2,
      ),
    ).rejects.toMatchObject({ code: 'lease_lost' });
  });
  it('joins the actual local actor, records Mongo settlement and recovers a lost acknowledgement', async () => {
    const lease = await f.processing();
    const journal = createUploadAttemptJournal(f.worker);
    const attempt = journal.attempts.begin(jest.fn());
    attempt.bind(lease);
    const root = await mkdtemp(path.join(tmpdir(), 'actor-mongo-'));
    const directory = path.join(root, `structure.${lease.generation}`);
    await mkdir(directory);
    await writeFile(path.join(directory, 'original'), 'isolated actor fixture');
    await writeFile(path.join(root, 'unrelated'), 'retain unrelated local bytes');
    await f.repository.fail(lease, 'processing_failed', f.now + 1);
    attempt.settle({ writerStopped: true, localCopiesAbsent: false });
    const confirm = jest.fn(
      async (...args: Parameters<typeof f.repository.confirmActorCleanup>) => {
        await f.repository.confirmActorCleanup(...args);
        throw new Error('reply lost after durable commit');
      },
    );
    const actor = createUploadActorSettlement({
      worker: f.worker,
      attempts: journal.attempts,
      repository: { ...f.repository, confirmActorCleanup: confirm },
      stagingRoot: root,
      documents: { cancel: jest.fn() } as never,
      now: () => f.now + 2,
    });
    try {
      expect(await actor.reconcile(new AbortController().signal)).toMatchObject({ pending: 1 });
      const successor = createUploadManagementRepository(f.db, { securityPolicySha256: f.policy });
      expect(await successor.cleanupForFile(f.user, 'structure')).toMatchObject({
        writerStopped: true,
        localCopiesAbsent: true,
      });
      expect(await actor.reconcile(new AbortController().signal)).toEqual({
        scanned: 0,
        settled: 0,
        pending: 0,
      });
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(await readFile(path.join(root, 'unrelated'), 'utf8')).toBe(
        'retain unrelated local bytes',
      );
      expect((await row())!.originalBytes).toBe(f.bytes.length);
      expect(await journal.close(new AbortController().signal)).toEqual({ complete: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
