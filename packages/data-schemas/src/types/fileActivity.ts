/** File-owned activity and finite read ports; public callers never receive Mongo objects. */
import type {
  ManagedFileReadTicket,
  ManagedFileReadRepresentation,
  ManagedFileReadReference,
  UploadPrincipal,
  UploadWorker,
} from 'librechat-data-provider';

export type FileActivitySubject = Readonly<{
  tenantId: string | null;
  ownerUserId: string;
  fileId: string;
}>;

/** Values count either the complete lifetime or precisely the stated tracked interval. */
export type FileActivityCount =
  | Readonly<{ known: true; value: number; coverage: 'complete' }>
  | Readonly<{ known: true; value: number; coverage: 'since'; since: string }>
  | Readonly<{ known: false }>;

export type FileActivityInactivity =
  | Readonly<{
      known: true;
      since: string;
      fullDays: number;
      basis: 'successful-use' | 'upload';
    }>
  | Readonly<{ known: false }>;

/** FileNotice and the existing mail presentation are structural projections of this owner DTO. */
export type FileActivitySnapshot = Readonly<{
  subject: FileActivitySubject;
  filename: string;
  acceptedAt: string | null;
  deadlineAt: string;
  deadlineGeneration: number;
  lastSuccessfulReadAt: string | null;
  lastReadKnown: boolean;
  lastSuccessfulProcessingAt: string | null;
  readCount: FileActivityCount;
  processingCount: FileActivityCount;
  inactivity: FileActivityInactivity;
}>;

/** The owner captures one observation instant for the complete bounded batch. */
export type FileActivitySnapshotBatch = Readonly<{
  asOf: string;
  files: readonly FileActivitySnapshot[];
}>;

/** Public API callers never receive a database session, model, document or query. */
export type ManagedFileReadClaim = Readonly<{
  version: 1;
  readKey: string;
  claimId: string;
  fence: number;
  worker: Readonly<UploadWorker>;
  fileId: string;
  representation: ManagedFileReadRepresentation;
  sourceBindingSha256: string;
  notAfter: string;
  leaseUntil: string;
}>;

/** Issued only by the trusted server adapter after full verified/serialized source acquisition. */
export type ManagedFileReadEvidence = Readonly<{
  version: 1;
  representation: ManagedFileReadRepresentation;
  sourceBindingSha256: string;
  contentSha256: string;
  verifiedBytes: number;
}>;

export type ManagedFileReadCompletion =
  | Readonly<{ status: 'completed'; firstCompletion: boolean; completedAt: string }>
  | Readonly<{ status: 'unknown' }>
  | Readonly<{
      status: 'refused';
      reason: 'expired' | 'revoked' | 'lease_lost' | 'source_changed' | 'not_found';
    }>;

export type ManagedFileReadInspection =
  | Readonly<{ status: 'admitted'; notAfter: string }>
  | Readonly<{ status: 'reading'; notAfter: string; retryAfterMs: 1000 }>
  | Readonly<{ status: 'completed'; notAfter: string; completedAt: string }>
  | Readonly<{ status: 'unknown'; retryAfterMs: 1000 }>
  | Readonly<{
      status: 'refused';
      reason: 'expired' | 'revoked' | 'source_changed' | 'not_found';
    }>;

export type ManagedFileReadAbandonment =
  | Readonly<{ status: 'released' }>
  | Readonly<{ status: 'completed'; completedAt: string }>
  | Readonly<{ status: 'unknown' }>
  | Readonly<{
      status: 'refused';
      reason: 'expired' | 'lease_lost' | 'not_found';
    }>;

/** Every route obtains its principal again from the existing authenticated source owner. */
export interface FileReadRepository {
  admitManagedFileRead(
    principal: UploadPrincipal,
    input: Readonly<{ fileId: string; representation: ManagedFileReadRepresentation }>,
  ): Promise<ManagedFileReadTicket>;
  claimManagedFileRead(
    principal: UploadPrincipal,
    ticket: ManagedFileReadReference,
    worker: Readonly<UploadWorker>,
    previousClaim?: ManagedFileReadClaim,
  ): Promise<ManagedFileReadClaim>;
  completeManagedFileRead(
    principal: UploadPrincipal,
    claim: ManagedFileReadClaim,
    evidence: ManagedFileReadEvidence,
  ): Promise<ManagedFileReadCompletion>;
  inspectManagedFileRead(
    principal: UploadPrincipal,
    ticket: ManagedFileReadReference,
  ): Promise<ManagedFileReadInspection>;
  abandonManagedFileRead(
    principal: UploadPrincipal,
    claim: ManagedFileReadClaim,
    input: Readonly<{ reason: 'aborted' | 'read_failed' }>,
  ): Promise<ManagedFileReadAbandonment>;
}

/** Private stored File value; plain Date fields describe Mongo representation, not a public wire DTO. */
export type StoredFileRetentionActivity = {
  version: 1;
  baselineDeadlineAt: Date;
  trackedSince: Date;
  historyConfidence: 'complete' | 'since-tracking';
  readCount: number;
  processingCount: number;
  lastSuccessfulReadAt?: Date;
  lastSuccessfulProcessingAt?: Date;
  deadlineGeneration: number;
  /** Existing export/migration owner sets this fence before reading a frozen File/Upload pair. */
  migrationEpoch?: string;
};

/** Private finite File-owned event evidence; no raw read capability is stored. */
export type StoredFileReadReceipt = {
  _id: string;
  version: 1;
  tenantId: string | null;
  userId: string;
  fileId: string;
  representation: ManagedFileReadRepresentation;
  admittedAt: Date;
  notAfter: Date;
  sourceBindingSha256: string;
  originalSha256: string;
  originalBytes: number;
  fence: number;
  claim?: {
    claimId: string;
    fence: number;
    worker: UploadWorker;
    leaseUntil: Date;
  };
  /** Immutable after first committed completion; a later materialization claim cannot reset it. */
  completion?: {
    claimId: string;
    fence: number;
    completedAt: Date;
    contentSha256: string;
    verifiedBytes: number;
    deadlineGeneration: number;
    deadlineAt: Date;
  };
};

/** Private File-to-Upload transition result, returned inside their existing shared transaction. */
export type FilePublicationActivityResult = Readonly<{
  expiredAtMs: number;
  deadlineGeneration: number;
}>;
