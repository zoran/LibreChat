/** uploadManagementNasTypes defines trusted in-process NAS dispatch and custody ports, never HTTP DTOs. */
import type {
  UploadLease,
  UploadPrincipal,
  UploadOriginalIntegrity,
  UploadSecurityApproval,
  NasS3Backend,
  NasUploadWriteBinding,
  NasOriginalWriteJournal,
  NasDeletionReceipt,
  NasOriginalHttp200,
  NasCleanupCustody,
  UploadSecurityExecution,
} from 'librechat-data-provider';
import type { JobClaim } from '../types/housekeeping';

/** The repository chooses a fresh key after authentic security admission. */
export type NasUploadWriteInput = {
  backend: NasS3Backend;
  bucket: string;
  operationId: string;
  generation: string;
  bytes: number;
  wholeSHA256: string;
  mediaType: string;
};

/** Only the admitted original receives these closures; reads/retries never recreate them. */
export type NasOriginalObserver = Readonly<{
  acknowledge200(response: NasOriginalHttp200): Promise<void>;
  verified(integrity: UploadOriginalIntegrity): Promise<void>;
  /** Invoke only before starting any network original; never after a timeout or local abort. */
  notDispatched(): Promise<void>;
}>;

/** Trusted adapter must await its actual original and call the observer from that original. */
export type NasOriginalDispatch = (
  binding: NasUploadWriteBinding,
  observer: NasOriginalObserver,
) => Promise<void>;

/** Trusted AV owner validates its actual loaded generation; absent/asynchronous authority denies NAS. */
export type NasAntivirusAdmission = (
  input: Readonly<{
    tenantId: string | null;
    userId: string;
    operationId: string;
    generation: number;
    bytes: number;
    sha256: string;
    mediaType: string;
    approval: UploadSecurityApproval;
    execution: UploadSecurityExecution;
  }>,
) => boolean;

/** Joined DELETE original acknowledgement must precede its exact-key absence observation. */
export type NasDeletionObserver = Readonly<{
  deleted(status: 200 | 204): Promise<void>;
  absent404(): Promise<void>;
}>;

export interface UploadNasMethods {
  dispatchNasOriginalWrite(
    lease: UploadLease,
    input: NasUploadWriteInput,
    integrity: UploadOriginalIntegrity,
    approval: UploadSecurityApproval,
    now: number,
    dispatch: NasOriginalDispatch,
  ): Promise<{
    state: 'verified' | 'pending' | 'already-dispatched';
    binding: NasUploadWriteBinding;
  }>;
  readNasOriginalWrite(
    principal: UploadPrincipal,
    operationId: string,
  ): Promise<{
    binding: NasUploadWriteBinding;
    original: NasOriginalWriteJournal;
    cleanup: NasCleanupCustody | null;
  } | null>;
  dispatchNasCleanup(
    principal: UploadPrincipal,
    operationId: string,
    dispatch: (binding: NasUploadWriteBinding, observer: NasDeletionObserver) => Promise<void>,
    claim?: JobClaim,
  ): Promise<NasDeletionReceipt | null>;
  /** Read-only reconciliation is available ONLY after a durable actual DELETE acknowledgement. */
  observeNasCleanup(
    principal: UploadPrincipal,
    operationId: string,
    observe: (binding: NasUploadWriteBinding) => Promise<404 | null>,
  ): Promise<NasDeletionReceipt | null>;
  /** Existing File owner joins its revocation/derivative/actor facts in its current transaction. */
  consumeNasCleanup(
    principal: UploadPrincipal,
    operationId: string,
    claim?: JobClaim,
  ): Promise<string | null>;
}
