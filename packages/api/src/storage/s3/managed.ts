import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { isUploadOriginalIntegrity, isUploadStorageReceipt } from 'librechat-data-provider';
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';
import type { UploadOriginalIntegrity, UploadStorageReceipt } from 'librechat-data-provider';
import type { S3Client } from '@aws-sdk/client-s3';
import type { StoragePort } from '../../uploads/contract';
import { verifyOriginalIntegrity } from '../../uploads/storage/integrity';
import { uploadAttemptId } from '../../uploads/processing/paths';
import { getS3Key, parseS3Key } from './crud';

const MAX_BYTES = 30 * 1024 * 1024;
const ignoreStreamError = () => {
  /* Stream consumption and finished() own error settlement. */
};

function identitySnapshot(
  integrity: UploadOriginalIntegrity,
  bytes: number,
): UploadOriginalIntegrity {
  if (!isUploadOriginalIntegrity(integrity, bytes))
    throw new Error('Invalid managed original integrity');
  const copy = { ...integrity, chunkSha256: integrity.chunkSha256.slice() };
  Object.freeze(copy.chunkSha256);
  return Object.freeze(copy);
}

async function closeStreams(...values: (Readable | undefined)[]): Promise<void> {
  const streams = [...new Set(values.filter((value): value is Readable => value !== undefined))];
  const closed = streams.map((stream) =>
    finished(stream, { cleanup: true }).catch(() => undefined),
  );
  for (const stream of streams) stream.destroy();
  await Promise.all(closed);
  for (const stream of streams) stream.off('error', ignoreStreamError);
}

/** Server-only namespace: independent of display filename, URL, tenant input or browser key. */
export function managedOriginalKey(input: {
  operationId: string;
  generation: number;
  tenantId: string | null;
  userId: string;
}): string {
  uploadAttemptId(input);
  if (
    (input.tenantId !== null && (typeof input.tenantId !== 'string' || !input.tenantId)) ||
    !input.userId
  )
    throw new Error('Missing managed object principal');
  return getS3Key({
    tenantId: input.tenantId,
    userId: input.userId,
    basePath: 'managed-uploads',
    fileName: `${input.operationId}.${input.generation}__original`,
  });
}

function validKey(key: string): boolean {
  const parsed = parseS3Key(key);
  return (
    !!parsed &&
    key === getS3Key(parsed) &&
    parsed.basePath === 'managed-uploads' &&
    /^[a-zA-Z0-9_-]{1,128}\.[1-9][0-9]{0,14}__original$/.test(parsed.fileName)
  );
}

export type ManagedStorageObservation = {
  operation: 'put' | 'read' | 'remove';
  outcome: 'durable' | 'unknown' | 'absent' | 'error';
  durationSeconds: number;
  observedAtMs: number;
};

function missing(error: unknown) {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    value?.name === 'NoSuchKey' ||
    value?.name === 'NotFound' ||
    value?.$metadata?.httpStatusCode === 404
  );
}

/** Credentials/client configuration belong to the existing S3 composition owner. */
export function createManagedS3Storage(options: {
  client: S3Client;
  bucket: string;
  urlForKey?: (key: string) => Promise<string>;
  observeBackend?: (observation: ManagedStorageObservation) => void;
  observeBackendService?: (observation: {
    outcome: 'success' | 'error';
    durationSeconds: number;
    observedAtMs: number;
  }) => void;
}): StoragePort {
  if (!options.bucket) throw new Error('Missing managed storage bucket');
  const { client, bucket: Bucket } = options;
  const observe = (
    operation: ManagedStorageObservation['operation'],
    outcome: ManagedStorageObservation['outcome'],
    started: number,
  ) => {
    try {
      options.observeBackend?.({
        operation,
        outcome,
        durationSeconds: (performance.now() - started) / 1000,
        observedAtMs: Date.now(),
      });
    } catch {
      // Telemetry cannot turn a durable write into a failure or release capacity.
    }
  };
  const observeService = (outcome: 'success' | 'error', started: number) => {
    try {
      options.observeBackendService?.({
        outcome,
        durationSeconds: (performance.now() - started) / 1000,
        observedAtMs: Date.now(),
      });
    } catch {
      /* observational only */
    }
  };
  return {
    async put(input) {
      const Key = managedOriginalKey(input.lease);
      const { operationId, generation } = input.lease;
      const { bytes, mediaType, signal } = input;
      const integrity = identitySnapshot(input.integrity, bytes);
      const started = performance.now();
      const receipt = { source: 's3', filepath: Key, storageKey: Key, bytes };
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_BYTES) {
        throw new Error('Invalid managed object size');
      }
      const source =
        input.body instanceof Readable
          ? input.body
          : Readable.from(input.body, { objectMode: false, highWaterMark: 64 * 1024 });
      source.on('error', ignoreStreamError);
      let body: Readable | undefined;
      const abort = () => {
        source.destroy();
        body?.destroy();
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (signal.aborted) return { ...receipt, outcome: 'absent' };
        receipt.filepath = await (options.urlForKey?.(Key) ??
          getSignedUrl(client, new GetObjectCommand({ Bucket, Key }), { expiresIn: 120 }));
        if (signal.aborted) return { ...receipt, outcome: 'absent' };
        if (!isUploadStorageReceipt({ ...receipt, outcome: 'absent' }))
          throw new Error('Invalid managed original locator');
        let complete = false;
        body = Readable.from(
          (async function* () {
            yield* verifyOriginalIntegrity(source, bytes, integrity, signal);
            complete = true;
          })(),
          { objectMode: false, highWaterMark: 64 * 1024 },
        );
        body.on('error', ignoreStreamError);
        try {
          const result = await client.send(
            new PutObjectCommand({
              Bucket,
              Key,
              Body: body,
              ContentLength: bytes,
              ContentType: mediaType,
              IfNoneMatch: '*',
              Metadata: { operation: operationId, generation: String(generation) },
            }),
            { abortSignal: signal },
          );
          const durable: UploadStorageReceipt = {
            ...receipt,
            outcome: 'durable',
            integrity,
            ...(result.ETag !== undefined ? { etag: result.ETag } : {}),
            ...(result.VersionId !== undefined ? { versionId: result.VersionId } : {}),
          };
          if (!complete || signal.aborted || !isUploadStorageReceipt(durable)) {
            observe('put', 'unknown', started);
            return { ...receipt, outcome: 'unknown' };
          }
          observe('put', 'durable', started);
          return durable;
        } catch {
          // An abort, integrity failure or missing acknowledgement after dispatch can follow
          // a partial or completed remote write. The existing cleanup owner retains capacity.
          observe('put', 'unknown', started);
          return { ...receipt, outcome: 'unknown' };
        }
      } finally {
        signal.removeEventListener('abort', abort);
        await closeStreams(source, body);
      }
    },
    read({ original, signal }) {
      if (
        !isUploadStorageReceipt(original) ||
        original.source !== 's3' ||
        original.outcome !== 'durable' ||
        !validKey(original.storageKey) ||
        !isUploadOriginalIntegrity(original.integrity, original.bytes)
      ) {
        throw new Error('Invalid managed original');
      }
      const { bytes, storageKey, versionId } = original;
      const integrity = identitySnapshot(original.integrity, bytes);
      return (async function* () {
        signal.throwIfAborted();
        const started = performance.now();
        let body: Readable | undefined;
        const abort = () => body?.destroy();
        let outcome: ManagedStorageObservation['outcome'] = 'error';
        signal.addEventListener('abort', abort, { once: true });
        try {
          const serviceStarted = performance.now();
          const result = await client
            .send(
              new GetObjectCommand({
                Bucket,
                Key: storageKey,
                ...(versionId ? { VersionId: versionId } : {}),
              }),
              { abortSignal: signal },
            )
            .then(
              (value) => {
                observeService('success', serviceStarted);
                return value;
              },
              (error: unknown) => {
                observeService('error', serviceStarted);
                throw error;
              },
            );
          if (!(result.Body instanceof Readable)) throw new Error('Managed original unavailable');
          body = result.Body;
          body.on('error', ignoreStreamError);
          if (signal.aborted) abort();
          yield* verifyOriginalIntegrity(body, bytes, integrity, signal);
          outcome = 'durable';
        } finally {
          signal.removeEventListener('abort', abort);
          await closeStreams(body);
          observe('read', outcome, started);
        }
      })();
    },
    async remove({ operationId, generation, tenantId, userId, signal }) {
      const Key = managedOriginalKey({ operationId, generation, tenantId, userId });
      const started = performance.now();
      let outcome: 'absent' | 'unknown' = 'unknown';
      try {
        signal.throwIfAborted();
        // Delete the current object first. Never confuse a versioned delete marker with
        // physical reclamation: enumerate and remove this exact key's retained versions.
        await client.send(new DeleteObjectCommand({ Bucket, Key }), { abortSignal: signal });
        for (let pass = 0; pass < 8; pass++) {
          const versions = await client.send(
            new ListObjectVersionsCommand({ Bucket, Prefix: Key, MaxKeys: 128 }),
            { abortSignal: signal },
          );
          const entries = [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])].filter(
            (entry) => entry.Key === Key,
          );
          if (entries.length === 0 && !versions.IsTruncated) {
            const serviceStarted = performance.now();
            try {
              await client.send(new HeadObjectCommand({ Bucket, Key }), { abortSignal: signal });
              observeService('success', serviceStarted);
              return 'unknown';
            } catch (error) {
              observeService(missing(error) ? 'success' : 'error', serviceStarted);
              outcome = missing(error) ? 'absent' : 'unknown';
              return outcome;
            }
          }
          if (entries.length === 0) return 'unknown';
          for (const entry of entries) {
            if (!entry.VersionId) return 'unknown';
            await client.send(
              new DeleteObjectCommand({ Bucket, Key, VersionId: entry.VersionId }),
              { abortSignal: signal },
            );
          }
        }
        return 'unknown';
      } catch {
        // Unsupported version listing is also unknown; no false capacity release.
        return 'unknown';
      } finally {
        observe('remove', outcome, started);
      }
    },
  };
}
