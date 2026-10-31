import { uploadOriginalSource } from './uploadManagementState';
/** Transfer/security and processing publication methods on the shared upload transaction owner. */
import {
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_MAX_TEXT_BYTES,
  isUploadOriginalIntegrity,
  isUploadStorageReceipt,
  readUploadSecurityExecution,
  readUploadSecuritySettlement,
  matchesUploadSecurityExecution,
  readUploadAcceptedMetadata,
  readManagedDocumentResult,
  readUploadDerivedOrigin,
} from 'librechat-data-provider';
import type { UploadLease, UploadClaimInput } from 'librechat-data-provider';
import type { UploadManagementRepository, UploadManagementContext } from './uploadManagementTypes';
import type { StoredUpload } from './uploadManagementStore';
import {
  principalFilter,
  project,
  leaseFor,
  assertLease,
  effectiveLimits,
  reject,
  uploadDigest,
  LEASE_MS,
  WAIT_MS,
  PROCESS_MS,
  RESOURCE_MAX,
} from './uploadManagementStore';
import {
  captureUploadSecurityApproval,
  upgradeUploadAvRecord,
  hasCurrentUploadSecurityApproval,
  requireUploadSecurityApproval,
  recordUploadSecuritySettlement,
} from './uploadManagement.security';
import { bindUploadIntakeClaim, requireUploadPromotionAcceptance } from './uploadManagementIntake';
import { touchActiveUserPrincipal } from './userPrincipal';
import { FileSourceCapacityError } from './fileRetention';
import { uploadOriginalKey } from './uploadManagementState';
import { assertNasOriginalPublication } from './uploadManagementNasState';
/** Transfer and processing lifecycle; every transition uses the injected Upload store transaction. */
export function createUploadProcessingMethods(
  context: UploadManagementContext,
): Pick<
  UploadManagementRepository,
  | 'claim'
  | 'renew'
  | 'bindSecurityExecution'
  | 'settleSecurityExecution'
  | 'accept'
  | 'publish'
  | 'retryProcessing'
  | 'getProcessingInput'
  | 'bindProcessingExecution'
> {
  const {
    mongoose,
    store,
    lifecycle,
    securityPolicySha256,
    principalOf,
    owned,
    recordOriginalPublication,
  } = context;
  async function claim(input: UploadClaimInput): Promise<UploadLease | null> {
    input = {
      ...input,
      worker: { ...input.worker },
      ...(input.principal ? { principal: { ...input.principal } } : {}),
      ...(input.intake ? { intake: { capabilitySha256: input.intake.capabilitySha256 } } : {}),
    };
    const { now, worker, kind } = input;
    if (kind !== 'transfer' && input.intake !== undefined) reject('invalid_request');
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
          kind === 'processing' &&
          !hasCurrentUploadSecurityApproval(row, securityPolicySha256, now)
        )
          continue;
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
      bindUploadIntakeClaim(row, input);
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
  return {
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
    async bindSecurityExecution(lease, value, now) {
      const execution = readUploadSecurityExecution(value);
      if (
        !execution ||
        execution.attemptId !== `${lease.operationId}.${lease.generation}` ||
        Date.parse(execution.expiresAt) <= now
      )
        reject('invalid_request');
      await store.transaction(async (session, global) => {
        const row = await store.Operation.findById(lease.operationId)
          .session(session)
          .lean<StoredUpload>();
        assertLease(row, lease, now);
        if (row.state !== 'transferring' || row.slot !== 'transfer') reject('lease_lost');
        const subject = execution.antivirus.subject;
        if (
          subject.tenantId !== row.tenantId ||
          subject.userId !== row.userId ||
          subject.operationId !== row._id ||
          subject.transferGeneration !== row.attemptGeneration ||
          subject.bytes !== row.declaredBytes ||
          subject.mediaType !== row.mediaType
        )
          reject('invalid_request');
        if (
          (row.mediaType === 'application/pdf') !== (execution.custody.kind === 'pdf-ocr') ||
          (execution.custody.kind === 'pdf-ocr' &&
            (execution.custody.scope.workDeadline * 1000 <= now ||
              execution.custody.scope.workDeadline * 1000 > now + 30_000))
        )
          reject('invalid_request');
        if (row.securityExecution) {
          if (!matchesUploadSecurityExecution(row.securityExecution, execution))
            reject('lease_lost');
          const priorCharge = row.recordBytes;
          upgradeUploadAvRecord(row, global);
          if (row.recordBytes !== priorCharge) await store.save(row, session);
          return;
        }
        upgradeUploadAvRecord(row, global);
        row.securityExecution = execution;
        await store.save(row, session);
      });
    },
    async settleSecurityExecution(lease, value, now) {
      const settlement = readUploadSecuritySettlement(value);
      if (!settlement) reject('invalid_request');
      await store.transaction(async (session) => {
        const row = await store.Operation.findById(lease.operationId)
          .session(session)
          .lean<StoredUpload>();
        assertLease(row, lease, now);
        if (row.state !== 'transferring' || row.slot !== 'transfer') reject('lease_lost');
        recordUploadSecuritySettlement(row, settlement);
        await store.save(row, session);
      });
    },
    async accept(principal, lease, receipt, securityApproval, metadata, now) {
      principalFilter(principal);
      principal = { ...principal };
      const acceptedMetadata = readUploadAcceptedMetadata(metadata);
      if (!acceptedMetadata) reject('invalid_request');
      const approval = captureUploadSecurityApproval(securityApproval);
      if (!approval) reject('security_uninspectable');
      // Capture the trusted acknowledgement before awaiting Mongo; callers retain no mutable
      // reference to the identity that this transaction may commit or replay.
      const outcome = receipt?.outcome;
      const bytes = receipt?.bytes;
      const original = isUploadStorageReceipt(receipt)
        ? {
            ...receipt,
            ...(receipt.backend ? { backend: structuredClone(receipt.backend) } : {}),
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
        assertNasOriginalPublication(row, original, now);
        await touchActiveUserPrincipal(mongoose, principal, session);
        if (
          row.derivedOrigin !== undefined &&
          original?.filepath !== `/api/files/managed/${row._id}`
        )
          reject('invalid_request');
        if (row.acceptedAt != null) {
          if (
            lease.kind !== 'transfer' ||
            lease.generation !== row.attemptGeneration ||
            lease.tenantId !== row.tenantId ||
            lease.userId !== row.userId
          )
            reject('lease_lost');
          requireUploadPromotionAcceptance(row, original, approval, acceptedMetadata);
          if (!original || !row.original || uploadDigest(original) !== uploadDigest(row.original))
            reject('idempotency_conflict');
          if (row.filename !== acceptedMetadata.filename) reject('idempotency_conflict');
          requireUploadSecurityApproval(row, securityPolicySha256, now);
          requireUploadSecurityApproval(row, securityPolicySha256, now, approval, original);
          if (uploadDigest(approval) !== uploadDigest(row.securityApproval))
            reject('idempotency_conflict');
          await lifecycle.touchManagedUploadForRetry(principal, row._id, now, session);
          return project(row, now);
        }
        assertLease(row, lease, now);
        if (row.slot !== 'transfer' || row.state !== 'transferring') reject('lease_lost');
        requireUploadPromotionAcceptance(row, original, approval, acceptedMetadata);
        if (outcome !== 'durable') reject('storage_uncertain');
        if (
          bytes !== row.declaredBytes ||
          !Number.isSafeInteger(bytes) ||
          bytes > UPLOAD_MAX_FILE_BYTES
        )
          reject('size_mismatch');
        const expectedKey = uploadOriginalKey(row);
        if (
          !original ||
          original.source !== uploadOriginalSource(row) ||
          original.storageKey !== expectedKey ||
          !isUploadOriginalIntegrity(original.integrity, original.bytes)
        )
          reject('invalid_request');
        row.securityApproval = requireUploadSecurityApproval(
          row,
          securityPolicySha256,
          now,
          approval,
          original,
        );
        await store.touchPrincipal(principal, session);
        const derivedOrigin =
          row.derivedOrigin === undefined ? undefined : readUploadDerivedOrigin(row.derivedOrigin);
        if (derivedOrigin === null) reject('not_found');
        row.acceptedAt = now;
        row.filename = acceptedMetadata.filename;
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
        try {
          const admission = await lifecycle.acceptManagedUpload(
            {
              principal,
              operationId: row._id,
              transferGeneration: row.attemptGeneration!,
              filename: row.filename,
              mediaType: row.mediaType,
              receipt: original,
              writeBinding: row.writeBinding,
              securityApproval: row.securityApproval,
              acceptedAt: now,
              ...(derivedOrigin ? { derivedOrigin } : {}),
            },
            session,
          );
          row.expiresAt = admission.expiredAt.getTime();
        } catch (error) {
          if (error instanceof FileSourceCapacityError) reject('capacity_exceeded');
          throw error;
        }
        await store.save(row, session);
        return project(row, now);
      });
    },
    async publish(lease, result, now) {
      if (!result || ![Object.prototype, null].includes(Object.getPrototypeOf(result)))
        reject('processing_failed');
      const fields = Object.getOwnPropertyDescriptors(result);
      if (
        Reflect.ownKeys(result).length !== 3 ||
        !['text', 'structure', 'writerStopped'].every(
          (key) => fields[key] && 'value' in fields[key],
        ) ||
        fields.writerStopped.value !== true
      )
        reject('processing_failed');
      const document = readManagedDocumentResult({
        text: fields.text.value,
        structure: fields.structure.value,
      });
      const actual = document
        ? Buffer.byteLength(document.text, 'utf8') +
          Buffer.byteLength(JSON.stringify(document.structure), 'utf8')
        : 0;
      if (!document || actual > UPLOAD_MAX_TEXT_BYTES) reject('processing_failed');
      const digest = uploadDigest(JSON.stringify(document));
      return store.transaction(async (session, global) => {
        const eligibilityNow = Math.max(now, Date.now());
        const row = await store.Operation.findById(lease.operationId)
          .session(session)
          .lean<StoredUpload>();
        if (!row || row.tenantId !== lease.tenantId || row.userId !== lease.userId)
          reject('lease_lost');
        await touchActiveUserPrincipal(mongoose, principalOf(row), session);
        if (
          row &&
          (document.structure.source.sha256 !== row.original?.integrity?.sha256 ||
            document.structure.source.bytes !== row.actualBytes ||
            document.structure.source.mediaType !== row.mediaType)
        )
          reject('processing_failed');
        if (
          row?.state === 'ready' &&
          row.generation === lease.generation &&
          row.tenantId === lease.tenantId &&
          row.userId === lease.userId &&
          row.worker?.hostId === lease.hostId &&
          row.worker?.instanceId === lease.instanceId &&
          row.publishedDigest === digest
        ) {
          requireUploadSecurityApproval(row, securityPolicySha256, eligibilityNow);
          await lifecycle.assertManagedUploadProcessing(
            principalOf(row),
            row._id,
            lease.generation,
            eligibilityNow,
            session,
          );
          return project(row, now);
        }
        assertLease(row, lease, eligibilityNow);
        if (
          row.state !== 'processing' ||
          row.slot !== 'processing' ||
          row.expiresAt! <= eligibilityNow ||
          !row.parserExecution
        )
          reject('lease_lost');
        requireUploadSecurityApproval(row, securityPolicySha256, eligibilityNow);
        const publication = await lifecycle.publishManagedUpload(
          principalOf(row),
          row._id,
          row.generation,
          document,
          now,
          session,
        );
        row.expiresAt = publication.expiredAtMs;
        global.textBytes -= row.textBytes - actual;
        row.textBytes = actual;
        row.state = 'ready';
        row.cleanupPending = row.stagingHeld;
        row.publishedDigest = digest;
        // The owning call captures now once; transaction retries reuse it. Ready replay above
        // leaves legacy missing timestamps unknown and never assigns a later observation time.
        if (row.firstPublishedAtMs === undefined) row.firstPublishedAtMs = now;
        if (
          recordOriginalPublication &&
          row.derivedOrigin === undefined &&
          row.scope.kind === 'personal' &&
          row.tenantId !== null
        ) {
          await recordOriginalPublication(
            { tenantId: row.tenantId, operationId: row._id, publishedAtMs: row.firstPublishedAtMs },
            session,
          );
        }
        row.writerStopped = true;
        delete row.slot;
        delete row.leaseExpiresAt;
        delete row.error;
        store.releaseQueue(row, global);
        await store.save(row, session);
        return project(row, now);
      });
    },
    async retryProcessing(principal, id, now) {
      return store.transaction(async (session, global) => {
        const row = await owned(principal, id, session);
        if (row.acceptedAt != null) requireUploadSecurityApproval(row, securityPolicySha256, now);
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
    async getProcessingInput(lease, now) {
      return store.transaction(async (session) => {
        const row = await store.Operation.findById(lease.operationId)
          .session(session)
          .lean<StoredUpload>();
        assertLease(row, lease, now);
        if (
          row.slot !== 'processing' ||
          !readUploadAcceptedMetadata({ filename: row.filename }) ||
          !isUploadStorageReceipt(row.original) ||
          row.original.outcome !== 'durable' ||
          row.original.bytes !== row.actualBytes ||
          !isUploadOriginalIntegrity(row.original.integrity, row.actualBytes!) ||
          row.expiresAt! <= now
        )
          reject('not_ready');
        const securityApproval = requireUploadSecurityApproval(row, securityPolicySha256, now);
        await lifecycle.assertManagedUploadProcessing(
          principalOf(row),
          row._id,
          lease.generation,
          now,
          session,
        );
        return {
          operationId: row._id,
          attemptGeneration: row.attemptGeneration!,
          filename: row.filename!,
          mediaType: row.mediaType,
          bytes: row.actualBytes!,
          original: row.original,
          securityApproval,
        };
      });
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
        requireUploadSecurityApproval(row, securityPolicySha256, now);
        await lifecycle.assertManagedUploadProcessing(
          principalOf(row),
          row._id,
          lease.generation,
          now,
          session,
        );
        if (row.parserExecution) return;
        row.parserExecution = { ...execution };
        await store.save(row, session);
      });
    },
  };
}
