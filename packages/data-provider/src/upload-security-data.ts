/** upload-security-data owns closed own-data validation for security and antivirus contracts. */
import type { UploadSecuritySubject } from './upload-security';
import { UPLOAD_MAX_FILE_BYTES } from './upload-management';
const SUBJECT_KEYS = [
  'tenantId',
  'userId',
  'operationId',
  'transferGeneration',
  'mediaType',
  'bytes',
  'sha256',
] as const;

export function readClosedRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length) return null;
    const record: Record<string, unknown> = Object.create(null);
    for (const key of ownKeys) {
      if (typeof key !== 'string' || !keys.includes(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value'))
        return null;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    // Revoked proxies and failed reflection are invalid input, never validation exceptions.
    return null;
  }
}

export function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    !/[^a-zA-Z0-9_.-]/.test(value)
  );
}

export function hash(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && !/[^a-f0-9]/.test(value);
}

export function positiveInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;
}

export function mediaType(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 127) return false;
  const match = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.exec(value);
  return match?.[0] === value;
}

export function scannerVersion(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[a-zA-Z0-9]/.test(value) &&
    !/[^a-zA-Z0-9._:+/-]/.test(value)
  );
}

export function checkedAt(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

/** Detached subject data for trusted server consumers; no accessor or inherited field is read. */
export function readUploadSecuritySubject(value: unknown): UploadSecuritySubject | null {
  const record = readClosedRecord(value, SUBJECT_KEYS);
  if (
    !record ||
    (record.tenantId !== null &&
      (!identifier(record.tenantId) || record.tenantId === '__SYSTEM__')) ||
    !identifier(record.userId) ||
    !identifier(record.operationId) ||
    !positiveInteger(record.transferGeneration) ||
    !mediaType(record.mediaType) ||
    !positiveInteger(record.bytes, UPLOAD_MAX_FILE_BYTES) ||
    !hash(record.sha256)
  )
    return null;
  return {
    tenantId: record.tenantId,
    userId: record.userId,
    operationId: record.operationId,
    transferGeneration: record.transferGeneration,
    mediaType: record.mediaType,
    bytes: record.bytes,
    sha256: record.sha256,
  };
}

export function uuidV4(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === 36 &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
  );
}

/** Validate and detach every nested value before any consumer can await or persist it. */
