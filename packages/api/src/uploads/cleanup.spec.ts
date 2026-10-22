import path from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import type { UploadCleanupTask } from 'librechat-data-provider';
import type { StoragePort } from './contract';
import { createUploadActorSettlement } from './actorSettlement';
import { createManagedUploadCleanup } from './cleanup';

const worker = { hostId: 'host', instanceId: 'instance' };
const principal = { tenantId: 'tenant', userId: 'user', authentication: 'verified-email' as const };
const securityExecution = {
  version: 2 as const,
  custody: { kind: 'none' as const },
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
      confirmCleanup: jest.fn().mockImplementation(async (proof) => ({
        cleanupPending: task.attemptGeneration != null && !proof.originalAbsent,
      })),
      prepareCleanupStorage: jest.fn().mockResolvedValue({ state: 'pending' }),
      recordCleanupStorage: jest.fn(),
    };
    const storage = {
      describeDeletion: jest.fn(() => {
        throw new Error('Unexpected storage deletion binding');
      }),
      beginDeletion: jest.fn(async () => {
        throw new Error('Unexpected storage deletion request');
      }),
      observeDeletion: jest.fn(async () => {
        throw new Error('Unexpected storage deletion observation');
      }),
      acknowledgeDeletionConsumed: jest.fn(async () => {
        throw new Error('Unexpected storage deletion consumption');
      }),
      put: jest.fn(),
      read: jest.fn(),
      remove: jest.fn().mockResolvedValue('absent'),
    } satisfies StoragePort;
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
      actor: createUploadActorSettlement({
        repository,
        documents,
        attempts,
        security,
        worker,
        stagingRoot: root,
        now: () => 1234,
      } as never),
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
      pending: 1,
    });
    expect(test.security.cancel).toHaveBeenCalledWith({
      execution: securityExecution,
      signal: expect.anything(),
    });
    expect(test.repository.confirmCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        writerStopped: true,
        originalAbsent: false,
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
    expect(proof.originalAbsent).toBe(false);
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

  it('retains accepted File custody until the File owner supplies a durable deletion receipt', async () => {
    const task = { ...base, writerStopped: true, localCopiesAbsent: true };
    const test = fixture(task);
    const proof = await test.cleanup.removeFileOriginal(task);
    expect(proof.originalAbsent).toBe(false);
    expect(test.storage.remove).not.toHaveBeenCalled();
    expect(test.repository.prepareCleanupStorage).not.toHaveBeenCalled();
    await expect(test.cleanup.finishFileDeletion(task, proof)).rejects.toThrow(
      'Managed original absence required',
    );
    expect(test.repository.confirmCleanup).toHaveBeenLastCalledWith(
      expect.objectContaining({
        generation: 2,
        originalAbsent: false,
        textAndHistoryRemoved: false,
      }),
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

  it('never lets an old aggregate stop flag bypass an invalid App promotion obligation', async () => {
    const task = {
      ...base,
      state: 'failed' as const,
      writerStopped: true,
      localCopiesAbsent: true,
      promotion: {} as never,
    };
    const test = fixture(task);
    await expect(test.cleanup.sweep({ deleteAcceptedFile: jest.fn() })).resolves.toMatchObject({
      pending: 1,
      cleaned: 0,
    });
    expect(test.storage.remove).not.toHaveBeenCalled();
    expect(test.repository.confirmCleanup).not.toHaveBeenCalled();
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
  it.each([true, false])(
    'runs without actor-local capabilities only from durable stop proof (%s)',
    async (stopped) => {
      const test = fixture({ ...base, writerStopped: stopped, localCopiesAbsent: stopped });
      const cleanup = createManagedUploadCleanup({
        repository: test.repository,
        storage: test.storage,
        now: () => 1234,
      });
      const proof = await cleanup.removeFileOriginal({
        ...base,
        writerStopped: stopped,
        localCopiesAbsent: stopped,
      });
      expect(proof.originalAbsent).toBe(false);
      expect(test.storage.remove).not.toHaveBeenCalled();
      expect(test.storage.describeDeletion).not.toHaveBeenCalled();
      expect(test.storage.beginDeletion).not.toHaveBeenCalled();
      expect(test.storage.observeDeletion).not.toHaveBeenCalled();
      expect(test.storage.acknowledgeDeletionConsumed).not.toHaveBeenCalled();
      expect(test.attempts.stopAndJoin).not.toHaveBeenCalled();
      expect(test.documents.cancel).not.toHaveBeenCalled();
    },
  );
});

/** Explicit protocol-port fixture; actual persistence and accounting are covered by Mongo owner cases. */
describe('single-operation Upload Housekeeping receipt orchestration', () => {
  const claim = {
    jobId: 'job',
    worker: { podUid: 'pod', incarnation: 'inc', source: 'src', hostId: 'host' },
    claimId: 'claim',
    fence: 1,
    executionId: 'execution',
    progressRevision: 4,
    leaseUntil: '2030-01-01T00:00:00.000Z',
    work: {
      handler: 'upload.cleanup' as const,
      subject: { tenantId: 'tenant', ownerUserId: 'user' },
      operationId: 'op',
      cleanupGeneration: 9,
      attemptGeneration: 1,
    },
  };
  const request = {
    protocol: 1,
    requestId: 'persisted-request',
    generation: '1',
    authorityBindingSHA256: 'a'.repeat(64),
    acceptedObjectSHA256: 'b'.repeat(64),
  };
  const binding = {
    ...request,
    bucket: 'bucket',
    key: 't/tenant/managed-uploads/user/op.1__original',
  };
  const receipt = {
    ...binding,
    state: 'durable_delete_complete',
    obligationId: 'obligation',
    aggregateRevision: '2',
    proofSHA256: 'c'.repeat(64),
  };
  const observe = { state: 'observe', request, binding };
  function setup() {
    const task = {
      ...base,
      state: 'failed',
      fileId: undefined,
      writerStopped: false,
      localCopiesAbsent: false,
    };
    const repository = {
      prepareHousekeepingCleanup: jest.fn().mockResolvedValue({ state: 'ready', task }),
      confirmHousekeepingCleanup: jest.fn(),
      prepareCleanupStorage: jest
        .fn()
        .mockResolvedValueOnce({ state: 'binding', request })
        .mockResolvedValue(observe),
      recordCleanupStorage: jest.fn().mockResolvedValue(observe),
      reconcile: jest.fn(),
      cleanupTasks: jest.fn(),
      confirmCleanup: jest.fn(),
    };
    const storage = {
      describeDeletion: jest.fn().mockReturnValue(binding),
      observeDeletion: jest
        .fn()
        .mockResolvedValue({ ...binding, state: 'namespace_absent', obligationId: 'obligation' }),
      beginDeletion: jest.fn().mockResolvedValue({ ...binding, state: 'unknown' }),
      acknowledgeDeletionConsumed: jest.fn().mockResolvedValue({ state: 'unknown' }),
      remove: jest.fn(),
    };
    const actor = { settle: jest.fn() };
    const cleanup = createManagedUploadCleanup({
      repository,
      storage,
      actor,
      now: () => 100,
    } as never);
    return { task, repository, storage, actor, cleanup };
  }
  it('persists the original request/binding before fencing storage, while actor ownership stays separate', async () => {
    const t = setup();
    expect(await t.cleanup.reconcileCleanupOperation(claim, new AbortController().signal)).toEqual({
      state: 'pending',
      code: 'owner_pending',
    });
    expect(t.repository.prepareCleanupStorage).toHaveBeenLastCalledWith(
      expect.objectContaining({ generation: 2, attemptGeneration: 1, claim }),
      binding,
    );
    expect(t.storage.observeDeletion).toHaveBeenCalledWith(
      expect.objectContaining({ generation: 1, binding, request, deadlineAtMs: 30100 }),
    );
    expect(t.repository.prepareCleanupStorage.mock.invocationCallOrder[1]).toBeLessThan(
      t.storage.observeDeletion.mock.invocationCallOrder[0],
    );
    expect(t.storage.acknowledgeDeletionConsumed).not.toHaveBeenCalled();
    expect(t.storage.remove).not.toHaveBeenCalled();
    expect(t.actor.settle).not.toHaveBeenCalled();
    expect(t.repository.reconcile).not.toHaveBeenCalled();
    expect(t.repository.cleanupTasks).not.toHaveBeenCalled();
  });
  it('reconciles an unknown lookup with the same persisted identity and never invents a terminal proof', async () => {
    const t = setup();
    t.storage.observeDeletion.mockResolvedValue({ ...binding, state: 'unknown' });
    await t.cleanup.reconcileCleanupOperation(claim, new AbortController().signal);
    expect(t.storage.beginDeletion).toHaveBeenCalledWith(
      t.storage.observeDeletion.mock.calls[0][0],
    );
    expect(t.repository.recordCleanupStorage).toHaveBeenCalledWith(
      expect.objectContaining({ claim }),
      { result: { ...binding, state: 'unknown' } },
    );
    expect(t.storage.acknowledgeDeletionConsumed).not.toHaveBeenCalled();
  });
  it('consumes only the exact owner-persisted receipt/commit after storage observation is recorded', async () => {
    const t = setup();
    t.storage.observeDeletion.mockResolvedValue(receipt);
    t.repository.recordCleanupStorage
      .mockResolvedValueOnce({
        state: 'consume',
        request,
        binding,
        receipt,
        consumerCommitId: 'persisted-commit',
      })
      .mockResolvedValueOnce({ state: 'complete', receiptRef: 'd'.repeat(64) });
    expect(await t.cleanup.reconcileCleanupOperation(claim, new AbortController().signal)).toEqual({
      state: 'settled',
      receiptRef: 'd'.repeat(64),
    });
    expect(t.storage.acknowledgeDeletionConsumed).toHaveBeenCalledWith(
      expect.objectContaining({ binding, receipt, consumerCommitId: 'persisted-commit' }),
    );
    expect(t.repository.recordCleanupStorage.mock.invocationCallOrder[0]).toBeLessThan(
      t.storage.acknowledgeDeletionConsumed.mock.invocationCallOrder[0],
    );
  });
  it.each(['file', 'attempt', 'active', 'tenant', 'owner'])(
    'refuses an invalid %s preparation before storage',
    async (kind) => {
      const t = setup();
      if (kind === 'file') t.task.fileId = 'accepted' as never;
      if (kind === 'attempt') t.task.attemptGeneration = 8;
      if (kind === 'active') t.task.state = 'processing';
      if (kind === 'tenant') t.task.principal = { ...principal, tenantId: 'other' };
      if (kind === 'owner') t.task.principal = { ...t.task.principal, userId: 'other' };
      await expect(
        t.cleanup.reconcileCleanupOperation(claim, new AbortController().signal),
      ).rejects.toThrow('Invalid unaccepted');
      expect(t.repository.prepareCleanupStorage).not.toHaveBeenCalled();
      expect(t.storage.observeDeletion).not.toHaveBeenCalled();
    },
  );
  it('returns a fenced/lost claim without advancing or consuming it', async () => {
    const t = setup();
    t.repository.prepareCleanupStorage.mockReset().mockResolvedValue({ state: 'lost' });
    expect(await t.cleanup.reconcileCleanupOperation(claim, new AbortController().signal)).toEqual({
      state: 'lost',
    });
    expect(t.storage.observeDeletion).not.toHaveBeenCalled();
    expect(t.repository.recordCleanupStorage).not.toHaveBeenCalled();
  });
  it('propagates owner waiting and cancellation without starting effects', async () => {
    const t = setup();
    t.repository.prepareHousekeepingCleanup.mockResolvedValue({
      state: 'outcome',
      outcome: { state: 'unknown' },
    });
    expect(await t.cleanup.reconcileCleanupOperation(claim, new AbortController().signal)).toEqual({
      state: 'unknown',
    });
    expect(await t.cleanup.reconcileCleanupOperation(claim, AbortSignal.abort())).toEqual({
      state: 'pending',
      code: 'owner_pending',
    });
    expect(t.storage.observeDeletion).not.toHaveBeenCalled();
  });
  it('keeps an unexpected transport exception pending with the original persisted intent', async () => {
    const t = setup();
    t.storage.observeDeletion.mockRejectedValue(Error('lost reply'));
    await expect(
      t.cleanup.reconcileCleanupOperation(claim, new AbortController().signal),
    ).rejects.toThrow('lost reply');
    expect(t.repository.prepareCleanupStorage).toHaveBeenCalledTimes(2);
    expect(t.repository.recordCleanupStorage).not.toHaveBeenCalled();
    expect(t.storage.acknowledgeDeletionConsumed).not.toHaveBeenCalled();
  });
});
