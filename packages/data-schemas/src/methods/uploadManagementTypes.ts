/** Public repository contract and private ports shared by the cohesive upload lifecycle owners. */
import type {
  UploadPrincipal,
  UploadReserveInput,
  UploadDerivedReserveInput,
  UploadDerivedBinding,
  UploadOperation,
  UploadUsage,
  UploadLease,
  UploadClaimInput,
  UploadStorageReceipt,
  UploadCleanupProof,
  UploadErrorCode,
  UploadMetricsSnapshot,
  UploadProcessingInput,
  UploadCleanupTask,
  UploadParserExecution,
  UploadWorker,
  UploadLocalReservations,
  UploadSecurityApproval,
  UploadSecurityExecution,
  UploadSecuritySettlement,
  UploadAcceptedMetadata,
  ManagedDocumentResult,
} from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { StoredUpload, GlobalState, UploadActivationMethods } from './uploadManagementStore';
import type { UploadMigrationMethods } from './uploadManagementMigration';
import type { UploadAdmissionMethods } from './uploadManagementAdmission';
import type { UploadControlMethods } from './uploadManagementControl';
import type { UploadIntakeMethods } from './uploadManagementIntake';
import { createUploadStore, storedUploadPrincipal } from './uploadManagementStore';
import { createFileRetentionMethods } from './fileRetention';
/** Upload repository contract and explicit internal composition ports. */
export type UploadManagementRepository = UploadControlMethods &
  UploadMigrationMethods &
  UploadAdmissionMethods &
  UploadIntakeMethods &
  UploadActivationMethods & {
    initialize(): Promise<void>;
    findReservation(
      principal: UploadPrincipal,
      key: string,
      fingerprint: string,
      now: number,
    ): Promise<UploadOperation | null>;
    reserve(
      principal: UploadPrincipal,
      input: UploadReserveInput,
      now: number,
    ): Promise<UploadOperation>;
    reserveDerived(
      principal: UploadPrincipal,
      input: UploadDerivedReserveInput,
      now: number,
    ): Promise<UploadOperation>;
    get(principal: UploadPrincipal, id: string, now: number): Promise<UploadOperation>;
    getDerivedOperation(
      principal: UploadPrincipal,
      id: string,
      expectedBinding: UploadDerivedBinding,
      now: number,
    ): Promise<UploadOperation>;
    list(principal: UploadPrincipal, now: number): Promise<UploadOperation[]>;
    usage(principal: UploadPrincipal, now: number): Promise<UploadUsage>;
    claim(input: UploadClaimInput): Promise<UploadLease | null>;
    renew(lease: UploadLease, now: number): Promise<UploadLease>;
    bindSecurityExecution(
      lease: UploadLease,
      execution: UploadSecurityExecution,
      now: number,
    ): Promise<void>;
    settleSecurityExecution(
      lease: UploadLease,
      settlement: UploadSecuritySettlement,
      now: number,
    ): Promise<void>;
    accept(
      principal: UploadPrincipal,
      lease: UploadLease,
      receipt: UploadStorageReceipt,
      securityApproval: UploadSecurityApproval,
      metadata: UploadAcceptedMetadata,
      now: number,
    ): Promise<UploadOperation>;
    publish(
      lease: UploadLease,
      result: ManagedDocumentResult & { writerStopped: true },
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
    metrics(now: number): Promise<UploadMetricsSnapshot>;
  };

/** Internal ports share the sole store, transaction and retention owners. */
/** Observational side effect participates in the caller's existing transaction. */
export type UploadPublicationPort = (
  input: { tenantId: string | null; operationId: string; publishedAtMs: number },
  session: ClientSession,
) => Promise<void>;

export interface UploadManagementContext {
  mongoose: typeof import('mongoose');
  store: ReturnType<typeof createUploadStore>;
  lifecycle: ReturnType<typeof createFileRetentionMethods>;
  securityPolicySha256?: string;
  principalOf: typeof storedUploadPrincipal;
  owned(principal: UploadPrincipal, id: string, session?: ClientSession): Promise<StoredUpload>;
  terminal(
    row: StoredUpload,
    global: GlobalState,
    state: StoredUpload['state'],
    code?: UploadErrorCode,
  ): void;
  cleanupTask(row: StoredUpload): UploadCleanupTask;
  usage(principal: UploadPrincipal, now: number, session?: ClientSession): Promise<UploadUsage>;
  recordOriginalPublication?: UploadPublicationPort;
}
