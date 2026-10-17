/** Fixed mTLS channel. The application must claim a promotion before permitting its first byte. */
import { once } from 'node:events';
import { TLSSocket } from 'node:tls';
import { createServer, request } from 'node:https';
import { UPLOAD_ERROR_CODES, UPLOAD_MAX_FILE_BYTES } from 'librechat-data-provider';
import type { UploadWorker, UploadOriginalIntegrity } from 'librechat-data-provider';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { UploadManagementError, isUploadManagementError } from '../errors';
import { verifyOriginalIntegrity } from '../storage/integrity';
import { createPinnedServiceEndpoint } from './endpoint';

const JSON_BYTES = 32 * 1024;
const IDENTIFIER = /^[a-zA-Z0-9-]{1,128}$/;
const WORKER_IDENTIFIER = /^[a-zA-Z0-9_.-]{1,128}$/;
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
const PROMOTION = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
type TlsMaterial = { ca: Buffer | string; cert: Buffer | string; key: Buffer | string };
type ClientContext = { operationId: string; capability: string; signal: AbortSignal };
export type IntakeChannelContext = Omit<ClientContext, 'signal'> & { worker: UploadWorker };
export interface IntakeChannelHandlers {
  control(context: IntakeChannelContext, command: unknown, signal: AbortSignal): Promise<unknown>;
  /** Body-free authorization and durable exclusive claim; no document input exists here. */
  promote(
    context: IntakeChannelContext,
    promotionId: string,
    bytes: number,
    signal: AbortSignal,
  ): Promise<{
    consume(body: AsyncIterable<Uint8Array>): Promise<unknown>;
    close(): Promise<void>;
  }>;
}
export interface IntakeChannel {
  control(input: ClientContext & { command: unknown }): Promise<unknown>;
  promote(
    input: ClientContext & {
      promotionId: string;
      bytes: number;
      integrity: UploadOriginalIntegrity;
      body: AsyncIterable<Uint8Array>;
    },
  ): Promise<unknown>;
}
function fail(code: 'invalid_request' | 'unauthorized' | 'unavailable' = 'invalid_request'): never {
  throw new UploadManagementError(code);
}
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value))
  )
    fail();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !keys.includes(key) || !descriptor || !('value' in descriptor))
      fail();
    copy[key] = descriptor.value;
  }
  return copy;
}
function entries(value: unknown): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > 64
  )
    fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) fail();
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor)) fail();
    return descriptor.value;
  });
}
function workerIdentity(value: unknown): UploadWorker {
  const worker = fields(value, ['hostId', 'instanceId']);
  if (
    typeof worker.hostId !== 'string' ||
    !WORKER_IDENTIFIER.test(worker.hostId) ||
    typeof worker.instanceId !== 'string' ||
    !WORKER_IDENTIFIER.test(worker.instanceId)
  )
    fail();
  return Object.freeze({ hostId: worker.hostId, instanceId: worker.instanceId });
}
function tlsMaterial(value: TlsMaterial): { ca: Buffer; cert: Buffer; key: Buffer } {
  const copy = fields(value, ['ca', 'cert', 'key']);
  const material = (item: unknown): Buffer => {
    if (!(typeof item === 'string' || Buffer.isBuffer(item)) || !item.length) fail();
    return Buffer.from(item);
  };
  return { ca: material(copy.ca), cert: material(copy.cert), key: material(copy.key) };
}
function header(message: IncomingMessage, name: string): string | undefined {
  if (
    message.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name)
      .length > 1
  )
    fail();
  const value = message.headers[name];
  if (Array.isArray(value)) fail();
  return value;
}
function encoded(value: unknown): Buffer {
  const result = Buffer.from(JSON.stringify(value));
  if (result.length > JSON_BYTES) fail();
  return result;
}
async function readJson(message: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  if (
    header(message, 'content-type')?.split(';')[0] !== 'application/json' ||
    header(message, 'content-encoding') !== undefined
  )
    fail();
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of message) {
    signal.throwIfAborted();
    bytes += chunk.length;
    if (bytes > JSON_BYTES) fail();
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}
function respond(response: ServerResponse, status: number, data: unknown) {
  if (response.headersSent || response.destroyed) return;
  const body = encoded(data);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Connection: 'close',
    'Content-Length': body.length,
  });
  response.end(body);
}
function failure(response: ServerResponse, error: unknown) {
  const code = isUploadManagementError(error) ? error.code : 'unavailable';
  const statuses: Record<string, number> = {
    unauthorized: 401,
    invalid_request: 400,
    security_uninspectable: 422,
    security_rejected: 422,
  };
  const status = statuses[code] ?? 503;
  respond(response, status, { code });
}
function clock(parent: AbortSignal | undefined, milliseconds: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(new UploadManagementError('unavailable'));
  const timer = setTimeout(abort, milliseconds);
  timer.unref();
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  return {
    controller,
    signal: controller.signal,
    close: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}

export function createIntakeChannel(
  options: Parameters<typeof createPinnedServiceEndpoint>[0] & {
    worker: UploadWorker;
    tls: TlsMaterial;
  },
): IntakeChannel {
  const config = fields(options, [
    'endpoint',
    'allowedHosts',
    'resolve',
    'worker',
    'tls',
  ]) as unknown as typeof options;
  const worker = workerIdentity(config.worker);
  const tls = tlsMaterial(config.tls);
  const { url: endpoint, lookup } = createPinnedServiceEndpoint({
    endpoint: config.endpoint,
    allowedHosts: config.allowedHosts,
    resolve: config.resolve,
  });
  async function call(
    context: ClientContext,
    promotion?: Parameters<IntakeChannel['promote']>[0],
    command?: unknown,
  ): Promise<unknown> {
    if (!IDENTIFIER.test(context.operationId) || !CAPABILITY.test(context.capability)) fail();
    if (
      promotion &&
      (!PROMOTION.test(promotion.promotionId) ||
        !Number.isSafeInteger(promotion.bytes) ||
        promotion.bytes < 1 ||
        promotion.bytes > UPLOAD_MAX_FILE_BYTES)
    )
      fail();
    const body = promotion ? undefined : encoded(command);
    const deadline = clock(context.signal, 120_000);
    let req: ReturnType<typeof request> | undefined;
    let sending: Promise<void> = Promise.resolve();
    let permitted = false;
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        req = request(
          new URL(
            `/v1/intake/${promotion ? 'promote' : 'control'}/${context.operationId}`,
            endpoint,
          ),
          {
            method: promotion ? 'PUT' : 'POST',
            ...tls,
            lookup,
            rejectUnauthorized: true,
            minVersion: 'TLSv1.3',
            agent: false,
            signal: deadline.signal,
            headers: {
              'Content-Type': promotion ? 'application/octet-stream' : 'application/json',
              'Content-Length': promotion?.bytes ?? body!.length,
              'X-Upload-Capability': context.capability,
              'X-Upload-Worker-Host': worker.hostId,
              'X-Upload-Worker-Instance': worker.instanceId,
              ...(promotion
                ? { Expect: '100-continue', 'X-Upload-Promotion': promotion.promotionId }
                : {}),
            },
          },
          (response) => {
            void readJson(response, deadline.signal).then((value) => {
              if (response.statusCode !== 200) {
                const code =
                  value && typeof value === 'object' && 'code' in value ? value.code : undefined;
                reject(
                  new UploadManagementError(
                    typeof code === 'string' &&
                    UPLOAD_ERROR_CODES.some((candidate) => candidate === code)
                      ? (code as (typeof UPLOAD_ERROR_CODES)[number])
                      : 'unavailable',
                  ),
                );
              } else if (promotion && !permitted) reject(new UploadManagementError('unavailable'));
              else resolve(value);
            }, reject);
          },
        );
        req.once('error', reject);
        if (promotion) {
          req.once('continue', () => {
            if (deadline.signal.aborted) return;
            permitted = true;
            sending = (async () => {
              for await (const chunk of verifyOriginalIntegrity(
                promotion.body,
                promotion.bytes,
                promotion.integrity,
                deadline.signal,
              )) {
                if (!req!.write(chunk)) await once(req!, 'drain', { signal: deadline.signal });
              }
              req!.end();
            })();
            void sending.catch((error) => {
              req?.destroy(error);
              reject(error);
            });
          });
          req.flushHeaders();
        } else req.end(body);
      });
      await sending;
      return result;
    } catch (error) {
      if (isUploadManagementError(error)) throw error;
      throw new UploadManagementError('unavailable');
    } finally {
      deadline.controller.abort();
      deadline.close();
      req?.destroy();
      await sending.catch(() => undefined);
    }
  }
  return {
    control: (input) => call(input, undefined, input.command),
    promote: (input) => call(input, input),
  };
}

export async function startIntakeControlService(options: {
  tls: TlsMaterial;
  peers: readonly { certificateSha256: string; role: 'intake'; hostIds: readonly string[] }[];
  handlers: IntakeChannelHandlers;
  host?: string;
  port?: number;
  deadlineMs?: number;
}): Promise<{ address: AddressInfo; close(signal?: AbortSignal): Promise<{ complete: boolean }> }> {
  const config = fields(options, [
    'tls',
    'peers',
    'handlers',
    'host',
    'port',
    'deadlineMs',
  ]) as unknown as typeof options;
  const tls = tlsMaterial(config.tls);
  const peers = new Map<string, ReadonlySet<string>>();
  for (const input of entries(config.peers)) {
    const peer = fields(input, ['certificateSha256', 'role', 'hostIds']);
    if (
      typeof peer.certificateSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(peer.certificateSha256) ||
      peers.has(peer.certificateSha256) ||
      peer.role !== 'intake'
    )
      fail();
    const hosts = entries(peer.hostIds);
    if (
      hosts.some((host) => typeof host !== 'string' || !WORKER_IDENTIFIER.test(host)) ||
      new Set(hosts).size !== hosts.length
    )
      fail();
    peers.set(peer.certificateSha256, new Set(hosts as string[]));
  }
  const handlers = fields(config.handlers, [
    'control',
    'promote',
  ]) as unknown as IntakeChannelHandlers;
  if (typeof handlers.control !== 'function' || typeof handlers.promote !== 'function') fail();
  const host = config.host ?? '0.0.0.0';
  const port = config.port ?? 8444;
  if (
    typeof host !== 'string' ||
    !host.length ||
    !Number.isSafeInteger(port) ||
    port < 0 ||
    port > 65535
  )
    fail();
  const milliseconds = config.deadlineMs ?? 120_000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 120_000) fail();
  const active = new Set<{ controller: AbortController; done: Promise<void> }>();
  let stopped = false;
  async function handle(
    message: IncomingMessage,
    response: ServerResponse,
    expectContinue: boolean,
    deadline: ReturnType<typeof clock>,
  ) {
    let promotion: Awaited<ReturnType<IntakeChannelHandlers['promote']>> | undefined;
    const disconnect = () => {
      if (!response.writableEnded) deadline.controller.abort();
    };
    const abort = () => {
      failure(response, new UploadManagementError('unavailable'));
      message.destroy();
    };
    message.once('aborted', disconnect);
    response.once('close', disconnect);
    deadline.signal.addEventListener('abort', abort, { once: true });
    try {
      if (stopped || !(message.socket instanceof TLSSocket) || !message.socket.authorized)
        fail('unauthorized');
      const fingerprint = message.socket
        .getPeerCertificate()
        .fingerprint256?.replaceAll(':', '')
        .toLowerCase();
      const hosts = fingerprint && peers.get(fingerprint);
      if (!hosts) fail('unauthorized');
      const worker = workerIdentity({
        hostId: header(message, 'x-upload-worker-host'),
        instanceId: header(message, 'x-upload-worker-instance'),
      });
      if (!hosts.has(worker.hostId)) fail('unauthorized');
      if (
        header(message, 'authorization') !== undefined ||
        header(message, 'cookie') !== undefined ||
        header(message, 'content-encoding') !== undefined
      )
        fail();
      const match = /^\/v1\/intake\/(control|promote)\/([a-zA-Z0-9-]{1,128})$/.exec(
        message.url ?? '',
      );
      const capability = header(message, 'x-upload-capability');
      if (!match || !capability || !CAPABILITY.test(capability)) fail();
      const context = { operationId: match[2], capability, worker: { ...worker } };
      if (match[1] === 'control') {
        if (expectContinue || message.method !== 'POST') fail();
        const result = await handlers.control(
          context,
          await readJson(message, deadline.signal),
          deadline.signal,
        );
        deadline.signal.throwIfAborted();
        respond(response, 200, result ?? null);
      } else {
        const promotionId = header(message, 'x-upload-promotion');
        const length = header(message, 'content-length');
        if (
          !expectContinue ||
          message.method !== 'PUT' ||
          header(message, 'expect') !== '100-continue' ||
          header(message, 'content-type') !== 'application/octet-stream' ||
          !promotionId ||
          !PROMOTION.test(promotionId) ||
          !length ||
          !/^[1-9][0-9]{0,7}$/.test(length) ||
          Number(length) > UPLOAD_MAX_FILE_BYTES ||
          header(message, 'transfer-encoding') !== undefined
        )
          fail();
        promotion = await handlers.promote(context, promotionId, Number(length), deadline.signal);
        deadline.signal.throwIfAborted();
        response.writeContinue();
        const result = await promotion.consume(message);
        deadline.signal.throwIfAborted();
        await promotion.close();
        promotion = undefined;
        respond(response, 200, result ?? null);
      }
    } catch (error) {
      failure(response, error);
    } finally {
      deadline.signal.removeEventListener('abort', abort);
      deadline.controller.abort();
      await promotion?.close().catch(() => undefined);
      deadline.close();
      message.off('aborted', disconnect);
      response.off('close', disconnect);
    }
  }
  function dispatch(message: IncomingMessage, response: ServerResponse, expectContinue: boolean) {
    message.pause();
    const deadline = clock(undefined, milliseconds);
    const record = { controller: deadline.controller, done: Promise.resolve() };
    active.add(record);
    record.done = handle(message, response, expectContinue, deadline).finally(() =>
      active.delete(record),
    );
    void record.done.catch(() => undefined);
  }
  const server = createServer(
    {
      ...tls,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
      maxHeaderSize: 8192,
      requestTimeout: milliseconds,
      headersTimeout: Math.min(5000, milliseconds),
      keepAliveTimeout: 1000,
    },
    (req, res) => dispatch(req, res, false),
  );
  server.on('checkContinue', (req, res) => dispatch(req, res, true));
  server.maxConnections = 16;
  server.maxRequestsPerSocket = 1;
  server.setTimeout(milliseconds, (socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  let closed: Promise<void> | undefined;
  return {
    address,
    async close(signal = AbortSignal.timeout(10_000)): Promise<{ complete: boolean }> {
      if (!stopped) {
        stopped = true;
        closed = new Promise((resolve) => server.close(() => resolve()));
      }
      for (const item of active) item.controller.abort();
      server.closeAllConnections();
      let abort!: () => void;
      try {
        const interrupted = new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error('unavailable'));
          signal.addEventListener('abort', abort, { once: true });
        });
        signal.throwIfAborted();
        await Promise.race([
          Promise.all([closed, ...[...active].map((item) => item.done)]),
          interrupted,
        ]);
        return { complete: active.size === 0 };
      } catch {
        return { complete: false };
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
  };
}
