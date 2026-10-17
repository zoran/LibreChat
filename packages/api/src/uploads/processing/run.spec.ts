import { documentResultFixture } from './result.helper';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import type { UploadProcessingInput } from 'librechat-data-provider';
import type { S3Client } from '@aws-sdk/client-s3';
import { createManagedS3Storage } from '../storage';
import { processNextManagedUpload } from './run';
import { IsolatedDocumentError } from './client';

jest.mock('~/files', () => ({ deleteRagFile: jest.fn() }));
jest.mock('@librechat/data-schemas', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const lease = {
  tenantId: 'tenant',
  userId: 'user',
  operationId: 'op',
  generation: 2,
  kind: 'processing' as const,
  hostId: 'host',
  instanceId: 'instance',
  expiresAt: '2099-01-01T00:00:00Z',
};
const execution = {
  attemptId: 'op.2',
  instanceId: 'parser-instance',
  expiresAt: '2099-01-01T00:00:00Z',
};
const integrityChunkBytes = 256 * 1024;

// Independent expected identity: these consumer tests must also fail against the
// previous size-only S3 reader, without depending on a missing new helper import.
function integrityFor(original: Buffer) {
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const chunkSha256: string[] = [];
  for (let offset = 0; offset < original.length; offset += integrityChunkBytes) {
    chunkSha256.push(digest(original.subarray(offset, offset + integrityChunkBytes)));
  }
  return {
    version: 1 as const,
    algorithm: 'sha256' as const,
    sha256: digest(original),
    chunkBytes: 262144 as const,
    chunkSha256,
  };
}

// Simulated prior intake, bound to the original bytes and transfer generation 1.
// The current processing lease is generation 2 and cannot replace that identity.
function processingInputFor(original: Buffer): UploadProcessingInput {
  const integrity = integrityFor(original);
  return {
    operationId: lease.operationId,
    attemptGeneration: 1,
    filename: 'note.txt',
    bytes: original.length,
    mediaType: 'text/plain',
    original: {
      outcome: 'durable',
      source: 's3',
      bytes: original.length,
      storageKey: `t/${lease.tenantId}/managed-uploads/${lease.userId}/${lease.operationId}.1__original`,
      filepath: `/api/files/managed/${lease.operationId}`,
      integrity,
    },
    securityApproval: {
      version: 1,
      decision: 'approved',
      policySha256: 'c'.repeat(64),
      subject: {
        tenantId: lease.tenantId,
        userId: lease.userId,
        operationId: lease.operationId,
        transferGeneration: 1,
        mediaType: 'text/plain',
        bytes: original.length,
        sha256: integrity.sha256,
      },
      scannerVersion: 'simulated-admission-fixture-v1',
      checkedAt: new Date(1_000).toISOString(),
      coverage: { complete: true, pages: 1, parts: 1 },
    },
  };
}

describe('one managed processing claim', () => {
  let root: string;
  beforeAll(async () => {
    if (!process.env.UPLOAD_TEST_TMPDIR)
      throw new Error('Explicit isolated upload test directory required');
    await mkdir(process.env.UPLOAD_TEST_TMPDIR, { recursive: true });
    root = await mkdtemp(path.join(process.env.UPLOAD_TEST_TMPDIR, 'processing-'));
  });
  afterEach(async () => {
    for (const entry of await readdir(root))
      await rm(path.join(root, entry), { recursive: true, force: true });
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });
  function fixture(
    extract = jest.fn(async () => ({ ...documentResultFixture(), writerStopped: true as const })),
  ) {
    const management = {
      claimProcessing: jest.fn(async () => lease),
      getProcessingInput: jest.fn(async () => processingInputFor(Buffer.from('hello'))),
      renew: jest.fn(async () => lease),
      bindProcessingExecution: jest.fn(async (): Promise<void> => undefined),
      claimWorkBytes: jest.fn(async (_lease, bytes: number) => ({
        bytes,
        generation: 1,
        expiresAt: '2099-01-01T00:00:00Z',
      })),
      completeWorkBytes: jest.fn(async () => undefined),
      publish: jest.fn(async () => ({ state: 'ready', createdAt: new Date(1_000).toISOString() })),
      fail: jest.fn(async () => ({ state: 'failed' })),
      confirmCleanup: jest.fn(async () => ({})),
    };
    const storage = {
      read: async function* () {
        yield Buffer.from('hello');
      },
      put: jest.fn(),
      remove: jest.fn(),
    };
    return {
      management,
      storage,
      documents: {
        extract,
        prepare: jest.fn(async () => execution),
        cancel: jest.fn(async () => ({ writerStopped: false })),
      },
      worker: lease,
      stagingRoot: root,
      now: () => 10_000,
    };
  }

  function storedOriginal(
    original: Buffer,
    returned = original,
    integrity = integrityFor(original),
  ) {
    const deps = fixture();
    const input = processingInputFor(original);
    const receipt = {
      ...input.original,
      versionId: 'recorded-version',
      etag: 'unchanged-etag',
      integrity,
    };
    deps.management.getProcessingInput.mockResolvedValue({
      ...input,
      original: receipt,
    });
    // Network boundaries deliberately do not coincide with the receipt blocks.
    const body = Readable.from(
      [
        returned.subarray(0, 17),
        returned.subarray(17, integrityChunkBytes + 9),
        returned.subarray(integrityChunkBytes + 9),
      ],
      { highWaterMark: 1 },
    );
    const send = jest.fn(async (_command, _options) => ({
      Body: body,
      ContentLength: returned.length,
      ETag: receipt.etag,
    }));
    const storage = createManagedS3Storage({
      client: { send } as unknown as S3Client,
      bucket: 'isolated',
    });
    return { ...deps, storage, body, send, receipt };
  }

  it('stages an intact version through the actual S3 reader before dispatching the parser', async () => {
    const original = Buffer.concat([
      Buffer.alloc(integrityChunkBytes, 65),
      Buffer.from('useful final text'),
    ]);
    const deps = storedOriginal(original);
    deps.documents.extract.mockImplementationOnce(async () => {
      expect(await readFile(path.join(root, 'op.2', 'original'))).toEqual(original);
      expect(deps.body.readableEnded).toBe(true);
      return { ...documentResultFixture(), writerStopped: true as const };
    });
    await processNextManagedUpload(deps as never, new AbortController().signal);
    expect(deps.send).toHaveBeenCalledTimes(1);
    expect(deps.send.mock.calls[0][0].input).toMatchObject({
      Key: deps.receipt.storageKey,
      VersionId: 'recorded-version',
    });
    expect(deps.management.publish).toHaveBeenCalledWith(lease, {
      ...documentResultFixture(),
      writerStopped: true,
    });
    expect(deps.management.fail).not.toHaveBeenCalled();
    expect(deps.body.destroyed).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    ['first block', 7, 0],
    ['later block', integrityChunkBytes + 7, integrityChunkBytes],
    ['final block', 2 * integrityChunkBytes + 7, 2 * integrityChunkBytes],
  ])(
    'never starts a parser or publishes text after equal-length mutation in the %s',
    async (_label, offset, verifiedBytes) => {
      const original = Buffer.alloc(2 * integrityChunkBytes + 23, 65);
      const returned = Buffer.from(original);
      returned[offset as number] ^= 1;
      const deps = storedOriginal(original, returned);
      const ticket = { bind: jest.fn(), settle: jest.fn() };
      await expect(
        processNextManagedUpload(
          { ...deps, attempts: { begin: () => ticket } } as never,
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ claimed: true, operation: { state: 'failed' } });
      expect(deps.send).toHaveBeenCalledTimes(1);
      expect(
        deps.management.claimWorkBytes.mock.calls.reduce((bytes, [, count]) => bytes + count, 0),
      ).toBe(verifiedBytes);
      expect(deps.documents.prepare).not.toHaveBeenCalled();
      expect(deps.documents.extract).not.toHaveBeenCalled();
      expect(deps.management.bindProcessingExecution).not.toHaveBeenCalled();
      expect(deps.management.publish).not.toHaveBeenCalled();
      expect(deps.management.fail).toHaveBeenCalledWith(lease, 'processing_failed');
      expect(deps.management.confirmCleanup).toHaveBeenCalledWith({
        operationId: 'op',
        generation: 2,
        writerStopped: true,
        localCopiesAbsent: true,
        originalAbsent: false,
        textAndHistoryRemoved: false,
      });
      expect(ticket.settle).toHaveBeenCalledWith({ writerStopped: true, localCopiesAbsent: true });
      expect(deps.body.destroyed).toBe(true);
      expect(deps.send.mock.calls[0][1].abortSignal.aborted).toBe(true);
      expect(await readdir(root)).toEqual([]);
    },
  );

  it('does not dispatch when all block hashes match but the recorded whole digest does not', async () => {
    const original = Buffer.alloc(integrityChunkBytes + 23, 65);
    const integrity = { ...integrityFor(original), sha256: '0'.repeat(64) };
    const deps = storedOriginal(original, original, integrity);
    await processNextManagedUpload(deps as never, new AbortController().signal);
    expect(
      deps.management.claimWorkBytes.mock.calls.reduce((bytes, [, count]) => bytes + count, 0),
    ).toBe(integrityChunkBytes);
    expect(deps.documents.prepare).not.toHaveBeenCalled();
    expect(deps.management.publish).not.toHaveBeenCalled();
    expect(deps.management.fail).toHaveBeenCalledWith(lease, 'processing_failed');
    expect(deps.body.destroyed).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });

  it('publishes useful text only with joined proof and removes its local copy', async () => {
    const deps = fixture();
    const observe = jest.fn();
    await expect(
      processNextManagedUpload({ ...deps, observe } as never, new AbortController().signal),
    ).resolves.toMatchObject({ claimed: true, operation: { state: 'ready' } });
    expect(deps.documents.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ attemptId: 'op.2', mediaType: 'text/plain' }),
    );
    expect(deps.documents.extract).toHaveBeenCalledWith(expect.objectContaining({ execution }));
    expect(deps.management.bindProcessingExecution).toHaveBeenCalledWith(lease, execution);
    expect(deps.management.bindProcessingExecution.mock.invocationCallOrder[0]).toBeLessThan(
      deps.documents.extract.mock.invocationCallOrder[0],
    );
    expect(deps.management.publish).toHaveBeenCalledWith(lease, {
      ...documentResultFixture(),
      writerStopped: true,
    });
    expect(deps.management.confirmCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        localCopiesAbsent: true,
        originalAbsent: false,
        textAndHistoryRemoved: false,
      }),
    );
    expect(observe).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledWith({
      stage: 'processing',
      seconds: expect.any(Number),
      outcome: 'success',
    });
    expect(observe).toHaveBeenCalledWith({ stage: 'total', seconds: 9, outcome: 'success' });
    expect(await readdir(root)).toEqual([]);
  });
  it('retains staging and permit when child stop is unknown after socket loss', async () => {
    const deps = fixture(
      jest.fn().mockRejectedValue(new IsolatedDocumentError('parser_unavailable', false)),
    );
    await processNextManagedUpload(deps as never, new AbortController().signal);
    expect(deps.management.publish).not.toHaveBeenCalled();
    expect(deps.management.confirmCleanup).not.toHaveBeenCalled();
    expect(deps.documents.cancel).toHaveBeenCalledWith(expect.objectContaining({ execution }));
    expect(await readdir(root)).toEqual(['op.2']);
  });
  it('recovers a lost extract reply only after exact-attempt cancellation joins the child', async () => {
    const deps = fixture(
      jest.fn().mockRejectedValue(new IsolatedDocumentError('parser_unavailable', false)),
    );
    deps.documents.cancel.mockResolvedValueOnce({ writerStopped: true });
    await processNextManagedUpload(deps as never, new AbortController().signal);
    expect(deps.management.confirmCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ writerStopped: true, localCopiesAbsent: true }),
    );
    expect(deps.management.fail.mock.invocationCallOrder[0]).toBeLessThan(
      deps.documents.cancel.mock.invocationCallOrder[0],
    );
    expect(await readdir(root)).toEqual([]);
  });
  it('never dispatches a prepared child when durable binding fails', async () => {
    const deps = fixture();
    deps.management.bindProcessingExecution.mockRejectedValueOnce(
      new Error('unknown bind result') as never,
    );
    deps.documents.cancel.mockResolvedValueOnce({ writerStopped: true });
    await processNextManagedUpload(deps as never, new AbortController().signal);
    expect(deps.documents.extract).not.toHaveBeenCalled();
    expect(deps.documents.cancel).toHaveBeenCalled();
  });
  it('does not dispatch while a durable bind is pending', async () => {
    const deps = fixture();
    let resolveBind!: () => void;
    let enteredBind!: () => void;
    const entering = new Promise<void>((resolve) => {
      enteredBind = resolve;
    });
    deps.management.bindProcessingExecution.mockImplementationOnce(() => {
      enteredBind();
      return new Promise<void>((resolve) => {
        resolveBind = resolve;
      });
    });
    const run = processNextManagedUpload(deps as never, new AbortController().signal);
    await entering;
    expect(deps.documents.extract).not.toHaveBeenCalled();
    resolveBind();
    await run;
    expect(deps.documents.extract).toHaveBeenCalledTimes(1);
  });
  it('confirms only joined/local cleanup after a parser resource failure', async () => {
    const deps = fixture(
      jest.fn().mockRejectedValue(new IsolatedDocumentError('resource_limit', true)),
    );
    const observe = jest.fn(async () => {
      throw new Error('observer unavailable');
    });
    await processNextManagedUpload({ ...deps, observe } as never, new AbortController().signal);
    expect(deps.management.confirmCleanup).toHaveBeenCalledWith({
      operationId: 'op',
      generation: 2,
      writerStopped: true,
      localCopiesAbsent: true,
      originalAbsent: false,
      textAndHistoryRemoved: false,
    });
    expect(deps.storage.remove).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith({
      stage: 'processing',
      seconds: expect.any(Number),
      outcome: 'failure',
    });
  });
  it.each(['acknowledged', 'unknown'])(
    'never claims derived cleanup after a lost publication and %s failure result',
    async (failureResult) => {
      const deps = fixture();
      deps.management.publish.mockRejectedValueOnce(new Error('unknown commit') as never);
      if (failureResult === 'unknown') {
        deps.management.fail.mockRejectedValueOnce(new Error('unknown failure persistence'));
      }
      const observe = jest.fn();
      const result = await processNextManagedUpload(
        { ...deps, observe } as never,
        new AbortController().signal,
      );
      expect(result).toEqual({
        claimed: true,
        operation: failureResult === 'unknown' ? undefined : { state: 'failed' },
      });
      expect(deps.management.confirmCleanup).toHaveBeenCalledWith(
        expect.objectContaining({ textAndHistoryRemoved: false, originalAbsent: false }),
      );
      expect(observe).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'total' }));
    },
  );
  it('registers a pending claim before await and joins a claim delivered after cancellation', async () => {
    const deps = fixture();
    let deliver!: (value: typeof lease) => void;
    deps.management.claimProcessing.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    );
    const ticket = { bind: jest.fn(), settle: jest.fn() };
    const attempts = {
      begin: jest.fn(() => ticket),
      stopAndJoin: jest.fn(),
      recordCleanup: jest.fn(),
    };
    const abort = new AbortController();
    const run = processNextManagedUpload({ ...deps, attempts } as never, abort.signal);
    expect(attempts.begin).toHaveBeenCalledTimes(1);
    expect(ticket.bind).not.toHaveBeenCalled();
    abort.abort();
    deliver(lease);
    await run;
    expect(ticket.bind).toHaveBeenCalledWith(lease);
    expect(deps.documents.prepare).not.toHaveBeenCalled();
    expect(ticket.settle).toHaveBeenCalledWith({ writerStopped: true, localCopiesAbsent: true });
    expect(await readdir(root)).toEqual([]);
  });

  it('records an unresolved child as unknown in the local maintenance owner', async () => {
    const deps = fixture(
      jest.fn().mockRejectedValue(new IsolatedDocumentError('parser_unavailable', false)),
    );
    const ticket = { bind: jest.fn(), settle: jest.fn() };
    await processNextManagedUpload(
      { ...deps, attempts: { begin: () => ticket } } as never,
      new AbortController().signal,
    );
    expect(ticket.settle).toHaveBeenCalledWith({ writerStopped: false, localCopiesAbsent: false });
  });

  it('paces S3 read slices through shared grants and aborts before consuming an ungranted remainder', async () => {
    const deps = fixture();
    const bytes = 64 * 1024 + 1;
    deps.management.getProcessingInput.mockResolvedValue(
      processingInputFor(Buffer.alloc(bytes, 65)),
    );
    deps.storage.read = async function* () {
      yield Buffer.alloc(bytes, 65);
    };
    let entered!: () => void;
    const secondGrant = new Promise<void>((resolve) => {
      entered = resolve;
    });
    deps.management.claimWorkBytes
      .mockImplementationOnce(async (_lease, requested) => {
        expect(requested).toBe(64 * 1024);
        return { bytes: requested, generation: 1, expiresAt: '2099-01-01T00:00:00Z' };
      })
      .mockImplementationOnce(async () => {
        entered();
        return null as never;
      });
    const abort = new AbortController();
    const observe = jest.fn();
    const run = processNextManagedUpload({ ...deps, observe } as never, abort.signal);
    await secondGrant;
    expect(deps.management.completeWorkBytes).toHaveBeenCalledTimes(1);
    expect(deps.management.completeWorkBytes).toHaveBeenCalledWith(lease, 1);
    expect(deps.management.claimWorkBytes).toHaveBeenLastCalledWith(lease, 1);
    abort.abort();
    await run;
    expect(deps.documents.prepare).not.toHaveBeenCalled();
    expect(deps.management.publish).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith({
      stage: 'processing',
      seconds: expect.any(Number),
      outcome: 'cancelled',
    });
    expect(await readdir(root)).toEqual([]);
  });

  it('emits no processing duration for an empty admission poll', async () => {
    const deps = fixture();
    deps.management.claimProcessing.mockResolvedValueOnce(null as never);
    const observe = jest.fn();
    await expect(
      processNextManagedUpload({ ...deps, observe } as never, new AbortController().signal),
    ).resolves.toEqual({ claimed: false });
    expect(observe).not.toHaveBeenCalled();
    expect(deps.documents.prepare).not.toHaveBeenCalled();
  });

  it('ends total duration at acknowledged ready publication before local cleanup', async () => {
    const deps = fixture();
    let time = 10_000;
    deps.management.confirmCleanup.mockImplementationOnce(async () => {
      time = 90_000;
      return {};
    });
    const observe = jest.fn();
    await processNextManagedUpload(
      { ...deps, now: () => time, observe } as never,
      new AbortController().signal,
    );
    expect(observe).toHaveBeenCalledWith({ stage: 'total', outcome: 'success', seconds: 9 });
    expect(time).toBe(90_000);
  });

  it.each([undefined, 'invalid', new Date(20_000).toISOString()])(
    'omits total for untrustworthy creation time %s',
    async (createdAt) => {
      const deps = fixture();
      deps.management.publish.mockResolvedValueOnce({ state: 'ready', createdAt } as never);
      const observe = jest.fn();
      await processNextManagedUpload({ ...deps, observe } as never, new AbortController().signal);
      expect(observe).toHaveBeenCalledTimes(1);
      expect(observe).toHaveBeenCalledWith({
        stage: 'processing',
        outcome: 'success',
        seconds: expect.any(Number),
      });
    },
  );

  it.each(['sync', 'async'])(
    'preserves successful publication and cleanup after %s observation failure',
    async (mode) => {
      const deps = fixture();
      const observe = jest.fn(() => {
        if (mode === 'sync') throw new Error('metrics unavailable');
        return Promise.reject(new Error('metrics unavailable'));
      });
      await expect(
        processNextManagedUpload({ ...deps, observe } as never, new AbortController().signal),
      ).resolves.toMatchObject({ operation: { state: 'ready' } });
      expect(deps.management.fail).not.toHaveBeenCalled();
      expect(deps.management.confirmCleanup).toHaveBeenCalledTimes(1);
      expect(await readdir(root)).toEqual([]);
    },
  );
});
