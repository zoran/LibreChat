import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ClientSession } from 'mongoose';
import type {
  StatusUsageReceipt,
  StatusUsageBucket,
  StatusUsageWriteResult,
  StatusUsageGrantAction,
  StatusUsageVisiblePresence,
  StatusUsageOriginalPublication,
  StatusUsageCollectorFence,
  StatusUsageWindowEvidence,
  StatusUsageCoverageCause,
} from '../types/statusUsage';
import { touchActiveUserPrincipal, touchDeletingUserPrincipal } from '~/methods/userPrincipal';
import { tenantStorage, SYSTEM_TENANT_ID } from '~/config/tenantContext';
import { STATUS_USAGE_STORAGE_LIMITS as L } from '../types/statusUsage';
import { createStatusUsageModels } from '../models/statusUsage';

const HOUR = 3600000;
const hour = (at: number) => Math.floor(at / HOUR) * HOUR;
const key = (...parts: unknown[]) =>
  createHash('sha256')
    .update(JSON.stringify([1, ...parts]))
    .digest('hex');
const readFailure = (error: unknown): StatusUsageCoverageCause => {
  if (error instanceof Error && error.message === 'STATUS_USAGE_QUERY_CAPACITY') return 'capacity';
  if (
    (error instanceof Error &&
      (error.message === 'STATUS_USAGE_QUERY_TIMEOUT' ||
        error.name === 'MongoOperationTimeoutError')) ||
    (typeof error === 'object' && error !== null && 'code' in error && error.code === 50)
  )
    return 'query_timeout';
  return 'producer_gap';
};
const time = (at: number) => {
  if (!Number.isSafeInteger(at) || at < 0) throw TypeError('STATUS_USAGE_TIME');
  return at;
};
const readBits = (value: unknown) => {
  const bits = Buffer.isBuffer(value)
    ? Buffer.from(value)
    : Buffer.from((value as { buffer: Uint8Array }).buffer);
  if (bits.length !== 450) throw Error('STATUS_USAGE_BITS');
  return bits;
};
const identity = (value: string) => {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw TypeError('STATUS_USAGE_IDENTITY');
  return value;
};

/** One application domain; no generic event ingestion and no active model/answer ports. */
export interface StatusUsageOptions {
  scopeId: string;
  tenantId: string | null;
  clock?: () => number;
}
export interface StatusUsageMethods {
  initialize(): Promise<void>;
  recordAuthorizedAction(input: StatusUsageGrantAction): Promise<StatusUsageWriteResult>;
  recordVisiblePresence(input: StatusUsageVisiblePresence): Promise<StatusUsageWriteResult>;
  recordOriginalPublication(
    input: StatusUsageOriginalPublication,
    session: ClientSession,
  ): Promise<StatusUsageWriteResult>;
  readTrailingHour(asOfMs: number): Promise<StatusUsageWindowEvidence>;
  readCompletedHours(asOfMs: number): Promise<StatusUsageWindowEvidence[]>;
  acquireCollector(ownerId: string): Promise<StatusUsageCollectorFence | null>;
  advanceRetention(fence: StatusUsageCollectorFence): Promise<void>;
  purgeSubject(input: {
    userId: string;
    tenantId: string;
    fenceStartedAtMs: number;
  }): Promise<{ removed: number; more: boolean }>;
}
export function createStatusUsageMethods(
  mongoose: typeof import('mongoose'),
  options: StatusUsageOptions,
): StatusUsageMethods {
  if (typeof options !== 'object' || options === null || Array.isArray(options))
    throw TypeError('STATUS_USAGE_OPTIONS');
  const { scopeId: inputScopeId, tenantId, clock: inputClock } = options;
  if (typeof inputScopeId !== 'string') throw TypeError('STATUS_USAGE_IDENTITY');
  const scopeId = identity(inputScopeId);
  if (
    tenantId !== null &&
    (typeof tenantId !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(tenantId) ||
      tenantId === SYSTEM_TENANT_ID)
  )
    throw TypeError('STATUS_USAGE_TENANT');
  if (inputClock !== undefined && typeof inputClock !== 'function')
    throw TypeError('STATUS_USAGE_CLOCK');
  const clock = inputClock ?? Date.now;
  const { Receipt, Bucket } = createStatusUsageModels(mongoose);
  const scope = { scopeId, tenantId: tenantId === null ? { $eq: null, $exists: true } : tenantId };
  const controlId = key(scopeId, tenantId, 'control');
  const run = <T>(fn: () => Promise<T>) =>
    tenantStorage.run({ ...tenantStorage.getStore(), tenantId: tenantId ?? SYSTEM_TENANT_ID }, fn);
  const opts = (session?: ClientSession) => ({ session, maxTimeMS: L.mongoOperationMs });
  const query = <T>(value: { maxTimeMS(ms: number): T }) => value.maxTimeMS(L.mongoOperationMs);
  const base = (id: string) => ({
    _id: id,
    schemaVersion: 1 as const,
    scopeId,
    tenantId,
    revision: 0,
  });
  const expiry = (at: number) => new Date(hour(at) + (L.completedRetentionHours + 1) * HOUR);
  const bounded = (value: object, max: number) => {
    if (mongoose.mongo.BSON.calculateObjectSize(value) > max) throw Error('STATUS_USAGE_SIZE');
  };
  const transaction = <T>(fn: (session: ClientSession) => Promise<T>) =>
    run(async () => {
      const session = await mongoose.startSession();
      let attempts = 0;
      try {
        return await session.withTransaction(
          async () => {
            if (++attempts > L.casRetries) throw Error('STATUS_USAGE_RETRY_LIMIT');
            if (attempts > 1) await delay(25 * attempts);
            return fn(session);
          },
          {
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority', wtimeout: L.mongoOperationMs },
            maxCommitTimeMS: L.mongoOperationMs,
            timeoutMS: L.transactionMs,
          },
        );
      } finally {
        await session.endSession();
      }
    });
  async function control(session?: ClientSession, remainingMs: number = L.mongoOperationMs) {
    const row = await query(Bucket.findOne({ ...scope, _id: controlId }).session(session ?? null))
      .setOptions(
        session
          ? {}
          : { timeoutMS: Math.max(1, Math.floor(Math.min(L.mongoOperationMs, remainingMs))) },
      )
      .lean<StatusUsageBucket>();
    if (!row) throw Error('STATUS_USAGE_NOT_INITIALIZED');
    return row;
  }
  async function gap(
    group: 'users' | 'documents',
    at: number,
    cause: StatusUsageCoverageCause,
    session: ClientSession,
  ) {
    await Bucket.updateOne(
      { ...scope, _id: controlId },
      {
        $min: { [`${group}GapFromMs`]: at },
        $set: { [`${group}Gap`]: cause },
        $inc: { revision: 1 },
      },
      opts(session),
    );
  }
  async function reserve(group: 'users' | 'documents', at: number, session: ClientSession) {
    const result = await Bucket.updateOne(
      { ...scope, _id: controlId, reservedReceipts: { $lt: L.receiptReservations } },
      { $inc: { reservedReceipts: 1, revision: 1 }, $min: { [`${group}ObservedFromMs`]: at } },
      opts(session),
    );
    if (result.modifiedCount === 1) return true;
    await gap(group, at, 'capacity', session);
    return false;
  }
  async function increment(at: number, field: 'active' | 'published', session: ClientSession) {
    const id = key(scopeId, tenantId, hour(at));
    await Bucket.updateOne(
      { ...scope, _id: id },
      {
        $setOnInsert: { ...base(id), kind: 'hour', hourStartMs: hour(at), expiresAt: expiry(at) },
        $inc: { [field]: 1 },
      },
      { ...opts(session), upsert: true },
    );
  }
  async function fenceGrant(
    grant: StatusUsageGrantAction['grant'],
    at: number,
    session: ClientSession,
  ) {
    if (grant.tenantId !== tenantId || !/^[a-f0-9]{24}$/.test(grant.sessionId) || at > clock())
      throw Error('STATUS_USAGE_GRANT');
    await touchActiveUserPrincipal(mongoose, { userId: grant.userId, tenantId }, session);
    const live = await query(
      mongoose.models.Session.findOne({
        _id: grant.sessionId,
        tenantId,
        user: grant.userId,
        authMethod: 'email_code',
        authVersion: grant.authVersion,
        authPolicyVersion: grant.policyVersion,
        revokedAt: { $exists: false },
        expiration: { $gt: new Date(clock()) },
        idleExpiresAt: { $gt: new Date(clock()) },
      }).session(session),
    ).lean<{ authCreatedAt?: Date }>();
    if (!live) throw Error('STATUS_USAGE_GRANT');
    const user = await query(
      mongoose.models.User.findOne({
        _id: grant.userId,
        tenantId,
        provider: 'email_code',
        emailVerified: true,
      }).session(session),
    ).lean<{ authVersion?: number; credentialsChangedAt?: Date; twoFactorEnrolledAt?: Date }>();
    if (
      !user ||
      (user.authVersion ?? 0) !== grant.authVersion ||
      !live.authCreatedAt ||
      (user.credentialsChangedAt && user.credentialsChangedAt >= live.authCreatedAt) ||
      (user.twoFactorEnrolledAt && user.twoFactorEnrolledAt > live.authCreatedAt)
    )
      throw Error('STATUS_USAGE_GRANT');
  }
  async function recordAuthorizedAction(
    input: StatusUsageGrantAction,
  ): Promise<StatusUsageWriteResult> {
    const at = time(input.authorizedAtMs);
    return transaction(async (session) => {
      await fenceGrant(input.grant, at, session);
      const c = await control(session);
      if (at < Math.max(c.acceptAfterMs!, hour(clock()) - L.completedRetentionHours * HOUR))
        return 'expired';
      const id = key(scopeId, tenantId, 'activity_hour', input.grant.userId, hour(at));
      const row = await query(
        Receipt.findOne({ ...scope, _id: id }).session(session),
      ).lean<StatusUsageReceipt>();
      const bits = row ? readBits(row.activityBits) : Buffer.alloc(450);
      const second = Math.floor((at - hour(at)) / 1000),
        byte = second >> 3,
        mask = 1 << (second & 7);
      if (bits[byte] & mask) return 'duplicate';
      bits[byte] |= mask;
      if (row) {
        const result = await Receipt.updateOne(
          { ...scope, _id: id, revision: row.revision },
          { $set: { activityBits: bits, updatedAtMs: clock() }, $inc: { revision: 1 } },
          opts(session),
        );
        if (result.modifiedCount !== 1) throw Error('STATUS_USAGE_CAS');
      } else {
        if (!(await reserve('users', at, session))) return 'capacity';
        const document: StatusUsageReceipt = {
          ...base(id),
          kind: 'activity_hour',
          userId: input.grant.userId,
          hourStartMs: hour(at),
          activityBits: bits,
          createdAtMs: clock(),
          updatedAtMs: clock(),
          expiresAt: expiry(at),
        };
        bounded(document, L.receiptBytes);
        await Receipt.insertMany([document], opts(session));
        await increment(at, 'active', session);
      }
      return 'recorded';
    });
  }
  async function recordVisiblePresence(
    input: StatusUsageVisiblePresence,
  ): Promise<StatusUsageWriteResult> {
    const at = time(input.visibleObservedAtMs);
    return transaction(async (session) => {
      await fenceGrant(input.grant, at, session);
      const c = await control(session);
      if (at < Math.max(c.acceptAfterMs!, hour(clock()) - L.completedRetentionHours * HOUR))
        return 'expired';
      const id = key(scopeId, tenantId, 'presence', input.grant.sessionId);
      const row = await query(
        Receipt.findOne({ ...scope, _id: id }).session(session),
      ).lean<StatusUsageReceipt>();
      if (row && row.lastVisibleAtMs! >= at) return 'duplicate';
      if (!row && !(await reserve('users', at, session))) return 'capacity';
      const document: StatusUsageReceipt = {
        ...base(id),
        kind: 'presence',
        userId: input.grant.userId,
        sessionId: input.grant.sessionId,
        authVersion: input.grant.authVersion,
        policyVersion: input.grant.policyVersion,
        lastVisibleAtMs: at,
        leaseUntilMs: at + 90000,
        createdAtMs: row?.createdAtMs ?? clock(),
        updatedAtMs: clock(),
        expiresAt: new Date(at + 90000),
        revision: (row?.revision ?? -1) + 1,
      };
      bounded(document, L.receiptBytes);
      await Receipt.replaceOne(
        { ...scope, _id: id, ...(row ? { revision: row.revision } : {}) },
        document,
        { ...opts(session), upsert: !row },
      );
      return 'recorded';
    });
  }
  async function recordOriginalPublication(
    input: StatusUsageOriginalPublication,
    session: ClientSession,
  ): Promise<StatusUsageWriteResult> {
    if (
      !(session instanceof mongoose.mongo.ClientSession) ||
      !session.inTransaction() ||
      session.hasEnded ||
      input.tenantId !== tenantId ||
      typeof input.operationId !== 'string' ||
      !input.operationId.length ||
      Buffer.byteLength(input.operationId) > 256
    )
      throw Error('STATUS_USAGE_PUBLICATION');
    const at = time(input.publishedAtMs);
    if (at > clock()) throw Error('STATUS_USAGE_TIME');
    return run(async () => {
      const c = await control(session);
      if (at < Math.max(c.acceptAfterMs!, hour(clock()) - L.completedRetentionHours * HOUR))
        return 'expired';
      const id = key(scopeId, tenantId, 'document_publication', input.operationId);
      const row = await query(
        Receipt.findOne({ ...scope, _id: id }).session(session),
      ).lean<StatusUsageReceipt>();
      if (row) {
        if (row.publishedAtMs === at) return 'duplicate';
        await gap('documents', at, 'owner_conflict', session);
        return 'conflict';
      }
      if (!(await reserve('documents', at, session))) return 'capacity';
      const document: StatusUsageReceipt = {
        ...base(id),
        kind: 'document_publication',
        publishedAtMs: at,
        hourStartMs: hour(at),
        createdAtMs: clock(),
        updatedAtMs: clock(),
        expiresAt: expiry(at),
      };
      bounded(document, L.receiptBytes);
      await Receipt.insertMany([document], opts(session));
      await increment(at, 'published', session);
      return 'recorded';
    });
  }
  async function initialize() {
    return run(async () => {
      await Promise.all([Receipt.init(), Bucket.init()]);
      await Bucket.updateOne(
        { ...scope, _id: controlId },
        {
          $setOnInsert: {
            ...base(controlId),
            kind: 'control',
            acceptAfterMs: Math.max(0, hour(clock()) - L.completedRetentionHours * HOUR),
            reservedReceipts: 0,
            collectorEpoch: 0,
            collectorUntilMs: 0,
          },
        },
        {
          upsert: true,
          maxTimeMS: L.mongoOperationMs,
          writeConcern: { w: 'majority', wtimeout: L.mongoOperationMs },
        },
      );
    });
  }
  async function readTrailingHour(asOfMs: number): Promise<StatusUsageWindowEvidence> {
    time(asOfMs);
    if (asOfMs % 1000 !== 0 || asOfMs > clock()) throw Error('STATUS_USAGE_WINDOW');
    const startMs = asOfMs - HOUR,
      began = performance.now();
    return run(async () => {
      try {
        const c = await control();
        const rows = await query(
          Receipt.find({
            ...scope,
            $or: [
              { kind: 'activity_hour', hourStartMs: { $gte: hour(startMs), $lt: asOfMs } },
              { kind: 'document_publication', publishedAtMs: { $gte: startMs, $lt: asOfMs } },
            ],
          }).limit(L.queryMax + 1),
        )
          .setOptions({
            timeoutMS: Math.max(
              1,
              Math.floor(
                Math.min(L.mongoOperationMs, L.overallReadMs - (performance.now() - began)),
              ),
            ),
          })
          .lean<StatusUsageReceipt[]>();
        if (rows.length > L.queryMax) throw Error('STATUS_USAGE_QUERY_CAPACITY');
        if (performance.now() - began > L.overallReadMs) throw Error('STATUS_USAGE_QUERY_TIMEOUT');
        const users = new Set<string>();
        let published = 0;
        for (const row of rows) {
          if (row.kind === 'document_publication') {
            published++;
            continue;
          }
          const bits = readBits(row.activityBits);
          for (
            let second = Math.max(0, (startMs - row.hourStartMs!) / 1000);
            second < Math.min(3600, (asOfMs - row.hourStartMs!) / 1000);
            second++
          )
            if (bits[second >> 3] & (1 << (second & 7))) {
              users.add(row.userId!);
              break;
            }
        }
        if (performance.now() - began > L.overallReadMs) throw Error('STATUS_USAGE_QUERY_TIMEOUT');
        return {
          startMs,
          endMs: asOfMs,
          activeUsers: c.usersObservedFromMs === undefined ? null : users.size,
          publishedDocuments: c.documentsObservedFromMs === undefined ? null : published,
          complete: false,
          gap: c.usersGap ?? c.documentsGap ?? 'not_instrumented',
        };
      } catch (error) {
        return {
          startMs,
          endMs: asOfMs,
          activeUsers: null,
          publishedDocuments: null,
          complete: false,
          gap: readFailure(error),
        };
      }
    });
  }
  async function readCompletedHours(asOfMs: number): Promise<StatusUsageWindowEvidence[]> {
    time(asOfMs);
    if (asOfMs > clock()) throw Error('STATUS_USAGE_WINDOW');
    const end = hour(asOfMs),
      start = end - 168 * HOUR,
      began = performance.now();
    return run(async () => {
      try {
        const rows = await query(
          Bucket.find({ ...scope, kind: 'hour', hourStartMs: { $gte: start, $lt: end } }).limit(
            168,
          ),
        )
          .setOptions({ timeoutMS: L.mongoOperationMs })
          .lean<StatusUsageBucket[]>();
        const c = await control(undefined, L.overallReadMs - (performance.now() - began));
        if (performance.now() - began > L.overallReadMs) throw Error('STATUS_USAGE_QUERY_TIMEOUT');
        const byHour = new Map(rows.map((row) => [row.hourStartMs, row]));
        return Array.from({ length: 168 }, (_, i) => {
          const at = start + i * HOUR,
            row = byHour.get(at);
          return {
            startMs: at,
            endMs: at + HOUR,
            activeUsers: row?.active ?? null,
            publishedDocuments: row?.published ?? null,
            complete: false as const,
            gap: c.usersGap ?? c.documentsGap ?? 'not_instrumented',
          };
        });
      } catch (error) {
        return Array.from({ length: 168 }, (_, i) => ({
          startMs: start + i * HOUR,
          endMs: start + (i + 1) * HOUR,
          activeUsers: null,
          publishedDocuments: null,
          complete: false as const,
          gap: readFailure(error),
        }));
      }
    });
  }
  async function acquireCollector(ownerId: string): Promise<StatusUsageCollectorFence | null> {
    identity(ownerId);
    return transaction(async (session) => {
      const c = await control(session),
        now = clock();
      if (c.collectorUntilMs! > now && c.collectorOwner !== ownerId) return null;
      const epoch =
        c.collectorOwner === ownerId && c.collectorUntilMs! > now
          ? c.collectorEpoch!
          : c.collectorEpoch! + 1;
      const result = await Bucket.updateOne(
        { ...scope, _id: controlId, revision: c.revision },
        {
          $set: {
            collectorOwner: ownerId,
            collectorEpoch: epoch,
            collectorUntilMs: now + L.collectorLeaseMs,
          },
          $inc: { revision: 1 },
        },
        opts(session),
      );
      if (result.modifiedCount !== 1) throw Error('STATUS_USAGE_CAS');
      return { ownerId, epoch };
    });
  }
  async function advanceRetention(fence: StatusUsageCollectorFence): Promise<void> {
    return transaction(async (session) => {
      const c = await control(session),
        now = clock();
      if (
        c.collectorOwner !== fence.ownerId ||
        c.collectorEpoch !== fence.epoch ||
        c.collectorUntilMs! <= now
      )
        throw Error('STATUS_USAGE_FENCE');
      const cutoff = Math.max(c.acceptAfterMs!, hour(now) - L.completedRetentionHours * HOUR);
      await Bucket.updateOne(
        { ...scope, _id: controlId, revision: c.revision },
        { $set: { acceptAfterMs: cutoff }, $inc: { revision: 1 } },
        opts(session),
      );
      const old = await query(
        Receipt.find({ ...scope, expiresAt: { $lte: new Date(now) } })
          .select('_id')
          .limit(L.batch)
          .session(session),
      ).lean();
      await Receipt.deleteMany({ ...scope, _id: { $in: old.map((r) => r._id) } }, opts(session));
      await Bucket.deleteMany(
        { ...scope, kind: 'hour', hourStartMs: { $lt: cutoff } },
        opts(session),
      );
      const count = await query(Receipt.countDocuments(scope).session(session));
      await Bucket.updateOne(
        { ...scope, _id: controlId },
        { $set: { reservedReceipts: count }, $inc: { revision: 1 } },
        opts(session),
      );
    });
  }
  async function purgeSubject(input: {
    userId: string;
    tenantId: string;
    fenceStartedAtMs: number;
  }) {
    if (input.tenantId !== tenantId) throw Error('STATUS_USAGE_TENANT');
    time(input.fenceStartedAtMs);
    return transaction(async (session) => {
      await touchDeletingUserPrincipal(
        mongoose,
        { userId: input.userId, tenantId },
        new Date(input.fenceStartedAtMs),
        session,
      );
      const rows = await query(
        Receipt.find({ ...scope, userId: input.userId })
          .sort({ _id: 1 })
          .limit(L.batch)
          .session(session),
      ).lean<StatusUsageReceipt[]>();
      if (rows.some((row) => row.kind === 'activity_hour'))
        await gap(
          'users',
          Math.min(...rows.filter((r) => r.kind === 'activity_hour').map((r) => r.hourStartMs!)),
          'purged_activity',
          session,
        );
      const removed = await Receipt.deleteMany(
        { ...scope, _id: { $in: rows.map((row) => row._id) } },
        opts(session),
      );
      const count = await query(Receipt.countDocuments(scope).session(session));
      await Bucket.updateOne(
        { ...scope, _id: controlId },
        { $set: { reservedReceipts: count }, $inc: { revision: 1 } },
        opts(session),
      );
      return { removed: removed.deletedCount, more: rows.length === L.batch };
    });
  }
  return {
    initialize,
    recordAuthorizedAction,
    recordVisiblePresence,
    recordOriginalPublication,
    readTrailingHour,
    readCompletedHours,
    acquireCollector,
    advanceRetention,
    purgeSubject,
  };
}
