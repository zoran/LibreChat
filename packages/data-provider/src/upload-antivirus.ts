/** upload-antivirus binds actual per-document engine custody, clean approval and original retirement. */
import type { UploadSecuritySubject } from './upload-security';
import {
  readClosedRecord,
  identifier,
  hash,
  positiveInteger,
  checkedAt,
  readUploadSecuritySubject,
} from './upload-security-data';

/** Immutable original process/loaded generation. Warmup availability never substitutes for this. */
export type UploadAntivirusCustody = {
  version: 1;
  slot: string;
  podUid: string;
  runtimeImage: string;
  sourceRevision: string;
  engineArtifactSha256: string;
  profileSha256: string;
  signatureManifestSha256: string;
  signatureVerificationSha256: string;
  dailyDatabaseVersion: number;
  dailyPublishedAt: string;
  original: {
    id: string;
    pid: number;
    startTicks: string;
    bootId: string;
    configurationSha256: string;
  };
  subject: UploadSecuritySubject;
  expiresAt: string;
};

/** Actual same-original readiness precedes its clean observation; engineVersion is configured. */
export type UploadAntivirusApproval = {
  custody: UploadAntivirusCustody;
  engineVersion: string;
  readyObservedAt: string;
  cleanAt: string;
};

/** Unknown is never joined/purged; physical flags belong to the exact original custody only. */
export type UploadAntivirusReceipt = {
  custody: UploadAntivirusCustody;
  state: 'unknown' | 'retired';
  originalProcessJoined: boolean;
  ownedTransientDataRemoved: boolean;
};

/** Current admission compares the selected immutable generation and typed signature-age bound. */
export type UploadAntivirusPolicy = {
  engineVersion: string;
  engineArtifactSha256: string;
  profileSha256: string;
  signatureManifestSha256: string;
  signatureVerificationSha256: string;
  signatureMaxAgeMs: number;
};
const CUSTODY_KEYS = [
  'version',
  'slot',
  'podUid',
  'runtimeImage',
  'sourceRevision',
  'engineArtifactSha256',
  'profileSha256',
  'signatureManifestSha256',
  'signatureVerificationSha256',
  'dailyDatabaseVersion',
  'dailyPublishedAt',
  'original',
  'subject',
  'expiresAt',
];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Shape only; neither a valid object nor a socket path authenticates the runtime issuer. */
export function readUploadAntivirusCustody(value: unknown): UploadAntivirusCustody | null {
  const r = readClosedRecord(value, CUSTODY_KEYS);
  const original =
    r && readClosedRecord(r.original, ['id', 'pid', 'startTicks', 'bootId', 'configurationSha256']);
  const subject = r && readUploadSecuritySubject(r.subject);
  if (
    !r ||
    !original ||
    !subject ||
    r.version !== 1 ||
    !identifier(r.slot) ||
    !identifier(r.podUid) ||
    typeof r.runtimeImage !== 'string' ||
    r.runtimeImage.length > 1024 ||
    !/^\S+@sha256:[a-f0-9]{64}$/.test(r.runtimeImage) ||
    typeof r.sourceRevision !== 'string' ||
    !/^[a-f0-9]{40}$/.test(r.sourceRevision) ||
    !hash(r.engineArtifactSha256) ||
    !hash(r.profileSha256) ||
    !hash(r.signatureManifestSha256) ||
    !hash(r.signatureVerificationSha256) ||
    !positiveInteger(r.dailyDatabaseVersion) ||
    !checkedAt(r.dailyPublishedAt) ||
    !checkedAt(r.expiresAt) ||
    Date.parse(r.expiresAt) <= Date.parse(r.dailyPublishedAt) ||
    typeof original.id !== 'string' ||
    !UUID.test(original.id) ||
    !positiveInteger(original.pid, 2147483647) ||
    typeof original.startTicks !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(original.startTicks) ||
    typeof original.bootId !== 'string' ||
    !UUID.test(original.bootId) ||
    !hash(original.configurationSha256)
  )
    return null;
  return {
    version: 1,
    slot: r.slot,
    podUid: r.podUid,
    runtimeImage: r.runtimeImage,
    sourceRevision: r.sourceRevision,
    engineArtifactSha256: r.engineArtifactSha256,
    profileSha256: r.profileSha256,
    signatureManifestSha256: r.signatureManifestSha256,
    signatureVerificationSha256: r.signatureVerificationSha256,
    dailyDatabaseVersion: r.dailyDatabaseVersion,
    dailyPublishedAt: r.dailyPublishedAt,
    original: {
      id: original.id,
      pid: original.pid,
      startTicks: original.startTicks,
      bootId: original.bootId,
      configurationSha256: original.configurationSha256,
    },
    subject,
    expiresAt: r.expiresAt,
  };
}

/** Retained matching is clock-free; only new write admission applies current configured freshness. */
export function readUploadAntivirusApproval(value: unknown): UploadAntivirusApproval | null {
  const r = readClosedRecord(value, ['custody', 'engineVersion', 'readyObservedAt', 'cleanAt']);
  const custody = r && readUploadAntivirusCustody(r.custody);
  if (
    !r ||
    !custody ||
    typeof r.engineVersion !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/.test(r.engineVersion) ||
    !checkedAt(r.readyObservedAt) ||
    !checkedAt(r.cleanAt) ||
    Date.parse(custody.dailyPublishedAt) > Date.parse(r.readyObservedAt) ||
    Date.parse(r.readyObservedAt) > Date.parse(r.cleanAt) ||
    Date.parse(r.cleanAt) > Date.parse(custody.expiresAt)
  )
    return null;
  return {
    custody,
    engineVersion: r.engineVersion,
    readyObservedAt: r.readyObservedAt,
    cleanAt: r.cleanAt,
  };
}

/** Entire normalized custody must match; an engine-only stop receipt cannot release an original. */
export function readUploadAntivirusReceipt(
  value: unknown,
  expected?: unknown,
): UploadAntivirusReceipt | null {
  const r = readClosedRecord(value, [
    'custody',
    'state',
    'originalProcessJoined',
    'ownedTransientDataRemoved',
  ]);
  const custody = r && readUploadAntivirusCustody(r.custody);
  if (
    !r ||
    !custody ||
    !['unknown', 'retired'].includes(String(r.state)) ||
    typeof r.originalProcessJoined !== 'boolean' ||
    typeof r.ownedTransientDataRemoved !== 'boolean'
  )
    return null;
  if (expected !== undefined) {
    const scope = readUploadAntivirusCustody(expected);
    if (!scope || JSON.stringify(scope) !== JSON.stringify(custody)) return null;
  }
  return {
    custody,
    state: r.state as 'unknown' | 'retired',
    originalProcessJoined: r.originalProcessJoined,
    ownedTransientDataRemoved: r.ownedTransientDataRemoved,
  };
}

/** Trusted current owner binds configured version/artifacts and signature TTL before a new write. */
export function matchesCurrentUploadAntivirus(
  value: unknown,
  expected: unknown,
  now: number,
  policy: UploadAntivirusPolicy,
): boolean {
  const a = readUploadAntivirusApproval(value),
    custody = readUploadAntivirusCustody(expected);
  return (
    !!a &&
    !!custody &&
    JSON.stringify(a.custody) === JSON.stringify(custody) &&
    Number.isSafeInteger(now) &&
    now >= Date.parse(a.cleanAt) &&
    now <= Date.parse(custody.expiresAt) &&
    Number.isSafeInteger(policy.signatureMaxAgeMs) &&
    policy.signatureMaxAgeMs > 0 &&
    now - Date.parse(custody.dailyPublishedAt) <= policy.signatureMaxAgeMs &&
    Date.parse(custody.expiresAt) <=
      Date.parse(custody.dailyPublishedAt) + policy.signatureMaxAgeMs &&
    a.engineVersion === policy.engineVersion &&
    (
      [
        'engineArtifactSha256',
        'profileSha256',
        'signatureManifestSha256',
        'signatureVerificationSha256',
      ] as const
    ).every((k) => hash(policy[k]) && custody[k] === policy[k])
  );
}
