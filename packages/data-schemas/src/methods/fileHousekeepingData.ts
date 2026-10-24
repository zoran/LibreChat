/** Shared closed-data primitives for the one File/HK contract and its history pages. */
import { createHash } from 'node:crypto';
import { canonicalManagedJson } from 'librechat-data-provider';
import type { FileCoverageFailureCode } from 'librechat-data-provider';

export class FileHistoryError extends Error {
  constructor(readonly code: FileCoverageFailureCode) {
    super(code);
  }
}

export const integer = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && !Object.is(v, -0) && v >= 0;
export const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const id = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
export const instant = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length === 24 &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
export const digest = (v: unknown): string =>
  createHash('sha256').update(canonicalManagedJson(v)).digest('hex');
export const same = (a: unknown, b: unknown): boolean =>
  canonicalManagedJson(a) === canonicalManagedJson(b);
export function shape(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(v))
  )
    return false;
  const own = Reflect.ownKeys(v);
  return (
    own.length === keys.length &&
    own.every((key) => {
      if (typeof key !== 'string' || !keys.includes(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      return descriptor?.enumerable === true && 'value' in descriptor;
    })
  );
}
/** BSON keys/types are represented as data, never coerced into the protocol's schema-key space. */
export function taggedSource(v: unknown): unknown {
  if (v === undefined) return ['missing'];
  if (v instanceof Date) {
    if (!Number.isFinite(v.getTime())) throw new FileHistoryError('unclassified');
    return ['date', v.toISOString()];
  }
  if (Array.isArray(v)) return ['array', v.map(taggedSource)];
  if (v && typeof v === 'object') {
    const bson = v as { _bsontype?: string; toHexString?: () => string; toString(): string };
    if (bson._bsontype === 'ObjectId') return ['object-id', bson.toHexString!()];
    if (bson._bsontype === 'Long' || bson._bsontype === 'Decimal128')
      return [bson._bsontype, bson.toString()];
    if (bson._bsontype) throw new FileHistoryError('unclassified');
    return [
      'object',
      Object.keys(v)
        .sort()
        .map((key) => [key, taggedSource((v as Record<string, unknown>)[key])]),
    ];
  }
  if (typeof v === 'number' && (!Number.isSafeInteger(v) || Object.is(v, -0)))
    return ['number', Object.is(v, -0) ? '-0' : String(v)];
  return v;
}
