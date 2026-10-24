/** Checked accounting at the File/HK data owner; logical and physical occupancy never share a sum. */
import {
  FILE_HISTORY_KIND_COUNTS,
  FILE_HISTORY_BYTE_KEYS,
  FILE_HISTORY_BLOCKER_KEYS,
} from 'librechat-data-provider';
import type {
  FileHistoryAccounting,
  FileHistoryEntry,
  FileHistoryBytes,
} from 'librechat-data-provider';
import { integer, FileHistoryError } from './fileHousekeepingData';

export function addInteger(a: number, b: number): number {
  const sum = a + b;
  if (!integer(a) || !integer(b) || !integer(sum)) throw new FileHistoryError('capacity');
  return sum;
}
export function emptyHistoryAccounting(): FileHistoryAccounting {
  return {
    counts: {
      ...Object.fromEntries(Object.values(FILE_HISTORY_KIND_COUNTS).map((key) => [key, 0])),
      retainedOwned: 0,
      deletionRequired: 0,
      deletionInFlight: 0,
      logicallyAbsentPhysicalPending: 0,
      absentAndConsumed: 0,
      unclassified: 0,
      heldSlots: 0,
      heldReservations: 0,
      unknownSizeCount: 0,
    } as FileHistoryAccounting['counts'],
    bytes: Object.fromEntries(FILE_HISTORY_BYTE_KEYS.map((key) => [key, 0])) as FileHistoryBytes,
    blockers: Object.fromEntries(
      FILE_HISTORY_BLOCKER_KEYS.map((key) => [key, 0]),
    ) as FileHistoryAccounting['blockers'],
  };
}
export function sumHistoryAccounting(
  a: FileHistoryAccounting,
  b: FileHistoryAccounting,
): FileHistoryAccounting {
  const result = emptyHistoryAccounting();
  for (const key of Object.keys(result.counts) as (keyof typeof result.counts)[])
    result.counts[key] = addInteger(a.counts[key], b.counts[key]);
  for (const key of FILE_HISTORY_BYTE_KEYS) {
    const x = a.bytes[key],
      y = b.bytes[key];
    result.bytes[key] = x === null || y === null ? null : addInteger(x, y);
  }
  for (const key of FILE_HISTORY_BLOCKER_KEYS)
    result.blockers[key] = addInteger(a.blockers[key], b.blockers[key]);
  return result;
}
export function recordHistoryBytes(
  accounting: FileHistoryAccounting,
  key: keyof FileHistoryBytes,
  value: unknown,
): void {
  if (!integer(value)) {
    accounting.bytes[key] = null;
    accounting.counts.unknownSizeCount = addInteger(accounting.counts.unknownSizeCount, 1);
    accounting.blockers.unknownSize = addInteger(accounting.blockers.unknownSize, 1);
  } else if (accounting.bytes[key] !== null) {
    accounting.bytes[key] = addInteger(accounting.bytes[key], value);
  }
}
export function entryHistoryAccounting(entry: FileHistoryEntry): FileHistoryAccounting {
  const result = emptyHistoryAccounting();
  result.counts[FILE_HISTORY_KIND_COUNTS[entry.kind]] = 1;
  const dispositions = {
    'retained-owned': 'retainedOwned',
    'deletion-required': 'deletionRequired',
    'deletion-in-flight': 'deletionInFlight',
    'logically-absent-physical-pending': 'logicallyAbsentPhysicalPending',
    'absent-and-consumed': 'absentAndConsumed',
    unclassified: 'unclassified',
  } as const;
  result.counts[dispositions[entry.disposition]] = 1;
  if (entry.owner.kind === 'unresolved' || entry.disposition === 'unclassified')
    result.blockers.unclassified = 1;
  if (['deletion-required', 'deletion-in-flight'].includes(entry.disposition))
    result.blockers.requiredDelete = 1;
  if (entry.disposition === 'logically-absent-physical-pending')
    result.blockers.physicalReclamation = 1;
  if (entry.reservedBytes === null || entry.measuredBytes === null) {
    result.counts.unknownSizeCount = 1;
    result.blockers.unknownSize = 1;
  }
  if (entry.reservedBytes !== null && entry.reservedBytes > 0) {
    result.counts.heldReservations = 1;
    result.blockers.reservation = 1;
  }
  if (entry.kind === 'multipartUpload' && entry.disposition !== 'absent-and-consumed')
    result.blockers.requiredAbort = 1;
  const measured: Partial<Record<FileHistoryEntry['kind'], keyof FileHistoryBytes>> = {
    object: 'logicalObjects',
    version: 'logicalVersions',
    multipartPart: 'multipartParts',
    physicalFile: 'physicalFileBytes',
    physicalAllocation: 'physicalAllocated',
    physicalOverhead: 'physicalOverhead',
  };
  const category = measured[entry.kind];
  if (category) recordHistoryBytes(result, category, entry.measuredBytes);
  if (entry.kind === 'physicalAllocation') {
    let allocatedCategory: keyof FileHistoryBytes | null = null;
    if (entry.disposition === 'retained-owned') allocatedCategory = 'allocatedRetained';
    else if (entry.disposition === 'unclassified') allocatedCategory = 'allocatedUnclassified';
    else if (entry.disposition !== 'absent-and-consumed') allocatedCategory = 'allocatedPending';
    if (allocatedCategory) recordHistoryBytes(result, allocatedCategory, entry.measuredBytes);
    if (allocatedCategory === 'allocatedPending') result.blockers.physicalReclamation = 1;
  }
  if (entry.kind === 'physicalRecord') {
    let category: keyof FileHistoryBytes = 'physicalDead';
    if (entry.owner.kind === 'unresolved' || entry.disposition === 'unclassified')
      category = 'physicalUnattributed';
    else if (entry.disposition === 'retained-owned') category = 'physicalLive';
    recordHistoryBytes(result, category, entry.measuredBytes);
    if (category !== 'physicalLive' && entry.measuredBytes !== 0)
      result.blockers.physicalReclamation = 1;
  }
  // Each nullable source measurement is counted once, even when assigned to a byte category.
  result.counts.unknownSizeCount =
    Number(entry.measuredBytes === null) + Number(entry.reservedBytes === null);
  result.blockers.unknownSize = result.counts.unknownSizeCount;
  return result;
}
export function historyHasBlockers(a: FileHistoryAccounting): boolean {
  return (
    ['deletionRequired', 'deletionInFlight', 'logicallyAbsentPhysicalPending', 'unclassified'].some(
      (k) => a.counts[k as keyof typeof a.counts] !== 0,
    ) ||
    Object.values(a.blockers).some((n) => n !== 0) ||
    Object.values(a.bytes).some((n) => n === null) ||
    a.counts.unknownSizeCount !== 0 ||
    a.counts.heldSlots !== 0 ||
    a.counts.heldReservations !== 0
  );
}
/** Conservation uses the existing baseline exactly once. File derivatives are already charged there. */
export function conservedMongoAccounting(
  global: Record<string, unknown>,
  a: FileHistoryAccounting,
  queueCount: number,
): boolean {
  const baseline = global.baseline;
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) return false;
  const b = baseline as Record<string, unknown>;
  const mappings = {
    originalBytes: a.bytes.uploadOriginal,
    objectBytes: a.bytes.uploadOriginal,
    textBytes: a.bytes.uploadText,
    recordBytes: a.bytes.uploadRecord,
    bundles: a.counts.upload,
  };
  try {
    return (
      Object.entries(mappings).every(
        ([key, value]) =>
          integer(value) &&
          integer(b[key]) &&
          integer(global[key]) &&
          addInteger(b[key], value) === global[key],
      ) &&
      integer(global.queueCount) &&
      global.queueCount === queueCount &&
      integer(global.queueBytes) &&
      global.queueBytes === a.bytes.uploadQueue
    );
  } catch {
    return false;
  }
}
export function conservedPhysicalAccounting(
  a: FileHistoryAccounting,
  filePhysicalBytes: number,
  allocatedPhysicalBytes: number,
): boolean {
  try {
    const sum = (keys: readonly (keyof FileHistoryBytes)[]) =>
      keys.reduce((total, key) => {
        const n = a.bytes[key];
        if (!integer(n)) throw new Error('Unknown physical amount');
        return addInteger(total, n);
      }, 0);
    return (
      integer(filePhysicalBytes) &&
      integer(allocatedPhysicalBytes) &&
      a.bytes.physicalFileBytes === filePhysicalBytes &&
      a.bytes.physicalAllocated === allocatedPhysicalBytes &&
      sum(['physicalLive', 'physicalDead', 'physicalUnattributed', 'physicalOverhead']) ===
        filePhysicalBytes &&
      sum(['allocatedRetained', 'allocatedPending', 'allocatedUnclassified']) ===
        allocatedPhysicalBytes &&
      a.counts.physicalFiles === a.counts.physicalAllocations
    );
  } catch {
    return false;
  }
}
/** Final authorization requires both equations and every existing ownership/custody blocker clear. */
export function sealablePhysicalAccounting(a: FileHistoryAccounting): boolean {
  return (
    conservedPhysicalAccounting(a, a.bytes.physicalFileBytes!, a.bytes.physicalAllocated!) &&
    a.bytes.allocatedPending === 0 &&
    a.bytes.allocatedUnclassified === 0 &&
    a.bytes.physicalDead === 0 &&
    a.bytes.physicalUnattributed === 0 &&
    !historyHasBlockers(a)
  );
}
