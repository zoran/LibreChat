import { join } from 'node:path';
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
  async function setup(overrides: Partial<Parameters<typeof startIntakeControlService>[0]> = {}) {
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
          worker,
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
      tls: { ca: pem('ca.pem'), cert: pem('client.pem'), key: pem('client.key') },
    });
    return { service, channel, control, promote, consume, release, received };
  }
  it('uses the authenticated certificate worker rather than caller identity', async () => {
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
    const { channel, control } = await setup({
      peers: [
        {
          certificateSha256: new X509Certificate(pem('client.pem')).fingerprint256
            .replaceAll(':', '')
            .toLowerCase(),
          worker: nativeWorker,
        },
      ],
    });
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
      peers: [{ certificateSha256: 'f'.repeat(64), worker }],
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
        tls: { ca: pem('ca.pem'), cert: pem('client.pem'), key: pem('client.key') },
      }),
    ).toThrow();
  });
});
