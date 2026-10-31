import type { UploadOperation, UploadUsage } from './upload-management';
import type { UploadStorageAvailability } from './upload-live';
import type { TFile } from './types/files';

/** Authenticated UI projection. Storage keys, lease tokens and other users never cross this port. */
export type ManagedUploadView = UploadOperation & {
  attachment?: Pick<
    TFile,
    | 'file_id'
    | 'filename'
    | 'filepath'
    | 'type'
    | 'source'
    | 'bytes'
    | 'embedded'
    | 'llmDeliveryPath'
  >;
};
export type ManagedUploadSnapshot = {
  version: 1;
  operations: ManagedUploadView[];
  usage: UploadUsage;
  /** Advisory only; the shared reservation transaction remains authoritative. */
  admissionsPaused: boolean | null;
  throttled: boolean;
  waitingReason: 'capacity' | 'unavailable' | null;
  /** Absent only for legacy storage. NAS always supplies its fail-closed current status. */
  storageAvailability?: UploadStorageAvailability;
};
