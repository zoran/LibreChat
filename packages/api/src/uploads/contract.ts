/** Upload domain ports. Adapters own credentials, storage engines, processes and transports. */
import type {
  UploadPrincipal,
  UploadScope,
  UploadReserveInput,
  UploadOperation,
  UploadUsage,
  UploadLease,
  UploadClaimInput,
  UploadStorageReceipt,
  UploadCleanupProof,
  UploadErrorCode,
  UploadControllerLease,
  UploadControlPolicy,
  UploadByteLease,
  UploadMetricsSnapshot,
  UploadMigrationPage,
  UploadProcessingInput,
  UploadCleanupTask,
  UploadParserExecution,
  UploadWorker,
  UploadMigrationReceipt,
  UploadResourceTotals,
  UploadReconciliationSnapshot,
  UploadActivationProof,
  UploadLocalReservations,
  UploadOriginalIntegrity,
  UploadAdmissionPolicy,
  UploadAdmissionCommand,
} from 'librechat-data-provider';

export interface IdentityPort {
  authorize(principal: UploadPrincipal, scope: UploadScope): Promise<boolean>;
}
export interface ResourcePort {
  assertSafe(input: {
    phase: 'admission' | 'transfer' | 'processing';
    hostId?: string;
    lease?: UploadLease;
  }): Promise<void>;
}
export interface TelemetryPort {
  /** Advisory response observations, never an exactly-once ledger or an authority. */
  transition(state: UploadOperation['state']): void | Promise<void>;
  retry(reason: 'processing'): void | Promise<void>;
  /** The repository exposes coarse public rejection categories, not individual storage pools. */
  rejectQuota(reason: 'window' | 'queue' | 'capacity'): void | Promise<void>;
}
export interface StoragePort {
  put(input: {
    lease: UploadLease;
    filename: string;
    mediaType: string;
    bytes: number;
    integrity: UploadOriginalIntegrity;
    body: AsyncIterable<Uint8Array>;
    signal: AbortSignal;
  }): Promise<UploadStorageReceipt>;
  read(input: { original: UploadStorageReceipt; signal: AbortSignal }): AsyncIterable<Uint8Array>;
  remove(input: {
    operationId: string;
    generation: number;
    tenantId: string | null;
    userId: string;
    signal: AbortSignal;
  }): Promise<'absent' | 'unknown'>;
}
export interface DocumentPort {
  prepare(input: {
    attemptId: string;
    mediaType: string;
    signal: AbortSignal;
  }): Promise<UploadParserExecution>;
  extract(input: {
    execution: UploadParserExecution;
    signal: AbortSignal;
  }): Promise<{ text: string; writerStopped: true }>;
  cancel(input: {
    execution: UploadParserExecution;
    signal: AbortSignal;
  }): Promise<{ writerStopped: boolean }>;
}
export type UploadAttemptSettlement = {
  /** Includes remote storage writers, not merely the local HTTP/SDK promise. */
  writerStopped: boolean;
  localCopiesAbsent: boolean;
  storageOutcome?: 'not_started' | 'absent' | 'durable' | 'unknown';
};
export type UploadAttemptRegistration = {
  bind(lease: UploadLease): void;
  settle(proof: UploadAttemptSettlement): void;
};
export type UploadAttemptPort = {
  /** Register before any asynchronous claim, then bind before any attempt I/O. */
  begin(abort: () => void): UploadAttemptRegistration;
  stopAndJoin(
    task: Pick<UploadCleanupTask, 'operationId' | 'generation' | 'worker'>,
    signal: AbortSignal,
  ): Promise<UploadAttemptSettlement>;
  recordCleanup(
    task: Pick<UploadCleanupTask, 'operationId' | 'generation' | 'worker'>,
    proof: UploadAttemptSettlement,
  ): void;
};
export interface UploadRepository {
  initialize(): Promise<void>;
  /** Private operator port: reads never initialize; mutation retains its original deadline. */
  getAdmissionPolicy(): Promise<UploadAdmissionPolicy>;
  setAdmissionPolicy(command: UploadAdmissionCommand): Promise<UploadAdmissionPolicy>;
  reconciliationSnapshot(now: number): Promise<UploadReconciliationSnapshot>;
  activateReconciled(proof: UploadActivationProof, now: number): Promise<void>;
  findReservation(
    principal: UploadPrincipal,
    key: string,
    fingerprint: string,
    now: number,
  ): Promise<UploadOperation | null>;
  reserve(
    principal: UploadPrincipal,
    request: UploadReserveInput,
    now: number,
  ): Promise<UploadOperation>;
  get(principal: UploadPrincipal, id: string, now: number): Promise<UploadOperation>;
  list(principal: UploadPrincipal, now: number): Promise<UploadOperation[]>;
  usage(principal: UploadPrincipal, now: number): Promise<UploadUsage>;
  claim(input: UploadClaimInput): Promise<UploadLease | null>;
  renew(lease: UploadLease, now: number): Promise<UploadLease>;
  accept(
    principal: UploadPrincipal,
    lease: UploadLease,
    receipt: UploadStorageReceipt,
    now: number,
  ): Promise<UploadOperation>;
  publish(
    lease: UploadLease,
    result: { text: string; writerStopped: true },
    now: number,
  ): Promise<UploadOperation>;
  cancel(principal: UploadPrincipal, id: string, now: number): Promise<UploadOperation>;
  delete(principal: UploadPrincipal, id: string, now: number): Promise<UploadOperation>;
  retryProcessing(principal: UploadPrincipal, id: string, now: number): Promise<UploadOperation>;
  fail(lease: UploadLease, code: UploadErrorCode, now: number): Promise<UploadOperation>;
  confirmCleanup(proof: UploadCleanupProof, now: number): Promise<UploadOperation>;
  reconcile(now: number, limit?: number): Promise<UploadOperation[]>;
  getProcessingInput(lease: UploadLease, now: number): Promise<UploadProcessingInput>;
  bindProcessingExecution(
    lease: UploadLease,
    execution: UploadParserExecution,
    now: number,
  ): Promise<void>;
  cleanupTasks(limit?: number): Promise<UploadCleanupTask[]>;
  cleanupForFile(
    owner: { tenantId: string | null; userId: string },
    fileId: string,
  ): Promise<UploadCleanupTask | null>;
  activeWorkers(): Promise<UploadWorker[]>;
  localReservations(worker: UploadWorker, now: number): Promise<UploadLocalReservations>;
  watchChanges(input: {
    tenantId: string;
    includeGuests?: boolean;
    onChanged: (principal: { tenantId: string | null; userId: string }) => void;
    onReset: () => void;
  }): () => void;
  claimController(input: { ownerId: string; now: number }): Promise<UploadControllerLease | null>;
  renewController(input: {
    lease: UploadControllerLease;
    now: number;
  }): Promise<UploadControllerLease | null>;
  publishControl(
    input: UploadControlPolicy & { lease: UploadControllerLease; now: number },
  ): Promise<boolean>;
  claimWorkBytes(input: {
    lease: UploadLease;
    requestedBytes: number;
    now: number;
  }): Promise<UploadByteLease | null>;
  completeWorkBytes(input: { lease: UploadLease; generation: number; now: number }): Promise<void>;
  metrics(now: number): Promise<UploadMetricsSnapshot>;
  exportSnapshot(input: {
    epoch: string;
    cursor?: string;
    limit?: number;
  }): Promise<UploadMigrationPage>;
  importSnapshot(page: UploadMigrationPage): Promise<void>;
  completeExport(epoch: string): Promise<UploadMigrationReceipt>;
  completeImport(input: {
    receipt: UploadMigrationReceipt;
    baseline: UploadResourceTotals;
    lifecycleReconciled: true;
  }): Promise<void>;
}
