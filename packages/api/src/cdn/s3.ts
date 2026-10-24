import { randomUUID } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { logger } from '@librechat/data-schemas';
import type { S3ClientCapture } from '../storage/providerObservation';
import { copyS3ClientCapture } from '../storage/providerObservation';
import { isEnabled } from '~/utils/common';

let s3: S3Client | null = null;
let capture: S3ClientCapture | undefined;
let acquisitionAttempted = false;
/** Null means acquisition has not begun; failed or closed actual custody is unavailable. */
export function getS3ClientCapture(): S3ClientCapture | null | undefined {
  return s3 || acquisitionAttempted ? capture : null;
}

/**
 * Initializes and returns an instance of the AWS S3 client.
 *
 * If AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are provided, they will be used.
 * Otherwise, the AWS SDK's default credentials chain (including IRSA) is used.
 *
 * If AWS_ENDPOINT_URL is provided, it will be used as the endpoint.
 *
 * @returns An instance of S3Client if the region is provided; otherwise, null.
 */
export const initializeS3 = (): S3Client | null => {
  if (s3) {
    return s3;
  }

  acquisitionAttempted = true;
  const region = process.env.AWS_REGION;
  if (!region) {
    logger.error('[initializeS3] AWS_REGION is not set. Cannot initialize S3.');
    return null;
  }

  if (!process.env.AWS_BUCKET_NAME) {
    throw new Error(
      '[S3] AWS_BUCKET_NAME environment variable is required for S3 operations. ' +
        'Please set this environment variable to enable S3 storage.',
    );
  }

  // Read the custom endpoint if provided.
  const endpoint = process.env.AWS_ENDPOINT_URL;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  const config = {
    region,
    requestChecksumCalculation: 'WHEN_REQUIRED' as const,
    ...(endpoint ? { endpoint } : {}),
    ...(isEnabled(process.env.AWS_FORCE_PATH_STYLE) ? { forcePathStyle: true } : {}),
  };

  if (accessKeyId && secretAccessKey) {
    s3 = new S3Client({
      ...config,
      credentials: { accessKeyId, secretAccessKey },
    });
    logger.info('[initializeS3] S3 initialized with provided credentials.');
  } else {
    // When using IRSA, credentials are automatically provided via the IAM Role attached to the ServiceAccount.
    s3 = new S3Client(config);
    logger.info('[initializeS3] S3 initialized using default credentials (IRSA).');
  }

  capture = copyS3ClientCapture({
    instanceId: randomUUID(),
    region,
    endpoint: config.endpoint ?? null,
    forcePathStyle: config.forcePathStyle === true,
  });
  const destroy = s3.destroy.bind(s3);
  s3.destroy = () => {
    capture = undefined;
    destroy();
  };
  return s3;
};
