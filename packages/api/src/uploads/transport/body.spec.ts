import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type {
  UploadLease,
  UploadPrincipal,
  UploadSecurityApproval,
  UploadSecurityDecision,
  UploadSecuritySubject,
} from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type { RawUploadBodyDependencies, RawUploadObservation } from './body';
import type { UploadAttemptPort, UploadSecurityPort } from '../contract';
import { createRawUploadBodyHandler, validateRawUploadHeaders } from './body';
import { UploadManagementError } from '../errors';

const principal = { tenantId: 'tenant', userId: 'user', authentication: 'verified-email' as const };
const lease = {
  ...principal,
  operationId: 'operation',
  generation: 1,
  kind: 'transfer' as const,
  hostId: 'host',
  instanceId: 'instance',
  expiresAt: '2099-01-01T00:00:00Z',
};
const policySha256 = 'a'.repeat(64);
const now = Date.parse('2026-10-17T02:00:00.000Z');

function approval(subject: UploadSecuritySubject): UploadSecurityApproval {
  return {
    version: 1,
    decision: 'approved',
    policySha256,
    subject: { ...subject },
    scannerVersion: 'bounded-test-scanner/1',
    checkedAt: '2026-10-17T02:00:00.000Z',
    coverage: { complete: true, pages: 1, parts: 1 },
  };
}

function inspection<T extends UploadSecurityDecision>(decision: T) {
  return {
    decision,
    cleanup: { writerStopped: true as const, transientDataRemoved: true as const },
  };
}

function expectedIntegrity(bytes: Buffer) {
  const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  const chunkSha256: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 262144)
    chunkSha256.push(sha256(bytes.subarray(offset, offset + 262144)));
  return {
    version: 1,
    algorithm: 'sha256',
    sha256: sha256(bytes),
    chunkBytes: 262144,
    chunkSha256,
  };
}

describe('raw upload body admission and streaming', () => {
  let root: string;
  let ordinaryRoot: string;
  let target = 0;
  beforeAll(async () => {
    if (!process.env.UPLOAD_TEST_TMPDIR)
      throw new Error('Explicit isolated upload test directory required');
    await mkdir(process.env.UPLOAD_TEST_TMPDIR, { recursive: true });
    root = await mkdtemp(path.join(process.env.UPLOAD_TEST_TMPDIR, 'transport-'));
    ordinaryRoot = await mkdtemp(path.join(process.env.UPLOAD_TEST_TMPDIR, 'ordinary-storage-'));
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    if (ordinaryRoot) await rm(ordinaryRoot, { recursive: true, force: true });
  });

  const headers = { 'content-type': 'application/octet-stream', 'content-length': '5' };
  test.each([
    { 'content-type': 'application/json' },
    { 'content-encoding': 'gzip' },
    { 'content-range': 'bytes 0-4/5' },
    { range: 'bytes=0-4' },
    { 'content-length': '4' },
  ])('rejects an incompatible raw profile before stream reads: %j', (extra) => {
    expect(() => validateRawUploadHeaders({ ...headers, ...extra }, 5)).toThrow();
  });
  it('validates the exact production boundary without allocating that body', () => {
    expect(() =>
      validateRawUploadHeaders({ 'content-type': 'application/octet-stream' }, 31_457_280),
    ).not.toThrow();
    expect(() =>
      validateRawUploadHeaders({ 'content-type': 'application/octet-stream' }, 31_457_281),
    ).toThrow();
  });

  function fixture(
    data: string | Buffer = 'hello',
    options: {
      authorized?: boolean;
      outcome?: 'durable' | 'unknown';
      declared?: number;
      deadlineMs?: number;
      idleMs?: number;
      attempts?: UploadAttemptPort;
      observe?: (event: RawUploadObservation) => void | Promise<void>;
      principal?: RawUploadBodyDependencies['principal'];
      missingSecurity?: boolean;
    } = {},
  ) {
    const inputBytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const ordinaryPath = path.join(ordinaryRoot, String(++target));
    const stream = new PassThrough();
    const req = Object.assign(stream, {
      headers: { ...headers, 'content-length': String(options.declared ?? 5) },
      params: { id: 'operation' },
      body: undefined,
    });
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      destroyed: false,
      headersSent: false,
      statusCode: 0,
      value: undefined as unknown,
      setHeader: jest.fn(),
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(value: unknown) {
        this.value = value;
        this.headersSent = true;
        this.writableEnded = true;
        return this;
      },
    });
    const management = {
      get: jest.fn(async () => {
        if (options.authorized === false) throw new Error('private authorization detail');
        return {
          filename: 'display.txt',
          mediaType: 'text/plain',
          declaredBytes: options.declared ?? 5,
        };
      }),
      claimTransfer: jest.fn(async (): Promise<UploadLease> => lease),
      renew: jest.fn(async (): Promise<UploadLease> => lease),
      accept: jest.fn(async () => ({ id: 'operation', state: 'queued_processing' })),
      fail: jest.fn(async () => ({})),
      cancel: jest.fn(async () => ({})),
      confirmCleanup: jest.fn(async () => ({})),
    };
    const storage = {
      put: jest.fn(
        async ({ body, integrity }: { body: AsyncIterable<Uint8Array>; integrity?: unknown }) => {
          const chunks: Buffer[] = [];
          for await (const chunk of body) chunks.push(Buffer.from(chunk));
          const stored = Buffer.concat(chunks);
          expect(stored).toEqual(inputBytes);
          // A real ordinary-storage side effect makes forbidden publication observable.
          await writeFile(ordinaryPath, stored, { flag: 'wx' });
          return {
            outcome: options.outcome ?? 'durable',
            bytes: inputBytes.byteLength,
            source: 's3',
            filepath: 'private',
            storageKey: 'private',
            integrity,
          };
        },
      ),
      read: jest.fn(),
      remove: jest.fn(),
    };
    const completeBytes = jest.fn(async () => undefined);
    const claimBytes = jest.fn(async (_lease, bytes: number) => ({
      bytes,
      generation: 1,
      expiresAt: '2099-01-01T00:00:00Z',
    }));
    const security = {
      policySha256,
      inspect: jest.fn(
        async ({ subject, body, signal }: Parameters<UploadSecurityPort['inspect']>[0]) => {
          const hash = createHash('sha256');
          let bytes = 0;
          for await (const chunk of body) {
            signal.throwIfAborted();
            hash.update(chunk);
            bytes += chunk.byteLength;
          }
          return inspection(approval({ ...subject, bytes, sha256: hash.digest('hex') }));
        },
      ),
    };
    const handler = createRawUploadBodyHandler({
      management: management as never,
      principal: options.principal ?? (async () => principal),
      storage: storage as never,
      security: options.missingSecurity ? (undefined as never) : security,
      worker: lease,
      stagingRoot: root,
      claimBytes,
      completeBytes,
      deadlineMs: options.deadlineMs,
      idleMs: options.idleMs,
      attempts: options.attempts,
      observe: options.observe,
      now: () => now,
    });
    return {
      req,
      response,
      management,
      storage,
      security,
      ordinaryPath,
      completeBytes,
      claimBytes,
      run: () => handler(req as unknown as Request, response as unknown as Response, jest.fn()),
    };
  }
  async function expectNoOrdinaryStorage(test: ReturnType<typeof fixture>) {
    expect(test.storage.put).not.toHaveBeenCalled();
    expect(test.management.accept).not.toHaveBeenCalled();
    await expect(readFile(test.ordinaryPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(root)).toEqual([]);
  }
  it('blocks security rejection before ordinary storage and confirms only owned local cleanup', async () => {
    const test = fixture();
    test.security.inspect.mockResolvedValueOnce(
      inspection({
        version: 1,
        decision: 'rejected',
        reason: 'classification_marking',
      }) as never,
    );
    const done = test.run();
    test.req.end('hello');
    await done;
    await expectNoOrdinaryStorage(test);
    expect(test.response.statusCode).toBe(422);
    expect(test.response.value).toEqual({ code: 'security_rejected' });
    expect(test.management.fail).toHaveBeenCalledWith(lease, 'security_rejected');
    expect(test.management.confirmCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        writerStopped: true,
        localCopiesAbsent: true,
        originalAbsent: true,
      }),
    );
  });
  it.each<[string, (value: UploadSecurityApproval) => unknown, boolean]>([
    ['missing result', () => undefined, false],
    ['unclassified rejection', () => ({ version: 1, decision: 'rejected' }), false],
    [
      'active content rejection',
      () => ({ version: 1, decision: 'rejected', reason: 'active_content' }),
      false,
    ],
    [
      'unsupported rejection',
      () => ({ version: 1, decision: 'rejected', reason: 'unsupported_format' }),
      false,
    ],
    [
      'unknown rejection reason',
      () => ({ version: 1, decision: 'rejected', reason: 'unexpected' }),
      false,
    ],
    [
      'unversioned rejection',
      () => ({ decision: 'rejected', reason: 'classification_marking' }),
      false,
    ],
    [
      'future rejection version',
      () => ({ version: 2, decision: 'rejected', reason: 'classification_marking' }),
      false,
    ],
    [
      'rejection with extra content',
      () => ({
        version: 1,
        decision: 'rejected',
        reason: 'classification_marking',
        content: 'private',
      }),
      false,
    ],
    ['null result', () => null, false],
    ['unsupported result', () => ({ version: 2, decision: 'approved' }), false],
    [
      'uninspectable result',
      () => ({ version: 1, decision: 'uninspectable', reason: 'encrypted' }),
      true,
    ],
    [
      'incomplete coverage',
      (value) => ({ ...value, coverage: { ...value.coverage, complete: false } }),
      false,
    ],
    [
      'zero covered pages',
      (value) => ({ ...value, coverage: { ...value.coverage, pages: 0 } }),
      false,
    ],
    [
      'zero covered parts',
      (value) => ({ ...value, coverage: { ...value.coverage, parts: 0 } }),
      false,
    ],
    ['obsolete policy', (value) => ({ ...value, policySha256: 'b'.repeat(64) }), true],
    ['future check', (value) => ({ ...value, checkedAt: '2026-10-17T02:00:00.001Z' }), true],
    [
      'wrong tenant',
      (value) => ({ ...value, subject: { ...value.subject, tenantId: null } }),
      true,
    ],
    [
      'wrong owner',
      (value) => ({ ...value, subject: { ...value.subject, userId: 'other' } }),
      true,
    ],
    [
      'wrong operation',
      (value) => ({ ...value, subject: { ...value.subject, operationId: 'other' } }),
      true,
    ],
    [
      'wrong transfer generation',
      (value) => ({ ...value, subject: { ...value.subject, transferGeneration: 2 } }),
      true,
    ],
    [
      'wrong media type',
      (value) => ({ ...value, subject: { ...value.subject, mediaType: 'application/pdf' } }),
      true,
    ],
    ['wrong size', (value) => ({ ...value, subject: { ...value.subject, bytes: 4 } }), true],
    [
      'wrong hash',
      (value) => ({ ...value, subject: { ...value.subject, sha256: '0'.repeat(64) } }),
      true,
    ],
    ['unexpected content', (value) => ({ ...value, content: 'private scanner detail' }), false],
  ])(
    'denies %s without storage and attests only explicit valid cleanup',
    async (_name, change, cleaned) => {
      const ticket = { bind: jest.fn(), settle: jest.fn() };
      const test = fixture('hello', { attempts: { begin: () => ticket } as never });
      const inspect = test.security.inspect.getMockImplementation()!;
      test.security.inspect.mockImplementationOnce(async (input) =>
        inspection(change((await inspect(input)).decision) as never),
      );
      const done = test.run();
      test.req.end('hello');
      await done;
      await expectNoOrdinaryStorage(test);
      expect(test.response.statusCode).toBe(422);
      expect(test.response.value).toEqual({ code: 'security_uninspectable' });
      if (cleaned) {
        expect(test.management.confirmCleanup).toHaveBeenCalledWith(
          expect.objectContaining({ writerStopped: true, originalAbsent: true }),
        );
      } else {
        expect(test.management.confirmCleanup).not.toHaveBeenCalled();
      }
      expect(ticket.settle).toHaveBeenCalledWith({
        writerStopped: cleaned,
        localCopiesAbsent: true,
        storageOutcome: 'not_started',
      });
    },
  );
  it.each<[string, (value: ReturnType<typeof inspection<UploadSecurityApproval>>) => unknown]>([
    ['missing reply', () => undefined],
    ['null reply', () => null],
    ['legacy bare approval', (value) => value.decision],
    [
      'legacy bare rejection',
      () => ({ version: 1, decision: 'rejected', reason: 'classification_marking' }),
    ],
    ['missing cleanup', (value) => ({ decision: value.decision })],
    ['null cleanup', (value) => ({ ...value, cleanup: null })],
    [
      'writer not confirmed',
      (value) => ({ ...value, cleanup: { writerStopped: false, transientDataRemoved: true } }),
    ],
    [
      'copies not confirmed',
      (value) => ({ ...value, cleanup: { writerStopped: true, transientDataRemoved: false } }),
    ],
    ['missing copy acknowledgement', (value) => ({ ...value, cleanup: { writerStopped: true } })],
    [
      'truthy acknowledgement',
      (value) => ({ ...value, cleanup: { writerStopped: 'true', transientDataRemoved: true } }),
    ],
    [
      'extra cleanup detail',
      (value) => ({ ...value, cleanup: { ...value.cleanup, detail: 'private' } }),
    ],
    ['extra envelope version', (value) => ({ ...value, version: 1 })],
  ])('does not infer stopped remote work from a resolved %s', async (_name, change) => {
    const ticket = { bind: jest.fn(), settle: jest.fn() };
    const test = fixture('hello', { attempts: { begin: () => ticket } as never });
    const inspect = test.security.inspect.getMockImplementation()!;
    test.security.inspect.mockImplementationOnce(
      async (input) => change(await inspect(input)) as never,
    );
    const done = test.run();
    test.req.end('hello');
    await done;
    await expectNoOrdinaryStorage(test);
    expect(test.response.statusCode).toBe(422);
    expect(test.response.value).toEqual({ code: 'security_uninspectable' });
    expect(test.management.confirmCleanup).not.toHaveBeenCalled();
    expect(ticket.settle).toHaveBeenCalledWith({
      writerStopped: false,
      localCopiesAbsent: true,
      storageOutcome: 'not_started',
    });
  });
  it('does not invoke cleanup or decision getters to derive a trusted result', async () => {
    const get = jest.fn(() => {
      throw new Error('private scanner getter');
    });
    for (const field of ['decision', 'cleanup']) {
      const ticket = { bind: jest.fn(), settle: jest.fn() };
      const test = fixture('hello', { attempts: { begin: () => ticket } as never });
      const inspect = test.security.inspect.getMockImplementation()!;
      test.security.inspect.mockImplementationOnce(async (input) =>
        Object.defineProperty(await inspect(input), field, { enumerable: true, get }),
      );
      const done = test.run();
      test.req.end('hello');
      await done;
      await expectNoOrdinaryStorage(test);
      expect(test.response.value).toEqual({ code: 'security_uninspectable' });
      expect(test.management.confirmCleanup).not.toHaveBeenCalled();
      expect(ticket.settle).toHaveBeenCalledWith({
        writerStopped: false,
        localCopiesAbsent: true,
        storageOutcome: 'not_started',
      });
    }
    expect(get).not.toHaveBeenCalled();
  });
  it('has no implicit approval when a scanner is not configured', async () => {
    const test = fixture('hello', { missingSecurity: true });
    const done = test.run();
    test.req.end('hello');
    await done;
    await expectNoOrdinaryStorage(test);
    expect(test.response.value).toEqual({ code: 'security_uninspectable' });
  });
  it.each([0, 1])(
    'denies an approval after only %i scan chunks instead of verified EOF',
    async (readChunks) => {
      const bytes = Buffer.alloc(70_000, 'a');
      const test = fixture(bytes, { declared: bytes.byteLength });
      test.security.inspect.mockImplementationOnce(async ({ body, subject }) => {
        if (readChunks) for await (const _chunk of body) break;
        return inspection(approval(subject));
      });
      const done = test.run();
      test.req.end(bytes);
      await done;
      await expectNoOrdinaryStorage(test);
      expect(test.response.value).toEqual({ code: 'security_uninspectable' });
    },
  );
  it.each([
    'synchronous throw',
    'rejected promise',
    'connection lost',
    'forged classified exception',
  ])('keeps scanner cleanup unknown after %s even when its promise settles', async (failure) => {
    const ticket = { bind: jest.fn(), settle: jest.fn() };
    const test = fixture('hello', { attempts: { begin: () => ticket } as never });
    const error =
      failure === 'forged classified exception'
        ? new UploadManagementError('security_rejected')
        : new Error('private document content and scanner path');
    if (failure === 'synchronous throw') {
      test.security.inspect.mockImplementationOnce(() => {
        throw error;
      });
    } else {
      if (failure === 'connection lost') Object.assign(error, { code: 'ECONNRESET' });
      test.security.inspect.mockRejectedValueOnce(error);
    }
    const done = test.run();
    test.req.end('hello');
    await done;
    await expectNoOrdinaryStorage(test);
    expect(test.response.statusCode).toBe(422);
    expect(test.response.value).toEqual({ code: 'security_uninspectable' });
    expect(test.management.fail).toHaveBeenCalledWith(lease, 'security_uninspectable');
    expect(test.management.confirmCleanup).not.toHaveBeenCalled();
    expect(ticket.settle).toHaveBeenCalledWith({
      writerStopped: false,
      localCopiesAbsent: true,
      storageOutcome: 'not_started',
    });
  });
  it('does not reuse an approval when the active policy changes during inspection', async () => {
    const test = fixture();
    const inspect = test.security.inspect.getMockImplementation()!;
    test.security.inspect.mockImplementationOnce(async (input) => {
      const result = await inspect(input);
      test.security.policySha256 = 'b'.repeat(64);
      return result;
    });
    const done = test.run();
    test.req.end('hello');
    await done;
    await expectNoOrdinaryStorage(test);
    expect(test.response.value).toEqual({ code: 'security_uninspectable' });
  });
  it('rechecks policy after asynchronous principal verification before storage', async () => {
    let inspected = false;
    const test = fixture('hello', {
      principal: async () => {
        if (inspected) test.security.policySha256 = 'b'.repeat(64);
        return principal;
      },
    });
    const inspect = test.security.inspect.getMockImplementation()!;
    test.security.inspect.mockImplementationOnce(async (input) => {
      const result = await inspect(input);
      inspected = true;
      return result;
    });
    const done = test.run();
    test.req.end('hello');
    await done;
    await expectNoOrdinaryStorage(test);
    expect(test.response.value).toEqual({ code: 'security_uninspectable' });
  });
  it('retains its checked approval when an adapter mutates the returned object during storage', async () => {
    const test = fixture();
    let returned!: UploadSecurityApproval;
    const inspect = test.security.inspect.getMockImplementation()!;
    test.security.inspect.mockImplementationOnce(async (input) => {
      const result = await inspect(input);
      returned = result.decision;
      return result;
    });
    const put = test.storage.put.getMockImplementation()!;
    test.storage.put.mockImplementationOnce(async (input) => {
      returned.subject.sha256 = '0'.repeat(64);
      returned.coverage.pages = 0;
      return put(input);
    });
    const done = test.run();
    test.req.end('hello');
    await done;
    expect(test.response.statusCode).toBe(202);
    expect(test.management.accept).toHaveBeenCalledWith(
      principal,
      'operation',
      lease,
      expect.objectContaining({ outcome: 'durable' }),
      approval(test.security.inspect.mock.calls[0][0].subject),
    );
    expect(await readFile(test.ordinaryPath, 'utf8')).toBe('hello');
  });
  it('revalidates the principal after inspection and before ordinary storage', async () => {
    let revoked = false;
    const test = fixture('hello', {
      principal: async () => {
        if (revoked) throw new UploadManagementError('unauthorized');
        return principal;
      },
    });
    const inspect = test.security.inspect.getMockImplementation()!;
    test.security.inspect.mockImplementationOnce(async (input) => {
      const result = await inspect(input);
      revoked = true;
      return result;
    });
    const done = test.run();
    test.req.end('hello');
    await done;
    await expectNoOrdinaryStorage(test);
    expect(test.management.fail).toHaveBeenCalledWith(lease, 'unauthorized');
    expect(test.response.statusCode).toBe(401);
  });
  it('renews the existing transfer lease while a bounded scanner is working', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      let entered!: () => void;
      let finish!: () => void;
      const scanning = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const release = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const test = fixture();
      const inspect = test.security.inspect.getMockImplementation()!;
      test.security.inspect.mockImplementationOnce(async (input) => {
        const result = await inspect(input);
        entered();
        await release;
        return result;
      });
      const done = test.run();
      test.req.end('hello');
      await scanning;
      await jest.advanceTimersByTimeAsync(5_000);
      expect(test.management.renew).toHaveBeenCalledWith(lease);
      expect(test.storage.put).not.toHaveBeenCalled();
      finish();
      await done;
      expect(test.response.statusCode).toBe(202);
      expect(await readFile(test.ordinaryPath, 'utf8')).toBe('hello');
    } finally {
      jest.useRealTimers();
    }
  });
  it('bounds an unresponsive scanner without certifying its unresolved execution as stopped', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      let entered!: () => void;
      let finish!: () => void;
      const scanning = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const release = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const ticket = { bind: jest.fn(), settle: jest.fn() };
      const test = fixture('hello', {
        deadlineMs: 50,
        attempts: { begin: () => ticket } as never,
      });
      const inspect = test.security.inspect.getMockImplementation()!;
      test.security.inspect.mockImplementationOnce(async (input) => {
        const result = await inspect(input);
        entered();
        await release; // Deliberately ignores abort; the transport may not join this remote work.
        return result;
      });
      const done = test.run();
      test.req.end('hello');
      await scanning;
      await jest.advanceTimersByTimeAsync(50);
      await done;
      await expectNoOrdinaryStorage(test);
      expect(test.response.statusCode).toBe(422);
      expect(test.response.value).toEqual({ code: 'security_uninspectable' });
      expect(test.management.confirmCleanup).not.toHaveBeenCalled();
      expect(ticket.settle).toHaveBeenCalledWith({
        writerStopped: false,
        localCopiesAbsent: true,
        storageOutcome: 'not_started',
      });
      finish();
      await release;
      expect(test.management.accept).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
  it('keeps remote cleanup unknown when a cooperative abort merely rejects the scanner promise', async () => {
    let entered!: () => void;
    let stop!: () => void;
    const scanning = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const ticket = { bind: jest.fn(), settle: jest.fn() };
    const test = fixture('hello', {
      attempts: {
        begin: (abort: () => void) => {
          stop = abort;
          return ticket;
        },
      } as never,
    });
    test.security.inspect.mockImplementationOnce(async ({ signal }) => {
      entered();
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const done = test.run();
    test.req.end('hello');
    await scanning;
    stop();
    await done;
    await expectNoOrdinaryStorage(test);
    expect(test.management.confirmCleanup).not.toHaveBeenCalled();
    expect(ticket.settle).toHaveBeenCalledWith({
      writerStopped: false,
      localCopiesAbsent: true,
      storageOutcome: 'not_started',
    });
  });
  it('accepts only counted, staged and durable bytes and awaits both traffic grant completions', async () => {
    const observe = jest.fn();
    const test = fixture('hello', { observe });
    const done = test.run();
    test.req.end('hello');
    await done;
    expect(test.management.accept).toHaveBeenCalledTimes(1);
    expect(test.response.statusCode).toBe(202);
    expect(await readFile(test.ordinaryPath, 'utf8')).toBe('hello');
    expect(test.security.inspect).toHaveBeenCalledTimes(1);
    const inspected = test.security.inspect.mock.calls[0][0];
    expect(Object.keys(inspected).sort()).toEqual(['body', 'signal', 'subject']);
    expect(inspected.subject).toEqual({
      tenantId: 'tenant',
      userId: 'user',
      operationId: 'operation',
      transferGeneration: 1,
      mediaType: 'text/plain',
      bytes: 5,
      sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    });
    expect(test.management.accept).toHaveBeenCalledWith(
      principal,
      'operation',
      lease,
      expect.objectContaining({ outcome: 'durable' }),
      approval(inspected.subject),
    );
    expect(test.completeBytes).toHaveBeenCalledTimes(2);
    expect(test.management.confirmCleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        writerStopped: true,
        localCopiesAbsent: true,
        originalAbsent: false,
      }),
    );
    const events: RawUploadObservation[] = observe.mock.calls.map(([event]) => event);
    expect(events.filter((event) => event.kind === 'received')).toEqual([
      { kind: 'received', bytes: 5 },
    ]);
    expect(events).toContainEqual({ kind: 'accepted', bytes: 5 });
    expect(events.filter((event) => event.kind === 'stage')).toEqual(
      ['wait', 'transfer', 'storage', 'request'].map((stage) => ({
        kind: 'stage',
        stage,
        seconds: expect.any(Number),
        outcome: 'success',
      })),
    );
    expect(events.every((event) => event.kind !== 'stage' || event.seconds >= 0)).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });
  it('passes trusted receive integrity across request and traffic-grant chunk boundaries', async () => {
    const bytes = Buffer.concat([
      Buffer.alloc(262144, 0x00),
      Buffer.alloc(262144, 0xff),
      Buffer.from('last\x00block\xc3\xa4', 'latin1'),
    ]);
    const integrity = expectedIntegrity(bytes);
    for (const cuts of [[], [7, 65539, 262145, bytes.byteLength - 2]]) {
      const test = fixture(bytes, { declared: bytes.byteLength });
      Object.assign(test.req.headers, {
        digest: `sha-256=${'A'.repeat(44)}`,
        'x-original-sha256': '0'.repeat(64),
      });
      test.claimBytes.mockImplementation(async (_lease, requested) => ({
        bytes: Math.min(4093, requested),
        generation: 1,
        expiresAt: '2099-01-01T00:00:00Z',
      }));
      const done = test.run();
      let offset = 0;
      for (const cut of cuts) {
        test.req.write(bytes.subarray(offset, cut));
        offset = cut;
      }
      test.req.end(bytes.subarray(offset));
      await done;
      expect(test.response.statusCode).toBe(202);
      expect(test.storage.put).toHaveBeenCalledWith(
        expect.objectContaining({ bytes: bytes.byteLength, integrity }),
      );
      expect(test.management.accept).toHaveBeenCalledWith(
        principal,
        'operation',
        lease,
        expect.objectContaining({ bytes: bytes.byteLength, integrity }),
        expect.objectContaining({
          decision: 'approved',
          subject: expect.objectContaining({ sha256: integrity.sha256 }),
        }),
      );
      expect(await readdir(root)).toEqual([]);
    }
  });
  it.each(['HELLO', 'hell', 'hello!'])(
    'blocks staging substitution %s even with a matching claimed approval',
    async (replacement) => {
      const received = Buffer.from('hello');
      const altered = Buffer.from(replacement);
      let replaced = false;
      const test = fixture(received, {
        observe: (event) => {
          if (event.kind === 'stage' && event.stage === 'transfer' && event.outcome === 'success') {
            writeFileSync(path.join(root, 'operation.1', 'original'), altered);
            replaced = true;
          }
        },
      });
      test.security.inspect.mockImplementationOnce(async ({ body, subject }) => {
        // A scanner's claimed subject cannot replace the transport's own read-integrity check.
        for await (const _chunk of body) {
          /* consume */
        }
        return inspection(approval(subject));
      });
      const done = test.run();
      test.req.end(received);
      await done;
      expect(replaced).toBe(true);
      await expectNoOrdinaryStorage(test);
      expect(test.management.fail).toHaveBeenCalledWith(lease, 'security_uninspectable');
      expect(test.response.statusCode).toBe(422);
    },
  );
  it('does not read or stage an unauthorized body', async () => {
    const test = fixture('hello', { authorized: false });
    test.req.write('hello');
    await test.run();
    expect(test.req.readableLength).toBe(5);
    expect(test.storage.put).not.toHaveBeenCalled();
    expect(test.security.inspect).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
    test.req.destroy();
  });
  it('rejects a grant revoked while a transfer claim was pending without staging a body', async () => {
    let revoked = false;
    const test = fixture('hello', {
      principal: async () => {
        if (revoked) throw new UploadManagementError('unauthorized');
        return principal;
      },
    });
    test.management.claimTransfer.mockImplementationOnce(async () => {
      revoked = true;
      return lease;
    });
    const done = test.run();
    test.req.end('hello');
    await done;
    expect(test.storage.put).not.toHaveBeenCalled();
    expect(test.management.accept).not.toHaveBeenCalled();
    expect(test.management.fail).toHaveBeenCalledWith(lease, 'unauthorized');
    expect(test.management.confirmCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ originalAbsent: true }),
    );
    expect(test.response.statusCode).toBe(401);
    expect(await readdir(root)).toEqual([]);
  });
  it('accepts a current explicit-null guest without changing its storage or cleanup ownership', async () => {
    const guest: UploadPrincipal = { authentication: 'guest', tenantId: null, userId: 'guest' };
    const guestLease = { ...lease, tenantId: null, userId: guest.userId };
    const test = fixture('hello', { principal: async () => guest });
    test.management.claimTransfer.mockResolvedValue(guestLease);
    const done = test.run();
    test.req.end('hello');
    await done;
    expect(test.response.statusCode).toBe(202);
    expect(test.management.get).toHaveBeenCalledWith(guest, 'operation');
    expect(test.management.accept).toHaveBeenCalledWith(
      guest,
      'operation',
      guestLease,
      expect.objectContaining({ outcome: 'durable' }),
      expect.objectContaining({
        subject: expect.objectContaining({ tenantId: null, userId: 'guest' }),
      }),
    );
    expect(test.storage.put).toHaveBeenCalledWith(expect.objectContaining({ lease: guestLease }));
    expect(await readdir(root)).toEqual([]);
  });
  it.each([
    ['verified-email', 'revoked'],
    ['verified-email', 'changed-owner'],
    ['guest', 'revoked'],
    ['guest', 'changed-owner'],
  ] as const)(
    'rechecks %s %s after durable storage and keeps the original charged for cleanup',
    async (authentication, change) => {
      const admitted: UploadPrincipal =
        authentication === 'guest'
          ? { authentication, tenantId: null, userId: 'guest' }
          : principal;
      const admittedLease = { ...lease, tenantId: admitted.tenantId, userId: admitted.userId };
      let completedPut = false;
      const test = fixture('hello', {
        principal: async () => {
          if (completedPut && change === 'revoked') throw new UploadManagementError('unauthorized');
          if (!completedPut) return admitted;
          if (admitted.authentication === 'verified-email')
            return { ...admitted, tenantId: 'other-tenant', userId: 'other-user' };
          return { ...admitted, userId: 'other-user' };
        },
      });
      test.management.claimTransfer.mockResolvedValue(admittedLease);
      const put = test.storage.put.getMockImplementation()!;
      test.storage.put.mockImplementationOnce(async (input) => {
        const receipt = await put(input);
        completedPut = true;
        return receipt;
      });
      const done = test.run();
      test.req.end('hello');
      await done;
      expect(test.management.accept).not.toHaveBeenCalled();
      expect(test.storage.remove).not.toHaveBeenCalled();
      expect(test.management.fail).toHaveBeenCalledWith(admittedLease, 'unauthorized');
      expect(test.management.confirmCleanup).toHaveBeenCalledWith(
        expect.objectContaining({
          writerStopped: true,
          localCopiesAbsent: true,
          originalAbsent: false,
        }),
      );
      expect(test.response.statusCode).toBe(401);
      expect(await readdir(root)).toEqual([]);
    },
  );
  it('stops an active partial transfer at the existing heartbeat after grant revocation', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      let revoked = false;
      let received!: () => void;
      const firstByte = new Promise<void>((resolve) => {
        received = resolve;
      });
      const test = fixture('hello', {
        principal: async () => {
          if (revoked) throw new UploadManagementError('unauthorized');
          return principal;
        },
      });
      test.completeBytes.mockImplementation(async () => {
        received();
      });
      const done = test.run();
      test.req.write('h');
      await firstByte;
      revoked = true;
      await jest.advanceTimersByTimeAsync(5_000);
      await done;
      expect(test.storage.put).not.toHaveBeenCalled();
      expect(test.management.accept).not.toHaveBeenCalled();
      expect(test.management.renew).not.toHaveBeenCalled();
      expect(test.management.fail).toHaveBeenCalledWith(lease, 'unauthorized');
      expect(test.response.statusCode).toBe(401);
      expect(await readdir(root)).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });
  it('keeps one unclaimed request paused and ends it at the deadline without replay or staging', async () => {
    const observe = jest.fn();
    const test = fixture('hello', { deadlineMs: 20, observe });
    test.management.claimTransfer.mockResolvedValue(null as never);
    test.req.write('hello');
    await test.run();
    expect(test.storage.put).not.toHaveBeenCalled();
    expect(test.claimBytes).not.toHaveBeenCalled();
    expect(test.management.cancel).toHaveBeenCalledWith(principal, 'operation');
    expect(test.response.statusCode).toBe(408);
    expect(observe.mock.calls.map(([event]) => event)).toEqual(
      ['wait', 'request'].map((stage) => ({
        kind: 'stage',
        stage,
        seconds: expect.any(Number),
        outcome: 'cancelled',
      })),
    );
    expect(await readdir(root)).toEqual([]);
  });
  it('terminates a stalled partial body and closes/removes its owned staging file', async () => {
    const test = fixture('hello', { idleMs: 20 });
    const done = test.run();
    test.req.write('he');
    await done;
    expect(test.storage.put).not.toHaveBeenCalled();
    expect(test.security.inspect).not.toHaveBeenCalled();
    expect(test.response.statusCode).toBe(408);
    expect(await readdir(root)).toEqual([]);
  });
  it('refuses an expired byte allowance and never accepts the file', async () => {
    const test = fixture();
    test.claimBytes.mockResolvedValueOnce({
      bytes: 5,
      generation: 1,
      expiresAt: '2000-01-01T00:00:00Z',
    });
    const done = test.run();
    test.req.end('hello');
    await done;
    expect(test.management.fail).toHaveBeenCalledWith(lease, 'lease_lost');
    expect(test.management.accept).not.toHaveBeenCalled();
  });
  it('rejects excess and short streams without accepting or sending them to S3', async () => {
    for (const data of ['four', 'longer']) {
      const test = fixture(data);
      const done = test.run();
      test.req.end(data);
      await done;
      expect(test.management.accept).not.toHaveBeenCalled();
      expect(test.storage.put).not.toHaveBeenCalled();
      expect(test.security.inspect).not.toHaveBeenCalled();
      expect(test.management.fail).toHaveBeenCalledWith(lease, 'size_mismatch');
    }
  });
  it('retains durable accounting on an unknown PUT outcome', async () => {
    const ticket = { bind: jest.fn(), settle: jest.fn() };
    const observe = jest.fn();
    const test = fixture('hello', {
      outcome: 'unknown',
      attempts: { begin: () => ticket } as never,
      observe,
    });
    const done = test.run();
    test.req.end('hello');
    await done;
    expect(test.management.accept).not.toHaveBeenCalled();
    expect(test.management.fail).toHaveBeenCalledWith(lease, 'storage_uncertain');
    expect(test.storage.remove).not.toHaveBeenCalled();
    expect(test.management.confirmCleanup).not.toHaveBeenCalled();
    expect(observe.mock.calls.map(([event]) => event)).not.toContainEqual({
      kind: 'accepted',
      bytes: 5,
    });
    expect(ticket.settle).toHaveBeenCalledWith({
      writerStopped: false,
      localCopiesAbsent: true,
      storageOutcome: 'unknown',
    });
  });
  it('never deletes a pre-existing attempt owned by another invocation', async () => {
    const occupied = path.join(root, 'operation.1');
    await mkdir(occupied);
    await writeFile(path.join(occupied, 'original'), 'owned');
    const ticket = { bind: jest.fn(), settle: jest.fn() };
    const test = fixture('hello', { attempts: { begin: () => ticket } as never });
    const done = test.run();
    test.req.end('hello');
    await done;
    expect(await readFile(path.join(occupied, 'original'), 'utf8')).toBe('owned');
    expect(test.storage.put).not.toHaveBeenCalled();
    expect(test.management.confirmCleanup).not.toHaveBeenCalled();
    expect(ticket.settle).toHaveBeenCalledWith(
      expect.objectContaining({ writerStopped: false, localCopiesAbsent: false }),
    );
    await rm(occupied, { recursive: true });
  });
  it('tracks and joins an admission claim that resolves after local shutdown', async () => {
    const ticket = { bind: jest.fn(), settle: jest.fn() };
    let stop!: () => void;
    let entered!: () => void;
    let deliver!: (value: typeof lease) => void;
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const test = fixture('hello', {
      attempts: {
        begin: (abort: () => void) => {
          stop = abort;
          return ticket;
        },
      } as never,
    });
    test.management.claimTransfer.mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => {
        deliver = resolve;
      });
    });
    const done = test.run();
    test.req.write('hello');
    await entering;
    stop();
    deliver(lease);
    await done;
    expect(ticket.bind).toHaveBeenCalledWith(lease);
    expect(test.storage.put).not.toHaveBeenCalled();
    expect(ticket.settle).toHaveBeenCalledWith({
      writerStopped: true,
      localCopiesAbsent: true,
      storageOutcome: 'not_started',
    });
    expect(await readdir(root)).toEqual([]);
  });

  it('keeps diagnostics from changing durable acceptance or cleanup', async () => {
    const observe = jest.fn((event: RawUploadObservation) => {
      if (event.kind === 'received') throw new Error('synchronous observer failure');
      return Promise.reject(new Error('asynchronous observer failure'));
    });
    const test = fixture('hello', { observe });
    const done = test.run();
    test.req.end('hello');
    await done;
    expect(test.response.statusCode).toBe(202);
    expect(test.management.accept).toHaveBeenCalledTimes(1);
    expect(test.management.confirmCleanup).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(6);
    expect(await readdir(root)).toEqual([]);
  });

  it('does not report a completed original before durable acceptance acknowledges', async () => {
    const observe = jest.fn();
    const test = fixture('hello', { observe });
    test.management.accept.mockRejectedValueOnce(new Error('unknown acknowledgement') as never);
    const done = test.run();
    test.req.end('hello');
    await done;
    expect(test.response.statusCode).toBe(503);
    expect(observe.mock.calls.map(([event]) => event)).not.toContainEqual({
      kind: 'accepted',
      bytes: 5,
    });
    expect(observe).not.toHaveBeenCalledWith(expect.objectContaining({ stage: 'total' }));
  });
});
