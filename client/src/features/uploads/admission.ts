/** admission projects independent public upload causes without granting backend authority. */
import type { UploadStorageAvailability } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks/useLocalize';

/** Missing NAS status is supplied as unavailable by its identity-bound live owner. */
export function uploadAdmissionError(input: {
  eligible: boolean;
  admissionsPaused: boolean | null;
  storageAvailability?: UploadStorageAvailability;
  availableBytes?: number;
}): TranslationKeys | null {
  if (!input.eligible) return 'com_upload_login_needed';
  if (input.admissionsPaused === true) return 'com_upload_admission_paused';
  if (input.storageAvailability?.available === false)
    return input.storageAvailability.reason === 'storage-stale'
      ? 'com_upload_storage_stale'
      : 'com_upload_storage_unavailable';
  if (input.admissionsPaused !== false) return 'com_upload_status_unavailable';
  if (input.availableBytes !== undefined && input.availableBytes <= 0)
    return 'com_upload_quota_exceeded';
  return null;
}
