/** Inert HTTPS frames through the actual current handler and client; no sockets. */
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
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { request } from 'node:https';
type InertTlsSocket = EventEmitter & {
  authorized: boolean;
  getPeerCertificate(): { raw: Buffer };
};
const { TLSSocket: MockTLSSocket } = jest.requireMock<{
  TLSSocket: new () => InertTlsSocket;
}>('node:tls');
import {
  readUploadSecurityExecution,
  readUploadSecurityInspection,
  readUploadOcrDispatchObservation,
  UPLOAD_OCR_DISPATCH_STAGES,
} from 'librechat-data-provider';
import { createHttpUploadSecurityPort, createSecurityRequestHandler } from './transport';

const fixtureBytes = readFileSync(join(__dirname, 'fixtures/response-budget.json'));
const fixture = () => JSON.parse(fixtureBytes.toString());
const RESPONSE_LIMIT = 12 * 1024;
function connect(
  value = fixture(),
  options: { responseBytes?: number; invalidRequest?: string } = {},
) {
  const observed = { responseBytes: 0, headers: 0 };
  const core = {
    policySha256: 'a'.repeat(64),
    dispatchObservation: () => value.dispatch,
    prepare: jest.fn(async () => value.execution),
    cancel: jest.fn(async () => value.inspection.settlement),
    inspect: jest.fn(async ({ body }: { body: AsyncIterable<Uint8Array> }) => {
      for await (const _chunk of body) {
        /* consume exact body */
      }
      return value.inspection;
    }),
  };
  const handler = createSecurityRequestHandler(core, {
    peers: [
      {
        certificateSha256: createHash('sha256').update('synthetic-peer').digest('hex'),
        role: 'intake',
      },
    ],
  });
  (request as jest.Mock).mockImplementation((url, input) => {
    observed.headers = input.maxHeaderSize;
    const chunks: Buffer[] = [];
    const outgoing = Object.assign(new EventEmitter(), {
      destroy() {},
      write(bytes: Buffer) {
        chunks.push(Buffer.from(bytes));
        return true;
      },
      end(bytes?: Buffer) {
        if (bytes) chunks.push(Buffer.from(bytes));
        let payload = Buffer.concat(chunks);
        const headers = { ...input.headers };
        if (options.invalidRequest === 'context')
          headers['x-upload-security-context'] = 'A'.repeat(4097);
        if (options.invalidRequest === 'headers') headers['x-too-long'] = 'a'.repeat(8193);
        if (options.invalidRequest === 'json')
          payload = Buffer.concat([payload, Buffer.alloc(8193 - payload.length, ' ')]);
        const incoming = Object.assign(Readable.from([payload]), {
          socket: new MockTLSSocket(),
          method: input.method,
          url: url.pathname,
          headers,
          rawHeaders: Object.entries(headers).flat().map(String),
        });
        let statusCode = 0;
        let responseHeaders: Record<string, string | number | string[]> = {};
        const reply = Object.assign(new EventEmitter(), {
          destroyed: false,
          writableEnded: false,
          writeHead(status: number, next: Record<string, string | number | string[]>) {
            statusCode = status;
            responseHeaders = next;
          },
          end(response: Buffer) {
            reply.writableEnded = true;
            observed.responseBytes = response.length;
            const body = options.responseBytes
              ? Buffer.concat([
                  response,
                  Buffer.alloc(options.responseBytes - response.length, ' '),
                ])
              : response;
            const source = Object.assign(Readable.from([body]), {
              statusCode,
              headers: responseHeaders,
              rawHeaders: Object.entries(responseHeaders).flat().map(String),
            });
            outgoing.emit('response', source);
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
  const input = () => ({
    execution: value.execution,
    subject: value.subject,
    body: (async function* () {
      yield Buffer.alloc(value.subject.bytes);
    })(),
    signal: new AbortController().signal,
  });
  return { client, input, core, observed };
}

describe('complete v2 response budget with unchanged request boundaries', () => {
  it('keeps the exact independently reviewed contract-valid fixture', () => {
    expect(createHash('sha256').update(fixtureBytes).digest('hex')).toBe(
      '2e9f4de69c0be2fda99af3d18f011b9f7d00f2ff8110530eded2faece5abdabc',
    );
    const value = fixture();
    expect(readUploadSecurityExecution(value.execution)).not.toBeNull();
    expect(readUploadSecurityInspection(value.inspection)).not.toBeNull();
    expect(readUploadOcrDispatchObservation(value.dispatch)).not.toBeNull();
    expect(Buffer.byteLength(JSON.stringify(value.payload))).toBe(7637);
    expect(
      Buffer.byteLength(
        JSON.stringify({ version: 2, payload: value.payload, dispatch: value.dispatch }),
      ),
    ).toBe(8650);
    expect(
      Buffer.from(JSON.stringify({ execution: value.execution, subject: value.subject })).toString(
        'base64',
      ).length,
    ).toBe(3804);
  });
  it('returns the valid PDF inspection with its complete non-null dispatch', async () => {
    const value = fixture();
    const { client, input, core, observed } = connect(value);
    await expect(client.inspect(input())).resolves.toEqual(value.inspection);
    expect(core.inspect).toHaveBeenCalledTimes(1);
    expect(client.dispatchObservation!()).toEqual(value.dispatch);
    expect(observed.responseBytes).toBe(8650);
    expect(observed.headers).toBe(8192);
  });
  it('budgets the fixed counter table at maximum safe integer widths', async () => {
    const value = fixture();
    value.dispatch.source.pid = Number.MAX_SAFE_INTEGER;
    value.dispatch.source.startedAt = Number.MAX_VALUE;
    value.dispatch.observedAt = Number.MAX_VALUE;
    for (const stage of UPLOAD_OCR_DISPATCH_STAGES) {
      const row = value.dispatch.counts[stage];
      row.started = Number.MAX_SAFE_INTEGER;
      for (const name of ['http_1xx', 'http_2xx', 'http_3xx', 'http_4xx', 'http_5xx'])
        row[name] = Math.floor(Number.MAX_SAFE_INTEGER / 5);
      for (const name of [
        'completed',
        'timeout',
        'aborted',
        'tls_error',
        'connection_error',
        'error',
      ])
        row[name] = Math.floor(Number.MAX_SAFE_INTEGER / 6);
    }
    expect(readUploadOcrDispatchObservation(value.dispatch)).not.toBeNull();
    expect(
      Buffer.byteLength(JSON.stringify({ version: 2, payload: null, dispatch: value.dispatch })),
    ).toBeLessThan(4096);
    const { client, input } = connect(value);
    await expect(client.inspect(input())).resolves.toEqual(value.inspection);
    expect(client.dispatchObservation!()).toEqual(value.dispatch);
  });
  it.each([RESPONSE_LIMIT, RESPONSE_LIMIT + 1])(
    'bounds actual response bytes at %s',
    async (size) => {
      const value = fixture();
      const { client, input } = connect(value, { responseBytes: size });
      if (size === RESPONSE_LIMIT)
        await expect(client.inspect(input())).resolves.toEqual(value.inspection);
      else await expect(client.inspect(input())).rejects.toThrow('security_uninspectable');
    },
  );
  it.each(['context', 'headers', 'json'])(
    'keeps original %s request limit',
    async (invalidRequest) => {
      const { client, input, core } = connect(fixture(), { invalidRequest });
      const pending =
        invalidRequest === 'json'
          ? client.prepare({
              attemptId: fixture().execution.attemptId,
              subject: fixture().subject,
              signal: new AbortController().signal,
            })
          : client.inspect(input());
      await expect(pending).rejects.toThrow('security_uninspectable');
      expect(core.inspect).not.toHaveBeenCalled();
      expect(core.prepare).not.toHaveBeenCalled();
    },
  );
});
