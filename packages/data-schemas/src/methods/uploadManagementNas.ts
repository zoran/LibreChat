/** uploadManagementNas owns single-dispatch NAS originals in the existing Upload transaction. */
import { randomUUID } from 'node:crypto';
import {
  isUploadOriginalIntegrity,
  readNasS3Backend,
  readNasUploadWriteBinding,
} from 'librechat-data-provider';
import type {
  UploadPrincipal,
  NasUploadWriteBinding,
  NasOriginalHttp200,
} from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type {
  UploadNasMethods,
  NasOriginalObserver,
  NasDeletionObserver,
} from './uploadManagementNasTypes';
import type { UploadManagementContext } from './uploadManagementContext';
import type { StoredUpload } from './uploadManagementState';
import {
  nasBindingDigest,
  hasNasOriginalTerminal,
  validateNasUploadState,
} from './uploadManagementNasState';
import { loadNasFileCleanup, consumeNasFileCleanup } from './uploadNasFileCleanup';
import { uploadOriginalKey, uploadRecordBudget } from './uploadManagementState';
import { principalFilter, reject, uploadDigest } from './uploadManagementStore';
import { captureUploadSecurityApproval } from './uploadManagement.security';
import { assertUploadWriteAdmission } from './uploadManagementWrite';
import { hasUploadActorClosure } from './uploadCleanupReceipts';

const terminal = new Set(['cancelled', 'failed', 'deleted', 'expired']);
/** Validate the supplied own-data record before copying; no expected hash becomes actual evidence. */
function integritySnapshot(
  value: import('librechat-data-provider').UploadOriginalIntegrity,
  bytes: number,
) {
  if (!isUploadOriginalIntegrity(value, bytes)) reject('storage_uncertain');
  return {
    version: 1 as const,
    algorithm: 'sha256' as const,
    sha256: value.sha256,
    chunkBytes: value.chunkBytes,
    chunkSha256: Array.from(value.chunkSha256),
  };
}
/** Only a durable acknowledgement of this DELETE permits later read-only absence reconciliation. */
function recordNasAbsence(row: StoredUpload, binding: NasUploadWriteBinding): void {
  const n = row.cleanupCustody!.nas!;
  if (n.state !== 'deleted' || !n.deleteStatus) reject('storage_uncertain');
  n.receipt = {
    protocol: 'nas-acknowledged-delete-v1',
    scope: 'nas-live-key-absent',
    backend: binding.backend,
    bindingSha256: n.bindingSha256,
    requestId: n.requestId,
    originalTerminal:
      row.originalWrite!.state === 'not-dispatched' ? 'not-dispatched' : 'acknowledged',
    deleteStatus: n.deleteStatus,
    absenceStatus: 404,
  };
  n.state = 'observed';
}
/** Only trusted response metadata, never headers, arbitrary provider output or capability material. */
function responseSnapshot(value: NasOriginalHttp200): NasOriginalHttp200 {
  const v = structuredClone(value);
  if (
    !v ||
    Object.keys(v).sort().join(',') !== 'etag,observedAt,requestId,status,versionId' ||
    v.status !== 200 ||
    !Number.isSafeInteger(v.observedAt) ||
    v.observedAt < 0 ||
    [v.requestId, v.etag, v.versionId].some(
      (s) => s !== null && (typeof s !== 'string' || s.length > 1024 || /[\r\n]/.test(s)),
    )
  )
    reject('invalid_request');
  return v;
}

/** Original-only recorder joins every callback even if the adapter forgot to await it. */
function recorder<T extends object>(methods: T) {
  let pending: Promise<void> = Promise.resolve();
  let open = true;
  return {
    enqueue(run: () => Promise<void>) {
      if (!open) return Promise.reject(new Error('NAS_ORIGINAL_CLOSED'));
      pending = pending.then(run);
      return pending;
    },
    async close() {
      open = false;
      await pending;
    },
    methods,
  };
}

export function createUploadNasMethods(context: UploadManagementContext): UploadNasMethods {
  const { store, securityPolicySha256 } = context;
  async function owned(principal: UploadPrincipal, id: string, session?: ClientSession) {
    const row = await store.Operation.findOne({ _id: id, ...principalFilter(principal) })
      .session(session ?? null)
      .lean<StoredUpload>();
    if (!row) reject('not_found');
    validateNasUploadState(row);
    return row;
  }
  function binding(row: StoredUpload): NasUploadWriteBinding {
    const value = readNasUploadWriteBinding(row.writeBinding);
    if (!value) reject('not_ready');
    return value;
  }
  return {
    async dispatchNasOriginalWrite(
      lease,
      supplied,
      suppliedIntegrity,
      suppliedApproval,
      now,
      dispatch,
    ) {
      lease = structuredClone(lease);
      // Normalize the closed backend before cloning: retain no caller object/prototype or accessor.
      const backend = readNasS3Backend(supplied.backend);
      const input = { ...structuredClone(supplied), backend };
      const integrity = integritySnapshot(suppliedIntegrity, input.bytes);
      const approval = captureUploadSecurityApproval(suppliedApproval);
      if (!approval) reject('security_uninspectable');
      if (
        !backend ||
        typeof dispatch !== 'function' ||
        Object.keys(input).sort().join(',') !==
          'backend,bucket,bytes,generation,mediaType,operationId,wholeSHA256' ||
        !Number.isSafeInteger(now) ||
        now < 0 ||
        now > 8_640_000_000_000_000 - 300_000
      )
        reject('invalid_request');
      const initial = await store.transaction(async (session) => {
        const row = await store.Operation.findById(lease.operationId)
          .session(session)
          .lean<StoredUpload>();
        const key = row ? uploadOriginalKey(row) : '';
        const { backend: _backend, ...fields } = input;
        assertUploadWriteAdmission(
          row,
          lease,
          { ...fields, key },
          integrity,
          approval,
          securityPolicySha256,
          now,
        );
        if (
          !row.securityExecution ||
          context.nasAntivirusAdmission?.(
            structuredClone({
              tenantId: row.tenantId,
              userId: row.userId,
              operationId: row._id,
              generation: row.attemptGeneration!,
              bytes: input.bytes,
              sha256: input.wholeSHA256,
              mediaType: input.mediaType,
              approval,
              execution: row.securityExecution,
            }),
          ) !== true
        )
          reject('security_uninspectable');
        if (row.writeBinding) {
          validateNasUploadState(row);
          const previous = binding(row);
          if (
            Object.entries(fields).some(([k, v]) => previous[k as keyof typeof fields] !== v) ||
            uploadDigest(previous.backend) !== uploadDigest(backend)
          )
            reject('idempotency_conflict');
          return { binding: previous, admitted: false, dispatchId: row.originalWrite!.dispatchId };
        }
        const value = readNasUploadWriteBinding({
          version: 2,
          ...fields,
          backend,
          key: `${key}.${randomUUID()}`,
          originalDeadline: new Date(now + 300_000).toISOString(),
        });
        if (!value) reject('invalid_request');
        const dispatchId = randomUUID();
        row.writeBinding = value;
        row.originalWrite = {
          version: 1,
          dispatchId,
          bindingSha256: nasBindingDigest(value),
          state: 'intended',
          intendedAt: now,
        };
        // Reserve acknowledgement, verification, accepted receipt/promotion and cleanup growth
        // BEFORE any PUT. A successful remote ACK must never become unrecordable by a late cap.
        const future = {
          ...row,
          nasFuture: {
            approvedSecurity: approval,
            integrityCopies: [integrity, integrity],
            responseMetadata: ['x'.repeat(1024), 'x'.repeat(1024), 'x'.repeat(1024)],
            filepath: 'x'.repeat(4096),
            filename: '\u0800'.repeat(255),
            cleanupAndFileConsumption: 'x'.repeat(2048),
          },
        };
        if (context.mongoose.mongo.BSON.calculateObjectSize(future) > uploadRecordBudget(row))
          reject('capacity_exceeded');
        await store.save(row, session);
        return { binding: value, admitted: true, dispatchId };
      });
      if (!initial.admitted) return { state: 'already-dispatched', binding: initial.binding };
      // The capability is this original's closure, not a readable/replayable lease or receipt DTO.
      const exact = async (run: (row: StoredUpload) => void) =>
        store.transaction(async (session) => {
          const row = await owned(
            {
              tenantId: lease.tenantId,
              userId: lease.userId,
              authentication: lease.tenantId === null ? 'guest' : 'verified-email',
            } as UploadPrincipal,
            lease.operationId,
            session,
          );
          if (
            row.originalWrite?.dispatchId !== initial.dispatchId ||
            nasBindingDigest(binding(row)) !== nasBindingDigest(initial.binding)
          )
            reject('lease_lost');
          run(row);
          validateNasUploadState(row);
          await store.save(row, session);
        });
      const record = recorder({});
      const observer: NasOriginalObserver = {
        acknowledge200(response) {
          const captured = responseSnapshot(response);
          return record.enqueue(() =>
            exact((row) => {
              const original = row.originalWrite!;
              if (captured.observedAt < original.intendedAt) reject('invalid_request');
              if (original.state === 'not-dispatched') reject('idempotency_conflict');
              if (original.response && uploadDigest(original.response) !== uploadDigest(captured))
                reject('idempotency_conflict');
              if (!original.response) {
                original.response = captured;
                original.acknowledgedAt = captured.observedAt;
                original.state = 'acknowledged';
              }
            }),
          );
        },
        verified(actual) {
          const captured = integritySnapshot(actual, initial.binding.bytes);
          return record.enqueue(() =>
            exact((row) => {
              const original = row.originalWrite!;
              if (
                !original.response ||
                original.response.versionId !== null ||
                !['acknowledged', 'verified'].includes(original.state) ||
                !isUploadOriginalIntegrity(captured, initial.binding.bytes) ||
                uploadDigest(captured) !== uploadDigest(integrity)
              )
                reject('storage_uncertain');
              original.integritySha256 = uploadDigest(captured);
              original.verifiedAt ??= Date.now();
              original.state = 'verified';
            }),
          );
        },
        notDispatched() {
          return record.enqueue(() =>
            exact((row) => {
              if (row.originalWrite!.state !== 'intended') reject('storage_uncertain');
              row.originalWrite!.state = 'not-dispatched';
            }),
          );
        },
      };
      try {
        await dispatch(structuredClone(initial.binding), Object.freeze(observer));
      } finally {
        try {
          await record.close();
        } finally {
          await exact((row) => {
            if (row.originalWrite!.state === 'intended') row.originalWrite!.state = 'unknown';
          });
        }
      }
      const row = await owned(
        {
          tenantId: lease.tenantId,
          userId: lease.userId,
          authentication: lease.tenantId === null ? 'guest' : 'verified-email',
        } as UploadPrincipal,
        lease.operationId,
      );
      return {
        state: row.originalWrite?.state === 'verified' ? 'verified' : 'pending',
        binding: initial.binding,
      };
    },
    async readNasOriginalWrite(principal, operationId) {
      const row = await owned(principal, operationId);
      if (row.writeBinding?.version !== 2) return null;
      return {
        binding: binding(row),
        original: structuredClone(row.originalWrite!),
        cleanup: row.cleanupCustody?.nas ? structuredClone(row.cleanupCustody.nas) : null,
      };
    },
    async dispatchNasCleanup(principal, operationId, dispatch, claim) {
      principal = { ...principal };
      const initial = await store.transaction(async (session) => {
        const row = await owned(principal, operationId, session);
        if (
          !terminal.has(row.state) ||
          !hasNasOriginalTerminal(row) ||
          row.originalWrite?.response?.versionId != null
        )
          return null;
        const value = binding(row);
        if (row.cleanupCustody?.nas) return null;
        // All original writers must be authentically terminal before the first DELETE.
        if (!hasUploadActorClosure(row)) return null;
        if (
          (row.acceptedAt != null || row.fileId) &&
          !(await loadNasFileCleanup(context, row, session, claim))
        )
          return null;
        row.cleanupCustody ??= { version: 1 };
        const requestId = randomUUID();
        row.cleanupCustody.nas = {
          version: 1,
          requestId,
          state: 'intended',
          bindingSha256: nasBindingDigest(value),
        };
        await store.save(row, session);
        return { binding: value, requestId };
      });
      if (!initial) return null;
      const exact = async (run: (row: StoredUpload) => void) =>
        store.transaction(async (session) => {
          const row = await owned(principal, operationId, session);
          if (
            row.cleanupCustody?.nas?.requestId !== initial.requestId ||
            nasBindingDigest(binding(row)) !== nasBindingDigest(initial.binding) ||
            !hasNasOriginalTerminal(row)
          )
            reject('lease_lost');
          run(row);
          validateNasUploadState(row);
          await store.save(row, session);
        });
      const record = recorder({});
      const observer: NasDeletionObserver = {
        deleted(status) {
          if (status !== 200 && status !== 204)
            return Promise.reject(new Error('NAS_DELETE_STATUS'));
          return record.enqueue(() =>
            exact((row) => {
              const n = row.cleanupCustody!.nas!;
              if (n.state !== 'intended') reject('idempotency_conflict');
              n.deleteStatus = status;
              n.state = 'deleted';
            }),
          );
        },
        absent404() {
          return record.enqueue(() =>
            exact((row) => {
              recordNasAbsence(row, initial.binding);
            }),
          );
        },
      };
      try {
        await dispatch(structuredClone(initial.binding), Object.freeze(observer));
      } finally {
        try {
          await record.close();
        } finally {
          await exact((row) => {
            if (row.cleanupCustody!.nas!.state === 'intended')
              row.cleanupCustody!.nas!.state = 'unknown';
          });
        }
      }
      return (await owned(principal, operationId)).cleanupCustody?.nas?.receipt ?? null;
    },
    async observeNasCleanup(principal, operationId, observe) {
      const before = await owned(principal, operationId);
      const n = before.cleanupCustody?.nas;
      if (n?.state === 'observed' || n?.state === 'consumed') return structuredClone(n.receipt!);
      if (!n || n.state !== 'deleted' || !hasNasOriginalTerminal(before)) return null;
      const expected = binding(before);
      // This port performs only HEAD/GET; it cannot recreate a DELETE or original dispatch permit.
      if ((await observe(structuredClone(expected))) !== 404) return null;
      return store.transaction(async (session) => {
        const row = await owned(principal, operationId, session);
        if (
          row.cleanupCustody?.nas?.requestId !== n.requestId ||
          nasBindingDigest(binding(row)) !== nasBindingDigest(expected)
        )
          reject('lease_lost');
        if (row.cleanupCustody.nas.state === 'deleted') recordNasAbsence(row, expected);
        validateNasUploadState(row);
        await store.save(row, session);
        return row.cleanupCustody.nas.receipt ?? null;
      });
    },
    async consumeNasCleanup(principal, operationId, claim) {
      return store.transaction(async (session, global) => {
        const row = await owned(principal, operationId, session);
        const n = row.cleanupCustody?.nas;
        if (n?.state === 'consumed') return n.consumerCommitId!;
        if (!n?.receipt || n.state !== 'observed' || !terminal.has(row.state)) return null;
        n.consumerCommitId = randomUUID();
        n.state = 'consumed';
        if (!hasUploadActorClosure(row)) return null;
        if (row.acceptedAt != null || row.fileId) {
          if (!(await consumeNasFileCleanup(context, row, session, claim))) return null;
          // The File owner adjusts this same global counter in the same session. Preserve its
          // actual text/baseline changes before the enclosing Upload transaction writes value.
          const current = await store.Counter.findById('global')
            .session(session)
            .lean<import('./uploadManagementStore').CounterRow>();
          if (!current) reject('unavailable');
          Object.assign(global, current.value);
        } else if (
          !context.mongoose.models.File ||
          (await context.mongoose.models.File.exists({ file_id: row._id }).session(session))
        )
          return null;
        context.applyCleanup(
          row,
          {
            operationId,
            generation: row.workerGeneration ?? row.generation,
            writerStopped: true,
            localCopiesAbsent: true,
            originalAbsent: true,
            textAndHistoryRemoved: true,
          },
          global,
        );
        validateNasUploadState(row);
        await store.save(row, session);
        return n.consumerCommitId;
      });
    },
  };
}
