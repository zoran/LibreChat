import { join } from 'node:path';
import { promises as dns } from 'node:dns';
import { readFileSync, existsSync } from 'node:fs';
import { createServer, request } from 'node:https';
import { createHash, X509Certificate } from 'node:crypto';
import type { LookupAddress, LookupAllOptions } from 'node:dns';
import type { RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { UploadSecurityPort } from '../contract';
import { createHttpUploadSecurityPort, createSecurityRequestHandler } from './transport';
import { createSecurityTlsFixture } from './tls-fixture.helper';

const policySha256 = 'a'.repeat(64);
const subject = {
  tenantId: 'tenant',
  userId: 'user',
  operationId: 'operation',
  transferGeneration: 1,
  mediaType: 'text/plain',
  bytes: 5,
  sha256: createHash('sha256').update('hello').digest('hex'),
};
const execution = {
  version: 2 as const,
  custody: { kind: 'none' as const },
  attemptId: 'operation.1',
  instanceId: '11111111-1111-4111-8111-111111111111',
  executionId: '22222222-2222-4222-8222-222222222222',
  expiresAt: '2099-01-01T00:00:00.000Z',
};
const signal = () => new AbortController().signal;
// Select the exact native overload called by the helper; only the DNS boundary is controlled.
const dnsAll: {
  lookup(hostname: string, options: LookupAllOptions): Promise<LookupAddress[]>;
} = dns;
const resolveAll = () => jest.spyOn(dnsAll, 'lookup');
const body = async function* () {
  yield Buffer.from('hello');
};
const inspection = () => ({
  decision: {
    version: 1 as const,
    decision: 'approved' as const,
    subject: { ...subject },
    policySha256,
    scannerVersion: 'test/1',
    checkedAt: '2026-10-17T00:00:00.000Z',
    coverage: { complete: true as const, pages: 1, parts: 1 },
  },
  settlement: { execution, writerStopped: true as const, transientDataRemoved: true as const },
});
const settlement = () => ({
  execution: { ...execution },
  writerStopped: true,
  transientDataRemoved: true,
});
// Only the scanner boundary is fake; TLS and streamed bytes use the real local transport.
function worker() {
  return {
    policySha256,
    prepare: jest.fn(async () => ({ ...execution })),
    inspect: jest.fn(async (input: Parameters<UploadSecurityPort['inspect']>[0]) => {
      const chunks: Buffer[] = [];
      for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe('hello');
      return inspection();
    }),
    cancel: jest.fn(async () => settlement()),
  };
}
describe('bounded authenticated scanner transport', () => {
  let ca: Buffer, cert: Buffer, key: Buffer;
  let certificateDirectory: string;
  let fixture: ReturnType<typeof createSecurityTlsFixture> | undefined;
  let ownsFixture = false;
  const servers: ReturnType<typeof createServer>[] = [];
  const pem = (name: string) => readFileSync(join(certificateDirectory, name));
  beforeAll(() => {
    ownsFixture = !process.env.SCANNER_TLS_TEST_CERTS;
    fixture = createSecurityTlsFixture();
    certificateDirectory = fixture.directory;
    ca = pem('ca.pem');
    cert = pem('client.pem');
    key = pem('client.key');
  });
  afterAll(() => {
    fixture?.close();
    if (fixture && ownsFixture && existsSync(fixture.directory))
      throw new Error('Owned TLS fixture survived cleanup');
  });
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.closeAllConnections();
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
    jest.restoreAllMocks();
  });
  async function serve(
    handler: RequestListener,
    certificate = 'server',
    rejectUnauthorized = true,
  ) {
    const server = createServer(
      {
        ca,
        cert: pem(`${certificate}.pem`),
        key: pem(`${certificate}.key`),
        requestCert: true,
        rejectUnauthorized,
      },
      handler,
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const client = (endpoint: string, tls = { ca, cert, key }) =>
    createHttpUploadSecurityPort({ endpoint, allowedHosts: ['127.0.0.1'], policySha256, tls });
  const peers = (role: 'intake' | 'application' = 'intake') => [
    {
      certificateSha256: createHash('sha256').update(new X509Certificate(cert).raw).digest('hex'),
      role,
    },
  ];
  it('tracks the actual handler after disconnect until an abort-ignoring scanner call settles', async () => {
    const scanner = worker();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const remaining = new Promise<void>((resolve) => {
      release = resolve;
    });
    scanner.inspect.mockImplementation(async (input) => {
      for await (const _chunk of input.body) {
        /* actual complete HTTP body */
      }
      entered();
      await remaining;
      return inspection();
    });
    const active = new Set<Promise<void>>();
    const endpoint = await serve(
      createSecurityRequestHandler(scanner, {
        peers: peers(),
        track(work) {
          active.add(work);
          void work.finally(() => active.delete(work)).catch(() => undefined);
        },
      }),
    );
    const controller = new AbortController();
    const result = client(endpoint).inspect({
      execution,
      subject,
      body: body(),
      signal: controller.signal,
    });
    const failed = result.catch((error: unknown) => error);
    try {
      await started;
      expect(active.size).toBe(1);
      controller.abort();
      expect(await failed).toBeInstanceOf(Error);
      expect(active.size).toBe(1);
    } finally {
      release();
      await Promise.allSettled([...active]);
    }
    expect(active.size).toBe(0);
  });
  async function raw(
    endpoint: string,
    route: string,
    payload: string,
    headers: Record<string, string | undefined> = {},
    authenticated = true,
    method = 'POST',
  ) {
    return new Promise<{ status: number; value: string }>((resolve, reject) => {
      const req = request(
        endpoint + route,
        {
          method,
          ca,
          ...(authenticated ? { cert, key } : {}),
          agent: false,
          headers: { 'content-type': 'application/json', ...headers },
        },
        async (res) => {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of res) chunks.push(chunk);
            resolve({ status: res.statusCode!, value: Buffer.concat(chunks).toString() });
          } catch (error) {
            reject(error);
          }
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }
  it('runs prepare, exact streamed inspect and independent cancel over mutual TLS', async () => {
    const core = worker();
    const port = client(await serve(createSecurityRequestHandler(core, { peers: peers() })));
    expect(await port.prepare({ attemptId: 'operation.1', subject, signal: signal() })).toEqual(
      execution,
    );
    expect(await port.inspect({ execution, subject, body: body(), signal: signal() })).toEqual(
      inspection(),
    );
    expect(await port.cancel({ execution, signal: signal() })).toEqual(settlement());
    expect(core.inspect).toHaveBeenCalledTimes(1);
  });
  it('allows the application role only health and exact cancellation, never preparation or inspection', async () => {
    const core = worker();
    const endpoint = await serve(
      createSecurityRequestHandler(core, { peers: peers('application') }),
    );
    expect((await raw(endpoint, '/healthz', '', {}, true, 'GET')).status).toBe(200);
    expect(await client(endpoint).cancel({ execution, signal: signal() })).toEqual(settlement());
    await expect(
      client(endpoint).prepare({ attemptId: 'operation.1', subject, signal: signal() }),
    ).rejects.toThrow('security_uninspectable');
    await expect(
      client(endpoint).inspect({ execution, subject, body: body(), signal: signal() }),
    ).rejects.toThrow('security_uninspectable');
    expect(core.prepare).not.toHaveBeenCalled();
    expect(core.inspect).not.toHaveBeenCalled();
    expect(core.cancel).toHaveBeenCalledTimes(1);
  });
  it('rejects a CA-authenticated but unpinned leaf even for health', async () => {
    const core = worker();
    const endpoint = await serve(
      createSecurityRequestHandler(core, {
        peers: [{ certificateSha256: 'f'.repeat(64), role: 'intake' }],
      }),
    );
    for (const [route, method] of [
      ['/healthz', 'GET'],
      ['/v1/cancel', 'POST'],
      ['/v1/prepare', 'POST'],
      ['/v1/inspect', 'PUT'],
    ])
      expect((await raw(endpoint, route, '{}', {}, true, method)).status).toBe(403);
    expect(core.prepare).not.toHaveBeenCalled();
    expect(core.inspect).not.toHaveBeenCalled();
    expect(core.cancel).not.toHaveBeenCalled();
  });
  it.each([{ authorization: 'Bearer forbidden' }, { cookie: 'session=forbidden' }])(
    'rejects browser authority before scanner work: %j',
    async (headers) => {
      const core = worker();
      const endpoint = await serve(createSecurityRequestHandler(core, { peers: peers() }));
      expect(
        (
          await raw(
            endpoint,
            '/v1/prepare',
            JSON.stringify({ attemptId: 'operation.1', subject }),
            headers,
          )
        ).status,
      ).toBe(403);
      expect(core.prepare).not.toHaveBeenCalled();
    },
  );
  it('copies exact role authority before later peer mutation', async () => {
    const core = worker();
    const configured = peers('application');
    const endpoint = await serve(createSecurityRequestHandler(core, { peers: configured }));
    configured[0].role = 'intake';
    configured[0].certificateSha256 = 'f'.repeat(64);
    configured.length = 0;
    expect((await raw(endpoint, '/healthz', '', {}, true, 'GET')).status).toBe(200);
    expect((await raw(endpoint, '/v1/prepare', '{}')).status).toBe(403);
    expect(core.prepare).not.toHaveBeenCalled();
  });
  it('rejects invalid peer configurations without invoking accessor properties', () => {
    const getter = jest.fn(() => 'intake');
    const peer = peers()[0];
    const accessor = Object.defineProperty({ certificateSha256: peer.certificateSha256 }, 'role', {
      get: getter,
    });
    const arrayAccessor = Object.defineProperty([], '0', { get: getter });
    const sparse = Array(1);
    for (const configured of [
      undefined,
      [],
      [peer, peer],
      Array(65).fill(peer),
      [null],
      [Object.create(peer)],
      [accessor],
      arrayAccessor,
      sparse,
      [{ ...peer, extra: true }],
      [{ ...peer, role: 'scanner' }],
      [{ ...peer, certificateSha256: 'not-a-pin' }],
      [{ ...peer, certificateSha256: peer.certificateSha256.toUpperCase() }],
    ])
      expect(() => createSecurityRequestHandler(worker(), { peers: configured } as never)).toThrow(
        'security_uninspectable',
      );
    expect(() => createSecurityRequestHandler(worker(), undefined as never)).toThrow(
      'security_uninspectable',
    );
    expect(getter).not.toHaveBeenCalled();
  });
  it('pins prepare, inspect and cancel to one DNS backend while preserving real TLS hostname checks', async () => {
    const core = worker();
    const local = await serve(createSecurityRequestHandler(core, { peers: peers() }));
    const resolve = resolveAll();
    resolve.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    resolve.mockResolvedValue([{ address: '127.0.0.2', family: 4 }]);
    const port = createHttpUploadSecurityPort({
      endpoint: local.replace('127.0.0.1', 'localhost'),
      allowedHosts: ['localhost'],
      policySha256,
      tls: { ca, cert, key },
    });
    expect(await port.prepare({ attemptId: 'operation.1', subject, signal: signal() })).toEqual(
      execution,
    );
    expect(await port.inspect({ execution, subject, body: body(), signal: signal() })).toEqual(
      inspection(),
    );
    expect(await port.cancel({ execution, signal: signal() })).toEqual(settlement());
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('localhost', { all: true, verbatim: true });
    const original = servers.shift()!;
    original.closeAllConnections();
    await new Promise<void>((resolveClose, reject) =>
      original.close((error) => (error ? reject(error) : resolveClose())),
    );
    await expect(port.cancel({ execution, signal: signal() })).rejects.toThrow(
      /^security_uninspectable$/,
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    const wrong = await serve(jest.fn(), 'wrong');
    resolve.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    const invalid = createHttpUploadSecurityPort({
      endpoint: wrong.replace('127.0.0.1', 'localhost'),
      allowedHosts: ['localhost'],
      policySha256,
      tls: { ca, cert, key },
    });
    await expect(
      invalid.prepare({ attemptId: 'operation.1', subject, signal: signal() }),
    ).rejects.toThrow(/^security_uninspectable$/);
  });
  it('keeps an actual pending DNS flight after request abort instead of resolving a replacement backend', async () => {
    const local = await serve(createSecurityRequestHandler(worker(), { peers: peers() }));
    let finish!: (answers: { address: string; family: number }[]) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<{ address: string; family: number }[]>((resolve) => {
      finish = resolve;
    });
    const resolve = resolveAll().mockImplementation(() => {
      entered();
      return pending;
    });
    const port = createHttpUploadSecurityPort({
      endpoint: local.replace('127.0.0.1', 'localhost'),
      allowedHosts: ['localhost'],
      policySha256,
      tls: { ca, cert, key },
    });
    const controller = new AbortController();
    const aborted = port
      .prepare({ attemptId: 'operation.1', subject, signal: controller.signal })
      .catch((error: unknown) => error);
    await started;
    controller.abort();
    expect(await aborted).toEqual(new Error('security_uninspectable'));
    const next = port.prepare({ attemptId: 'operation.1', subject, signal: signal() });
    finish([{ address: '127.0.0.1', family: 4 }]);
    expect(await next).toEqual(execution);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it('preserves an externally supplied TLS fixture', () => {
    const previous = process.env.SCANNER_TLS_TEST_CERTS;
    try {
      process.env.SCANNER_TLS_TEST_CERTS = certificateDirectory;
      const external = createSecurityTlsFixture();
      external.close();
      expect(pem('ca.pem')).toEqual(ca);
    } finally {
      if (previous === undefined) delete process.env.SCANNER_TLS_TEST_CERTS;
      else process.env.SCANNER_TLS_TEST_CERTS = previous;
    }
  });
  it.each([
    'http://127.0.0.1',
    'https://u:p@127.0.0.1',
    'https://127.0.0.1/prefix',
    'https://127.0.0.1?x=1',
    'https://127.0.0.1#x',
    'https://other.invalid',
  ])('rejects configured endpoint %s', (endpoint) =>
    expect(() => client(endpoint)).toThrow('security_uninspectable'),
  );
  it('rejects missing TLS credentials', () =>
    expect(() => client('https://127.0.0.1', { ca, cert: Buffer.alloc(0), key })).toThrow(
      'security_uninspectable',
    ));
  it('does not consume input before server identity succeeds', async () => {
    const received = jest.fn();
    const endpoint = await serve(received, 'wrong');
    const read = jest.fn();
    const input = (async function* () {
      read();
      yield Buffer.from('hello');
    })();
    await expect(
      client(endpoint).inspect({ execution, subject, body: input, signal: signal() }),
    ).rejects.toThrow(/^security_uninspectable$/);
    expect(read).not.toHaveBeenCalled();
    expect(received).not.toHaveBeenCalled();
  });
  it('rejects missing client identity at TLS and handler boundaries, including health', async () => {
    const core = worker();
    const strict = await serve(createSecurityRequestHandler(core, { peers: peers() }));
    await expect(raw(strict, '/v1/prepare', '{}', {}, false)).rejects.toThrow();
    const permissive = await serve(
      createSecurityRequestHandler(core, { peers: peers() }),
      'server',
      false,
    );
    for (const route of ['/v1/prepare', '/healthz'])
      expect((await raw(permissive, route, '{}', {}, false)).status).toBe(403);
    expect(core.prepare).not.toHaveBeenCalled();
  });
  it.each([
    ['extra field', JSON.stringify({ attemptId: 'operation.1', subject, filename: 'private' }), {}],
    ['oversized JSON', ' '.repeat(8193), {}],
    ['invalid JSON', '{private', {}],
    ['wrong MIME', '{}', { 'content-type': 'text/plain' }],
    ['compressed input', '{}', { 'content-encoding': 'gzip' }],
  ])('rejects %s before prepare without detail leaks', async (_name, payload, headers) => {
    const core = worker();
    const endpoint = await serve(createSecurityRequestHandler(core, { peers: peers() }));
    expect(await raw(endpoint, '/v1/prepare', payload, headers)).toEqual({
      status: 400,
      value: '{"version":2,"payload":{"code":"security_uninspectable"},"dispatch":null}',
    });
    expect(core.prepare).not.toHaveBeenCalled();
  });
  it.each([
    'bad-base64',
    'a'.repeat(4097),
    Buffer.from(JSON.stringify({ execution, subject, extra: true })).toString('base64'),
  ])('rejects invalid inspect context #%#', async (context) => {
    const core = worker();
    const endpoint = await serve(createSecurityRequestHandler(core, { peers: peers() }));
    expect(
      (
        await raw(
          endpoint,
          '/v1/inspect',
          'hello',
          { 'content-type': 'application/octet-stream', 'x-upload-security-context': context },
          true,
          'PUT',
        )
      ).status,
    ).toBe(400);
    expect(core.inspect).not.toHaveBeenCalled();
  });
  it.each([
    'redirect',
    'wrong execution',
    'wrong settlement',
    'wrong version',
    'old envelope',
    'wrong envelope version',
    'extra field',
    'oversized response',
    'wrong MIME',
    'remote error',
  ])('fails closed for %s', async (kind) => {
    const endpoint = await serve((_req, res) => {
      res.statusCode = 200;
      if (kind === 'redirect') res.statusCode = 302;
      if (kind === 'remote error') res.statusCode = 500;
      res.setHeader('content-type', kind === 'wrong MIME' ? 'text/plain' : 'application/json');
      res.setHeader('location', 'https://forbidden.invalid/');
      const result = {
        version: kind === 'wrong version' ? 2 : 1,
        execution:
          kind === 'wrong execution'
            ? { ...execution, executionId: '33333333-3333-4333-8333-333333333333' }
            : execution,
        settlement:
          kind === 'wrong settlement'
            ? { ...settlement(), execution: { ...execution, attemptId: 'other.1' } }
            : settlement(),
      };
      res.end(
        kind === 'oversized response'
          ? 'private'.repeat(2000)
          : JSON.stringify(
              kind === 'old envelope'
                ? result
                : {
                    version: kind === 'wrong envelope version' ? 1 : 2,
                    dispatch: null,
                    payload: kind === 'extra field' ? { ...result, content: 'private' } : result,
                  },
            ),
      );
    });
    await expect(client(endpoint).cancel({ execution, signal: signal() })).rejects.toThrow(
      /^security_uninspectable$/,
    );
  });
  it.each(['hell', 'hello!'])('rejects a body whose actual length differs: %s', async (content) => {
    const port = client(await serve(createSecurityRequestHandler(worker(), { peers: peers() })));
    const input = (async function* () {
      yield Buffer.from(content);
    })();
    await expect(
      port.inspect({ execution, subject, body: input, signal: signal() }),
    ).rejects.toThrow(/^security_uninspectable$/);
  });
  it('does not return a core approval that skipped the input stream', async () => {
    const core = worker();
    core.inspect.mockResolvedValueOnce(inspection());
    const port = client(await serve(createSecurityRequestHandler(core, { peers: peers() })));
    await expect(
      port.inspect({ execution, subject, body: body(), signal: signal() }),
    ).rejects.toThrow(/^security_uninspectable$/);
  });
  it('rejects an untrusted server CA before consuming input', async () => {
    const core = worker();
    const read = jest.fn();
    const endpoint = await serve(createSecurityRequestHandler(core, { peers: peers() }));
    const port = client(endpoint, { ca: cert, cert, key });
    const input = (async function* () {
      read();
      yield Buffer.from('hello');
    })();
    await expect(
      port.inspect({ execution, subject, body: input, signal: signal() }),
    ).rejects.toThrow(/^security_uninspectable$/);
    expect(read).not.toHaveBeenCalled();
    expect(core.inspect).not.toHaveBeenCalled();
  });
  it('propagates disconnect and supports independent cancel without inferred cleanup', async () => {
    let entered!: () => void, aborted!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const stopped = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const core = worker();
    core.inspect.mockImplementationOnce(async ({ signal: inputSignal }) => {
      entered();
      return new Promise((_resolve, reject) =>
        inputSignal.addEventListener(
          'abort',
          () => {
            aborted();
            reject(new Error('private disconnect'));
          },
          { once: true },
        ),
      );
    });
    core.cancel.mockResolvedValueOnce({
      execution,
      writerStopped: false,
      transientDataRemoved: false,
    });
    const port = client(await serve(createSecurityRequestHandler(core, { peers: peers() })));
    const controller = new AbortController();
    const pending = port
      .inspect({ execution, subject, body: body(), signal: controller.signal })
      .then(
        () => new Error('unexpected success'),
        (error: unknown) => error,
      );
    await started;
    controller.abort();
    expect(await pending).toEqual(new Error('security_uninspectable'));
    await stopped;
    expect(await port.cancel({ execution, signal: signal() })).toEqual({
      execution,
      writerStopped: false,
      transientDataRemoved: false,
    });
  });
});
