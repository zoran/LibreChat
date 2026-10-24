/** Purpose-scoped managed storage construction; never adopts the CDN singleton or ambient keys. */
import { randomUUID } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import type { S3ClientCapture } from '../providerObservation';
import { copyS3ClientCapture } from '../providerObservation';

const captures = new WeakMap<S3Client, S3ClientCapture>();
/** Only clients returned by this factory can carry current managed custody. */
export function getManagedS3ClientCapture(client: S3Client): S3ClientCapture | undefined {
  return captures.get(client);
}

export function createManagedS3Client(env: Readonly<Record<string, string | undefined>>): S3Client {
  let endpoint: URL;
  try {
    endpoint = new URL(env.AWS_ENDPOINT_URL ?? '');
  } catch {
    throw new Error('Managed storage configuration unavailable');
  }
  if (
    !env.AWS_REGION ||
    !env.AWS_BUCKET_NAME ||
    !env.AWS_ACCESS_KEY_ID ||
    !env.AWS_SECRET_ACCESS_KEY ||
    env.AWS_FORCE_PATH_STYLE !== 'true' ||
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error('Managed storage configuration unavailable');
  }
  const config = {
    region: env.AWS_REGION,
    endpoint: endpoint.href,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED' as const,
    credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
  };
  const client = new S3Client(config);
  const capture = copyS3ClientCapture({
    instanceId: randomUUID(),
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
  });
  if (capture) captures.set(client, capture);
  const destroy = client.destroy.bind(client);
  client.destroy = () => {
    captures.delete(client);
    destroy();
  };
  return client;
}
