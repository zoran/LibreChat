import { Document, Types } from 'mongoose';
import type {
  FileLibraryMetadata,
  CodeEnvRef,
  CodeEnvRefMap,
  FileContext,
  RunFileProvenance,
  TFile,
  UploadSecurityApproval,
  UploadPrincipal,
  UploadStorageReceipt,
  DocumentStructure,
  ManagedRetrievalState,
  UploadDerivedOrigin,
} from 'librechat-data-provider';
import type { StoredFileRetentionActivity } from './fileActivity';
import type { FileCleanupProgress } from './fileCleanup';

/** One retained consumer's exact liability, committed alongside the existing File counter. */
export type RetainedTextAllocation = { fileId: string; bytes: number };

export type RunArtifactRunScope = {
  userId: string;
  tenantId?: string | null;
  conversationId: string;
  runId: string;
};

export type RunArtifactScope = RunArtifactRunScope & {
  executionId: string;
  agentId: string;
  sourceFileId: string;
};

export type RunArtifactFile = TFile & {
  conversationId: string;
  messageId?: string;
  expiredAt?: Date | null;
  previewRevision?: string;
  metadata: NonNullable<TFile['metadata']> & { runFile: RunFileProvenance };
};

export type RunArtifactContent = Pick<
  TFile,
  | 'filename'
  | 'filepath'
  | 'bytes'
  | 'type'
  | 'source'
  | 'storageKey'
  | 'storageRegion'
  | 'text'
  | 'textFormat'
  | 'width'
  | 'height'
  | 'status'
  | 'previewError'
  | 'llmDeliveryPath'
> & {
  messageId?: string;
  expiredAt?: Date | null;
  previewRevision?: string;
  metadata?: Omit<NonNullable<TFile['metadata']>, 'runFile'>;
};

export type CodeFileCommitData = Omit<
  RunArtifactContent,
  'text' | 'status' | 'previewError' | 'previewRevision'
> & {
  file_id: string;
  user: string;
  tenantId?: string;
  conversationId?: string;
  context?: FileContext;
  object?: 'file';
  embedded?: boolean;
  usage?: number;
  text?: string | null;
  status?: TFile['status'] | null;
  previewError?: string | null;
  previewRevision?: string | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
};

export type PublishRunArtifactInput = {
  scope: RunArtifactScope;
  file: RunArtifactContent;
  provenance: RunFileProvenance;
};

export type RunArtifactClaim = {
  file_id: string;
  file?: RunArtifactFile;
};

export type FileOwnerScope = {
  userId: string;
  tenantId?: string | null;
};

/** Selective current File observation; callers still fence all materialization dependencies. */
export type FileSourceInspection = Readonly<
  { fileId: string } & (
    | { state: 'managed'; sourceExpiresAt: Date; sourceBindingSha256: string }
    | { state: 'unmanaged'; sourceExpiresAt: Date | null }
    | { state: 'unavailable' }
  )
>;

export type FileRetentionAdmission = Readonly<{ acceptedAt: Date; expiredAt: Date }>;
/** Private stream receipt or exact pre-reserve intent; release refunds only the stored amount. */
export type FileSourceCopyReservation = {
  fileId: string;
  reservationId: string;
  bytes: number;
  state: 'held' | 'released';
};

/** Private managed File creation custody; only first retrieval admission advances it. */
export type FileRetrievalCreation = {
  version: 1;
  owner: { tenantId: string | null; userId: string };
  fileId: string;
  acceptedAt: number;
  state: 'empty' | 'admitted';
};

export interface IMongoFile extends Omit<Document, 'model'> {
  /** Private organization metadata. Absence is revision zero, without a backfill. */
  library?: FileLibraryMetadata;
  retentionAcceptedAt?: Date;
  retentionRevision?: number;
  /** Private successful activity summary and current deadline arithmetic. */
  retentionActivity?: StoredFileRetentionActivity;
  derivedRetention?: StoredDerivedFileRetention;
  retentionRevocationId?: string;
  retentionCleanup?: FileCleanupProgress;
  /** Includes liabilities whose Message has expired; released by this File's cleanup. */
  retainedDerivativeBytes?: number;
  retainedDerivativeReservations?: Array<Omit<FileSourceCopyReservation, 'fileId'>>;
  uploadOperationId?: string;
  /** Private immutable upload-owner proof; never part of TFile or client projections. */
  securityApproval?: UploadSecurityApproval;
  /** Private immutable source identities; ordinary File consumers must not expose drafts. */
  derivedOrigin?: UploadDerivedOrigin;
  /** Private derived structure, bound to the immutable accepted original and File lifecycle. */
  documentStructure?: DocumentStructure;
  /** Private File-owned index liabilities; never a client File projection. */
  managedRetrieval?: ManagedRetrievalState;
  retrievalCreation?: FileRetrievalCreation;
  deletionRequestedAt?: Date;
  deletionCompletedAt?: Date;
  user: Types.ObjectId;
  conversationId?: string;
  messageId?: string;
  file_id: string;
  temp_file_id?: string;
  bytes: number;
  text?: string;
  /**
   * Format of the `text` field — `'html'` when the backend produced
   * a sanitized full-document HTML preview (e.g. office types via
   * `bufferToOfficeHtml`), `'text'` for plain-text extracts (e.g.
   * RAG mammoth/pdf-parse output), `undefined` for legacy records
   * that pre-date the field. Clients MUST treat `undefined` as
   * `'text'` and refuse to inject the value into HTML contexts —
   * otherwise plain document text containing `<script>` tags would
   * become executable markup. See Codex P1 review on PR #12934.
   */
  textFormat?: 'html' | 'text';
  /**
   * Lifecycle of the inline preview rendered from `text`. Tracks the
   * deferred-preview code-execution flow (PR #12951 follow-up): the
   * immediate persist step saves the file blob and emits the attachment
   * record with `status: 'pending'`; a background render runs HTML
   * extraction and updates the record to `'ready'` (with `text` +
   * `textFormat`) or `'failed'` (with `previewError`). Decouples the
   * agent's final response from CPU-heavy office-format rendering.
   *
   * Absent for legacy records and for files that never expect a preview
   * (RAG uploads, images, plain-text artifacts). Clients MUST treat
   * `undefined` as `'ready'` so prior-version records render normally.
   */
  status?: 'pending' | 'ready' | 'failed';
  /**
   * Short machine-readable reason when `status === 'failed'` —
   * `'timeout'`, `'parser-error'`, `'oversized'`, `'orphaned'`. UI hint
   * for tooltip text; not user-facing prose. Absent otherwise.
   */
  previewError?: string;
  /**
   * Generation marker for the deferred-preview lifecycle. The
   * immediate persist step stamps a fresh UUID on every emit; the
   * deferred render's update only commits when the marker still
   * matches. Guards against an older render overwriting a newer
   * record on cross-turn filename reuse. Absent for legacy records
   * and for files that never expect a preview.
   */
  previewRevision?: string;
  filename: string;
  filepath: string;
  storageKey?: string;
  storageRegion?: string;
  object: 'file';
  embedded?: boolean;
  type: string;
  context?: string;
  usage: number;
  source: string;
  model?: string;
  width?: number;
  height?: number;
  metadata?: {
    runFile?: RunFileProvenance;
    /**
     * Code-environment cache pointer for files re-uploadable to
     * codeapi (chat attachments, agent tool resources, code-output
     * files). Carries the resource kind + identity so codeapi can
     * derive the sessionKey explicitly.
     */
    codeEnvRef?: CodeEnvRef;
    codeEnvRefs?: CodeEnvRefMap;
    /** Dispatch-order stamp for the current source artifact generation. */
    sourceDispatchedAt?: number;
    /** Vector namespaces this file has been embedded into. */
    embeddedEntities?: string[];
    /** The user named this destination, so absent ones were declined. */
    destinationChosen?: boolean;
    /** The type the delivery route was resolved against, when conversion changed it. */
    routingMimeType?: string;
  };
  /** Upload-time inference, not a durable contract. See the schema field for why. */
  llmDeliveryPath?: string;
  expiresAt?: Date;
  expiredAt?: Date | null;
  /**
   * Consecutive failed retention-sweep deletions. The sweep backs off
   * between attempts and parks the file once this reaches the configured
   * cap, so a file whose backing storage refuses deletion cannot occupy
   * the sweep's bounded queue. Absent until the first failure.
   */
  deletionAttempts?: number;
  /**
   * Earliest time the retention sweep may retry this file, and the only
   * thing holding it back. Set alongside `deletionAttempts` on every
   * failure; absent until the first one.
   */
  deletionRetryAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  tenantId?: string;
}

/** Derived retention projects parent constraints; it never counts user activity. */
export type StoredDerivedFileRetention = {
  version: 1;
  ownDeadlineAt: Date;
  capBasis: 'admission' | 'legacy-baseline';
  trackedSince: Date;
  deadlineGeneration: number;
  migrationEpoch?: string;
};

export type ManagedUploadAcceptance = {
  principal: UploadPrincipal;
  operationId: string;
  filename: string;
  mediaType: string;
  receipt: UploadStorageReceipt;
  transferGeneration: number;
  securityApproval: UploadSecurityApproval;
  derivedOrigin?: UploadDerivedOrigin;
  acceptedAt: number;
};
