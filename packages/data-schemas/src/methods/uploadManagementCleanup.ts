/** Cleanup, reconciliation and operational census methods on the shared upload store. */
import {
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_WINDOW_MS,
  UPLOAD_REPLAY_MS,
  readUploadSecuritySettlement,
} from 'librechat-data-provider';
import type {
  UploadOperation,
  UploadWorker,
  UploadCleanupProof,
  UploadErrorCode,
} from 'librechat-data-provider';
import type { UploadManagementRepository, UploadManagementContext } from './uploadManagementTypes';
import type { StoredUpload, GlobalState, UploadStore } from './uploadManagementStore';
import {
  principalFilter,
  storedUploadPrincipal,
  project,
  reject,
  WAIT_MS,
  PROCESS_MS,
} from './uploadManagementStore';
import {
  hasUploadStorageCompletion,
  hasUploadActorClosure,
  hasUploadAcceptedFileAck,
} from './uploadCleanupReceipts';
import {
  hasCompleteUploadSecurityExecution,
  recordUploadSecuritySettlement,
} from './uploadManagement.security';
import { retireUploadHousekeeping } from './uploadHousekeepingProjection';
import { hasStoppedUploadPromotion } from './uploadManagementIntake';
import { readUploadAdmission } from './uploadManagementAdmission';
/** One-operation timeout predicate. Accepted content expiry is deliberately File-owned. */
export function uploadTimeoutTransition(
  row: StoredUpload,
  now: number,
): 'lease_lost' | 'expired' | null {
  if (
    row.slot &&
    row.leaseExpiresAt != null &&
    row.leaseExpiresAt <= now &&
    !['failed', 'deleted', 'expired', 'cancelled'].includes(row.state)
  )
    return 'lease_lost';
  if (row.state === 'waiting' && row.createdAt + WAIT_MS <= now) return 'expired';
  if (
    row.state === 'queued_processing' &&
    row.processingQueuedAt != null &&
    row.processingQueuedAt + PROCESS_MS <= now
  )
    return 'expired';
  return null;
}
/** Only a receipt for the current exact actor can supplement its local journal. */
export function actorCleanupFacts(row: StoredUpload): {
  writerStopped: boolean;
  localCopiesAbsent: boolean;
  localWriterStopped: boolean;
} {
  const proof = row.actorSettlement;
  const matches =
    proof?.generation === (row.workerGeneration ?? row.generation) &&
    !!row.worker &&
    proof?.worker?.hostId === row.worker.hostId &&
    proof.worker.instanceId === row.worker.instanceId;
  return {
    writerStopped: matches && proof?.writerStopped === true,
    localWriterStopped: matches && proof?.localWriterStopped === true,
    localCopiesAbsent: matches && proof?.localCopiesAbsent === true,
  };
}
function actorIdentity(worker: UploadWorker): UploadWorker {
  if (
    [worker?.hostId, worker?.instanceId].some(
      (value) => typeof value !== 'string' || !value || value.length > 128,
    )
  )
    reject('invalid_request');
  return { hostId: worker.hostId, instanceId: worker.instanceId };
}
/** Upload cleanup, observation and expiry reconciliation; no independent storage authority. */
export function createUploadCleanupMethods(
  context: UploadManagementContext,
): Pick<
  UploadManagementRepository,
  | 'cleanupTasks'
  | 'cleanupForWorker'
  | 'confirmActorCleanup'
  | 'cleanupForFile'
  | 'activeWorkers'
  | 'localReservations'
  | 'watchChanges'
  | 'reconcile'
  | 'metrics'
> {
  const { mongoose, store, lifecycle, principalOf, terminal, cleanupTask } = context;

  const actorTask = (row: StoredUpload) => ({
    ...cleanupTask(row),
    actorWriterStopped: row.writerStopped === true || actorCleanupFacts(row).writerStopped,
    actorLocalWriterStopped: actorCleanupFacts(row).localWriterStopped,
  });
  return {
    async cleanupForWorker(identity, page = {}) {
      const worker = actorIdentity(identity);
      const limit = page.limit ?? 16;
      const cursor = page.cursor ?? null;
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (cursor !== null && (typeof cursor !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(cursor)))
      )
        reject('invalid_request');
      const filter = {
        cleanupPending: true,
        state: { $nin: ['waiting', 'transferring', 'processing'] },
        $or: [
          {
            'worker.hostId': worker.hostId,
            'worker.instanceId': worker.instanceId,
            $or: [{ writerStopped: { $ne: true } }, { stagingHeld: true }],
          },
          {
            'promotion.worker.hostId': worker.hostId,
            'promotion.worker.instanceId': worker.instanceId,
            'promotion.writerStopped': { $ne: true },
          },
        ],
      };
      const read = (after: string | null) =>
        store.Operation.find({ ...filter, ...(after ? { _id: { $gt: after } } : {}) })
          .sort({ _id: 1 })
          .limit(limit)
          .maxTimeMS(3_000)
          .lean<StoredUpload[]>();
      let rows = await read(cursor);
      if (!rows.length && cursor) rows = await read(null);
      return { tasks: rows.map(actorTask), cursor: rows[rows.length - 1]?._id ?? null };
    },
    async confirmActorCleanup(identity, input, now) {
      const worker = actorIdentity(identity);
      const settlement =
        input.securitySettlement === undefined
          ? undefined
          : readUploadSecuritySettlement(input.securitySettlement);
      const proof = {
        operationId: input.operationId,
        generation: input.generation,
        writerStopped: input.writerStopped,
        localWriterStopped: input.localWriterStopped,
        localCopiesAbsent: input.localCopiesAbsent,
        ...(settlement ? { securitySettlement: settlement } : {}),
      };
      if (
        typeof proof.operationId !== 'string' ||
        !/^[a-zA-Z0-9-]{1,128}$/.test(proof.operationId) ||
        !Number.isSafeInteger(proof.generation) ||
        proof.generation < 1 ||
        typeof proof.writerStopped !== 'boolean' ||
        (proof.localWriterStopped !== undefined && typeof proof.localWriterStopped !== 'boolean') ||
        typeof proof.localCopiesAbsent !== 'boolean' ||
        settlement === null ||
        !Number.isSafeInteger(now) ||
        now < 0
      )
        reject('invalid_request');
      return store.transaction(async (session, global) => {
        const row = await store.Operation.findById(proof.operationId)
          .session(session)
          .lean<StoredUpload>();
        if (
          !row ||
          row.worker?.hostId !== worker.hostId ||
          row.worker.instanceId !== worker.instanceId ||
          (row.workerGeneration ?? row.generation) !== proof.generation
        )
          reject('lease_lost');
        if (['waiting', 'transferring', 'processing'].includes(row.state)) reject('not_ready');
        const previous = actorCleanupFacts(row);
        row.actorSettlement = {
          generation: proof.generation,
          worker,
          writerStopped: previous.writerStopped || proof.writerStopped,
          localWriterStopped: previous.localWriterStopped || proof.localWriterStopped === true,
          localCopiesAbsent: previous.localCopiesAbsent || proof.localCopiesAbsent,
        };
        if (settlement) recordUploadSecuritySettlement(row, settlement);
        if (
          row.actorSettlement.writerStopped &&
          hasStoppedUploadPromotion(row) &&
          (!row.securityExecution || hasCompleteUploadSecurityExecution(row))
        ) {
          context.applyCleanup(
            row,
            {
              ...proof,
              writerStopped: true,
              localCopiesAbsent: row.actorSettlement.localCopiesAbsent,
              originalAbsent: false,
              textAndHistoryRemoved: false,
            },
            global,
          );
        }
        await store.save(row, session);
        return actorTask(row);
      });
    },
    async cleanupTasks(limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) reject('invalid_request');
      return store.transaction(async (session, global) => {
        let rows = await store.Operation.find({
          cleanupPending: true,
          ...(global.cleanupCursor ? { _id: { $gt: global.cleanupCursor } } : {}),
        })
          .sort({ _id: 1 })
          .limit(limit)
          .session(session)
          .lean<StoredUpload[]>();
        if (!rows.length && global.cleanupCursor)
          rows = await store.Operation.find({ cleanupPending: true })
            .sort({ _id: 1 })
            .limit(limit)
            .session(session)
            .lean<StoredUpload[]>();
        global.cleanupCursor = rows[rows.length - 1]?._id;
        return rows.map(cleanupTask);
      });
    },
    async cleanupForFile(owner, fileId) {
      if (typeof fileId !== 'string' || !fileId || fileId.length > 128) reject('invalid_request');
      const principal = storedUploadPrincipal(owner);
      const row = await store.Operation.findOne({
        ...principalFilter(principal),
        fileId,
      }).lean<StoredUpload>();
      return row ? cleanupTask(row) : null;
    },
    async activeWorkers() {
      const rows = await store.Operation.find({ slot: { $exists: true } })
        .select('worker')
        .limit(10)
        .lean<StoredUpload[]>();
      if (rows.length > 9 || rows.some((row) => !row.worker)) reject('unavailable');
      return [...new Map(rows.map((row) => [JSON.stringify(row.worker), row.worker!])).values()];
    },
    async localReservations(worker, now) {
      if (
        !Number.isSafeInteger(now) ||
        now < 0 ||
        [worker?.hostId, worker?.instanceId].some(
          (value) => typeof value !== 'string' || !value || value.length > 128,
        )
      )
        reject('invalid_request');
      const rows = await store.Operation.find({
        stagingHeld: true,
        'worker.hostId': worker.hostId,
        'worker.instanceId': worker.instanceId,
      })
        .select('_id declaredBytes workerGeneration workerKind worker')
        .sort({ _id: 1 })
        .limit(129)
        .lean<StoredUpload[]>();
      if (
        rows.length > 128 ||
        rows.some(
          (row) =>
            !Number.isSafeInteger(row.workerGeneration) ||
            row.workerGeneration! < 1 ||
            !['transfer', 'processing'].includes(row.workerKind!) ||
            !row.worker ||
            !Number.isSafeInteger(row.declaredBytes) ||
            row.declaredBytes <= 0 ||
            row.declaredBytes > UPLOAD_MAX_FILE_BYTES,
        )
      )
        reject('unavailable');
      const attempts = rows.map((row) => ({
        operationId: row._id,
        generation: row.workerGeneration!,
        declaredBytes: row.declaredBytes,
        kind: row.workerKind!,
        worker: { ...row.worker! },
      }));
      const counts = { transfer: 0, processing: 0 };
      for (const attempt of attempts) counts[attempt.kind]++;
      return {
        worker: { ...worker },
        observedAt: now,
        attempts,
        counts,
        heldBytes: attempts.reduce((sum, attempt) => sum + attempt.declaredBytes, 0),
      };
    },
    watchChanges({ tenantId, includeGuests = false, onChanged, onReset }) {
      if (
        typeof tenantId !== 'string' ||
        !/^[a-zA-Z0-9_.-]{1,128}$/.test(tenantId) ||
        tenantId === '__SYSTEM__' ||
        typeof includeGuests !== 'boolean'
      )
        reject('invalid_request');
      // A missing document or collection invalidation is a reset-only system signal, never tenant data authority.
      // eslint-disable-next-line no-restricted-syntax -- Server hub uses an explicit tenantId $match and metadata-only projection; unroutable lifecycle events can only reset.
      const stream = store.Operation.watch(
        [
          {
            $match: {
              $or: [
                { 'fullDocument.tenantId': tenantId },
                ...(includeGuests ? [{ 'fullDocument.tenantId': { $type: 10 } }] : []),
                {
                  fullDocument: null,
                  operationType: {
                    $in: [
                      'delete',
                      'update',
                      'replace',
                      'drop',
                      'rename',
                      'dropDatabase',
                      'invalidate',
                    ],
                  },
                },
              ],
            },
          },
          {
            $project: {
              _id: 1,
              operationType: 1,
              'fullDocument.tenantId': 1,
              'fullDocument.userId': 1,
            },
          },
        ],
        { fullDocument: 'updateLookup' },
      );
      const pending = new Map<string, { tenantId: string | null; userId: string }>();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        pending.clear();
        void stream.close().catch(() => undefined);
      };
      const reset = () => {
        if (!closed) {
          close();
          onReset();
        }
      };
      stream.on('error', reset);
      stream.on('close', reset);
      stream.on('change', (change) => {
        if (closed) return;
        const row = 'fullDocument' in change ? change.fullDocument : null;
        if (!row) {
          pending.clear();
          onReset();
          return;
        }
        if (row.tenantId !== tenantId && !(includeGuests && row.tenantId === null)) return;
        if (typeof row.userId !== 'string' || !row.userId) {
          pending.clear();
          onReset();
          return;
        }
        const principal = { tenantId: row.tenantId, userId: row.userId };
        pending.set(JSON.stringify(principal), principal);
        if (pending.size > 128) {
          pending.clear();
          onReset();
          return;
        }
        timer ??= setTimeout(() => {
          timer = undefined;
          const batch = [...pending.values()];
          pending.clear();
          for (const owner of batch) onChanged(owner);
        }, 50);
      });
      return close;
    },
    async reconcile(now, limit = 100) {
      return store.transaction(async (session, global) => {
        const filter = {
          $or: [
            { state: 'waiting', createdAt: { $lte: now - WAIT_MS } },
            { state: 'queued_processing', processingQueuedAt: { $lte: now - PROCESS_MS } },
            {
              state: { $in: ['transferring', 'processing'] },
              slot: { $exists: true },
              leaseExpiresAt: { $lte: now },
            },
            {
              acceptedAt: { $exists: true },
              expiresAt: { $lte: now },
              state: { $nin: ['deleted', 'expired'] },
            },
            {
              createdAt: { $lte: now - UPLOAD_REPLAY_MS },
              cleanupPending: false,
              originalBytes: 0,
              textBytes: 0,
              slot: { $exists: false },
            },
          ],
        };
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) reject('invalid_request');
        let rows = await store.Operation.find({
          ...filter,
          ...(global.reconcileCursor ? { _id: { $gt: global.reconcileCursor } } : {}),
        })
          .sort({ _id: 1 })
          .limit(limit)
          .session(session)
          .lean<StoredUpload[]>();
        if (!rows.length && global.reconcileCursor)
          rows = await store.Operation.find(filter)
            .sort({ _id: 1 })
            .limit(limit)
            .session(session)
            .lean<StoredUpload[]>();
        global.reconcileCursor = rows[rows.length - 1]?._id;
        const changed: UploadOperation[] = [];
        for (const row of rows) {
          let transitioned = false;
          if (
            row.acceptedAt != null &&
            row.expiresAt! <= now &&
            !['deleted', 'expired'].includes(row.state)
          ) {
            if (
              await lifecycle.revokeExpiredManagedUpload(
                principalOf(row),
                row._id,
                row.expiresAt!,
                now,
                session,
              )
            ) {
              terminal(row, global, 'expired', 'expired');
              transitioned = true;
            }
          } else {
            const code = uploadTimeoutTransition(row, now);
            if (code) {
              terminal(row, global, 'failed', code);
              transitioned = true;
            }
          }
          if (
            row.createdAt + UPLOAD_REPLAY_MS <= now &&
            (row.acceptedAt == null || row.acceptedAt + UPLOAD_WINDOW_MS <= now) &&
            !row.cleanupPending &&
            !row.slot &&
            !row.originalBytes &&
            !row.textBytes &&
            !row.stagingHeld
          ) {
            // File tombstones remain owned by the lifecycle and retain their bundle allowance.
            const tombstone =
              row.fileId &&
              (await mongoose.models.File.exists({
                file_id: row.fileId,
                tenantId: row.tenantId,
              }).session(session));
            if (!tombstone && (await retireUploadHousekeeping(mongoose, row, session))) {
              global.recordBytes -= row.recordBytes;
              global.bundles--;
              await store.Operation.deleteOne({ _id: row._id }, { session });
              continue;
            }
          }
          if (transitioned) {
            await store.save(row, session);
            changed.push(project(row, now));
          }
        }
        return changed;
      });
    },
    async metrics(now) {
      if (!Number.isSafeInteger(now) || now < 0) reject('invalid_request');
      const counter = await store.Counter.findById('global').lean();
      if (!counter) reject('unavailable');
      const g = counter.value as GlobalState;
      let admissionsPaused: boolean | null;
      try {
        admissionsPaused = readUploadAdmission(g).paused;
      } catch {
        admissionsPaused = null;
      }
      type Group = {
        _id: StoredUpload['state'];
        count: number;
        queueCount: number;
        queueBytes: number;
        oldest: number;
        usedBytes: number;
        reservedBytes: number;
        retainedBytes: number;
        stagingCount: number;
        stagingBytes: number;
        cleanup: number;
        transfers: number;
        processors: number;
      };
      const grouped = await store.Operation.aggregate<Group>([
        {
          $group: {
            _id: '$state',
            count: { $sum: 1 },
            queueCount: { $sum: { $cond: ['$queueCharged', 1, 0] } },
            queueBytes: { $sum: { $cond: ['$queueCharged', '$declaredBytes', 0] } },
            oldest: {
              $min: {
                $cond: [
                  '$queueCharged',
                  { $ifNull: ['$processingQueuedAt', '$createdAt'] },
                  Number.MAX_SAFE_INTEGER,
                ],
              },
            },
            usedBytes: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $gt: ['$acceptedAt', now - UPLOAD_WINDOW_MS] },
                      { $lte: ['$acceptedAt', now] },
                    ],
                  },
                  '$actualBytes',
                  0,
                ],
              },
            },
            reservedBytes: { $sum: '$pendingBytes' },
            retainedBytes: {
              $sum: {
                $cond: [{ $ne: [{ $ifNull: ['$acceptedAt', null] }, null] }, '$originalBytes', 0],
              },
            },
            stagingCount: { $sum: { $cond: ['$stagingHeld', 1, 0] } },
            stagingBytes: { $sum: { $cond: ['$stagingHeld', '$declaredBytes', 0] } },
            cleanup: { $sum: { $cond: ['$cleanupPending', 1, 0] } },
            transfers: { $sum: { $cond: [{ $eq: ['$slot', 'transfer'] }, 1, 0] } },
            processors: { $sum: { $cond: [{ $eq: ['$slot', 'processing'] }, 1, 0] } },
          },
        },
      ]);
      const total = (field: Exclude<keyof Group, '_id' | 'oldest'>) =>
        grouped.reduce((sum, row) => sum + row[field], 0);
      const oldest = Math.min(Number.MAX_SAFE_INTEGER, ...grouped.map((row) => row.oldest));
      return {
        observedAt: now,
        admissionsPaused,
        control: {
          mode: g.mode,
          limits: { ...g.limits },
          sourceExpiresAt: g.policyUntil,
          leaseExpiresAt: g.controllerUntil,
          enabled: g.enabled && g.reconciled,
        },
        queue: {
          count: total('queueCount'),
          bytes: total('queueBytes'),
          oldestAgeSeconds:
            oldest === Number.MAX_SAFE_INTEGER ? 0 : Math.max(0, (now - oldest) / 1000),
        },
        quota: {
          usedBytes: total('usedBytes'),
          reservedBytes: total('reservedBytes'),
          retainedBytes: total('retainedBytes'),
        },
        staging: { count: total('stagingCount'), bytes: total('stagingBytes') },
        states: Object.fromEntries(grouped.map((r) => [r._id, r.count])),
        originalBytes: g.originalBytes,
        objectBytes: g.objectBytes,
        textBytes: g.textBytes,
        recordBytes: g.recordBytes,
        bundles: g.bundles,
        cleanupPending: total('cleanup'),
        transfers: total('transfers'),
        processors: total('processors'),
      };
    },
  };
}

/** Existing terminal/accounting transitions shared by the two actual Upload cleanup owners. */
export function createUploadCleanupTransitions(store: UploadStore): {
  terminal(
    row: StoredUpload,
    global: GlobalState,
    state: StoredUpload['state'],
    code?: UploadErrorCode,
  ): void;
  applyCleanup(row: StoredUpload, proof: UploadCleanupProof, global: GlobalState): void;
} {
  function terminal(
    row: StoredUpload,
    global: GlobalState,
    state: StoredUpload['state'],
    code?: UploadErrorCode,
  ): void {
    row.state = state;
    row.error = code;
    row.pendingBytes = 0;
    row.generation++;
    store.releaseQueue(row, global);
    row.cleanupPending =
      row.slot != null || row.stagingHeld || row.originalBytes > 0 || row.textBytes > 0;
    if (row.attemptGeneration == null && row.acceptedAt == null) {
      global.originalBytes -= row.originalBytes;
      global.objectBytes -= row.originalBytes;
      row.originalBytes = 0;
      row.originalRemoved = true;
      row.cleanupPending = false;
    }
  }
  function applyCleanup(row: StoredUpload, proof: UploadCleanupProof, global: GlobalState): void {
    const settlement =
      proof.securitySettlement === undefined
        ? undefined
        : readUploadSecuritySettlement(proof.securitySettlement);
    if (settlement === null) reject('invalid_request');
    if ((row.workerGeneration ?? row.generation) !== proof.generation) reject('lease_lost');
    if (settlement) recordUploadSecuritySettlement(row, settlement);
    if (row.securityExecution && !hasCompleteUploadSecurityExecution(row)) reject('not_ready');
    if (!hasStoppedUploadPromotion(row)) reject('not_ready');
    if (!proof.writerStopped) reject('not_ready');
    row.writerStopped = true;
    if (row.slot && ['transferring', 'processing'].includes(row.state))
      terminal(row, global, 'failed', 'processing_failed');
    delete row.slot;
    delete row.leaseExpiresAt;
    if (proof.localCopiesAbsent) row.stagingHeld = false;
    const removeOriginal = row.acceptedAt == null || ['deleted', 'expired'].includes(row.state);
    if (
      proof.originalAbsent &&
      removeOriginal &&
      (row.attemptGeneration == null ||
        ((hasUploadStorageCompletion(row) || hasUploadAcceptedFileAck(row)) &&
          hasUploadActorClosure(row)))
    ) {
      global.originalBytes -= row.originalBytes;
      global.objectBytes -= row.originalBytes;
      row.originalBytes = 0;
      row.originalRemoved = true;
    }
    if (
      proof.textAndHistoryRemoved &&
      row.state !== 'ready' &&
      (row.attemptGeneration == null ||
        ((hasUploadStorageCompletion(row) || hasUploadAcceptedFileAck(row)) &&
          hasUploadActorClosure(row)))
    ) {
      global.textBytes -= row.textBytes;
      row.textBytes = 0;
      row.textRemoved = true;
    }
    row.cleanupPending =
      row.stagingHeld ||
      (removeOriginal && (row.originalBytes > 0 || row.textBytes > 0)) ||
      (!!row.cleanupCustody?.request && row.cleanupCustody.consumed === undefined);
    // Preserve the original Intake acknowledgement before a later processing claim replaces
    // the active worker fields. This bit never attests that later processing generation.
    if (
      row.intake?.generation === proof.generation &&
      row.attemptGeneration === proof.generation &&
      row.intake.worker?.hostId === row.worker?.hostId &&
      row.intake.worker?.instanceId === row.worker?.instanceId &&
      proof.localCopiesAbsent &&
      row.promotion?.receipt?.outcome !== 'unknown' &&
      row.promotion?.state !== 'writing'
    )
      row.intake.cleanupAcknowledged = true;
  }
  return { terminal, applyCleanup };
}
