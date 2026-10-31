/** upload-nas owns private acknowledged-only NAS identities; shapes never authenticate observations. */
import type { UploadOriginalWriteBinding } from './upload-management';

/** Immutable provider identity: changing configuration never repoints an existing original. */
export type NasS3Backend = Readonly<{
  kind: 'nas-s3';
  uid: string;
  configurationSha256: string;
  protocol: 'acknowledged-only-v1';
}>;

/** Server-selected unique key and original deadline; no second dispatch capability is serialized. */
export type NasUploadWriteBinding = Readonly<{
  version: 2;
  backend: NasS3Backend;
  bucket: string;
  key: string;
  operationId: string;
  generation: string;
  bytes: number;
  wholeSHA256: string;
  mediaType: string;
  originalDeadline: string;
}>;

/** The same UploadOperation retains ambiguous transport history across cancellation and takeover. */
export type NasOriginalWriteJournal = {
  version: 1;
  dispatchId: string;
  bindingSha256: string;
  state: 'intended' | 'unknown' | 'acknowledged' | 'verified' | 'not-dispatched';
  intendedAt: number;
  acknowledgedAt?: number;
  verifiedAt?: number;
  /** Digest of the actually verified complete integrity record; vectors stay in original receipts. */
  integritySha256?: string;
  response?: NasOriginalHttp200;
};

/** Captured by the trusted original transport; ETag is opaque and never replaces byte verification. */
export type NasOriginalHttp200 = Readonly<{
  status: 200;
  requestId: string | null;
  etag: string | null;
  versionId: string | null;
  observedAt: number;
}>;

/** Live-key absence only; this receipt does not assert snapshot, media or three-replica erasure. */
export type NasDeletionReceipt = Readonly<{
  protocol: 'nas-acknowledged-delete-v1';
  scope: 'nas-live-key-absent';
  backend: NasS3Backend;
  bindingSha256: string;
  requestId: string;
  originalTerminal: 'acknowledged' | 'not-dispatched';
  deleteStatus: 200 | 204;
  absenceStatus: 404;
}>;

/** Private receipt custody is consumed by the existing repository/File transaction, never a client. */
export type NasCleanupCustody = {
  version: 1;
  requestId: string;
  state: 'intended' | 'unknown' | 'deleted' | 'observed' | 'consumed';
  bindingSha256: string;
  deleteStatus?: 200 | 204;
  receipt?: NasDeletionReceipt;
  consumerCommitId?: string;
};

const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
/** Closed own-data reader avoids invoking accessors or trusting a prototype as provider authority. */
function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return Object.keys(result).length === keys.length ? result : null;
}

/** Shape only; the trusted composition independently selects and authenticates the backend. */
export function readNasS3Backend(value: unknown): NasS3Backend | null {
  try {
    const r = record(value, ['kind', 'uid', 'configurationSha256', 'protocol']);
    if (
      !r ||
      r.kind !== 'nas-s3' ||
      r.protocol !== 'acknowledged-only-v1' ||
      typeof r.uid !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(r.uid) ||
      !hash(r.configurationSha256)
    )
      return null;
    return {
      kind: 'nas-s3',
      uid: r.uid,
      configurationSha256: r.configurationSha256,
      protocol: 'acknowledged-only-v1',
    };
  } catch {
    return null;
  }
}

/** Full immutable binding reader; it does not infer dispatch/ACK/verification from a key or HEAD. */
export function readNasUploadWriteBinding(value: unknown): NasUploadWriteBinding | null {
  try {
    const r = record(value, [
      'version',
      'backend',
      'bucket',
      'key',
      'operationId',
      'generation',
      'bytes',
      'wholeSHA256',
      'mediaType',
      'originalDeadline',
    ]);
    const backend = r && readNasS3Backend(r.backend);
    if (
      !r ||
      !backend ||
      r.version !== 2 ||
      typeof r.bucket !== 'string' ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(r.bucket) ||
      typeof r.key !== 'string' ||
      r.key.length < 1 ||
      r.key.length > 4096 ||
      typeof r.operationId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(r.operationId) ||
      typeof r.generation !== 'string' ||
      !/^[1-9][0-9]{0,14}$/.test(r.generation) ||
      typeof r.bytes !== 'number' ||
      !Number.isSafeInteger(r.bytes) ||
      r.bytes < 1 ||
      r.bytes > 31_457_280 ||
      !hash(r.wholeSHA256) ||
      typeof r.mediaType !== 'string' ||
      !r.mediaType ||
      r.mediaType.length > 128 ||
      typeof r.originalDeadline !== 'string' ||
      !Number.isFinite(Date.parse(r.originalDeadline)) ||
      new Date(r.originalDeadline).toISOString() !== r.originalDeadline
    )
      return null;
    return {
      version: 2,
      backend,
      bucket: r.bucket,
      key: r.key,
      operationId: r.operationId,
      generation: r.generation,
      bytes: r.bytes,
      wholeSHA256: r.wholeSHA256,
      mediaType: r.mediaType,
      originalDeadline: r.originalDeadline,
    };
  } catch {
    return null;
  }
}

/** Read either genuine stored protocol binding without inferring or repointing its backend. */
export function readUploadOriginalWriteBinding(value: unknown): UploadOriginalWriteBinding | null {
  const nas = readNasUploadWriteBinding(value);
  if (nas) return nas;
  try {
    const r = record(value, [
      'version',
      'bucket',
      'key',
      'operationId',
      'generation',
      'bytes',
      'wholeSHA256',
      'mediaType',
      'originalDeadline',
    ]);
    if (
      !r ||
      r.version !== 1 ||
      typeof r.bucket !== 'string' ||
      !/^[a-z0-9][a-z0-9.-]{0,253}[a-z0-9]$/.test(r.bucket) ||
      typeof r.key !== 'string' ||
      new TextEncoder().encode(r.key).length > 4096 ||
      typeof r.operationId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(r.operationId) ||
      typeof r.generation !== 'string' ||
      !/^[1-9][0-9]{0,14}$/.test(r.generation) ||
      typeof r.bytes !== 'number' ||
      !Number.isSafeInteger(r.bytes) ||
      r.bytes < 1 ||
      r.bytes > 31_457_280 ||
      !hash(r.wholeSHA256) ||
      typeof r.mediaType !== 'string' ||
      !r.mediaType ||
      typeof r.originalDeadline !== 'string' ||
      !Number.isFinite(Date.parse(r.originalDeadline)) ||
      new Date(r.originalDeadline).toISOString() !== r.originalDeadline
    )
      return null;
    return {
      version: 1,
      bucket: r.bucket,
      key: r.key,
      operationId: r.operationId,
      generation: r.generation,
      bytes: r.bytes,
      wholeSHA256: r.wholeSHA256,
      mediaType: r.mediaType,
      originalDeadline: r.originalDeadline,
    };
  } catch {
    return null;
  }
}
