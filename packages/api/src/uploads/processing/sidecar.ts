import { MANAGED_DOCUMENT_WIRE_MAX_BYTES } from 'librechat-data-provider';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { UploadParserExecution } from 'librechat-data-provider';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UploadParserResourceOwner } from '../platform/parserResources';
import type { ParserAttempt } from './receipts';
import {
  MANAGED_DOCUMENT_LIMITS,
  MANAGED_DOCUMENT_TYPES,
  DocumentProcessingError,
} from '../../files/documents/managed';
import { createUploadParserResourceOwner } from '../platform/parserResources';
import { existingAttemptOriginal, attemptOriginalPath } from './paths';
import { ParserReceipts } from './receipts';

export type DocumentSidecarOptions = {
  socketPath: string;
  stagingRoot: string;
  scratchRoot: string;
  childEntry: string;
  /** These ceilings may only be lowered for focused, isolated fixtures. */
  wallMs?: number;
  receiptCapacity?: number;
  receiptRetentionMs?: number;
  cgroupDirectory?: string;
  /** Trusted composition/test port only; the Unix caller cannot supply resource observations. */
  resourceOwner?: UploadParserResourceOwner;
};
export interface DocumentSidecar {
  close(): Promise<void>;
}

const failureCodes = new Set([
  'unsupported_format',
  'resource_limit',
  'invalid_document',
  'no_text',
  'cancelled',
  'processing_timeout',
  'parser_unavailable',
]);

function json(response: ServerResponse, status: number, data: unknown) {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(data));
}
function failure(response: ServerResponse, code: string, joined: boolean, status = 422) {
  json(response, status, { code, joined });
}

async function metadata(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (
    request.method !== 'POST' ||
    request.headers['content-type'] !== 'application/json' ||
    request.headers['content-encoding'] !== undefined ||
    request.headers['transfer-encoding'] !== undefined
  ) {
    throw new DocumentProcessingError('invalid_document');
  }
  const length = Number(request.headers['content-length']);
  if (!Number.isSafeInteger(length) || length < 1 || length > 1024)
    throw new DocumentProcessingError('invalid_document');
  let bytes = 0;
  const chunks: Buffer[] = [];
  const timeout = setTimeout(() => request.destroy(), 5_000);
  timeout.unref();
  try {
    for await (const value of request) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > length) throw new DocumentProcessingError('invalid_document');
      chunks.push(chunk);
    }
    if (bytes !== length) throw new DocumentProcessingError('invalid_document');
    const input: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new DocumentProcessingError('invalid_document');
    return input as Record<string, unknown>;
  } finally {
    clearTimeout(timeout);
  }
}

function executionInput(input: Record<string, unknown>): UploadParserExecution {
  if (
    Object.keys(input).length !== 3 ||
    typeof input.attemptId !== 'string' ||
    typeof input.instanceId !== 'string' ||
    typeof input.expiresAt !== 'string'
  ) {
    throw new DocumentProcessingError('invalid_document');
  }
  return { attemptId: input.attemptId, instanceId: input.instanceId, expiresAt: input.expiresAt };
}

/** Same-Pod execution boundary: no identity, credentials, shared queue or database authority. */
export async function startDocumentSidecar(
  options: DocumentSidecarOptions,
): Promise<DocumentSidecar> {
  const wallMs = options.wallMs ?? MANAGED_DOCUMENT_LIMITS.wallMs;
  if (
    ![options.socketPath, options.stagingRoot, options.scratchRoot, options.childEntry].every(
      path.isAbsolute,
    )
  ) {
    throw new Error('Invalid parser configuration');
  }
  const receipts = new ParserReceipts({
    wallMs,
    capacity: options.receiptCapacity,
    retentionMs: options.receiptRetentionMs,
  });
  const resources =
    options.resourceOwner ??
    createUploadParserResourceOwner({
      scratchRoot: options.scratchRoot,
      cgroupDirectory: options.cgroupDirectory ?? '/sys/fs/cgroup',
      instanceId: receipts.instanceId,
    });
  const existing = await lstat(options.socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing) {
    if (!existing.isSocket()) throw new Error('Parser socket path is not a socket');
    const stale = await new Promise<boolean>((resolve) => {
      const probe = createConnection(options.socketPath);
      const finish = (value: boolean) => {
        probe.destroy();
        resolve(value);
      };
      probe.setTimeout(1_000, () => finish(false));
      probe.once('connect', () => finish(false));
      probe.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ECONNREFUSED'));
    });
    const current = await lstat(options.socketPath);
    if (!stale || current.ino !== existing.ino || current.dev !== existing.dev)
      throw new Error('Parser socket already exists');
    await unlink(options.socketPath);
  }
  let active: { record: ParserAttempt; joined: Promise<void>; stop: () => void } | null = null;
  let closing = false;
  await resources.start();

  async function extract(record: ParserAttempt, response: ServerResponse) {
    let resolveJoin!: () => void;
    let child: ChildProcessWithoutNullStreams | undefined;
    let stopCode = 'cancelled';
    const stop = (code = 'cancelled') => {
      stopCode = code;
      receipts.fence(record);
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    };
    const slot = {
      record,
      joined: new Promise<void>((resolve) => {
        resolveJoin = resolve;
      }),
      stop,
    };
    active = slot; // Synchronous reservation, before any filesystem await or child start.
    const disconnected = () => {
      if (!response.writableEnded) stop();
    };
    response.once('close', disconnected);
    const timer = setTimeout(
      () => stop('processing_timeout'),
      Math.max(1, receipts.remainingMs(record)),
    );
    timer.unref();
    const resourceTimer = setInterval(() => {
      if (!resources.safe()) stop('resource_limit');
    }, 1_000);
    resourceTimer.unref();
    let joined = true;
    try {
      try {
        resources.claim();
      } catch {
        throw new DocumentProcessingError('resource_limit');
      }
      await existingAttemptOriginal(options.stagingRoot, record.execution.attemptId);
      if (response.destroyed || record.state !== 'running' || receipts.remainingMs(record) <= 0) {
        stop();
        return failure(response, stopCode, true);
      }
      joined = false;
      child = spawn(
        process.execPath,
        [
          '--max-old-space-size=256',
          options.childEntry,
          options.stagingRoot,
          record.execution.attemptId,
          record.mediaType,
        ],
        {
          cwd: options.scratchRoot,
          env: {
            PATH: '/usr/bin:/bin',
            LANG: 'C.UTF-8',
            HOME: options.scratchRoot,
            TMPDIR: options.scratchRoot,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      child.stdin.end();
      const output: Buffer[] = [];
      let bytes = 0;
      let errorCode = '';
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MANAGED_DOCUMENT_WIRE_MAX_BYTES) stop('resource_limit');
        else if (record.state === 'running') output.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (errorCode.length < 128)
          errorCode += chunk.toString('utf8').slice(0, 128 - errorCode.length);
      });
      const exit = await new Promise<{ code: number | null; error?: Error }>((resolve) => {
        let spawnError: Error | undefined;
        child!.once('error', (error) => {
          spawnError = error;
        });
        child!.once('close', (code) => resolve({ code, error: spawnError }));
      });
      joined = true;
      if (record.state !== 'running') return failure(response, stopCode, true);
      if (exit.error || exit.code !== 0)
        return failure(
          response,
          failureCodes.has(errorCode) ? errorCode : 'parser_unavailable',
          true,
        );
      response.writeHead(200, {
        'content-type': 'application/vnd.librechat.document-frame',
        'content-length': bytes,
        'x-parser-joined': '1',
        'cache-control': 'no-store',
      });
      response.end(Buffer.concat(output, bytes));
    } catch (error) {
      if (child && !joined) {
        stop();
        await new Promise<void>((resolve) => child!.once('close', () => resolve()));
        joined = true;
      }
      let code = 'invalid_document';
      if (record.state === 'fenced') code = stopCode;
      else if (error instanceof DocumentProcessingError) code = error.code;
      failure(response, code, joined);
    } finally {
      clearTimeout(timer);
      clearInterval(resourceTimer);
      response.off('close', disconnected);
      receipts.finish(record);
      if (active === slot) active = null;
      resources.release();
      resolveJoin();
    }
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('connection', 'close');
    try {
      if (
        closing ||
        !['/prepare', '/extract', '/cancel', '/resources'].includes(request.url ?? '')
      ) {
        return failure(response, 'parser_unavailable', false, 503);
      }
      if (request.url === '/resources') {
        if (
          request.method !== 'GET' ||
          request.headers['content-length'] !== undefined ||
          request.headers['transfer-encoding'] !== undefined ||
          request.headers['content-encoding'] !== undefined
        ) {
          return failure(response, 'invalid_document', false, 400);
        }
        const value = resources.current();
        return value
          ? json(response, 200, value)
          : failure(response, 'parser_unavailable', false, 503);
      }
      const input = await metadata(request);
      if (request.url === '/prepare') {
        if (
          Object.keys(input).length !== 2 ||
          typeof input.attemptId !== 'string' ||
          typeof input.mediaType !== 'string' ||
          !MANAGED_DOCUMENT_TYPES.some((type) => type === input.mediaType)
        )
          throw new DocumentProcessingError('invalid_document');
        attemptOriginalPath(options.stagingRoot, input.attemptId);
        return json(response, 200, receipts.prepare(input.attemptId, input.mediaType));
      }
      const execution = executionInput(input);
      const record = receipts.find(execution);
      if (request.url === '/cancel') {
        if (!record) return json(response, 200, { writerStopped: false });
        receipts.fence(record); // Fence before any await; a delayed execute cannot start.
        const current = active;
        if (current?.record === record) {
          current.stop();
          await current.joined;
        } else receipts.finish(record, true);
        return json(response, 200, { writerStopped: true });
      }
      if (!record) return failure(response, 'parser_unavailable', false);
      if (record.state !== 'prepared')
        return failure(response, 'cancelled', active?.record !== record);
      if (active || !receipts.start(execution)) {
        receipts.finish(record, true);
        return failure(response, 'parser_unavailable', true, 429);
      }
      await extract(record, response);
    } catch (error) {
      failure(
        response,
        error instanceof DocumentProcessingError ? error.code : 'invalid_document',
        false,
        400,
      );
    }
  }
  const server = createServer((request, response) => {
    void handle(request, response);
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.maxConnections = 4;
  let ownedSocket: Awaited<ReturnType<typeof lstat>>;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    await chmod(options.socketPath, 0o600);
    ownedSocket = await lstat(options.socketPath);
  } catch (error) {
    resources.close();
    server.close();
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return {
    close() {
      closePromise ??= (async () => {
        closing = true;
        const current = active;
        current?.stop();
        await current?.joined;
        resources.close();
        server.closeIdleConnections();
        if (server.listening) {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => {
              if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING')
                reject(error);
              else resolve();
            }),
          );
        }
        // Node normally removes its Unix socket during close. If it remains,
        // clean only the inode this instance bound, never a replacement path.
        const remaining = await lstat(options.socketPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
        if (
          remaining?.isSocket() &&
          remaining.ino === ownedSocket.ino &&
          remaining.dev === ownedSocket.dev
        ) {
          await unlink(options.socketPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
      })();
      return closePromise;
    },
  };
}
