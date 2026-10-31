/** client.spec.ts exercises NAS transport through the real AWS SDK and owned loopback TLS. */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { HttpRequest } from '@smithy/protocol-http';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { NasS3ClientOptions, NasTransportTrust } from './client';
import { createNasS3Client, getNasS3ClientCapture } from './client';

type Certificate = Readonly<{ pem: string; key: string; sha256: string }>;
type Client = ReturnType<typeof createNasS3Client>;
type Fixture = Readonly<{
  endpoint: string;
  port: number;
  requests: Array<{ method: string | undefined; path: string }>;
  connections: () => number;
  replaceCertificate: (certificate: Certificate) => void;
  close: () => Promise<void>;
}>;

const bucket = 'cortex-files';
const credentials = {
  accessKeyId: 'SYNTHETIC_NAS_TLS_ACCESS',
  secretAccessKey: 'SYNTHETIC_NAS_TLS_SECRET',
};
const backend: NasS3ClientOptions['backend'] = {
  kind: 'nas-s3',
  protocol: 'acknowledged-only-v1',
  uid: 'synthetic-nas-backend',
  configurationSha256: 'a'.repeat(64),
};
const clients = new Set<Client>();
const fixtures = new Set<Fixture>();
let directory: string | undefined;
let first: Certificate;
let second: Certificate;
let renewed: Certificate;

function certificate(name: string): Certificate {
  if (!directory) throw new Error('Synthetic TLS fixture is not prepared');
  const config = join(directory, name + '.cnf');
  const key = join(directory, name + '.key');
  const cert = join(directory, name + '.pem');
  writeFileSync(config, '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=synthetic.invalid\n');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-sha256',
      '-days',
      '2',
      '-config',
      config,
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign',
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: 'ignore', timeout: 10000 },
  );
  const pem = readFileSync(cert, 'utf8');
  return {
    pem,
    key: readFileSync(key, 'utf8'),
    sha256: createHash('sha256').update(new X509Certificate(pem).raw).digest('hex'),
  };
}

function signedReplacement(): Certificate {
  if (!directory) throw new Error('Synthetic TLS fixture is not prepared');
  const path = (name: string) => join(directory!, name);
  const run = (args: string[]) =>
    execFileSync('openssl', args, { stdio: 'ignore', timeout: 10000 });
  writeFileSync(
    path('intermediate.ext'),
    'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n',
  );
  writeFileSync(
    path('replacement.ext'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n',
  );
  run([
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=synthetic-intermediate.invalid',
    '-keyout',
    path('intermediate.key'),
    '-out',
    path('intermediate.csr'),
  ]);
  run([
    'x509',
    '-req',
    '-in',
    path('intermediate.csr'),
    '-CA',
    path('first.pem'),
    '-CAkey',
    path('first.key'),
    '-set_serial',
    '3',
    '-days',
    '2',
    '-sha256',
    '-extfile',
    path('intermediate.ext'),
    '-out',
    path('intermediate.pem'),
  ]);
  run([
    'req',
    '-new',
    '-key',
    path('first.key'),
    '-subj',
    '/CN=synthetic.invalid',
    '-out',
    path('replacement.csr'),
  ]);
  run([
    'x509',
    '-req',
    '-in',
    path('replacement.csr'),
    '-CA',
    path('intermediate.pem'),
    '-CAkey',
    path('intermediate.key'),
    '-set_serial',
    '4',
    '-days',
    '2',
    '-sha256',
    '-extfile',
    path('replacement.ext'),
    '-out',
    path('replacement.pem'),
  ]);
  const leaf = readFileSync(path('replacement.pem'), 'utf8');
  return {
    pem: leaf + readFileSync(path('intermediate.pem'), 'utf8'),
    key: first.key,
    sha256: createHash('sha256').update(new X509Certificate(leaf).raw).digest('hex'),
  };
}

function pin(value = first): NasTransportTrust {
  return { mode: 'exact-certificate', certificatePem: value.pem, sha256: value.sha256 };
}

function options(endpoint: string, trust: NasTransportTrust = pin()): NasS3ClientOptions {
  return {
    backend,
    endpoint,
    region: 'us-east-1',
    bucket,
    credentials,
    trust,
    requestTimeoutMs: 2000,
  };
}

function client(endpoint: string, trust: NasTransportTrust = pin()): Client {
  const value = createNasS3Client(options(endpoint, trust));
  clients.add(value);
  return value;
}

async function fixture(
  value = first,
  reply: (request: IncomingMessage, response: ServerResponse) => void = (_request, response) => {
    response.writeHead(200, { etag: '"synthetic-etag"', 'content-length': '0' });
    response.end();
  },
): Promise<Fixture> {
  const requests: Fixture['requests'] = [];
  const sockets = new Set<Duplex>();
  let connections = 0;
  let closing: Promise<void> | undefined;
  const server = createServer({ key: value.key, cert: value.pem }, (request, response) => {
    requests.push({ method: request.method, path: (request.url ?? '/').split('?')[0] });
    reply(request, response);
  });
  server.on('connection', (socket) => {
    connections++;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('tlsClientError', () => {
    // Rejected synthetic handshakes are expected; no request headers or key material are logged.
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback listener unavailable');
  const valueFixture: Fixture = {
    endpoint: `https://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    connections: () => connections,
    replaceCertificate(next) {
      server.setSecureContext({ key: next.key, cert: next.pem });
    },
    close() {
      closing ??= (async () => {
        const socketClosed = Array.from(
          sockets,
          (socket) => new Promise<void>((resolve) => socket.once('close', () => resolve())),
        );
        const closed = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        for (const socket of sockets) socket.destroy();
        await Promise.all([closed, ...socketClosed]);
        expect(server.listening).toBe(false);
        expect(sockets.size).toBe(0);
      })();
      return closing;
    },
  };
  fixtures.add(valueFixture);
  return valueFixture;
}

function head(value: Client, selectedBucket = bucket) {
  return value.send(new HeadObjectCommand({ Bucket: selectedBucket, Key: 'approved/fixture.txt' }));
}

function configurationFailure(value: NasS3ClientOptions): Error {
  let failure: unknown;
  try {
    const accepted = createNasS3Client(value);
    accepted.destroy();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  if (!(failure instanceof Error)) throw new Error('Invalid configuration was accepted');
  const diagnostic = String(failure) + failure.stack;
  for (const secret of [
    credentials.accessKeyId,
    credentials.secretAccessKey,
    'url-user',
    'url-secret',
  ])
    expect(diagnostic).not.toContain(secret);
  return failure;
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'cortex-nas-client-tls-'));
  first = certificate('first');
  second = certificate('second');
  renewed = signedReplacement();
});

function expectJoinedFixtures(errors: unknown[]) {
  expect(errors).toEqual([]);
}
afterEach(async () => {
  jest.restoreAllMocks();
  for (const value of clients) value.destroy();
  clients.clear();
  const errors: unknown[] = [];
  await Promise.all(
    Array.from(fixtures, async (value) => {
      try {
        await value.close();
      } catch (error) {
        errors.push(error);
      }
    }),
  );
  fixtures.clear();
  expectJoinedFixtures(errors);
});

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('NAS S3 transport with real AWS SDK and loopback HTTPS', () => {
  it('accepts only the exact self-signed certificate even without a SAN', async () => {
    expect(new X509Certificate(first.pem).subjectAltName).toBeUndefined();
    const server = await fixture();
    await expect(head(client(server.endpoint))).resolves.toMatchObject({
      $metadata: { httpStatusCode: 200, attempts: 1 },
    });
    expect(server.connections()).toBe(1);
    expect(server.requests).toEqual([
      { method: 'HEAD', path: '/cortex-files/approved/fixture.txt' },
    ]);
  });

  it('rejects a different valid pinned anchor before any HTTP reaches the server', async () => {
    const server = await fixture();
    await expect(head(client(server.endpoint, pin(second)))).rejects.toThrow();
    expect(server.connections()).toBeGreaterThanOrEqual(1);
    expect(server.requests).toHaveLength(0);
  });

  it('rejects a certificate changed after one successful request', async () => {
    const server = await fixture();
    const value = client(server.endpoint);
    await head(value);
    server.replaceCertificate(second);
    await expect(head(value)).rejects.toThrow();
    expect(server.connections()).toBe(2);
    expect(server.requests).toHaveLength(1);
  });

  it('rejects renewed DER with the same key and subject even when its CA chain verifies', async () => {
    const original = new X509Certificate(first.pem);
    const replacement = new X509Certificate(renewed.pem);
    expect(replacement.subject).toBe(original.subject);
    expect(replacement.publicKey.export({ type: 'spki', format: 'der' })).toEqual(
      original.publicKey.export({ type: 'spki', format: 'der' }),
    );
    expect(renewed.sha256).not.toBe(first.sha256);
    const server = await fixture(renewed);
    // Scoped control proves CA acceptance alone would permit this certificate. No HTTP is sent.
    const control = connect({
      host: '127.0.0.1',
      port: server.port,
      ca: first.pem,
      rejectUnauthorized: true,
      checkServerIdentity: () => undefined,
    });
    const closed = new Promise<void>((resolve) => control.once('close', () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        control.once('error', reject);
        control.once('secureConnect', () => {
          if (!control.authorized) reject(new Error('Synthetic CA control was not authorized'));
          else resolve();
        });
        control.setTimeout(2000, () =>
          control.destroy(new Error('Synthetic TLS control timed out')),
        );
      });
    } finally {
      control.destroy();
      await closed;
    }
    await expect(head(client(server.endpoint))).rejects.toThrow();
    expect(server.connections()).toBeGreaterThanOrEqual(2);
    expect(server.requests).toHaveLength(0);
  });

  it('retains hostname checks in CA mode rather than inheriting the exact-pin exception', async () => {
    const server = await fixture();
    await expect(
      head(client(server.endpoint, { mode: 'ca-hostname', caPem: first.pem })),
    ).rejects.toThrow(/ERR_TLS_CERT_ALTNAME_INVALID/);
    expect(server.connections()).toBeGreaterThanOrEqual(1);
    expect(server.requests).toHaveLength(0);
  });

  it('does not globally trust the pinned certificate for a separate default-CA client', async () => {
    const server = await fixture();
    await head(client(server.endpoint));
    await expect(head(client(server.endpoint, { mode: 'ca-hostname' }))).rejects.toThrow();
    expect(server.requests).toHaveLength(1);
  });

  it('rejects an expired exact anchor using controlled factory time', () => {
    expect.hasAssertions();
    const now = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(new X509Certificate(first.pem).validTo) + 1);
    try {
      configurationFailure(options('https://127.0.0.1:9443'));
    } finally {
      now.mockRestore();
    }
  });

  it('rejects a mismatched anchor digest without exposing credentials', () => {
    expect.hasAssertions();
    configurationFailure(
      options('https://127.0.0.1:9443', {
        mode: 'exact-certificate',
        certificatePem: first.pem,
        sha256: '0'.repeat(64),
      }),
    );
  });

  it.each([
    'http://127.0.0.1:9443',
    'https://url-user:url-secret@127.0.0.1:9443',
    'https://127.0.0.1:9443/not-the-endpoint-root',
    'https://127.0.0.1:9443/?not-allowed=1',
    'https://127.0.0.1:9443/#not-allowed',
  ])('rejects unsafe endpoint configuration without credential disclosure: %s', (endpoint) => {
    expect.hasAssertions();
    configurationFailure(options(endpoint));
  });

  it('refuses another bucket before opening a connection', async () => {
    const server = await fixture();
    await expect(head(client(server.endpoint), 'foreign-files')).rejects.toThrow();
    expect(server.connections()).toBe(0);
    expect(server.requests).toHaveLength(0);
  });

  it('refuses a different loopback endpoint even when public SDK middleware changes the target', async () => {
    const source = await fixture();
    const target = await fixture();
    const value = client(source.endpoint);
    value.middlewareStack.add(
      (next) => async (args) => {
        if (!HttpRequest.isInstance(args.request)) throw new Error('SDK request unavailable');
        args.request.port = target.port;
        return next(args);
      },
      { step: 'build', name: 'syntheticEndpointMutation' },
    );
    await expect(head(value)).rejects.toThrow();
    expect(source.connections()).toBe(0);
    expect(target.connections()).toBe(0);
    expect(target.requests).toHaveLength(0);
  });

  it('does not send a redirected request to a different endpoint', async () => {
    const target = await fixture();
    const source = await fixture(first, (_request, response) => {
      response.writeHead(307, { location: target.endpoint + '/cortex-files/approved/fixture.txt' });
      response.end();
    });
    await expect(head(client(source.endpoint))).rejects.toMatchObject({
      $metadata: { httpStatusCode: 307, attempts: 1 },
    });
    expect(source.requests).toHaveLength(1);
    expect(target.connections()).toBe(0);
    expect(target.requests).toHaveLength(0);
  });

  it('does not retry an uncertain 503 response', async () => {
    const server = await fixture(first, (_request, response) => {
      response.writeHead(503, { 'content-type': 'application/xml' });
      response.end('<Error><Code>SlowDown</Code></Error>');
    });
    await expect(head(client(server.endpoint))).rejects.toMatchObject({
      $metadata: { httpStatusCode: 503, attempts: 1 },
    });
    expect(server.requests).toHaveLength(1);
  });

  it('captures public configuration without credentials and forgets it on destroy', async () => {
    const server = await fixture();
    const value = client(server.endpoint);
    await head(value);
    const capture = getNasS3ClientCapture(value);
    expect(capture).toMatchObject({
      backend,
      endpoint: server.endpoint,
      bucket,
      trustMode: 'exact-certificate',
    });
    const serialized = JSON.stringify(capture);
    for (const secret of [
      credentials.accessKeyId,
      credentials.secretAccessKey,
      first.key,
      first.pem,
    ])
      expect(serialized).not.toContain(secret);
    value.destroy();
    clients.delete(value);
    expect(getNasS3ClientCapture(value)).toBeUndefined();
  });
});
