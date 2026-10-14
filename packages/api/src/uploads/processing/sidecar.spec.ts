import path from 'node:path';
import { request } from 'node:http';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { UploadParserResourceOwner, UploadParserResources } from '../platform/parserResources';
import type { DocumentSidecar } from './sidecar';
import { startDocumentSidecar } from './sidecar';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));

describe('parser resources on the existing Unix execution boundary', () => {
  let root: string;
  let socketPath: string;
  let sidecar: DocumentSidecar | undefined;
  beforeEach(async () => {
    if (!process.env.UPLOAD_TEST_TMPDIR)
      throw new Error('Explicit isolated upload test directory required');
    await mkdir(process.env.UPLOAD_TEST_TMPDIR, { recursive: true });
    root = await mkdtemp(path.join(process.env.UPLOAD_TEST_TMPDIR, 'sidecar-'));
    socketPath = path.join(root, 'parser.sock');
    if (Buffer.byteLength(socketPath) >= 100)
      throw new Error('Upload fixture root must allow a short Unix socket path');
    (spawn as jest.Mock).mockReset();
  });
  afterEach(async () => {
    await sidecar?.close();
    sidecar = undefined;
    if (root) await rm(root, { recursive: true, force: true });
  });
  function resources() {
    const value: UploadParserResources = {
      schema: 1,
      instanceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      observedAtMs: Date.now() - 500,
      active: false,
      memory: { currentBytes: 100 * 1048576, limitBytes: 768 * 1048576, reservedBytes: 0 },
      scratch: {
        usedBytes: 0,
        reservedBytes: 0,
        freeBytes: 512 * 1048576,
        freeInodes: 10000,
        capacityBytes: 128 * 1048576,
      },
    };
    return {
      value,
      current: jest.fn(() => value),
      start: jest.fn(async () => undefined),
      claim: jest.fn(),
      release: jest.fn(),
      safe: jest.fn(() => true),
      close: jest.fn(),
    };
  }
  async function start(resourceOwner: UploadParserResourceOwner) {
    sidecar = await startDocumentSidecar({
      socketPath,
      stagingRoot: root,
      scratchRoot: root,
      childEntry: path.join(root, 'never-executed.js'),
      resourceOwner,
    });
  }
  function call(
    target: string,
    body?: unknown,
  ): Promise<{ status: number; data: Record<string, unknown> }> {
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath,
          path: target,
          method: encoded ? 'POST' : 'GET',
          headers: encoded
            ? { 'content-type': 'application/json', 'content-length': encoded.length }
            : {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.once('error', reject);
          res.once('end', () => {
            try {
              const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (!data || typeof data !== 'object' || Array.isArray(data)) {
                throw new Error('Parser fixture expected a JSON object');
              }
              resolve({ status: res.statusCode ?? 0, data: data as Record<string, unknown> });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.setTimeout(5000, () => req.destroy(new Error('Parser fixture request timed out')));
      req.once('error', reject);
      req.end(encoded);
    });
  }
  it('returns actual source time and denies resource mutation without creating a child', async () => {
    const owner = resources();
    await start(owner);
    expect(await call('/resources')).toEqual({ status: 200, data: owner.value });
    expect((await call('/resources', { freeBytes: 999999999 })).status).toBe(400);
    expect(owner.claim).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
  it('rejects an unsafe claim before file access or spawn and retains exact stopped proof', async () => {
    const owner = resources();
    owner.claim.mockImplementation(() => {
      throw new Error('unsafe');
    });
    await start(owner);
    const prepared = await call('/prepare', { attemptId: 'operation.2', mediaType: 'text/plain' });
    expect(prepared.status).toBe(200);
    expect(await call('/extract', prepared.data)).toEqual({
      status: 422,
      data: { code: 'resource_limit', joined: true },
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(owner.release).toHaveBeenCalledTimes(1);
    expect(await call('/cancel', prepared.data)).toEqual({
      status: 200,
      data: { writerStopped: true },
    });
    expect(
      (await call('/cancel', { ...prepared.data, instanceId: 'other' })).data.writerStopped,
    ).toBe(false);
  });
  it('fences resource exhaustion and waits for child close before releasing its reservation', async () => {
    const owner = resources();
    await start(owner);
    await mkdir(path.join(root, 'operation.3'));
    await writeFile(path.join(root, 'operation.3', 'original'), 'fixture');
    let spawned!: () => void;
    let killed!: () => void;
    const entered = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      killed = resolve;
    });
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: jest.fn(() => {
        killed();
        return true;
      }),
    });
    (spawn as jest.Mock).mockImplementation(() => {
      spawned();
      return child;
    });
    const prepared = await call('/prepare', { attemptId: 'operation.3', mediaType: 'text/plain' });
    let replied = false;
    const extracting = call('/extract', prepared.data).then((value) => {
      replied = true;
      return value;
    });
    await entered;
    owner.safe.mockReturnValue(false);
    await stopped;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(replied).toBe(false);
    expect(owner.release).not.toHaveBeenCalled();
    child.emit('close', null);
    expect(await extracting).toEqual({
      status: 422,
      data: { code: 'resource_limit', joined: true },
    });
    expect(owner.release).toHaveBeenCalledTimes(1);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  });
});
