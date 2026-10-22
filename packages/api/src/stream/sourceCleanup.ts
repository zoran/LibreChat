import type { IJobStore, IEventTransport, SerializableJobData } from './interfaces/IJobStore';

/** Metadata-only control protocol. File owns durable targets, claims and aggregate completion. */
export const SOURCE_CLEANUP_PAGE_SIZE = 128;
export const SOURCE_CLEANUP_CONCURRENCY = 4;
export const SOURCE_CLEANUP_JOB_FIELDS = [
  'streamId',
  'userId',
  'tenantId',
  'createdAt',
  'status',
  'providerExecutionId',
  'providerDrained',
  'terminalPersistencePending',
  'terminalHostActionPending',
  'sourceRetention',
  'sourceRetentionPurged',
  'sourceRetentionRevokedAt',
  'sourceReplayIntent',
  'sourceReplayHeld',
  'sourceActorSettlement',
] as const;
export type {
  GenerationCleanupScope,
  GenerationCleanupTarget,
  SourceActorSettlement,
  GenerationCleanupEvidence,
  GenerationCleanupResult,
  GenerationCleanupPage,
  GenerationCleanupPort,
} from './interfaces/SourceCleanup';
export type { SourceCleanupProjection } from './interfaces/IJobStore';
import type {
  GenerationCleanupScope,
  GenerationCleanupTarget,
  SourceActorSettlement,
  GenerationCleanupResult,
  GenerationCleanupPort,
} from './interfaces/SourceCleanup';

const validId = (id: unknown): id is string =>
  // eslint-disable-next-line no-control-regex -- Persisted control identities cannot contain ASCII control bytes.
  typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\x00-\x1f]/.test(id);
const validEpoch = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;
export function canonicalSourceIds(ids: readonly string[]): string[] {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 64 || !ids.every(validId))
    throw new Error('generation_cleanup_invalid_source_ids');
  return [...new Set(ids)].sort();
}
function canonicalScope(scope: GenerationCleanupScope): GenerationCleanupScope {
  if (
    !scope ||
    !validId(scope.userId) ||
    !validId(scope.revocationId) ||
    (scope.tenantId != null && !validId(scope.tenantId))
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
        epochs.push(validEpoch(row.generationCreatedAt) ? row.generationCreatedAt : null);
    }
  }
  return epochs;
}
export function sourceCleanupTerminal(job: SerializableJobData): boolean {
  return (
    ['aborted', 'complete', 'error'].includes(job.status) &&
    job.providerDrained === true &&
    !job.terminalPersistencePending &&
    !job.terminalHostActionPending
  );
}
export function sourceActorSettlementMatches(
  job: SerializableJobData,
  receipt: SourceActorSettlement | undefined,
): receipt is SourceActorSettlement {
  try {
    return (
      !!receipt &&
      receipt.schema === 1 &&
      receipt.localCopiesAbsent === true &&
      validEpoch(receipt.createdAt) &&
      validEpoch(receipt.sourceRetentionRevokedAt) &&
      validId(receipt.providerExecutionId) &&
      job.streamId === receipt.streamId &&
      job.createdAt === receipt.createdAt &&
      job.providerExecutionId === receipt.providerExecutionId &&
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

type Store = Required<
  Pick<
    IJobStore,
    | 'getSourceReplayJob'
    | 'captureSourceCleanupPage'
    | 'revokeSourceRetention'
    | 'purgeSourceRetention'
    | 'purgeFileSourceRecovery'
  >
>;
type Transport = Required<
  Pick<IEventTransport, 'emitAbortConfirmed' | 'purgeSourceRetention' | 'hasProviderDrain'>
>;

/** No manager, lifecycle timer, provider dispatch or terminal writer capability is accepted here. */
export function createGenerationCleanupPort(dependencies: {
  store: Store;
  transport: Transport;
  close?: () => void | Promise<void>;
}): GenerationCleanupPort {
  const { store, transport } = dependencies;
  let closed = false;
  const active = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  function run<T>(operation: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new Error('generation_cleanup_closed'));
    if (active.size >= SOURCE_CLEANUP_CONCURRENCY)
      return Promise.reject(new Error('generation_cleanup_busy'));
    const work = operation();
    active.add(work);
    void work.finally(() => active.delete(work)).catch(() => undefined);
    return work;
  }
  const unknown = (reason: string): GenerationCleanupResult => ({ state: 'unknown', reason });
  const pending = (reason: string): GenerationCleanupResult => ({ state: 'pending', reason });
  return {
    capture: (input, cursor) =>
      run(async () => {
        const scope = canonicalScope(input);
        if (cursor != null && (!validId(cursor) || cursor.length > 128))
          throw new Error('generation_cleanup_invalid_cursor');
        const page = await store.captureSourceCleanupPage(scope, cursor);
        if (page.jobs.length > SOURCE_CLEANUP_PAGE_SIZE)
          throw new Error('generation_cleanup_page_overflow');
        const targets: GenerationCleanupTarget[] = [];
        for (const job of page.jobs) {
          if (
            !sourceCleanupOwnerMatches(job, scope) ||
            !job.sourceRetention?.sourceFileIds.some((id) => scope.sourceFileIds.includes(id))
          )
            continue;
          if (!validEpoch(job.createdAt) || !validId(job.streamId))
            throw new Error('generation_cleanup_invalid_identity');
          targets.push({
            schema: 1,
            scope,
            streamId: job.streamId,
            createdAt: job.createdAt,
            providerExecutionId: validId(job.providerExecutionId) ? job.providerExecutionId : null,
          });
        }
        return {
          targets,
          cursor: page.cursor,
          complete: page.complete && !page.unresolvedRecovery,
          ...(page.unresolvedRecovery ? { reason: 'recovery_identity_unavailable' as const } : {}),
        };
      }),
    reconcile: (input) =>
      run(async () => {
        const target = { ...input, scope: canonicalScope(input.scope) };
        if (target.schema !== 1 || !validId(target.streamId) || !validEpoch(target.createdAt))
          throw new Error('generation_cleanup_invalid_target');
        if (!validId(target.providerExecutionId)) return unknown('provider_identity_unavailable');
        function identity(job: SerializableJobData | null): GenerationCleanupResult | undefined {
          if (!job) return unknown('actor_metadata_missing');
          if (job.createdAt !== target.createdAt) return unknown('generation_replaced');
          if (!sourceCleanupOwnerMatches(job, target.scope)) return unknown('owner_mismatch');
          if (job.providerExecutionId !== target.providerExecutionId)
            return unknown('provider_replaced');
          if (
            !job.sourceRetention?.sourceFileIds.some((id) =>
              target.scope.sourceFileIds.includes(id),
            )
          )
            return unknown('source_binding_missing');
        }
        try {
          let job = await store.getSourceReplayJob(target.streamId);
          let refusal = identity(job);
          if (refusal) return refusal;
          if (!(await store.revokeSourceRetention(target.streamId, target.createdAt)))
            return pending('source_revocation_unconfirmed');
          job = await store.getSourceReplayJob(target.streamId);
          refusal = identity(job);
          if (refusal) return refusal;
          if (job!.sourceRetentionRevokedAt == null)
            return pending('source_revocation_unconfirmed');
          await transport.purgeSourceRetention(target.streamId, target.createdAt);
          const acknowledged = await transport.emitAbortConfirmed(
            target.streamId,
            target.createdAt,
          );
          job = await store.getSourceReplayJob(target.streamId);
          refusal = identity(job);
          if (refusal) return refusal;
          if (!sourceCleanupTerminal(job!)) return pending('actor_terminal_obligations');
          if (!sourceActorSettlementMatches(job!, job!.sourceActorSettlement))
            return unknown('actor_settlement_unproven');
          const actor = job!.sourceActorSettlement!;
          if (
            !(
              job!.providerDrained === true ||
              (await transport.hasProviderDrain(
                target.streamId,
                target.createdAt,
                target.providerExecutionId,
              ))
            )
          )
            return pending('provider_drain_unproven');
          if (
            !(await store.purgeFileSourceRecovery(
              target.streamId,
              target.scope,
              target.scope.sourceFileIds,
            ))
          )
            return pending('recovery_purge_unconfirmed');
          if (!(await store.purgeSourceRetention(target.streamId, target.createdAt)))
            return pending('source_purge_unconfirmed');
          job = await store.getSourceReplayJob(target.streamId);
          refusal = identity(job);
          if (refusal) return refusal;
          if (!sourceActorSettlementMatches(job!, actor) || !job!.sourceRetentionPurged)
            return pending('settlement_changed');
          if (job!.sourceReplayHeld || job!.sourceReplayIntent)
            return pending('source_replay_release_pending');
          return {
            state: 'settled',
            reason: 'actor_and_storage_settled',
            evidence: {
              actor,
              providerDrained: true,
              sourcePurged: true,
              recoveryPurged: true,
              replayReleased: true,
              abortAcknowledged: acknowledged,
            },
          };
        } catch {
          return unknown('generation_control_unavailable');
        }
      }),
    close: () => {
      closed = true;
      closing ??= Promise.allSettled([...active]).then(async () => {
        await dependencies.close?.();
      });
      return closing;
    },
  };
}
