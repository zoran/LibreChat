/** Typed File/Upload custody ports shared by cleanup execution and its completion reader. */
import type { ClientSession } from 'mongoose';
import type {
  FileCleanupCompletionOptions,
  FileUploadCleanupBinding,
  FileUploadCleanupAcknowledgment,
} from '../types/fileCleanup';
import type { JobClaim } from '../types/housekeeping';
import type { FileOwnerScope } from '../types/file';
export type AcceptedFileCleanupInput = Readonly<{ claim: JobClaim }>;
type OwnerPending =
  | {
      state: 'pending';
      reason:
        | 'owner_pending'
        | 'actor_pending'
        | 'source_strategy_unavailable'
        | 'migration_pending';
    }
  | { state: 'lost' };
export interface AcceptedFileCleanupOwner {
  observeAcceptedFileCleanup(
    input: FileCleanupCompletionOptions & Readonly<{ owner: FileOwnerScope; fileId: string }>,
    session: ClientSession,
  ): Promise<
    { state: 'acknowledged'; ack: FileUploadCleanupAcknowledgment } | { state: 'pending' }
  >;
  fenceAcceptedFileCleanup(
    input: AcceptedFileCleanupInput,
    session: ClientSession,
  ): Promise<{ state: 'bound'; binding: FileUploadCleanupBinding } | OwnerPending>;
  acknowledgeAcceptedFileCleanup(
    input: AcceptedFileCleanupInput,
    session: ClientSession,
  ): Promise<{ state: 'acknowledged'; ack: FileUploadCleanupAcknowledgment } | OwnerPending>;
}
