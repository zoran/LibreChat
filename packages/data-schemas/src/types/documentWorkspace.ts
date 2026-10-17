import type { DocumentWorkspaceFormat, UploadDerivedBinding } from 'librechat-data-provider';
import type { CapturedMessageArtifactSource } from './message';

/** No content, preview, model output or security decision is persisted in these metadata rows. */
export type DocumentWorkspaceRecord = {
  workspaceId: string;
  user: string;
  tenantId: string | null;
  title: string;
  format: DocumentWorkspaceFormat;
  revision: number;
  headFileId: string | null;
  initialSourceFileIds: string[];
  origin?: CapturedMessageArtifactSource['anchor'];
  accessRevision: number;
  createdAt: Date;
  updatedAt: Date;
};

export type DocumentWorkspaceRevisionRecord = {
  workspaceId: string;
  user: string;
  tenantId: string | null;
  revision: number;
  fileId: string;
  binding: UploadDerivedBinding;
  createdAt: Date;
};
