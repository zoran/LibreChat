/** NAS original custody: one acknowledged dispatch, private verified reads and owned cleanup. */
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { uploadDigest } from '@librechat/data-schemas';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  isUploadOriginalIntegrity,
  isUploadStorageReceipt,
  readNasS3Backend,
  readNasUploadWriteBinding,
} from 'librechat-data-provider';
import type {
  NasDeletionReceipt,
  NasS3Backend,
  NasOriginalWriteJournal,
  NasUploadWriteBinding,
  UploadOriginalIntegrity,
  UploadPrincipal,
  UploadStorageReceipt,
} from 'librechat-data-provider';
import type { JobClaim, UploadNasMethods } from '@librechat/data-schemas';
import type { S3Client } from '@aws-sdk/client-s3';
import type { StoragePort } from '../../uploads/contract';
import { verifyOriginalIntegrity } from '../../uploads/storage/integrity';
import { getNasS3ClientCapture } from './client';
import { dispatchNasWrite } from './write';

export type NasReadAuthority = Readonly<{ principal: UploadPrincipal; operationId: string }>;
export type NasCleanupResult =
  | { state: 'pending' }
  | { state: 'complete'; receipt: NasDeletionReceipt; consumerCommitId: string };

/** Principal context is supplied by the existing authenticated File/processing owner. */
export interface NasStoragePort extends StoragePort {
  readonly kind: 'nas-s3';
  cleanupOriginal(
    input: NasReadAuthority & {
      claim?: JobClaim;
      signal: AbortSignal;
      deadlineAtMs: number;
    },
  ): Promise<NasCleanupResult>;
}

export type NasStorageOptions = {
  client: S3Client;
  repository: UploadNasMethods;
  now?: () => number;
  /** Same canonical availability owner as the normal platform; missing always denies new writes. */
  assertWriteSafe?: () => void;
};

export type NasS3StorageCapture = Readonly<{
  kind: 'nas-s3';
  backend: NasS3Backend;
  bucket: string;
  clientInstanceId: string;
}>;
const captures = new WeakMap<StoragePort, { client: S3Client; value: NasS3StorageCapture }>();
/** A property named kind is not authority; only a factory/client-captured adapter is recognized. */
export function getNasS3StorageCapture(storage: StoragePort): NasS3StorageCapture | undefined {
  const captured = captures.get(storage);
  const client = captured && getNasS3ClientCapture(captured.client);
  return client?.instanceId === captured?.value.clientInstanceId ? captured?.value : undefined;
}
export function isNasStoragePort(storage: StoragePort): storage is NasStoragePort {
  return getNasS3StorageCapture(storage) !== undefined;
}

const unavailable = () => new Error('NAS original custody unavailable');
const ignoreStreamError = () => {
  /* finished() owns stream settlement. */
};
const same = (a: unknown, b: unknown): boolean => uploadDigest(a) === uploadDigest(b);

function integritySnapshot(value: UploadOriginalIntegrity, bytes: number): UploadOriginalIntegrity {
  if (!isUploadOriginalIntegrity(value, bytes)) throw unavailable();
  return { ...value, chunkSha256: value.chunkSha256.slice() };
}

async function closeStreams(...values: (Readable | undefined)[]): Promise<void> {
  const streams = [...new Set(values.filter((value): value is Readable => value !== undefined))];
  const settled = streams.map((stream) =>
    finished(stream, { cleanup: true }).catch(() => undefined),
  );
  for (const stream of streams) stream.destroy();
  await Promise.all(settled); // Timeout/abort is never substituted for an actual local join.
  for (const stream of streams) stream.off('error', ignoreStreamError);
}

function status(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const metadata: unknown = Reflect.get(error, '$metadata');
  if (!metadata || typeof metadata !== 'object') return undefined;
  const code: unknown = Reflect.get(metadata, 'httpStatusCode');
  return typeof code === 'number' ? code : undefined;
}

function capturedText(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || Buffer.byteLength(value) > 1024 || /[\r\n\0]/.test(value))
    throw unavailable();
  return value;
}

/** This adapter never creates a client, selects ambient credentials, or relies on conditional PUT. */
export function createNasS3Storage(options: NasStorageOptions): NasStoragePort {
  const { client, repository } = options;
  const initial = getNasS3ClientCapture(client);
  const backend = initial && readNasS3Backend(initial.backend);
  if (!initial || !backend || initial.maxAttempts !== 1 || !initial.forcePathStyle)
    throw unavailable();
  const bucket = initial.bucket;
  const now = options.now ?? Date.now;
  const capture = () => {
    const current = getNasS3ClientCapture(client);
    if (
      !current ||
      current.instanceId !== initial.instanceId ||
      current.bucket !== bucket ||
      !same(current.backend, backend) ||
      current.maxAttempts !== 1
    )
      throw unavailable();
  };
  const binding = (value: unknown): NasUploadWriteBinding => {
    capture();
    const parsed = readNasUploadWriteBinding(value);
    if (!parsed || parsed.bucket !== bucket || !same(parsed.backend, backend)) throw unavailable();
    return parsed;
  };
  const receipt = (
    value: NasUploadWriteBinding,
    outcome: UploadStorageReceipt['outcome'],
    integrity?: UploadOriginalIntegrity,
    etag?: string | null,
  ): UploadStorageReceipt => {
    const filepath = `/api/files/managed/${value.operationId}`;
    if (/^https?:\/\//i.test(filepath) || !filepath || filepath.length > 4096) throw unavailable();
    const result: UploadStorageReceipt = {
      outcome,
      bytes: value.bytes,
      source: 'nas-s3',
      filepath,
      storageKey: value.key,
      backend: value.backend,
      ...(integrity ? { integrity } : {}),
      ...(etag == null ? {} : { etag }),
    };
    if (!isUploadStorageReceipt(result)) throw unavailable();
    return result;
  };
  const owned = async (authority: NasReadAuthority) => {
    capture();
    const state = await repository.readNasOriginalWrite(authority.principal, authority.operationId);
    if (!state || state.binding.operationId !== authority.operationId) throw unavailable();
    return { ...state, binding: binding(state.binding) };
  };
  const verified = (
    value: NasUploadWriteBinding,
    original: NasOriginalWriteJournal,
    integrity: UploadOriginalIntegrity,
  ): boolean =>
    original.state === 'verified' &&
    original.response?.status === 200 &&
    original.response.versionId === null &&
    isUploadOriginalIntegrity(integrity, value.bytes) &&
    integrity.sha256 === value.wholeSHA256 &&
    original.integritySha256 === uploadDigest(integrity);

  async function* readBytes(
    value: NasUploadWriteBinding,
    integrity: UploadOriginalIntegrity,
    signal: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    capture();
    signal.throwIfAborted();
    let body: Readable | undefined;
    const abort = () => body?.destroy();
    signal.addEventListener('abort', abort, { once: true });
    try {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: value.key }), {
        abortSignal: signal,
      });
      if (result.Body instanceof Readable) {
        body = result.Body;
        body.on('error', ignoreStreamError);
      }
      if (
        !body ||
        result.$metadata.httpStatusCode !== 200 ||
        result.VersionId !== undefined ||
        result.ContentLength !== value.bytes
      )
        throw unavailable();
      if (signal.aborted) abort();
      yield* verifyOriginalIntegrity(body, value.bytes, integrity, signal);
    } finally {
      signal.removeEventListener('abort', abort);
      await closeStreams(body);
    }
  }
  const absence = async (
    value: NasUploadWriteBinding,
    signal: AbortSignal,
  ): Promise<404 | null> => {
    capture();
    signal.throwIfAborted();
    try {
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key: value.key }), {
        abortSignal: signal,
      });
      return null;
    } catch (error) {
      return status(error) === 404 ? 404 : null;
    }
  };

  const storage: NasStoragePort = {
    kind: 'nas-s3',
    async put(input) {
      const integrity = integritySnapshot(input.integrity, input.bytes);
      if (!input.securityApproval) throw unavailable();
      capture();
      const principal: UploadPrincipal =
        input.lease.tenantId === null
          ? { authentication: 'guest', tenantId: null, userId: input.lease.userId }
          : {
              authentication: 'verified-email',
              tenantId: input.lease.tenantId,
              userId: input.lease.userId,
            };
      const source =
        input.body instanceof Readable
          ? input.body
          : Readable.from(input.body, { objectMode: false });
      source.on('error', ignoreStreamError);
      let outbound: Readable | undefined;
      try {
        const result = await repository.dispatchNasOriginalWrite(
          input.lease,
          {
            backend,
            bucket,
            operationId: input.lease.operationId,
            generation: String(input.lease.generation),
            bytes: input.bytes,
            wholeSHA256: integrity.sha256,
            mediaType: input.mediaType,
          },
          integrity,
          input.securityApproval,
          now(),
          async (supplied, observer) => {
            const value = binding(supplied);
            if (
              value.operationId !== input.lease.operationId ||
              value.generation !== String(input.lease.generation) ||
              value.bytes !== input.bytes ||
              value.wholeSHA256 !== integrity.sha256 ||
              value.mediaType !== input.mediaType
            )
              throw unavailable();
            const remaining = Date.parse(value.originalDeadline) - now();
            if (input.signal.aborted || remaining <= 0) {
              await observer.notDispatched(); // This closure has not called client.send, ever.
              return;
            }
            if (remaining > 300_000) throw unavailable();
            const originalSignal = AbortSignal.timeout(remaining); // Browser cancellation cannot renew/erase the original.
            let complete = false;
            outbound = Readable.from(
              (async function* () {
                yield* verifyOriginalIntegrity(source, value.bytes, integrity, originalSignal);
                complete = true;
              })(),
              { objectMode: false },
            );
            outbound.on('error', ignoreStreamError);
            const abort = () => {
              source?.destroy();
              outbound?.destroy();
            };
            originalSignal.addEventListener('abort', abort, { once: true });
            try {
              capture();
              const response = await dispatchNasWrite(options.assertWriteSafe, observer, () =>
                client.send(
                  new PutObjectCommand({
                    Bucket: bucket,
                    Key: value.key,
                    Body: outbound,
                    ContentLength: value.bytes,
                    ContentType: value.mediaType,
                    Metadata: {
                      operation: value.operationId,
                      generation: value.generation,
                      'cortex-upload-bytes': String(value.bytes),
                      'cortex-upload-sha256': value.wholeSHA256,
                      'cortex-upload-deadline': value.originalDeadline,
                    },
                  }),
                  { abortSignal: originalSignal },
                ),
              );
              if (!response || response.$metadata.httpStatusCode !== 200) return;
              const versionId = capturedText(response.VersionId);
              await observer.acknowledge200({
                status: 200,
                requestId: capturedText(response.$metadata.requestId),
                etag: capturedText(response.ETag),
                versionId,
                observedAt: now(),
              }); // Persist authentic ACK before a verification GET, including unexpected versions.
              await closeStreams(source, outbound);
              if (versionId !== null || !complete || originalSignal.aborted) return;
              for await (const _chunk of readBytes(value, integrity, originalSignal)) {
                /* Full byte/hash verification. */
              }
              if (originalSignal.aborted || now() > Date.parse(value.originalDeadline)) return;
              await observer.verified(integrity);
            } finally {
              originalSignal.removeEventListener('abort', abort);
              await closeStreams(source, outbound);
            }
          },
        );
        const state = await owned({ principal, operationId: input.lease.operationId });
        if (!same(state.binding, result.binding)) throw unavailable();
        if (
          verified(state.binding, state.original, integrity) &&
          !state.cleanup &&
          now() <= Date.parse(state.binding.originalDeadline)
        )
          return receipt(state.binding, 'durable', integrity, state.original.response?.etag);
        return receipt(state.binding, 'unknown');
      } catch {
        const state = await owned({ principal, operationId: input.lease.operationId });
        return receipt(state.binding, 'unknown'); // A rejected send/local abort is never remote absence.
      } finally {
        await closeStreams(source, outbound);
      }
    },
    async observeOriginal(input) {
      input.signal.throwIfAborted();
      const value = binding(input.binding);
      const state = await owned({ principal: input.principal, operationId: value.operationId });
      if (!same(state.binding, value)) throw unavailable();
      const integrity = integritySnapshot(input.integrity, state.binding.bytes);
      return verified(state.binding, state.original, integrity) && !state.cleanup
        ? receipt(state.binding, 'durable', integrity, state.original.response?.etag)
        : receipt(state.binding, 'unknown');
    },
    async *read(input) {
      const state = await owned(input);
      const original = input.original;
      if (
        !isUploadStorageReceipt(original) ||
        original.outcome !== 'durable' ||
        original.source !== 'nas-s3' ||
        original.storageKey !== state.binding.key ||
        original.bytes !== state.binding.bytes ||
        !same(original.backend, backend) ||
        original.versionId !== undefined ||
        !original.integrity ||
        state.cleanup ||
        !verified(state.binding, state.original, original.integrity)
      )
        throw unavailable();
      yield* readBytes(
        state.binding,
        integritySnapshot(original.integrity, original.bytes),
        input.signal,
      );
    },
    async cleanupOriginal(input) {
      if (
        input.signal.aborted ||
        !Number.isSafeInteger(input.deadlineAtMs) ||
        input.deadlineAtMs <= now() ||
        input.deadlineAtMs - now() > 300_000
      )
        return { state: 'pending' };
      const signal = AbortSignal.any([
        input.signal,
        AbortSignal.timeout(Math.max(1, input.deadlineAtMs - now())),
      ]);
      try {
        capture();
        let result = await repository.observeNasCleanup(
          input.principal,
          input.operationId,
          async (supplied) => absence(binding(supplied), signal),
        );
        if (!result)
          result = await repository.dispatchNasCleanup(
            input.principal,
            input.operationId,
            async (supplied, observer) => {
              const value = binding(supplied);
              signal.throwIfAborted();
              const response = await client.send(
                new DeleteObjectCommand({ Bucket: bucket, Key: value.key }),
                { abortSignal: signal },
              );
              const code = response.$metadata.httpStatusCode;
              if (code !== 200 && code !== 204) return;
              await observer.deleted(code); // Real original DELETE ACK is durable before any absence read.
              if ((await absence(value, signal)) === 404) await observer.absent404();
            },
            input.claim,
          );
        if (!result) return { state: 'pending' };
        if (!same(result.backend, backend) || result.scope !== 'nas-live-key-absent')
          return { state: 'pending' };
        const consumerCommitId = await repository.consumeNasCleanup(
          input.principal,
          input.operationId,
          input.claim,
        );
        return consumerCommitId
          ? { state: 'complete', receipt: result, consumerCommitId }
          : { state: 'pending' };
      } catch {
        return { state: 'pending' };
      }
    },
    describeDeletion() {
      throw new Error('NAS cleanup requires its authenticated repository port');
    },
    async beginDeletion(input) {
      return { ...input.binding, state: 'unknown' };
    },
    async observeDeletion(input) {
      return { ...input.binding, state: 'unknown' };
    },
    async acknowledgeDeletionConsumed() {
      return { state: 'unknown' };
    },
    async remove() {
      return 'unknown';
    },
  };
  captures.set(storage, {
    client,
    value: Object.freeze({
      kind: 'nas-s3',
      backend: Object.freeze({ ...backend }),
      bucket,
      clientInstanceId: initial.instanceId,
    }),
  });
  return Object.freeze(storage);
}
