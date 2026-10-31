/** NAS-only S3 transport. Owns endpoint/TLS confinement; never reads ambient credentials. */
import { Agent } from 'node:https';
import { S3Client } from '@aws-sdk/client-s3';
import { checkServerIdentity } from 'node:tls';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import type { NasS3Backend } from 'librechat-data-provider';
import type { PeerCertificate } from 'node:tls';

export type NasTransportTrust =
  | Readonly<{ mode: 'ca-hostname'; caPem?: string }>
  | Readonly<{
      mode: 'exact-certificate';
      certificatePem: string;
      sha256: string;
    }>;

export type NasS3ClientOptions = Readonly<{
  backend: NasS3Backend;
  endpoint: string;
  region: string;
  bucket: string;
  credentials: Readonly<{ accessKeyId: string; secretAccessKey: string }>;
  trust: NasTransportTrust;
  requestTimeoutMs: number;
}>;

/** Public custody observation contains identity/configuration only, never credential material. */
export type NasS3ClientCapture = Readonly<{
  instanceId: string;
  backend: NasS3Backend;
  endpoint: string;
  region: string;
  bucket: string;
  forcePathStyle: true;
  maxAttempts: 1;
  trustMode: NasTransportTrust['mode'];
  certificateSha256: string | null;
}>;

const captures = new WeakMap<S3Client, NasS3ClientCapture>();
const configurationError = () => new Error('NAS storage configuration unavailable');

function certificateCurrent(certificate: X509Certificate): boolean {
  const now = Date.now();
  const from = Date.parse(certificate.validFrom);
  const until = Date.parse(certificate.validTo);
  return Number.isFinite(from) && Number.isFinite(until) && from <= now && now <= until;
}

/** The hostname exception exists only for this exact configured anchor and endpoint. */
function exactCertificateCheck(
  endpoint: URL,
  trust: Extract<NasTransportTrust, { mode: 'exact-certificate' }>,
): (hostname: string, peer: PeerCertificate) => Error | undefined {
  if (
    !/^[a-f0-9]{64}$/.test(trust.sha256) ||
    trust.certificatePem.length > 65536 ||
    trust.certificatePem.split('-----BEGIN CERTIFICATE-----').length !== 2
  )
    throw configurationError();
  let anchor: X509Certificate;
  try {
    anchor = new X509Certificate(trust.certificatePem);
  } catch {
    throw configurationError();
  }
  if (
    createHash('sha256').update(anchor.raw).digest('hex') !== trust.sha256 ||
    !anchor.checkIssued(anchor) ||
    !anchor.verify(anchor.publicKey) ||
    !certificateCurrent(anchor)
  )
    throw configurationError();
  const expectedHost = endpoint.hostname.replace(/^\[|\]$/g, '');
  return (hostname, peer) => {
    if (
      hostname.replace(/^\[|\]$/g, '') !== expectedHost ||
      !peer.raw ||
      createHash('sha256').update(peer.raw).digest('hex') !== trust.sha256 ||
      !certificateCurrent(anchor)
    )
      return new Error('NAS TLS identity rejected');
    return undefined;
  };
}

class NasHttpHandler extends NodeHttpHandler {
  constructor(
    private readonly endpoint: URL,
    private readonly bucket: string,
    agent: Agent,
    requestTimeoutMs: number,
  ) {
    super({
      httpsAgent: agent,
      connectionTimeout: Math.min(5000, requestTimeoutMs),
      requestTimeout: requestTimeoutMs,
      throwOnRequestTimeout: true,
    });
  }

  override handle(
    ...args: Parameters<NodeHttpHandler['handle']>
  ): ReturnType<NodeHttpHandler['handle']> {
    const [request] = args;
    const base = '/' + encodeURIComponent(this.bucket);
    if (
      request.protocol !== 'https:' ||
      request.hostname !== this.endpoint.hostname.replace(/^\[|\]$/g, '') ||
      (request.port ?? 443) !== Number(this.endpoint.port || 443) ||
      (request.path !== base && !request.path.startsWith(base + '/'))
    )
      return Promise.reject(new Error('NAS request target rejected'));
    return super.handle(...args);
  }
}

export function getNasS3ClientCapture(client: S3Client): NasS3ClientCapture | undefined {
  return captures.get(client);
}

/** Retries are disabled: an uncertain original is reconciled by its durable owner. */
export function createNasS3Client(options: NasS3ClientOptions): S3Client {
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint);
  } catch {
    throw configurationError();
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket) ||
    !options.region ||
    options.region.length > 128 ||
    !options.backend ||
    options.backend.kind !== 'nas-s3' ||
    options.backend.protocol !== 'acknowledged-only-v1' ||
    !options.backend.uid ||
    !/^[a-f0-9]{64}$/.test(options.backend.configurationSha256) ||
    !Number.isSafeInteger(options.requestTimeoutMs) ||
    options.requestTimeoutMs < 1000 ||
    options.requestTimeoutMs > 300000 ||
    [options.credentials.accessKeyId, options.credentials.secretAccessKey].some(
      (value) =>
        typeof value !== 'string' || !value || value.length > 1024 || /[\r\n\0]/.test(value),
    )
  )
    throw configurationError();

  const trust = Object.freeze({ ...options.trust });
  if (trust.mode !== 'exact-certificate' && trust.mode !== 'ca-hostname')
    throw configurationError();
  if (trust.mode === 'ca-hostname' && trust.caPem && trust.caPem.length > 65536)
    throw configurationError();
  const verify =
    trust.mode === 'exact-certificate'
      ? exactCertificateCheck(endpoint, trust)
      : checkServerIdentity;
  let certificateOptions: { ca?: string } = {};
  if (trust.mode === 'exact-certificate') certificateOptions = { ca: trust.certificatePem };
  else if (trust.caPem) certificateOptions = { ca: trust.caPem };
  const agent = new Agent({
    keepAlive: false,
    maxCachedSessions: 0,
    minVersion: 'TLSv1.2',
    rejectUnauthorized: true,
    ...certificateOptions,
    checkServerIdentity: verify,
  });
  const handler = new NasHttpHandler(endpoint, options.bucket, agent, options.requestTimeoutMs);
  const client = new S3Client({
    region: options.region,
    endpoint: endpoint.origin,
    forcePathStyle: true,
    followRegionRedirects: false,
    useAccelerateEndpoint: false,
    useDualstackEndpoint: false,
    useFipsEndpoint: false,
    maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: {
      accessKeyId: options.credentials.accessKeyId,
      secretAccessKey: options.credentials.secretAccessKey,
    },
    requestHandler: handler,
  });
  captures.set(
    client,
    Object.freeze({
      instanceId: randomUUID(),
      backend: Object.freeze({ ...options.backend }),
      endpoint: endpoint.origin,
      region: options.region,
      bucket: options.bucket,
      forcePathStyle: true,
      maxAttempts: 1,
      trustMode: trust.mode,
      certificateSha256: trust.mode === 'exact-certificate' ? trust.sha256 : null,
    }),
  );
  const destroy = client.destroy.bind(client);
  client.destroy = () => {
    captures.delete(client);
    destroy();
    agent.destroy();
  };
  return client;
}
