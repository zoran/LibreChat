import { join } from 'node:path';
import { request } from 'node:https';
import { readFileSync } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import type { IntakeChannelContext } from './channel';
import { createIntakeChannel, startIntakeControlService } from './channel';
import { createSecurityTlsFixture } from '../security/tls-fixture.helper';
import { UploadManagementError } from '../errors';

describe('isolated intake channel', () => {
  let fixture: ReturnType<typeof createSecurityTlsFixture>;
  const services: Awaited<ReturnType<typeof startIntakeControlService>>[] = [];
  const worker = { hostId: 'intake-node', instanceId: 'intake-pod' };
  const operationId = '11111111-1111-4111-8111-111111111111';
  const capability = 'A'.repeat(43);
  const promotionId = '22222222-2222-4222-8222-222222222222';
  const pem = (name: string) => readFileSync(join(fixture.directory, name));
  const digest = createHash('sha256').update('hello').digest('hex');
  const integrity = {
    version: 1 as const,
    algorithm: 'sha256' as const,
    chunkBytes: 262144 as const,
    sha256: digest,
    chunkSha256: [digest],
  };
  beforeAll(() => {
    fixture = createSecurityTlsFixture();
  });
  afterEach(async () => {
    for (const service of services.splice(0))
      if (!(await service.close()).complete) throw new Error('Incomplete owned channel drain');
  });
  afterAll(() => fixture.close());
  async function setup(
    overrides: Partial<Parameters<typeof startIntakeControlService>[0]> = {},
    clientWorker = worker,
  ) {
    const control = jest.fn(async (_context: IntakeChannelContext) => ({ ok: true }));
    const received: Buffer[] = [];
    const consume = jest.fn(async (body: AsyncIterable<Uint8Array>) => {
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(Buffer.from(chunk));
        received.push(Buffer.from(chunk));
      }
      return { received: Buffer.concat(chunks).toString() };
    });
    const release = jest.fn(async () => undefined);
    const promote = jest.fn(async () => ({ consume, close: release }));
    const service = await startIntakeControlService({
      tls: { ca: pem('ca.pem'), cert: pem('server.pem'), key: pem('server.key') },
      peers: [
        {
          certificateSha256: new X509Certificate(pem('client.pem')).fingerprint256
            .replaceAll(':', '')
            .toLowerCase(),
          role: 'intake',
          hostIds: [worker.hostId],
        },
      ],
      handlers: { control, promote },
      host: '127.0.0.1',
      port: 0,
      ...overrides,
    });
    services.push(service);
    const channel = createIntakeChannel({
      endpoint: `https://127.0.0.1:${service.address.port}`,
      allowedHosts: ['127.0.0.1'],
      worker: clientWorker,
      tls: { ca: pem('ca.pem'), cert: pem('client.pem'), key: pem('client.key') },
    });
    return { service, channel, control, promote, consume, release, received };
  }
  it('binds the configured process to the authenticated role and host permission', async () => {
    const { channel, control } = await setup();
    await expect(
      channel.control({
        operationId,
        capability,
        command: { action: 'get' },
        signal: AbortSignal.timeout(5000),
      }),
    ).resolves.toEqual({ ok: true });
    expect(control.mock.calls[0]?.[0]).toEqual({ operationId, capability, worker });
  });
  it('preserves worker identifiers accepted by the native durable contract', async () => {
    const nativeWorker = { hostId: 'intake.node', instanceId: 'intake_pod' };
    const { channel, control } = await setup(
      {
        peers: [
          {
            certificateSha256: new X509Certificate(pem('client.pem')).fingerprint256
              .replaceAll(':', '')
              .toLowerCase(),
            role: 'intake',
            hostIds: [nativeWorker.hostId],
          },
        ],
      },
      nativeWorker,
    );
    await channel.control({
      operationId,
      capability,
      command: { action: 'get' },
      signal: AbortSignal.timeout(5000),
    });
    expect(control.mock.calls[0]?.[0].worker).toEqual(nativeWorker);
  });
  it('does not evaluate document bytes before explicit approval and body claim', async () => {
    let allow!: () => void;
    const ready = new Promise<void>((resolve) => {
      allow = resolve;
    });
    const consumed = jest.fn();
    const body = async function* () {
      consumed();
      yield Buffer.from('hello');
    };
    let prepared!: () => void;
    const preflight = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    const { channel } = await setup({
      handlers: {
        control: async () => ({}),
        promote: async () => {
          prepared();
          await ready;
          return {
            consume: async (input) => {
              for await (const _chunk of input) {
                /* consume after Go */
              }
              return { ok: true };
            },
            close: async () => undefined,
          };
        },
      },
    });
    const pending = channel.promote({
      operationId,
      capability,
      promotionId,
      bytes: 5,
      integrity,
      body: body(),
      signal: AbortSignal.timeout(5000),
    });
    await preflight;
    expect(consumed).not.toHaveBeenCalled();
    allow();
    await expect(pending).resolves.toEqual({ ok: true });
    expect(consumed).toHaveBeenCalledTimes(1);
  });
  it('never reads the source after denied promotion', async () => {
    const consumed = jest.fn();
    const { channel } = await setup({
      handlers: {
        control: async () => ({}),
        promote: async () => {
          throw new UploadManagementError('security_uninspectable');
        },
      },
    });
    await expect(
      channel.promote({
        operationId,
        capability,
        promotionId,
        bytes: 5,
        integrity,
        body: (async function* () {
          consumed();
          yield Buffer.from('hello');
        })(),
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toMatchObject({ code: 'security_uninspectable' });
    expect(consumed).not.toHaveBeenCalled();
  });
  it('rejects a trusted CA client absent from the exact peer allowlist', async () => {
    const { channel, control } = await setup({
      peers: [{ certificateSha256: 'f'.repeat(64), role: 'intake', hostIds: [worker.hostId] }],
    });
    await expect(
      channel.control({
        operationId,
        capability,
        command: { action: 'get' },
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(control).not.toHaveBeenCalled();
  });
  it('verifies source integrity before any altered bytes reach the App consumer', async () => {
    const { channel, consume, release, received } = await setup();
    await expect(
      channel.promote({
        operationId,
        capability,
        promotionId,
        bytes: 5,
        integrity,
        body: (async function* () {
          yield Buffer.from('WRONG');
        })(),
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toBeDefined();
    expect(consume).toHaveBeenCalledTimes(1);
    await services[0].close();
    expect(received).toEqual([]);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('allows an authentic, claimed, intact body through the same channel', async () => {
    const { channel, release } = await setup();
    await expect(
      channel.promote({
        operationId,
        capability,
        promotionId,
        bytes: 5,
        integrity,
        body: (async function* () {
          yield Buffer.from('hello');
        })(),
        signal: AbortSignal.timeout(5000),
      }),
    ).resolves.toEqual({ received: 'hello' });
    expect(release).toHaveBeenCalledTimes(1);
  });
  it.each([
    'http://127.0.0.1',
    'https://127.0.0.1/other',
    'https://evil.invalid',
    'https://user:pass@127.0.0.1',
  ])('rejects an uncontrolled endpoint %s', (endpoint) => {
    expect(() =>
      createIntakeChannel({
        endpoint,
        allowedHosts: ['127.0.0.1'],
        worker,
        tls: { ca: pem('ca.pem'), cert: pem('client.pem'), key: pem('client.key') },
      }),
    ).toThrow();
  });

  it('allows two current process incarnations under the same pinned role certificate', async () => {
    const { service, channel, control } = await setup();
    const secondWorker = { ...worker, instanceId: 'next-process' };
    const second = createIntakeChannel({
      endpoint: `https://127.0.0.1:${service.address.port}`,
      allowedHosts: ['127.0.0.1'],
      worker: secondWorker,
      tls: { ca: pem('ca.pem'), cert: pem('client.pem'), key: pem('client.key') },
    });
    for (const client of [channel, second])
      await client.control({
        operationId,
        capability,
        command: { action: 'get' },
        signal: AbortSignal.timeout(5000),
      });
    expect(control.mock.calls.map(([context]) => context.worker)).toEqual([worker, secondWorker]);
  });

  it('snapshots role hosts and worker so configuration or request mutation cannot change authority', async () => {
    const hosts = [worker.hostId];
    const mutableWorker = { ...worker };
    const peer = {
      certificateSha256: new X509Certificate(pem('client.pem')).fingerprint256
        .replaceAll(':', '')
        .toLowerCase(),
      role: 'intake' as const,
      hostIds: hosts,
    };
    const { channel, control } = await setup({ peers: [peer] }, mutableWorker);
    hosts[0] = 'foreign';
    peer.certificateSha256 = 'f'.repeat(64);
    mutableWorker.hostId = 'foreign';
    mutableWorker.instanceId = 'forged';
    await channel.control({
      operationId,
      capability,
      command: { action: 'get' },
      signal: AbortSignal.timeout(5000),
      worker: mutableWorker,
      headers: { 'X-Upload-Worker-Host': 'foreign' },
    } as never);
    expect(control.mock.calls[0][0].worker).toEqual(worker);
  });

  it.each([
    ['missing host', { 'x-upload-worker-host': undefined }, 400],
    ['missing instance', { 'x-upload-worker-instance': undefined }, 400],
    ['invalid instance', { 'x-upload-worker-instance': 'not an instance' }, 400],
    ['foreign host', { 'x-upload-worker-host': 'foreign-host' }, 401],
    ['duplicate host', { 'x-upload-worker-host': ['intake-node', 'intake-node'] }, 400],
    ['duplicate instance', { 'x-upload-worker-instance': ['intake-pod', 'intake-pod'] }, 400],
    ['browser bearer', { authorization: 'Bearer forbidden' }, 400],
    ['browser cookie', { cookie: 'session=forbidden' }, 400],
  ] as const)(
    'rejects %s before invoking the control owner',
    async (_name, overrides, expected) => {
      const { service, control } = await setup();
      const headers: Record<string, string | readonly string[] | undefined> = {
        'content-type': 'application/json',
        'content-length': '2',
        'x-upload-capability': capability,
        'x-upload-worker-host': worker.hostId,
        'x-upload-worker-instance': worker.instanceId,
        ...overrides,
      };
      const requestHeaders: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(headers))
        if (value !== undefined)
          requestHeaders[name] = typeof value === 'string' ? value : [...value];
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(
          `https://127.0.0.1:${service.address.port}/v1/intake/control/${operationId}`,
          {
            ca: pem('ca.pem'),
            cert: pem('client.pem'),
            key: pem('client.key'),
            method: 'POST',
            headers: requestHeaders,
            agent: false,
            signal: AbortSignal.timeout(5000),
          },
          (response) => {
            response.resume();
            response.once('end', () => resolve(response.statusCode));
            response.once('error', reject);
          },
        );
        req.once('error', reject);
        req.end('{}');
      });
      expect(status).toBe(expected);
      expect(control).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ certificateSha256: 'a'.repeat(64), worker }],
    [{ certificateSha256: 'a'.repeat(64), role: 'app', hostIds: [worker.hostId] }],
    [{ certificateSha256: 'a'.repeat(64), role: 'intake', hostIds: [] }],
    [
      {
        certificateSha256: 'a'.repeat(64),
        role: 'intake',
        hostIds: [worker.hostId, worker.hostId],
      },
    ],
    [{ certificateSha256: 'a'.repeat(64), role: 'intake', hostIds: [undefined] }],
    [
      { certificateSha256: 'a'.repeat(64), role: 'intake', hostIds: [worker.hostId] },
      { certificateSha256: 'a'.repeat(64), role: 'intake', hostIds: ['other'] },
    ],
  ])(
    'rejects legacy or invalid role configuration %# before opening a listener',
    async (...peers) => {
      await expect(setup({ peers: peers as never })).rejects.toThrow();
    },
  );

  it('rejects missing, malformed, inherited and accessor worker identities without evaluating getters', () => {
    const getter = jest.fn(() => worker.hostId);
    const accessor = Object.defineProperty({ instanceId: worker.instanceId }, 'hostId', {
      get: getter,
    });
    for (const identity of [
      undefined,
      {},
      { ...worker, hostId: 123 },
      { ...worker, instanceId: '' },
      Object.create(worker),
      accessor,
    ])
      expect(() =>
        createIntakeChannel({
          endpoint: 'https://127.0.0.1',
          allowedHosts: ['127.0.0.1'],
          worker: identity,
          tls: { ca: pem('ca.pem'), cert: pem('client.pem'), key: pem('client.key') },
        } as never),
      ).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });

  it('shares one pinned DNS target across control and promotion without failover after disconnect', async () => {
    const { service, control, release } = await setup();
    const resolve = jest.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
    const channel = createIntakeChannel({
      endpoint: `https://localhost:${service.address.port}`,
      allowedHosts: ['localhost'],
      worker,
      resolve,
      tls: { ca: pem('ca.pem'), cert: pem('client.pem'), key: pem('client.key') },
    });
    await channel.control({
      operationId,
      capability,
      command: {},
      signal: AbortSignal.timeout(5000),
    });
    resolve.mockImplementation(async () => [{ address: '127.0.0.2', family: 4 }]);
    await expect(
      channel.promote({
        operationId,
        capability,
        promotionId,
        bytes: 5,
        integrity,
        body: (async function* () {
          yield Buffer.from('hello');
        })(),
        signal: AbortSignal.timeout(5000),
      }),
    ).resolves.toEqual({ received: 'hello' });
    expect(control.mock.calls[0][0].worker).toEqual(worker);
    expect(release).toHaveBeenCalledTimes(1);
    await service.close();
    await expect(
      channel.control({ operationId, capability, command: {}, signal: AbortSignal.timeout(5000) }),
    ).rejects.toThrow();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith('localhost');
  });

  it('keeps CA and URL-hostname verification when DNS is pinned to a valid server address', async () => {
    const { service, control } = await setup();
    const channel = createIntakeChannel({
      endpoint: `https://wrong.invalid:${service.address.port}`,
      allowedHosts: ['wrong.invalid'],
      worker,
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      tls: { ca: pem('ca.pem'), cert: pem('client.pem'), key: pem('client.key') },
    });
    await expect(
      channel.control({ operationId, capability, command: {}, signal: AbortSignal.timeout(5000) }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(control).not.toHaveBeenCalled();
  });
});
