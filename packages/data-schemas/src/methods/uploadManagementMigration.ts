/** Private frozen snapshot, validated import and single-owner cutover for the upload repository. */
import { mongo } from 'mongoose';
import { randomUUID } from 'crypto';
import {
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_MAX_TEXT_BYTES,
  UPLOAD_RECORD_BYTES,
  UPLOAD_RETENTION_MS,
  isUploadOriginalIntegrity,
  isUploadStorageReceipt,
  readUploadAcceptedMetadata,
  readHistoricalUploadDerivedOrigin,
  uploadReservationFingerprint,
} from 'librechat-data-provider';
import type {
  UploadMigrationPage,
  FileRetentionMigrationRecord,
  UploadMigrationReceipt,
} from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type {
  UploadStore,
  StoredUpload,
  CounterRow,
  GlobalState,
  ResourceTotals,
  SnapshotHeader,
  MigrationState,
} from './uploadManagementStore';
import type { UploadMigrationMethods } from './uploadManagementTypes';
import {
  uploadDigest,
  invalidateFileHousekeepingCoverage,
  RESOURCE_MAX,
  MAX_QUEUE_BYTES,
  FALLBACK_LIMITS,
  hasValidUploadPublicationTime,
  reject,
} from './uploadManagementStore';
import {
  prepareFileRetentionMigration,
  verifyFrozenFileRetentionMigration,
  assertFrozenFileRetentionPopulation,
  thawFileRetentionMigrationPage,
} from './fileRetentionMigration';
import { validateUploadCleanupCustody, assertUploadCleanupCapacity } from './uploadCleanupReceipts';
import { validateUploadMigrationSecurity } from './uploadManagement.security';
import { projectUploadHousekeeping } from './uploadHousekeepingProjection';
import { validateUploadMigrationIntake } from './uploadManagementIntake';
import { validateUploadFileCleanupMigration } from './uploadFileCleanup';
import { readUploadAdmission } from './uploadManagementAdmission';
import { uploadSecurityPolicySha256 } from './fileSecurity';

/** One private replacement protocol; the existing File/storage owners reconcile their own data. */
export function createUploadMigrationMethods(
  store: UploadStore,
  securityPolicySha256?: string,
): UploadMigrationMethods {
  const policy = uploadSecurityPolicySha256(securityPolicySha256);
  const keys = Object.keys(RESOURCE_MAX) as (keyof ResourceTotals)[];
  const totalsOf = (source: ResourceTotals): ResourceTotals =>
    Object.fromEntries(keys.map((key) => [key, source[key]])) as ResourceTotals;
  const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
    Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
  const id = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-zA-Z0-9-]{1,128}$/.test(value);
  const text = (value: unknown, max: number): value is string => {
    if (typeof value !== 'string' || value.length === 0 || value.length > max) return false;
    // eslint-disable-next-line no-control-regex -- Reject control characters in imported identifiers and metadata before admitting a snapshot.
    return !/[\x00-\x1f]/.test(value);
  };
  const pageKey = (cursor: string | null): string => (cursor == null ? 'first' : `after-${cursor}`);
  const currentKey = (value: unknown): value is string =>
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
  function validateTotals(value: ResourceTotals): void {
    if (
      !value ||
      keys.some((key) => !integer(value[key], RESOURCE_MAX[key])) ||
      value.objectBytes < value.originalBytes
    )
      reject('migration_conflict');
  }
  function validateRow(value: unknown): StoredUpload {
    if (!value || typeof value !== 'object' || Array.isArray(value)) reject('migration_conflict');
    const row = value as StoredUpload;
    validateUploadCleanupCustody(row);
    try {
      assertUploadCleanupCapacity(row, mongo.BSON.calculateObjectSize);
    } catch {
      reject('migration_conflict');
    }
    if (!hasValidUploadPublicationTime(row)) reject('migration_conflict');
    const origin =
      row.derivedOrigin === undefined
        ? undefined
        : readHistoricalUploadDerivedOrigin(row.derivedOrigin);
    if (origin === null) reject('migration_conflict');
    if (
      origin &&
      (!['text/plain', 'text/csv'].includes(row.mediaType) ||
        row.declaredBytes > 65_536 ||
        mongo.BSON.calculateObjectSize({ derivedOrigin: origin, fingerprint: row.fingerprint }) >
          UPLOAD_RECORD_BYTES / 2 ||
        (row.original && row.original.filepath !== `/api/files/managed/${row._id}`))
    )
      reject('migration_conflict');
    if (
      origin?.ancestors.some(
        (source) =>
          source.subject.operationId === row._id ||
          source.subject.userId !== row.userId ||
          source.subject.tenantId !== row.tenantId,
      )
    )
      reject('migration_conflict');
    const derived = origin
      ? { binding: origin.binding, directSourceFileIds: origin.directSourceFileIds }
      : undefined;
    if (
      Object.keys(row).some((key) => !store.Operation.schema.path(key)) ||
      !id(row._id) ||
      !(
        row.tenantId === null ||
        (text(row.tenantId, 128) &&
          /^[a-zA-Z0-9_.-]{1,128}$/.test(row.tenantId) &&
          row.tenantId !== '__SYSTEM__')
      ) ||
      !text(row.userId, 128) ||
      row.scope?.kind !== 'personal' ||
      !currentKey(row.idempotencyKey) ||
      (row.acceptedAt == null
        ? row.filename !== undefined
        : !readUploadAcceptedMetadata({ filename: row.filename })) ||
      !text(row.mediaType, 128) ||
      !integer(row.declaredBytes, UPLOAD_MAX_FILE_BYTES) ||
      row.declaredBytes === 0 ||
      row.fingerprint !== uploadReservationFingerprint(row, derived) ||
      !integer(row.createdAt, 8.64e15 - UPLOAD_RETENTION_MS) ||
      !integer(row.generation) ||
      !integer(row.revision) ||
      row.revision === 0 ||
      ![
        'waiting',
        'queued_processing',
        'ready',
        'failed',
        'cancelled',
        'deleted',
        'expired',
      ].includes(row.state) ||
      row.slot != null ||
      row.stagingHeld !== false ||
      row.leaseExpiresAt != null ||
      (row.writerStopped !== undefined && typeof row.writerStopped !== 'boolean') ||
      (row.workerKind !== undefined && !['transfer', 'processing'].includes(row.workerKind)) ||
      typeof row.cleanupPending !== 'boolean' ||
      typeof row.queueCharged !== 'boolean' ||
      ![0, row.declaredBytes].includes(row.originalBytes) ||
      ![0, row.declaredBytes].includes(row.pendingBytes) ||
      !integer(row.textBytes, UPLOAD_MAX_TEXT_BYTES) ||
      row.recordBytes !== UPLOAD_RECORD_BYTES
    )
      reject('migration_conflict');
    if (
      row.queueCharged !== ['waiting', 'queued_processing'].includes(row.state) ||
      row.pendingBytes !== (row.state === 'waiting' ? row.declaredBytes : 0)
    )
      reject('migration_conflict');
    for (const field of [
      'attemptGeneration',
      'workerGeneration',
      'byteLeaseGeneration',
      'byteLeaseUntil',
      'processingQueuedAt',
    ] as const) {
      if (row[field] != null && !integer(row[field])) reject('migration_conflict');
    }
    if (
      (row.attemptGeneration ?? 0) > row.generation ||
      (row.workerGeneration ?? 0) > row.generation ||
      (row.worker && (!text(row.worker.hostId, 128) || !text(row.worker.instanceId, 128)))
    )
      reject('migration_conflict');
    if (row.acceptedAt != null) {
      if (
        !integer(row.acceptedAt, 8.64e15 - UPLOAD_RETENTION_MS) ||
        row.acceptedAt < row.createdAt ||
        !integer(row.expiresAt, 8.64e15) ||
        row.expiresAt <= row.acceptedAt ||
        row.actualBytes !== row.declaredBytes ||
        row.fileId !== row._id ||
        !row.attemptGeneration ||
        !isUploadStorageReceipt(row.original) ||
        row.original.outcome !== 'durable' ||
        (row.originalBytes > 0 &&
          !isUploadOriginalIntegrity(row.original.integrity, row.declaredBytes)) ||
        row.original.source !== 's3' ||
        row.original.bytes !== row.actualBytes ||
        !text(row.original.filepath, 4096) ||
        row.original.storageKey !==
          `${row.tenantId === null ? '' : `t/${row.tenantId}/`}managed-uploads/${row.userId}/${row._id}.${row.attemptGeneration}__original` ||
        ['waiting', 'cancelled'].includes(row.state)
      )
        reject('migration_conflict');
    } else if (
      row.actualBytes != null ||
      row.expiresAt != null ||
      row.fileId != null ||
      row.original != null ||
      row.textBytes !== 0 ||
      ['queued_processing', 'ready', 'expired'].includes(row.state)
    )
      reject('migration_conflict');
    if (row.originalBytes === 0 && row.originalRemoved !== true) reject('migration_conflict');
    if (
      row.originalRemoved === true &&
      (row.originalBytes !== 0 || ['ready', 'queued_processing', 'waiting'].includes(row.state))
    )
      reject('migration_conflict');
    if (
      row.parserExecution &&
      (row.parserExecution.attemptId !== `${row._id}.${row.workerGeneration}` ||
        !text(row.parserExecution.instanceId, 128) ||
        !Number.isFinite(Date.parse(row.parserExecution.expiresAt)))
    )
      reject('migration_conflict');
    validateUploadMigrationSecurity(row, securityPolicySha256, Date.now());
    validateUploadMigrationIntake(row);
    return row;
  }
  async function prepareExportRow(
    row: StoredUpload,
    epoch: string,
    frozenAt: number,
    session: ClientSession,
  ): Promise<FileRetentionMigrationRecord | null> {
    const fresh = await store.Operation.findById(row._id).session(session).lean<StoredUpload>();
    if (!fresh || !policy) reject('migration_conflict');
    Object.assign(row, fresh);
    const origin =
      row.derivedOrigin === undefined
        ? undefined
        : readHistoricalUploadDerivedOrigin(row.derivedOrigin);
    if (origin === null) reject('migration_conflict');
    const fingerprint = uploadReservationFingerprint(
      row,
      origin
        ? { binding: origin.binding, directSourceFileIds: origin.directSourceFileIds }
        : undefined,
    );
    const legacyFingerprint = JSON.stringify([
      row.scope,
      row.filename,
      row.mediaType,
      row.declaredBytes,
    ]);
    if (
      !text(row.idempotencyKey, 128) ||
      (row.fingerprint !== fingerprint &&
        (origin !== undefined || !text(row.filename, 255) || row.fingerprint !== legacyFingerprint))
    )
      reject('migration_conflict');
    const previous = uploadDigest(row);
    // This owner is frozen. Persist redaction and a fresh opaque legacy key atomically with
    // the page, so replay never resurrects names or derives a secret-bearing key/hash.
    row.fingerprint = fingerprint;
    if (row.acceptedAt == null) delete row.filename;
    if (!currentKey(row.idempotencyKey)) row.idempotencyKey = randomUUID();
    // No body was claimed. Invalidate its credential on the frozen source and exported page.
    if (row.intake && row.intake.generation === undefined) {
      validateUploadMigrationIntake(row);
      delete row.intake;
    }
    await validateUploadFileCleanupMigration(store.mongoose, row, session);
    // Reject corrupt Upload metadata before File source preparation consumes it. Keep the
    // final validation below because historical derived normalization can also change the row.
    validateRow(row);
    const file = await prepareFileRetentionMigration(
      store.mongoose,
      row,
      epoch,
      frozenAt,
      session,
      policy,
      true,
    );
    validateRow(row);
    if (uploadDigest(row) !== previous) await store.save(row, session);
    return file;
  }
  async function exactTotals(global: GlobalState, session: ClientSession): Promise<void> {
    const sum = await store.totals(session);
    if (
      keys.some((key) => global[key] !== global.baseline[key] + sum[key]) ||
      sum.queueCount !== global.queueCount ||
      sum.queueBytes !== global.queueBytes
    )
      reject('migration_conflict');
  }
  function seal(state: MigrationState): UploadMigrationReceipt {
    return {
      version: 2,
      epoch: state.epoch,
      sourceId: state.header.sourceId,
      digest: state.digest,
      operations: state.operations,
      sourceRetired: true,
      fileActivity: { ...state.fileActivity },
    };
  }
  return {
    async exportSnapshot({ epoch, cursor, limit = 100 }) {
      if (!id(epoch) || (cursor != null && !id(cursor)) || !integer(limit, 100) || limit === 0)
        reject('invalid_request');
      return store.transaction(async (session, global) => {
        if (!global.migration) {
          if (
            cursor ||
            global.migrationEpoch ||
            !global.storeId ||
            !global.baseline ||
            (await store.Operation.countDocuments({}).session(session)) > limit * 1000 ||
            (await store.Operation.exists({
              $or: [{ slot: { $exists: true } }, { stagingHeld: true }],
            }).session(session))
          )
            reject('migration_conflict');
          validateTotals(global);
          validateTotals(global.baseline);
          await exactTotals(global, session);
          invalidateFileHousekeepingCoverage(
            global,
            uploadDigest(['file-coverage-migration', global.storeId, epoch]),
            'migration',
          );
          global.migration = {
            epoch,
            role: 'export',
            phase: 'paging',
            cursor: null,
            digest: '',
            operations: 0,
            fileActivity: { version: 1, files: 0, sha256: '' },
            pages: {},
            header: {
              retentionFrozenAt: Date.now(),
              sourceId: global.storeId,
              totals: totalsOf(global),
              baseline: { ...global.baseline },
              reconciled: global.reconciled,
              queueCount: global.queueCount,
              queueBytes: global.queueBytes,
              turn: global.turn,
              byteGrants: global.byteGrants.map((grant) => ({ ...grant })),
              admission: readUploadAdmission(global),
            },
          };
          global.enabled = false;
          global.migrationEpoch = epoch;
        }
        const state = global.migration;
        if (state.epoch !== epoch || state.role !== 'export') reject('migration_conflict');
        const key = pageKey(cursor ?? null);
        const previous = state.pages[key];
        if (
          previous
            ? previous.limit !== limit
            : state.phase !== 'paging' || state.cursor !== (cursor ?? null)
        )
          reject('migration_conflict');
        const rows = await store.Operation.find(cursor ? { _id: { $gt: cursor } } : {})
          .sort({ _id: 1 })
          .limit(limit + 1)
          .session(session)
          .lean<StoredUpload[]>();
        const selected = rows.slice(0, limit);
        const fileRecords: FileRetentionMigrationRecord[] = [];
        for (const row of selected) {
          const file = await prepareExportRow(row, epoch, state.header.retentionFrozenAt, session);
          if (file) fileRecords.push(file);
        }
        const principalIds = [
          ...new Set(selected.map((row) => JSON.stringify([row.tenantId, row.userId]))),
        ];
        const principals = await store.Counter.find({ _id: { $in: principalIds } })
          .session(session)
          .lean<CounterRow[]>();
        const turns = new Map(
          principals.map((row) => [row._id, (row.value as { turn: number }).turn]),
        );
        if (principalIds.some((key) => !integer(turns.get(key), state.header.turn)))
          reject('migration_conflict');
        const page: UploadMigrationPage = {
          version: 2,
          epoch,
          cursor: cursor ?? null,
          nextCursor: rows.length > limit ? selected[selected.length - 1]._id : null,
          records: [
            ...(!cursor ? [{ type: 'global', value: state.header }] : []),
            ...fileRecords,
            ...selected.map((value) => ({
              type: 'operation',
              value,
              principalTurn: turns.get(JSON.stringify([value.tenantId, value.userId])),
            })),
          ],
        };
        const digest = uploadDigest(page);
        if (previous && previous.digest !== digest) reject('migration_conflict');
        if (!previous) {
          state.pages[key] = { digest, nextCursor: page.nextCursor, limit };
          state.digest = uploadDigest([state.digest, digest]);
          state.operations += selected.length;
          for (const file of fileRecords) {
            state.fileActivity.files++;
            state.fileActivity.sha256 = uploadDigest([state.fileActivity.sha256, file]);
          }
          state.cursor = page.nextCursor;
          if (page.nextCursor == null) state.phase = 'complete';
        }
        return page;
      }, true);
    },
    async importSnapshot(page) {
      if (
        page.version !== 2 ||
        !id(page.epoch) ||
        !Array.isArray(page.records) ||
        page.records.length > 201 ||
        (page.cursor != null && !id(page.cursor)) ||
        (page.nextCursor != null && !id(page.nextCursor))
      )
        reject('migration_conflict');
      await store.transaction(async (session, global) => {
        const digest = uploadDigest(page),
          key = pageKey(page.cursor);
        if (!global.migration) {
          if (
            global.enabled ||
            global.migrationEpoch ||
            page.cursor != null ||
            keys.some((field) => global[field] !== 0) ||
            (await store.Operation.exists({}).session(session))
          )
            reject('migration_conflict');
          const record = page.records[0];
          if (record?.type !== 'global' || !record.value || typeof record.value !== 'object')
            reject('migration_conflict');
          const header = record.value as SnapshotHeader;
          const admission = readUploadAdmission(header);
          validateTotals(header.totals);
          validateTotals(header.baseline);
          if (
            !integer(header.retentionFrozenAt, Date.now()) ||
            !id(header.sourceId) ||
            header.sourceId === global.storeId ||
            typeof header.reconciled !== 'boolean' ||
            !integer(header.queueCount, 128) ||
            !integer(header.queueBytes, MAX_QUEUE_BYTES) ||
            !integer(header.turn) ||
            !Array.isArray(header.byteGrants) ||
            header.byteGrants.length > 2048 ||
            header.byteGrants.some(
              (grant) =>
                !grant ||
                !integer(grant.at) ||
                !integer(grant.bytes, 4 * 1_048_576) ||
                grant.bytes === 0 ||
                !text(grant.host, 128),
            )
          )
            reject('migration_conflict');
          Object.assign(global, header.totals, {
            baseline: { ...header.baseline },
            queueCount: header.queueCount,
            queueBytes: header.queueBytes,
            turn: header.turn,
            reconciled: false,
            enabled: false,
            controllerUntil: 0,
            policyUntil: 0,
            migrationEpoch: page.epoch,
            byteGrants: header.byteGrants.map((grant) => ({ ...grant })),
            admission,
          });
          invalidateFileHousekeepingCoverage(
            global,
            uploadDigest(['file-coverage-migration', global.storeId, page.epoch]),
            'migration',
          );
          global.migration = {
            epoch: page.epoch,
            role: 'import',
            phase: 'paging',
            header: { ...header, admission: { ...admission } },
            cursor: null,
            digest: '',
            operations: 0,
            fileActivity: { version: 1, files: 0, sha256: '' },
            pages: {},
          };
        }
        const state = global.migration;
        if (state.role !== 'import' || state.epoch !== page.epoch) reject('migration_conflict');
        const previous = state.pages[key];
        if (previous) {
          if (previous.digest !== digest) reject('migration_conflict');
          return;
        }
        if (
          state.phase !== 'paging' ||
          state.cursor !== page.cursor ||
          Object.keys(state.pages).length >= 1000
        )
          reject('migration_conflict');
        const content = page.cursor == null ? page.records.slice(1) : page.records;
        const fileRecords = content.filter(
          (record) => record.kind === 'file-retention',
        ) as FileRetentionMigrationRecord[];
        const records = content.filter((record) => record.type === 'operation');
        if (content.length !== records.length + fileRecords.length || fileRecords.length > 100)
          reject('migration_conflict');
        const proofs = new Map(fileRecords.map((record) => [record.subject.fileId, record]));
        if (proofs.size !== fileRecords.length) reject('migration_conflict');
        if (records.length > 100 || (!records.length && page.nextCursor != null))
          reject('migration_conflict');
        let last = page.cursor;
        for (const record of records) {
          if (record.type !== 'operation') reject('migration_conflict');
          const row = validateRow(record.value);
          if (!integer(record.principalTurn, state.header.turn)) reject('migration_conflict');
          if (last != null && row._id <= last) reject('migration_conflict');
          last = row._id;
          if (
            await store.Operation.exists({
              $or: [
                { _id: row._id },
                { tenantId: row.tenantId, userId: row.userId, idempotencyKey: row.idempotencyKey },
              ],
            }).session(session)
          )
            reject('migration_conflict');
          await store.Operation.create([row], { session });
          await projectUploadHousekeeping(store.mongoose, null, row, session);
          if (!policy) reject('migration_conflict');
          await validateUploadFileCleanupMigration(store.mongoose, row, session);
          const actualFile = await prepareFileRetentionMigration(
            store.mongoose,
            row,
            page.epoch,
            state.header.retentionFrozenAt,
            session,
            policy,
            false,
          );
          const expected = proofs.get(row._id);
          if (uploadDigest(actualFile) !== uploadDigest(expected ?? null))
            reject('migration_conflict');
          if (actualFile) {
            proofs.delete(row._id);
            state.fileActivity.files++;
            state.fileActivity.sha256 = uploadDigest([state.fileActivity.sha256, actualFile]);
          }
          const principalKey = JSON.stringify([row.tenantId, row.userId]);
          const existing = await store.Counter.findById(principalKey)
            .session(session)
            .lean<CounterRow>();
          if (existing && (existing.value as { turn: number }).turn !== record.principalTurn)
            reject('migration_conflict');
          await store.touchPrincipal(
            row.tenantId === null
              ? { tenantId: null, userId: row.userId, authentication: 'guest' }
              : { tenantId: row.tenantId, userId: row.userId, authentication: 'verified-email' },
            session,
            record.principalTurn,
          );
        }
        if (proofs.size) reject('migration_conflict');
        if (page.nextCursor != null && page.nextCursor !== last) reject('migration_conflict');
        state.pages[key] = { digest, nextCursor: page.nextCursor, limit: records.length };
        state.digest = uploadDigest([state.digest, digest]);
        state.operations += records.length;
        state.cursor = page.nextCursor;
        if (page.nextCursor == null) {
          await exactTotals(global, session);
          state.phase = 'complete';
        }
      }, true);
    },
    async completeExport(epoch) {
      return store.transaction(async (_session, global) => {
        const state = global.migration;
        if (
          !state ||
          state.role !== 'export' ||
          state.epoch !== epoch ||
          !['complete', 'retired'].includes(state.phase)
        )
          reject('migration_conflict');
        state.phase = 'retired';
        return seal(state);
      }, true);
    },
    async completeImport({ receipt, baseline, lifecycleReconciled }) {
      for (let pass = 0; pass <= 2001; pass++) {
        const complete = await store.transaction(async (session, global) => {
          const state = global.migration;
          validateTotals(baseline);
          if (
            lifecycleReconciled === true &&
            global.completedImport &&
            uploadDigest(global.completedImport) === uploadDigest({ receipt, baseline })
          ) {
            await store.assertCurrentSecurityState(session);
            return true;
          }
          if (
            !state ||
            state.role !== 'import' ||
            !['complete', 'validating', 'thawing'].includes(state.phase) ||
            uploadDigest(receipt) !== uploadDigest(seal(state)) ||
            keys.some((key) => baseline[key] !== state.header.baseline[key]) ||
            lifecycleReconciled !== true ||
            !state.header.reconciled ||
            !policy
          )
            reject('migration_conflict');
          if (state.phase !== 'thawing') {
            state.phase = 'validating';
            state.validation ??= { cursor: null, operations: 0, files: 0, sha256: '' };
            const check = state.validation;
            const rows = await store.Operation.find(
              check.cursor ? { _id: { $gt: check.cursor } } : {},
            )
              .sort({ _id: 1 })
              .limit(100)
              .session(session)
              .lean<StoredUpload[]>();
            for (const row of rows) {
              validateRow(row);
              await validateUploadFileCleanupMigration(store.mongoose, row, session);
              const file = await verifyFrozenFileRetentionMigration(
                store.mongoose,
                row,
                state.epoch,
                state.header.retentionFrozenAt,
                session,
                policy,
              );
              check.operations++;
              check.cursor = row._id;
              if (file) {
                check.files++;
                check.sha256 = uploadDigest([check.sha256, file]);
              }
            }
            if (rows.length === 100) return false;
            if (
              check.operations !== state.operations ||
              check.files !== receipt.fileActivity.files ||
              check.sha256 !== receipt.fileActivity.sha256
            )
              reject('migration_conflict');
            await assertFrozenFileRetentionPopulation(
              store.mongoose,
              state.epoch,
              receipt.fileActivity.files,
              session,
            );
            await exactTotals(global, session);
            await store.assertCurrentSecurityState(session);
            state.phase = 'thawing';
            return false; // No File freeze is removed before this complete verified barrier commits.
          }
          if (await thawFileRetentionMigrationPage(store.mongoose, state.epoch, session))
            return false;
          global.completedImport = { receipt, baseline: { ...baseline } };
          delete global.migration;
          delete global.migrationEpoch;
          global.enabled = true;
          global.reconciled = true;
          global.mode = 'fallback';
          global.limits = { ...FALLBACK_LIMITS };
          return true;
        }, true);
        if (complete) return;
      }
      reject('migration_conflict');
    },
  };
}
