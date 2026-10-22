/** Internal composition ports for the single Upload store and File retention owner. */
import type {
  UploadPrincipal,
  UploadErrorCode,
  UploadCleanupTask,
  UploadCleanupProof,
  UploadUsage,
} from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type {
  StoredUpload,
  GlobalState,
  createUploadStore,
  storedUploadPrincipal,
} from './uploadManagementStore';
import type { createFileRetentionMethods } from './fileRetention';

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
  applyCleanup(row: StoredUpload, proof: UploadCleanupProof, global: GlobalState): void;
  usage(principal: UploadPrincipal, now: number, session?: ClientSession): Promise<UploadUsage>;
  recordOriginalPublication?: UploadPublicationPort;
}
