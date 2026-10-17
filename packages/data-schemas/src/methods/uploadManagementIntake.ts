/** Private Intake capability and App-promotion fences on the existing transactional upload row. */
import {
  readUploadIntakeGrant,
  readUploadIntakeRecoveryBinding,
  readUploadIntakeRecovery,
  readUploadIntakeLocalSettlement,
  readUploadPromotionInput,
  readUploadPromotionRecord,
  readUploadPromotionSettlement,
  matchesUploadSecurityApproval,
  isUploadOriginalIntegrity,
} from 'librechat-data-provider';
import type {
  UploadPrincipal,
  UploadIntakeGrant,
  UploadLease,
  UploadWorker,
  UploadClaimInput,
  UploadPromotionInput,
  UploadPromotionRecord,
  UploadPromotionSettlement,
  UploadStorageReceipt,
  UploadAcceptedMetadata,
  UploadSecurityApproval,
  UploadCleanupProof,
  UploadIntakeRecoveryBinding,
  UploadIntakeRecovery,
  UploadIntakeLocalSettlement,
} from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { StoredUpload, UploadStore, GlobalState } from './uploadManagementStore';
import {
  hasCompleteUploadSecurityExecution,
  recordUploadSecuritySettlement,
} from './uploadManagement.security';
import { principalFilter, assertLease, uploadDigest, reject } from './uploadManagementStore';

export type UploadIntakeReference = {
  grant: UploadIntakeGrant;
  worker?: UploadWorker;
  generation?: number;
};
export type UploadIntakeMethods = {
  sealIntakeRecovery(
    binding: UploadIntakeRecoveryBinding,
    now: number,
  ): Promise<UploadIntakeRecovery>;
  confirmIntakeRecovery(
    binding: UploadIntakeRecoveryBinding,
    settlement: UploadIntakeLocalSettlement,
    now: number,
  ): Promise<UploadIntakeRecovery>;
  issueIntake(
    principal: UploadPrincipal,
    id: string,
    capabilitySha256: string,
    grant: UploadIntakeGrant,
    now: number,
  ): Promise<void>;
  readIntake(id: string, capabilitySha256: string, now: number): Promise<UploadIntakeReference>;
  preparePromotion(input: UploadPromotionInput, now: number): Promise<UploadPromotionRecord>;
  beginPromotion(
    lease: UploadLease,
    promotionId: string,
    worker: UploadWorker,
    now: number,
  ): Promise<UploadPromotionRecord>;
  settlePromotion(input: UploadPromotionSettlement, now: number): Promise<UploadPromotionRecord>;
  getPromotion(
    principal: UploadPrincipal,
    id: string,
    now: number,
  ): Promise<UploadPromotionRecord | null>;
};
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sameWorker = (a: UploadWorker | undefined, b: UploadWorker | undefined): boolean =>
  !!a && !!b && a.hostId === b.hostId && a.instanceId === b.instanceId;
const same = (a: unknown, b: unknown): boolean =>
  uploadDigest(a ?? null) === uploadDigest(b ?? null);
const key = (row: StoredUpload): string =>
  `${row.tenantId === null ? '' : `t/${row.tenantId}/`}managed-uploads/${row.userId}/${row._id}.${row.attemptGeneration}__original`;

function grantOf(row: StoredUpload): UploadIntakeGrant | null {
  const grant = readUploadIntakeGrant(row.intake?.grant);
  return grant && grant.principal.tenantId === row.tenantId && grant.principal.userId === row.userId
    ? grant
    : null;
}
function currentIntake(
  row: StoredUpload,
  capabilitySha256: string,
  now: number,
): UploadIntakeGrant {
  const grant = grantOf(row);
  if (
    !hash(capabilitySha256) ||
    row.intake?.capabilitySha256 !== capabilitySha256 ||
    row.intake.closed === true ||
    !grant ||
    Date.parse(grant.expiresAt) <= now ||
    !['waiting', 'transferring'].includes(row.state)
  )
    reject('unauthorized');
  return grant;
}

/** Called within the same transaction which assigns the actual transfer generation/worker. */
export function bindUploadIntakeClaim(row: StoredUpload, input: UploadClaimInput): void {
  if (input.kind !== 'transfer') {
    if (input.intake !== undefined) reject('invalid_request');
    return;
  }
  if (!row.intake) {
    if (input.intake !== undefined) reject('unauthorized');
    return;
  }
  currentIntake(row, input.intake?.capabilitySha256 ?? '', input.now);
  if (
    row.intake.generation !== undefined ||
    row.intake.worker !== undefined ||
    row.attemptGeneration != null ||
    row.slot
  )
    reject('lease_lost');
  row.intake.generation = row.generation + 1;
  row.intake.worker = { ...input.worker };
}

export function readStoredUploadPromotion(row: StoredUpload): UploadPromotionRecord | undefined {
  if (row.promotion === undefined) return undefined;
  const record = readUploadPromotionRecord(row.promotion);
  if (
    !record ||
    record.lease.operationId !== row._id ||
    record.lease.tenantId !== row.tenantId ||
    record.lease.userId !== row.userId ||
    record.lease.generation !== row.attemptGeneration ||
    record.approval.subject.mediaType !== row.mediaType ||
    record.approval.subject.bytes !== row.declaredBytes ||
    !isUploadOriginalIntegrity(record.integrity, row.declaredBytes) ||
    (row.intake &&
      (row.intake.generation !== record.lease.generation ||
        !sameWorker(row.intake.worker, record.lease))) ||
    (record.receipt &&
      (record.receipt.source !== 's3' ||
        record.receipt.storageKey !== key(row) ||
        (record.receipt.outcome === 'durable' &&
          !same(record.receipt.integrity, record.integrity))))
  )
    reject('unavailable');
  return record;
}
export function hasStoppedUploadPromotion(row: StoredUpload): boolean {
  return readStoredUploadPromotion(row)?.writerStopped !== false;
}
export function requireUploadPromotionAcceptance(
  row: StoredUpload,
  receipt: UploadStorageReceipt | undefined,
  approval: UploadSecurityApproval,
  metadata: UploadAcceptedMetadata,
): void {
  const record = readStoredUploadPromotion(row);
  if (!record) {
    if (row.intake) reject('not_ready');
    return;
  }
  if (record.state !== 'settled' || !record.writerStopped || record.receipt?.outcome !== 'durable')
    reject('not_ready');
  if (
    !same(record.receipt, receipt) ||
    !same(record.approval, approval) ||
    !same(record.metadata, metadata)
  )
    reject('idempotency_conflict');
}

/** Preserve private settled obligations; never migrate a live or uncertain App writer. */
export function validateUploadMigrationIntake(row: StoredUpload): void {
  try {
    if (
      row.intake &&
      (!hash(row.intake.capabilitySha256) ||
        !grantOf(row) ||
        (row.intake.closed !== undefined && row.intake.closed !== true) ||
        (row.intake.cleanupAcknowledged !== undefined && row.intake.cleanupAcknowledged !== true) ||
        ((row.intake.closed || row.intake.cleanupAcknowledged) &&
          row.intake.generation === undefined) ||
        (row.intake.generation !== undefined &&
          (row.intake.generation !== row.attemptGeneration ||
            !row.intake.worker?.hostId ||
            !row.intake.worker.instanceId ||
            row.state === 'waiting')) ||
        (row.intake.generation === undefined &&
          (row.intake.worker !== undefined || row.attemptGeneration != null || row.promotion)))
    )
      reject('migration_conflict');
    if (row.intake?.cleanupAcknowledged) {
      recoveryView(row);
      if (
        (row.workerGeneration ?? row.generation) === row.intake.generation &&
        (!row.writerStopped || row.stagingHeld)
      )
        reject('migration_conflict');
    }
    const promotion = readStoredUploadPromotion(row);
    if (promotion && !promotion.writerStopped) reject('migration_conflict');
    if (promotion && !hasCompleteUploadSecurityExecution(row)) reject('migration_conflict');
    if (row.acceptedAt != null && (row.intake || promotion))
      requireUploadPromotionAcceptance(row, row.original, row.securityApproval!, {
        filename: row.filename!,
      });
  } catch {
    reject('migration_conflict');
  }
}

/** Only a permanently fenced reference can prove that no future App writer will start. */
function recoveryView(row: StoredUpload): UploadIntakeRecovery {
  const promotion = readStoredUploadPromotion(row);
  const storageOutcome =
    promotion?.state === 'writing' ? 'unknown' : (promotion?.receipt?.outcome ?? 'not_started');
  const result = readUploadIntakeRecovery({
    version: 1,
    operationId: row._id,
    transferGeneration: row.intake!.generation,
    worker: row.intake!.worker,
    closed: true,
    acknowledged: row.intake!.cleanupAcknowledged === true,
    storageOutcome,
    appWriterStopped: storageOutcome !== 'unknown',
    ...(promotion
      ? { promotion: { promotionId: promotion.promotionId, worker: promotion.worker } }
      : {}),
    ...(row.securityExecution ? { securityExecution: row.securityExecution } : {}),
    ...(row.securitySettlement ? { securitySettlement: row.securitySettlement } : {}),
  });
  if (!result) reject('unavailable');
  return result;
}

export function createUploadIntakeMethods(
  store: UploadStore,
  policySha256: string | undefined,
  applyCleanup: (row: StoredUpload, proof: UploadCleanupProof, global: GlobalState) => void,
): UploadIntakeMethods {
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
  function approved(row: StoredUpload, input: UploadPromotionInput, now: number): void {
    if (
      !hasCompleteUploadSecurityExecution(row) ||
      !policySha256 ||
      !isUploadOriginalIntegrity(input.integrity, row.declaredBytes) ||
      !matchesUploadSecurityApproval(
        input.approval,
        {
          tenantId: row.tenantId,
          userId: row.userId,
          operationId: row._id,
          transferGeneration: row.attemptGeneration!,
          mediaType: row.mediaType,
          bytes: row.declaredBytes,
          sha256: input.integrity.sha256,
        },
        policySha256,
        now,
      )
    )
      reject('security_uninspectable');
    if (
      row.intake &&
      (row.intake.generation !== row.attemptGeneration ||
        !sameWorker(row.intake.worker, input.lease))
    )
      reject('lease_lost');
  }
  async function recoveryRow(
    binding: UploadIntakeRecoveryBinding,
    session?: ClientSession,
  ): Promise<StoredUpload> {
    const row = await store.Operation.findById(binding.operationId)
      .session(session ?? null)
      .lean<StoredUpload>();
    if (
      !row?.intake ||
      row.intake.capabilitySha256 !== binding.capabilitySha256 ||
      row.intake.generation !== binding.transferGeneration ||
      row.attemptGeneration !== binding.transferGeneration ||
      !sameWorker(row.intake.worker, binding.worker) ||
      ((row.workerGeneration ?? row.generation) === binding.transferGeneration &&
        !sameWorker(row.worker, binding.worker))
    )
      reject('unauthorized');
    return row;
  }
  return {
    async sealIntakeRecovery(value, _now) {
      const binding = readUploadIntakeRecoveryBinding(value);
      if (!binding) reject('invalid_request');
      const prior = await recoveryRow(binding);
      if (prior.intake!.closed) return recoveryView(prior);
      return store.transaction(async (session) => {
        const row = await recoveryRow(binding, session);
        row.intake!.closed = true;
        const result = recoveryView(row);
        await store.save(row, session);
        return result;
      });
    },
    async confirmIntakeRecovery(value, localValue, _now) {
      const binding = readUploadIntakeRecoveryBinding(value);
      const local = readUploadIntakeLocalSettlement(localValue);
      if (!binding || !local) reject('invalid_request');
      if (
        local.operationId !== binding.operationId ||
        local.transferGeneration !== binding.transferGeneration ||
        !sameWorker(local.worker, binding.worker)
      )
        reject('unauthorized');
      function check(row: StoredUpload): UploadIntakeRecovery {
        if (!row.intake!.closed) reject('not_ready');
        if (local!.securitySettlement)
          recordUploadSecuritySettlement(row, local!.securitySettlement);
        return recoveryView(row);
      }
      // A historical acknowledgement cannot touch a subsequently claimed processing attempt.
      const prior = await recoveryRow(binding);
      const previous = check(prior);
      if (previous.acknowledged) return previous;
      return store.transaction(async (session, global) => {
        const row = await recoveryRow(binding, session);
        const result = check(row);
        if (result.acknowledged) return result;
        if (
          result.appWriterStopped &&
          (!row.securityExecution || hasCompleteUploadSecurityExecution(row))
        ) {
          applyCleanup(
            row,
            {
              operationId: binding.operationId,
              generation: binding.transferGeneration,
              writerStopped: true,
              localCopiesAbsent: local.localCopiesAbsent,
              originalAbsent: ['not_started', 'absent'].includes(result.storageOutcome),
              textAndHistoryRemoved: false,
            },
            global,
          );
        }
        await store.save(row, session);
        return recoveryView(row);
      });
    },
    async issueIntake(principal, id, capabilitySha256, value, now) {
      principal = { ...principal };
      const grant = readUploadIntakeGrant(value);
      if (
        !grant ||
        !hash(capabilitySha256) ||
        principal.authentication !== 'verified-email' ||
        grant.principal.tenantId !== principal.tenantId ||
        grant.principal.userId !== principal.userId ||
        Date.parse(grant.expiresAt) <= now ||
        Date.parse(grant.expiresAt) > now + 720_000
      )
        reject('invalid_request');
      await store.transaction(async (session) => {
        const row = await owned(principal, id, session);
        if (
          row.state !== 'waiting' ||
          row.attemptGeneration != null ||
          row.generation !== 0 ||
          row.slot ||
          row.promotion
        )
          reject('not_ready');
        row.intake = { capabilitySha256, grant };
        await store.save(row, session);
      });
    },
    async readIntake(id, capabilitySha256, now) {
      if (!hash(capabilitySha256)) reject('unauthorized');
      const row = await store.Operation.findOne({
        _id: id,
        'intake.capabilitySha256': capabilitySha256,
      }).lean<StoredUpload>();
      if (!row || row.intake?.closed) reject('unauthorized');
      const grant = grantOf(row);
      if (!grant || Date.parse(grant.expiresAt) <= now) reject('unauthorized');
      const intake = row.intake!;
      if (intake.generation === undefined) {
        if (row.state !== 'waiting' || row.attemptGeneration != null || intake.worker !== undefined)
          reject('unauthorized');
      } else if (
        !Number.isSafeInteger(intake.generation) ||
        intake.generation < 1 ||
        intake.generation !== row.attemptGeneration ||
        !intake.worker?.hostId ||
        !intake.worker.instanceId ||
        ((row.workerGeneration ?? row.generation) === intake.generation &&
          !sameWorker(row.worker, intake.worker))
      )
        reject('lease_lost');
      // This is only the original private attempt reference. The facade revalidates the live
      // native grant and each operation still fences its own state/lease or exact cleanup proof.
      return {
        grant,
        ...(intake.generation === undefined
          ? {}
          : { generation: intake.generation, worker: { ...intake.worker! } }),
      };
    },
    async preparePromotion(value, now) {
      const input = readUploadPromotionInput(value);
      if (!input) reject('invalid_request');
      return store.transaction(async (session) => {
        const row = await store.Operation.findById(input.lease.operationId)
          .session(session)
          .lean<StoredUpload>();
        assertLease(row, input.lease, now);
        if (row.state !== 'transferring' || row.slot !== 'transfer') reject('lease_lost');
        approved(row, input, now);
        if (row.intake) currentIntake(row, row.intake.capabilitySha256, now);
        const prior = readStoredUploadPromotion(row);
        if (prior) {
          const { state: _state, writerStopped: _stopped, receipt: _receipt, ...original } = prior;
          if (uploadDigest(original) !== uploadDigest(input)) reject('idempotency_conflict');
          return prior;
        }
        row.promotion = { ...input, state: 'prepared', writerStopped: true };
        await store.save(row, session);
        return readUploadPromotionRecord(row.promotion)!;
      });
    },
    async beginPromotion(lease, promotionId, worker, now) {
      const binding = readUploadPromotionSettlement({
        operationId: lease.operationId,
        transferGeneration: lease.generation,
        promotionId,
        worker,
        writerStopped: false,
      });
      if (!binding) reject('invalid_request');
      const capturedLease = { ...lease };
      return store.transaction(async (session) => {
        const row = await store.Operation.findById(binding.operationId)
          .session(session)
          .lean<StoredUpload>();
        assertLease(row, capturedLease, now);
        if (row.state !== 'transferring' || row.slot !== 'transfer') reject('lease_lost');
        const record = readStoredUploadPromotion(row);
        if (
          !record ||
          record.promotionId !== binding.promotionId ||
          !sameWorker(record.worker, binding.worker) ||
          uploadDigest(record.lease) !== uploadDigest(capturedLease)
        )
          reject('lease_lost');
        approved(row, record, now);
        if (row.intake) currentIntake(row, row.intake.capabilitySha256, now);
        if (record.state !== 'prepared') reject('not_ready');
        row.promotion = { ...record, state: 'writing', writerStopped: false };
        await store.save(row, session);
        return readUploadPromotionRecord(row.promotion)!;
      });
    },
    async settlePromotion(value, _now) {
      const input = readUploadPromotionSettlement(value);
      if (!input) reject('invalid_request');
      return store.transaction(async (session) => {
        const row = await store.Operation.findById(input.operationId)
          .session(session)
          .lean<StoredUpload>();
        if (!row) reject('not_found');
        const record = readStoredUploadPromotion(row);
        if (
          !record ||
          record.promotionId !== input.promotionId ||
          record.lease.generation !== input.transferGeneration ||
          !sameWorker(record.worker, input.worker)
        )
          reject('lease_lost');
        if (record.state === 'prepared') reject('not_ready');
        if (
          input.receipt &&
          (input.receipt.source !== 's3' ||
            input.receipt.storageKey !== key(row) ||
            input.receipt.bytes !== row.declaredBytes ||
            (input.receipt.outcome === 'durable' &&
              (!isUploadOriginalIntegrity(input.receipt.integrity, row.declaredBytes) ||
                uploadDigest(input.receipt.integrity) !== uploadDigest(record.integrity))))
        )
          reject('invalid_request');
        if (record.state === 'settled') {
          if (!input.writerStopped || !same(input.receipt, record.receipt))
            reject('idempotency_conflict');
          return record;
        }
        if (
          record.receipt &&
          record.receipt.outcome !== 'unknown' &&
          (input.receipt || input.writerStopped) &&
          !same(record.receipt, input.receipt)
        )
          reject('idempotency_conflict');
        row.promotion = {
          ...record,
          state: input.writerStopped ? 'settled' : 'writing',
          writerStopped: input.writerStopped,
          ...(input.receipt === undefined ? {} : { receipt: input.receipt }),
        };
        // A join without a receipt must not inherit a previous unknown observation.
        if (input.writerStopped && input.receipt === undefined) delete row.promotion.receipt;
        await store.save(row, session);
        return readUploadPromotionRecord(row.promotion)!;
      });
    },
    async getPromotion(principal, id, _now) {
      return readStoredUploadPromotion(await owned(principal, id)) ?? null;
    },
  };
}
