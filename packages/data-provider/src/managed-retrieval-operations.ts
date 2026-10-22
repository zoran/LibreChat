/** Managed v1 operation wire. File owns authority; validated messages grant none. */
import { z } from 'zod';
import type { ManagedIndexKey, ManagedRevision, ManagedSha256 } from './managed-retrieval';
import type { ManagedDocumentResult } from './document-structure';
import {
  canonicalManagedJson,
  managedDigest,
  managedOwnerSchema,
  managedIndexKeySchema,
  managedRevisionSchema,
  managedEvidenceSchema,
  verifyManagedRevision,
  validateManagedEvidence,
} from './managed-retrieval';
import { readManagedDocumentResult, MANAGED_DOCUMENT_WIRE_MAX_BYTES } from './document-structure';

const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const keys = z
  .array(managedIndexKeySchema)
  .min(1)
  .max(32)
  .refine(
    (items) => new Set(items.map(canonicalManagedJson)).size === items.length,
    'Duplicate ordered source keys',
  );
const same = (a: unknown, b: unknown) => canonicalManagedJson(a) === canonicalManagedJson(b);
const need: (condition: unknown) => asserts condition = (condition) => {
  if (!condition) throw new Error('Managed retrieval binding mismatch');
};
function bounded(value: unknown): string {
  const raw = canonicalManagedJson(value);
  need(new TextEncoder().encode(raw).length <= MANAGED_DOCUMENT_WIRE_MAX_BYTES);
  return raw;
}

export const managedRetrievalLookupRequestSchema = z
  .object({
    version: z.literal(1),
    owner: managedOwnerSchema,
    operationId: id,
    requestedPurpose: z.enum(['index', 'query', 'purge', 'status']),
  })
  .strict();
const lookupReason = z.enum([
  'not_found',
  'backend_mismatch',
  'purpose_mismatch',
  'source_unavailable',
  'original_expired',
  'history_unavailable',
  'policy_unavailable',
  'status_contract_unselected',
]);
export type ManagedRetrievalLookupReason = z.infer<typeof lookupReason>;
export type ManagedRetrievalLookupRequest = z.infer<typeof managedRetrievalLookupRequestSchema>;
export const managedRetrievalLookupResponseSchema = z.discriminatedUnion('status', [
  z
    .object({ version: z.literal(1), status: z.literal('unavailable'), reason: lookupReason })
    .strict(),
  z
    .object({
      version: z.literal(1),
      status: z.literal('available'),
      timeUnit: z.literal('unix-seconds'),
      owner: managedOwnerSchema,
      operationId: id,
      original: z
        .object({
          purpose: z.enum(['index', 'query', 'purge']),
          originalSha256: hash,
          bodySha256: hash,
          backendIdentity: id,
          writerEpoch: integer,
          routePolicySha256: hash,
          rankingPolicySha256: hash.nullable(),
          indexGeneration: hash,
          policyProvenanceSha256: hash,
          admittedAt: integer,
          workDeadline: integer,
          technicalCleanupDeadline: integer,
        })
        .strict(),
      authority: z
        .object({
          purpose: z.enum(['index', 'query', 'purge']),
          requestSha256: hash,
          writerEpoch: integer,
          workDeadline: integer,
          routePolicySha256: hash,
          sourceExpiresAt: integer.nullable(),
          cleanupDeadline: integer.nullable(),
        })
        .strict(),
      sources: z
        .array(
          z
            .object({
              key: managedIndexKeySchema,
              revision: managedRevisionSchema,
              /** Historical admission evidence, never the current File authority. */
              originalExpiresAt: integer,
              currentExpiresAt: integer.nullable(),
              contentState: z.enum([
                'live',
                'expired',
                'revoked',
                'missing',
                'revision_mismatch',
                'policy_mismatch',
              ]),
              indexOriginal: z
                .object({
                  operationId: id,
                  requestSha256: hash,
                  writerEpoch: integer,
                  backendIdentity: id,
                  state: z.enum(['preparing', 'ready', 'unknown', 'purge_pending', 'purged']),
                })
                .strict(),
            })
            .strict(),
        )
        .min(1)
        .max(32),
    })
    .strict(),
]);
export type ManagedRetrievalLookup = z.infer<typeof managedRetrievalLookupResponseSchema>;

/** Shared File projection validator; freshness and deployment policy remain the consumer's job. */
export function validateManagedRetrievalLookup(
  value: unknown,
  selector: ManagedRetrievalLookupRequest,
  backendIdentity: string,
  sha256: ManagedSha256,
): ManagedRetrievalLookup {
  bounded(value);
  const request = managedRetrievalLookupRequestSchema.parse(selector);
  const response = managedRetrievalLookupResponseSchema.parse(value);
  if (response.status === 'unavailable') return response;
  const { original, authority, sources } = response;
  need(
    request.requestedPurpose !== 'status' &&
      original.purpose === request.requestedPurpose &&
      authority.purpose === original.purpose &&
      response.operationId === request.operationId &&
      same(response.owner, request.owner) &&
      original.backendIdentity === backendIdentity &&
      authority.requestSha256 === original.bodySha256 &&
      authority.writerEpoch === original.writerEpoch &&
      authority.workDeadline === original.workDeadline &&
      authority.routePolicySha256 === original.routePolicySha256,
  );
  keys.parse(sources.map((source) => source.key));
  need(
    original.admittedAt < original.workDeadline &&
      original.workDeadline <= original.admittedAt + (original.purpose === 'query' ? 120 : 900) &&
      original.technicalCleanupDeadline === original.workDeadline + 900,
  );
  need(original.purpose !== 'index' || sources.length === 1);
  for (const source of sources) {
    const revision = verifyManagedRevision(source.revision, sha256);
    need(
      same(revision.owner, request.owner) &&
        revision.sourceRevision === source.key.sourceRevision &&
        revision.representationRevision === source.key.representationRevision &&
        source.indexOriginal.backendIdentity === backendIdentity &&
        source.indexOriginal.writerEpoch === original.writerEpoch &&
        (original.purpose === 'purge' || source.key.indexGeneration === original.indexGeneration),
    );
    if (original.purpose === 'index')
      need(
        source.indexOriginal.operationId === request.operationId &&
          source.indexOriginal.requestSha256 === original.bodySha256,
      );
    if (original.purpose !== 'purge')
      need(
        source.contentState === 'live' &&
          source.currentExpiresAt !== null &&
          (original.purpose === 'query'
            ? source.indexOriginal.state === 'ready'
            : ['preparing', 'ready'].includes(source.indexOriginal.state)),
      );
  }
  if (original.purpose === 'purge') {
    need(authority.sourceExpiresAt === null && authority.cleanupDeadline === original.workDeadline);
  } else {
    need(
      authority.cleanupDeadline === null &&
        // Retention may advance; the original operation and token clocks do not.
        authority.sourceExpiresAt ===
          Math.min(...sources.map((source) => source.currentExpiresAt!)),
    );
  }
  return response;
}

const indexRequest = z
  .object({
    version: z.literal(1),
    operationId: id,
    key: managedIndexKeySchema,
    document: z.unknown(),
  })
  .strict();
const queryRequest = z
  .object({
    version: z.literal(1),
    operationId: id,
    keys,
    query: z.string().min(1),
    limit: integer.min(1).max(32),
  })
  .strict();
const purgeRequest = z
  .object({
    version: z.literal(1),
    purgeOperationId: id,
    keys,
    writerEpoch: integer,
  })
  .strict();
export type ManagedIndexRequest = Omit<z.infer<typeof indexRequest>, 'document'> & {
  document: ManagedDocumentResult;
};
export type ManagedQueryRequest = z.infer<typeof queryRequest>;
export type ManagedPurgeRequest = z.infer<typeof purgeRequest>;

export function readManagedRetrievalRequest(purpose: 'index', value: unknown): ManagedIndexRequest;
export function readManagedRetrievalRequest(purpose: 'query', value: unknown): ManagedQueryRequest;
export function readManagedRetrievalRequest(purpose: 'purge', value: unknown): ManagedPurgeRequest;
export function readManagedRetrievalRequest(
  purpose: 'index' | 'query' | 'purge',
  value: unknown,
): ManagedIndexRequest | ManagedQueryRequest | ManagedPurgeRequest {
  bounded(value);
  if (purpose === 'index') {
    const parsed = indexRequest.parse(value);
    const document = readManagedDocumentResult(parsed.document);
    need(document);
    return { ...parsed, document };
  }
  if (purpose === 'query') {
    const parsed = queryRequest.parse(value);
    need(/[^\t\r\n ]/.test(parsed.query));
    return parsed;
  }
  need(purpose === 'purge');
  return purgeRequest.parse(value);
}

const indexReceiptSchema = z
  .object({
    version: z.literal(1),
    operationId: id,
    requestSha256: hash,
    backendIdentity: id,
    writerEpoch: integer,
    key: managedIndexKeySchema,
    state: z.literal('ready'),
    completedAt: integer,
    receiptSha256: hash,
  })
  .strict();
export type ManagedIndexReceipt = z.infer<typeof indexReceiptSchema>;
export type ManagedIndexReceiptBinding = {
  operationId: string;
  requestSha256: string;
  backendIdentity: string;
  writerEpoch: number;
  key: ManagedIndexKey;
  admittedAt: number;
  workDeadline: number;
};

/** Call only after authenticated backend transport and fresh File-owned original lookup. */
export function verifyManagedIndexReceipt(
  value: unknown,
  binding: ManagedIndexReceiptBinding,
  sha256: ManagedSha256,
): ManagedIndexReceipt {
  bounded(value);
  const receipt = indexReceiptSchema.parse(value);
  const { receiptSha256, ...payload } = receipt;
  need(
    receiptSha256 === managedDigest(payload, sha256) &&
      receipt.operationId === binding.operationId &&
      receipt.requestSha256 === binding.requestSha256 &&
      receipt.backendIdentity === binding.backendIdentity &&
      receipt.writerEpoch === binding.writerEpoch &&
      same(receipt.key, binding.key) &&
      Number.isSafeInteger(binding.admittedAt) &&
      Number.isSafeInteger(binding.workDeadline) &&
      binding.admittedAt >= 0 &&
      binding.admittedAt <= receipt.completedAt &&
      receipt.completedAt < binding.workDeadline,
  );
  return receipt;
}

const queryResultSchema = z
  .object({
    version: z.literal(1),
    operationId: id,
    requestSha256: hash,
    backendIdentity: id,
    writerEpoch: integer,
    keys,
    rankingPolicySha256: hash,
    state: z.literal('complete'),
    hits: z
      .array(
        z
          .object({
            key: managedIndexKeySchema,
            evidence: managedEvidenceSchema,
            text: z.string().min(1),
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
export type ManagedQueryResult = z.infer<typeof queryResultSchema>;
export type ManagedQueryResultBinding = {
  operationId: string;
  requestSha256: string;
  backendIdentity: string;
  writerEpoch: number;
  keys: ManagedIndexKey[];
  rankingPolicySha256: string;
  limit: number;
};
export type ManagedRetrievalTrustedSource = {
  key: ManagedIndexKey;
  revision: ManagedRevision;
  document: ManagedDocumentResult;
};

/** Ordered hits carry rank; only exact current File evidence may become model context or citations. */
export function verifyManagedQueryResult(
  value: unknown,
  binding: ManagedQueryResultBinding,
  trustedSources: readonly ManagedRetrievalTrustedSource[],
  sha256: ManagedSha256,
): ManagedQueryResult {
  bounded(value);
  const response = queryResultSchema.parse(value);
  need(
    response.operationId === binding.operationId &&
      response.requestSha256 === binding.requestSha256 &&
      response.backendIdentity === binding.backendIdentity &&
      response.writerEpoch === binding.writerEpoch &&
      same(response.keys, binding.keys) &&
      response.rankingPolicySha256 === binding.rankingPolicySha256 &&
      Number.isSafeInteger(binding.limit) &&
      binding.limit >= 1 &&
      binding.limit <= 32 &&
      response.hits.length <= binding.limit &&
      same(
        trustedSources.map((source) => source.key),
        binding.keys,
      ),
  );
  const sources = new Map(
    trustedSources.map((source) => [canonicalManagedJson(source.key), source]),
  );
  const seen = new Set<string>();
  for (const hit of response.hits) {
    const source = sources.get(canonicalManagedJson(hit.key));
    const identity = canonicalManagedJson({ key: hit.key, evidence: hit.evidence });
    need(source && !seen.has(identity));
    need(
      hit.text === validateManagedEvidence(hit.evidence, source.revision, source.document, sha256),
    );
    need(
      source.revision.sourceRevision === hit.key.sourceRevision &&
        source.revision.representationRevision === hit.key.representationRevision,
    );
    seen.add(identity);
  }
  return response;
}
