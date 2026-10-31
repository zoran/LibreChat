/** Inactive managed retrieval v1 wire. File owns authority; this module grants none. */
import { z } from 'zod';
import type { ManagedDocumentResult } from './document-structure';
import type { UploadSecurityApproval } from './upload-security';
import { readHistoricalUploadSecurityApproval } from './upload-security';
import { readManagedDocumentResult } from './document-structure';

export const MANAGED_RETRIEVAL_VERSION = 1;
export const MANAGED_RETRIEVAL_ADMISSION_DEFAULT = false;
export const MANAGED_RETRIEVAL_FENCE_RULE =
  'Durable full-key source/work admission precedes every provider dispatch. Purge before first admission must durably tombstone the full key or remain pending; old epochs cannot create a source after the fence.';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(256);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const managedOwnerSchema = z.object({ tenantId: id.nullable(), userId: id }).strict();
export const managedSourceIdentitySchema = z
  .object({
    fileId: id,
    operationId: id,
    transferGeneration: integer.min(1),
    originalSha256: hash,
    originalBytes: integer.min(1).max(30 * 1024 * 1024),
    mediaType: z.string().min(1).max(127),
  })
  .strict();
export const managedRevisionSchema = z
  .object({
    version: z.literal(1),
    owner: managedOwnerSchema,
    source: managedSourceIdentitySchema,
    sourceRevision: hash,
    representationRevision: hash,
    textSha256: hash,
    structureSha256: hash,
    approvalSha256: hash,
    extractionPolicySha256: hash,
  })
  .strict();
export const managedEvidenceSchema = z
  .object({
    sourceRevision: hash,
    representationRevision: hash,
    elementId: z.string().regex(/^e[1-9][0-9]{0,5}$/),
    unit: z.literal('utf16'),
    start: integer,
    end: integer,
  })
  .strict()
  .refine((v) => v.end > v.start, 'Empty/reversed evidence');
export const managedIndexProfileSchema = z
  .object({
    version: z.literal(1),
    schema: z.literal('cortex-managed-retrieval-v1'),
    chunkingProfileSha256: hash,
    embeddingProfileSha256: hash,
    dimensions: z.literal(768),
    normalization: z.literal('l2'),
    distance: z.literal('cosine'),
  })
  .strict();
export const managedIndexKeySchema = z
  .object({
    sourceRevision: hash,
    representationRevision: hash,
    indexGeneration: hash,
  })
  .strict();
const keys = z
  .array(managedIndexKeySchema)
  .min(1)
  .max(32)
  .refine(
    (value) => new Set(value.map((key) => canonicalManagedJson(key))).size === value.length,
    'Duplicate keys',
  );
export const managedObligationSchema = z
  .object({
    key: managedIndexKeySchema,
    backendIdentity: id,
    operationId: id,
    requestSha256: hash,
    writerEpoch: integer,
    state: z.enum(['preparing', 'ready', 'unknown', 'purge_pending', 'purged']),
    purgeOperationId: id.optional(),
    receiptSha256: hash.optional(),
  })
  .strict()
  .refine(
    (v) => v.state !== 'purged' || Boolean(v.purgeOperationId && v.receiptSha256),
    'A terminal obligation requires its original purge receipt',
  );
export const managedRetrievalStateSchema = z
  .object({
    version: z.literal(1),
    revision: managedRevisionSchema.nullable(),
    /** Private migration identity, never an invented SourceRevision or backend IndexKey. */
    legacy: z
      .object({
        owner: managedOwnerSchema,
        fileId: id,
        evidenceSha256: hash,
        missingEvidence: z.array(z.enum(['revision', 'original', 'extraction'])).max(3),
      })
      .strict()
      .optional(),
    inventory: z.enum(['known', 'unknown']),
    obligations: z.array(managedObligationSchema).max(64),
    inventoryReceipt: z
      .object({
        reconciliationId: id,
        storeId: id,
        owner: managedOwnerSchema,
        fileId: id,
        topologySha256: hash,
        retirementsSha256: hash,
        backendsSha256: hash,
        evidenceSha256: hash,
        observedAt: integer,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const invalid = () =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Unbound inventory evidence' });
    if (value.revision === null) {
      if (!value.legacy || value.obligations.length) invalid();
    } else if (value.legacy !== undefined) invalid();
    if (value.inventory === 'known' && !value.inventoryReceipt) invalid();
    const identityOwner = value.revision?.owner ?? value.legacy?.owner;
    const identityFile = value.revision?.source.fileId ?? value.legacy?.fileId;
    if (!identityOwner || !identityFile) {
      invalid();
      return;
    }
    if (
      value.inventoryReceipt &&
      (canonicalManagedJson(value.inventoryReceipt.owner) !== canonicalManagedJson(identityOwner) ||
        value.inventoryReceipt.fileId !== identityFile ||
        (value.legacy && value.inventoryReceipt.evidenceSha256 !== value.legacy.evidenceSha256))
    )
      invalid();
    const seen = new Set<string>();
    for (const obligation of value.obligations) {
      const identity = canonicalManagedJson({
        key: obligation.key,
        backendIdentity: obligation.backendIdentity,
      });
      if (
        seen.has(identity) ||
        obligation.key.sourceRevision !== value.revision?.sourceRevision ||
        obligation.key.representationRevision !== value.revision?.representationRevision
      )
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate or foreign obligation' });
      seen.add(identity);
    }
  });
export const managedPurgeReceiptSchema = z
  .object({
    version: z.literal(1),
    purgeOperationId: id,
    keys,
    backendIdentity: id,
    fenceEpoch: integer.min(1),
    state: z.literal('purged'),
    remainingChunks: z.literal(0),
    activeWriters: z.literal(0),
    completedAt: integer,
    receiptSha256: hash,
  })
  .strict();
export const managedCapabilitySchema = z
  .object({
    version: z.literal(1),
    iss: z.literal('cortex-librechat'),
    aud: z.literal('cortex-rag'),
    sub: id,
    owner: managedOwnerSchema,
    purpose: z.enum(['index', 'query', 'purge', 'status']),
    jti: id,
    iat: integer,
    nbf: integer,
    exp: integer,
    backendIdentity: id,
    requestSha256: hash,
    keys,
    allowedEntityIds: z.array(z.never()).max(0),
    operationId: id,
    writerEpoch: integer,
    workDeadline: integer,
    routePolicySha256: hash,
  })
  .strict();
export type ManagedRevision = z.infer<typeof managedRevisionSchema>;
export type ManagedIndexKey = z.infer<typeof managedIndexKeySchema>;
export type ManagedRetrievalState = z.infer<typeof managedRetrievalStateSchema>;
export type ManagedPurgeReceipt = z.infer<typeof managedPurgeReceiptSchema>;
export type ManagedCapability = z.infer<typeof managedCapabilitySchema>;
export type ManagedSha256 = (utf8: string) => string;

/** Canonical UTF-8 JSON subset shared with the pinned backend. No getters/prototypes/floats. */
export function canonicalManagedJson(value: unknown): string {
  const ancestors = new Set<object>();
  const string = (v: string): string => {
    for (let i = 0; i < v.length; i++) {
      const unit = v.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = v.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Unpaired Unicode surrogate');
        i++;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        throw new Error('Unpaired Unicode surrogate');
      }
    }
    return JSON.stringify(v);
  };
  const visit = (v: unknown, depth: number): string => {
    if (depth > 32) throw new Error('Canonical nesting limit');
    if (v === null) return 'null';
    if (typeof v === 'string') return string(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v) || Object.is(v, -0)) throw new Error('Noncanonical number');
      return String(v);
    }
    if (typeof v !== 'object' || !v || ancestors.has(v)) throw new Error('Noncanonical data');
    ancestors.add(v);
    try {
      if (Array.isArray(v)) {
        if (
          Object.keys(v).length !== v.length ||
          Object.getOwnPropertyNames(v).length !== v.length + 1 ||
          Object.getOwnPropertySymbols(v).length
        )
          throw new Error('Sparse/decorated array');
        return (
          '[' +
          Array.from({ length: v.length }, (_, i) => {
            const d = Object.getOwnPropertyDescriptor(v, String(i));
            if (!d || !('value' in d)) throw new Error('Non-data array');
            return visit(d.value, depth + 1);
          }).join(',') +
          ']'
        );
      }
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
        throw new Error('Non-plain object');
      if (Object.getOwnPropertySymbols(v).length) throw new Error('Symbol property');
      return (
        '{' +
        Object.getOwnPropertyNames(v)
          .sort()
          .map((k) => {
            if (!/^[A-Za-z][A-Za-z0-9]*$/.test(k)) throw new Error('Non-schema key');
            const d = Object.getOwnPropertyDescriptor(v, k)!;
            if (!('value' in d) || !d.enumerable) throw new Error('Non-data property');
            return string(k) + ':' + visit(d.value, depth + 1);
          })
          .join(',') +
        '}'
      );
    } finally {
      ancestors.delete(v);
    }
  };
  return visit(value, 0);
}
export function managedDigest(value: unknown, sha256: ManagedSha256): string {
  return hash.parse(sha256(canonicalManagedJson(value)));
}
export function verifyManagedRevision(value: unknown, sha256: ManagedSha256): ManagedRevision {
  canonicalManagedJson(value);
  const revision = managedRevisionSchema.parse(value);
  const {
    owner,
    source,
    sourceRevision,
    textSha256,
    structureSha256,
    approvalSha256,
    extractionPolicySha256,
  } = revision;
  if (
    sourceRevision !== managedDigest({ version: 1, owner, source }, sha256) ||
    revision.representationRevision !==
      managedDigest(
        {
          version: 1,
          sourceRevision,
          textSha256,
          structureSha256,
          approvalSha256,
          extractionPolicySha256,
        },
        sha256,
      )
  )
    throw new Error('Revision digest mismatch');
  return revision;
}
/** Caller must already own the source/approval. This validates evidence; it does not authorize access. */
export function buildManagedRevision(
  input: {
    owner: ManagedRevision['owner'];
    fileId: string;
    operationId: string;
    document: ManagedDocumentResult;
    approval: UploadSecurityApproval;
    extractionPolicySha256: string;
  },
  sha256: ManagedSha256,
): ManagedRevision {
  canonicalManagedJson(input);
  const document = readManagedDocumentResult(input.document);
  const approval = input.approval;
  if (!document || !readHistoricalUploadSecurityApproval(approval))
    throw new Error('Invalid extraction evidence');
  const { owner, fileId, operationId } = input;
  const original = document.structure.source;
  if (
    approval.subject.tenantId !== owner.tenantId ||
    approval.subject.userId !== owner.userId ||
    approval.subject.operationId !== operationId ||
    approval.subject.sha256 !== original.sha256 ||
    approval.subject.bytes !== original.bytes ||
    approval.subject.mediaType !== original.mediaType
  )
    throw new Error('Extraction evidence does not belong to the source');
  const source = managedSourceIdentitySchema.parse({
    fileId,
    operationId,
    transferGeneration: approval.subject.transferGeneration,
    originalSha256: original.sha256,
    originalBytes: original.bytes,
    mediaType: original.mediaType,
  });
  const sourceRevision = managedDigest({ version: 1, owner, source }, sha256);
  const representation = {
    version: 1 as const,
    sourceRevision,
    textSha256: sha256(document.text),
    structureSha256: managedDigest(document.structure, sha256),
    approvalSha256: managedDigest(approval, sha256),
    extractionPolicySha256: hash.parse(input.extractionPolicySha256),
  };
  return verifyManagedRevision(
    {
      ...representation,
      owner,
      source,
      representationRevision: managedDigest(representation, sha256),
    },
    sha256,
  );
}
/** Use only after authenticated transport verifies the exact backend identity. Missing rows are no receipt. */
export function verifyManagedPurgeReceipt(
  value: unknown,
  obligation: ManagedRetrievalState['obligations'][number],
  purgeOperationId: string,
  sha256: ManagedSha256,
  expectedKeys: ManagedIndexKey[] = [obligation.key],
): ManagedPurgeReceipt {
  canonicalManagedJson(value);
  const receipt = managedPurgeReceiptSchema.parse(value);
  managedObligationSchema.parse(obligation);
  keys.parse(expectedKeys);
  const { receiptSha256, ...payload } = receipt;
  if (
    receiptSha256 !== managedDigest(payload, sha256) ||
    receipt.backendIdentity !== obligation.backendIdentity ||
    receipt.purgeOperationId !== purgeOperationId ||
    (obligation.purgeOperationId !== undefined &&
      obligation.purgeOperationId !== purgeOperationId) ||
    (obligation.receiptSha256 !== undefined && obligation.receiptSha256 !== receiptSha256) ||
    receipt.fenceEpoch <= obligation.writerEpoch ||
    canonicalManagedJson(receipt.keys) !== canonicalManagedJson(expectedKeys) ||
    !receipt.keys.some((key) => canonicalManagedJson(key) === canonicalManagedJson(obligation.key))
  )
    throw new Error('Unbound purge receipt');
  return receipt;
}
/** Claims validation is not JWT authentication. The middleware must verify signature/key/algorithm first. */
export function validateManagedCapability(
  value: unknown,
  context: {
    now: number;
    purpose: ManagedCapability['purpose'];
    owner: ManagedCapability['owner'];
    backendIdentity: string;
    requestSha256: string;
    operationId: string;
    keys: ManagedIndexKey[];
    writerEpoch: number;
    workDeadline: number;
    routePolicySha256: string;
    sourceExpiresAt?: number;
    cleanupDeadline?: number;
  },
): ManagedCapability {
  canonicalManagedJson(value);
  const claims = managedCapabilitySchema.parse(value);
  const cleanup = claims.purpose === 'purge' || claims.purpose === 'status';
  const deadline = cleanup ? context.cleanupDeadline : context.sourceExpiresAt;
  if (
    !Number.isSafeInteger(context.now) ||
    context.now < 0 ||
    deadline === undefined ||
    !Number.isSafeInteger(deadline) ||
    claims.sub !== claims.owner.userId ||
    claims.purpose !== context.purpose ||
    canonicalManagedJson(claims.owner) !== canonicalManagedJson(context.owner) ||
    claims.backendIdentity !== context.backendIdentity ||
    claims.requestSha256 !== context.requestSha256 ||
    claims.operationId !== context.operationId ||
    claims.writerEpoch !== context.writerEpoch ||
    claims.workDeadline !== context.workDeadline ||
    claims.routePolicySha256 !== context.routePolicySha256 ||
    canonicalManagedJson(claims.keys) !== canonicalManagedJson(context.keys) ||
    claims.iat > context.now ||
    claims.nbf > context.now ||
    claims.nbf < claims.iat ||
    claims.exp <= context.now ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > 60 ||
    claims.exp > deadline ||
    claims.exp > claims.workDeadline
  )
    throw new Error('Capability scope or deadline mismatch');
  return claims;
}

/** Caller revalidates its trusted handle again before releasing context or citations. */
export function validateManagedEvidence(
  value: unknown,
  inputRevision: unknown,
  inputDocument: unknown,
  sha256: ManagedSha256,
): string {
  canonicalManagedJson(value);
  const evidence = managedEvidenceSchema.parse(value);
  const revision = verifyManagedRevision(inputRevision, sha256);
  const document = readManagedDocumentResult(inputDocument);
  if (
    !document ||
    evidence.sourceRevision !== revision.sourceRevision ||
    evidence.representationRevision !== revision.representationRevision ||
    sha256(document.text) !== revision.textSha256 ||
    managedDigest(document.structure, sha256) !== revision.structureSha256
  )
    throw new Error('Foreign evidence representation');
  const element = document.structure.elements.find((item) => item.id === evidence.elementId);
  const boundary = (offset: number) =>
    offset === document.text.length ||
    !(document.text.charCodeAt(offset) >= 0xdc00 && document.text.charCodeAt(offset) <= 0xdfff);
  if (
    !element ||
    evidence.start < element.start ||
    evidence.end > element.end ||
    !boundary(evidence.start) ||
    !boundary(evidence.end)
  )
    throw new Error('Evidence outside admitted element');
  return document.text.slice(evidence.start, evidence.end);
}
