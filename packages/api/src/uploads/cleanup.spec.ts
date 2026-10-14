import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import type { UploadCleanupTask } from 'librechat-data-provider';
import { createManagedUploadCleanup } from './cleanup';

const worker = { hostId: 'host', instanceId: 'instance' };
const principal = { tenantId: 'tenant', userId: 'user', authentication: 'verified-email' as const };
const base: UploadCleanupTask = {
  operationId: 'op',
  generation: 2,
  attemptGeneration: 1,
  principal,
  worker,
  state: 'deleted',
  fileId: 'op',
  writerStopped: false,
  localCopiesAbsent: false,
};

describe('sole File owner managed cleanup adapter', () => {
  let root: string;
  beforeAll(async () => {
    if (!process.env.UPLOAD_TEST_TMPDIR)
      throw new Error('Explicit isolated upload test directory required');
    await mkdir(process.env.UPLOAD_TEST_TMPDIR, { recursive: true });
    root = await mkdtemp(path.join(process.env.UPLOAD_TEST_TMPDIR, 'cleanup-'));
  });
  afterEach(async () => {
    for (const name of await readdir(root))
      await rm(path.join(root, name), { recursive: true, force: true });
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });
  function fixture(task: UploadCleanupTask = base) {
    const repository = {
      cleanupForFile: jest.fn().mockResolvedValue(task),
      delete: jest.fn().mockResolvedValue({}),
      reconcile: jest.fn().mockResolvedValue([]),
      cleanupTasks: jest.fn().mockResolvedValue([task]),
      confirmCleanup: jest.fn().mockResolvedValue({ cleanupPending: false }),
    };
    const storage = {
      put: jest.fn(),
      read: jest.fn(),
      remove: jest.fn().mockResolvedValue('absent'),
    };
    const documents = {
      prepare: jest.fn(),
      extract: jest.fn(),
      cancel: jest.fn().mockResolvedValue({ writerStopped: false }),
    };
    const attempts = {
      begin: jest.fn(),
      stopAndJoin: jest.fn().mockResolvedValue({ writerStopped: false, localCopiesAbsent: false }),
      recordCleanup: jest.fn(),
    };
    const cleanup = createManagedUploadCleanup({
      repository,
      storage,
      documents,
      attempts,
      worker,
      stagingRoot: root,
      now: () => 1234,
    } as never);
    return { cleanup, repository, storage, documents, attempts };
  }

  it('fences the exact managed file then reloads durable cleanup facts', async () => {
    const test = fixture();
    await expect(test.cleanup.beginFileDeletion(principal, 'op')).resolves.toEqual(base);
    expect(test.repository.cleanupForFile).toHaveBeenCalledWith(
      { tenantId: 'tenant', userId: 'user' },
      'op',
    );
    expect(test.repository.delete).toHaveBeenCalledWith(principal, 'op', 1234);
    expect(test.repository.cleanupForFile.mock.invocationCallOrder[1]).toBeGreaterThan(
      test.repository.delete.mock.invocationCallOrder[0],
    );
  });

  it('a legacy file lookup does not mutate upload state', async () => {
    const test = fixture();
    test.repository.cleanupForFile.mockResolvedValue(null);
    await expect(test.cleanup.beginFileDeletion(principal, 'legacy')).resolves.toBeNull();
    expect(test.repository.delete).not.toHaveBeenCalled();
  });

  it('never deletes or releases an uncertain remote PUT after local promise settlement', async () => {
    const test = fixture({ ...base, fileId: undefined, state: 'failed' });
    test.attempts.stopAndJoin.mockResolvedValue({
      writerStopped: false,
      localCopiesAbsent: true,
      storageOutcome: 'unknown',
    });
    await expect(test.cleanup.sweep({ deleteAcceptedFile: jest.fn() })).resolves.toMatchObject({
      pending: 1,
    });
    expect(test.storage.remove).not.toHaveBeenCalled();
    expect(test.repository.confirmCleanup).not.toHaveBeenCalled();
  });

  it('keeps another incarnation unknown without touching this socket or disk', async () => {
    const task = {
      ...base,
      worker: { ...worker, instanceId: 'previous' },
      parserExecution: { attemptId: 'op.2', instanceId: 'old-parser', expiresAt: '2000-01-01' },
    };
    const test = fixture(task);
    const proof = await test.cleanup.removeFileOriginal(task);
    expect(proof.writerStopped).toBe(false);
    expect(test.attempts.stopAndJoin).not.toHaveBeenCalled();
    expect(test.documents.cancel).not.toHaveBeenCalled();
    expect(test.storage.remove).not.toHaveBeenCalled();
  });

  it('uses original attempt generation for physical deletion and proves history only after finalization', async () => {
    const task = { ...base, writerStopped: true, localCopiesAbsent: true };
    const test = fixture(task);
    const proof = await test.cleanup.removeFileOriginal(task);
    expect(test.storage.remove).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'op',
        generation: 1,
        tenantId: 'tenant',
        userId: 'user',
      }),
    );
    expect(test.repository.confirmCleanup).toHaveBeenLastCalledWith(
      expect.objectContaining({
        generation: 2,
        originalAbsent: true,
        textAndHistoryRemoved: false,
      }),
      1234,
    );
    await test.cleanup.finishFileDeletion(task, proof);
    expect(test.repository.confirmCleanup).toHaveBeenLastCalledWith(
      expect.objectContaining({ originalAbsent: true, textAndHistoryRemoved: true }),
      1234,
    );
  });

  it('cannot finalize an unconfirmed version-aware deletion', async () => {
    const task = { ...base, writerStopped: true, localCopiesAbsent: true };
    const test = fixture(task);
    test.storage.remove.mockResolvedValue('unknown');
    const proof = await test.cleanup.removeFileOriginal(task);
    await expect(test.cleanup.finishFileDeletion(task, proof)).rejects.toThrow();
    expect(test.repository.confirmCleanup).toHaveBeenCalledTimes(1);
    expect(test.repository.confirmCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ originalAbsent: false, textAndHistoryRemoved: false }),
      1234,
    );
  });

  it('joins the exact parser before local cleanup while retaining an accepted failed original', async () => {
    const task = {
      ...base,
      state: 'failed' as const,
      parserExecution: { attemptId: 'op.2', instanceId: 'parser', expiresAt: '2099-01-01' },
    };
    const test = fixture(task);
    test.documents.cancel.mockResolvedValue({ writerStopped: true });
    await mkdir(path.join(root, 'op.2'));
    await writeFile(path.join(root, 'op.2', 'original'), 'owned input');
    await test.cleanup.sweep({ deleteAcceptedFile: jest.fn() });
    expect(test.documents.cancel).toHaveBeenCalledWith(
      expect.objectContaining({ execution: task.parserExecution }),
    );
    expect(await readdir(root)).toEqual([]);
    expect(test.storage.remove).not.toHaveBeenCalled();
    expect(test.repository.confirmCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        writerStopped: true,
        localCopiesAbsent: true,
        originalAbsent: false,
        textAndHistoryRemoved: false,
      }),
      1234,
    );
  });

  it('retains a replaced staging path instead of following it', async () => {
    const task = { ...base, state: 'failed' as const, writerStopped: true };
    const test = fixture(task);
    await mkdir(path.join(root, 'foreign'));
    await writeFile(path.join(root, 'foreign', 'original'), 'preserve');
    await symlink(path.join(root, 'foreign'), path.join(root, 'op.2'));
    await test.cleanup.sweep({ deleteAcceptedFile: jest.fn() });
    expect(await readFile(path.join(root, 'foreign', 'original'), 'utf8')).toBe('preserve');
    expect(test.repository.confirmCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ localCopiesAbsent: false }),
      1234,
    );
  });

  it('cleans a never-admitted reservation without inventing a storage attempt', async () => {
    const task = {
      ...base,
      fileId: undefined,
      attemptGeneration: undefined,
      worker: undefined,
      state: 'cancelled' as const,
      writerStopped: true,
      localCopiesAbsent: true,
    };
    const test = fixture(task);
    await expect(test.cleanup.sweep({ deleteAcceptedFile: jest.fn() })).resolves.toMatchObject({
      cleaned: 1,
    });
    expect(test.storage.remove).not.toHaveBeenCalled();
    expect(test.repository.confirmCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ originalAbsent: true, textAndHistoryRemoved: true }),
      1234,
    );
  });

  it('routes accepted deletion back through File composition and never stops a live task', async () => {
    const test = fixture();
    const deleteAcceptedFile = jest.fn().mockResolvedValue(false);
    test.repository.cleanupTasks.mockResolvedValue([
      base,
      { ...base, operationId: 'live', state: 'processing' },
    ]);
    await expect(test.cleanup.sweep({ deleteAcceptedFile })).resolves.toEqual({
      scanned: 2,
      cleaned: 0,
      pending: 1,
    });
    expect(deleteAcceptedFile).toHaveBeenCalledTimes(1);
    expect(test.storage.remove).not.toHaveBeenCalled();
    expect(test.attempts.stopAndJoin).not.toHaveBeenCalled();
  });
});
