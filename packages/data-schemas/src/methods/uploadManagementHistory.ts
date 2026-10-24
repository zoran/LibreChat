/** Raw historical observation at the existing Upload store; no lifecycle normalization or writes. */
import { mongo } from 'mongoose';
import { performance } from 'node:perf_hooks';
import type { ClientSession, Model } from 'mongoose';
import type { StoredUpload } from './uploadManagementState';

const SOURCE_LIMIT = 64 * 1024;
// A single source row leaves room for its BSON envelope. Larger rows remain explicit capacity.
const RECORD_LIMIT = SOURCE_LIMIT - 4096;

export type CompleteUploadObservation =
  | { outcome: 'eof'; cursor: string | null }
  | {
      outcome: 'observed';
      cursor: string | null;
      nextCursor: string;
      sourceBytes: number;
      completeUpload: Record<string, unknown>;
    };

export class UploadHistoryObservationError extends Error {
  constructor(readonly code: 'invalid_input' | 'deadline' | 'capacity' | 'unclassified') {
    super(code);
  }
}

/** Read one complete persisted operation, including active/expired/unknown states and custody.
 * The caller supplies its original session/deadline/abort signal and owns snapshot/hold authority.
 * A nonempty observation never claims EOF; only the following empty source read can do that.
 * Missing/malformed tenant, state, reservations and receipts are preserved for the join owner.
 */
export async function observeCompleteUpload(
  Operation: Model<StoredUpload>,
  cursor: string | null,
  session: ClientSession,
  end: number,
  signal: AbortSignal,
): Promise<CompleteUploadObservation> {
  if (cursor !== null && typeof cursor !== 'string')
    throw new UploadHistoryObservationError('invalid_input');
  if (!Number.isFinite(end) || signal.aborted || performance.now() >= end)
    throw new UploadHistoryObservationError('deadline');
  const ms = Math.max(1, Math.floor(end - performance.now()));
  const collection = Operation.collection as unknown as mongo.Collection<StoredUpload>;
  const original = collection.aggregate<{
    sourceBytes: number;
    completeUpload: Record<string, unknown> | null;
  }>(
    [
      // $expr compares BSON types too: malformed non-string IDs cannot disappear through
      // Mongo's ordinary range-query type bracketing after a valid string cursor.
      ...(cursor === null ? [] : [{ $match: { $expr: { $gt: ['$_id', { $literal: cursor }] } } }]),
      { $sort: { _id: 1 } },
      { $limit: 1 },
      {
        $project: {
          _id: 0,
          sourceBytes: { $bsonSize: '$$ROOT' },
          completeUpload: {
            $cond: [{ $lte: [{ $bsonSize: '$$ROOT' }, RECORD_LIMIT] }, '$$ROOT', null],
          },
        },
      },
    ],
    {
      session,
      signal,
      maxTimeMS: ms,
      ...(session.inTransaction() ? {} : { timeoutMS: ms }),
      hint: '_id_',
      collation: { locale: 'simple' },
      batchSize: 1,
    },
  );
  try {
    const observed = await original.next();
    if (signal.aborted || performance.now() >= end)
      throw new UploadHistoryObservationError('deadline');
    if (observed === null) return { outcome: 'eof', cursor };
    if (
      !Number.isSafeInteger(observed.sourceBytes) ||
      observed.sourceBytes < 0 ||
      observed.sourceBytes > RECORD_LIMIT ||
      observed.completeUpload === null ||
      mongo.BSON.calculateObjectSize(observed) > SOURCE_LIMIT
    )
      throw new UploadHistoryObservationError('capacity');
    const nextCursor = observed.completeUpload._id;
    if (typeof nextCursor !== 'string') throw new UploadHistoryObservationError('unclassified');
    return {
      outcome: 'observed',
      cursor,
      nextCursor,
      sourceBytes: observed.sourceBytes,
      completeUpload: observed.completeUpload,
    };
  } finally {
    await original.close();
  }
}
