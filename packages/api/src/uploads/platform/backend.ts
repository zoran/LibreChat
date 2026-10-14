/** Public, bounded backend evidence. The object-storage owner supplies qualification, not the app. */
import type { UploadClock } from '../control/types';

export const UPLOAD_SAFETY_NAMESPACE = 'cortex-objectstore';
export const UPLOAD_SAFETY_NAMES = [
  'cortex-upload-safety-cpu-2',
  'cortex-upload-safety-cpu-4',
] as const;
export const UPLOAD_SAFETY_BUCKET = 'cortex-managed-uploads';
export const UPLOAD_SAFETY_AGE_MS = 70_000;
export const UPLOAD_BACKEND_FREE_BYTES: number = 512 * 1024 ** 3;
export const uploadSafetyReasons = [
  'qualified',
  'unqualified',
  'identity',
  'policy',
  'health',
  'replication',
  'space',
  'empty',
  'timeout',
  'invalid',
  'limit',
] as const;
type SafetyState = 'safe' | 'unsafe' | 'unknown';
type Filesystem = { hostId: string; pvUid: string; filesystemId: string };
type Policy = {
  revision: string;
  sourceSha256: string;
  filers: { member: string; podUid: string; processId: string }[];
};
export interface UploadBackendBinding {
  schema: 1;
  deploymentId: string;
  storeId: string;
  bucket: typeof UPLOAD_SAFETY_BUCKET;
  collection: string;
  observers: {
    observer: 'cpu-2' | 'cpu-4';
    name: (typeof UPLOAD_SAFETY_NAMES)[number];
    uid: string;
  }[];
  policy: Policy;
  filesystems: Filesystem[];
  /** Only the native owner may qualify an initially empty, newly provisioned bucket. */
  emptyProvisionRevision?: string;
}
export interface UploadBackendView {
  observer: string;
  state: SafetyState;
  collectedFromMs: number;
  collectedThroughMs: number;
  publishedAtMs: number;
  expiresAtMs: number;
  expiresMonotonicMs: number;
}
export interface UploadDurability {
  state: SafetyState;
  observedAtMs: number;
  expiresAtMs: number;
  expiresMonotonicMs: number;
}

function invalid(): never {
  throw new Error('invalid_upload_safety_evidence');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 128): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > max ||
    // eslint-disable-next-line no-control-regex -- Safety evidence identifiers must not contain control characters.
    /[\s\x00-\x1f]/.test(value)
  )
    return invalid();
  return value;
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalid();
  return value;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) return invalid();
  return value;
}
function parsePolicy(value: unknown): Policy {
  const raw = object(value);
  const sourceSha256 = text(raw.sourceSha256);
  if (!/^[a-f0-9]{64}$/.test(sourceSha256)) return invalid();
  const filers = array(raw.filers, 2)
    .map((entry) => {
      const row = object(entry);
      return {
        member: text(row.member),
        podUid: text(row.podUid),
        processId: text(row.processId, 256),
      };
    })
    .sort((a, b) => a.member.localeCompare(b.member));
  if (
    filers.length !== 2 ||
    new Set(filers.map((filer) => filer.member)).size !== 2 ||
    new Set(filers.map((filer) => filer.podUid)).size !== 2
  )
    return invalid();
  return { revision: text(raw.revision), sourceSha256, filers };
}
function filesystem(value: unknown): Filesystem {
  const row = object(value);
  return { hostId: text(row.hostId), pvUid: text(row.pvUid), filesystemId: text(row.filesystemId) };
}
export function parseUploadBackendBinding(
  value: unknown,
  expectedHosts: readonly string[],
): UploadBackendBinding {
  const raw = object(value);
  if (
    raw.schema !== 1 ||
    raw.bucket !== UPLOAD_SAFETY_BUCKET ||
    expectedHosts.length !== 4 ||
    new Set(expectedHosts).size !== 4
  )
    return invalid();
  const observers = array(raw.observers, 2).map((value, index) => {
    const row = object(value);
    const observer = index === 0 ? 'cpu-2' : 'cpu-4';
    if (row.observer !== observer || row.name !== UPLOAD_SAFETY_NAMES[index]) return invalid();
    return {
      observer,
      name: UPLOAD_SAFETY_NAMES[index],
      uid: text(row.uid),
    } as UploadBackendBinding['observers'][number];
  });
  const filesystems = array(raw.filesystems, 4)
    .map(filesystem)
    .sort((a, b) => a.hostId.localeCompare(b.hostId));
  if (
    observers.length !== 2 ||
    new Set(observers.map((row) => row.uid)).size !== 2 ||
    filesystems.length !== 4 ||
    new Set(filesystems.map((row) => row.hostId)).size !== 4 ||
    new Set(filesystems.map((row) => row.pvUid)).size !== 4 ||
    filesystems.some((row) => !expectedHosts.includes(row.hostId))
  )
    return invalid();
  return {
    schema: 1,
    deploymentId: text(raw.deploymentId),
    storeId: text(raw.storeId),
    bucket: UPLOAD_SAFETY_BUCKET,
    collection: text(raw.collection),
    observers,
    filesystems,
    policy: parsePolicy(raw.policy),
    ...(raw.emptyProvisionRevision === undefined
      ? {}
      : { emptyProvisionRevision: text(raw.emptyProvisionRevision) }),
  };
}

/** Validate one independently complete view, including native physical replica domains. */
export function decodeUploadBackendView(
  value: unknown,
  binding: UploadBackendBinding,
  observer: UploadBackendBinding['observers'][number],
  received: UploadClock,
  previous?: UploadBackendView,
): UploadBackendView {
  const configMap = object(value);
  const metadata = object(configMap.metadata);
  if (
    configMap.kind !== 'ConfigMap' ||
    configMap.apiVersion !== 'v1' ||
    metadata.name !== observer.name ||
    metadata.namespace !== UPLOAD_SAFETY_NAMESPACE ||
    metadata.uid !== observer.uid ||
    metadata.deletionTimestamp !== undefined
  )
    return invalid();
  const encoded = object(configMap.data)['snapshot.json'];
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 64 * 1024) return invalid();
  const raw = object(JSON.parse(encoded));
  if (
    raw.schema !== 1 ||
    raw.observer !== observer.observer ||
    raw.deploymentId !== binding.deploymentId ||
    raw.storeId !== binding.storeId ||
    raw.bucket !== binding.bucket ||
    raw.collection !== binding.collection ||
    !['safe', 'unsafe', 'unknown'].includes(String(raw.state)) ||
    !uploadSafetyReasons.includes(raw.reason as (typeof uploadSafetyReasons)[number])
  )
    return invalid();
  const collectedFromMs = number(raw.collectedFromMs);
  const collectedThroughMs = number(raw.collectedThroughMs);
  const publishedAtMs = number(raw.publishedAtMs);
  if (
    !Number.isFinite(received.nowMs) ||
    !Number.isFinite(received.monotonicMs) ||
    collectedFromMs > collectedThroughMs ||
    collectedThroughMs > publishedAtMs ||
    publishedAtMs > received.nowMs ||
    collectedThroughMs - collectedFromMs > 20_000 ||
    publishedAtMs - collectedThroughMs > 2_000 ||
    received.nowMs - collectedFromMs >= UPLOAD_SAFETY_AGE_MS ||
    (previous && collectedFromMs < previous.collectedFromMs)
  )
    return invalid();
  let state = raw.state as SafetyState;
  if (state === 'safe') {
    try {
      if (
        raw.reason !== 'qualified' ||
        JSON.stringify(parsePolicy(raw.policy)) !== JSON.stringify(binding.policy)
      )
        return invalid();
      const disks = array(raw.filesystems, 4);
      const nativeDisks = disks.map(filesystem).sort((a, b) => a.hostId.localeCompare(b.hostId));
      if (
        JSON.stringify(nativeDisks) !== JSON.stringify(binding.filesystems) ||
        disks.some((disk) => number(object(disk).freeBytes) < UPLOAD_BACKEND_FREE_BYTES)
      )
        return invalid();
      const volumes = array(raw.volumes, 256);
      const ids = new Set<number>();
      for (const entry of volumes) {
        const volume = object(entry);
        const id = number(volume.id);
        const hosts = array(volume.hosts, 3).map((host) => text(host));
        if (
          !id ||
          ids.has(id) ||
          volume.collection !== binding.collection ||
          volume.replication !== '020' ||
          hosts.length !== 3 ||
          new Set(hosts).size !== 3 ||
          hosts.some((host) => !binding.filesystems.some((disk) => disk.hostId === host))
        )
          return invalid();
        ids.add(id);
      }
      if (
        !volumes.length &&
        (!binding.emptyProvisionRevision ||
          raw.emptyProvisionRevision !== binding.emptyProvisionRevision ||
          raw.bucketEmpty !== true)
      )
        return invalid();
    } catch {
      // A correctly identified fresh observer with invalid safety proof is an explicit unknown,
      // not a reason to retain that observer's older healthy view.
      state = 'unknown';
    }
  }
  const expiresAtMs = collectedFromMs + UPLOAD_SAFETY_AGE_MS;
  let expiresMonotonicMs = received.monotonicMs + expiresAtMs - received.nowMs;
  if (previous && previous.collectedFromMs === collectedFromMs) {
    expiresMonotonicMs = Math.min(previous.expiresMonotonicMs, expiresMonotonicMs);
    if (previous.collectedThroughMs !== collectedThroughMs || previous.state !== state) {
      state = previous.state === 'unsafe' || state === 'unsafe' ? 'unsafe' : 'unknown';
    }
  }
  return {
    observer: observer.observer,
    state,
    collectedFromMs,
    collectedThroughMs,
    publishedAtMs,
    expiresAtMs,
    expiresMonotonicMs,
  };
}

export function selectUploadDurability(
  views: readonly UploadBackendView[],
  clock: UploadClock,
): UploadDurability {
  const live = views.filter(
    (view) =>
      view.collectedFromMs <= clock.nowMs &&
      view.expiresAtMs > clock.nowMs &&
      view.expiresMonotonicMs > clock.monotonicMs &&
      clock.nowMs - view.collectedFromMs < UPLOAD_SAFETY_AGE_MS,
  );
  const safe = live
    .filter((view) => view.state === 'safe')
    .sort((a, b) => b.collectedFromMs - a.collectedFromMs)[0];
  const veto = live
    .filter((view) => view.state !== 'safe')
    .sort((a, b) => b.collectedThroughMs - a.collectedThroughMs)[0];
  const selected = safe && (!veto || safe.collectedFromMs > veto.collectedThroughMs) ? safe : veto;
  return selected
    ? {
        state: selected.state,
        observedAtMs: selected.collectedFromMs,
        expiresAtMs: selected.expiresAtMs,
        expiresMonotonicMs: selected.expiresMonotonicMs,
      }
    : { state: 'unknown', observedAtMs: 0, expiresAtMs: 0, expiresMonotonicMs: 0 };
}
