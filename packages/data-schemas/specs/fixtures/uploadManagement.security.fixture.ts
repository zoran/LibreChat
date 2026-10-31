/** uploadManagement.security.fixture owns current synthetic scan tuples and explicit native write admission for owner tests. */
import {
  readUploadSecurityApproval,
  readUploadSecurityExecution,
  readUploadOriginalWriteBinding,
} from 'librechat-data-provider';
import type {
  CurrentUploadSecurityApproval,
  CurrentUploadSecurityExecution,
  UploadAntivirusReceipt,
  UploadLease,
  UploadSecuritySettlement,
  UploadSecurityApproval,
  UploadSecurityExecution,
  UploadStorageReceipt,
  UploadOriginalWriteBinding,
  ManagedUploadWriteBinding,
} from 'librechat-data-provider';
import type { UploadManagementRepository } from '../../src/methods/uploadManagementTypes';
import { antivirusFixture } from '../../../data-provider/src/__fixtures__/upload-antivirus';

/** Preserve the caller's actual subject, coverage, scanner and clock; no scan or native AV proof is performed. */
type ApprovalInput = Omit<CurrentUploadSecurityApproval, 'version' | 'antivirus'>;
type ExecutionInput = Partial<Omit<CurrentUploadSecurityExecution, 'version' | 'antivirus'>>;
export interface UploadSecurityFixture {
  execution: CurrentUploadSecurityExecution;
  approval: CurrentUploadSecurityApproval;
  settlement: UploadSecuritySettlement;
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** One external-engine fixture produces matching current execution, approval and original-retirement custody. */
export function uploadSecurityFixture(
  input: ApprovalInput,
  selected: ExecutionInput = {},
): UploadSecurityFixture {
  const now = Date.parse(input.checkedAt);
  const expiresAt = selected.expiresAt ?? new Date(now + 60_000).toISOString();
  const antivirus = antivirusFixture(input.subject, now, expiresAt);
  const execution = readUploadSecurityExecution({
    attemptId: `${input.subject.operationId}.${input.subject.transferGeneration}`,
    instanceId: '11111111-1111-4111-8111-111111111111',
    executionId: '22222222-2222-4222-8222-222222222222',
    custody: { kind: 'none' },
    ...copy(selected),
    version: 3,
    expiresAt,
    antivirus: copy(antivirus.custody),
  });
  const approval = readUploadSecurityApproval({
    ...copy(input),
    version: 2,
    antivirus: copy(antivirus.approval),
  });
  if (!execution || !approval || approval.version !== 2) {
    throw new Error('Current upload fixture requires a valid execution and matching approval');
  }
  return {
    execution: copy(execution),
    approval: copy(approval),
    settlement: {
      execution: copy(execution),
      writerStopped: true,
      transientDataRemoved: true,
      antivirusReceipt: copy(antivirus.receipt),
    },
  };
}

/** Explicit inert retirement port for a selected current original; callers retain incomplete and unknown variants. */
export function uploadSecuritySettlementFixture(
  execution: UploadSecurityExecution,
  flags: {
    writerStopped?: boolean;
    transientDataRemoved?: boolean;
    antivirusReceipt?: UploadAntivirusReceipt;
  } = {},
): UploadSecuritySettlement {
  if (execution.version !== 3) {
    return {
      execution: copy(execution),
      writerStopped: true,
      transientDataRemoved: true,
      ...copy(flags),
    };
  }
  return {
    execution: copy(execution),
    writerStopped: true,
    transientDataRemoved: true,
    antivirusReceipt: {
      custody: copy(execution.antivirus),
      state: 'retired',
      originalProcessJoined: true,
      ownedTransientDataRemoved: true,
    },
    ...copy(flags),
  };
}

/** Bind only the supplied original through the real repository fences before the fixture publishes any bytes. */
export async function bindUploadOriginalFixture(
  repository: Pick<UploadManagementRepository, 'bindOriginalWrite'>,
  lease: UploadLease,
  receipt: UploadStorageReceipt,
  approval: UploadSecurityApproval,
  now: number,
): Promise<UploadOriginalWriteBinding> {
  if (!receipt.integrity || approval.version !== 2)
    throw new Error('Original fixture requires current approval and its actual integrity');
  return repository.bindOriginalWrite(
    lease,
    {
      bucket: 'isolated',
      key: receipt.storageKey,
      operationId: lease.operationId,
      generation: String(lease.generation),
      bytes: receipt.bytes,
      wholeSHA256: receipt.integrity.sha256,
      mediaType: approval.subject.mediaType,
    },
    receipt.integrity,
    approval,
    now,
  );
}

/** Isolated File-consumer wire specimen only; this does not attest a native storage dispatch. */
export function originalWriteBindingFixture(
  receipt: UploadStorageReceipt,
  approval: UploadSecurityApproval,
  now: number,
): ManagedUploadWriteBinding {
  const supplied = {
    version: 1,
    bucket: 'isolated',
    key: receipt.storageKey,
    operationId: approval.subject.operationId,
    generation: String(approval.subject.transferGeneration),
    bytes: receipt.bytes,
    wholeSHA256: receipt.integrity?.sha256,
    mediaType: approval.subject.mediaType,
    originalDeadline: new Date(now + 300_000).toISOString(),
  };
  const binding = readUploadOriginalWriteBinding(supplied);
  if (!binding || binding.version !== 1)
    throw new Error('Invalid isolated File write-binding specimen');
  return copy(binding);
}
