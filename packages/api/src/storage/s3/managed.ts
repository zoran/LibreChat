import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
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
import type { ManagedUploadWriteBinding, ManagedUploadWriteInput } from '@librechat/data-schemas';
import type { UploadOriginalIntegrity, UploadStorageReceipt } from 'librechat-data-provider';
import type { S3Client } from '@aws-sdk/client-s3';
import type {
  ManagedS3Provider,
  ManagedS3CommandCapture,
  UploadBackendCapture,
} from '../providerObservation';
import type { StoragePort } from '../../uploads/contract';
import { observeManagedOriginal, snapshotManagedWrite } from './managedUpload';
import { verifyOriginalIntegrity } from '../../uploads/storage/integrity';
import { observeStorageProviders } from '../providerObservation';
import { createManagedDeletionAdapter } from './managedDeletion';
import { uploadAttemptId } from '../../uploads/processing/paths';
import { getManagedS3ClientCapture } from './managedClient';
import { buildS3Key as getS3Key, parseS3Key } from './keys';

const captures = new WeakMap<
  StoragePort,
  { client: S3Client; commands: ManagedS3CommandCapture }
>();
/** Undefined backend means missing web custody; null is the explicit standalone HK composition. */
export function getManagedS3Provider(
  storage: StoragePort,
  backend: UploadBackendCapture | null | undefined,
): ManagedS3Provider {
  const captured = captures.get(storage);
  const client = captured && getManagedS3ClientCapture(captured.client);
  if (!captured || !client || backend === undefined) return Object.freeze({ state: 'unavailable' });
  return (
    observeStorageProviders(() => ({
      ordinaryS3: { state: 'not-owned' },
      managedS3: { state: 'captured', client, commands: captured.commands, backend },
    }))?.managedS3 ?? Object.freeze({ state: 'unavailable' })
  );
}

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
  const deletion = createManagedDeletionAdapter(client, Bucket);
  const deletionInput = (input: Parameters<StoragePort['beginDeletion']>[0]) => {
    if (input.request.generation !== String(input.generation))
      throw new Error('Managed deletion generation mismatch');
    return {
      binding: input.binding,
      key: managedOriginalKey(input),
      request: input.request,
      signal: input.signal,
      deadlineAtMs: input.deadlineAtMs,
    };
  };
  const storage: StoragePort = {
    describeDeletion: (input) => {
      if (input.request.generation !== String(input.generation))
        throw new Error('Managed deletion generation mismatch');
      return deletion.describe({ key: managedOriginalKey(input), request: input.request });
    },
    acknowledgeDeletionConsumed: (input) =>
      deletion.acknowledgeDeletionConsumed({
        ...deletionInput(input),
        receipt: input.receipt,
        consumerCommitId: input.consumerCommitId,
      }),
    beginDeletion: (input) => deletion.begin(deletionInput(input)),
    observeDeletion: (input) => deletion.observe(deletionInput(input)),
    async observeOriginal({ binding: supplied, integrity: suppliedIntegrity, signal }) {
      const binding = snapshotManagedWrite(supplied);
      const integrity = identitySnapshot(suppliedIntegrity, binding.bytes);
      if (
        binding.bucket !== Bucket ||
        !validKey(binding.key) ||
        binding.wholeSHA256 !== integrity.sha256
      )
        throw new Error('Managed original observation binding mismatch');
      const receipt = {
        source: 's3' as const,
        filepath: await (options.urlForKey?.(binding.key) ??
          getSignedUrl(client, new GetObjectCommand({ Bucket, Key: binding.key }), {
            expiresIn: 120,
          })),
        storageKey: binding.key,
        bytes: binding.bytes,
      };
      const result = await observeManagedOriginal(client, { binding, signal });
      if (result.state !== 'published') return { ...receipt, outcome: 'unknown' as const };
      const durable = { ...receipt, outcome: 'durable' as const, integrity, etag: result.etag };
      return isUploadStorageReceipt(durable)
        ? durable
        : { ...receipt, outcome: 'unknown' as const };
    },
    async put(input) {
      const Key = managedOriginalKey(input.lease);
      const { operationId, generation } = input.lease;
      const { bytes, mediaType } = input;
      let signal = input.signal;
      const integrity = identitySnapshot(input.integrity, bytes);
      const started = performance.now();
      const receipt = { source: 's3', filepath: Key, storageKey: Key, bytes };
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_BYTES) {
        throw new Error('Invalid managed object size');
      }
      const proposal: ManagedUploadWriteInput = {
        bucket: Bucket,
        key: Key,
        operationId,
        generation: String(generation),
        bytes,
        wholeSHA256: integrity.sha256,
        mediaType,
      };
      if (typeof input.bindWrite !== 'function')
        throw new Error('Missing managed write binding owner');
      const binding: ManagedUploadWriteBinding = { ...(await input.bindWrite(proposal)) };
      const bindingKeys = ['version', ...Object.keys(proposal), 'originalDeadline'].sort();
      if (
        !binding ||
        Object.getPrototypeOf(binding) !== Object.prototype ||
        Object.keys(binding).sort().join(',') !== bindingKeys.join(',') ||
        binding.version !== 1 ||
        Object.entries(proposal).some(
          ([key, value]) => binding[key as keyof ManagedUploadWriteBinding] !== value,
        ) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(binding.originalDeadline) ||
        !Number.isFinite(Date.parse(binding.originalDeadline)) ||
        new Date(binding.originalDeadline).toISOString() !== binding.originalDeadline ||
        Date.parse(binding.originalDeadline) <= Date.now()
      )
        throw new Error('Invalid or expired managed write binding');
      signal = AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.max(1, Date.parse(binding.originalDeadline) - Date.now())),
      ]);
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
        if (Date.parse(binding.originalDeadline) <= Date.now())
          throw new Error('Managed write deadline expired before dispatch');
        let complete = false;
        body = Readable.from(
          (async function* () {
            yield* verifyOriginalIntegrity(source, bytes, integrity, signal);
            complete = true;
          })(),
          { objectMode: false, highWaterMark: 64 * 1024 },
        );
        body.on('error', ignoreStreamError);
        const reconcile = async () => {
          if (!complete || input.signal.aborted) return;
          return storage
            .observeOriginal({ binding, integrity, signal: input.signal })
            .catch(() => undefined);
        };
        try {
          const result = await client.send(
            new PutObjectCommand({
              Bucket,
              Key,
              Body: body,
              ContentLength: bytes,
              ContentType: mediaType,
              IfNoneMatch: '*',
              Metadata: {
                operation: operationId,
                generation: String(generation),
                'cortex-upload-bytes': String(binding.bytes),
                'cortex-upload-sha256': binding.wholeSHA256,
                'cortex-upload-deadline': binding.originalDeadline,
              },
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
            const recovered = await reconcile();
            if (recovered?.outcome === 'durable') {
              observe('put', 'durable', started);
              return recovered;
            }
            observe('put', 'unknown', started);
            return { ...receipt, outcome: 'unknown' };
          }
          observe('put', 'durable', started);
          return durable;
        } catch {
          const recovered = await reconcile();
          if (recovered?.outcome === 'durable') {
            observe('put', 'durable', started);
            return recovered;
          }
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
  captures.set(storage, {
    client,
    commands: Object.freeze({ instanceId: randomUUID(), bucket: Bucket }),
  });
  return storage;
}
