/** Public control metadata; File owns target and aggregate persistence. No runtime imports. */
export interface GenerationCleanupScope {
  userId: string;
  tenantId?: string;
  revocationId: string;
  sourceFileIds: readonly string[];
}
export interface GenerationCleanupTarget {
  schema: 1;
  scope: GenerationCleanupScope;
  streamId: string;
  createdAt: number;
  providerExecutionId: string | null;
}
export interface SourceActorSettlement {
  schema: 1;
  streamId: string;
  createdAt: number;
  providerExecutionId: string;
  sourceRetentionRevokedAt: number;
  sourceFileIds: readonly string[];
  localCopiesAbsent: true;
}
export interface GenerationCleanupEvidence {
  actor: SourceActorSettlement;
  providerDrained: true;
  sourcePurged: true;
  recoveryPurged: true;
  replayReleased: true;
  abortAcknowledged: boolean;
}
export interface GenerationCleanupResult {
  state: 'pending' | 'unknown' | 'settled';
  reason: string;
  evidence?: GenerationCleanupEvidence;
}
export interface GenerationCleanupPage {
  targets: GenerationCleanupTarget[];
  cursor?: string;
  complete: boolean;
  reason?: 'recovery_identity_unavailable';
}
export interface GenerationCleanupPort {
  capture(scope: GenerationCleanupScope, cursor?: string): Promise<GenerationCleanupPage>;
  /** The caller must persist this exact target under its current File claim before calling. */
  reconcile(target: GenerationCleanupTarget): Promise<GenerationCleanupResult>;
  close(): Promise<void>;
}

/** Minimal structural view of the existing Generation receipt owner; no API dependency. */
export interface SourceCleanupJobReceiptView {
  streamId: string;
  createdAt: number;
  status: string;
  providerExecutionId?: string;
  providerDrained?: boolean;
  terminalPersistencePending?: boolean;
  terminalHostActionPending?: boolean;
  sourceRetentionRevokedAt?: number;
  sourceRetention?: { sourceFileIds: readonly string[] };
}
export const SOURCE_CLEANUP_PAGE_SIZE = 128;
export const validSourceCleanupIdentity = (id: unknown): id is string =>
  // eslint-disable-next-line no-control-regex -- Persisted control identities cannot contain ASCII control bytes.
  typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\x00-\x1f]/.test(id);
export const validSourceCleanupEpoch = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
export function canonicalSourceIds(ids: readonly string[]): string[] {
  if (
    !Array.isArray(ids) ||
    ids.length < 1 ||
    ids.length > 64 ||
    !ids.every(validSourceCleanupIdentity)
  )
    throw new Error('generation_cleanup_invalid_source_ids');
  return Array.from(new Set(ids)).sort();
}
export function canonicalGenerationCleanupScope(
  scope: GenerationCleanupScope,
): GenerationCleanupScope {
  if (
    !scope ||
    !validSourceCleanupIdentity(scope.userId) ||
    !validSourceCleanupIdentity(scope.revocationId) ||
    (scope.tenantId != null && !validSourceCleanupIdentity(scope.tenantId))
  )
    throw new Error('generation_cleanup_invalid_scope');
  return {
    userId: scope.userId,
    ...(scope.tenantId ? { tenantId: scope.tenantId } : {}),
    revocationId: scope.revocationId,
    sourceFileIds: canonicalSourceIds(scope.sourceFileIds),
  };
}
export function sourceCleanupOwnerMatches(
  job: { userId: string; tenantId?: string },
  scope: { userId: string; tenantId?: string },
): boolean {
  return (
    job.userId === scope.userId && (job.tenantId ?? undefined) === (scope.tenantId ?? undefined)
  );
}
/** Existing recovery rows carry source object references but may predate provider identity. */
export function sourceCleanupRecoveryEpochs(
  rows: readonly unknown[],
  scope: GenerationCleanupScope,
): Array<number | null> {
  const epochs: Array<number | null> = [];
  if (rows.length > SOURCE_CLEANUP_PAGE_SIZE)
    throw new Error('generation_cleanup_recovery_overflow');
  for (const value of rows) {
    const row = value as {
      userId: string;
      tenantId?: string;
      generationCreatedAt?: number;
      item?: unknown;
      steers?: unknown[];
    };
    if (!row || !sourceCleanupOwnerMatches(row, scope)) continue;
    const items = row.item ? [row.item] : (row.steers ?? []);
    if (items.length > SOURCE_CLEANUP_PAGE_SIZE)
      throw new Error('generation_cleanup_recovery_overflow');
    for (const raw of items) {
      const item = raw as {
        files?: Array<{ file_id?: string }>;
        quoteRetention?: { quoteSourceRetention?: Array<{ sourceFileIds: string[] }> };
      };
      const ids = [
        ...(item.files ?? []).flatMap((file) => (file.file_id ? [file.file_id] : [])),
        ...(item.quoteRetention?.quoteSourceRetention ?? []).flatMap(
          (binding) => binding?.sourceFileIds ?? [],
        ),
      ];
      if (ids.some((id) => scope.sourceFileIds.includes(id)))
        epochs.push(
          validSourceCleanupEpoch(row.generationCreatedAt) ? row.generationCreatedAt : null,
        );
    }
  }
  return epochs;
}
export function sourceCleanupTerminal(job: SourceCleanupJobReceiptView): boolean {
  return (
    ['aborted', 'complete', 'error'].includes(job.status) &&
    job.providerDrained === true &&
    !job.terminalPersistencePending &&
    !job.terminalHostActionPending
  );
}
export function sourceActorSettlementMatches(
  job: SourceCleanupJobReceiptView,
  receipt: SourceActorSettlement | undefined,
): receipt is SourceActorSettlement {
  try {
    return (
      sourceActorSettlementIdentityMatches(job, receipt) &&
      job.sourceRetentionRevokedAt === receipt.sourceRetentionRevokedAt &&
      !!job.sourceRetention &&
      sourceCleanupTerminal(job) &&
      JSON.stringify(canonicalSourceIds(job.sourceRetention.sourceFileIds)) ===
        JSON.stringify(receipt.sourceFileIds)
    );
  } catch {
    return false;
  }
}

/** Structural identity checks only. This does not establish that an actor actually settled. */
export function sourceActorSettlementIdentityMatches(
  identity: { streamId: string; createdAt: number; providerExecutionId?: string | null },
  receipt: SourceActorSettlement | undefined,
): receipt is SourceActorSettlement {
  return (
    !!receipt &&
    receipt.schema === 1 &&
    receipt.localCopiesAbsent === true &&
    validSourceCleanupEpoch(receipt.createdAt) &&
    validSourceCleanupEpoch(receipt.sourceRetentionRevokedAt) &&
    validSourceCleanupIdentity(receipt.providerExecutionId) &&
    identity.streamId === receipt.streamId &&
    identity.createdAt === receipt.createdAt &&
    identity.providerExecutionId === receipt.providerExecutionId
  );
}
/** File custody binding only; callers must obtain evidence from the actual Generation port. */
export function generationCleanupEvidenceMatchesTarget(
  target: GenerationCleanupTarget,
  evidence: GenerationCleanupEvidence | undefined,
): evidence is GenerationCleanupEvidence {
  try {
    return (
      !!evidence &&
      sourceActorSettlementIdentityMatches(target, evidence.actor) &&
      evidence.providerDrained === true &&
      evidence.sourcePurged === true &&
      evidence.recoveryPurged === true &&
      evidence.replayReleased === true &&
      typeof evidence.abortAcknowledged === 'boolean' &&
      JSON.stringify(canonicalSourceIds(evidence.actor.sourceFileIds)) ===
        JSON.stringify(evidence.actor.sourceFileIds) &&
      evidence.actor.sourceFileIds.some((id) => target.scope.sourceFileIds.includes(id))
    );
  } catch {
    return false;
  }
}
