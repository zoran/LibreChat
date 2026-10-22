/** Purpose-scoped managed storage construction; never adopts the CDN singleton or ambient keys. */
import { S3Client } from '@aws-sdk/client-s3';

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
  return new S3Client({
    region: env.AWS_REGION,
    endpoint: endpoint.href,
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
  });
}
