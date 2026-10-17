/** Private persistence primitives for the one Upload Management repository. */
import { performance } from 'perf_hooks';
import { setTimeout as delay } from 'timers/promises';
import { createHash, randomInt, randomUUID } from 'crypto';
import { isUploadPrincipal } from 'librechat-data-provider';
import type {
  UploadPrincipal,
  UploadScope,
  UploadState,
  UploadErrorCode,
  UploadWorker,
  UploadLease,
  UploadOperation,
  UploadStorageReceipt,
  UploadLimits,
  UploadControlMode,
  UploadParserExecution,
  UploadMigrationReceipt,
  UploadReconciliationSnapshot,
  UploadActivationProof,
  UploadSecurityApproval,
} from 'librechat-data-provider';
import type { ClientSession, Model } from 'mongoose';
import { tenantStorage, SYSTEM_TENANT_ID, runAsSystem } from '~/config/tenantContext';

export const LEASE_MS = 45_000;
export const WAIT_MS = 600_000;
export const PROCESS_MS = 3_600_000;
export const MAX_QUEUE_BYTES = 1_073_741_824;
export const HARD_LIMITS: UploadLimits = {
  transferPermits: 6,
  processingPermits: 3,
  transferBytesPerSecond: 8 * 1_048_576,
};
export const FALLBACK_LIMITS: UploadLimits = {
  transferPermits: 1,
  processingPermits: 1,
  transferBytesPerSecond: 1_048_576,
};
export const RESOURCE_MAX: {
  originalBytes: number;
  objectBytes: number;
  textBytes: number;
  recordBytes: number;
  bundles: number;
} = {
  originalBytes: 1_099_511_627_776,
  objectBytes: 1_649_267_441_664,
  textBytes: 16 * 1_073_741_824,
  recordBytes: 4 * 1_073_741_824,
  bundles: 100_000,
};
export type ResourceTotals = typeof RESOURCE_MAX;
export type StoredUploadAdmissionPolicy = {
  paused: boolean;
  revision: number;
  lastRequestSha256?: string;
};
export type SnapshotHeader = {
  sourceId: string;
  totals: ResourceTotals;
  baseline: ResourceTotals;
  reconciled: boolean;
  queueCount: number;
  queueBytes: number;
  turn: number;
  byteGrants: GlobalState['byteGrants'];
  admission?: StoredUploadAdmissionPolicy;
};
export type MigrationState = {
  epoch: string;
  role: 'export' | 'import';
  phase: 'paging' | 'complete' | 'retired';
  header: SnapshotHeader;
  cursor: string | null;
  digest: string;
  operations: number;
  pages: Record<string, { digest: string; nextCursor: string | null; limit: number }>;
};
export type StoredUpload = {
  _id: string;
  tenantId: string | null;
  userId: string;
  scope: UploadScope;
  idempotencyKey: string;
  fingerprint: string;
  filename: string;
  mediaType: string;
  declaredBytes: number;
  actualBytes?: number;
  state: UploadState;
  revision: number;
  createdAt: number;
  acceptedAt?: number;
  expiresAt?: number;
  fileId?: string;
  error?: UploadErrorCode;
  cleanupPending: boolean;
  generation: number;
  slot?: 'transfer' | 'processing';
  worker?: UploadWorker;
  leaseExpiresAt?: number;
  attemptGeneration?: number;
  original?: UploadStorageReceipt;
  /** Trusted scanner receipt, private to the original transfer rather than processing attempts. */
  securityApproval?: UploadSecurityApproval;
  originalBytes: number;
  textBytes: number;
  recordBytes: number;
  queueCharged: boolean;
  pendingBytes: number;
  stagingHeld: boolean;
  processingQueuedAt?: number;
  byteLeaseUntil?: number;
  workerGeneration?: number;
  workerKind?: UploadLease['kind'];
  writerStopped?: boolean;
  byteLeaseGeneration?: number;
  originalRemoved?: boolean;
  textRemoved?: boolean;
  parserExecution?: UploadParserExecution;
  publishedDigest?: string;
};
export type GlobalState = ResourceTotals & {
  revision: number;
  reconciled: boolean;
  enabled: boolean;
  queueCount: number;
  queueBytes: number;
  turn: number;
  controllerOwner?: string;
  controllerGeneration: number;
  controllerUntil: number;
  limits: UploadLimits;
  mode: UploadControlMode;
  policyUntil: number;
  byteGrants: { at: number; bytes: number; host: string }[];
  migrationEpoch?: string;
  storeId: string;
  admission?: StoredUploadAdmissionPolicy;
  baseline: ResourceTotals;
  migration?: MigrationState;
  cleanupCursor?: string;
  reconcileCursor?: string;
  completedImport?: { receipt: UploadMigrationReceipt; baseline: ResourceTotals };
  reconciliationFence?: { revision: number; observedAt: number };
  activationProof?: UploadActivationProof;
};
export type CounterRow = { _id: string; revision: number; value: GlobalState | { turn: number } };
export type UploadStoreOptions = {
  /** Missing/invalid policy closes dependent operations without preventing cleanup or startup. */
  securityPolicySha256?: string;
  /** Only the trusted activation/reconciliation owner may attest existing occupancy. */
  reconciled?: boolean;
  baseline?: Partial<ResourceTotals>;
  enabled?: boolean;
};

/** Joins the File owner's transaction; there is one global text pool, including retained copies. */
export async function adjustRetainedTextBytes(
  mongoose: typeof import('mongoose'),
  delta: number,
  session: ClientSession,
): Promise<void> {
  if (!session.inTransaction() || !Number.isSafeInteger(delta))
    throw new Error('Invalid retained-text transaction');
  if (delta === 0) return;
  const Counter = mongoose.models.UploadCounter as Model<CounterRow> | undefined;
  const row = await Counter?.findById('global').session(session).lean<CounterRow>();
  const global = row?.value as GlobalState | undefined;
  if (
    !Counter ||
    !global ||
    !global.reconciled ||
    global.migrationEpoch ||
    (delta > 0 && !global.enabled)
  ) {
    throw Object.assign(new Error('Document storage is not reconciled.'), {
      code: 'document_inventory_unreconciled',
    });
  }
  if (
    !Number.isSafeInteger(global.textBytes) ||
    !Number.isSafeInteger(global.baseline?.textBytes) ||
    global.textBytes + delta < 0 ||
    global.baseline.textBytes + delta < 0
  ) {
    throw Object.assign(new Error('Document storage is not reconciled.'), {
      code: 'document_inventory_unreconciled',
    });
  }
  if (global.textBytes + delta > RESOURCE_MAX.textBytes) {
    throw Object.assign(
      new Error('Document storage is full. Remove documents or wait for cleanup, then retry.'),
      { code: 'document_capacity_exceeded' },
    );
  }
  // The upload owner's own transaction writes this document too. Concurrent reservations conflict.
  await Counter.updateOne(
    { _id: 'global', revision: row!.revision },
    {
      $inc: {
        revision: 1,
        'value.revision': 1,
        'value.textBytes': delta,
        'value.baseline.textBytes': delta,
      },
    },
    { session },
  );
}
export function reject(code: UploadErrorCode): never {
  const error = Object.assign(new Error(code), { name: 'UploadManagementError', code });
  throw error;
}
/** Missing tenant data is never admitted as an explicit guest row. */
export function principalFilter(principal: UploadPrincipal): {
  tenantId: string | null;
  userId: string;
  $and?: { tenantId: { $exists: true } }[];
} {
  const tenant = tenantStorage.getStore()?.tenantId;
  if (
    !isUploadPrincipal(principal) ||
    (tenant && tenant !== SYSTEM_TENANT_ID && tenant !== principal.tenantId)
  )
    reject('unauthorized');
  return {
    tenantId: principal.tenantId,
    userId: principal.userId,
    ...(principal.tenantId === null ? { $and: [{ tenantId: { $exists: true as const } }] } : {}),
  };
}
export function storedUploadPrincipal(
  row: Pick<StoredUpload, 'tenantId' | 'userId'>,
): UploadPrincipal {
  const principal =
    row.tenantId === null
      ? { tenantId: null, userId: row.userId, authentication: 'guest' as const }
      : { tenantId: row.tenantId, userId: row.userId, authentication: 'verified-email' as const };
  if (!isUploadPrincipal(principal)) reject('unavailable');
  return principal;
}
export function project(row: StoredUpload, now: number): UploadOperation {
  return {
    version: 1,
    id: row._id,
    revision: row.revision,
    scope: row.scope,
    filename: row.filename,
    mediaType: row.mediaType,
    declaredBytes: row.declaredBytes,
    actualBytes: row.actualBytes,
    state: row.expiresAt && row.expiresAt <= now && row.state !== 'deleted' ? 'expired' : row.state,
    createdAt: new Date(row.createdAt).toISOString(),
    acceptedAt: row.acceptedAt == null ? undefined : new Date(row.acceptedAt).toISOString(),
    expiresAt: row.expiresAt == null ? undefined : new Date(row.expiresAt).toISOString(),
    fileId: row.fileId,
    error: row.error,
    cleanupPending: row.cleanupPending,
    canUseInComposer: row.state === 'ready' && row.expiresAt != null && row.expiresAt > now,
    canRetryProcessing:
      row.state === 'failed' &&
      row.acceptedAt != null &&
      row.expiresAt! > now &&
      !row.originalRemoved &&
      !row.slot &&
      !row.stagingHeld,
  };
}
export function leaseFor(row: StoredUpload): UploadLease {
  if (!row.slot || !row.worker || !row.leaseExpiresAt) reject('lease_lost');
  return {
    operationId: row._id,
    tenantId: row.tenantId,
    userId: row.userId,
    generation: row.generation,
    kind: row.slot,
    ...row.worker,
    expiresAt: new Date(row.leaseExpiresAt).toISOString(),
  };
}
export function assertLease(
  row: StoredUpload | null,
  lease: UploadLease,
  now: number,
): asserts row is StoredUpload {
  if (
    !row ||
    row._id !== lease.operationId ||
    row.generation !== lease.generation ||
    row.slot !== lease.kind ||
    row.tenantId !== lease.tenantId ||
    row.userId !== lease.userId ||
    row.worker?.hostId !== lease.hostId ||
    row.worker?.instanceId !== lease.instanceId ||
    !row.leaseExpiresAt ||
    row.leaseExpiresAt <= now
  )
    reject('lease_lost');
}
export function effectiveLimits(global: GlobalState, now: number): UploadLimits {
  if (!global.enabled || !global.reconciled)
    return { transferPermits: 0, processingPermits: 0, transferBytesPerSecond: 0 };
  if (global.mode === 'blocked')
    return { transferPermits: 0, processingPermits: 0, transferBytesPerSecond: 0 };
  if (global.controllerUntil <= now || global.policyUntil <= now)
    return {
      transferPermits: Math.min(FALLBACK_LIMITS.transferPermits, global.limits.transferPermits),
      processingPermits: Math.min(
        FALLBACK_LIMITS.processingPermits,
        global.limits.processingPermits,
      ),
      transferBytesPerSecond: Math.min(
        FALLBACK_LIMITS.transferBytesPerSecond,
        global.limits.transferBytesPerSecond,
      ),
    };
  return global.limits;
}

export type UploadStore = {
  mongoose: typeof import('mongoose');
  Operation: Model<StoredUpload>;
  Counter: Model<CounterRow>;
  initialize(): Promise<void>;
  transaction<T>(
    work: (session: ClientSession, global: GlobalState) => Promise<T>,
    migration?: boolean,
  ): Promise<T>;
  save(row: StoredUpload, session: ClientSession): Promise<void>;
  touchPrincipal(
    principal: UploadPrincipal,
    session: ClientSession,
    turn?: number,
  ): Promise<number>;
  releaseQueue(row: StoredUpload, global: GlobalState): void;
  chargeQueue(row: StoredUpload, global: GlobalState): void;
  totals(
    session: ClientSession,
  ): Promise<ResourceTotals & { queueCount: number; queueBytes: number }>;
};
export function createUploadStore(
  mongoose: typeof import('mongoose'),
  options: UploadStoreOptions,
): UploadStore {
  const S = mongoose.Schema;
  const operationSchema = new S<StoredUpload>(
    {
      _id: String,
      tenantId: {
        type: String,
        validate: (value: unknown) =>
          value === null ||
          (typeof value === 'string' &&
            /^[a-zA-Z0-9_.-]{1,128}$/.test(value) &&
            value !== SYSTEM_TENANT_ID),
      },
      userId: { type: String, required: true },
      scope: S.Types.Mixed,
      idempotencyKey: String,
      fingerprint: String,
      filename: String,
      mediaType: String,
      declaredBytes: Number,
      actualBytes: Number,
      state: String,
      revision: Number,
      createdAt: Number,
      acceptedAt: Number,
      expiresAt: Number,
      fileId: String,
      error: String,
      cleanupPending: Boolean,
      generation: Number,
      slot: String,
      worker: S.Types.Mixed,
      leaseExpiresAt: Number,
      writerStopped: Boolean,
      attemptGeneration: Number,
      original: S.Types.Mixed,
      securityApproval: S.Types.Mixed,
      originalBytes: Number,
      textBytes: Number,
      recordBytes: Number,
      queueCharged: Boolean,
      pendingBytes: Number,
      stagingHeld: Boolean,
      processingQueuedAt: Number,
      byteLeaseUntil: Number,
      byteLeaseGeneration: Number,
      workerGeneration: Number,
      workerKind: String,
      parserExecution: S.Types.Mixed,
      publishedDigest: String,
      originalRemoved: Boolean,
      textRemoved: Boolean,
    },
    { versionKey: false },
  );
  operationSchema.index({ tenantId: 1, userId: 1, idempotencyKey: 1 }, { unique: true });
  operationSchema.index({ tenantId: 1, userId: 1, acceptedAt: 1 });
  operationSchema.index({ state: 1, createdAt: 1 });
  operationSchema.index({ cleanupPending: 1, _id: 1 });
  operationSchema.index({ slot: 1, 'worker.hostId': 1, 'worker.instanceId': 1 });
  operationSchema.index({ stagingHeld: 1, 'worker.hostId': 1, 'worker.instanceId': 1, _id: 1 });
  const counterSchema = new S<CounterRow>(
    { _id: String, revision: Number, value: S.Types.Mixed },
    { versionKey: false },
  );
  const Operation = (mongoose.models.UploadOperation ??
    mongoose.model('UploadOperation', operationSchema)) as Model<StoredUpload>;
  const Counter = (mongoose.models.UploadCounter ??
    mongoose.model('UploadCounter', counterSchema)) as Model<CounterRow>;
  async function initialize(): Promise<void> {
    await Promise.all([Operation.init(), Counter.init()]);
    const baseline = {
      originalBytes: 0,
      objectBytes: 0,
      textBytes: 0,
      recordBytes: 0,
      bundles: 0,
      ...options.baseline,
    };
    for (const key of Object.keys(RESOURCE_MAX) as (keyof ResourceTotals)[]) {
      if (
        !Number.isSafeInteger(baseline[key]) ||
        baseline[key] < 0 ||
        baseline[key] > RESOURCE_MAX[key]
      )
        reject('capacity_exceeded');
    }
    if (baseline.objectBytes < baseline.originalBytes) reject('capacity_exceeded');
    const value: GlobalState = {
      ...baseline,
      revision: 0,
      reconciled: options.reconciled === true,
      enabled: options.enabled === true,
      queueCount: 0,
      queueBytes: 0,
      turn: 0,
      controllerGeneration: 0,
      controllerUntil: 0,
      policyUntil: 0,
      limits: FALLBACK_LIMITS,
      mode: 'fallback',
      byteGrants: [],
      storeId: randomUUID(),
      admission: { paused: false, revision: 0 },
      baseline,
    };
    await Counter.updateOne(
      { _id: 'global' },
      { $setOnInsert: { revision: 0, value } },
      { upsert: true },
    );
  }
  async function transaction<T>(
    work: (session: ClientSession, global: GlobalState) => Promise<T>,
    migration = false,
  ): Promise<T> {
    const session = await mongoose.startSession();
    try {
      let attempts = 0;
      let result: T | undefined;
      const deadline = performance.now() + 8000;
      await session.withTransaction(
        async () => {
          if (++attempts > 16 || performance.now() >= deadline) reject('unavailable');
          if (attempts > 1) {
            // The driver retries write conflicts immediately. Yield before acquiring a snapshot so
            // a concurrent counter holder can commit instead of exhausting retries against its lock.
            const backoff = Math.min(250, 20 * 2 ** (attempts - 2));
            await delay(Math.min(deadline - performance.now(), randomInt(backoff, backoff * 2)));
            if (performance.now() >= deadline) reject('unavailable');
          }
          const counter = await Counter.findById('global').session(session).lean<CounterRow>();
          if (!counter) reject('unavailable');
          const global = counter.value as GlobalState;
          if (global.migrationEpoch && !migration) reject('migration_conflict');
          // Every transition writes this same document, so snapshots cannot grant disjoint overbooking.
          await Counter.updateOne({ _id: 'global' }, { $inc: { revision: 1 } }, { session });
          result = await work(session, global);
          global.revision++;
          await Counter.updateOne({ _id: 'global' }, { $set: { value: global } }, { session });
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority', wtimeout: 2000 },
          maxCommitTimeMS: 2000,
          timeoutMS: 8000,
        },
      );
      return result as T;
    } finally {
      await session.endSession();
    }
  }
  async function save(row: StoredUpload, session: ClientSession): Promise<void> {
    row.revision++;
    await Operation.replaceOne({ _id: row._id }, row, { session });
  }
  async function touchPrincipal(
    principal: UploadPrincipal,
    session: ClientSession,
    turn?: number,
  ): Promise<number> {
    const { tenantId, userId } = principalFilter(principal);
    const id = JSON.stringify([tenantId, userId]);
    const update =
      turn == null
        ? { $inc: { revision: 1 }, $setOnInsert: { value: { turn: 0 } } }
        : { $inc: { revision: 1 }, $set: { value: { turn } } };
    const row = await Counter.findOneAndUpdate({ _id: id }, update, {
      upsert: true,
      new: true,
      session,
    }).lean<CounterRow>();
    return (row?.value as { turn: number })?.turn ?? 0;
  }
  function releaseQueue(row: StoredUpload, global: GlobalState): void {
    if (!row.queueCharged) return;
    global.queueCount--;
    global.queueBytes -= row.declaredBytes;
    row.queueCharged = false;
  }
  function chargeQueue(row: StoredUpload, global: GlobalState): void {
    if (row.queueCharged) return;
    if (global.queueCount >= 128 || global.queueBytes + row.declaredBytes > MAX_QUEUE_BYTES)
      reject('queue_full');
    global.queueCount++;
    global.queueBytes += row.declaredBytes;
    row.queueCharged = true;
  }
  async function totals(
    session: ClientSession,
  ): Promise<ResourceTotals & { queueCount: number; queueBytes: number }> {
    const rows = await Operation.aggregate<
      ResourceTotals & { queueCount: number; queueBytes: number }
    >([
      {
        $group: {
          _id: null,
          originalBytes: { $sum: '$originalBytes' },
          objectBytes: { $sum: '$originalBytes' },
          textBytes: { $sum: '$textBytes' },
          recordBytes: { $sum: '$recordBytes' },
          bundles: { $sum: 1 },
          queueCount: { $sum: { $cond: ['$queueCharged', 1, 0] } },
          queueBytes: { $sum: { $cond: ['$queueCharged', '$declaredBytes', 0] } },
        },
      },
    ]).session(session);
    return (
      rows[0] ?? {
        originalBytes: 0,
        objectBytes: 0,
        textBytes: 0,
        recordBytes: 0,
        bundles: 0,
        queueCount: 0,
        queueBytes: 0,
      }
    );
  }
  return {
    mongoose,
    Operation,
    Counter,
    initialize,
    transaction,
    save,
    touchPrincipal,
    releaseQueue,
    chargeQueue,
    totals,
  };
}

/** Stable digest for private snapshots and idempotent derived-content publication. */
export function uploadDigest(value: unknown): string {
  function stable(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(stable);
    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input)
          .filter(([, entry]) => entry !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, stable(entry)]),
      );
    return input;
  }
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}

export type UploadActivationMethods = {
  reconciliationSnapshot(now: number): Promise<UploadReconciliationSnapshot>;
  activateReconciled(proof: UploadActivationProof, now: number): Promise<void>;
};

/** Only the trusted inventory/lifecycle reconciliation composition may call this private port. */
export function createUploadActivationMethods(store: UploadStore): UploadActivationMethods {
  const keys = Object.keys(RESOURCE_MAX) as (keyof ResourceTotals)[];
  function survivingSourceMessage(): Record<string, unknown> {
    // A binding alone is not surviving content: empty/redacted bodies and removed quotations
    // may legitimately retain their provenance and an empty allocation list.
    const bodyContent = [
      ...[
        'text',
        'summary',
        'privateText',
        'subagentTranscript.messagesJson',
        'subagentActivityProjection.activityJson',
      ].map((path) => ({ [path]: { $type: 'string', $ne: '' } })),
      ...['content', 'files', 'attachments', 'privateTextTokens'].map((path) => ({
        [`${path}.0`]: { $exists: true },
      })),
      ...['metadata', 'contextMeta', 'feedback'].map((path) => ({
        [path]: { $exists: true, $nin: [null, {}, [], ''] },
      })),
    ];
    return {
      $or: [
        { 'sourceFileIds.0': { $exists: true }, sourceContentRemovedAt: null, $or: bodyContent },
        {
          'quoteSourceRetention.0': { $exists: true },
          $expr: {
            $anyElementTrue: [
              {
                $map: {
                  input: {
                    $cond: [{ $isArray: '$quoteSourceRetention' }, '$quoteSourceRetention', []],
                  },
                  as: 'binding',
                  in: {
                    $ne: [
                      {
                        $ifNull: [
                          {
                            $arrayElemAt: [
                              { $cond: [{ $isArray: '$quotes' }, '$quotes', []] },
                              '$$binding.index',
                            ],
                          },
                          '',
                        ],
                      },
                      '',
                    ],
                  },
                },
              },
            ],
          },
        },
      ],
    };
  }
  async function initialInventory(
    session: ClientSession,
  ): Promise<UploadReconciliationSnapshot['initialInventory']> {
    const { File, Message } = store.mongoose.models;
    if (!File || !Message) reject('not_ready');
    return runAsSystem(async () => {
      const operations = await store.Operation.aggregate([{ $limit: 1 }, { $count: 'present' }])
        .session(session)
        .option({ maxTimeMS: 2000 });
      const files = await File.aggregate([{ $limit: 1 }, { $count: 'present' }])
        .session(session)
        .option({ maxTimeMS: 2000 });
      const sourceMessages = await Message.aggregate([
        { $match: survivingSourceMessage() },
        { $limit: 1 },
        { $count: 'present' },
      ])
        .session(session)
        .option({ maxTimeMS: 2000 });
      return {
        operations: operations.length ? 1 : 0,
        files: files.length ? 1 : 0,
        sourceMessages: sourceMessages.length ? 1 : 0,
      };
    });
  }
  async function quiescent(global: GlobalState, session: ClientSession): Promise<void> {
    if (
      global.enabled ||
      global.migrationEpoch ||
      global.migration ||
      (await store.Operation.exists({
        $or: [{ slot: { $exists: true } }, { stagingHeld: true }],
      }).session(session))
    )
      reject('not_ready');
  }
  async function retainedTextFloor(session: ClientSession): Promise<number> {
    const { File, Message } = store.mongoose.models;
    if (!File || !Message) reject('not_ready');
    // Only this private activation owner performs a cross-tenant census. Raw aggregation keeps
    // missing legacy fields visible; ordinary hydrated File defaults are not inventory evidence.
    return runAsSystem(async () => {
      const [inventory] = await File.aggregate<{ textBytes: number; invalid: number }>([
        {
          $match: {
            $or: [
              { retentionAcceptedAt: { $ne: null } },
              { retainedDerivativeBytes: { $gt: 0 } },
              { 'retainedDerivativeReservations.0': { $exists: true } },
            ],
          },
        },
        {
          $project: {
            bytes: {
              $cond: [{ $isNumber: '$retainedDerivativeBytes' }, '$retainedDerivativeBytes', -1],
            },
          },
        },
        {
          $group: {
            _id: null,
            textBytes: { $sum: '$bytes' },
            invalid: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $gte: ['$bytes', 0] },
                      { $lte: ['$bytes', Number.MAX_SAFE_INTEGER] },
                      { $eq: ['$bytes', { $trunc: '$bytes' }] },
                    ],
                  },
                  0,
                  1,
                ],
              },
            },
          },
        },
      ])
        .session(session)
        .option({ maxTimeMS: 2000 });
      if (inventory?.invalid || !Number.isSafeInteger(inventory?.textBytes ?? 0))
        reject('not_ready');
      const unknown = await Message.aggregate<{ unaccounted: number }>([
        {
          $match: {
            $and: [
              {
                $or: [
                  { retainedTextAllocations: { $not: { $type: 'array' } } },
                  { 'retainedTextAllocations.0': { $exists: false } },
                ],
              },
              survivingSourceMessage(),
            ],
          },
        },
        { $limit: 1 },
        { $count: 'unaccounted' },
      ])
        .session(session)
        .option({ maxTimeMS: 2000 });
      if (unknown.length) reject('not_ready');
      // Aggregate already includes Message copies, held replay payload and released metadata.
      return inventory?.textBytes ?? 0;
    });
  }
  return {
    async reconciliationSnapshot(now) {
      if (!Number.isSafeInteger(now) || now < 0) reject('invalid_request');
      return store.transaction(async (session, global) => {
        if (typeof global.storeId !== 'string' || !global.storeId) reject('not_ready');
        await quiescent(global, session);
        const totals = await store.totals(session);
        if (
          !global.baseline ||
          keys.some((key) => global[key] !== global.baseline[key] + totals[key]) ||
          totals.queueCount !== global.queueCount ||
          totals.queueBytes !== global.queueBytes
        )
          reject('unavailable');
        global.reconciliationFence = { revision: global.revision + 1, observedAt: now };
        return {
          storeId: global.storeId,
          revision: global.reconciliationFence.revision,
          observedAt: new Date(now).toISOString(),
          initialInventory: await initialInventory(session),
          ledgerTotals: Object.fromEntries(keys.map((key) => [key, totals[key]])) as ResourceTotals,
          baseline: { ...global.baseline },
        };
      });
    },
    async activateReconciled(proof, now) {
      await store.transaction(async (session, global) => {
        if (
          typeof global.storeId !== 'string' ||
          !global.storeId ||
          proof.storeId !== global.storeId
        )
          reject('not_ready');
        if (
          global.activationProof &&
          uploadDigest(global.activationProof) === uploadDigest(proof)
        ) {
          if (!global.enabled || !global.reconciled || global.migration || global.migrationEpoch)
            reject('not_ready');
          return;
        }
        await quiescent(global, session);
        const observed = Date.parse(proof.observedAt);
        if (
          !global.reconciliationFence ||
          proof.revision !== global.revision ||
          proof.revision !== global.reconciliationFence.revision ||
          !Number.isSafeInteger(now) ||
          !Number.isSafeInteger(observed) ||
          observed < global.reconciliationFence.observedAt ||
          observed > now ||
          now - observed > 300_000 ||
          proof.historyCopiesAccounted !== true ||
          !proof.inventoryEvidenceId ||
          proof.inventoryEvidenceId.length > 512 ||
          !proof.baseline ||
          (proof.admission !== undefined && proof.admission !== 'initial-empty') ||
          keys.some(
            (key) => !Number.isSafeInteger(proof.baseline[key]) || proof.baseline[key] < 0,
          ) ||
          proof.baseline.objectBytes < proof.baseline.originalBytes
        )
          reject('not_ready');
        if (proof.admission === 'initial-empty') {
          const deadline = Date.parse(proof.originalDeadline ?? '');
          if (
            !Number.isSafeInteger(deadline) ||
            new Date(deadline).toISOString() !== proof.originalDeadline ||
            deadline < observed ||
            deadline > observed + 300_000 ||
            now >= deadline
          )
            reject('not_ready');
        }
        const totals = await store.totals(session);
        if (
          totals.queueCount !== global.queueCount ||
          totals.queueBytes !== global.queueBytes ||
          keys.some((key) => global[key] !== global.baseline[key] + totals[key])
        )
          reject('unavailable');
        if (proof.admission === 'initial-empty') {
          if (
            keys.some(
              (key) => global.baseline[key] !== 0 || proof.baseline[key] !== 0 || totals[key] !== 0,
            )
          )
            reject('not_ready');
          // Recheck database populations in this transaction. Independent File/Message writers
          // still require the coordinator's external quiescence proof; snapshots do not fence phantoms.
          const inventory = await initialInventory(session);
          if (inventory.operations || inventory.files || inventory.sourceMessages)
            reject('not_ready');
        }
        if (proof.baseline.textBytes < (await retainedTextFloor(session))) reject('not_ready');
        for (const key of keys) {
          const total = totals[key] + proof.baseline[key];
          if (!Number.isSafeInteger(total) || total > RESOURCE_MAX[key])
            reject('capacity_exceeded');
          global[key] = total;
        }
        global.baseline = { ...proof.baseline };
        global.activationProof = { ...proof, baseline: { ...proof.baseline } };
        global.reconciled = true;
        global.enabled = true;
        delete global.reconciliationFence;
      });
    },
  };
}
