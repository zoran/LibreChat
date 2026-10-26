/** Private full-inventory reconciliation and activation of the existing Upload Store. */
import { canonicalManagedJson } from 'librechat-data-provider';
import type { UploadReconciliationSnapshot, UploadActivationProof } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type {
  ManagedRetrievalInventoryAuthority,
  ManagedRetrievalInventoryProof,
} from './fileRetrieval';
import type { UploadStore, ResourceTotals, GlobalState } from './uploadManagementStore';
import {
  RESOURCE_MAX,
  uploadDigest,
  invalidateFileHousekeepingCoverage,
} from './uploadManagementStore';
import { issueManagedRetrievalInventory } from './fileRetrieval';
import { runAsSystem } from '~/config/tenantContext';
import { reject } from './uploadManagementState';

export type UploadActivationMethods = {
  reconciliationSnapshot(now: number): Promise<UploadReconciliationSnapshot>;
  reconcileFileRetrievalInventory(
    proof: ManagedRetrievalInventoryProof,
    now: number,
  ): Promise<void>;
  activateReconciled(proof: UploadActivationProof, now: number): Promise<void>;
};

/** Only the trusted inventory/lifecycle reconciliation composition may call this private port. */
export function createUploadActivationMethods(
  store: UploadStore,
  options: { retrievalInventoryAuthority?: ManagedRetrievalInventoryAuthority } = {},
): UploadActivationMethods {
  const retrievalInventoryAuthority =
    options.retrievalInventoryAuthority === undefined
      ? undefined
      : (JSON.parse(
          canonicalManagedJson(options.retrievalInventoryAuthority),
        ) as ManagedRetrievalInventoryAuthority);
  const keys = Object.keys(RESOURCE_MAX) as (keyof ResourceTotals)[];
  function survivingSourceMessage(): Record<string, unknown> {
    // A binding alone is not surviving content: empty/redacted bodies and removed quotations
    // may legitimately retain their provenance and an empty allocation list.
    const bodyContent = [
      ...[
        'text',
        'summary',
        'privateText',
        'subagentTranscript.messagesJson',
        'subagentActivityProjection.activityJson',
      ].map((path) => ({ [path]: { $type: 'string', $ne: '' } })),
      ...['content', 'files', 'attachments', 'privateTextTokens'].map((path) => ({
        [`${path}.0`]: { $exists: true },
      })),
      ...['metadata', 'contextMeta', 'feedback'].map((path) => ({
        [path]: { $exists: true, $nin: [null, {}, [], ''] },
      })),
    ];
    return {
      $or: [
        { 'sourceFileIds.0': { $exists: true }, sourceContentRemovedAt: null, $or: bodyContent },
        {
          'quoteSourceRetention.0': { $exists: true },
          $expr: {
            $anyElementTrue: [
              {
                $map: {
                  input: {
                    $cond: [{ $isArray: '$quoteSourceRetention' }, '$quoteSourceRetention', []],
                  },
                  as: 'binding',
                  in: {
                    $ne: [
                      {
                        $ifNull: [
                          {
                            $arrayElemAt: [
                              { $cond: [{ $isArray: '$quotes' }, '$quotes', []] },
                              '$$binding.index',
                            ],
                          },
                          '',
                        ],
                      },
                      '',
                    ],
                  },
                },
              },
            ],
          },
        },
      ],
    };
  }
  async function initialInventory(
    session: ClientSession,
  ): Promise<UploadReconciliationSnapshot['initialInventory']> {
    const { File, Message } = store.mongoose.models;
    if (!File || !Message) reject('not_ready');
    return runAsSystem(async () => {
      const operations = await store.Operation.aggregate([{ $limit: 1 }, { $count: 'present' }])
        .session(session)
        .option({ maxTimeMS: 2000 });
      const files = await File.aggregate([{ $limit: 1 }, { $count: 'present' }])
        .session(session)
        .option({ maxTimeMS: 2000 });
      const sourceMessages = await Message.aggregate([
        { $match: survivingSourceMessage() },
        { $limit: 1 },
        { $count: 'present' },
      ])
        .session(session)
        .option({ maxTimeMS: 2000 });
      return {
        operations: operations.length ? 1 : 0,
        files: files.length ? 1 : 0,
        sourceMessages: sourceMessages.length ? 1 : 0,
      };
    });
  }
  async function quiescent(global: GlobalState, session: ClientSession): Promise<void> {
    if (
      global.enabled ||
      global.migrationEpoch ||
      global.migration ||
      (await store.Operation.exists({
        $or: [{ slot: { $exists: true } }, { stagingHeld: true }],
      }).session(session))
    )
      reject('not_ready');
  }
  async function retainedTextFloor(session: ClientSession): Promise<number> {
    const { File, Message } = store.mongoose.models;
    if (!File || !Message) reject('not_ready');
    // Only this private activation owner performs a cross-tenant census. Raw aggregation keeps
    // missing legacy fields visible; ordinary hydrated File defaults are not inventory evidence.
    return runAsSystem(async () => {
      const [inventory] = await File.aggregate<{ textBytes: number; invalid: number }>([
        {
          $match: {
            $or: [
              { retentionAcceptedAt: { $ne: null } },
              { retainedDerivativeBytes: { $gt: 0 } },
              { 'retainedDerivativeReservations.0': { $exists: true } },
            ],
          },
        },
        {
          $project: {
            bytes: {
              $cond: [{ $isNumber: '$retainedDerivativeBytes' }, '$retainedDerivativeBytes', -1],
            },
          },
        },
        {
          $group: {
            _id: null,
            textBytes: { $sum: '$bytes' },
            invalid: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $gte: ['$bytes', 0] },
                      { $lte: ['$bytes', Number.MAX_SAFE_INTEGER] },
                      { $eq: ['$bytes', { $trunc: '$bytes' }] },
                    ],
                  },
                  0,
                  1,
                ],
              },
            },
          },
        },
      ])
        .session(session)
        .option({ maxTimeMS: 2000 });
      if (inventory?.invalid || !Number.isSafeInteger(inventory?.textBytes ?? 0))
        reject('not_ready');
      const unknown = await Message.aggregate<{ unaccounted: number }>([
        {
          $match: {
            $and: [
              {
                $or: [
                  { retainedTextAllocations: { $not: { $type: 'array' } } },
                  { 'retainedTextAllocations.0': { $exists: false } },
                ],
              },
              survivingSourceMessage(),
            ],
          },
        },
        { $limit: 1 },
        { $count: 'unaccounted' },
      ])
        .session(session)
        .option({ maxTimeMS: 2000 });
      if (unknown.length) reject('not_ready');
      // Aggregate already includes Message copies, held replay payload and released metadata.
      return inventory?.textBytes ?? 0;
    });
  }
  return {
    async reconcileFileRetrievalInventory(input, now) {
      const proof = JSON.parse(canonicalManagedJson(input)) as ManagedRetrievalInventoryProof;
      const authority = retrievalInventoryAuthority;
      if (
        !authority ||
        !Number.isSafeInteger(now) ||
        now < 0 ||
        !Number.isSafeInteger(proof.observedAt) ||
        proof.observedAt > now ||
        now - proof.observedAt > 300_000
      )
        reject('not_ready');
      // One bounded File per existing majority transaction. External writer retirement and the
      // complete backend census must already be authenticated by the trusted lifecycle composition.
      await store.transaction(async (session, global) => {
        await quiescent(global, session);
        if (
          proof.storeId !== global.storeId ||
          !global.reconciliationFence ||
          proof.revision !== global.revision ||
          proof.revision !== global.reconciliationFence.revision ||
          proof.observedAt < global.reconciliationFence.observedAt
        )
          reject('not_ready');
        const File = store.mongoose.models.File;
        if (!File) reject('not_ready');
        await runAsSystem(async () => {
          const filter = {
            file_id: proof.fileId,
            user: proof.owner.userId,
            tenantId:
              proof.owner.tenantId === null ? { $eq: null, $exists: true } : proof.owner.tenantId,
            retentionAcceptedAt: { $ne: null },
          };
          const row = await File.findOne(filter)
            .select('+securityApproval +documentStructure +managedRetrieval')
            .session(session)
            .lean<Record<string, unknown>>();
          if (!row || row.deletionCompletedAt) reject('not_ready');
          const state = issueManagedRetrievalInventory(row, proof, authority);
          const written = await File.updateOne(
            { ...filter, _id: row._id },
            { $set: { managedRetrieval: state }, $inc: { retentionRevision: 1 } },
            { session, timestamps: false },
          );
          if (written.matchedCount !== 1) reject('not_ready');
        });
        // A new inventory observation is required for the next File or activation. An old proof
        // cannot advance another File after the global revision changes.
        delete global.reconciliationFence;
      });
    },
    async reconciliationSnapshot(now) {
      if (!Number.isSafeInteger(now) || now < 0) reject('invalid_request');
      return store.transaction(async (session, global) => {
        if (typeof global.storeId !== 'string' || !global.storeId) reject('not_ready');
        await quiescent(global, session);
        await store.assertCurrentSecurityState(session);
        const totals = await store.totals(session);
        if (
          !global.baseline ||
          keys.some((key) => global[key] !== global.baseline[key] + totals[key]) ||
          totals.queueCount !== global.queueCount ||
          totals.queueBytes !== global.queueBytes
        )
          reject('unavailable');
        global.reconciliationFence = { revision: global.revision + 1, observedAt: now };
        return {
          storeId: global.storeId,
          revision: global.reconciliationFence.revision,
          observedAt: new Date(now).toISOString(),
          initialInventory: await initialInventory(session),
          ledgerTotals: Object.fromEntries(keys.map((key) => [key, totals[key]])) as ResourceTotals,
          baseline: { ...global.baseline },
        };
      });
    },
    async activateReconciled(proof, now) {
      await store.transaction(async (session, global) => {
        // Also check an idempotent replay: a historical activation receipt is not a v2 inventory.
        await store.assertCurrentSecurityState(session);
        if (
          typeof global.storeId !== 'string' ||
          !global.storeId ||
          proof.storeId !== global.storeId
        )
          reject('not_ready');
        if (
          global.activationProof &&
          uploadDigest(global.activationProof) === uploadDigest(proof)
        ) {
          if (!global.enabled || !global.reconciled || global.migration || global.migrationEpoch)
            reject('not_ready');
          return;
        }
        await quiescent(global, session);
        const observed = Date.parse(proof.observedAt);
        if (
          !global.reconciliationFence ||
          proof.revision !== global.revision ||
          proof.revision !== global.reconciliationFence.revision ||
          !Number.isSafeInteger(now) ||
          !Number.isSafeInteger(observed) ||
          observed < global.reconciliationFence.observedAt ||
          observed > now ||
          now - observed > 300_000 ||
          proof.historyCopiesAccounted !== true ||
          !proof.inventoryEvidenceId ||
          proof.inventoryEvidenceId.length > 512 ||
          !proof.baseline ||
          (proof.admission !== undefined && proof.admission !== 'initial-empty') ||
          keys.some(
            (key) => !Number.isSafeInteger(proof.baseline[key]) || proof.baseline[key] < 0,
          ) ||
          proof.baseline.objectBytes < proof.baseline.originalBytes
        )
          reject('not_ready');
        if (proof.admission === 'initial-empty') {
          const deadline = Date.parse(proof.originalDeadline ?? '');
          if (
            !Number.isSafeInteger(deadline) ||
            new Date(deadline).toISOString() !== proof.originalDeadline ||
            deadline < observed ||
            deadline > observed + 300_000 ||
            now >= deadline
          )
            reject('not_ready');
        }
        const totals = await store.totals(session);
        if (
          totals.queueCount !== global.queueCount ||
          totals.queueBytes !== global.queueBytes ||
          keys.some((key) => global[key] !== global.baseline[key] + totals[key])
        )
          reject('unavailable');
        if (proof.admission === 'initial-empty') {
          if (
            keys.some(
              (key) => global.baseline[key] !== 0 || proof.baseline[key] !== 0 || totals[key] !== 0,
            )
          )
            reject('not_ready');
          // Recheck database populations in this transaction. Independent File/Message writers
          // still require the coordinator's external quiescence proof; snapshots do not fence phantoms.
          const inventory = await initialInventory(session);
          if (inventory.operations || inventory.files || inventory.sourceMessages)
            reject('not_ready');
        }
        if (proof.baseline.textBytes < (await retainedTextFloor(session))) reject('not_ready');
        for (const key of keys) {
          const total = totals[key] + proof.baseline[key];
          if (!Number.isSafeInteger(total) || total > RESOURCE_MAX[key])
            reject('capacity_exceeded');
          global[key] = total;
        }
        global.baseline = { ...proof.baseline };
        invalidateFileHousekeepingCoverage(global, uploadDigest(proof), 'writer_admission');
        global.activationProof = { ...proof, baseline: { ...proof.baseline } };
        global.reconciled = true;
        global.enabled = true;
        delete global.reconciliationFence;
      });
    },
  };
}
