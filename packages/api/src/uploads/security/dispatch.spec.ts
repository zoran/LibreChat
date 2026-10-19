/** Inert HTTP/TLS transport; actual OCR caller, shared reader and App registry. */
jest.mock('node:https', () => ({ request: jest.fn() }));
jest.mock('node:tls', () => {
  const { EventEmitter: MockEventEmitter } =
    jest.requireActual<typeof import('node:events')>('node:events');
  return {
    TLSSocket: class extends MockEventEmitter {
      authorized = true;
      getPeerCertificate() {
        return { raw: Buffer.from('synthetic-peer') };
      }
    },
  };
});
jest.mock('@napi-rs/canvas', () => ({ createCanvas: jest.fn(), ImageData: jest.fn() }));
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createHttpUploadSecurityPort, createSecurityRequestHandler } from './transport';
import { createHash } from 'node:crypto';
import { request } from 'node:https';
type InertTlsSocket = EventEmitter & {
  authorized: boolean;
  getPeerCertificate(): { raw: Buffer };
};
const { TLSSocket: MockTLSSocket } = jest.requireMock<{
  TLSSocket: new () => InertTlsSocket;
}>('node:tls');
import { Registry } from 'prom-client';
import {
  createUploadOcrDispatchCounts,
  readUploadOcrDispatchObservation,
} from 'librechat-data-provider';
import { createSecurityPdfOcrProvider } from './pdf-ocr';
import { createUploadMetrics } from '../metrics/metrics';

const instanceId = '11111111-1111-4111-8111-111111111111';
const snapshot = () => ({
  version: 1 as const,
  source: { instanceId, pid: 123, startedAt: Date.now() - 1000 },
  observedAt: Date.now(),
  counts: createUploadOcrDispatchCounts(),
});
function provider() {
  return createSecurityPdfOcrProvider({
    endpoint: 'https://ocr.invalid',
    allowedHosts: ['ocr.invalid'],
    certificateSha256: createHash('sha256').update('synthetic-peer').digest('hex'),
    apiKey: 'synthetic',
    tls: { ca: 'synthetic', cert: 'synthetic', key: 'synthetic' },
    binding: {
      podUid: instanceId,
      containerId: 'a'.repeat(64),
      runtimeImage: 'r/x@sha256:' + 'b'.repeat(64),
      sourceManifestSha256: 'c'.repeat(64),
      modelRevision: 'aaa02f3811945a91062062994c5c4a3f4c0af2b0',
      profileSha256: 'd'.repeat(64),
    },
  });
}
const prepared = (signal = new AbortController().signal, milliseconds = 1000) => ({
  execution: {
    version: 2 as const,
    attemptId: 'document.1',
    instanceId,
    executionId: '22222222-2222-4222-8222-222222222222',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    custody: { kind: 'none' as const },
  },
  subject: {
    tenantId: 'private',
    userId: 'private',
    operationId: 'document',
    transferGeneration: 1,
    mediaType: 'application/pdf',
    bytes: 10,
    sha256: 'e'.repeat(64),
  },
  workDeadline: (Date.now() + milliseconds) / 1000,
  cleanupDeadline: (Date.now() + milliseconds + 1000) / 1000,
  signal,
});
function transport(mode: number | string) {
  (request as jest.Mock).mockImplementation(() => {
    const req = new EventEmitter() as EventEmitter & {
      end: () => void;
      destroy: (error?: Error) => void;
    };
    let closed = false;
    req.destroy = (error) => {
      if (closed) return;
      closed = true;
      queueMicrotask(() => {
        if (error) req.emit('error', error);
        req.emit('close');
      });
    };
    req.end = () => {
      if (mode === 'hang') return;
      const res = Object.assign(new EventEmitter(), {
        statusCode: mode as number,
        headers: { 'content-type': 'application/json' },
        complete: true,
        destroy() {
          queueMicrotask(() => res.emit('close'));
        },
      });
      req.emit('response', res);
      queueMicrotask(() => {
        res.emit('data', Buffer.from('{}'));
        res.emit('end');
        res.emit('close');
      });
    };
    queueMicrotask(() => {
      if (mode === 'connection' || mode === 'tls') {
        req.emit(
          'error',
          Object.assign(new Error('synthetic'), {
            code: mode === 'tls' ? 'ERR_TLS_CERT_ALTNAME_INVALID' : 'ECONNREFUSED',
          }),
        );
        return;
      }
      const socket = new MockTLSSocket();
      req.emit('socket', socket);
      queueMicrotask(() => socket.emit('secureConnect'));
    });
    return req;
  });
}

describe('real OCR dispatch lifecycle', () => {
  beforeEach(() => jest.clearAllMocks());
  it.each([200, 302, 401, 409, 429, 500, 503])(
    'counts HTTP %s before semantic rejection, once',
    async (status) => {
      transport(status);
      const owner = provider();
      await expect(owner.prepare(prepared())).rejects.toThrow(); // deliberately invalid inert provider payload
      const counts = owner.dispatchCounts!()!;
      expect(counts.prepare.started).toBe(1);
      expect(counts.prepare[('http_' + Math.floor(status / 100) + 'xx') as 'http_2xx']).toBe(1);
      expect(
        counts.prepare.completed + counts.prepare.error + counts.prepare.connection_error,
      ).toBe(1);
    },
  );
  it.each([
    ['connection', 'connection_error'],
    ['tls', 'tls_error'],
  ])('counts %s even without HTTP response', async (mode, outcome) => {
    transport(mode);
    const owner = provider();
    await expect(owner.prepare(prepared())).rejects.toThrow();
    expect(owner.dispatchCounts!()!.prepare.started).toBe(1);
    expect(owner.dispatchCounts!()!.prepare[outcome as 'tls_error']).toBe(1);
  });
  it('counts timeout and abort only after the original request closes', async () => {
    transport('hang');
    const one = provider();
    await expect(one.prepare(prepared(undefined, 20))).rejects.toThrow();
    expect(one.dispatchCounts!()!.prepare.timeout).toBe(1);
    const controller = new AbortController();
    const two = provider();
    const pending = two.prepare(prepared(controller.signal));
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toThrow();
    expect(two.dispatchCounts!()!.prepare.aborted).toBe(1);
  });
  it('does not invent a dispatch for input rejected before the request owner', async () => {
    transport(200);
    const owner = provider();
    const controller = new AbortController();
    controller.abort();
    await expect(owner.prepare(prepared(controller.signal))).rejects.toThrow();
    expect(owner.dispatchCounts!()!.prepare.started).toBe(0);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('one private process snapshot and existing registry', () => {
  it('rejects missing rows, unknown fields, getters and impossible terminal counts', () => {
    for (const change of [
      (value: ReturnType<typeof snapshot>) => Reflect.deleteProperty(value.counts.page, 'timeout'),
      (value: ReturnType<typeof snapshot>) => {
        Object.assign(value.counts.page, { user: 0 });
      },
      (value: ReturnType<typeof snapshot>) => {
        value.counts.page.completed = 1;
      },
      (value: ReturnType<typeof snapshot>) =>
        Object.defineProperty(value, 'observedAt', {
          get() {
            throw new Error('must not invoke');
          },
          enumerable: true,
        }),
    ]) {
      const value = snapshot();
      change(value);
      expect(readUploadOcrDispatchObservation(value)).toBeNull();
    }
  });
  it('emits no zero before a source, mirrors once, and keeps identity out of labels', async () => {
    const registry = new Registry();
    const metrics = createUploadMetrics(registry, ['cpu-2']).bind('cpu-2');
    expect(await registry.metrics()).not.toContain('cortex_upload_ocr_dispatch_total{');
    const value = snapshot();
    value.counts.prepare.started = 2;
    value.counts.prepare.connection_error = 2;
    metrics.observeSecurityDispatch(value);
    metrics.observeSecurityDispatch(value);
    const output = await registry.metrics();
    expect(output).toContain(
      'cortex_upload_ocr_dispatch_total{slot="cpu-2",stage="prepare",outcome="started"} 2',
    );
    expect(output).toContain(
      'cortex_upload_ocr_dispatch_total{slot="cpu-2",stage="page",outcome="started"} 0',
    );
    expect(output).not.toContain(instanceId);
    expect(output).not.toContain('document.1');
    value.counts.prepare.started = 0;
    value.counts.prepare.connection_error = 0;
    expect(() => metrics.observeSecurityDispatch(value)).toThrow();
  });
  it('uses direct application cancellation observations without a new timer or request', async () => {
    const registry = new Registry();
    const value = snapshot();
    value.counts.cancel.started = 1;
    value.counts.cancel.aborted = 1;
    createUploadMetrics(registry, ['cpu-2'], { slot: 'cpu-2', snapshot: () => value }).bind(
      'cpu-2',
    );
    expect(await registry.metrics()).toContain('stage="cancel",outcome="aborted"} 1');
  });
  it('stale source disappears rather than becoming a fresh zero', async () => {
    const registry = new Registry();
    const metrics = createUploadMetrics(registry, ['cpu-2']).bind('cpu-2');
    const value = snapshot();
    metrics.observeSecurityDispatch(value);
    jest.spyOn(Date, 'now').mockReturnValue(value.observedAt + 120001);
    expect(await registry.metrics()).not.toContain('cortex_upload_ocr_dispatch_total{');
  });
});

describe('actual security service/result consumer without sockets', () => {
  it.each([false, true])(
    'carries source counts through HTTP success/error (%s)',
    async (failed) => {
      const value = snapshot();
      value.counts.prepare.started = 1;
      value.counts.prepare[failed ? 'connection_error' : 'completed'] = 1;
      const execution = prepared().execution;
      const handler = createSecurityRequestHandler(
        {
          policySha256: 'a'.repeat(64),
          dispatchObservation: () => value,
          prepare: async () => {
            if (failed) throw new Error('provider unavailable');
            return execution;
          },
          inspect: jest.fn(),
          cancel: jest.fn(),
        },
        {
          peers: [
            {
              certificateSha256: createHash('sha256').update('synthetic-peer').digest('hex'),
              role: 'intake',
            },
          ],
        },
      );
      (request as jest.Mock).mockImplementation((url, options) => {
        const outgoing = Object.assign(new EventEmitter(), {
          destroy() {},
          end(payload: Buffer) {
            const incoming = Object.assign(Readable.from([payload]), {
              socket: new MockTLSSocket(),
              method: options.method,
              url: url.pathname,
              headers: options.headers,
              rawHeaders: Object.entries(options.headers).flat(),
            });
            let statusCode = 0;
            let headers: Record<string, string | number | string[]> = {};
            const reply = Object.assign(new EventEmitter(), {
              destroyed: false,
              writableEnded: false,
              writeHead(status: number, next: Record<string, string | number | string[]>) {
                statusCode = status;
                headers = next;
              },
              end(bytes: Buffer) {
                reply.writableEnded = true;
                const response = Object.assign(Readable.from([bytes]), {
                  statusCode,
                  headers,
                  rawHeaders: Object.entries(headers).flat().map(String),
                });
                outgoing.emit('response', response);
              },
            });
            // The real handler consumes these deliberately partial, inert HTTP frames.
            Reflect.apply(handler, undefined, [incoming, reply]);
          },
        });
        queueMicrotask(() => {
          const socket = new MockTLSSocket();
          outgoing.emit('socket', socket);
          queueMicrotask(() => socket.emit('secureConnect'));
        });
        return outgoing;
      });
      const client = createHttpUploadSecurityPort({
        endpoint: 'https://scanner.invalid',
        allowedHosts: ['scanner.invalid'],
        policySha256: 'a'.repeat(64),
        tls: { ca: 'synthetic', cert: 'synthetic', key: 'synthetic' },
      });
      const input = {
        attemptId: execution.attemptId,
        subject: prepared().subject,
        signal: new AbortController().signal,
      };
      if (failed) await expect(client.prepare(input)).rejects.toThrow('security_uninspectable');
      else await expect(client.prepare(input)).resolves.toEqual(execution);
      expect(client.dispatchObservation!()).toEqual(value);
    },
  );
});
