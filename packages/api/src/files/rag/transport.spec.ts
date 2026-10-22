/** Real wire validation/signing and HTTP adapter logic; only the external HTTPS boundary is mocked. */
import jwt from 'jsonwebtoken';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Agent, request } from 'node:https';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { canonicalManagedJson, MANAGED_DOCUMENT_WIRE_MAX_BYTES } from 'librechat-data-provider';
import type { RequestOptions } from 'node:https';
import type { EventEmitter } from 'node:events';
import {
  checkRagApiHealth,
  createManagedRagClient,
  createManagedRagClientFromEnvironment,
  createRagTlsTransport,
} from './transport';
import { signManagedCapability } from '~/crypto/jwt';
type FixtureRequest = EventEmitter & { destroy(error: Error): void; end(body: string): void };
type FixtureResponse = EventEmitter & {
  statusCode: number;
  complete: boolean;
  destroy(error: Error): void;
};

jest.mock('node:https', () => {
  const { EventEmitter } = jest.requireActual<typeof import('node:events')>('node:events');
  return {
    Agent: jest.fn().mockImplementation(() => ({ destroy: jest.fn() })),
    request: jest.fn().mockImplementation((url, options, callback) => {
      const req = new EventEmitter() as FixtureRequest;
      req.destroy = (error: Error) => {
        req.emit('error', error);
        req.emit('close');
      };
      req.end = (body: string) => {
        mockRequests.push({ url: String(url), options, body });
        if (mockOutcome.pending) return;
        queueMicrotask(() => {
          const response = new EventEmitter() as FixtureResponse;
          response.statusCode = mockOutcome.status;
          response.complete = mockOutcome.complete;
          response.destroy = (error: Error) => response.emit('error', error);
          callback(response);
          if (mockOutcome.abort) response.emit('aborted');
          else {
            response.emit('data', Buffer.from(mockOutcome.body));
            response.emit('end');
          }
          req.emit('close');
        });
      };
      return req;
    }),
  };
});

jest.mock('node:fs', () => {
  const actual = jest.requireActual('node:fs');
  const map = (path: string) =>
    typeof path === 'string' && path.startsWith('/etc/cortex-retrieval-client/')
      ? path.replace('/etc/cortex-retrieval-client', mockRoot)
      : path;
  return {
    ...actual,
    readFileSync: (path: string, ...args: unknown[]) => actual.readFileSync(map(path), ...args),
    statSync: (path: string, ...args: unknown[]) => actual.statSync(map(path), ...args),
  };
});

const mockRequests: {
  url: string;
  options: RequestOptions & { headers: { Authorization: string } };
  body: string;
}[] = [];
let mockOutcome: {
  status: number;
  body: string;
  complete: boolean;
  abort?: boolean;
  pending?: boolean;
};
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const now = 1_800_000_000;
const key = 'a'.repeat(128);
let mockRoot: string;
let env: NodeJS.ProcessEnv;
let serverPin: string;

function fixture(purpose: 'index' | 'query' | 'purge' = 'query') {
  const body = {
    query: 'synthetic query',
    keys: [
      {
        sourceRevision: '1'.repeat(64),
        representationRevision: '2'.repeat(64),
        indexGeneration: '3'.repeat(64),
      },
    ],
  };
  const context = {
    purpose,
    owner: { tenantId: null, userId: 'fixture-user' },
    backendIdentity: 'fixture-backend',
    requestSha256: sha(canonicalManagedJson(body)),
    operationId: 'original-operation',
    keys: body.keys,
    writerEpoch: 3,
    workDeadline: now + 60,
    routePolicySha256: '4'.repeat(64),
    sourceExpiresAt: now + 120,
    cleanupDeadline: now + 120,
  };
  const claims = {
    ...context,
    version: 1,
    iss: 'cortex-librechat',
    aud: 'cortex-rag',
    sub: 'fixture-user',
    jti: 'original-jti',
    iat: now,
    nbf: now,
    exp: now + 30,
    allowedEntityIds: [],
  };
  delete (claims as Partial<typeof claims>).sourceExpiresAt;
  delete (claims as Partial<typeof claims>).cleanupDeadline;
  return { body, context, claims };
}

function client() {
  return createManagedRagClientFromEnvironment(env);
}

beforeAll(() => {
  mockRoot = mkdtempSync(join(tmpdir(), 'cortex-rag-client-'));
  for (const name of ['ca.crt', 'tls.crt', 'tls.key'])
    writeFileSync(join(mockRoot, name), `synthetic-${name}`);
  writeFileSync(join(mockRoot, 'backend-signing.key'), key, { mode: 0o600 });
  serverPin = sha('synthetic-server-der');
  env = {
    RAG_API_URL: 'https://retrieval.test:8000',
    RAG_API_SERVER_SHA256: serverPin,
    JWT_SECRET: 'test-session-secret-must-not-sign',
  };
});
afterAll(() => rmSync(mockRoot, { recursive: true, force: true }));
beforeEach(() => {
  mockRequests.length = 0;
  mockOutcome = { status: 200, body: '{"status":"UP"}', complete: true };
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(now * 1000);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test('health uses explicit verified client TLS and exact server DER pin without a bearer', async () => {
  expect(await checkRagApiHealth(env)).toBe(true);
  expect(mockRequests).toHaveLength(1);
  expect(mockRequests[0].url).toBe('https://retrieval.test:8000/health');
  expect(mockRequests[0].options.headers.Authorization).toBeUndefined();
  const options = (Agent as unknown as jest.Mock).mock.calls[0][0];
  expect(options).toMatchObject({
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
    keepAlive: false,
    maxCachedSessions: 0,
    ca: Buffer.from('synthetic-ca.crt'),
    cert: Buffer.from('synthetic-tls.crt'),
    key: Buffer.from('synthetic-tls.key'),
  });
  const certificate = {
    raw: Buffer.from('synthetic-server-der'),
    subjectaltname: 'DNS:retrieval.test',
    subject: {},
  };
  expect(options.checkServerIdentity('retrieval.test', certificate)).toBeUndefined();
  expect(options.checkServerIdentity('wrong.test', certificate).code).toBe(
    'ERR_TLS_CERT_ALTNAME_INVALID',
  );
  expect(
    options.checkServerIdentity('retrieval.test', { ...certificate, raw: Buffer.from('other') }),
  ).toBeInstanceOf(Error);
});

test.each([
  'http://retrieval.test',
  'https://user:password@retrieval.test',
  'https://retrieval.test/other',
  'https://retrieval.test?redirect=1',
])('unsafe base URL %s is denied', (url) => {
  expect(() => createRagTlsTransport(url, serverPin)).toThrow();
  expect(request).not.toHaveBeenCalled();
});

test('missing dedicated material has no session-key or system-trust fallback', async () => {
  await expect(checkRagApiHealth({ ...env, RAG_API_SERVER_SHA256: undefined })).rejects.toThrow();
  expect(() => createManagedRagClientFromEnvironment({ ...env, RAG_API_URL: undefined })).toThrow();
  writeFileSync(join(mockRoot, 'backend-signing.key'), '');
  try {
    expect(() =>
      createManagedRagClient({ url: env.RAG_API_URL!, serverCertificateSha256: serverPin }),
    ).toThrow();
  } finally {
    writeFileSync(join(mockRoot, 'backend-signing.key'), key);
  }
  expect(request).not.toHaveBeenCalled();
});

test.each([302, 401, 503])('health response %s cannot become ready or redirect', async (status) => {
  mockOutcome.status = status;
  await expect(checkRagApiHealth(env)).rejects.toThrow();
  expect(mockRequests).toHaveLength(1);
});

test.each(['{"status":"DOWN"}', '{"status":"UP","extra":true}', '{"status":"DOWN","status":"UP"}'])(
  'health body %s is not ready',
  async (body) => {
    mockOutcome.body = body;
    expect(await checkRagApiHealth(env)).toBe(false);
  },
);

test('truncated, aborted and oversized responses fail closed', async () => {
  for (const change of [{ complete: false }, { abort: true }, { body: 'x'.repeat(16385) }]) {
    mockOutcome = { status: 200, body: '{"status":"UP"}', complete: true, ...change };
    await expect(checkRagApiHealth(env)).rejects.toThrow();
  }
});

test('actual signer uses the dedicated key and preserves exact managed claims', () => {
  const f = fixture();
  const token = signManagedCapability(f.claims, { ...f.context, now }, key);
  expect(jwt.verify(token, key, { algorithms: ['HS256'], clockTimestamp: now })).toEqual(f.claims);
  expect(() =>
    jwt.verify(token, env.JWT_SECRET!, { algorithms: ['HS256'], clockTimestamp: now }),
  ).toThrow();
  expect(jwt.decode(token)).not.toHaveProperty('id');
  expect(() => signManagedCapability({ id: 'fixture-user' }, { ...f.context, now }, key)).toThrow();
});

test('index, query and purge keep original independently authorized operation identity', async () => {
  for (const purpose of ['index', 'query', 'purge'] as const) {
    const f = fixture(purpose),
      c = client();
    const authorize = jest.fn().mockResolvedValue(f.context);
    const paths = { index: '/embed', query: '/query_multiple', purge: '/documents' } as const;
    const path = paths[purpose];
    const method = purpose === 'purge' ? 'DELETE' : 'POST';
    mockOutcome.body = '{"fixture":true}';
    expect(
      await c.invoke({ purpose, path, method, body: f.body, capability: f.claims, authorize }),
    ).toEqual({ fixture: true });
    expect(authorize).toHaveBeenCalledTimes(2);
    const sent = mockRequests[mockRequests.length - 1]!;
    expect(sent.body).toBe(canonicalManagedJson(f.body));
    const token = sent.options.headers.Authorization.slice('Bearer '.length);
    expect(jwt.verify(token, key, { algorithms: ['HS256'], clockTimestamp: now })).toEqual(
      f.claims,
    );
    c.close();
  }
});

test('wrong independently authorized epoch, body, purpose and expiry cannot dispatch', async () => {
  const f = fixture(),
    c = client();
  for (const change of [
    { writerEpoch: 4 },
    { requestSha256: '0'.repeat(64) },
    { purpose: 'index' as const },
    { sourceExpiresAt: now },
  ]) {
    await expect(
      c.invoke({
        purpose: 'query',
        path: '/query',
        method: 'POST',
        body: f.body,
        capability: f.claims,
        authorize: async () => ({ ...f.context, ...change }),
      }),
    ).rejects.toThrow();
  }
  expect(request).not.toHaveBeenCalled();
  c.close();
});

test('revalidation failure after dispatch prevents response content release', async () => {
  const f = fixture(),
    c = client();
  const authorize = jest
    .fn()
    .mockResolvedValueOnce(f.context)
    .mockResolvedValueOnce({ ...f.context, writerEpoch: 4 });
  mockOutcome.body = '{"privateContext":"must not escape"}';
  await expect(
    c.invoke({
      purpose: 'query',
      path: '/query',
      method: 'POST',
      body: f.body,
      capability: f.claims,
      authorize,
    }),
  ).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(1);
  c.close();
});

test('uncomposed status, missing authority and pre-aborted work cannot dispatch', async () => {
  const f = fixture(),
    c = client();
  for (const change of [{ purpose: 'status' }, { authorize: undefined }]) {
    await expect(
      c.invoke({
        purpose: 'query',
        path: '/query',
        method: 'POST',
        body: f.body,
        capability: f.claims,
        authorize: async () => f.context,
        ...change,
      } as unknown as Parameters<typeof c.invoke>[0]),
    ).rejects.toThrow();
  }
  await expect(
    c.invoke({
      purpose: 'query',
      path: '/query',
      method: 'POST',
      body: f.body,
      capability: f.claims,
      authorize: async () => f.context,
      signal: AbortSignal.abort(),
    }),
  ).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
  c.close();
});

test('whole request timer settles a stalled external response without retry', async () => {
  jest.useFakeTimers();
  mockOutcome.pending = true;
  const transport = createRagTlsTransport(env.RAG_API_URL!, serverPin);
  const result = transport.health();
  const rejection = (async () => {
    await expect(result).rejects.toThrow();
  })();
  await jest.advanceTimersByTimeAsync(4001);
  await rejection;
  expect(request).toHaveBeenCalledTimes(1);
  transport.close();
});

test('the fixed managed response ceiling accepts its boundary and rejects overflow without truncation', async () => {
  expect(MANAGED_DOCUMENT_WIRE_MAX_BYTES).toBe(16252932);
  const f = fixture(),
    c = client();
  const invoke = () =>
    c.invoke({
      purpose: 'query',
      path: '/query',
      method: 'POST',
      body: f.body,
      capability: f.claims,
      authorize: async () => f.context,
    });
  mockOutcome.body = '"' + 'x'.repeat(MANAGED_DOCUMENT_WIRE_MAX_BYTES - 2) + '"';
  expect(((await invoke()) as string).length).toBe(MANAGED_DOCUMENT_WIRE_MAX_BYTES - 2);
  mockOutcome.body = '"' + 'x'.repeat(MANAGED_DOCUMENT_WIRE_MAX_BYTES - 1) + '"';
  await expect(invoke()).rejects.toThrow('Managed retrieval transport unavailable');
  expect(request).toHaveBeenCalledTimes(2);
  c.close();
});
