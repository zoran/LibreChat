/** Private provenance for trusted upload consumers; never a public upload authorization. */
import type { UploadSecuritySubject } from './upload-security';
import type { UploadScope } from './upload-management';
import { readUploadSecuritySubject } from './upload-security';

export const UPLOAD_DERIVED_MAX_SOURCES: number = 64;
export const UPLOAD_DERIVED_MAX_DESCENDANTS: number = 64;
export const UPLOAD_DERIVED_MAX_ORIGIN_BYTES: number = 16 * 1024;

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
  /** Immutable actual original-receipt binding; captured expiry is provenance only. */
  sourceBindingSha256: string;
  expiresAt: number;
};
export type UploadDerivedOrigin = UploadDerivedIntent & {
  version: 2;
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

export type HistoricalUploadDerivedOrigin = UploadDerivedIntent & {
  version: 1;
  ancestors: Omit<UploadDerivedSource, 'sourceBindingSha256'>[];
};

/** Historical parsing grants custody only; all current authorization accepts v2 exclusively. */
export function readHistoricalUploadDerivedOrigin(
  value: unknown,
): UploadDerivedOrigin | HistoricalUploadDerivedOrigin | null {
  return parseOrigin(value, 2) ?? parseOrigin(value, 1);
}
export function readUploadDerivedOrigin(value: unknown): UploadDerivedOrigin | null {
  return parseOrigin(value, 2) as UploadDerivedOrigin | null;
}
function parseOrigin(
  value: unknown,
  version: 1 | 2,
): UploadDerivedOrigin | HistoricalUploadDerivedOrigin | null {
  try {
    const input = record(value, ['version', 'binding', 'directSourceFileIds', 'ancestors']);
    if (!input || input.version !== version) return null;
    const captured = intent(input.binding, input.directSourceFileIds);
    const sources = array(input.ancestors);
    if (!captured || !sources) return null;
    const ancestors: UploadDerivedSource[] = [];
    const ids = new Set<string>();
    for (const value of sources) {
      const source = record(value, [
        'subject',
        'policySha256',
        'expiresAt',
        ...(version === 2 ? ['sourceBindingSha256'] : []),
      ]);
      if (!source) return null;
      const subject = readUploadSecuritySubject(source.subject);
      if (
        !subject ||
        ids.has(subject.operationId) ||
        typeof source.policySha256 !== 'string' ||
        source.policySha256.length !== 64 ||
        /[^a-f0-9]/.test(source.policySha256) ||
        (version === 2 &&
          (typeof source.sourceBindingSha256 !== 'string' ||
            !/^[a-f0-9]{64}$/.test(source.sourceBindingSha256))) ||
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
      ancestors.push({
        subject,
        policySha256: source.policySha256,
        expiresAt: source.expiresAt,
        ...(version === 2 ? { sourceBindingSha256: source.sourceBindingSha256 as string } : {}),
      } as UploadDerivedSource);
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
    const origin = { version, ...captured, ancestors } as
      | UploadDerivedOrigin
      | HistoricalUploadDerivedOrigin;
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

/** Dates are capture provenance; current parent caps are resolved by the File owner. */
export function sameUploadDerivedSource(a: UploadDerivedSource, b: UploadDerivedSource): boolean {
  return (
    a.sourceBindingSha256 === b.sourceBindingSha256 &&
    a.policySha256 === b.policySha256 &&
    JSON.stringify(a.subject) === JSON.stringify(b.subject)
  );
}
export function sameUploadDerivedOrigin(a: UploadDerivedOrigin, b: UploadDerivedOrigin): boolean {
  return (
    JSON.stringify(a.binding) === JSON.stringify(b.binding) &&
    JSON.stringify(a.directSourceFileIds) === JSON.stringify(b.directSourceFileIds) &&
    a.ancestors.length === b.ancestors.length &&
    a.ancestors.every((source, index) => sameUploadDerivedSource(source, b.ancestors[index]))
  );
}
