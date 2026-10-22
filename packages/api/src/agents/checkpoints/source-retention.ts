/** Native checkpoint rows own exact File copy liabilities in their caller's transaction. */
import mongoose from 'mongoose';
import { performance } from 'node:perf_hooks';
import {
  resizeRetainedDerivatives,
  snapshotCheckpointSourceBinding,
} from '@librechat/data-schemas';
import type { CheckpointSourceBinding, RetainedTextAllocation } from '@librechat/data-schemas';
import type { Document, Filter, UpdateOneModel, UpdateFilter } from 'mongodb';
import type { ResolvedCheckpointerConfig } from './config';
import { checkpointOwnerNamespacePrefix } from '../../stream/checkpoints';

const SOURCE_FIELDS = [
  'lc_source_binding',
  'lc_source_file_ids',
  'lc_source_expires_at',
  'lc_retained_allocations',
] as const;
export const SOURCE_FREE: Record<string, { $exists: boolean }> = Object.fromEntries(
  SOURCE_FIELDS.map((field) => [field, { $exists: false }]),
);
export const SOURCE_PRESENT: { $or: Record<string, { $exists: boolean }>[] } = {
  $or: SOURCE_FIELDS.map((field) => ({ [field]: { $exists: true } })),
};
const BATCH_ROWS = 16;
const MAX_METADATA_BYTES = 65536;

function held(): never {
  throw new Error('Checkpoint source cleanup is incomplete or unverified');
}

type PurgeStorage = Pick<
  ResolvedCheckpointerConfig,
  'checkpointCollectionName' | 'checkpointWritesCollectionName'
>;
type MetadataRow = { meta: Document | null; bytes: number; metadataBytes: number };

export function checkpointRowLiability(row: MetadataRow): {
  binding: CheckpointSourceBinding;
  owner: { userId: string; tenantId: string | null };
  allocation: RetainedTextAllocation;
} {
  const meta = row.meta;
  if (
    !meta ||
    !(meta._id instanceof mongoose.mongo.ObjectId) ||
    !SOURCE_FIELDS.every((field) => Object.prototype.hasOwnProperty.call(meta, field)) ||
    Object.prototype.hasOwnProperty.call(meta, 'upserted_at')
  )
    held();
  const binding = snapshotCheckpointSourceBinding(
    meta.lc_source_binding?.owner,
    meta.lc_source_binding,
  );
  const owner = binding.owner;
  const prefix = checkpointOwnerNamespacePrefix(owner.userId, owner.tenantId ?? undefined);
  if (
    meta.lc_owner !== prefix ||
    typeof meta.thread_id !== 'string' ||
    !meta.thread_id.startsWith(prefix) ||
    meta.thread_id.length <= prefix.length ||
    typeof meta.checkpoint_ns !== 'string' ||
    !meta.checkpoint_ns.startsWith(prefix)
  )
    held();
  const ids = binding.files.map((file) => file.fileId);
  if (
    !Array.isArray(meta.lc_source_file_ids) ||
    meta.lc_source_file_ids.length !== ids.length ||
    ids.some((id, index) => meta.lc_source_file_ids[index] !== id)
  )
    held();
  const expiry = meta.lc_source_expires_at;
  if (
    !(expiry instanceof Date) ||
    !Number.isFinite(expiry.getTime()) ||
    expiry.getTime() <= 0 ||
    expiry.getTime() > Date.parse(binding.expiresAt)
  )
    held();
  const allocations = meta.lc_retained_allocations;
  if (
    !Array.isArray(allocations) ||
    allocations.length !== 1 ||
    !allocations[0] ||
    Object.keys(allocations[0]).sort().join(',') !== 'bytes,fileId' ||
    allocations[0].fileId !== ids[0] ||
    !Number.isSafeInteger(allocations[0].bytes) ||
    allocations[0].bytes <= 0 ||
    allocations[0].bytes !== row.bytes
  )
    held();
  return { binding, owner, allocation: { fileId: ids[0], bytes: row.bytes } };
}

/** Private writer only: source fences and generation authority belong to the enclosing transaction. */
export async function writeCheckpointSourceRows(
  input: {
    collectionName: string;
    operations: readonly UpdateOneModel<Document>[];
    binding: CheckpointSourceBinding;
    expiresAt: Date;
    maxBsonBytes: number;
  },
  session: mongoose.ClientSession,
): Promise<void> {
  if (
    !(session instanceof mongoose.mongo.ClientSession) ||
    session.hasEnded ||
    !session.inTransaction()
  )
    held();
  const binding = snapshotCheckpointSourceBinding(input.binding.owner, input.binding);
  let expiry = input.expiresAt.getTime();
  if (
    !Number.isFinite(expiry) ||
    expiry <= Date.now() ||
    expiry > Date.parse(binding.expiresAt) ||
    input.operations.length > 1024 ||
    !Number.isSafeInteger(input.maxBsonBytes) ||
    input.maxBsonBytes <= 0
  )
    held();
  const db = mongoose.connection.db;
  if (!db) held();
  const collection = db.collection(input.collectionName);
  const prefix = checkpointOwnerNamespacePrefix(
    binding.owner.userId,
    binding.owner.tenantId ?? undefined,
  );
  const projection = Object.fromEntries(
    ['_id', 'thread_id', 'checkpoint_ns', 'lc_owner', 'upserted_at', ...SOURCE_FIELDS].map(
      (field) => [field, `$${field}`],
    ),
  );
  const read = (filter: Document) =>
    collection
      .aggregate<MetadataRow>(
        [
          { $match: filter },
          { $limit: 2 },
          { $project: { _id: 0, bytes: { $bsonSize: '$$ROOT' }, meta: projection } },
          { $set: { metadataBytes: { $bsonSize: '$meta' } } },
          {
            $project: {
              bytes: 1,
              metadataBytes: 1,
              meta: { $cond: [{ $lte: ['$metadataBytes', MAX_METADATA_BYTES] }, '$meta', null] },
            },
          },
        ],
        { session, collation: { locale: 'simple' }, maxTimeMS: 5000 },
      )
      .toArray();
  for (const operation of input.operations) {
    const { lc_owner: owner, ...slot } = operation.filter;
    if (
      owner !== prefix ||
      typeof slot.thread_id !== 'string' ||
      !slot.thread_id.startsWith(prefix) ||
      typeof slot.checkpoint_ns !== 'string' ||
      !slot.checkpoint_ns.startsWith(prefix)
    )
      held();
    const previous = await read(slot);
    if (previous.length > 1) held();
    const prior = previous[0] ? checkpointRowLiability(previous[0]) : undefined;
    if (prior && prior.binding.bindingSha256 !== binding.bindingSha256) held();
    const update = operation.update as UpdateFilter<Document>;
    if (Array.isArray(update) || (!update.$set && !update.$setOnInsert)) held();
    // The validated prior row and this update share one Mongo transaction: a rewrite
    // cannot renew its admitted recovery deadline, including mutable special slots.
    const rowExpiry = Math.min(
      input.expiresAt.getTime(),
      prior ? previous[0].meta!.lc_source_expires_at.getTime() : Infinity,
    );
    expiry = Math.min(expiry, rowExpiry);
    if (expiry <= Date.now()) held();
    if (prior && update.$setOnInsert) {
      // Native insert-only replay also retains its original payload and exact charge.
      continue;
    }
    const fields = { ...(update.$set ?? update.$setOnInsert) };
    delete fields.upserted_at;
    const id = previous[0]?.meta?._id ?? new mongoose.mongo.ObjectId();
    await collection.updateOne(
      { ...slot, lc_owner: prefix, _id: id },
      {
        $set: {
          ...fields,
          lc_source_binding: binding,
          lc_source_file_ids: binding.files.map((file) => file.fileId),
          lc_source_expires_at: new Date(rowExpiry),
          lc_retained_allocations: [{ fileId: binding.files[0].fileId, bytes: 1 }],
        },
        $unset: { upserted_at: '' },
      },
      { session, upsert: true, collation: { locale: 'simple' }, maxTimeMS: 5000 },
    );
    const [postimage] = await read({ _id: id });
    if (
      !postimage?.meta ||
      !Number.isSafeInteger(postimage.bytes) ||
      postimage.bytes <= 0 ||
      postimage.bytes > input.maxBsonBytes
    )
      held();
    await collection.updateOne(
      { _id: id },
      { $set: { 'lc_retained_allocations.0.bytes': postimage.bytes } },
      { session, maxTimeMS: 5000 },
    );
    const [settled] = await read({ _id: id });
    if (!settled || settled.bytes !== postimage.bytes) held();
    const next = checkpointRowLiability(settled);
    await resizeRetainedDerivatives(
      mongoose,
      binding.owner,
      prior ? [prior.allocation] : [],
      [next.allocation],
      session,
    );
  }
  if (expiry <= Date.now()) held();
}

/** Existing caller filters authorize targets. Unknown or malformed liabilities are held. */
export async function purgeCheckpointRows(
  storage: PurgeStorage,
  filter: Filter<Document>,
  options: {
    singleCheckpoint?: boolean;
    pendingFirst?: boolean;
    sourceFileIds?: readonly string[];
  } = {},
): Promise<void> {
  const db = mongoose.connection.db;
  if (!db || mongoose.connection.readyState !== 1)
    throw new Error('Checkpoint database is unavailable');
  const started = performance.now();
  const remaining = (): number => {
    const value = Math.floor(10000 - (performance.now() - started));
    if (value <= 0) held();
    return value;
  };
  const names = [storage.checkpointWritesCollectionName, storage.checkpointCollectionName];
  if (
    names.some(
      (name) =>
        typeof name !== 'string' ||
        !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/.test(name) ||
        name.startsWith('system.'),
    )
  )
    held();
  let checkpointAllowance = options.singleCheckpoint ? 1 : Infinity;
  // Keep the native source-free path usable on standalone Mongo. A racing marker prevents deletion.
  const ordinaryNames = options.pendingFirst ? names : [...names].reverse();
  for (const name of options.sourceFileIds ? [] : ordinaryNames) {
    const collection = db.collection(name);
    const single = name === storage.checkpointCollectionName && options.singleCheckpoint;
    const query = {
      ...filter,
      ...SOURCE_FREE,
      ...(SOURCE_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(filter, field))
        ? { $and: [filter, SOURCE_FREE] }
        : {}),
    };
    const result = single
      ? await collection.deleteOne(query, { maxTimeMS: remaining() })
      : await collection.deleteMany(query, { maxTimeMS: remaining() });
    if (single) checkpointAllowance -= result.deletedCount;
  }
  const projection = Object.fromEntries(
    ['_id', 'thread_id', 'checkpoint_ns', 'lc_owner', 'upserted_at', ...SOURCE_FIELDS].map(
      (field) => [field, `$${field}`],
    ),
  );
  const cursors = new Map<string, mongoose.mongo.ObjectId>();
  async function read(
    name: string,
    session: mongoose.ClientSession,
    budget: number,
  ): Promise<MetadataRow[]> {
    if (budget <= 0) return [];
    if (
      await db!
        .collection(name)
        .countDocuments(
          { $and: [filter, SOURCE_PRESENT, { $expr: { $ne: [{ $type: '$_id' }, 'objectId'] } }] },
          { session, limit: 1, maxTimeMS: remaining() },
        )
    )
      held();
    const after = cursors.get(name);
    return db!
      .collection(name)
      .aggregate<MetadataRow>(
        [
          {
            $match: { $and: [filter, SOURCE_PRESENT, ...(after ? [{ _id: { $gt: after } }] : [])] },
          },
          { $sort: { _id: 1 } },
          { $limit: BATCH_ROWS },
          { $project: { _id: 1, bytes: { $bsonSize: '$$ROOT' }, meta: projection } },
          { $set: { metadataBytes: { $add: [{ $bsonSize: '$$ROOT' }, 32] } } },
          {
            $setWindowFields: {
              sortBy: { _id: 1 },
              output: {
                cumulativeBytes: {
                  $sum: '$metadataBytes',
                  window: { documents: ['unbounded', 'current'] },
                },
                rowNumber: { $documentNumber: {} },
              },
            },
          },
          {
            $match: {
              $or: [
                { cumulativeBytes: { $lte: budget } },
                ...(budget === MAX_METADATA_BYTES
                  ? [{ rowNumber: 1 }]
                  : [{ rowNumber: 1, metadataBytes: { $gt: MAX_METADATA_BYTES } }]),
              ],
            },
          },
          {
            $project: {
              _id: 0,
              bytes: 1,
              metadataBytes: 1,
              meta: { $cond: [{ $lte: ['$cumulativeBytes', budget] }, '$meta', null] },
            },
          },
        ],
        { session, maxTimeMS: remaining(), allowDiskUse: false },
      )
      .toArray();
  }
  // Unrelated retained rows may span many batches; the monotonic deadline bounds this scan.
  for (;;) {
    // The ordinary path still works on standalone Mongo; no source metadata is read here.
    if (
      (
        await Promise.all(
          names.map((name) =>
            db
              .collection(name)
              .countDocuments(
                { $and: [filter, SOURCE_PRESENT] },
                { limit: 1, maxTimeMS: remaining() },
              ),
          ),
        )
      ).every((count) => count === 0)
    )
      return;
    const session = await mongoose.startSession();
    let finished = false;
    let exhausted = false;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        let checkpointDeleted = 0;
        let failure: unknown;
        try {
          await session.withTransaction(
            async () => {
              try {
                const loaded: Array<{ name: string; rows: MetadataRow[] }> = [];
                let budget = MAX_METADATA_BYTES;
                const advances = new Map<string, mongoose.mongo.ObjectId>();
                for (const name of names) {
                  const rows = await read(name, session, budget);
                  budget -= rows.reduce((total, row) => total + row.metadataBytes, 0);
                  if (
                    name === storage.checkpointCollectionName &&
                    rows.length > checkpointAllowance
                  )
                    held();
                  loaded.push({ name, rows });
                  if (
                    rows.length &&
                    rows[rows.length - 1].meta?._id instanceof mongoose.mongo.ObjectId
                  )
                    advances.set(name, rows[rows.length - 1].meta!._id);
                }
                const groups = new Map<
                  string,
                  { owner: { userId: string; tenantId: string | null }; bytes: Map<string, number> }
                >();
                for (const entry of loaded) {
                  const selected: MetadataRow[] = [];
                  for (const row of entry.rows) {
                    const { owner, allocation } = checkpointRowLiability(row);
                    if (
                      options.sourceFileIds &&
                      !row.meta!.lc_source_file_ids.some((id: string) =>
                        options.sourceFileIds!.includes(id),
                      )
                    ) {
                      continue;
                    }
                    selected.push(row);
                    const key = JSON.stringify(owner);
                    let group = groups.get(key);
                    if (!group) {
                      group = { owner, bytes: new Map() };
                      groups.set(key, group);
                    }
                    const bytes = (group.bytes.get(allocation.fileId) ?? 0) + allocation.bytes;
                    if (!Number.isSafeInteger(bytes)) held();
                    group.bytes.set(allocation.fileId, bytes);
                  }
                  entry.rows = selected;
                }
                exhausted = loaded.every(({ rows }) => rows.length === 0) && advances.size === 0;
                for (const { owner, bytes } of groups.values())
                  await resizeRetainedDerivatives(
                    mongoose,
                    owner,
                    [...bytes].map(([fileId, value]) => ({ fileId, bytes: value })),
                    [],
                    session,
                  );
                for (const { name, rows } of loaded) {
                  if (!rows.length) continue;
                  const result = await db
                    .collection(name)
                    .deleteMany(
                      { $and: [filter, { _id: { $in: rows.map((row) => row.meta!._id) } }] },
                      { session, maxTimeMS: remaining() },
                    );
                  if (result.deletedCount !== rows.length) held();
                  if (name === storage.checkpointCollectionName) checkpointDeleted = rows.length;
                }
                remaining();
                await session.commitTransaction();
                checkpointAllowance -= checkpointDeleted;
                for (const [name, last] of advances) cursors.set(name, last);
                finished = true;
              } catch (error) {
                failure = error;
                // Native CSOT bounds every joined operation; manual commit prevents unknown retries.
                throw new Error('Checkpoint source cleanup did not finish');
              }
            },
            {
              timeoutMS: remaining(),
              readConcern: { level: 'snapshot' },
              writeConcern: { w: 'majority' },
              maxCommitTimeMS: Math.min(2000, remaining()),
            },
          );
          break;
        } catch (caught) {
          const error = failure ?? caught;
          const labeled = error as { hasErrorLabel?: (label: string) => boolean };
          if (labeled.hasErrorLabel?.('UnknownTransactionCommitResult')) held();
          if (session.inTransaction())
            await session.abortTransaction({
              timeoutMS: Math.max(1, Math.min(1000, 10000 - (performance.now() - started))),
            });
          if (!labeled.hasErrorLabel?.('TransientTransactionError') || attempt === 1) throw error;
          remaining();
        }
      }
    } finally {
      await session.endSession();
    }
    if (!finished) held();
    if (exhausted) return;
  }
}
