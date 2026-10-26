/** Immutable original-write contracts. This leaf owns no database, admission or runtime effects.
 * originalDeadline is selected once by the fenced owner; status reads never renew it. */
import type {
  UploadLease,
  UploadPrincipal,
  UploadOriginalIntegrity,
  UploadSecurityApproval,
} from 'librechat-data-provider';

export type ManagedUploadWriteInput = Readonly<{
  bucket: string;
  key: string;
  operationId: string;
  generation: string;
  bytes: number;
  wholeSHA256: string;
  mediaType: string;
}>;

export type ManagedUploadWriteBinding = ManagedUploadWriteInput &
  Readonly<{
    version: 1;
    originalDeadline: string;
  }>;

export type ManagedUploadWriteBinder = (
  input: ManagedUploadWriteInput,
) => Promise<ManagedUploadWriteBinding>;

export interface UploadWriteMethods {
  bindOriginalWrite(
    lease: UploadLease,
    input: ManagedUploadWriteInput,
    integrity: UploadOriginalIntegrity,
    approval: UploadSecurityApproval,
    now: number,
  ): Promise<ManagedUploadWriteBinding>;
  readOriginalWrite(
    principal: UploadPrincipal,
    operationId: string,
  ): Promise<ManagedUploadWriteBinding | null>;
}
