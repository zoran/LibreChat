import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import type { UploadCleanupTask } from 'librechat-data-provider';
import { createManagedUploadCleanup } from './cleanup';

const worker = { hostId: 'host', instanceId: 'instance' };
const principal = { tenantId: 'tenant', userId: 'user', authentication: 'verified-email' as const };
const securityExecution = {
  version: 1 as const,
  attemptId: 'op.1',
  instanceId: '11111111-1111-4111-8111-111111111111',
  executionId: '22222222-2222-4222-8222-222222222222',
  expiresAt: '2026-10-17T02:01:00.000Z',
};
const securitySettlement = {
  execution: securityExecution,
  writerStopped: true,
  transientDataRemoved: true,
};
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
    const security = { cancel: jest.fn().mockRejectedValue(new Error('unavailable')) };
    const cleanup = createManagedUploadCleanup({
      repository,
      storage,
      documents,
      attempts,
      security,
      worker,
      stagingRoot: root,
      now: () => 1234,
    } as never);
    return { cleanup, repository, storage, documents, attempts, security };
  }

  it.each(['unavailable', 'foreign receipt', 'partial settlement'])(
    'retains cleanup obligations when the scanner returns %s',
    async (reason) => {
      const task = { ...base, state: 'failed' as const, fileId: undefined, securityExecution };
      const test = fixture(task);
      test.attempts.stopAndJoin.mockResolvedValue({
        writerStopped: true,
        localCopiesAbsent: true,
        securityPending: true,
      });
      if (reason === 'foreign receipt')
        test.security.cancel.mockResolvedValue({
          ...securitySettlement,
          execution: { ...securityExecution, executionId: '33333333-3333-4333-8333-333333333333' },
        });
      if (reason === 'partial settlement')
        test.security.cancel.mockResolvedValue({
          ...securitySettlement,
          transientDataRemoved: false,
        });
      expect(await test.cleanup.sweep({ deleteAcceptedFile: jest.fn() })).toMatchObject({
        pending: 1,
      });
      expect(test.storage.remove).not.toHaveBeenCalled();
      expect(test.repository.confirmCleanup).not.toHaveBeenCalled();
      expect(test.attempts.recordCleanup).toHaveBeenCalledWith(
        task,
        expect.objectContaining({ securityPending: true }),
      );
    },
  );

  it('retries the exact remote join and combines it only with known local completion', async () => {
    const task = { ...base, state: 'failed' as const, fileId: undefined, securityExecution };
    const test = fixture(task);
    test.attempts.stopAndJoin.mockResolvedValue({
      writerStopped: true,
      localCopiesAbsent: true,
      securityPending: true,
    });
    test.security.cancel.mockResolvedValue(securitySettlement);
    expect(await test.cleanup.sweep({ deleteAcceptedFile: jest.fn() })).toMatchObject({
      cleaned: 1,
    });
    expect(test.security.cancel).toHaveBeenCalledWith({
      execution: securityExecution,
      signal: expect.anything(),
    });
    expect(test.repository.confirmCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        writerStopped: true,
        originalAbsent: true,
        securitySettlement,
      }),
      1234,
    );
    expect(test.attempts.recordCleanup).toHaveBeenCalledWith(
      task,
      expect.objectContaining({ securityPending: false }),
    );
  });

  it.each(['missing local receipt', 'uncertain storage'])(
    'a positive scanner join cannot replace %s',
    async (reason) => {
      const task = { ...base, state: 'failed' as const, fileId: undefined, securityExecution };
      const test = fixture(task);
      test.security.cancel.mockResolvedValue(securitySettlement);
      if (reason === 'uncertain storage')
        test.attempts.stopAndJoin.mockResolvedValue({
          writerStopped: true,
          localCopiesAbsent: true,
          storageOutcome: 'unknown',
        });
      expect(await test.cleanup.sweep({ deleteAcceptedFile: jest.fn() })).toMatchObject({
        pending: 1,
      });
      expect(test.storage.remove).not.toHaveBeenCalled();
      expect(test.repository.confirmCleanup).not.toHaveBeenCalled();
    },
  );

  it('reuses durable scanner completion without restarting or contacting the scanner', async () => {
    const task = {
      ...base,
      writerStopped: true,
      localCopiesAbsent: true,
      securityExecution,
      securitySettlement,
    };
    const test = fixture(task);
    const proof = await test.cleanup.removeFileOriginal(task);
    expect(proof.securitySettlement).toEqual(securitySettlement);
    expect(test.security.cancel).not.toHaveBeenCalled();
    expect(proof.originalAbsent).toBe(true);
  });

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

  it('normalizes only the existing tenantless File owner and retains unknown guest cleanup', async () => {
    const guest = { authentication: 'guest', tenantId: null, userId: 'guest' } as const;
    const task = { ...base, principal: guest, writerStopped: true, localCopiesAbsent: true };
    const test = fixture(task);
    await expect(test.cleanup.beginFileDeletion({ userId: 'guest' }, 'op')).resolves.toEqual(task);
    expect(test.repository.cleanupForFile).toHaveBeenCalledWith(
      { tenantId: null, userId: 'guest' },
      'op',
    );
    test.storage.remove.mockResolvedValue('unknown');
    const proof = await test.cleanup.removeFileOriginal(task);
    expect(proof.originalAbsent).toBe(false);
    await expect(test.cleanup.finishFileDeletion(task, proof)).rejects.toThrow();
    expect(test.repository.confirmCleanup).not.toHaveBeenCalledWith(
      expect.objectContaining({ textAndHistoryRemoved: true }),
      expect.anything(),
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
