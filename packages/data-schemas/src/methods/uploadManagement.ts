/** Durable Upload Management authority. All mutations share one Mongo transaction/fence. */
import {
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_USER_WINDOW_BYTES,
  UPLOAD_WINDOW_MS,
  UPLOAD_RETENTION_MS,
  UPLOAD_REPLAY_MS,
  UPLOAD_MAX_TEXT_BYTES,
  UPLOAD_RECORD_BYTES,
  isUploadOriginalIntegrity,
  isUploadStorageReceipt,
} from 'librechat-data-provider';
import type {
  UploadPrincipal,
  UploadReserveInput,
  UploadOperation,
  UploadUsage,
  UploadLease,
  UploadClaimInput,
  UploadStorageReceipt,
  UploadCleanupProof,
  UploadErrorCode,
  UploadMetricsSnapshot,
  UploadProcessingInput,
  UploadCleanupTask,
  UploadParserExecution,
  UploadWorker,
  UploadLocalReservations,
} from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type {
  StoredUpload,
  GlobalState,
  UploadStoreOptions,
  UploadActivationMethods,
} from './uploadManagementStore';
import type { UploadMigrationMethods } from './uploadManagementMigration';
import type { UploadAdmissionMethods } from './uploadManagementAdmission';
import type { UploadControlMethods } from './uploadManagementControl';
import {
  createUploadStore,
  principalFilter,
  project,
  leaseFor,
  assertLease,
  effectiveLimits,
  reject,
  createUploadActivationMethods,
  uploadDigest,
  LEASE_MS,
  WAIT_MS,
  PROCESS_MS,
  RESOURCE_MAX,
} from './uploadManagementStore';
import { createUploadAdmissionMethods, readUploadAdmission } from './uploadManagementAdmission';
import { createUploadMigrationMethods } from './uploadManagementMigration';
import { createUploadControlMethods } from './uploadManagementControl';
import { createFileRetentionMethods } from './fileRetention';

export type UploadManagementRepository = UploadControlMethods &
  UploadMigrationMethods &
  UploadAdmissionMethods &
  UploadActivationMethods & {
    initialize(): Promise<void>;
    findReservation(
      principal: UploadPrincipal,
      key: string,
      fingerprint: string,
      now: number,
    ): Promise<UploadOperation | null>;
    reserve(
      principal: UploadPrincipal,
      input: UploadReserveInput,
      now: number,
    ): Promise<UploadOperation>;
    get(principal: UploadPrincipal, id: string, now: number): Promise<UploadOperation>;
    list(principal: UploadPrincipal, now: number): Promise<UploadOperation[]>;
    usage(principal: UploadPrincipal, now: number): Promise<UploadUsage>;
    claim(input: UploadClaimInput): Promise<UploadLease | null>;
    renew(lease: UploadLease, now: number): Promise<UploadLease>;
    accept(
      principal: UploadPrincipal,
      lease: UploadLease,
      receipt: UploadStorageReceipt,
      now: number,
    ): Promise<UploadOperation>;
    publish(
      lease: UploadLease,
      result: { text: string; writerStopped: true },
      now: number,
    ): Promise<UploadOperation>;
    cancel(principal: UploadPrincipal, id: string, now: number): Promise<UploadOperation>;
    delete(principal: UploadPrincipal, id: string, now: number): Promise<UploadOperation>;
    retryProcessing(principal: UploadPrincipal, id: string, now: number): Promise<UploadOperation>;
    fail(lease: UploadLease, code: UploadErrorCode, now: number): Promise<UploadOperation>;
    confirmCleanup(proof: UploadCleanupProof, now: number): Promise<UploadOperation>;
    reconcile(now: number, limit?: number): Promise<UploadOperation[]>;
    getProcessingInput(lease: UploadLease, now: number): Promise<UploadProcessingInput>;
    bindProcessingExecution(
      lease: UploadLease,
      execution: UploadParserExecution,
      now: number,
    ): Promise<void>;
    cleanupTasks(limit?: number): Promise<UploadCleanupTask[]>;
    cleanupForFile(
      owner: { tenantId: string; userId: string },
      fileId: string,
    ): Promise<UploadCleanupTask | null>;
    activeWorkers(): Promise<UploadWorker[]>;
    localReservations(worker: UploadWorker, now: number): Promise<UploadLocalReservations>;
    watchChanges(input: {
      tenantId: string;
      onChanged: (principal: { tenantId: string; userId: string }) => void;
      onReset: () => void;
    }): () => void;
    metrics(now: number): Promise<UploadMetricsSnapshot>;
  };

export function createUploadManagementRepository(
  mongoose: typeof import('mongoose'),
  options: UploadStoreOptions = {},
): UploadManagementRepository {
  const store = createUploadStore(mongoose, options);
  const lifecycle = createFileRetentionMethods(mongoose);
  const principalOf = (row: StoredUpload): UploadPrincipal => ({
    tenantId: row.tenantId,
    userId: row.userId,
    authentication: 'verified-email',
  });
  const cleanupTask = (row: StoredUpload): UploadCleanupTask => ({
    operationId: row._id,
    generation: row.workerGeneration ?? row.generation,
    attemptGeneration: row.attemptGeneration,
    principal: principalOf(row),
    worker: row.worker,
    original: row.original,
    fileId: row.fileId,
    state: row.state,
    parserExecution: row.parserExecution,
    writerStopped: row.writerStopped === true,
    localCopiesAbsent: row.stagingHeld === false,
  });
  async function owned(
    principal: UploadPrincipal,
    id: string,
    session?: ClientSession,
  ): Promise<StoredUpload> {
    const row = await store.Operation.findOne({ _id: id, ...principalFilter(principal) })
      .session(session ?? null)
      .lean<StoredUpload>();
    if (!row) reject('not_found');
    return row;
  }
  async function usage(
    principal: UploadPrincipal,
    now: number,
    session?: ClientSession,
  ): Promise<UploadUsage> {
    const owner = principalFilter(principal);
    const inWindow = {
      $and: [{ $gt: ['$acceptedAt', now - UPLOAD_WINDOW_MS] }, { $lte: ['$acceptedAt', now] }],
    };
    const rows = await store.Operation.aggregate<{
      used: number;
      reserved: number;
      retained: number;
      next: number;
    }>([
      { $match: owner },
      {
        $group: {
          _id: null,
          used: { $sum: { $cond: [inWindow, '$actualBytes', 0] } },
          reserved: { $sum: '$pendingBytes' },
          retained: {
            $sum: {
              $cond: [{ $ne: [{ $ifNull: ['$acceptedAt', null] }, null] }, '$originalBytes', 0],
            },
          },
          next: { $min: { $cond: [inWindow, '$acceptedAt', Number.MAX_SAFE_INTEGER] } },
        },
      },
    ]).session(session ?? null);
    const r = rows[0] ?? { used: 0, reserved: 0, retained: 0, next: Number.MAX_SAFE_INTEGER };
    const next = r.next === Number.MAX_SAFE_INTEGER ? null : r.next;
    const releases =
      next == null
        ? []
        : await store.Operation.aggregate<{ bytes: number }>([
            { $match: { ...owner, acceptedAt: next } },
            { $group: { _id: null, bytes: { $sum: '$actualBytes' } } },
          ]).session(session ?? null);
    return {
      limitBytes: UPLOAD_USER_WINDOW_BYTES,
      usedBytes: r.used,
      reservedBytes: r.reserved,
      availableBytes: Math.max(0, UPLOAD_USER_WINDOW_BYTES - r.used - r.reserved),
      retainedBytes: r.retained,
      nextReleaseAt: next == null ? null : new Date(next + UPLOAD_WINDOW_MS).toISOString(),
      nextReleaseBytes: releases[0]?.bytes ?? 0,
    };
  }
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
  async function reserve(
    principal: UploadPrincipal,
    input: UploadReserveInput,
    now: number,
  ): Promise<UploadOperation> {
    principalFilter(principal);
    const scope = input.scope ?? { kind: 'personal' };
    if (scope.kind !== 'personal') reject('forbidden');
    if (
      !Number.isSafeInteger(input.declaredBytes) ||
      input.declaredBytes <= 0 ||
      input.declaredBytes > UPLOAD_MAX_FILE_BYTES ||
      !input.operationId ||
      !/^[a-zA-Z0-9-]{1,128}$/.test(input.operationId) ||
      !input.idempotencyKey ||
      input.idempotencyKey.length > 128 ||
      !input.filename ||
      input.filename.length > 255 ||
      !input.mediaType ||
      input.mediaType.length > 128
    )
      reject('invalid_request');
    const fingerprint = JSON.stringify([
      scope,
      input.filename,
      input.mediaType,
      input.declaredBytes,
    ]);
    if (fingerprint !== input.fingerprint) reject('invalid_request');
    return store.transaction(async (session, global) => {
      const owner = principalFilter(principal);
      const previous = await store.Operation.findOne({
        ...owner,
        idempotencyKey: input.idempotencyKey,
      })
        .session(session)
        .lean<StoredUpload>();
      if (previous) {
        if (previous.fingerprint !== fingerprint) reject('idempotency_conflict');
        return project(previous, now);
      }
      if (!global.enabled || !global.reconciled || global.mode === 'blocked') reject('unavailable');
      if (readUploadAdmission(global).paused) reject('admission_paused');
      await store.touchPrincipal(principal, session);
      if (
        (await store.Operation.countDocuments({ ...owner, queueCharged: true }).session(session)) >=
        2
      )
        reject('queue_full');
      const quota = await usage(principal, now, session);
      if (quota.availableBytes < input.declaredBytes) reject('quota_exceeded');
      if (
        global.originalBytes + input.declaredBytes > RESOURCE_MAX.originalBytes ||
        global.objectBytes + input.declaredBytes > RESOURCE_MAX.objectBytes ||
        global.recordBytes + UPLOAD_RECORD_BYTES > RESOURCE_MAX.recordBytes ||
        global.bundles >= RESOURCE_MAX.bundles
      )
        reject('capacity_exceeded');
      const row: StoredUpload = {
        _id: input.operationId,
        ...owner,
        scope,
        idempotencyKey: input.idempotencyKey,
        fingerprint,
        filename: input.filename,
        mediaType: input.mediaType,
        declaredBytes: input.declaredBytes,
        state: 'waiting',
        revision: 1,
        createdAt: now,
        generation: 0,
        cleanupPending: false,
        originalBytes: input.declaredBytes,
        textBytes: 0,
        recordBytes: UPLOAD_RECORD_BYTES,
        queueCharged: false,
        pendingBytes: input.declaredBytes,
        stagingHeld: false,
        writerStopped: true,
      };
      store.chargeQueue(row, global);
      global.originalBytes += row.originalBytes;
      global.objectBytes += row.originalBytes;
      global.recordBytes += row.recordBytes;
      global.bundles++;
      await store.Operation.create([row], { session });
      return project(row, now);
    });
  }
  async function claim(input: UploadClaimInput): Promise<UploadLease | null> {
    const { now, worker, kind } = input;
    if (
      !worker.hostId ||
      !worker.instanceId ||
      worker.hostId.length > 128 ||
      worker.instanceId.length > 128
    )
      reject('invalid_request');
    if (kind === 'transfer' && (!input.principal || !input.operationId)) reject('unauthorized');
    return store.transaction(async (session, global) => {
      if (input.principal) await owned(input.principal, input.operationId!, session);
      const limits = effectiveLimits(global, now);
      const cap = kind === 'transfer' ? limits.transferPermits : limits.processingPermits;
      const perHost = kind === 'transfer' ? 2 : 1;
      const active = await store.Operation.find({ slot: kind })
        .session(session)
        .lean<StoredUpload[]>();
      // Expired leases retain slots until the old writer has been positively joined.
      if (
        active.length >= cap ||
        active.filter((r) => r.worker?.hostId === worker.hostId).length >= perHost ||
        active.filter((r) => r.worker?.instanceId === worker.instanceId).length >= perHost
      )
        return null;
      const held = await store.Operation.find({
        stagingHeld: true,
        'worker.instanceId': worker.instanceId,
      })
        .session(session)
        .lean<StoredUpload[]>();
      const heldBytes = held.reduce((sum, r) => sum + r.declaredBytes, 0);
      const state = kind === 'transfer' ? 'waiting' : 'queued_processing';
      const rows = await store.Operation.find({ state, stagingHeld: false })
        .sort({ createdAt: 1, _id: 1 })
        .limit(128)
        .session(session)
        .lean<StoredUpload[]>();
      const heads = new Map<string, { row: StoredUpload; turn: number }>();
      for (const row of rows) {
        if (
          (kind === 'transfer' && row.createdAt + WAIT_MS <= now) ||
          (kind === 'processing' &&
            (row.expiresAt! <= now || row.processingQueuedAt! + PROCESS_MS <= now))
        )
          continue;
        const key = JSON.stringify([row.tenantId, row.userId]);
        if (!heads.has(key))
          heads.set(key, { row, turn: await store.touchPrincipal(principalOf(row), session) });
      }
      const candidates = [...heads.values()].sort(
        (a, b) => a.turn - b.turn || a.row.createdAt - b.row.createdAt,
      );
      const selected = candidates.find(
        ({ row }) => heldBytes + row.declaredBytes <= 112 * 1_048_576,
      );
      if (!selected || (input.operationId && selected.row._id !== input.operationId)) return null;
      const row = selected.row;
      if (
        kind === 'processing' &&
        global.textBytes + UPLOAD_MAX_TEXT_BYTES - row.textBytes > RESOURCE_MAX.textBytes
      )
        return null;
      row.generation++;
      row.workerGeneration = row.generation;
      row.workerKind = kind;
      row.slot = kind;
      row.worker = worker;
      row.writerStopped = false;
      delete row.parserExecution;
      delete row.publishedDigest;
      row.leaseExpiresAt = now + LEASE_MS;
      row.stagingHeld = true;
      row.state = kind === 'transfer' ? 'transferring' : 'processing';
      if (kind === 'transfer') row.attemptGeneration = row.generation;
      else {
        global.textBytes += UPLOAD_MAX_TEXT_BYTES - row.textBytes;
        row.textBytes = UPLOAD_MAX_TEXT_BYTES;
        await lifecycle.claimManagedUploadProcessing(
          principalOf(row),
          row._id,
          row.generation,
          now,
          session,
        );
      }
      await store.touchPrincipal(principalOf(row), session, ++global.turn);
      await store.save(row, session);
      return leaseFor(row);
    });
  }
  async function fail(
    lease: UploadLease,
    code: UploadErrorCode,
    now: number,
  ): Promise<UploadOperation> {
    return store.transaction(async (session, global) => {
      const row = await store.Operation.findById(lease.operationId)
        .session(session)
        .lean<StoredUpload>();
      assertLease(row, lease, now);
      terminal(row, global, 'failed', code);
      await store.save(row, session);
      return project(row, now);
    });
  }
  async function remove(
    principal: UploadPrincipal,
    id: string,
    now: number,
    deleting: boolean,
  ): Promise<UploadOperation> {
    return store.transaction(async (session, global) => {
      const row = await owned(principal, id, session);
      if (
        row.state === 'deleted' ||
        row.state === 'expired' ||
        (row.state === 'cancelled' && !deleting)
      )
        return project(row, now);
      if (!deleting && row.state === 'ready') reject('not_ready');
      let state: StoredUpload['state'] = 'cancelled';
      if (deleting) state = 'deleted';
      else if (row.acceptedAt != null) state = 'failed';
      terminal(row, global, state, 'cancelled');
      if (deleting && row.acceptedAt != null)
        await lifecycle.revokeManagedUpload(principal, id, now, session);
      await store.save(row, session);
      return project(row, now);
    });
  }
  return {
    initialize: store.initialize,
    ...createUploadControlMethods(store),
    ...createUploadMigrationMethods(store),
    ...createUploadActivationMethods(store),
    ...createUploadAdmissionMethods(store),
    reserve,
    usage,
    async findReservation(principal, key, fingerprint, now) {
      const row = await store.Operation.findOne({
        ...principalFilter(principal),
        idempotencyKey: key,
      }).lean<StoredUpload>();
      if (!row) return null;
      if (row.fingerprint !== fingerprint) reject('idempotency_conflict');
      return project(row, now);
    },
    async get(principal, id, now) {
      const result = project(await owned(principal, id), now);
      if (result.canUseInComposer || result.canRetryProcessing) {
        const [file] = await lifecycle.getManagedUploadAvailability(principal, [id], now);
        result.canUseInComposer = result.canUseInComposer && file?.ready === true;
        result.canRetryProcessing = result.canRetryProcessing && file != null;
      }
      return result;
    },
    async list(principal, now) {
      const rows = await store.Operation.find(principalFilter(principal))
        .sort({ createdAt: -1, _id: -1 })
        .limit(100)
        .lean<StoredUpload[]>();
      const available = new Map(
        (
          await lifecycle.getManagedUploadAvailability(
            principal,
            rows.map((row) => row._id),
            now,
          )
        ).map((file) => [file.fileId, file]),
      );
      return rows.map((row) => {
        const result = project(row, now);
        return {
          ...result,
          canUseInComposer: result.canUseInComposer && available.get(row._id)?.ready === true,
          canRetryProcessing: result.canRetryProcessing && available.has(row._id),
        };
      });
    },
    claim,
    async renew(lease, now) {
      return store.transaction(async (session) => {
        const row = await store.Operation.findById(lease.operationId)
          .session(session)
          .lean<StoredUpload>();
        assertLease(row, lease, now);
        if (
          !['transferring', 'processing'].includes(row.state) ||
          (row.expiresAt != null && row.expiresAt <= now)
        )
          reject('lease_lost');
        row.leaseExpiresAt = now + LEASE_MS;
        await store.save(row, session);
        return leaseFor(row);
      });
    },
    async accept(principal, lease, receipt, now) {
      // Capture the trusted acknowledgement before awaiting Mongo; callers retain no mutable
      // reference to the identity that this transaction may commit or replay.
      const outcome = receipt?.outcome;
      const bytes = receipt?.bytes;
      const original = isUploadStorageReceipt(receipt)
        ? {
            ...receipt,
            ...(receipt.integrity
              ? {
                  integrity: {
                    ...receipt.integrity,
                    chunkSha256: [...receipt.integrity.chunkSha256],
                  },
                }
              : {}),
          }
        : undefined;
      return store.transaction(async (session) => {
        const row = await owned(principal, lease.operationId, session);
        if (row.acceptedAt != null) {
          if (
            lease.kind !== 'transfer' ||
            lease.generation !== row.attemptGeneration ||
            lease.tenantId !== row.tenantId ||
            lease.userId !== row.userId
          )
            reject('lease_lost');
          if (!original || !row.original || uploadDigest(original) !== uploadDigest(row.original))
            reject('idempotency_conflict');
          return project(row, now);
        }
        assertLease(row, lease, now);
        if (row.slot !== 'transfer' || row.state !== 'transferring') reject('lease_lost');
        if (outcome !== 'durable') reject('storage_uncertain');
        if (
          bytes !== row.declaredBytes ||
          !Number.isSafeInteger(bytes) ||
          bytes > UPLOAD_MAX_FILE_BYTES
        )
          reject('size_mismatch');
        const expectedKey = `t/${row.tenantId}/managed-uploads/${row.userId}/${row._id}.${row.attemptGeneration}__original`;
        if (
          !original ||
          original.source !== 's3' ||
          original.storageKey !== expectedKey ||
          !isUploadOriginalIntegrity(original.integrity, original.bytes)
        )
          reject('invalid_request');
        await store.touchPrincipal(principal, session);
        row.acceptedAt = now;
        row.expiresAt = now + UPLOAD_RETENTION_MS;
        row.fileId = row._id;
        row.actualBytes = original.bytes;
        row.original = original;
        row.pendingBytes = 0;
        row.state = 'queued_processing';
        row.processingQueuedAt = now;
        row.cleanupPending = row.stagingHeld;
        // Durable put has completed. Its local copy remains reserved until independently removed.
        row.writerStopped = true;
        delete row.slot;
        delete row.leaseExpiresAt;
        await lifecycle.acceptManagedUpload(
          {
            principal,
            operationId: row._id,
            filename: row.filename,
            mediaType: row.mediaType,
            receipt: original,
            acceptedAt: now,
            expiresAt: row.expiresAt,
          },
          session,
        );
        await store.save(row, session);
        return project(row, now);
      });
    },
    async publish(lease, result, now) {
      if (
        result.writerStopped !== true ||
        !result.text ||
        Buffer.byteLength(result.text, 'utf8') > UPLOAD_MAX_TEXT_BYTES
      )
        reject('processing_failed');
      return store.transaction(async (session, global) => {
        const row = await store.Operation.findById(lease.operationId)
          .session(session)
          .lean<StoredUpload>();
        const digest = uploadDigest(result.text);
        if (
          row?.state === 'ready' &&
          row.generation === lease.generation &&
          row.tenantId === lease.tenantId &&
          row.userId === lease.userId &&
          row.worker?.hostId === lease.hostId &&
          row.worker?.instanceId === lease.instanceId &&
          row.publishedDigest === digest
        )
          return project(row, now);
        assertLease(row, lease, now);
        if (
          row.state !== 'processing' ||
          row.slot !== 'processing' ||
          row.expiresAt! <= now ||
          !row.parserExecution
        )
          reject('lease_lost');
        await lifecycle.publishManagedUpload(
          principalOf(row),
          row._id,
          row.generation,
          result.text,
          now,
          session,
        );
        const actual = Buffer.byteLength(result.text, 'utf8');
        global.textBytes -= row.textBytes - actual;
        row.textBytes = actual;
        row.state = 'ready';
        row.cleanupPending = row.stagingHeld;
        row.publishedDigest = digest;
        row.writerStopped = true;
        delete row.slot;
        delete row.leaseExpiresAt;
        delete row.error;
        store.releaseQueue(row, global);
        await store.save(row, session);
        return project(row, now);
      });
    },
    cancel: (principal, id, now) => remove(principal, id, now, false),
    delete: (principal, id, now) => remove(principal, id, now, true),
    async retryProcessing(principal, id, now) {
      return store.transaction(async (session, global) => {
        const row = await owned(principal, id, session);
        if (
          row.state === 'queued_processing' ||
          row.state === 'processing' ||
          row.state === 'ready'
        )
          return project(row, now);
        if (
          row.state !== 'failed' ||
          row.acceptedAt == null ||
          row.expiresAt! <= now ||
          row.originalRemoved
        )
          reject('not_ready');
        if (row.slot || row.stagingHeld) reject('not_ready');
        if (
          (await store.Operation.countDocuments({
            ...principalFilter(principal),
            queueCharged: true,
          }).session(session)) >= 2
        )
          reject('queue_full');
        await lifecycle.touchManagedUploadForRetry(principal, id, now, session);
        store.chargeQueue(row, global);
        row.state = 'queued_processing';
        row.processingQueuedAt = now;
        delete row.error;
        await store.save(row, session);
        return project(row, now);
      });
    },
    fail,
    async confirmCleanup(proof, now) {
      return store.transaction(async (session, global) => {
        const row = await store.Operation.findById(proof.operationId)
          .session(session)
          .lean<StoredUpload>();
        if (!row || (row.workerGeneration ?? row.generation) !== proof.generation)
          reject('lease_lost');
        if (!proof.writerStopped) reject('not_ready');
        row.writerStopped = true;
        if (row.slot && ['transferring', 'processing'].includes(row.state))
          terminal(row, global, 'failed', 'processing_failed');
        delete row.slot;
        delete row.leaseExpiresAt;
        if (proof.localCopiesAbsent) row.stagingHeld = false;
        const removeOriginal = row.acceptedAt == null || ['deleted', 'expired'].includes(row.state);
        if (proof.originalAbsent && removeOriginal) {
          global.originalBytes -= row.originalBytes;
          global.objectBytes -= row.originalBytes;
          row.originalBytes = 0;
          row.originalRemoved = true;
        }
        if (proof.textAndHistoryRemoved && row.state !== 'ready') {
          global.textBytes -= row.textBytes;
          row.textBytes = 0;
          row.textRemoved = true;
        }
        row.cleanupPending =
          row.stagingHeld || (removeOriginal && (row.originalBytes > 0 || row.textBytes > 0));
        await store.save(row, session);
        return project(row, now);
      });
    },
    async getProcessingInput(lease, now) {
      const row = await store.Operation.findById(lease.operationId).lean<StoredUpload>();
      assertLease(row, lease, now);
      if (
        row.slot !== 'processing' ||
        !isUploadStorageReceipt(row.original) ||
        row.original.outcome !== 'durable' ||
        row.original.bytes !== row.actualBytes ||
        !isUploadOriginalIntegrity(row.original.integrity, row.actualBytes!) ||
        row.expiresAt! <= now
      )
        reject('not_ready');
      return {
        operationId: row._id,
        attemptGeneration: row.attemptGeneration!,
        filename: row.filename,
        mediaType: row.mediaType,
        bytes: row.actualBytes!,
        original: row.original,
      };
    },
    async bindProcessingExecution(lease, execution, now) {
      if (
        execution.attemptId !== `${lease.operationId}.${lease.generation}` ||
        !execution.instanceId ||
        execution.instanceId.length > 128 ||
        !Number.isSafeInteger(Date.parse(execution.expiresAt)) ||
        Date.parse(execution.expiresAt) <= now ||
        Date.parse(execution.expiresAt) > now + 60_000
      )
        reject('invalid_request');
      await store.transaction(async (session) => {
        const row = await store.Operation.findById(lease.operationId)
          .session(session)
          .lean<StoredUpload>();
        assertLease(row, lease, now);
        if (
          row.slot !== 'processing' ||
          row.state !== 'processing' ||
          row.expiresAt! <= now ||
          (row.parserExecution && uploadDigest(row.parserExecution) !== uploadDigest(execution))
        )
          reject('lease_lost');
        if (row.parserExecution) return;
        row.parserExecution = { ...execution };
        await store.save(row, session);
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
      const principal: UploadPrincipal = { ...owner, authentication: 'verified-email' };
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
    watchChanges({ tenantId, onChanged, onReset }) {
      if (typeof tenantId !== 'string' || !tenantId || tenantId.length > 128)
        reject('invalid_request');
      // A missing document or collection invalidation is a reset-only system signal, never tenant data authority.
      // eslint-disable-next-line no-restricted-syntax -- Server hub uses an explicit tenantId $match and metadata-only projection; unroutable lifecycle events can only reset.
      const stream = store.Operation.watch(
        [
          {
            $match: {
              $or: [
                { 'fullDocument.tenantId': tenantId },
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
      const pending = new Map<string, { tenantId: string; userId: string }>();
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
        if (row.tenantId !== tenantId) return;
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
            terminal(row, global, 'expired', 'expired');
            await lifecycle.revokeManagedUpload(principalOf(row), row._id, now, session);
            transitioned = true;
          } else if (
            row.slot &&
            row.leaseExpiresAt! <= now &&
            !['failed', 'deleted', 'expired', 'cancelled'].includes(row.state)
          ) {
            terminal(row, global, 'failed', 'lease_lost');
            transitioned = true;
          } else if (['waiting', 'queued_processing'].includes(row.state)) {
            terminal(row, global, 'failed', 'expired');
            transitioned = true;
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
            if (!tombstone) {
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
