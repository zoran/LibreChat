/** Private bounded raw source selection; the caller owns admission, source fences and commit. */
import mongoose from 'mongoose';
import {
  snapshotGenerationCheckpointAdmission,
  snapshotCheckpointSourceBinding,
} from '@librechat/data-schemas';
import type {
  CheckpointSourceBinding,
  GenerationAdmissionInput,
  GenerationCheckpointRecoverySource,
} from '@librechat/data-schemas';
import type { CheckpointRow, WriteRow } from './saver';
import {
  checkpointOwnerNamespacePrefix,
  checkpointNamespaceBelongsToOwner,
} from '../../stream/checkpoints';
import { checkpointRowLiability } from './source-retention';

type RawRow<T> = { row: T | null; bytes: number };

/** Bootstrap candidate metadata only. The enclosing recovery transaction owns authority. */
export async function readCheckpointRecoverySource(
  input: {
    checkpointCollectionName: string;
    maxBsonBytes: number;
    predecessor: GenerationAdmissionInput;
  },
  session: mongoose.ClientSession,
): Promise<GenerationCheckpointRecoverySource> {
  if (!session.inTransaction() || session.hasEnded)
    throw new Error('Recovery requires a transaction');
  const prior = snapshotGenerationCheckpointAdmission(input.predecessor);
  const owner = {
    userId: prior.principalId,
    tenantId: prior.tenantId === '__single_tenant__' ? null : prior.tenantId,
  };
  const prefix = checkpointOwnerNamespacePrefix(owner.userId, owner.tenantId ?? undefined);
  if (
    !prior.continuation!.sourceBindingSha256 ||
    !checkpointNamespaceBelongsToOwner(
      prior.continuation!.checkpointNamespace,
      owner.userId,
      owner.tenantId ?? undefined,
    )
  )
    throw new Error('Invalid recovery scope');
  const db = mongoose.connection.db;
  if (!db) throw new Error('Checkpoint database is unavailable');
  const options = { session, collation: { locale: 'simple' }, maxTimeMS: 5000 };
  const query = {
    thread_id: `${prefix}${prior.conversationId}`,
    checkpoint_ns: `${prefix}${prior.continuation!.checkpointNamespace}`,
  };
  const fields = Object.fromEntries(
    [
      '_id',
      'thread_id',
      'checkpoint_ns',
      'checkpoint_id',
      'lc_owner',
      'upserted_at',
      'lc_source_binding',
      'lc_source_file_ids',
      'lc_source_expires_at',
      'lc_retained_allocations',
    ].map((field) => [field, `$${field}`]),
  );
  const [selected] = await db
    .collection(input.checkpointCollectionName)
    .aggregate<{
      meta: mongoose.mongo.Document | null;
      bytes: number;
      metadataBytes: number;
    }>(
      [
        { $match: query },
        // Choose the head BEFORE validating markers, hash or expiry. Never fall back to older rows.
        { $sort: { checkpoint_id: -1 } },
        { $limit: 1 },
        { $project: { _id: 0, bytes: { $bsonSize: '$$ROOT' }, meta: fields } },
        {
          $project: {
            _id: 0,
            bytes: 1,
            metadataBytes: { $bsonSize: '$meta' },
            meta: {
              $cond: [
                {
                  $and: [
                    { $lte: ['$bytes', input.maxBsonBytes] },
                    { $lte: [{ $bsonSize: '$meta' }, 65536] },
                  ],
                },
                '$meta',
                null,
              ],
            },
          },
        },
      ],
      options,
    )
    .toArray();
  if (
    !selected?.meta ||
    !Number.isSafeInteger(selected.bytes) ||
    selected.bytes <= 0 ||
    selected.bytes > input.maxBsonBytes ||
    !Number.isSafeInteger(selected.metadataBytes) ||
    selected.metadataBytes > 65536
  )
    throw new Error('Source recovery metadata unavailable');
  const meta = selected.meta;
  if (
    meta.lc_owner !== prefix ||
    typeof meta.checkpoint_id !== 'string' ||
    !meta.checkpoint_id.length ||
    meta.checkpoint_id.length > 4096 ||
    Array.from(meta.checkpoint_id).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new Error('Invalid recovery checkpoint slot');
  if (
    (await db
      .collection(input.checkpointCollectionName)
      .countDocuments(
        { ...query, checkpoint_id: meta.checkpoint_id },
        { ...options, limit: 2 },
      )) !== 1
  )
    throw new Error('Ambiguous recovery checkpoint slot');
  const liability = checkpointRowLiability(selected);
  const binding = snapshotCheckpointSourceBinding(owner, liability.binding);
  const expiresAt = Math.min(Date.parse(binding.expiresAt), meta.lc_source_expires_at.getTime());
  if (binding.bindingSha256 !== prior.continuation!.sourceBindingSha256 || expiresAt <= Date.now())
    throw new Error('Source recovery binding unavailable');
  return Object.freeze({
    sourceBinding: binding,
    expiresAt,
    checkpoint: Object.freeze({
      threadId: prior.conversationId,
      checkpointId: meta.checkpoint_id as string,
      checkpointNs: '' as const,
    }),
  });
}

/** Read one complete tuple or reject it: never truncate pending rows or the BSON budget. */
export async function readCheckpointSourceTuple(
  input: {
    checkpointCollectionName: string;
    checkpointWritesCollectionName: string;
    query: mongoose.mongo.Filter<mongoose.mongo.Document>;
    binding: CheckpointSourceBinding;
    maxBsonBytes: number;
  },
  session: mongoose.ClientSession,
): Promise<{ checkpoint: CheckpointRow; pending: WriteRow[]; expiresAt: number } | undefined> {
  if (!session.inTransaction() || session.hasEnded)
    throw new Error('Source reads require a transaction');
  const db = mongoose.connection.db;
  if (!db) throw new Error('Checkpoint database is unavailable');
  const options = { session, collation: { locale: 'simple' }, maxTimeMS: 5000 };
  let expiresAt = Date.parse(input.binding.expiresAt);
  const validate = <T extends CheckpointRow | WriteRow>(envelope: RawRow<T>): T => {
    if (!envelope.row || !Number.isSafeInteger(envelope.bytes) || envelope.bytes <= 0)
      throw new Error('Source checkpoint tuple exceeds its read budget');
    const row = envelope.row as T & mongoose.mongo.Document;
    const liability = checkpointRowLiability({
      meta: row,
      bytes: envelope.bytes,
      metadataBytes: 0,
    });
    if (liability.binding.bindingSha256 !== input.binding.bindingSha256)
      throw new Error('Source checkpoint binding mismatch');
    expiresAt = Math.min(expiresAt, row.lc_source_expires_at.getTime());
    if (expiresAt <= Date.now()) throw new Error('Source checkpoint tuple expired');
    return row;
  };
  const [selected] = await db
    .collection(input.checkpointCollectionName)
    .aggregate<RawRow<CheckpointRow>>(
      [
        { $match: input.query },
        { $sort: { checkpoint_id: -1 } },
        { $limit: 1 },
        {
          $project: {
            _id: 0,
            bytes: { $bsonSize: '$$ROOT' },
            row: {
              $cond: [{ $lte: [{ $bsonSize: '$$ROOT' }, input.maxBsonBytes] }, '$$ROOT', null],
            },
          },
        },
      ],
      options,
    )
    .toArray();
  if (!selected) return undefined;
  const checkpoint = validate(selected);
  const slot = {
    thread_id: checkpoint.thread_id,
    checkpoint_ns: checkpoint.checkpoint_ns,
    checkpoint_id: checkpoint.checkpoint_id,
  };
  if (
    (await db
      .collection(input.checkpointCollectionName)
      .countDocuments(slot, { ...options, limit: 2 })) !== 1
  )
    throw new Error('Ambiguous source checkpoint slot');
  // Inspect only bounded size metadata first, including malformed historical identifiers.
  // No pending payload is fetched or sorted until the complete snapshot fits.
  const sizes = await db
    .collection(input.checkpointWritesCollectionName)
    .aggregate<{ _id: mongoose.mongo.ObjectId | null; bytes: number }>(
      [
        { $match: slot },
        { $limit: 1025 },
        {
          $project: {
            _id: { $cond: [{ $eq: [{ $type: '$_id' }, 'objectId'] }, '$_id', null] },
            bytes: { $bsonSize: '$$ROOT' },
          },
        },
      ],
      options,
    )
    .toArray();
  if (sizes.length > 1024) throw new Error('Source checkpoint tuple exceeds 1024 pending rows');
  let totalBytes = selected.bytes;
  const bytesById = new Map<string, number>();
  for (const size of sizes) {
    if (
      !(size._id instanceof mongoose.mongo.ObjectId) ||
      !Number.isSafeInteger(size.bytes) ||
      size.bytes <= 0
    )
      throw new Error('Invalid source pending size metadata');
    totalBytes += size.bytes;
    if (totalBytes > input.maxBsonBytes)
      throw new Error('Source checkpoint tuple exceeds its read budget');
    bytesById.set(size._id.toHexString(), size.bytes);
  }
  const rows = await db
    .collection<WriteRow>(input.checkpointWritesCollectionName)
    .find(slot, { ...options, sort: { _id: 1 } })
    .toArray();
  if (rows.length !== sizes.length) throw new Error('Source checkpoint snapshot mismatch');
  const pending = rows.map((row) =>
    validate({ row, bytes: bytesById.get(row._id.toHexString()) ?? 0 }),
  );
  const slots = new Set(pending.map((row) => JSON.stringify([row.task_id, row.idx])));
  if (slots.size !== pending.length) throw new Error('Ambiguous source pending slot');
  if (expiresAt <= Date.now()) throw new Error('Source checkpoint tuple expired');
  return { checkpoint, pending, expiresAt };
}
