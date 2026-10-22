import { join } from 'node:path';
import { request } from 'node:https';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { IncomingMessage } from 'node:http';
import { createHash, X509Certificate } from 'node:crypto';
import { canonicalManagedJson, MANAGED_DOCUMENT_WIRE_MAX_BYTES } from 'librechat-data-provider';
import type { RetrievalLookupHandler } from './retrieval-lookup';
import operationsFixture from '../../../../data-provider/src/__fixtures__/managed-retrieval-operations-v1.json';
import { encodeRetrievalLookup, readRetrievalLookup } from './retrieval-lookup';
import { createSecurityTlsFixture } from '../security/tls-fixture.helper';
import { startIntakeControlService } from './channel';

const sha = (v: unknown) => createHash('sha256').update(canonicalManagedJson(v)).digest('hex');
const digest = 'a'.repeat(64);
const selector = {
  version: 1,
  owner: { tenantId: 'tenant', userId: 'user' },
  operationId: 'operation',
  requestedPurpose: 'query',
};
const absent = { version: 1, status: 'unavailable', reason: 'not_found' };
function available(count = 1) {
  return {
    version: 1,
    status: 'available',
    timeUnit: 'unix-seconds',
    owner: { ...selector.owner },
    operationId: selector.operationId,
    original: {
      purpose: 'query',
      originalSha256: digest,
      bodySha256: digest,
      backendIdentity: 'backend',
      writerEpoch: 1,
      routePolicySha256: digest,
      rankingPolicySha256: digest,
      indexGeneration: digest,
      policyProvenanceSha256: digest,
      admittedAt: 1000,
      workDeadline: 1120,
      technicalCleanupDeadline: 2020,
    },
    authority: {
      purpose: 'query',
      requestSha256: digest,
      writerEpoch: 1,
      workDeadline: 1120,
      routePolicySha256: digest,
      sourceExpiresAt: 1200,
      cleanupDeadline: null,
    },
    sources: Array.from({ length: count }, (_, i) => {
      const source = {
        fileId: 'file-' + i + 'x'.repeat(240),
        operationId: 'x'.repeat(256),
        transferGeneration: 1,
        originalSha256: digest,
        originalBytes: 20,
        mediaType: 'text/plain',
      };
      const sourceRevision = sha({ version: 1, owner: selector.owner, source });
      const parts = {
        version: 1,
        sourceRevision,
        textSha256: digest,
        structureSha256: digest,
        approvalSha256: digest,
        extractionPolicySha256: digest,
      };
      const representationRevision = sha(parts);
      const revision = { ...parts, owner: selector.owner, source, representationRevision };
      return {
        key: { sourceRevision, representationRevision, indexGeneration: digest },
        revision,
        originalExpiresAt: 1200,
        currentExpiresAt: 1200,
        contentState: 'live',
        indexOriginal: {
          operationId: 'x'.repeat(256),
          requestSha256: digest,
          writerEpoch: 1,
          backendIdentity: 'backend',
          state: 'ready',
        },
      };
    }),
  };
}

describe('retrieval lookup on the existing isolated mTLS listener', () => {
  let fixture: ReturnType<typeof createSecurityTlsFixture>;
  const services: Awaited<ReturnType<typeof startIntakeControlService>>[] = [];
  const pem = (name: string) => readFileSync(join(fixture.directory, name));
  const pin = () =>
    new X509Certificate(pem('client.pem')).fingerprint256.replaceAll(':', '').toLowerCase();
  beforeAll(() => {
    fixture = createSecurityTlsFixture();
  });
  afterEach(async () => {
    for (const service of services.splice(0)) assert.equal((await service.close()).complete, true);
  });
  afterAll(() => fixture.close());
  async function setup(
    lookup?: RetrievalLookupHandler,
    role: 'intake' | 'retrieval-backend' = 'retrieval-backend',
  ) {
    const control = jest.fn(async () => ({ ok: true }));
    const promote = jest.fn(async () => {
      throw Error('must not promote');
    });
    const service = await startIntakeControlService({
      tls: { ca: pem('ca.pem'), cert: pem('server.pem'), key: pem('server.key') },
      peers:
        role === 'intake'
          ? [{ certificateSha256: pin(), role, hostIds: ['host'] }]
          : [{ certificateSha256: pin(), role, backendIdentity: 'backend' }],
      handlers: { control, promote, lookup },
      host: '127.0.0.1',
      port: 0,
      deadlineMs: 2000,
    });
    services.push(service);
    return { service, control, promote };
  }
  function call(
    service: Awaited<ReturnType<typeof startIntakeControlService>>,
    options: {
      path?: string;
      method?: string;
      raw?: string | Buffer;
      headers?: Record<string, string | undefined>;
      certificate?: string;
    } = {},
  ) {
    const raw = options.raw ?? canonicalManagedJson(selector);
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port: service.address.port,
          path: options.path ?? '/v1/retrieval/lookup',
          method: options.method ?? 'POST',
          ca: pem('ca.pem'),
          cert: pem((options.certificate ?? 'client') + '.pem'),
          key: pem((options.certificate ?? 'client') + '.key'),
          agent: false,
          headers: {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(raw)),
            ...options.headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.once('error', reject);
          res.once('end', () =>
            resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }),
          );
        },
      );
      req.once('error', reject);
      req.end(raw);
    });
  }
  it('passes only verified selectors and certificate-bound backend identity to File', async () => {
    const lookup = jest.fn(async () => available());
    const { service } = await setup(lookup);
    const response = await call(service);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual(available());
    expect(lookup.mock.calls[0]).toEqual([
      selector,
      { backendIdentity: 'backend' },
      expect.any(AbortSignal),
      expect.any(Number),
    ]);
  });
  it('keeps the original dispatch deadline after a delayed canonical body', async () => {
    const dispatchedAt = Date.parse('2026-10-19T12:00:00Z');
    let currentTime = dispatchedAt;
    jest.spyOn(Date, 'now').mockImplementation(() => currentTime);
    let reading!: () => void;
    const bodyRead = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const iterate = IncomingMessage.prototype[Symbol.asyncIterator];
    jest.spyOn(IncomingMessage.prototype, Symbol.asyncIterator).mockImplementation(function (
      this: IncomingMessage,
    ) {
      if (this.url === '/v1/retrieval/lookup') reading();
      return iterate.call(this);
    });
    const lookup = jest.fn(async () => absent);
    const { service } = await setup(lookup);
    const raw = Buffer.from(canonicalManagedJson(selector));
    let client!: ReturnType<typeof request>;
    const pending = new Promise<number>((resolve, reject) => {
      client = request(
        {
          hostname: '127.0.0.1',
          port: service.address.port,
          path: '/v1/retrieval/lookup',
          method: 'POST',
          ca: pem('ca.pem'),
          cert: pem('client.pem'),
          key: pem('client.key'),
          agent: false,
          headers: { 'content-type': 'application/json', 'content-length': raw.length },
        },
        (response) => {
          response.resume();
          response.once('error', reject);
          response.once('end', () => resolve(response.statusCode!));
        },
      );
      client.once('error', reject);
      client.write(raw.subarray(0, 1));
    });
    await bodyRead;
    currentTime += 750;
    client.end(raw.subarray(1));
    expect(await pending).toBe(200);
    expect(lookup.mock.calls).toHaveLength(1);
    const deadlineAt = (lookup.mock.calls[0] as unknown[])[3] as number;
    expect(deadlineAt).toBe(dispatchedAt + 2000);
    expect((lookup.mock.calls[0] as unknown[])[0]).toEqual(selector);
    expect((lookup.mock.calls[0] as unknown[])[1]).toEqual({ backendIdentity: 'backend' });
    expect((lookup.mock.calls[0] as unknown[])[2]).toBeInstanceOf(AbortSignal);
    expect(deadlineAt - currentTime).toBe(1250);
  });
  it('supports valid32-source responses beyond the unchanged intake32KiB gate', async () => {
    const value = available(32);
    expect(Buffer.byteLength(canonicalManagedJson(value))).toBeGreaterThan(32768);
    const { service } = await setup(async () => value);
    expect((await call(service)).status).toBe(200);
  });
  it('fails unavailable when the File callback is not composed', async () => {
    const { service } = await setup();
    const response = await call(service);
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ code: 'unavailable' });
  });
  it('isolates both peer roles and never grants backend control or promotion', async () => {
    const lookup = jest.fn(async () => absent);
    const backend = await setup(lookup);
    for (const path of ['/v1/intake/control/operation', '/v1/intake/promote/operation'])
      expect((await call(backend.service, { path })).status).toBe(401);
    const intake = await setup(lookup, 'intake');
    expect((await call(intake.service)).status).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
    expect(backend.control).not.toHaveBeenCalled();
    expect(backend.promote).not.toHaveBeenCalled();
  });
  it.each([
    { method: 'GET' },
    { path: '/v1/retrieval/lookup?owner=other' },
    { headers: { authorization: 'Bearer foreign' } },
    { headers: { cookie: 'secret' } },
    { headers: { 'content-encoding': 'gzip' } },
    { headers: { expect: '100-continue' } },
    { headers: { 'x-upload-capability': 'A'.repeat(43) } },
    { raw: JSON.stringify(selector) },
    { raw: canonicalManagedJson(selector) + ' ' },
    { raw: canonicalManagedJson(selector).replace('"version":1', '"version":1,"version":1') },
    { raw: canonicalManagedJson({ ...selector, backendIdentity: 'caller' }) },
    {
      raw: Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(canonicalManagedJson(selector)),
      ]),
    },
    { raw: Buffer.from([0xff]) },
    { raw: 'x'.repeat(32769) },
  ])('rejects malformed/ambiguous/over-limit requests before lookup %#', async (options) => {
    const lookup = jest.fn(async () => absent);
    const { service } = await setup(lookup);
    const response = await call(service, options);
    expect([400, 401]).toContain(response.status);
    expect(lookup).not.toHaveBeenCalled();
  });
  it('rejects an untrusted TLS client before any lookup', async () => {
    const lookup = jest.fn(async () => absent);
    const { service } = await setup(lookup);
    await expect(call(service, { certificate: 'wrong' })).rejects.toThrow();
    expect(lookup).not.toHaveBeenCalled();
  });
  it.each(['foreign-owner', 'extra-field', 'oversize', 'bad-revision'])(
    'rejects unsafe callback output %s without leaking values',
    async (mutation) => {
      const value: ReturnType<typeof available> & { secret?: string } = available();
      if (mutation === 'foreign-owner') value.owner.userId = 'PRIVATE';
      if (mutation === 'extra-field') value.secret = 'PRIVATE';
      if (mutation === 'oversize') value.secret = 'x'.repeat(MANAGED_DOCUMENT_WIRE_MAX_BYTES + 1);
      if (mutation === 'bad-revision') value.sources[0].revision.textSha256 = 'b'.repeat(64);
      const { service } = await setup(async () => value);
      const response = await call(service);
      expect(response.status).toBe(503);
      expect(JSON.parse(response.body)).toEqual({ code: 'unavailable' });
    },
  );
  it('propagates shutdown cancellation and joins the lookup callback', async () => {
    let entered!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    let aborted = false;
    const { service } = await setup(async (_request, _backend, signal) => {
      entered();
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
      return absent;
    });
    const pending = call(service).catch(() => undefined);
    await ready;
    expect((await service.close()).complete).toBe(true);
    await pending;
    expect(aborted).toBe(true);
  });
  it('keeps a noncancellable callback owned after disconnect until it actually settles', async () => {
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signal: AbortSignal | undefined;
    const { service } = await setup(async (_request, _peer, current) => {
      signal = current;
      entered();
      await hold;
      return absent;
    });
    const raw = canonicalManagedJson(selector);
    const client = request({
      hostname: '127.0.0.1',
      port: service.address.port,
      path: '/v1/retrieval/lookup',
      method: 'POST',
      ca: pem('ca.pem'),
      cert: pem('client.pem'),
      key: pem('client.key'),
      agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) },
    });
    client.on('error', () => undefined);
    client.end(raw);
    await ready;
    client.destroy();
    expect((await service.close(AbortSignal.timeout(30))).complete).toBe(false);
    expect(signal?.aborted).toBe(true);
    release();
    expect((await service.close()).complete).toBe(true);
  });
  it('retains selected status unavailability without exposing an available status grant', async () => {
    const { service } = await setup(async () => ({
      version: 1,
      status: 'unavailable',
      reason: 'status_contract_unselected',
    }));
    const result = await call(service, {
      raw: canonicalManagedJson({ ...selector, requestedPurpose: 'status' }),
    });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body).reason).toBe('status_contract_unselected');
  });
  it('rejects mixed peer permissions and duplicate certificate pins at startup', async () => {
    for (const peers of [
      [
        {
          certificateSha256: pin(),
          role: 'retrieval-backend',
          backendIdentity: 'backend',
          hostIds: ['host'],
        },
      ],
      [{ certificateSha256: pin(), role: 'intake', hostIds: ['host'], backendIdentity: 'backend' }],
      [
        { certificateSha256: pin(), role: 'retrieval-backend', backendIdentity: 'backend' },
        { certificateSha256: pin(), role: 'intake', hostIds: ['host'] },
      ],
    ])
      await expect(
        startIntakeControlService({
          tls: { ca: pem('ca.pem'), cert: pem('server.pem'), key: pem('server.key') },
          peers: peers as unknown as Parameters<typeof startIntakeControlService>[0]['peers'],
          handlers: {
            control: async () => null,
            promote: async () => {
              throw Error();
            },
          },
          host: '127.0.0.1',
          port: 0,
        }),
      ).rejects.toThrow();
  });
});

/** The API owns serialization; provider and Python consumers retain the same shared wire fixtures. */
describe('retrieval lookup shared wire fixtures', () => {
  it.each(['index', 'query', 'purge'] as const)(
    'serializes the existing File projection for %s identically to Python',
    (purpose) => {
      const item = operationsFixture.operations[purpose];
      const selector = readRetrievalLookup(canonicalManagedJson(item.selector));
      expect(
        encodeRetrievalLookup(
          item.lookup,
          selector,
          item.lookup.original.backendIdentity,
        ).toString(),
      ).toBe(item.canonicalLookup);
    },
  );

  it('rejects noncanonical and duplicate-key lookup bytes', () => {
    expect(() =>
      readRetrievalLookup(JSON.stringify(operationsFixture.operations.query.selector)),
    ).toThrow();
    expect(() => readRetrievalLookup('{"version":1,"version":1}')).toThrow();
  });
});
