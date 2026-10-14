import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { Request, Response } from 'express';
import type { RawUploadBodyDependencies, RawUploadObservation } from './body';
import type { UploadAttemptPort } from '../contract';
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
  beforeAll(async () => {
    if (!process.env.UPLOAD_TEST_TMPDIR)
      throw new Error('Explicit isolated upload test directory required');
    await mkdir(process.env.UPLOAD_TEST_TMPDIR, { recursive: true });
    root = await mkdtemp(path.join(process.env.UPLOAD_TEST_TMPDIR, 'transport-'));
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
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
    } = {},
  ) {
    const inputBytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
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
      claimTransfer: jest.fn(async () => lease),
      renew: jest.fn(async () => lease),
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
          expect(Buffer.concat(chunks)).toEqual(inputBytes);
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
    const handler = createRawUploadBodyHandler({
      management: management as never,
      principal: options.principal ?? (async () => principal),
      storage: storage as never,
      worker: lease,
      stagingRoot: root,
      claimBytes,
      completeBytes,
      deadlineMs: options.deadlineMs,
      idleMs: options.idleMs,
      attempts: options.attempts,
      observe: options.observe,
    });
    return {
      req,
      response,
      management,
      storage,
      completeBytes,
      claimBytes,
      run: () => handler(req as unknown as Request, response as unknown as Response, jest.fn()),
    };
  }
  it('accepts only counted, staged and durable bytes and awaits both traffic grant completions', async () => {
    const observe = jest.fn();
    const test = fixture('hello', { observe });
    const done = test.run();
    test.req.end('hello');
    await done;
    expect(test.management.accept).toHaveBeenCalledTimes(1);
    expect(test.response.statusCode).toBe(202);
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
      );
      expect(await readdir(root)).toEqual([]);
    }
  });
  it('binds PUT integrity to received bytes even if same-length staging changes before the PUT read', async () => {
    const received = Buffer.from('hello');
    const altered = Buffer.from('HELLO');
    let replaced = false;
    const test = fixture(received, {
      observe: (event) => {
        if (event.kind === 'stage' && event.stage === 'transfer' && event.outcome === 'success') {
          writeFileSync(path.join(root, 'operation.1', 'original'), altered);
          replaced = true;
        }
      },
    });
    let submitted: Buffer | undefined;
    test.storage.put.mockImplementationOnce(async ({ body, integrity }) => {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      submitted = Buffer.concat(chunks);
      // The storage owner separately verifies the identity; an uncertain writer retains its obligation.
      return {
        outcome: 'unknown',
        bytes: received.byteLength,
        source: 's3',
        filepath: 'private',
        storageKey: 'private',
        integrity,
      };
    });
    const done = test.run();
    test.req.end(received);
    await done;
    expect(replaced).toBe(true);
    expect(submitted).toEqual(altered);
    expect(test.storage.put).toHaveBeenCalledWith(
      expect.objectContaining({ integrity: expectedIntegrity(received) }),
    );
    expect(test.management.accept).not.toHaveBeenCalled();
    expect(test.management.fail).toHaveBeenCalledWith(lease, 'storage_uncertain');
    expect(test.management.confirmCleanup).not.toHaveBeenCalled();
    expect(test.response.statusCode).toBe(503);
    expect(await readdir(root)).toEqual([]);
  });
  it('does not read or stage an unauthorized body', async () => {
    const test = fixture('hello', { authorized: false });
    test.req.write('hello');
    await test.run();
    expect(test.req.readableLength).toBe(5);
    expect(test.storage.put).not.toHaveBeenCalled();
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
  it.each(['revoked', 'changed-owner'] as const)(
    'rechecks %s after durable storage and keeps the original charged for cleanup',
    async (change) => {
      let completedPut = false;
      const test = fixture('hello', {
        principal: async () => {
          if (completedPut && change === 'revoked') throw new UploadManagementError('unauthorized');
          return completedPut
            ? { ...principal, tenantId: 'other-tenant', userId: 'other-user' }
            : principal;
        },
      });
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
      expect(test.management.fail).toHaveBeenCalledWith(lease, 'unauthorized');
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
