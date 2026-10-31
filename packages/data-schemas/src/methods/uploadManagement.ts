import type { NasAntivirusAdmission } from './uploadManagementNasTypes';
import { createUploadWriteMethods } from './uploadManagementWrite';
import { createUploadNasMethods } from './uploadManagementNas';
/** Compose the existing upload store, reservation and lifecycle owners; retain one repository. */
import {
  UPLOAD_MAX_FILE_BYTES,
  readUploadOriginalWriteBinding,
  UPLOAD_USER_WINDOW_BYTES,
  UPLOAD_WINDOW_MS,
  UPLOAD_AV_RECORD_BYTES,
  UPLOAD_DERIVED_MAX_ORIGIN_BYTES,
  readHistoricalUploadSecuritySettlement,
  readUploadDerivedIntent,
  readUploadDerivedOrigin,
  uploadReservationFingerprint,
} from 'librechat-data-provider';
import type {
  UploadPrincipal,
  UploadReserveInput,
  UploadDerivedReserveInput,
  UploadOperation,
  UploadUsage,
  UploadLease,
  UploadErrorCode,
  UploadCleanupTask,
} from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { UploadManagementRepository, UploadPublicationPort } from './uploadManagementTypes';
import type { StoredUpload, UploadStoreOptions } from './uploadManagementStore';
import {
  createUploadStore,
  principalFilter,
  storedUploadPrincipal,
  project,
  assertLease,
  reject,
  RESOURCE_MAX,
} from './uploadManagementStore';
import { createUploadActivationMethods } from './uploadManagementActivation';
import {
  createUploadIntakeMethods,
  hasStoppedUploadPromotion,
  readStoredUploadPromotion,
} from './uploadManagementIntake';
import {
  createUploadCleanupMethods,
  actorCleanupFacts,
  createUploadCleanupTransitions,
} from './uploadManagementCleanup';
import {
  hasCurrentUploadSecurityApproval,
  hasCompleteUploadSecurityExecution,
} from './uploadManagement.security';
import {
  createFileRetentionMethods,
  FileSourceCapacityError,
  FileSourceUnavailableError,
} from './fileRetention';
import { createUploadAdmissionMethods, readUploadAdmission } from './uploadManagementAdmission';
import { createUploadHousekeepingProjection } from './uploadHousekeepingProjection';
import { createUploadProcessingMethods } from './uploadManagementProcessing';
import { createUploadCleanupReceiptMethods } from './uploadCleanupReceipts';
import { createUploadMigrationMethods } from './uploadManagementMigration';
import { createUploadControlMethods } from './uploadManagementControl';
import { createUploadHousekeepingMethods } from './uploadHousekeeping';
import { createFileActivityRepository } from './fileActivity';
import { createHousekeepingStore } from './housekeepingStore';
import { touchActiveUserPrincipal } from './userPrincipal';
export type { UploadManagementRepository } from './uploadManagementTypes';

export function createUploadManagementRepository(
  mongoose: typeof import('mongoose'),
  options: UploadStoreOptions & {
    recordOriginalPublication?: UploadPublicationPort;
    nasAntivirusAdmission?: NasAntivirusAdmission;
  } = {},
): UploadManagementRepository {
  const store = createUploadStore(mongoose, options);
  const jobs = createHousekeepingStore(mongoose);
  const projectHousekeeping = createUploadHousekeepingProjection(jobs);
  const lifecycle = createFileRetentionMethods(mongoose, {
    securityPolicySha256: options.securityPolicySha256,
    extractionPolicySha256: options.extractionPolicySha256,
  });
  const securityPolicySha256 = options.securityPolicySha256;
  const principalOf = storedUploadPrincipal;
  const cleanupTask = (row: StoredUpload): UploadCleanupTask => {
    const binding = row.writeBinding ? readUploadOriginalWriteBinding(row.writeBinding) : null;
    if (row.writeBinding && !binding) reject('migration_conflict');
    return {
      operationId: row._id,
      generation: row.workerGeneration ?? row.generation,
      attemptGeneration: row.attemptGeneration,
      principal: principalOf(row),
      worker: row.worker,
      original: row.original,
      ...(binding ? { writeBinding: binding } : {}),
      fileId: row.fileId,
      state: row.state,
      parserExecution: row.parserExecution,
      securityExecution: row.securityExecution,
      securitySettlement: row.securitySettlement,
      promotion: readStoredUploadPromotion(row),
      writerStopped:
        (row.writerStopped === true || actorCleanupFacts(row).writerStopped) &&
        hasStoppedUploadPromotion(row) &&
        (!row.securityExecution || hasCompleteUploadSecurityExecution(row)),
      localCopiesAbsent: row.stagingHeld === false || actorCleanupFacts(row).localCopiesAbsent,
    };
  };
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
  const { terminal, applyCleanup } = createUploadCleanupTransitions(store);
  async function reserve(
    principal: UploadPrincipal,
    input: UploadReserveInput | UploadDerivedReserveInput,
    now: number,
    derivedMode = false,
  ): Promise<UploadOperation> {
    principalFilter(principal);
    principal = { ...principal };
    const allowed = new Set([
      'operationId',
      'idempotencyKey',
      'fingerprint',
      'mediaType',
      'declaredBytes',
      'scope',
      ...(derivedMode ? ['derived'] : []),
    ]);
    if (
      !input ||
      typeof input !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Reflect.ownKeys(input).some(
        (key) =>
          typeof key !== 'string' ||
          !allowed.has(key) ||
          !('value' in (Object.getOwnPropertyDescriptor(input, key) ?? {})),
      )
    )
      reject('invalid_request');
    if (
      input.scope !== undefined &&
      (!input.scope ||
        typeof input.scope !== 'object' ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(input.scope)) ||
        !('value' in (Object.getOwnPropertyDescriptor(input.scope, 'kind') ?? {})))
    )
      reject('invalid_request');
    if (input.scope !== undefined && input.scope.kind !== 'personal') reject('forbidden');
    if (input.scope !== undefined && Reflect.ownKeys(input.scope).some((key) => key !== 'kind'))
      reject('invalid_request');
    const derived = derivedMode
      ? readUploadDerivedIntent('derived' in input ? input.derived : undefined)
      : undefined;
    if (derivedMode && !derived) reject('invalid_request');
    const scope = { kind: 'personal' as const };
    // Snapshot the technical reservation before any await; never retain caller metadata.
    input = { ...input, ...(derived ? { derived } : {}), scope: { kind: 'personal' } };
    if (
      !Number.isSafeInteger(input.declaredBytes) ||
      input.declaredBytes <= 0 ||
      input.declaredBytes > UPLOAD_MAX_FILE_BYTES ||
      typeof input.operationId !== 'string' ||
      !/^[a-zA-Z0-9-]{1,128}$/.test(input.operationId) ||
      typeof input.idempotencyKey !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        input.idempotencyKey,
      ) ||
      typeof input.mediaType !== 'string' ||
      !input.mediaType ||
      input.mediaType.length > 128
    )
      reject('invalid_request');
    const fingerprint = uploadReservationFingerprint({ ...input, scope }, derived ?? undefined);
    // Current native TXT/CSV qualification leaves bounded room for all three integrity copies.
    // Never impose a late journal size rejection after a writer or durable PUT has started.
    if (
      derived &&
      (!['text/plain', 'text/csv'].includes(input.mediaType) || input.declaredBytes > 65_536)
    )
      reject('invalid_request');
    if (fingerprint !== input.fingerprint) reject('invalid_request');
    return store.transaction(async (session, global) => {
      const owner = principalFilter(principal);
      await touchActiveUserPrincipal(mongoose, owner, session);
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
        global.recordBytes + UPLOAD_AV_RECORD_BYTES > RESOURCE_MAX.recordBytes ||
        global.bundles >= RESOURCE_MAX.bundles
      )
        reject('capacity_exceeded');
      let derivedOrigin;
      if (derived) {
        try {
          derivedOrigin = await lifecycle.captureManagedUploadOrigin(
            principal,
            derived,
            now,
            session,
          );
        } catch (error) {
          if (error instanceof FileSourceCapacityError) reject('capacity_exceeded');
          if (error instanceof FileSourceUnavailableError) reject('not_found');
          throw error;
        }
        // Reserve half of the existing record allowance for the native bounded receipt/worker
        // journal, before any external writer exists. Never reject cleanup because of row size.
        if (
          mongoose.mongo.BSON.calculateObjectSize({ derivedOrigin, fingerprint }) >
          UPLOAD_DERIVED_MAX_ORIGIN_BYTES
        )
          reject('capacity_exceeded');
      }
      const row: StoredUpload = {
        _id: input.operationId,
        tenantId: principal.tenantId,
        userId: principal.userId,
        scope,
        idempotencyKey: input.idempotencyKey,
        fingerprint,
        ...(derivedOrigin ? { derivedOrigin } : {}),
        mediaType: input.mediaType,
        declaredBytes: input.declaredBytes,
        state: 'waiting',
        revision: 1,
        createdAt: now,
        generation: 0,
        cleanupPending: false,
        cleanupCustody: { version: 1 },
        originalBytes: input.declaredBytes,
        textBytes: 0,
        recordBytes: UPLOAD_AV_RECORD_BYTES,
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
      await projectHousekeeping(null, row, session);
      return project(row, now);
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
  const context = {
    mongoose,
    store,
    lifecycle,
    securityPolicySha256,
    principalOf,
    owned,
    terminal,
    cleanupTask,
    applyCleanup,
    usage,
    recordOriginalPublication: options.recordOriginalPublication,
    nasAntivirusAdmission: options.nasAntivirusAdmission,
  };
  return {
    ...createUploadWriteMethods(context),
    ...createUploadNasMethods(context),
    ...createUploadProcessingMethods(context),
    ...createUploadCleanupMethods(context),
    ...createUploadHousekeepingMethods(context, jobs, projectHousekeeping),
    ...createUploadCleanupReceiptMethods(context, jobs),
    async initialize() {
      await store.initialize();
      await jobs.initialize();
    },
    fileReads: createFileActivityRepository(mongoose, store, options),
    ...createUploadControlMethods(store),
    ...createUploadMigrationMethods(store, securityPolicySha256),
    ...createUploadActivationMethods(store, {
      retrievalInventoryAuthority: options.retrievalInventoryAuthority,
    }),
    ...createUploadAdmissionMethods(store),
    ...createUploadIntakeMethods(store, securityPolicySha256, applyCleanup),
    reserve: (principal, input, now) => reserve(principal, input, now),
    reserveDerived: (principal, input, now) => reserve(principal, input, now, true),
    usage,
    async findReservation(principal, key, fingerprint, now) {
      const owner = principalFilter(principal);
      return store.transaction(async (session) => {
        await touchActiveUserPrincipal(mongoose, owner, session);
        const row = await store.Operation.findOne({ ...owner, idempotencyKey: key })
          .session(session)
          .lean<StoredUpload>();
        if (!row) return null;
        if (row.fingerprint !== fingerprint) reject('idempotency_conflict');
        return project(row, now);
      });
    },
    async getDerivedOperation(principal, id, expectedBinding, now) {
      principalFilter(principal);
      principal = { ...principal };
      const binding = readUploadDerivedIntent({
        binding: expectedBinding,
        directSourceFileIds: [],
      })?.binding;
      if (!binding) reject('invalid_request');
      return store.transaction(async (session) => {
        await touchActiveUserPrincipal(mongoose, principal, session);
        const row = await owned(principal, id, session);
        const origin = readUploadDerivedOrigin(row.derivedOrigin);
        if (
          !origin ||
          origin.binding.purpose !== binding.purpose ||
          origin.binding.sourceId !== binding.sourceId ||
          origin.binding.sourceRevision !== binding.sourceRevision
        )
          reject('not_found');
        return project(row, now);
      });
    },
    async get(principal, id, now) {
      const row = await owned(principal, id);
      const result = project(row, now);
      const approved = hasCurrentUploadSecurityApproval(row, securityPolicySha256, now);
      result.canUseInComposer = result.canUseInComposer && approved;
      result.canRetryProcessing = result.canRetryProcessing && approved;
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
        const approved = hasCurrentUploadSecurityApproval(row, securityPolicySha256, now);
        return {
          ...result,
          canUseInComposer:
            result.canUseInComposer && approved && available.get(row._id)?.ready === true,
          canRetryProcessing: result.canRetryProcessing && approved && available.has(row._id),
        };
      });
    },
    cancel: (principal, id, now) => remove(principal, id, now, false),
    delete: (principal, id, now) => remove(principal, id, now, true),
    fail,
    async confirmCleanup(proof, now) {
      const settlement =
        proof.securitySettlement === undefined
          ? undefined
          : readHistoricalUploadSecuritySettlement(proof.securitySettlement);
      if (settlement === null) reject('invalid_request');
      return store.transaction(async (session, global) => {
        const row = await store.Operation.findById(proof.operationId)
          .session(session)
          .lean<StoredUpload>();
        if (!row) reject('lease_lost');
        applyCleanup(
          row,
          { ...proof, ...(settlement ? { securitySettlement: settlement } : {}) },
          global,
        );
        await store.save(row, session);
        return project(row, now);
      });
    },
  };
}
