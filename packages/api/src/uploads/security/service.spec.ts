/** Real mTLS listener, HTTP handlers and built scanner thread; no native deployment claim. */
import { join } from 'node:path';
import { request } from 'node:https';
import { readFileSync, statSync } from 'node:fs';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import type { ClientRequest } from 'node:http';
import { createInertAntivirusFixture, antivirusCustodyFixture } from './antivirus-fixture.helper';
import { createSecurityTlsFixture } from './tls-fixture.helper';
import { createHttpUploadSecurityPort } from './transport';
import { startSecurityService } from './service';

const policyBytes = Buffer.from(
  JSON.stringify({
    version: 1,
    markings: [
      'VS-NfD',
      'VS-NUR FÜR DEN DIENSTGEBRAUCH',
      'VS-VERTRAULICH',
      'GEHEIM',
      'STRENG GEHEIM',
    ],
    labels: ['Einstufung'],
  }),
);
const policySha256 = createHash('sha256').update(policyBytes).digest('hex');
const subject = {
  tenantId: 'tenant',
  userId: 'user',
  operationId: 'upload',
  transferGeneration: 1,
  mediaType: 'text/plain',
  bytes: 5,
  sha256: createHash('sha256').update('hello').digest('hex'),
};
const signal = () => AbortSignal.timeout(3000);

describe('scanner service maintenance', () => {
  let fixture: ReturnType<typeof createSecurityTlsFixture>;
  const services: Awaited<ReturnType<typeof startSecurityService>>[] = [];
  const requests: ClientRequest[] = [];
  const pem = (name: string) => readFileSync(join(fixture.directory, name));
  beforeAll(() => {
    fixture = createSecurityTlsFixture();
  });
  afterEach(async () => {
    for (const pending of requests.splice(0)) pending.destroy();
    for (const service of services.splice(0)) {
      if (!(await service.close(signal())).complete)
        throw new Error('Owned service did not settle');
    }
  });
  afterAll(() => {
    fixture?.close();
  });
  async function start(overrides: Partial<Parameters<typeof startSecurityService>[0]> = {}) {
    const threadPath = join(__dirname, '../../../dist/uploads/security/worker-thread.cjs');
    statSync(threadPath);
    const service = await startSecurityService({
      antivirus: createInertAntivirusFixture().runtime,
      instanceId: randomUUID(),
      peers: [
        {
          certificateSha256: createHash('sha256')
            .update(new X509Certificate(pem('client.pem')).raw)
            .digest('hex'),
          role: 'intake',
        },
      ],
      policyBytes,
      policySha256,
      threadPath,
      host: '127.0.0.1',
      port: 0,
      tls: { ca: pem('ca.pem'), cert: pem('server.pem'), key: pem('server.key') },
      ...overrides,
    });
    services.push(service);
    const endpoint = `https://127.0.0.1:${service.address.port}`;
    const tls = { ca: pem('ca.pem'), cert: pem('client.pem'), key: pem('client.key') };
    return {
      service,
      endpoint,
      tls,
      client: createHttpUploadSecurityPort({
        endpoint,
        allowedHosts: ['127.0.0.1'],
        policySha256,
        tls,
      }),
    };
  }
  async function until(check: () => Promise<boolean>) {
    const deadline = Date.now() + 3000;
    while (!(await check())) {
      if (Date.now() >= deadline) throw new Error('Expected scanner lifecycle transition missing');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it.each([undefined, [], [{ certificateSha256: 'a'.repeat(64), role: 'scanner' }]])(
    'rejects missing or invalid peer configuration before listening: %j',
    async (peers) => {
      await expect(start({ peers: peers as never })).rejects.toThrow('security_uninspectable');
    },
  );

  it.each([undefined, '100-continue'])(
    'rejects application preparation before body input or automatic continue: %s',
    async (expectation) => {
      const peers = [
        {
          certificateSha256: createHash('sha256')
            .update(new X509Certificate(pem('client.pem')).raw)
            .digest('hex'),
          role: 'application' as const,
        },
      ];
      const { service, endpoint, tls, client } = await start({ peers });
      const continued = jest.fn();
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const pending = request(
          endpoint + '/v1/prepare',
          {
            ...tls,
            method: 'POST',
            agent: false,
            signal: signal(),
            headers: {
              'content-type': 'application/json',
              'content-length': '512',
              ...(expectation ? { expect: expectation } : {}),
            },
          },
          (res) => {
            res.resume();
            res.once('end', () => resolve(res.statusCode));
            res.once('error', reject);
          },
        );
        requests.push(pending);
        pending.once('error', reject);
        pending.on('continue', continued);
        pending.flushHeaders(); // No body is ever sent; rejection cannot depend on parsing it.
      });
      expect(status).toBe(403);
      expect(continued).not.toHaveBeenCalled();
      expect(await service.maintenance.getMaintenanceCensus(null)).toMatchObject({
        queuedContinuations: 0,
        pendingWrites: 0,
        complete: true,
      });
      const missingExpiry = new Date(Date.now() + 60_000).toISOString();
      const missing = {
        version: 3 as const,
        antivirus: antivirusCustodyFixture(subject, missingExpiry),
        custody: { kind: 'none' as const },
        attemptId: 'upload.1',
        instanceId: randomUUID(),
        executionId: randomUUID(),
        expiresAt: missingExpiry,
      };
      expect(await client.cancel({ execution: missing, signal: signal() })).toEqual({
        execution: missing,
        antivirusReceipt: null,
        writerStopped: false,
        transientDataRemoved: false,
      });
    },
  );

  it('stops prepare admission while exact admitted scans and cancel remain available over mTLS', async () => {
    const { service, client } = await start();
    const execution = await client.prepare({ attemptId: 'upload.1', subject, signal: signal() });
    const cancelled = await client.prepare({
      attemptId: 'cancel.1',
      subject: { ...subject, operationId: 'cancel' },
      signal: signal(),
    });
    expect(service.maintenance.pauseAdmissions('owner')).toBe(true);
    expect(service.maintenance.pauseAdmissions('foreign')).toBe(false);
    expect(service.maintenance.resumeAdmissions('foreign')).toBe(false);
    expect(service.maintenance.resumeAdmissions('owner')).toBe(false);
    expect(await service.maintenance.getMaintenanceCensus('owner')).toEqual({
      admissionClosed: true,
      queuedContinuations: 2,
      pendingWrites: 0,
      complete: true,
    });
    await expect(
      client.prepare({
        attemptId: 'late.1',
        subject: { ...subject, operationId: 'late' },
        signal: signal(),
      }),
    ).rejects.toThrow('security_uninspectable');
    const body = async function* () {
      yield Buffer.from('hello');
    };
    expect(
      (await client.inspect({ execution, subject, body: body(), signal: signal() })).decision
        .decision,
    ).toBe('approved');
    expect((await client.cancel({ execution: cancelled, signal: signal() })).writerStopped).toBe(
      true,
    );
    expect(await service.maintenance.getMaintenanceCensus('owner')).toEqual({
      admissionClosed: true,
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
    expect(service.maintenance.resumeAdmissions('owner')).toBe(true);
    expect(service.maintenance.resumeAdmissions('owner')).toBe(false);
  });

  it('counts an actual unfinished HTTP handler before worker admission and joins repeated close', async () => {
    const { service, endpoint, tls } = await start();
    const pending = request(endpoint + '/v1/prepare', {
      ...tls,
      method: 'POST',
      agent: false,
      headers: { 'content-type': 'application/json', 'content-length': '512' },
    });
    requests.push(pending);
    pending.on('error', () => undefined);
    pending.write('{');
    await until(
      async () => (await service.maintenance.getMaintenanceCensus(null)).pendingWrites === 1,
    );
    expect(service.maintenance.pauseAdmissions('owner')).toBe(true);
    expect(await service.maintenance.getMaintenanceCensus('owner')).toEqual({
      admissionClosed: true,
      queuedContinuations: 0,
      pendingWrites: 1,
      complete: false,
    });
    expect(service.maintenance.resumeAdmissions('owner')).toBe(false);
    expect(await service.close(AbortSignal.abort())).toEqual({ complete: false });
    expect(await service.close(signal())).toEqual({ complete: true });
    expect(await service.close(signal())).toEqual({ complete: true });
    expect(await service.maintenance.getMaintenanceCensus('owner')).toMatchObject({
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
    expect(service.maintenance.pauseAdmissions('owner')).toBe(false);
    expect(service.maintenance.resumeAdmissions('owner')).toBe(false);
  });

  it('keeps both the streamed inspection handler and its producer visible until disconnect joins', async () => {
    const { service, client, endpoint, tls } = await start();
    const execution = await client.prepare({ attemptId: 'upload.1', subject, signal: signal() });
    const pending = request(endpoint + '/v1/inspect', {
      ...tls,
      method: 'PUT',
      agent: false,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(subject.bytes),
        'x-upload-security-context': Buffer.from(JSON.stringify({ execution, subject })).toString(
          'base64',
        ),
      },
    });
    requests.push(pending);
    pending.on('error', () => undefined);
    pending.write('he');
    await until(
      async () => (await service.maintenance.getMaintenanceCensus(null)).pendingWrites === 2,
    );
    expect(service.maintenance.pauseAdmissions('owner')).toBe(true);
    expect(service.maintenance.resumeAdmissions('owner')).toBe(false);
    pending.destroy();
    await until(
      async () => (await service.maintenance.getMaintenanceCensus('owner')).pendingWrites === 0,
    );
    expect((await client.cancel({ execution, signal: signal() })).writerStopped).toBe(true);
    expect(service.maintenance.resumeAdmissions('owner')).toBe(true);
  });
});
