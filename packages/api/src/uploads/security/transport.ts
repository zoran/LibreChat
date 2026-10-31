import { once } from 'node:events';
import { request } from 'node:https';
import { TLSSocket } from 'node:tls';
import { createHash } from 'node:crypto';
import {
  readUploadOcrDispatchObservation,
  readUploadSecuritySubject,
  readUploadSecurityExecution,
  readUploadSecurityInspection,
  readUploadSecuritySettlement,
  matchesUploadSecurityExecution,
} from 'librechat-data-provider';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { UploadSecurityPort } from '../contract';
import { createPinnedServiceEndpoint } from '../intake/endpoint';

const JSON_LIMIT = 8192;
// Keep JSON/header input at8KiB. Mandatory AV original+approval+retirement and PDF
// scopes are bounded together: the maximal representative envelope is under24KiB.
// Base64 request context grows only to8KiB; actual raw-header admission stays8KiB.
const RESPONSE_JSON_LIMIT = 24 * 1024;
const CONTEXT_LIMIT = 8192;
const DEADLINE_MS = 60_000;
const failure = () => new Error('security_uninspectable');

export type UploadSecurityClientPeer = {
  certificateSha256: string;
  role: 'intake' | 'application';
};

/** Startup authority is detached plain data; neither getters nor later edits can grant a role. */
function configuration(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value))
  )
    throw failure();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !keys.includes(key) || !descriptor || !('value' in descriptor))
      throw failure();
    copy[key] = descriptor.value;
  }
  return copy;
}
function clientPeers(value: unknown): ReadonlyMap<string, UploadSecurityClientPeer['role']> {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > 64
  )
    throw failure();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1) throw failure();
  const peers = new Map<string, UploadSecurityClientPeer['role']>();
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !('value' in descriptor)) throw failure();
    const peer = configuration(descriptor.value, ['certificateSha256', 'role']);
    if (
      typeof peer.certificateSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(peer.certificateSha256) ||
      peers.has(peer.certificateSha256) ||
      (peer.role !== 'intake' && peer.role !== 'application')
    )
      throw failure();
    peers.set(peer.certificateSha256, peer.role);
  }
  return peers;
}

/** These envelopes come from JSON; domain values use the shared descriptor-based readers. */
function closed(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    throw failure();
  return value as Record<string, unknown>;
}
function json(bytes: Buffer): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
function encode(value: unknown, maximum = JSON_LIMIT): Buffer {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > maximum) throw failure();
  return bytes;
}
function header(message: IncomingMessage, name: string): string | undefined {
  const count = message.rawHeaders.filter(
    (_value, index) => index % 2 === 0 && message.rawHeaders[index].toLowerCase() === name,
  ).length;
  const value = message.headers[name];
  if (count > 1 || Array.isArray(value)) throw failure();
  return value;
}
function profile(message: IncomingMessage, contentType: string) {
  if (
    message.rawHeaders.reduce((size, value) => size + Buffer.byteLength(value) + 2, 0) >
      JSON_LIMIT ||
    header(message, 'content-type') !== contentType ||
    header(message, 'content-encoding') !== undefined
  )
    throw failure();
}
function readJson(
  message: IncomingMessage,
  signal: AbortSignal,
  maximum = JSON_LIMIT,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const finish = (error?: Error) => {
      message.off('data', data);
      message.off('end', end);
      message.off('error', failed);
      message.off('aborted', failed);
      signal.removeEventListener('abort', failed);
      if (error) {
        message.pause();
        reject(failure());
      } else {
        try {
          resolve(json(Buffer.concat(chunks)));
        } catch {
          reject(failure());
        }
      }
    };
    const failed = () => finish(failure());
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximum) finish(failure());
      else chunks.push(chunk);
    };
    const end = () => finish();
    message.on('data', data);
    message.once('end', end);
    message.once('error', failed);
    message.once('aborted', failed);
    signal.addEventListener('abort', failed, { once: true });
    if (signal.aborted) failed();
  });
}
function deadline(parent?: AbortSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort(failure());
  const timer = setTimeout(abort, DEADLINE_MS);
  timer.unref();
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  return {
    signal: controller.signal,
    abort,
    close: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}
async function bounded<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(failure());
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    signal.throwIfAborted();
    return await Promise.race([operation(), stopped]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
function boundSubject(value: unknown, attemptId: unknown) {
  const subject = readUploadSecuritySubject(value);
  if (!subject || attemptId !== `${subject.operationId}.${subject.transferGeneration}`)
    throw failure();
  return subject;
}

export function createHttpUploadSecurityPort(options: {
  endpoint: string;
  allowedHosts: readonly string[];
  policySha256: string;
  tls: { ca: string | Buffer; cert: string | Buffer; key: string | Buffer };
}): UploadSecurityPort {
  let endpoint: ReturnType<typeof createPinnedServiceEndpoint>;
  try {
    endpoint = createPinnedServiceEndpoint(options);
    if (!/^[a-f0-9]{64}$/.test(options.policySha256)) throw failure();
    for (const value of [options.tls.ca, options.tls.cert, options.tls.key])
      if (!(typeof value === 'string' || Buffer.isBuffer(value)) || value.length === 0)
        throw failure();
  } catch {
    throw failure();
  }
  let observed: import('librechat-data-provider').UploadOcrDispatchObservation | null = null;
  const tls = {
    ca: Buffer.from(options.tls.ca),
    cert: Buffer.from(options.tls.cert),
    key: Buffer.from(options.tls.key),
  };
  async function call(
    route: string,
    method: string,
    signal: AbortSignal,
    payload: Buffer | AsyncIterable<Uint8Array>,
    headers: Record<string, string>,
    expectedBytes: number,
  ): Promise<unknown> {
    const clock = deadline(signal);
    let req: ReturnType<typeof request>;
    try {
      req = request(new URL(route, endpoint.url), {
        method,
        ...tls,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        agent: false,
        lookup: endpoint.lookup,
        maxHeaderSize: JSON_LIMIT,
        signal: clock.signal,
        headers: { ...headers, 'content-length': String(expectedBytes) },
      });
    } catch {
      clock.close();
      throw failure();
    }
    const response = new Promise<unknown>((resolve, reject) => {
      req.once('error', () => reject(failure()));
      req.once('response', (res) => {
        void (async () => {
          try {
            profile(res, 'application/json');
            const envelope = closed(await readJson(res, clock.signal, RESPONSE_JSON_LIMIT), [
              'version',
              'payload',
              'dispatch',
            ]);
            if (envelope.version !== 2) throw failure();
            const dispatch =
              envelope.dispatch === null
                ? null
                : readUploadOcrDispatchObservation(envelope.dispatch);
            if (envelope.dispatch !== null && !dispatch) throw failure();
            observed = dispatch;
            if (res.statusCode !== 200) throw failure();
            resolve(envelope.payload);
          } catch {
            reject(failure());
          } finally {
            res.destroy();
          }
        })();
      });
    });
    // Observe failures even while awaiting TLS or a producer that has not returned yet.
    void response.catch(() => undefined);
    try {
      return await bounded(async () => {
        await new Promise<void>((resolve, reject) => {
          req.once('error', () => reject(failure()));
          req.once('socket', (socket) => {
            if (!(socket instanceof TLSSocket)) {
              reject(failure());
              return;
            }
            socket.once('secureConnect', () => (socket.authorized ? resolve() : reject(failure())));
          });
        });
        clock.signal.throwIfAborted();
        if (Buffer.isBuffer(payload)) {
          if (payload.length !== expectedBytes) throw failure();
          req.end(payload);
        } else {
          let bytes = 0;
          for await (const chunk of payload) {
            clock.signal.throwIfAborted();
            if (!(chunk instanceof Uint8Array)) throw failure();
            bytes += chunk.byteLength;
            if (bytes > expectedBytes) throw failure();
            if (!req.write(chunk)) await once(req, 'drain', { signal: clock.signal });
          }
          if (bytes !== expectedBytes) throw failure();
          req.end();
        }
        return await response;
      }, clock.signal);
    } catch {
      throw failure();
    } finally {
      clock.close();
      req.destroy();
    }
  }
  return {
    dispatchObservation: () => readUploadOcrDispatchObservation(observed),
    policySha256: options.policySha256,
    async prepare(input) {
      try {
        const subject = boundSubject(input.subject, input.attemptId);
        const payload = encode({ attemptId: input.attemptId, subject });
        const result = closed(
          await call(
            '/v1/prepare',
            'POST',
            input.signal,
            payload,
            { 'content-type': 'application/json' },
            payload.length,
          ),
          ['version', 'execution'],
        );
        const execution = readUploadSecurityExecution(result.execution);
        if (result.version !== 1 || !execution || execution.attemptId !== input.attemptId)
          throw failure();
        return execution;
      } catch {
        throw failure();
      }
    },
    async inspect(input) {
      try {
        const execution = readUploadSecurityExecution(input.execution);
        if (!execution) throw failure();
        const subject = boundSubject(input.subject, execution.attemptId);
        const context = encode({ execution, subject }).toString('base64');
        if (context.length > CONTEXT_LIMIT) throw failure();
        const result = closed(
          await call(
            '/v1/inspect',
            'PUT',
            input.signal,
            input.body,
            { 'content-type': 'application/octet-stream', 'x-upload-security-context': context },
            subject.bytes,
          ),
          ['version', 'execution', 'inspection'],
        );
        const inspection = readUploadSecurityInspection(result.inspection);
        if (
          result.version !== 1 ||
          !matchesUploadSecurityExecution(result.execution, execution) ||
          !inspection ||
          !matchesUploadSecurityExecution(inspection.settlement.execution, execution)
        )
          throw failure();
        return inspection;
      } catch {
        throw failure();
      }
    },
    async cancel(input) {
      try {
        const execution = readUploadSecurityExecution(input.execution);
        if (!execution) throw failure();
        const payload = encode({ execution });
        const result = closed(
          await call(
            '/v1/cancel',
            'POST',
            input.signal,
            payload,
            { 'content-type': 'application/json' },
            payload.length,
          ),
          ['version', 'execution', 'settlement'],
        );
        const settlement = readUploadSecuritySettlement(result.settlement);
        if (
          result.version !== 1 ||
          !matchesUploadSecurityExecution(result.execution, execution) ||
          !settlement ||
          !matchesUploadSecurityExecution(settlement.execution, execution)
        )
          throw failure();
        return settlement;
      } catch {
        throw failure();
      }
    },
  };
}

function reply(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed || res.writableEnded) return;
  const payload = encode(value, RESPONSE_JSON_LIMIT);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': payload.length,
    connection: 'close',
  });
  res.end(payload);
}

/** Composition must also configure HTTPS requestCert and rejectUnauthorized. */
export function createSecurityRequestHandler(
  worker: UploadSecurityPort,
  options: { peers: readonly UploadSecurityClientPeer[]; track?: (work: Promise<void>) => void },
): RequestListener {
  const config = configuration(options, ['peers', 'track']);
  const peers = clientPeers(config.peers);
  if (config.track !== undefined && typeof config.track !== 'function') throw failure();
  const track = config.track as ((work: Promise<void>) => void) | undefined;
  return (req, res) => {
    try {
      if (!(req.socket instanceof TLSSocket) || req.socket.authorized !== true) throw failure();
      const der = req.socket.getPeerCertificate().raw;
      if (!Buffer.isBuffer(der) || !der.length) throw failure();
      const role = peers.get(createHash('sha256').update(der).digest('hex'));
      const shared =
        (req.url === '/healthz' && req.method === 'GET') ||
        (req.url === '/v1/cancel' && req.method === 'POST');
      const intake =
        (req.url === '/v1/prepare' && req.method === 'POST') ||
        (req.url === '/v1/inspect' && req.method === 'PUT');
      if (
        !role ||
        (!shared && !(role === 'intake' && intake)) ||
        header(req, 'authorization') !== undefined ||
        header(req, 'cookie') !== undefined ||
        header(req, 'expect') !== undefined
      )
        throw failure();
    } catch {
      req.pause();
      reply(res, 403, { code: 'security_uninspectable' });
      return;
    }
    const respond = (status: number, payload: unknown) =>
      reply(res, status, {
        version: 2,
        payload,
        dispatch: readUploadOcrDispatchObservation(worker.dispatchObservation?.()),
      });
    const clock = deadline();
    const disconnect = () => {
      if (!res.writableEnded) clock.abort();
    };
    req.once('aborted', clock.abort);
    res.once('close', disconnect);
    void bounded(() => {
      const work = (async () => {
        if (req.url === '/healthz' && req.method === 'GET') {
          respond(200, { version: 1 });
          return;
        }
        if (req.url === '/v1/inspect' && req.method === 'PUT') {
          profile(req, 'application/octet-stream');
          const context = header(req, 'x-upload-security-context');
          if (
            !context ||
            context.length > CONTEXT_LIMIT ||
            Buffer.from(context, 'base64').toString('base64') !== context
          )
            throw failure();
          const record = closed(json(Buffer.from(context, 'base64')), ['execution', 'subject']);
          const execution = readUploadSecurityExecution(record.execution);
          if (!execution) throw failure();
          const subject = boundSubject(record.subject, execution.attemptId);
          if (
            header(req, 'content-length') !== String(subject.bytes) ||
            header(req, 'transfer-encoding') !== undefined
          )
            throw failure();
          let complete = false;
          const body = (async function* () {
            let bytes = 0;
            for await (const chunk of req) {
              clock.signal.throwIfAborted();
              bytes += chunk.length;
              if (bytes > subject.bytes) throw failure();
              yield chunk as Buffer;
            }
            if (bytes !== subject.bytes) throw failure();
            complete = true;
          })();
          const inspection = readUploadSecurityInspection(
            await worker.inspect({ execution, subject, body, signal: clock.signal }),
          );
          if (
            !inspection ||
            !matchesUploadSecurityExecution(inspection.settlement.execution, execution) ||
            (inspection.decision.decision === 'approved' && !complete)
          )
            throw failure();
          respond(200, { version: 1, execution, inspection });
          return;
        }
        if (req.method !== 'POST' || (req.url !== '/v1/prepare' && req.url !== '/v1/cancel'))
          throw failure();
        profile(req, 'application/json');
        const value = await readJson(req, clock.signal);
        if (req.url === '/v1/prepare') {
          const record = closed(value, ['attemptId', 'subject']);
          const subject = boundSubject(record.subject, record.attemptId);
          const execution = readUploadSecurityExecution(
            await worker.prepare({
              attemptId: record.attemptId as string,
              subject,
              signal: clock.signal,
            }),
          );
          if (!execution || execution.attemptId !== record.attemptId) throw failure();
          respond(200, { version: 1, execution });
        } else {
          const record = closed(value, ['execution']);
          const execution = readUploadSecurityExecution(record.execution);
          if (!execution) throw failure();
          const settlement = readUploadSecuritySettlement(
            await worker.cancel({ execution, signal: clock.signal }),
          );
          if (!settlement || !matchesUploadSecurityExecution(settlement.execution, execution))
            throw failure();
          respond(200, { version: 1, execution, settlement });
        }
      })();
      // Track the actual handler, not the deadline race or HTTP response lifetime.
      track?.(work);
      return work;
    }, clock.signal)
      .catch(() => respond(400, { code: 'security_uninspectable' }))
      .finally(() => {
        clock.close();
        req.off('aborted', clock.abort);
        res.off('close', disconnect);
      });
  };
}
