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

  it('fences every new control and promotion request for the local File hold', async () => {
    const { service, channel, control, promote } = await setup();
    expect(service.maintenance.pauseAdmissions('maintenance')).toBe(true);
    expect(service.maintenance.pauseAdmissions('foreign')).toBe(false);
    for (const action of [
      'authorize',
      'get',
      'claim',
      'prepare-promotion',
      'get-promotion',
      'renew',
      'fail',
      'cancel',
      'bind-security',
      'settle-security',
      'claim-bytes',
      'complete-bytes',
      'accept',
      'confirm-cleanup',
      'seal-recovery',
      'confirm-recovery',
    ])
      await expect(
        channel.control({
          operationId,
          capability,
          command: { action },
          signal: AbortSignal.timeout(5000),
        }),
      ).rejects.toMatchObject({ code: 'unavailable' });
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
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(control).not.toHaveBeenCalled();
    expect(promote).not.toHaveBeenCalled();
    expect(await service.maintenance.getMaintenanceCensus('maintenance')).toMatchObject({
      admissionClosed: true,
      pendingWrites: 0,
      complete: true,
    });
    expect(service.maintenance.resumeAdmissions('foreign')).toBe(false);
    expect(service.maintenance.resumeAdmissions('maintenance')).toBe(true);
    await channel.control({
      operationId,
      capability,
      command: { action: 'claim' },
      signal: AbortSignal.timeout(5000),
    });
    expect(control).toHaveBeenCalledTimes(1);
  });

  it('retains a request admitted before pause even when its body arrives after pause', async () => {
    const { service, control } = await setup();
    const command = JSON.stringify({ action: 'claim' });
    let pending!: ReturnType<typeof request>;
    const response = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      pending = request(
        {
          host: '127.0.0.1',
          port: service.address.port,
          path: `/v1/intake/control/${operationId}`,
          method: 'POST',
          ca: pem('ca.pem'),
          cert: pem('client.pem'),
          key: pem('client.key'),
          agent: false,
          signal: AbortSignal.timeout(5000),
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(command),
            'X-Upload-Worker-Host': worker.hostId,
            'X-Upload-Worker-Instance': worker.instanceId,
            'X-Upload-Capability': capability,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.once('error', reject);
          res.once('end', () => {
            try {
              resolve({
                status: res.statusCode!,
                body: JSON.parse(Buffer.concat(chunks).toString()),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      pending.once('error', reject);
      pending.flushHeaders();
    });
    void response.catch(() => undefined);
    try {
      // Observe actual server dispatch before closing admission, without delivering the body.
      const until = Date.now() + 4000;
      while (
        (await service.maintenance.getMaintenanceCensus(null)).pendingWrites === 0 &&
        Date.now() < until
      )
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect((await service.maintenance.getMaintenanceCensus(null)).pendingWrites).toBe(1);
      expect(control).not.toHaveBeenCalled();
      expect(service.maintenance.pauseAdmissions('maintenance')).toBe(true);
      expect(await service.maintenance.getMaintenanceCensus('maintenance')).toMatchObject({
        admissionClosed: true,
        pendingWrites: 1,
      });
      pending.end(command);
      await expect(response).resolves.toEqual({ status: 200, body: { ok: true } });
      expect(control).toHaveBeenCalledTimes(1);
      expect(await service.maintenance.getMaintenanceCensus('maintenance')).toMatchObject({
        admissionClosed: true,
        pendingWrites: 0,
        complete: true,
      });
    } finally {
      pending.destroy();
      await response.catch(() => undefined);
    }
  });

  it('retains the original control transaction after client abort and an interrupted close', async () => {
    let entered!: () => void;
    let release!: () => void;
    const began = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { service, channel } = await setup({
      handlers: {
        control: async () => {
          entered();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { committed: true };
        },
        promote: async () => ({ consume: async () => undefined, close: async () => undefined }),
      },
    });
    const controller = new AbortController();
    const response = channel
      .control({
        operationId,
        capability,
        command: { action: 'claim' },
        signal: controller.signal,
      })
      .catch((error: unknown) => error);
    await began;
    expect(service.maintenance.pauseAdmissions('maintenance')).toBe(true);
    controller.abort();
    await response;
    expect((await service.maintenance.getMaintenanceCensus('maintenance')).pendingWrites).toBe(1);
    expect(await service.close(AbortSignal.abort())).toEqual({ complete: false });
    expect(
      (await service.maintenance.getMaintenanceCensus('maintenance')).pendingWrites,
    ).toBeGreaterThan(0);
    release();
    expect(await service.close()).toEqual({ complete: true });
    expect(await service.maintenance.getMaintenanceCensus('maintenance')).toMatchObject({
      admissionClosed: true,
      pendingWrites: 0,
    });
  });

  it('retains the promotion original through its actual cleanup after disconnect', async () => {
    let entered!: () => void;
    let release!: () => void;
    const began = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const close = jest.fn(async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const { service, channel } = await setup({
      handlers: {
        control: async () => undefined,
        promote: async () => ({
          consume: async (body) => {
            for await (const chunk of body) expect(Buffer.from(chunk).length).toBeGreaterThan(0);
          },
          close,
        }),
      },
    });
    const controller = new AbortController();
    const response = channel
      .promote({
        operationId,
        capability,
        promotionId,
        bytes: 5,
        integrity,
        body: (async function* () {
          yield Buffer.from('hello');
        })(),
        signal: controller.signal,
      })
      .catch((error: unknown) => error);
    await began;
    service.maintenance.pauseAdmissions('maintenance');
    controller.abort();
    await response;
    expect((await service.maintenance.getMaintenanceCensus('maintenance')).pendingWrites).toBe(1);
    expect(await service.close(AbortSignal.abort())).toEqual({ complete: false });
    release();
    expect(await service.close()).toEqual({ complete: true });
    expect(close).toHaveBeenCalledTimes(1);
    expect((await service.maintenance.getMaintenanceCensus('maintenance')).pendingWrites).toBe(0);
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
