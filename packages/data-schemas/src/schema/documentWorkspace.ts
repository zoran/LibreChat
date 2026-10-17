import { Schema } from 'mongoose';
import type {
  DocumentWorkspaceRecord,
  DocumentWorkspaceRevisionRecord,
} from '~/types/documentWorkspace';

export const documentWorkspaceSchema: Schema<DocumentWorkspaceRecord> =
  new Schema<DocumentWorkspaceRecord>(
    {
      workspaceId: { type: String, required: true, immutable: true },
      user: { type: String, required: true, immutable: true },
      tenantId: { type: String, default: null, immutable: true },
      title: { type: String, required: true, maxlength: 100 },
      format: { type: String, enum: ['text', 'markdown'], required: true, immutable: true },
      revision: { type: Number, required: true, min: 0 },
      headFileId: { type: String, default: null },
      initialSourceFileIds: { type: [String], default: [], select: false, immutable: true },
      origin: { type: Schema.Types.Mixed, select: false, immutable: true },
      accessRevision: { type: Number, required: true, default: 0, select: false },
      createdAt: { type: Date, required: true, immutable: true },
      updatedAt: { type: Date, required: true },
    },
    { strict: 'throw', versionKey: false },
  );
documentWorkspaceSchema.index({ tenantId: 1, user: 1, workspaceId: 1 }, { unique: true });
documentWorkspaceSchema.index({ tenantId: 1, user: 1, updatedAt: -1, workspaceId: 1 });

export const documentWorkspaceRevisionSchema: Schema<DocumentWorkspaceRevisionRecord> =
  new Schema<DocumentWorkspaceRevisionRecord>(
    {
      workspaceId: { type: String, required: true, immutable: true },
      user: { type: String, required: true, immutable: true },
      tenantId: { type: String, default: null, immutable: true },
      revision: { type: Number, required: true, min: 1, immutable: true },
      fileId: { type: String, required: true, immutable: true },
      binding: { type: Schema.Types.Mixed, required: true, immutable: true },
      createdAt: { type: Date, required: true, immutable: true },
    },
    { strict: 'throw', versionKey: false },
  );
documentWorkspaceRevisionSchema.index(
  { tenantId: 1, user: 1, workspaceId: 1, revision: 1 },
  { unique: true },
);
documentWorkspaceRevisionSchema.index({ tenantId: 1, user: 1, fileId: 1 }, { unique: true });
