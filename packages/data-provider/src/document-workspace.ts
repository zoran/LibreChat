/** Public Workspace metadata. Content remains in an independently approved native File version. */
export type DocumentWorkspaceFormat = 'text' | 'markdown';

export type DocumentWorkspace = {
  workspaceId: string;
  title: string;
  format: DocumentWorkspaceFormat;
  revision: number;
  headFileId: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
};

export type DocumentWorkspaceVersion = {
  workspaceId: string;
  revision: number;
  fileId: string;
  createdAt: string;
  expiresAt: string;
};

export type DocumentWorkspaceErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'revision_conflict'
  | 'source_unavailable'
  | 'quota_exceeded'
  | 'unavailable';
