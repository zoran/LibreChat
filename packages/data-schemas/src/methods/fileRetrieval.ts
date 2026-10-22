/** File-owned immutable publication and deletion guards. No index writer or transport. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  buildManagedRevision,
  canonicalManagedJson,
  managedRetrievalStateSchema,
  verifyManagedRevision,
  managedOwnerSchema,
  managedObligationSchema,
  managedDigest,
} from 'librechat-data-provider';
import type {
  ManagedDocumentResult,
  ManagedRetrievalState,
  UploadSecurityApproval,
} from 'librechat-data-provider';
import type { FileRetrievalCreation } from '~/types/file';
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const unavailable = () =>
  Object.assign(new Error('Managed retrieval inventory is unresolved'), {
    code: 'managed_retrieval_unresolved',
  });

const creationSchema = z
  .object({
    version: z.literal(1),
    owner: managedOwnerSchema,
    fileId: z.string().min(1).max(256),
    acceptedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    state: z.enum(['empty', 'admitted']),
  })
  .strict();
type InventoryFile = {
  retrievalCreation?: unknown;
  managedRetrieval?: unknown;
  file_id?: unknown;
  uploadOperationId?: unknown;
  user?: unknown;
  tenantId?: unknown;
  retentionAcceptedAt?: Date | string;
};

/** Private birth record, written only by the unique managed File INSERT transaction.
 * This proves the new File had no possible prior File-owned dispatch. It is not a
 * backend census, does not backfill old Files, and never resets after admission.
 */
export function createManagedFileRetrievalInventory(
  owner: FileRetrievalCreation['owner'],
  fileId: string,
  acceptedAt: number,
): FileRetrievalCreation {
  return creationSchema.parse({ version: 1, owner, fileId, acceptedAt, state: 'empty' });
}

function creationFor(row: InventoryFile): FileRetrievalCreation | undefined {
  const parsed = creationSchema.safeParse(row.retrievalCreation);
  if (!parsed.success) return undefined;
  const proof = parsed.data;
  if (
    proof.fileId !== row.file_id ||
    proof.fileId !== row.uploadOperationId ||
    proof.owner.userId !== String(row.user ?? '') ||
    proof.owner.tenantId !== row.tenantId ||
    row.retentionAcceptedAt === undefined ||
    proof.acceptedAt !== new Date(row.retentionAcceptedAt).getTime()
  )
    return undefined;
  return proof;
}

/** Called before the first liability is added, in its original File transaction. */
export function admitManagedFileRetrievalInventory(
  row: InventoryFile,
): FileRetrievalCreation | undefined {
  if (row.retrievalCreation === undefined) return undefined;
  const creation = creationFor(row);
  if (!creation) throw unavailable();
  const state = managedRetrievalStateSchema.parse(row.managedRetrieval);
  if (creation.state === 'empty' && state.obligations.length !== 0) throw unavailable();
  return { ...creation, state: 'admitted' };
}

/** New File custody is complete by construction; legacy custody still needs its census.
 * Every admitted File keeps all liabilities and requires the existing purge receipts.
 */
export function managedFileRetrievalDeletionSettled(row: InventoryFile): boolean {
  const identity = {
    owner: { tenantId: row.tenantId as string | null, userId: String(row.user ?? '') },
    fileId: row.file_id as string,
  };
  if (managedRetrievalDeletionSettled(row.managedRetrieval, identity)) return true;
  try {
    const creation = creationFor(row);
    if (!creation) return false;
    if (row.managedRetrieval === undefined) return creation.state === 'empty';
    const state = managedRetrievalStateSchema.parse(row.managedRetrieval);
    if (!state.revision) return false;
    const revision = verifyManagedRevision(state.revision, sha256);
    if (
      canonicalManagedJson(revision.owner) !== canonicalManagedJson(creation.owner) ||
      revision.source.fileId !== creation.fileId ||
      revision.source.operationId !== creation.fileId
    )
      return false;
    if (creation.state === 'empty') return state.obligations.length === 0;
    return (
      state.obligations.length > 0 &&
      state.obligations.every(
        (entry) =>
          entry.state === 'purged' && Boolean(entry.purgeOperationId && entry.receiptSha256),
      )
    );
  } catch {
    return false;
  }
}

/** No policy digest means no retrieval-ready projection, never known-empty inventory. */
export function prepareManagedRetrievalPublication(input: {
  owner: { tenantId: string | null; userId: string };
  fileId: string;
  operationId: string;
  document: ManagedDocumentResult;
  approval: UploadSecurityApproval;
  extractionPolicySha256?: string;
  previous?: unknown;
}): ManagedRetrievalState | undefined {
  if (input.extractionPolicySha256 === undefined) {
    if (input.previous !== undefined) throw unavailable();
    return undefined;
  }
  const revision = buildManagedRevision(
    {
      owner: input.owner,
      fileId: input.fileId,
      operationId: input.operationId,
      document: input.document,
      approval: input.approval,
      extractionPolicySha256: input.extractionPolicySha256,
    },
    sha256,
  );
  if (input.previous !== undefined) {
    canonicalManagedJson(input.previous);
    const previous = managedRetrievalStateSchema.parse(input.previous);
    if (!previous.revision) throw unavailable();
    verifyManagedRevision(previous.revision, sha256);
    if (canonicalManagedJson(previous.revision) !== canonicalManagedJson(revision))
      throw unavailable();
    return previous;
  }
  // Admission-disabled configuration is not evidence that historical/foreign writers were excluded.
  return { version: 1, revision, inventory: 'unknown', obligations: [] };
}

/** Called before final accounting/metadata release. Unknown inventory and absent receipts remain pending. */
export function managedRetrievalDeletionSettled(
  value: unknown,
  identity?: { owner: { tenantId: string | null; userId: string }; fileId: string },
): boolean {
  try {
    canonicalManagedJson(value);
    const state = managedRetrievalStateSchema.parse(value);
    if (state.revision) verifyManagedRevision(state.revision, sha256);
    if (
      identity &&
      (canonicalManagedJson(identity.owner) !==
        canonicalManagedJson(state.revision?.owner ?? state.legacy?.owner) ||
        identity.fileId !== (state.revision?.source.fileId ?? state.legacy?.fileId))
    )
      return false;
    return (
      state.inventory === 'known' &&
      state.obligations.every(
        (entry) =>
          entry.state === 'purged' && Boolean(entry.purgeOperationId && entry.receiptSha256),
      )
    );
  } catch {
    return false;
  }
}

/** Independent trusted lifecycle composition supplies these verified, persisted owner receipts.
 * It must enumerate every historical writer/backend; configuration absence is never an inventory.
 * This private port is not exported by the employee File API and does not accept request data.
 */
export type ManagedRetrievalInventoryAuthority = {
  topologySha256: string;
  writers: readonly { writerId: string; retirementReceiptSha256: string }[];
  backends: readonly { backendIdentity: string; inventoryReceiptSha256: string }[];
};
export type ManagedRetrievalInventoryProof = {
  reconciliationId: string;
  storeId: string;
  revision: number;
  observedAt: number;
  owner: { tenantId: string | null; userId: string };
  fileId: string;
  evidenceSha256: string;
  /** Each receipt is authenticated by the private composition before constructing authority. */
  backends: {
    backendIdentity: string;
    inventoryReceiptSha256: string;
    owner: { tenantId: string | null; userId: string };
    fileId: string;
    evidenceSha256: string;
    observedAt: number;
    complete: true;
    obligations: ManagedRetrievalState['obligations'];
  }[];
};

const HASH = /^[a-f0-9]{64}$/;
const validId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 256;
const digest = (value: unknown) => managedDigest(value, sha256);

/** Hash the actual retained evidence, including absence. This is NOT a document/source revision. */
export function captureManagedRetrievalInventoryEvidence(row: Record<string, unknown>): {
  owner: { tenantId: string | null; userId: string };
  fileId: string;
  evidenceSha256: string;
  missingEvidence: ('revision' | 'original' | 'extraction')[];
} {
  const owner = managedOwnerSchema.parse({
    tenantId: row.tenantId ?? null,
    userId: String(row.user ?? ''),
  });
  if (!validId(row.file_id) || !row._id) throw unavailable();
  const date = (value: unknown) => (value instanceof Date ? value.toISOString() : (value ?? null));
  const original = {
    operationId: row.uploadOperationId ?? null,
    approval: row.securityApproval ?? null,
    documentStructure: row.documentStructure ?? null,
    filepath: row.filepath ?? null,
    source: row.source ?? null,
    bytes: row.bytes ?? null,
    type: row.type ?? null,
  };
  const evidenceSha256 = digest({
    owner,
    fileId: row.file_id,
    rowId: String(row._id),
    createdAt: date(row.createdAt),
    retentionAcceptedAt: date(row.retentionAcceptedAt),
    expiredAt: date(row.expiredAt),
    original,
    textSha256: typeof row.text === 'string' ? sha256(row.text) : null,
  });
  const missingEvidence: ('revision' | 'original' | 'extraction')[] = [];
  if (!row.managedRetrieval) missingEvidence.push('revision');
  if (!row.securityApproval || !row.documentStructure) missingEvidence.push('original');
  if (typeof row.text !== 'string' || !row.documentStructure) missingEvidence.push('extraction');
  return { owner, fileId: row.file_id, evidenceSha256, missingEvidence };
}

/** Actual File state issuer, called only inside the existing quiescent Upload reconciliation transaction. */
export function issueManagedRetrievalInventory(
  row: Record<string, unknown>,
  proof: ManagedRetrievalInventoryProof,
  authority: ManagedRetrievalInventoryAuthority,
): ManagedRetrievalState {
  canonicalManagedJson(proof);
  canonicalManagedJson(authority);
  if (
    !validId(proof.reconciliationId) ||
    !validId(proof.storeId) ||
    !HASH.test(authority.topologySha256) ||
    !Number.isSafeInteger(proof.observedAt) ||
    proof.observedAt < 0 ||
    !Number.isSafeInteger(proof.revision) ||
    proof.revision < 0 ||
    authority.writers.length === 0 ||
    authority.writers.length > 32 ||
    authority.backends.length === 0 ||
    authority.backends.length > 32 ||
    proof.backends.length !== authority.backends.length
  )
    throw unavailable();
  const writers = new Set<string>();
  for (const writer of authority.writers) {
    if (
      !validId(writer.writerId) ||
      writers.has(writer.writerId) ||
      !HASH.test(writer.retirementReceiptSha256)
    )
      throw unavailable();
    writers.add(writer.writerId);
  }
  const evidence = captureManagedRetrievalInventoryEvidence(row);
  if (
    canonicalManagedJson(evidence.owner) !== canonicalManagedJson(proof.owner) ||
    evidence.fileId !== proof.fileId ||
    evidence.evidenceSha256 !== proof.evidenceSha256
  )
    throw unavailable();
  const previous =
    row.managedRetrieval === undefined
      ? undefined
      : managedRetrievalStateSchema.parse(row.managedRetrieval);
  if (previous?.revision) verifyManagedRevision(previous.revision, sha256);
  if (
    previous &&
    (canonicalManagedJson(previous.revision?.owner ?? previous.legacy?.owner) !==
      canonicalManagedJson(evidence.owner) ||
      (previous.revision?.source.fileId ?? previous.legacy?.fileId) !== evidence.fileId)
  )
    throw unavailable();
  const backendIds = new Set<string>();
  const obligations: ManagedRetrievalState['obligations'] = [];
  for (let i = 0; i < authority.backends.length; i++) {
    const expected = authority.backends[i];
    const actual = proof.backends[i];
    if (
      !validId(expected.backendIdentity) ||
      backendIds.has(expected.backendIdentity) ||
      !HASH.test(expected.inventoryReceiptSha256) ||
      actual.backendIdentity !== expected.backendIdentity ||
      actual.inventoryReceiptSha256 !== expected.inventoryReceiptSha256 ||
      canonicalManagedJson(actual.owner) !== canonicalManagedJson(evidence.owner) ||
      actual.fileId !== evidence.fileId ||
      actual.evidenceSha256 !== evidence.evidenceSha256 ||
      actual.observedAt !== proof.observedAt ||
      actual.complete !== true ||
      !Array.isArray(actual.obligations)
    )
      throw unavailable();
    const { inventoryReceiptSha256, ...inventoryPayload } = actual;
    if (digest(inventoryPayload) !== inventoryReceiptSha256) throw unavailable();
    backendIds.add(expected.backendIdentity);
    for (const value of actual.obligations) {
      const obligation = managedObligationSchema.parse(value);
      if (obligation.backendIdentity !== expected.backendIdentity) throw unavailable();
      obligations.push(obligation);
    }
  }
  // Census cannot erase a previously admitted liability, even when a backend now reports no row.
  for (const prior of previous?.obligations ?? []) {
    if (
      !obligations.some((current) => canonicalManagedJson(current) === canonicalManagedJson(prior))
    )
      throw unavailable();
  }
  if (!previous?.revision && obligations.length) throw unavailable();
  return managedRetrievalStateSchema.parse({
    version: 1,
    revision: previous?.revision ?? null,
    ...(!previous?.revision ? { legacy: evidence } : {}),
    inventory: 'known',
    obligations,
    inventoryReceipt: {
      reconciliationId: proof.reconciliationId,
      storeId: proof.storeId,
      owner: evidence.owner,
      fileId: evidence.fileId,
      topologySha256: authority.topologySha256,
      retirementsSha256: digest(authority.writers),
      backendsSha256: digest(proof.backends),
      evidenceSha256: evidence.evidenceSha256,
      observedAt: proof.observedAt,
    },
  });
}
