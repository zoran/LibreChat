import type { Model } from 'mongoose';
import type {
  DocumentWorkspaceRecord,
  DocumentWorkspaceRevisionRecord,
} from '~/types/documentWorkspace';
import { applyTenantIsolation } from './plugins/tenantIsolation';
import {
  documentWorkspaceSchema,
  documentWorkspaceRevisionSchema,
} from '~/schema/documentWorkspace';

export function createDocumentWorkspaceModel(
  mongoose: typeof import('mongoose'),
): Model<DocumentWorkspaceRecord> {
  applyTenantIsolation(documentWorkspaceSchema);
  return (
    mongoose.models.DocumentWorkspace ||
    mongoose.model<DocumentWorkspaceRecord>(
      'DocumentWorkspace',
      documentWorkspaceSchema,
      'documentworkspaces',
    )
  );
}

export function createDocumentWorkspaceRevisionModel(
  mongoose: typeof import('mongoose'),
): Model<DocumentWorkspaceRevisionRecord> {
  applyTenantIsolation(documentWorkspaceRevisionSchema);
  return (
    mongoose.models.DocumentWorkspaceRevision ||
    mongoose.model<DocumentWorkspaceRevisionRecord>(
      'DocumentWorkspaceRevision',
      documentWorkspaceRevisionSchema,
      'documentworkspacerevisions',
    )
  );
}
