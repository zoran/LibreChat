import type { Model } from 'mongoose';
import type { FileCleanupTargetRecord } from '../types/fileCleanup';

export const FILE_CLEANUP_TARGET_INDEXES: Readonly<{ identity: string; pending: string }> =
  Object.freeze({
    identity: 'file_cleanup_target_identity',
    pending: 'file_cleanup_target_pending_v2',
  });
/** Exact Generation identities and original receipts survive pending work indefinitely. No TTL. */
export function createFileCleanupTargetModel(
  mongoose: typeof import('mongoose'),
): Model<FileCleanupTargetRecord> {
  if (mongoose.models.FileCleanupTarget) return mongoose.models.FileCleanupTarget;
  const id = { type: String, required: true, maxlength: 256 };
  const schema = new mongoose.Schema<FileCleanupTargetRecord>(
    {
      _id: { type: String, required: true, maxlength: 64 },
      schema: { type: Number, required: true, enum: [1] },
      tenantId: { type: String, default: null, maxlength: 256 },
      ownerUserId: id,
      fileId: id,
      revocationId: id,
      kind: { type: String, required: true, enum: ['generation'] },
      targetIdentityHash: { type: String, required: true, maxlength: 64 },
      target: { type: mongoose.Schema.Types.Mixed, required: true, immutable: true },
      state: { type: String, required: true, enum: ['pending', 'unknown', 'settled'] },
      evidence: { type: mongoose.Schema.Types.Mixed, default: null },
      reason: { type: String, required: true, maxlength: 256 },
      createdAt: { type: Date, required: true },
      updatedAt: { type: Date, required: true },
      settledAt: { type: Date, default: null },
    },
    { versionKey: false, strict: 'throw', collection: 'file_cleanup_targets' },
  );
  schema.index(
    { revocationId: 1, kind: 1, targetIdentityHash: 1 },
    { unique: true, name: FILE_CLEANUP_TARGET_INDEXES.identity },
  );
  schema.index(
    { tenantId: 1, ownerUserId: 1, fileId: 1, revocationId: 1, state: 1, updatedAt: 1, _id: 1 },
    { name: FILE_CLEANUP_TARGET_INDEXES.pending },
  );
  return mongoose.model<FileCleanupTargetRecord>('FileCleanupTarget', schema);
}
