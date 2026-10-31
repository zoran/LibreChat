/** NAS adapter exports; current authenticated principal and repository custody stay explicit. */
export { createNasS3Storage, getNasS3StorageCapture, isNasStoragePort } from './storage';
export type {
  NasCleanupResult,
  NasReadAuthority,
  NasS3StorageCapture,
  NasStorageOptions,
  NasStoragePort,
} from './storage';
