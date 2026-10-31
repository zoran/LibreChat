/** upload-storage-health validates source-bound CPU NFS/S3 samples without granting issuer authority. */
import type { UploadStorageAvailability } from './upload-live';
import type { NasS3Backend } from './upload-nas';
import { readClosedRecord, identifier, hash } from './upload-security-data';
import { readNasS3Backend } from './upload-nas';

/** Trusted server configuration fixes the four CPU hosts; GPU health is a different purpose. */
export type UploadStorageHealthBinding = {
  backend: NasS3Backend;
  cpuHosts: readonly string[];
  cohortSha256: string;
  nfsSourceSha256: string;
  intervalMs: number;
  maxAgeMs: number;
};

/** Normal authenticated collector report. Shape alone never proves the original kernel I/O joined. */
export type UploadNfsWriteProof = {
  version: 1;
  hostId: string;
  backend: NasS3Backend;
  cohortSha256: string;
  sourceSha256: string;
  probeId: string;
  mountIdentitySha256: string;
  writeReadSha256: string | null;
  originalState: 'joined' | 'unresolved';
  outcome: 'ready' | 'failed' | 'unknown';
  startedAtMs: number;
  completedAtMs: number;
  expiresAtMs: number;
};

/** This is a dedicated control-key observation, never a user-original or deletion receipt. */
export type UploadS3HealthProof = {
  version: 1;
  backend: NasS3Backend;
  owner: string;
  outcome: 'ready' | 'failed' | 'unknown';
  startedAtMs: number;
  completedAtMs: number;
  expiresAtMs: number;
};
const count = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const timeKeys = ['startedAtMs', 'completedAtMs', 'expiresAtMs'];
/** Bounded own-data arrays; revoked proxies and accessors never run as collector evidence. */
function array(value: unknown, max: number): unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null;
    const d = Object.getOwnPropertyDescriptors(value),
      length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > max ||
      Reflect.ownKeys(d).length !== length + 1
    )
      return null;
    const out: unknown[] = [];
    for (let i = 0; i < length; i++) {
      const item = d[String(i)];
      if (!item?.enumerable || !('value' in item)) return null;
      out.push(item.value);
    }
    return out;
  } catch {
    return null;
  }
}
const times = (r: Record<string, unknown>): boolean =>
  timeKeys.every((k) => count(r[k])) &&
  Number(r.startedAtMs) <= Number(r.completedAtMs) &&
  Number(r.completedAtMs) < Number(r.expiresAtMs);

export function readUploadStorageHealthBinding(value: unknown): UploadStorageHealthBinding | null {
  const r = readClosedRecord(value, [
    'backend',
    'cpuHosts',
    'cohortSha256',
    'nfsSourceSha256',
    'intervalMs',
    'maxAgeMs',
  ]);
  const backend = r && readNasS3Backend(r.backend);
  const hosts = r && array(r.cpuHosts, 4);
  if (
    !r ||
    !backend ||
    !hosts ||
    hosts.length !== 4 ||
    !hosts.every(identifier) ||
    new Set(hosts).size !== 4 ||
    !hash(r.cohortSha256) ||
    !hash(r.nfsSourceSha256) ||
    r.intervalMs !== 60000 ||
    r.maxAgeMs !== 90000
  )
    return null;
  return {
    backend,
    cpuHosts: hosts as string[],
    cohortSha256: r.cohortSha256,
    nfsSourceSha256: r.nfsSourceSha256,
    intervalMs: r.intervalMs,
    maxAgeMs: r.maxAgeMs,
  };
}

export function readUploadNfsWriteProof(value: unknown): UploadNfsWriteProof | null {
  const r = readClosedRecord(value, [
    'version',
    'hostId',
    'backend',
    'cohortSha256',
    'sourceSha256',
    'probeId',
    'mountIdentitySha256',
    'writeReadSha256',
    'originalState',
    'outcome',
    ...timeKeys,
  ]);
  const backend = r && readNasS3Backend(r.backend);
  if (
    !r ||
    !backend ||
    r.version !== 1 ||
    !identifier(r.hostId) ||
    !identifier(r.probeId) ||
    !hash(r.cohortSha256) ||
    !hash(r.sourceSha256) ||
    !hash(r.mountIdentitySha256) ||
    (r.writeReadSha256 !== null && !hash(r.writeReadSha256)) ||
    !['joined', 'unresolved'].includes(String(r.originalState)) ||
    !['ready', 'failed', 'unknown'].includes(String(r.outcome)) ||
    !times(r) ||
    (r.outcome === 'ready' && (r.originalState !== 'joined' || !hash(r.writeReadSha256)))
  )
    return null;
  return { ...r, backend } as UploadNfsWriteProof;
}

export function readUploadS3HealthProof(value: unknown): UploadS3HealthProof | null {
  const r = readClosedRecord(value, ['version', 'backend', 'owner', 'outcome', ...timeKeys]);
  const backend = r && readNasS3Backend(r.backend);
  if (
    !r ||
    !backend ||
    r.version !== 1 ||
    !identifier(r.owner) ||
    !['ready', 'failed', 'unknown'].includes(String(r.outcome)) ||
    !times(r)
  )
    return null;
  return { ...r, backend } as UploadS3HealthProof;
}
const unavailable = (): UploadStorageAvailability => ({
  available: false,
  reason: 'storage-unavailable',
});

/** The authenticated caller owns these reports; no caller-selected clock can restamp their source. */
export function evaluateUploadStorageAvailability(
  binding: UploadStorageHealthBinding,
  nfs: readonly unknown[],
  s3: unknown,
  now: number,
): UploadStorageAvailability {
  const b = readUploadStorageHealthBinding(binding);
  const store = readUploadS3HealthProof(s3);
  const samples = array(nfs, 64);
  if (
    !b ||
    !count(now) ||
    !samples ||
    !store ||
    !b.cpuHosts.includes(store.owner) ||
    JSON.stringify(store.backend) !== JSON.stringify(b.backend)
  )
    return unavailable();
  const rows: UploadNfsWriteProof[] = [];
  for (const value of samples) {
    let host: unknown;
    try {
      host = Object.getOwnPropertyDescriptor(value, 'hostId')?.value;
    } catch {
      return unavailable();
    }
    if (!identifier(host)) return unavailable();
    if (!b.cpuHosts.includes(host)) continue;
    const row = readUploadNfsWriteProof(value);
    if (!row) return unavailable();
    rows.push(row);
  }
  if (
    rows.length !== 4 ||
    new Set(rows.map((r) => r.hostId)).size !== 4 ||
    rows.some(
      (r) =>
        r.cohortSha256 !== b.cohortSha256 ||
        r.sourceSha256 !== b.nfsSourceSha256 ||
        JSON.stringify(r.backend) !== JSON.stringify(b.backend) ||
        r.outcome !== 'ready' ||
        r.originalState !== 'joined',
    ) ||
    store.outcome !== 'ready'
  )
    return unavailable();
  const all = [...rows, store];
  if (
    all.some(
      (r) =>
        r.startedAtMs > now || r.completedAtMs > now || r.expiresAtMs - r.startedAtMs > b.maxAgeMs,
    )
  )
    return unavailable();
  if (all.some((r) => r.expiresAtMs <= now || now - r.startedAtMs >= b.maxAgeMs))
    return { available: false, reason: 'storage-stale' };
  return { available: true, reason: null };
}
