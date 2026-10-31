import type { ManagedUploadWriteInput, UploadWriteMethods } from './uploadManagementWriteTypes';
/** Private immutable dispatch binding, persisted in the existing fenced transfer attempt. */
import {
  isUploadOriginalIntegrity,
  readUploadOriginalWriteBinding,
  matchesUploadSecurityApproval,
  readUploadSecurityExecution,
} from 'librechat-data-provider';

import type { UploadManagementContext } from './uploadManagementContext';
import { assertLease, principalFilter, reject } from './uploadManagementStore';
import { uploadOriginalKey } from './uploadManagementState';
import type { StoredUpload } from './uploadManagementStore';
import { hasCompleteUploadSecurityExecution } from './uploadManagement.security';
const FIELDS = [
  'bucket',
  'key',
  'operationId',
  'generation',
  'bytes',
  'wholeSHA256',
  'mediaType',
] as const;
function snapshot(value: ManagedUploadWriteInput): ManagedUploadWriteInput {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join(',') !== [...FIELDS].sort().join(',') ||
    !/^[a-z0-9][a-z0-9.-]{0,253}[a-z0-9]$/.test(value.bucket) ||
    typeof value.key !== 'string' ||
    Buffer.byteLength(value.key) > 4096 ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.operationId) ||
    !/^[1-9][0-9]{0,14}$/.test(value.generation) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > 30 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(value.wholeSHA256) ||
    typeof value.mediaType !== 'string' ||
    !value.mediaType
  )
    reject('invalid_request');
  return structuredClone(value);
}
/** Shared actual transfer/security gate for legacy and NAS dispatch admission. */
export function assertUploadWriteAdmission(
  row: StoredUpload | null,
  lease: import('librechat-data-provider').UploadLease,
  input: ManagedUploadWriteInput,
  integrity: import('librechat-data-provider').UploadOriginalIntegrity,
  approval: import('librechat-data-provider').UploadSecurityApproval,
  securityPolicySha256: string | undefined,
  now: number,
): asserts row is StoredUpload {
  assertLease(row, lease, now);
  if (
    lease.kind !== 'transfer' ||
    row.state !== 'transferring' ||
    row.attemptGeneration !== lease.generation ||
    input.operationId !== row._id ||
    input.generation !== String(row.attemptGeneration) ||
    input.key !== uploadOriginalKey(row) ||
    input.bytes !== row.declaredBytes ||
    input.mediaType !== row.mediaType ||
    !isUploadOriginalIntegrity(integrity, input.bytes) ||
    integrity.sha256 !== input.wholeSHA256
  )
    reject('lease_lost');
  const execution = readUploadSecurityExecution(row.securityExecution);
  if (
    !securityPolicySha256 ||
    !execution ||
    approval.version !== 2 ||
    JSON.stringify(approval.antivirus.custody) !== JSON.stringify(execution.antivirus) ||
    !hasCompleteUploadSecurityExecution(row) ||
    (execution?.custody.kind === 'pdf-ocr' &&
      execution.custody.scope.documentSha256 !== input.wholeSHA256) ||
    !matchesUploadSecurityApproval(
      approval,
      {
        tenantId: row.tenantId,
        userId: row.userId,
        operationId: row._id,
        transferGeneration: row.attemptGeneration!,
        mediaType: input.mediaType,
        bytes: input.bytes,
        sha256: input.wholeSHA256,
      },
      securityPolicySha256,
      now,
    )
  )
    reject('security_uninspectable');
}

export function createUploadWriteMethods(context: UploadManagementContext): UploadWriteMethods {
  const { store, securityPolicySha256 } = context;
  return {
    async bindOriginalWrite(lease, supplied, integrity, approval, now) {
      const input = snapshot(supplied);
      if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 - 300_000)
        reject('invalid_request');
      return store.transaction(async (session) => {
        const row = await store.Operation.findById(lease.operationId)
          .session(session)
          .lean<StoredUpload>();
        assertUploadWriteAdmission(
          row,
          lease,
          input,
          integrity,
          approval,
          securityPolicySha256,
          now,
        );
        if (row.writeBinding) {
          if (
            row.writeBinding.version !== 1 ||
            FIELDS.some((field) => row.writeBinding![field] !== input[field]) ||
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
              row.writeBinding.originalDeadline,
            ) ||
            !Number.isFinite(Date.parse(row.writeBinding.originalDeadline)) ||
            new Date(row.writeBinding.originalDeadline).toISOString() !==
              row.writeBinding.originalDeadline
          )
            reject('lease_lost');
          return structuredClone(row.writeBinding);
        }
        row.writeBinding = {
          version: 1,
          ...input,
          originalDeadline: new Date(now + 300_000).toISOString(),
        };
        await store.save(row, session);
        return structuredClone(row.writeBinding);
      });
    },
    async readOriginalWrite(principal, operationId) {
      const row = await store.Operation.findOne({
        _id: operationId,
        ...principalFilter(principal),
      }).lean<StoredUpload>();
      if (!row) reject('not_found');
      // Observation never extends deadline, mutates the attempt or grants another dispatch.
      const binding = row.writeBinding ? readUploadOriginalWriteBinding(row.writeBinding) : null;
      if (row.writeBinding && !binding) reject('migration_conflict');
      return binding;
    },
  };
}
