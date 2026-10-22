import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { FilterQuery, Model } from 'mongoose';
import type * as mongoose from 'mongoose';
import type { MessageSourceCleanupCursor } from '../types/fileCleanup';
import type { FileOwnerScope } from '../types/file';
import type { IMessage } from '../types/message';
import { FileSourceUnavailableError, fileSourceScope } from './fileRetention';
export type { MessageSourceCleanupCursor } from '../types/fileCleanup';

export interface MessageSourceCleanupOptions {
  /** Absolute epoch milliseconds; one call also has a fixed 10-second ceiling. */
  deadlineAt: number;
  signal: AbortSignal;
  /** Integer 1..100; default 25. At most this many Message rows are processed. */
  limit?: number;
  cursor?: MessageSourceCleanupCursor | null;
}

export interface MessageSourceCleanupCounts {
  redactedMessages: number;
  detachedMessages: number;
}

export type MessageSourceCleanupResult = MessageSourceCleanupCounts &
  ({ complete: true; cursor: null } | { complete: false; cursor: MessageSourceCleanupCursor });

export interface MessageSourceCleanupMethod {
  (owner: FileOwnerScope, fileIds: readonly string[]): Promise<MessageSourceCleanupCounts>;
  (
    owner: FileOwnerScope,
    fileIds: readonly string[],
    options: MessageSourceCleanupOptions,
  ): Promise<MessageSourceCleanupResult>;
}

export interface MessageSourceCleanupBudget {
  readonly signal: AbortSignal;
  remainingMS(): number;
  queryOptions(): { maxTimeMS: number; timeoutMS: number; signal: AbortSignal };
}

function createBudget(
  deadlineAt: number,
  signal: AbortSignal,
  ceiling: number,
): MessageSourceCleanupBudget {
  if (!Number.isFinite(deadlineAt) || deadlineAt <= 0 || !(signal instanceof AbortSignal))
    throw new TypeError('Invalid Message source cleanup deadline or signal');
  const expires = performance.now() + Math.min(ceiling, deadlineAt - Date.now());
  const remainingMS = (): number => {
    if (signal.aborted) {
      const error = new Error('Message source cleanup was aborted');
      error.name = 'AbortError';
      throw error;
    }
    const remaining = Math.floor(Math.min(expires - performance.now(), deadlineAt - Date.now()));
    if (remaining < 1) {
      const error = new Error('Message source cleanup deadline expired');
      error.name = 'TimeoutError';
      throw error;
    }
    return remaining;
  };
  return {
    signal,
    remainingMS,
    queryOptions: () => {
      const remaining = remainingMS();
      return { maxTimeMS: remaining, timeoutMS: remaining, signal };
    },
  };
}

/** One bounded owner for the existing Message redaction and reference cleanup operation. */
export function createMessageSourceCleanup(
  db: typeof mongoose,
  dependencies: {
    privateMessagePaths(): string;
    redactRow(
      owner: FileOwnerScope,
      ids: readonly string[],
      row: IMessage,
      budget: MessageSourceCleanupBudget,
    ): Promise<number>;
  },
): MessageSourceCleanupMethod {
  async function page(
    owner: FileOwnerScope,
    fileIds: readonly string[],
    options: MessageSourceCleanupOptions,
  ): Promise<MessageSourceCleanupResult> {
    owner = { userId: owner.userId, tenantId: owner.tenantId };
    const budget = createBudget(options.deadlineAt, options.signal, 10_000);
    budget.remainingMS();
    const limit = options.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError('Invalid Message source cleanup page size');
    const ids = [...new Set(fileIds)].sort();
    const scope = fileSourceScope(owner);
    const scopeSha256 = createHash('sha256')
      .update(JSON.stringify([owner.userId, owner.tenantId ?? null, ids]))
      .digest('hex');
    const cursor: MessageSourceCleanupCursor =
      options.cursor == null
        ? { version: 1, scopeSha256, phase: 'redact', after: null }
        : { ...options.cursor };
    if (
      cursor.version !== 1 ||
      cursor.scopeSha256 !== scopeSha256 ||
      !['redact', 'detach'].includes(cursor.phase) ||
      (cursor.after !== null &&
        (typeof cursor.after !== 'string' || !/^[a-f0-9]{24}$/.test(cursor.after)))
    )
      throw new TypeError('Invalid Message source cleanup cursor');
    const counts = { redactedMessages: 0, detachedMessages: 0 };
    if (!ids.length) return { ...counts, complete: true, cursor: null };

    // File revoke precedes cleanup, preventing new admitted source-body commits.
    const files = await db.models.File.find({
      ...scope,
      file_id: { $in: ids },
      retentionAcceptedAt: { $ne: null },
      deletionRequestedAt: { $ne: null },
    })
      .select('file_id')
      .limit(ids.length + 1)
      .setOptions(budget.queryOptions())
      .lean();
    budget.remainingMS();
    if (files.length !== ids.length) throw new FileSourceUnavailableError();

    const body = [
      { sourceFileIds: { $in: ids }, sourceContentRemovedAt: null },
      { 'quoteSourceRetention.sourceFileIds': { $in: ids } },
    ];
    const references = [{ 'files.file_id': { $in: ids } }, { 'attachments.file_id': { $in: ids } }];
    const Message = db.models.Message as Model<IMessage>;
    const affected: FilterQuery<IMessage> = {
      ...scope,
      $or: cursor.phase === 'redact' ? body : references,
      ...(cursor.after === null ? {} : { _id: { $gt: cursor.after } }),
    };
    const rows = await Message.find(affected)
      .sort({ _id: 1 })
      .limit(limit)
      .select(cursor.phase === 'redact' ? dependencies.privateMessagePaths() : '_id')
      .setOptions(budget.queryOptions())
      .lean<IMessage[]>();
    budget.remainingMS();
    for (const row of rows) {
      budget.remainingMS();
      if (cursor.phase === 'redact') {
        counts.redactedMessages += await dependencies.redactRow(owner, ids, row, budget);
      } else {
        const result = await Message.updateOne(
          { _id: row._id, ...scope, $or: references },
          {
            $pull: { files: { file_id: { $in: ids } }, attachments: { file_id: { $in: ids } } },
            $inc: { __v: 1 },
          },
          { timestamps: false, writeConcern: { w: 'majority' }, ...budget.queryOptions() },
        );
        if (!result.acknowledged) throw new Error('Message reference cleanup was not acknowledged');
        counts.detachedMessages += result.modifiedCount;
      }
      budget.remainingMS();
    }

    // Completion is a majority primary read over the entire scope, never an empty page.
    const pending = await Message.findOne({ ...scope, $or: [...body, ...references] })
      .select('_id')
      .read('primary')
      .readConcern('majority')
      .setOptions(budget.queryOptions())
      .lean();
    budget.remainingMS();
    if (!pending) return { ...counts, complete: true, cursor: null };
    const phaseEnded = rows.length < limit;
    const nextPhase = cursor.phase === 'redact' ? 'detach' : 'redact';
    return {
      ...counts,
      complete: false,
      cursor: {
        version: 1,
        scopeSha256,
        phase: phaseEnded ? nextPhase : cursor.phase,
        after: phaseEnded ? null : String(rows[rows.length - 1]._id),
      },
    };
  }

  function cleanup(
    owner: FileOwnerScope,
    fileIds: readonly string[],
  ): Promise<MessageSourceCleanupCounts>;
  function cleanup(
    owner: FileOwnerScope,
    fileIds: readonly string[],
    options: MessageSourceCleanupOptions,
  ): Promise<MessageSourceCleanupResult>;
  async function cleanup(
    owner: FileOwnerScope,
    fileIds: readonly string[],
    options?: MessageSourceCleanupOptions,
  ): Promise<MessageSourceCleanupCounts | MessageSourceCleanupResult> {
    if (options) return page(owner, fileIds, options);
    const deadlineAt = Date.now() + 60_000;
    const signal = new AbortController().signal;
    const budget = createBudget(deadlineAt, signal, 60_000);
    const counts = { redactedMessages: 0, detachedMessages: 0 };
    let cursor: MessageSourceCleanupCursor | null = null;
    for (;;) {
      const result = await page(owner, fileIds, {
        deadlineAt: Math.min(deadlineAt, Date.now() + budget.remainingMS()),
        signal,
        cursor,
      });
      counts.redactedMessages += result.redactedMessages;
      counts.detachedMessages += result.detachedMessages;
      budget.remainingMS();
      if (result.complete) return counts;
      cursor = result.cursor;
    }
  }
  return cleanup;
}
