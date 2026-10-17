/** Private provenance for trusted upload consumers; never a public upload authorization. */
import { UPLOAD_RETENTION_MS } from './upload-management';
import { readUploadSecuritySubject } from './upload-security';
import type { UploadScope } from './upload-management';
import type { UploadSecuritySubject } from './upload-security';

export const UPLOAD_DERIVED_MAX_SOURCES = 64;
export const UPLOAD_DERIVED_MAX_DESCENDANTS = 64;
export const UPLOAD_DERIVED_MAX_ORIGIN_BYTES = 16 * 1024;

export type UploadDerivedBinding = {
  purpose: 'workspace-draft';
  sourceId: string;
  sourceRevision: number;
};
export type UploadDerivedIntent = {
  binding: UploadDerivedBinding;
  directSourceFileIds: string[];
};
export type UploadDerivedSource = {
  subject: UploadSecuritySubject;
  policySha256: string;
  expiresAt: number;
};
export type UploadDerivedOrigin = UploadDerivedIntent & {
  version: 1;
  ancestors: UploadDerivedSource[];
};

function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length) return null;
  const result: Record<string, unknown> = Object.create(null);
  for (const key of actual) {
    if (typeof key !== 'string' || !keys.includes(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function array(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > UPLOAD_DERIVED_MAX_SOURCES)
    return null;
  if (Reflect.ownKeys(value).length !== length + 1) return null;
  const result: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    result.push(descriptor.value);
  }
  return result;
}

function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    !/[^a-zA-Z0-9_.-]/.test(value)
  );
}

function intent(bindingValue: unknown, idsValue: unknown): UploadDerivedIntent | null {
  const binding = record(bindingValue, ['purpose', 'sourceId', 'sourceRevision']);
  const ids = array(idsValue);
  if (
    !binding ||
    binding.purpose !== 'workspace-draft' ||
    !identifier(binding.sourceId) ||
    typeof binding.sourceRevision !== 'number' ||
    !Number.isSafeInteger(binding.sourceRevision) ||
    binding.sourceRevision < 0 ||
    !ids ||
    !ids.every(identifier) ||
    new Set(ids).size !== ids.length
  )
    return null;
  return {
    binding: {
      purpose: 'workspace-draft',
      sourceId: binding.sourceId,
      sourceRevision: binding.sourceRevision,
    },
    directSourceFileIds: ids.sort(),
  };
}

export function readUploadDerivedIntent(value: unknown): UploadDerivedIntent | null {
  try {
    const input = record(value, ['binding', 'directSourceFileIds']);
    return input ? intent(input.binding, input.directSourceFileIds) : null;
  } catch {
    return null;
  }
}

export function readUploadDerivedOrigin(value: unknown): UploadDerivedOrigin | null {
  try {
    const input = record(value, ['version', 'binding', 'directSourceFileIds', 'ancestors']);
    if (!input || input.version !== 1) return null;
    const captured = intent(input.binding, input.directSourceFileIds);
    const sources = array(input.ancestors);
    if (!captured || !sources) return null;
    const ancestors: UploadDerivedSource[] = [];
    const ids = new Set<string>();
    for (const value of sources) {
      const source = record(value, ['subject', 'policySha256', 'expiresAt']);
      if (!source) return null;
      const subject = readUploadSecuritySubject(source.subject);
      if (
        !subject ||
        ids.has(subject.operationId) ||
        typeof source.policySha256 !== 'string' ||
        source.policySha256.length !== 64 ||
        /[^a-f0-9]/.test(source.policySha256) ||
        typeof source.expiresAt !== 'number' ||
        !Number.isSafeInteger(source.expiresAt) ||
        source.expiresAt <= 0 ||
        source.expiresAt > 8_640_000_000_000_000
      )
        return null;
      const first = ancestors[0];
      if (
        first &&
        (first.subject.userId !== subject.userId ||
          first.subject.tenantId !== subject.tenantId ||
          first.policySha256 !== source.policySha256)
      )
        return null;
      ids.add(subject.operationId);
      ancestors.push({ subject, policySha256: source.policySha256, expiresAt: source.expiresAt });
    }
    if (
      !captured.directSourceFileIds.every((id) => ids.has(id)) ||
      (captured.directSourceFileIds.length === 0 && ancestors.length !== 0)
    )
      return null;
    ancestors.sort((a, b) => {
      if (a.subject.operationId < b.subject.operationId) return -1;
      return a.subject.operationId > b.subject.operationId ? 1 : 0;
    });
    const origin: UploadDerivedOrigin = { version: 1, ...captured, ancestors };
    return new TextEncoder().encode(JSON.stringify(origin)).length <=
      UPLOAD_DERIVED_MAX_ORIGIN_BYTES
      ? origin
      : null;
  } catch {
    return null;
  }
}

/** The stored source snapshot is captured once; retries compare this immutable request intent. */
export function uploadReservationFingerprint(
  input: { scope: UploadScope; mediaType: string; declaredBytes: number },
  derived?: UploadDerivedIntent,
): string {
  const values: unknown[] = [input.scope, input.mediaType, input.declaredBytes];
  if (derived !== undefined) {
    const snapshot = readUploadDerivedIntent(derived);
    if (!snapshot) throw new TypeError('Invalid derived upload intent');
    values.push(snapshot);
  }
  return JSON.stringify(values);
}

export function uploadDerivedExpiresAt(acceptedAt: number, origin?: UploadDerivedOrigin): number {
  const ownExpiry = acceptedAt + UPLOAD_RETENTION_MS;
  if (!Number.isSafeInteger(acceptedAt) || acceptedAt < 0 || ownExpiry > 8_640_000_000_000_000)
    throw new TypeError('Invalid upload acceptance time');
  if (origin === undefined) return ownExpiry;
  const snapshot = readUploadDerivedOrigin(origin);
  if (!snapshot) throw new TypeError('Invalid derived upload origin');
  return Math.min(ownExpiry, ...snapshot.ancestors.map((source) => source.expiresAt));
}
