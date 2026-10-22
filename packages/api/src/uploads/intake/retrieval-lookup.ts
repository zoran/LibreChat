/** Lookup-only transport on the existing private listener; File owns all authority. */
import { createHash } from 'node:crypto';
import {
  canonicalManagedJson,
  managedRetrievalLookupRequestSchema,
  validateManagedRetrievalLookup,
} from 'librechat-data-provider';
import type { ManagedRetrievalLookupRequest } from 'librechat-data-provider';

export type RetrievalLookupRequest = ManagedRetrievalLookupRequest;
/** Peer identity and the original Unix-millisecond dispatch deadline are server-owned arguments. */
export type RetrievalLookupHandler = (
  request: RetrievalLookupRequest,
  peer: Readonly<{ backendIdentity: string }>,
  signal: AbortSignal,
  deadlineAt: number,
) => Promise<unknown>;

export function readRetrievalLookup(raw: string): RetrievalLookupRequest {
  const value: unknown = JSON.parse(raw);
  if (canonicalManagedJson(value) !== raw) throw new Error('noncanonical lookup');
  return managedRetrievalLookupRequestSchema.parse(value);
}

export function encodeRetrievalLookup(
  value: unknown,
  request: RetrievalLookupRequest,
  backendIdentity: string,
): Buffer {
  validateManagedRetrievalLookup(value, request, backendIdentity, (text) =>
    createHash('sha256').update(text, 'utf8').digest('hex'),
  );
  return Buffer.from(canonicalManagedJson(value));
}
