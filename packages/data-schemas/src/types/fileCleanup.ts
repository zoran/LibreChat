import type {
  UploadWorker,
  StorageDeletionRequest,
  StorageDeletionBinding,
  StorageDeletionTerminalReceipt,
  StorageDeletionConsumptionResult,
} from 'librechat-data-provider';
import type {
  GenerationCleanupTarget,
  GenerationCleanupEvidence,
  GenerationCleanupPage,
  GenerationCleanupResult,
} from 'librechat-data-provider';
import type { JobClaim, JobPhase } from './housekeeping';

export interface MessageSourceCleanupCursor {
  version: 1;
  scopeSha256: string;
  phase: 'redact' | 'detach';
  after: string | null;
}

/** Private File custody. No target arrays or storage inventories live on File. */
export interface FileCleanupProgress {
  schema: 1;
  revocationId: string;
  jobId: string;
  executionId: string;
  capture: { cursor: string | null; complete: boolean; recoveryUnresolved: boolean };
  generationReceiptRef: string | null;
  /** Missing on generation-only custody; it never authorizes lifecycle effects/completion. */
  lifecycle?: FileLifecycleCustody;
}
export interface FileCleanupExpectation {
  fileRevision: number;
  jobRevision: number;
  phase: JobPhase;
  cursor: string | null;
}
export interface FileCleanupCapture {
  expected: FileCleanupExpectation;
  progress: FileCleanupProgress;
}
export type FileCleanupResult<T> =
  | ({ state: 'progress' } & T)
  | { state: 'lost' | 'unknown' }
  | { state: 'pending'; reason: string };
export type FileCleanupProgressResult = FileCleanupResult<FileCleanupCapture>;
export type FileCleanupCaptureObservation = FileCleanupProgressResult;
export interface FileCleanupTargetRecord {
  _id: string;
  schema: 1;
  tenantId: string | null;
  ownerUserId: string;
  fileId: string;
  revocationId: string;
  kind: 'generation';
  targetIdentityHash: string;
  target: GenerationCleanupTarget;
  state: 'pending' | 'unknown' | 'settled';
  evidence: GenerationCleanupEvidence | null;
  reason: string;
  createdAt: Date;
  updatedAt: Date;
  settledAt: Date | null;
}
export type FileCleanupTargetPage = FileCleanupResult<
  FileCleanupCapture & {
    targets: ReadonlyArray<{ id: string; target: GenerationCleanupTarget }>;
    cursor: string | null;
  }
>;
/** Trusted owner composition only; no session/model escapes to the public worker. */
export interface FileCleanupProgressMethods {
  initialize(): Promise<void>;
  beginCapture(claim: JobClaim, signal: AbortSignal): Promise<FileCleanupProgressResult>;
  readCapture(claim: JobClaim, signal: AbortSignal): Promise<FileCleanupCaptureObservation>;
  recordCapturePage(
    claim: JobClaim,
    expected: FileCleanupExpectation,
    page: GenerationCleanupPage,
    signal: AbortSignal,
  ): Promise<FileCleanupProgressResult>;
  readPendingTargets(
    claim: JobClaim,
    signal: AbortSignal,
    after?: string,
  ): Promise<FileCleanupTargetPage>;
  recordGenerationResult(
    claim: JobClaim,
    expected: FileCleanupExpectation,
    targetId: string,
    result: GenerationCleanupResult,
    signal: AbortSignal,
  ): Promise<FileCleanupProgressResult>;
  finishGenerationStage(
    claim: JobClaim,
    expected: FileCleanupExpectation,
    signal: AbortSignal,
  ): Promise<FileCleanupProgressResult>;
}

/** File-owned accepted-original custody; Upload owns identity/actor/accounting validation. */
export interface FileUploadCleanupBinding {
  tenantId: string | null;
  userId: string;
  fileId: string;
  operationId: string;
  /** Upload's current terminal cleanup generation, distinct from both identities below. */
  cleanupGeneration: number;
  /** Immutable object generation used by the canonical original key and storage protocol. */
  attemptGeneration: number;
  workerGeneration: number | null;
  worker: UploadWorker | null;
  promotion: { promotionId: string; generation: number; worker: UploadWorker } | null;
  originalKey: string;
  originalSource: string;
  originalBytes: number;
  /** Hash of Upload's immutable actual original receipt and exact principal/op/attempt/key. */
  acceptedObjectSHA256: string;
}

/** Created and retained once by the Upload owner after checking actual File custody. */
export interface FileUploadCleanupAcknowledgment {
  reference: string;
  operationId: string;
  cleanupGeneration: number;
  attemptGeneration: number;
  revocationId: string;
  receiptSHA256: string;
}

type FileStorageRequest = Omit<StorageDeletionRequest, 'obligationId'>;
type FileStorageTerminal = {
  request: FileStorageRequest;
  binding: StorageDeletionBinding;
  receipt: StorageDeletionTerminalReceipt;
  receiptSHA256: string;
};
type FileStorageLocalCommit = FileStorageTerminal & {
  uploadAck: FileUploadCleanupAcknowledgment;
  consumerCommitId: string;
};
/** One monotonic custody record. Unknown observations never erase a known obligation/receipt. */
export type FileStorageCleanupCustody =
  | { state: 'binding'; request: FileStorageRequest }
  | {
      state: 'observing';
      request: FileStorageRequest;
      binding: StorageDeletionBinding;
      obligationId: string | null;
      lastState: 'pending' | 'namespace_absent' | 'unknown' | null;
    }
  | (FileStorageTerminal & { state: 'terminal' })
  | (FileStorageLocalCommit & { state: 'committed' })
  | (FileStorageLocalCommit & {
      state: 'consumed';
      consumption: Extract<StorageDeletionConsumptionResult, { state: 'recorded' }>;
    });

/** Bounded owner progress, not client-submitted proof or a physical inventory. */
export interface FileLifecycleCustody {
  upload: FileUploadCleanupBinding;
  derivatives: {
    retrieval: 'pending' | 'complete';
    checkpoints: 'pending' | 'complete';
    /** Bound by the Message owner to canonical tenant/user/this File's source scope. */
    messageCursor: MessageSourceCleanupCursor | null;
    messages: 'pending' | 'complete';
  };
  storage: FileStorageCleanupCustody | null;
  /** Set only with the existing File preparation/accounting/descendant guard transaction. */
  contentPrepared: boolean;
  completionRef: string | null;
}

/** Tenant/user-scoped observation; only the retained owner join can report complete. */
export type FileCleanupCompletionObservation =
  | { fileId: string; state: 'complete'; completionRef: string }
  | { fileId: string; state: 'pending' | 'unknown' };
export type FileCleanupCompletionOptions = Readonly<{
  deadlineAt: number;
  signal: AbortSignal;
}>;
