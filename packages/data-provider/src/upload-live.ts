/** upload-live projects only safe storage availability, never host, key or proof metadata. */
import { readClosedRecord } from './upload-security-data';

/** Advisory status only. Authenticated backend admission remains authoritative. */
export type UploadStorageAvailability =
  | { available: true; reason: null }
  | { available: false; reason: 'storage-unavailable' | 'storage-stale' };

/** The public feature gains one safe requirement bit, never private storage configuration. */
export type ManagedUploadFeatureCapability = {
  enabled: boolean;
  eligible: boolean;
  storageAvailabilityRequired: boolean;
};

/** Genuine two-flag legacy input upgrades to false; a malformed present marker is never legacy. */
export function readManagedUploadFeatureCapability(
  value: unknown,
): ManagedUploadFeatureCapability | null {
  const current = readClosedRecord(value, ['enabled', 'eligible', 'storageAvailabilityRequired']);
  const legacy = current ? null : readClosedRecord(value, ['enabled', 'eligible']);
  const r = current ?? legacy;
  if (
    !r ||
    typeof r.enabled !== 'boolean' ||
    typeof r.eligible !== 'boolean' ||
    (current && typeof current.storageAvailabilityRequired !== 'boolean')
  )
    return null;
  return {
    enabled: r.enabled,
    eligible: r.eligible,
    storageAvailabilityRequired: current?.storageAvailabilityRequired === true,
  };
}

/** Invalid or absent wire status remains unavailable; it never defaults to green. */
export function readUploadStorageAvailability(value: unknown): UploadStorageAvailability | null {
  const row = readClosedRecord(value, ['available', 'reason']);
  if (row?.available === true && row.reason === null) return { available: true, reason: null };
  if (
    row?.available === false &&
    (row.reason === 'storage-unavailable' || row.reason === 'storage-stale')
  )
    return { available: false, reason: row.reason };
  return null;
}
