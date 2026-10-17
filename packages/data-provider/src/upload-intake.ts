/** Private intake data: readers prove shape and binding, never issuer authority or writer exit. */
import type {
  UploadAcceptedMetadata,
  UploadLease,
  UploadOriginalIntegrity,
  UploadPrincipal,
  UploadStorageReceipt,
  UploadWorker,
} from './upload-management';
import type { UploadSecurityApproval } from './upload-security';
import {
  UPLOAD_INTEGRITY_CHUNK_BYTES,
  UPLOAD_MAX_FILE_BYTES,
  isUploadOriginalIntegrity,
  isUploadPrincipal,
  isUploadStorageReceipt,
  readUploadAcceptedMetadata,
} from './upload-management';
import { isUploadSecurityApproval } from './upload-security';

export type UploadIntakeGrant = {
  version: 1;
  principal: Extract<UploadPrincipal, { authentication: 'verified-email' }>;
  sessionId: string;
  authVersion: number;
  policyVersion: number;
  expiresAt: string;
};

/** Browser capability only; never includes the native session grant or application credentials. */
export type UploadIntakeTicket = {
  version: 1;
  operationId: string;
  capability: string;
  expiresAt: string;
};

export type UploadPromotionInput = {
  version: 1;
  promotionId: string;
  lease: UploadLease;
  /** Actual application storage writer, distinct from the intake lease owner. */
  worker: UploadWorker;
  approval: UploadSecurityApproval;
  integrity: UploadOriginalIntegrity;
  metadata: UploadAcceptedMetadata;
};

export type UploadPromotionRecord = UploadPromotionInput & {
  state: 'prepared' | 'writing' | 'settled';
  writerStopped: boolean;
  receipt?: UploadStorageReceipt;
};

export type UploadPromotionSettlement = {
  operationId: string;
  transferGeneration: number;
  promotionId: string;
  worker: UploadWorker;
  writerStopped: boolean;
  receipt?: UploadStorageReceipt;
};

const INPUT_KEYS = [
  'version',
  'promotionId',
  'lease',
  'worker',
  'approval',
  'integrity',
  'metadata',
];
const RECORD_KEYS = [...INPUT_KEYS, 'state', 'writerStopped'];
const SETTLEMENT_KEYS = [
  'operationId',
  'transferGeneration',
  'promotionId',
  'worker',
  'writerStopped',
];

/** Bounded descriptor-only copy protects existing validators without replacing their semantics. */
function snapshot(value: unknown): unknown {
  let remaining = 2048;
  function copy(input: unknown, depth: number): unknown {
    if (--remaining < 0 || depth > 8) throw new Error();
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (typeof input === 'string' && input.length <= 4096) return input;
    if (!input || typeof input !== 'object') throw new Error();
    const keys = Reflect.ownKeys(input);
    if (Array.isArray(input)) {
      const length = Object.getOwnPropertyDescriptor(input, 'length')?.value;
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > Math.ceil(UPLOAD_MAX_FILE_BYTES / UPLOAD_INTEGRITY_CHUNK_BYTES) ||
        keys.length !== length + 1
      )
        throw new Error();
      const result: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value'))
          throw new Error();
        result.push(copy(descriptor.value, depth + 1));
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(input);
    if ((prototype !== Object.prototype && prototype !== null) || keys.length > 32)
      throw new Error();
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string') throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value'))
        throw new Error();
      result[key] = copy(descriptor.value, depth + 1);
    }
    return result;
  }
  try {
    return copy(value, 0);
  } catch {
    return null;
  }
}

/** Input is already detached; optional own undefined fields are rejected by snapshot. */
function closed(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
    ? record
    : null;
}

function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    !/[^a-zA-Z0-9_.-]/.test(value)
  );
}
function objectId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 24 && !/[^a-f0-9]/.test(value);
}
function uuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === 36 &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
  );
}
function integer(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}
function iso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function worker(value: unknown): UploadWorker | null {
  const data = closed(value, ['hostId', 'instanceId']);
  return data && identifier(data.hostId) && identifier(data.instanceId)
    ? { hostId: data.hostId, instanceId: data.instanceId }
    : null;
}
function transferLease(value: unknown): UploadLease | null {
  const data = closed(value, [
    'tenantId',
    'userId',
    'operationId',
    'generation',
    'kind',
    'hostId',
    'instanceId',
    'expiresAt',
  ]);
  if (
    !data ||
    (data.tenantId !== null && (!identifier(data.tenantId) || data.tenantId === '__SYSTEM__')) ||
    !identifier(data.userId) ||
    !identifier(data.operationId) ||
    !integer(data.generation, 1) ||
    data.kind !== 'transfer' ||
    !iso(data.expiresAt)
  )
    return null;
  const owner = worker({ hostId: data.hostId, instanceId: data.instanceId });
  return owner
    ? {
        ...owner,
        tenantId: data.tenantId,
        userId: data.userId,
        operationId: data.operationId,
        generation: data.generation,
        kind: 'transfer',
        expiresAt: data.expiresAt,
      }
    : null;
}

/** Native owner separately enforces current session, policy and the original access deadline. */
export function readUploadIntakeGrant(value: unknown): UploadIntakeGrant | null {
  const data = closed(snapshot(value), [
    'version',
    'principal',
    'sessionId',
    'authVersion',
    'policyVersion',
    'expiresAt',
  ]);
  if (
    !data ||
    data.version !== 1 ||
    !objectId(data.sessionId) ||
    !integer(data.authVersion, 0) ||
    !integer(data.policyVersion, 1) ||
    !iso(data.expiresAt)
  )
    return null;
  const principal = closed(data.principal, ['authentication', 'tenantId', 'userId']);
  if (
    !isUploadPrincipal(principal) ||
    principal.authentication !== 'verified-email' ||
    !objectId(principal.userId)
  )
    return null;
  return {
    version: 1,
    principal: { ...principal },
    sessionId: data.sessionId,
    authVersion: data.authVersion,
    policyVersion: data.policyVersion,
    expiresAt: data.expiresAt,
  };
}

export function readUploadIntakeTicket(value: unknown): UploadIntakeTicket | null {
  const data = closed(snapshot(value), ['version', 'operationId', 'capability', 'expiresAt']);
  if (
    !data ||
    data.version !== 1 ||
    !identifier(data.operationId) ||
    !iso(data.expiresAt) ||
    typeof data.capability !== 'string' ||
    data.capability.length !== 43 ||
    !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(data.capability)
  )
    return null;
  return {
    version: 1,
    operationId: data.operationId,
    capability: data.capability,
    expiresAt: data.expiresAt,
  };
}

function promotion(data: Record<string, unknown>): UploadPromotionInput | null {
  if (data.version !== 1 || !uuid(data.promotionId)) return null;
  const lease = transferLease(data.lease);
  const owner = worker(data.worker);
  const metadata = readUploadAcceptedMetadata(data.metadata);
  const approval = data.approval;
  if (!lease || !owner || !metadata || !isUploadSecurityApproval(approval)) return null;
  const subject = approval.subject;
  if (
    lease.tenantId !== subject.tenantId ||
    lease.userId !== subject.userId ||
    lease.operationId !== subject.operationId ||
    lease.generation !== subject.transferGeneration ||
    !isUploadOriginalIntegrity(data.integrity, subject.bytes) ||
    data.integrity.sha256 !== subject.sha256
  )
    return null;
  return {
    version: 1,
    promotionId: data.promotionId,
    lease,
    worker: owner,
    approval,
    integrity: data.integrity,
    metadata,
  };
}

export function readUploadPromotionInput(value: unknown): UploadPromotionInput | null {
  const data = closed(snapshot(value), INPUT_KEYS);
  return data ? promotion(data) : null;
}

export function readUploadPromotionRecord(value: unknown): UploadPromotionRecord | null {
  const data = closed(snapshot(value), RECORD_KEYS, ['receipt']);
  if (!data || typeof data.writerStopped !== 'boolean') return null;
  const input = promotion(data);
  if (!input || (data.receipt !== undefined && !isUploadStorageReceipt(data.receipt))) return null;
  const receipt = data.receipt;
  if (
    receipt &&
    (receipt.bytes !== input.approval.subject.bytes ||
      (receipt.integrity &&
        (receipt.integrity.sha256 !== input.integrity.sha256 ||
          receipt.integrity.chunkSha256.some(
            (hash, index) => hash !== input.integrity.chunkSha256[index],
          ))))
  )
    return null;
  if (data.state === 'prepared') {
    if (!data.writerStopped || receipt) return null;
  } else if (data.state === 'writing') {
    if (data.writerStopped) return null;
  } else if (data.state === 'settled') {
    if (!data.writerStopped || receipt?.outcome === 'unknown') return null;
  } else return null;
  return {
    ...input,
    state: data.state,
    writerStopped: data.writerStopped,
    ...(receipt === undefined ? {} : { receipt }),
  };
}

export function readUploadPromotionSettlement(value: unknown): UploadPromotionSettlement | null {
  const data = closed(snapshot(value), SETTLEMENT_KEYS, ['receipt']);
  if (
    !data ||
    !identifier(data.operationId) ||
    !integer(data.transferGeneration, 1) ||
    !uuid(data.promotionId) ||
    typeof data.writerStopped !== 'boolean'
  )
    return null;
  const owner = worker(data.worker);
  if (
    !owner ||
    (data.receipt !== undefined && !isUploadStorageReceipt(data.receipt)) ||
    (data.writerStopped && data.receipt?.outcome === 'unknown')
  )
    return null;
  return {
    operationId: data.operationId,
    transferGeneration: data.transferGeneration,
    promotionId: data.promotionId,
    worker: owner,
    writerStopped: data.writerStopped,
    ...(data.receipt === undefined ? {} : { receipt: data.receipt }),
  };
}
