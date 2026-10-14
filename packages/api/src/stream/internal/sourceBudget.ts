/** Source-bound replay policy. File retention owns the only shared byte ledger. */
import { createHash } from 'node:crypto';
import type { FileOwnerScope, FileSourceCopyReservation } from '@librechat/data-schemas';

const MIB = 1024 * 1024;
export const SOURCE_REPLAY_LIMITS: Readonly<{
  epochs: number;
  reservedBytes: number;
  jobBytes: number;
  metadataBytes: number;
  chunkBytes: number;
  chunkEntries: number;
  runStepBytes: number;
  eventBytes: number;
  intentBytes: number;
  bootstrapEntries: number;
  bootstrapBytes: number;
}> = Object.freeze({
  epochs: 32,
  reservedBytes: 28 * MIB,
  jobBytes: 16 * MIB,
  metadataBytes: 512 * 1024,
  chunkBytes: 8 * MIB,
  chunkEntries: 32_768,
  runStepBytes: 4 * MIB,
  eventBytes: MIB,
  intentBytes: 16 * 1024,
  bootstrapEntries: 64,
  bootstrapBytes: MIB,
});

export type SourceReplayReason =
  | 'document_capacity_exceeded'
  | 'document_source_unavailable'
  | 'document_replay_unsupported';

/** Public errors contain a finite reason, never a File, owner or stream identifier. */
export class SourceReplayError extends Error {
  readonly status: number;
  constructor(readonly code: SourceReplayReason) {
    super(
      code === 'document_capacity_exceeded'
        ? 'Document chat capacity is full. Please retry after current work finishes.'
        : 'Document chat is temporarily unavailable. Please retry.',
    );
    this.status = code === 'document_capacity_exceeded' ? 429 : 503;
  }
}

/** Exact generation identity comes from the stored job, never from an HTTP owner field. */
export interface SourceReplayIdentity {
  streamId: string;
  userId: string;
  tenantId?: string;
  createdAt: number;
}

/** This is cleanup delivery evidence; it is not a second quota ledger. */
export interface SourceReplayIntent extends SourceReplayIdentity {
  sourceFileIds: readonly string[];
  sourceExpiresAt: number;
  receipt: FileSourceCopyReservation;
}

export interface SourceReplayQuota {
  reserveFileSourceCopies(
    owner: FileOwnerScope,
    input: {
      reservationId: string;
      sourceFileIds: readonly string[];
      bytes: number;
    },
  ): Promise<FileSourceCopyReservation>;
  releaseFileSourceCopies(owner: FileOwnerScope, receipt: FileSourceCopyReservation): Promise<void>;
}

export interface SourceReplaySettlement {
  createdAt: number;
  status: string;
  providerDrained?: boolean;
  terminalPersistencePending?: boolean;
  terminalHostActionPending?: boolean;
  sourceRetentionPurged?: boolean;
}

export function createSourceReplayIntent(
  identity: SourceReplayIdentity,
  sourceFileIds: readonly string[],
  sourceExpiresAt: number,
): SourceReplayIntent {
  // eslint-disable-next-line no-control-regex -- Source identities must reject every ASCII control character.
  const controlCharacters = /[\u0000-\u001f]/;
  const validId = (id: unknown): id is string =>
    typeof id === 'string' &&
    id.length > 0 &&
    Buffer.byteLength(id) <= 128 &&
    !controlCharacters.test(id);
  if (
    !validId(identity.streamId) ||
    !validId(identity.userId) ||
    (identity.tenantId != null && !validId(identity.tenantId)) ||
    !Number.isSafeInteger(identity.createdAt) ||
    identity.createdAt < 0 ||
    !Number.isSafeInteger(sourceExpiresAt) ||
    sourceExpiresAt <= identity.createdAt ||
    sourceFileIds.length < 1 ||
    sourceFileIds.length > 64 ||
    !sourceFileIds.every(validId)
  ) {
    throw new SourceReplayError('document_source_unavailable');
  }
  const ids = [...new Set(sourceFileIds)].sort();
  const reservationId = createHash('sha256')
    .update(
      JSON.stringify([
        identity.tenantId ?? '',
        identity.userId,
        identity.streamId,
        identity.createdAt,
      ]),
    )
    .digest('hex');
  const intent: SourceReplayIntent = {
    streamId: identity.streamId,
    userId: identity.userId,
    ...(identity.tenantId != null ? { tenantId: identity.tenantId } : {}),
    createdAt: identity.createdAt,
    sourceFileIds: ids,
    sourceExpiresAt,
    receipt: {
      fileId: ids[0],
      reservationId,
      bytes: SOURCE_REPLAY_LIMITS.reservedBytes,
      state: 'held',
    },
  };
  if (Buffer.byteLength(JSON.stringify(intent)) > SOURCE_REPLAY_LIMITS.intentBytes)
    throw new SourceReplayError('document_capacity_exceeded');
  return intent;
}

export function sourceHashBytes(key: string, fields: Readonly<Record<string, string>>): number {
  return Object.entries(fields).reduce(
    (total, [field, value]) => total + Buffer.byteLength(field) + Buffer.byteLength(value),
    Buffer.byteLength(key),
  );
}

export function sourceChunkBytes(serializedEvent: string): number {
  // The key is charged once at preparation. Each stream ID is at most two
  // unsigned64-bit decimal integers and a hyphen; each row has field "event".
  return Buffer.byteLength(serializedEvent) + 41 + 5;
}

export function assertSourceJobSize(key: string, fields: Readonly<Record<string, string>>): void {
  if (
    sourceHashBytes(key, fields) >
    SOURCE_REPLAY_LIMITS.jobBytes - SOURCE_REPLAY_LIMITS.metadataBytes
  )
    throw new SourceReplayError('document_capacity_exceeded');
}

/** Same wire accounting for the process-local store, without sharing its mutable job map. */
export function assertSourceObjectSize<
  T extends {
    streamId: string;
    sourceReplayIntent?: SourceReplayIntent;
  },
>(job: T): void {
  if (!job.sourceReplayIntent) return;
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(job)) {
    if (value === undefined) continue;
    if (typeof value === 'object') fields[key] = JSON.stringify(value);
    else if (typeof value === 'boolean') fields[key] = value ? '1' : '0';
    else fields[key] = String(value);
  }
  assertSourceJobSize(`stream:{${job.streamId}}:job`, fields);
}

export function canReleaseSourceReplay(
  intent: SourceReplayIntent,
  job: SourceReplaySettlement | null,
): boolean {
  return (
    job != null &&
    job.createdAt === intent.createdAt &&
    ['complete', 'error', 'aborted'].includes(job.status) &&
    job.providerDrained === true &&
    !job.terminalPersistencePending &&
    !job.terminalHostActionPending &&
    job.sourceRetentionPurged === true
  );
}
