/** File-owned target custody. Generation remains the authority for actual effect receipts. */
import { createHash, randomUUID } from 'node:crypto';
import {
  canonicalSourceIds,
  generationCleanupEvidenceMatchesTarget,
} from 'librechat-data-provider';
import type { GenerationCleanupTarget, GenerationCleanupPage } from 'librechat-data-provider';
import type { mongo } from 'mongoose';
import type { FileCleanupTargetRecord, FileCleanupProgressMethods } from '../types/fileCleanup';
import type { HousekeepingStore } from './housekeepingStore';
import type { JobClaim } from '../types/housekeeping';
import {
  createFileCleanupAuthority,
  FileCleanupLost as Lost,
  FileCleanupPending as Pending,
} from './fileCleanupAuthority';
import {
  createFileCleanupTargetModel,
  FILE_CLEANUP_TARGET_INDEXES,
} from '../models/fileCleanupTarget';
import { tenantSafeBulkWrite } from '../utils/tenantBulkWrite';
const QUERY_MS = 1000;
const MAX_TARGET_BYTES = 65536;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256;
const cursorValid = (value: unknown) =>
  value === null ||
  (typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 128);
function boundedTarget(row: FileCleanupTargetRecord): FileCleanupTargetRecord {
  if (Buffer.byteLength(JSON.stringify(row)) > MAX_TARGET_BYTES)
    throw new Pending('target_overflow');
  return row;
}
export function createFileCleanupProgressMethods(
  mongoose: typeof import('mongoose'),
  store: HousekeepingStore,
): FileCleanupProgressMethods {
  const { transaction, targetScope, progress, observation, load, save, checkSignal } =
    createFileCleanupAuthority(mongoose, store);
  const model = createFileCleanupTargetModel(mongoose);
  const targets = model.collection as unknown as mongo.Collection<FileCleanupTargetRecord>;
  function assertPage(claim: JobClaim, page: GenerationCleanupPage): void {
    const scope = targetScope(claim);
    if (
      !page ||
      !Array.isArray(page.targets) ||
      page.targets.length > 128 ||
      typeof page.complete !== 'boolean' ||
      !cursorValid(page.cursor ?? null) ||
      (page.reason !== undefined && page.reason !== 'recovery_identity_unavailable')
    )
      throw new Pending('invalid_capture');
    for (const target of page.targets) {
      if (
        !target ||
        target.schema !== 1 ||
        !id(target.streamId) ||
        !Number.isSafeInteger(target.createdAt) ||
        target.createdAt <= 0 ||
        !(target.providerExecutionId === null || id(target.providerExecutionId)) ||
        target.scope?.userId !== scope.ownerUserId ||
        (target.scope.tenantId ?? null) !== scope.tenantId ||
        target.scope.revocationId !== scope.revocationId ||
        JSON.stringify(canonicalSourceIds(target.scope.sourceFileIds)) !==
          JSON.stringify([scope.fileId]) ||
        JSON.stringify(target.scope.sourceFileIds) !== JSON.stringify([scope.fileId]) ||
        Buffer.byteLength(JSON.stringify(target)) > MAX_TARGET_BYTES
      )
        throw new Pending('invalid_capture');
    }
  }
  const activePhase = (context: import('./fileCleanupAuthority').FileCleanupContext) => {
    if (!['capturing_generations', 'settling_generations'].includes(context.job.execution.phase))
      throw new Pending('owner_pending');
  };
  return {
    async initialize() {
      await model.init();
    },
    beginCapture(claim, signal) {
      return transaction(signal, async (session) => {
        const context = await load(claim, session);
        if (context.file.retentionCleanup) {
          const value = progress(context);
          return context.job.execution.phase === 'revoked'
            ? save(claim, context, value, 'capturing_generations', session)
            : observation(context);
        }
        if (context.job.execution.phase !== 'revoked') throw new Pending('owner_pending');
        const scope = targetScope(claim);
        return save(
          claim,
          context,
          {
            schema: 1,
            revocationId: scope.revocationId,
            jobId: claim.jobId,
            executionId: claim.executionId,
            capture: { cursor: null, complete: false, recoveryUnresolved: false },
            generationReceiptRef: null,
          },
          'capturing_generations',
          session,
        );
      });
    },
    readCapture(claim, signal) {
      return transaction(signal, async (session) => observation(await load(claim, session)));
    },
    recordCapturePage(claim, expected, page, signal) {
      return transaction(signal, async (session) => {
        const context = await load(claim, session, expected);
        const value = progress(context);
        if (context.job.execution.phase !== 'capturing_generations' || value.capture.complete)
          throw new Pending('owner_pending');
        assertPage(claim, page);
        const scope = targetScope(claim);
        const now = new Date();
        if (page.targets.length)
          await tenantSafeBulkWrite(
            model,
            page.targets.map((target: GenerationCleanupTarget) => {
              const targetIdentityHash = hash([
                target.streamId,
                target.createdAt,
                target.providerExecutionId,
              ]);
              const _id = hash([
                scope.tenantId,
                scope.ownerUserId,
                scope.fileId,
                scope.revocationId,
                'generation',
                targetIdentityHash,
              ]);
              return {
                updateOne: {
                  filter: { _id, ...scope },
                  update: {
                    $setOnInsert: boundedTarget({
                      _id,
                      ...scope,
                      schema: 1 as const,
                      kind: 'generation' as const,
                      targetIdentityHash,
                      target,
                      state:
                        target.providerExecutionId === null
                          ? ('unknown' as const)
                          : ('pending' as const),
                      reason:
                        target.providerExecutionId === null
                          ? 'provider_identity_unavailable'
                          : 'captured',
                      evidence: null,
                      createdAt: now,
                      updatedAt: now,
                      settledAt: null,
                    }),
                  },
                  upsert: true,
                },
              };
            }),
            { session, ordered: true, maxTimeMS: QUERY_MS },
          );
        // Retry order uses the database clock for both first custody and later observations.
        if (page.targets.length)
          await targets.updateMany(
            {
              ...scope,
              targetIdentityHash: {
                $in: page.targets.map((target) =>
                  hash([target.streamId, target.createdAt, target.providerExecutionId]),
                ),
              },
            },
            { $currentDate: { updatedAt: true } },
            { session, maxTimeMS: QUERY_MS },
          );
        checkSignal(signal);
        const next = {
          ...value,
          capture: {
            cursor: page.cursor ?? null,
            complete: page.complete,
            recoveryUnresolved:
              value.capture.recoveryUnresolved || page.reason === 'recovery_identity_unavailable',
          },
        };
        return save(claim, context, next, 'capturing_generations', session);
      });
    },
    readPendingTargets(claim, signal, after) {
      return transaction(signal, async (session) => {
        const context = await load(claim, session);
        activePhase(context);
        if (after !== undefined && !/^[a-f0-9]{64}$/.test(after))
          throw new Pending('invalid_cursor');
        const anchor = after
          ? await targets.findOne(
              { _id: after, ...targetScope(claim) },
              { session, maxTimeMS: QUERY_MS },
            )
          : null;
        if (after && !anchor) throw new Pending('invalid_cursor');
        const rows = await targets
          .find(
            {
              ...targetScope(claim),
              state: { $in: ['pending', 'unknown'] },
              ...(anchor
                ? {
                    $or: [
                      { updatedAt: { $gt: anchor.updatedAt } },
                      { updatedAt: anchor.updatedAt, _id: { $gt: anchor._id } },
                    ],
                  }
                : {}),
            },
            { session, maxTimeMS: QUERY_MS, hint: FILE_CLEANUP_TARGET_INDEXES.pending },
          )
          .sort({ updatedAt: 1, _id: 1 })
          .limit(32)
          .toArray();
        return {
          ...observation(context),
          targets: rows.map((row) => ({ id: row._id, target: row.target })),
          cursor: rows.length === 32 ? rows[rows.length - 1]._id : null,
        };
      });
    },
    recordGenerationResult(claim, expected, targetId, result, signal) {
      return transaction(signal, async (session) => {
        const context = await load(claim, session, expected);
        activePhase(context);
        const row = await targets.findOne(
          { _id: targetId, ...targetScope(claim) },
          { session, maxTimeMS: QUERY_MS },
        );
        if (!row) throw new Pending('target_unavailable');
        // A later worker may only observe the first accepted evidence, never rewrite or downgrade it.
        if (row.state === 'settled') return observation(context);
        if (
          !result ||
          !['pending', 'unknown', 'settled'].includes(result.state) ||
          !id(result.reason) ||
          Buffer.byteLength(JSON.stringify(result)) > MAX_TARGET_BYTES ||
          (result.state === 'settled' &&
            !generationCleanupEvidenceMatchesTarget(row.target, result.evidence))
        )
          throw new Pending('invalid_evidence');
        const now = new Date();
        boundedTarget({
          ...row,
          state: result.state,
          reason: result.reason,
          evidence: result.state === 'settled' ? result.evidence! : null,
          updatedAt: now,
          settledAt: result.state === 'settled' ? now : null,
        });
        const changed = await targets.updateOne(
          { _id: row._id, ...targetScope(claim), state: row.state },
          {
            $set: {
              state: result.state,
              reason: result.reason,
              evidence: result.state === 'settled' ? result.evidence! : null,
              settledAt: result.state === 'settled' ? now : null,
            },
            $currentDate: { updatedAt: true },
          },
          { session, maxTimeMS: QUERY_MS },
        );
        if (changed.matchedCount !== 1) throw new Lost();
        checkSignal(signal);
        return save(claim, context, progress(context), context.job.execution.phase, session);
      });
    },
    finishGenerationStage(claim, expected, signal) {
      return transaction(signal, async (session) => {
        const context = await load(claim, session, expected);
        const value = progress(context);
        if (context.job.execution.phase === 'purging_derivatives' && value.generationReceiptRef)
          return observation(context);
        activePhase(context);
        if (!value.capture.complete || value.capture.recoveryUnresolved)
          throw new Pending('unresolved_capture');
        if (
          await targets.findOne(
            { ...targetScope(claim), state: { $in: ['pending', 'unknown'] } },
            { session, maxTimeMS: QUERY_MS, hint: FILE_CLEANUP_TARGET_INDEXES.pending },
          )
        )
          throw new Pending('unsettled_targets');
        // This reference records File custody of committed capture and receipts, not physical deletion.
        const next = {
          ...value,
          generationReceiptRef: value.generationReceiptRef ?? `generation:${randomUUID()}`,
        };
        if (context.job.execution.phase === 'capturing_generations')
          await save(claim, context, next, 'settling_generations', session);
        checkSignal(signal);
        return save(claim, context, next, 'purging_derivatives', session);
      });
    },
  };
}
