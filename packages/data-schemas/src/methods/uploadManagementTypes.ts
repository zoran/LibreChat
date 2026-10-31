import type { UploadCleanupReceiptMethods } from './uploadCleanupReceipts';
import type { UploadWriteMethods } from './uploadManagementWriteTypes';
import type { UploadNasMethods } from './uploadManagementNasTypes';
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
  UploadMigrationPage,
  UploadMigrationReceipt,
  UploadResourceTotals,
} from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type {
  DiscoveryPage,
  HousekeepingCoverage,
  JobClaim,
  StepOutcome,
} from '../types/housekeeping';
import type { FileReadRepository } from '~/types/fileActivity';
import type { UploadActivationMethods } from './uploadManagementActivation';
import type { UploadAdmissionMethods } from './uploadManagementAdmission';
import type { UploadControlMethods } from './uploadManagementControl';
import type { UploadIntakeMethods } from './uploadManagementIntake';
export type UploadMigrationMethods = {
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
};

export type UploadCleanupClaim = JobClaim & {
  work: Extract<JobClaim['work'], { handler: 'upload.cleanup' }>;
};
export type UploadCleanupPreparation =
  | { state: 'ready'; task: UploadCleanupTask }
  | { state: 'outcome'; outcome: StepOutcome };

/** Exact actor facts survive independently of scanner, promotion and original deletion. */
export type UploadActorCleanupTask = UploadCleanupTask & {
  actorWriterStopped: boolean;
  actorLocalWriterStopped: boolean;
};
export type UploadActorCleanupProof = Pick<
  UploadCleanupProof,
  'operationId' | 'generation' | 'writerStopped' | 'localCopiesAbsent' | 'securitySettlement'
> & { localWriterStopped?: boolean };
/** Upload repository contract and explicit internal composition ports. */
export type UploadManagementRepository = UploadWriteMethods &
  UploadNasMethods &
  UploadCleanupReceiptMethods &
  UploadControlMethods &
  UploadMigrationMethods &
  UploadAdmissionMethods &
  UploadIntakeMethods &
  UploadActivationMethods & {
    readonly fileReads: FileReadRepository;
    coverageUploadHousekeeping(
      signal: AbortSignal,
      session: ClientSession,
    ): Promise<HousekeepingCoverage>;
    discoverUploadHousekeeping(cursor: string | null): Promise<DiscoveryPage>;
    prepareHousekeepingCleanup(claim: JobClaim): Promise<UploadCleanupPreparation>;
    confirmHousekeepingCleanup(claim: JobClaim, proof: UploadCleanupProof): Promise<StepOutcome>;
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
    cleanupForWorker(
      worker: UploadWorker,
      page?: { limit?: number; cursor?: string | null },
    ): Promise<{ tasks: UploadActorCleanupTask[]; cursor: string | null }>;
    confirmActorCleanup(
      worker: UploadWorker,
      proof: UploadActorCleanupProof,
      now: number,
    ): Promise<UploadActorCleanupTask>;
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

export type { UploadManagementContext, UploadPublicationPort } from './uploadManagementContext';
