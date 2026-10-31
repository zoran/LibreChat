/** health probes one bounded non-user NAS control key using the actual captured S3 client. */
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { randomBytes, createHash } from 'node:crypto';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type { UploadS3HealthProof } from 'librechat-data-provider';
import type { S3Client } from '@aws-sdk/client-s3';
import { getNasS3ClientCapture } from './client';

/** One immutable invocation belongs to the availability owner's original singleflight. */
export type NasS3HealthContext = {
  signal: AbortSignal;
  startedAtMs: number;
  deadlineAtMs: number;
  maxAgeMs: number;
};
export type NasS3HealthProbe = (context: NasS3HealthContext) => Promise<UploadS3HealthProof>;

/** No ambient configuration, random object key, retries, user File or terminal deletion authority. */
export function createNasS3HealthProbe(
  client: S3Client,
  owner: string,
  clock: () => number = Date.now,
): NasS3HealthProbe {
  const captured = getNasS3ClientCapture(client);
  if (!captured || !/^[a-zA-Z0-9_.-]{1,128}$/.test(owner) || captured.maxAttempts !== 1)
    throw new Error('invalid_nas_health_client');
  const key = `health/v1/${owner}`;
  let flight: Promise<UploadS3HealthProof> | undefined;
  return (context) => {
    if (flight) return flight;
    const { signal, startedAtMs, deadlineAtMs, maxAgeMs } = context;
    if (
      !Number.isSafeInteger(startedAtMs) ||
      startedAtMs < 0 ||
      !Number.isSafeInteger(deadlineAtMs) ||
      deadlineAtMs <= startedAtMs ||
      deadlineAtMs - startedAtMs > 20000 ||
      maxAgeMs !== 90000
    )
      return Promise.reject(new Error('invalid_nas_health_clock'));
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.max(0, deadlineAtMs - clock()));
    timer.unref?.();
    const run = async (): Promise<UploadS3HealthProof> => {
      let outcome: UploadS3HealthProof['outcome'] = 'unknown';
      let responseBody: Readable | undefined;
      const live = () => {
        if (
          cancellation.signal.aborted ||
          clock() >= deadlineAtMs ||
          clock() < startedAtMs ||
          getNasS3ClientCapture(client) !== captured
        )
          throw new Error('nas_health_unavailable');
      };
      try {
        live();
        const body = randomBytes(4096);
        const digest = createHash('sha256').update(body).digest('hex');
        const written = await client.send(
          new PutObjectCommand({
            Bucket: captured.bucket,
            Key: key,
            Body: body,
            ContentLength: 4096,
            ContentType: 'application/octet-stream',
          }),
          { abortSignal: cancellation.signal },
        );
        live();
        if (written.$metadata.httpStatusCode !== 200 || written.VersionId !== undefined)
          throw new Error('nas_health_write');
        const read = await client.send(
          new GetObjectCommand({ Bucket: captured.bucket, Key: key }),
          { abortSignal: cancellation.signal },
        );
        if (read.Body instanceof Readable) responseBody = read.Body;
        live();
        if (
          read.$metadata.httpStatusCode !== 200 ||
          read.VersionId !== undefined ||
          read.ContentLength !== 4096 ||
          !responseBody
        )
          throw new Error('nas_health_read');
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of responseBody as AsyncIterable<Uint8Array>) {
          live();
          if (
            !(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) ||
            (size += chunk.length) > 4096
          )
            throw new Error('nas_health_size');
          chunks.push(chunk);
        }
        live();
        if (
          size !== 4096 ||
          createHash('sha256').update(Buffer.concat(chunks)).digest('hex') !== digest
        )
          throw new Error('nas_health_integrity');
        outcome = 'ready';
      } catch {
        /* Transport details and credentials never enter public status. */
      } finally {
        if (responseBody) {
          if (!responseBody.readableEnded) responseBody.destroy();
          await finished(responseBody, { cleanup: true }).catch(() => undefined);
        }
      }
      return {
        version: 1,
        backend: { ...captured.backend },
        owner,
        outcome,
        startedAtMs,
        completedAtMs: clock(),
        expiresAtMs: startedAtMs + maxAgeMs,
      };
    };
    flight = run().finally(() => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      flight = undefined;
    });
    return flight;
  };
}
