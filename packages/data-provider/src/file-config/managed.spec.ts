/** managed.spec.ts checks the actual optional configSchema path and its closed private deployment block. */
import { fileConfigSchema, managedUploadsConfigSchema, mergeFileConfig } from '../file-config';
import { configSchema } from '../config';

function fixture() {
  return {
    storage: {
      kind: 'nas-s3' as const,
      uid: 'synthetic-nas',
      endpoint: 'https://nas.synthetic.invalid:8010',
      bucket: 'private-files',
      credentialsFile: '/synthetic/credentials.json',
      trust: {
        mode: 'exact-certificate' as const,
        certificateFile: '/synthetic/certificate.pem',
        sha256: 'a'.repeat(64),
      },
    },
    health: { requiredHosts: ['cpu2', 'cpu3', 'cpu4', 'cpu5'] },
  };
}

it('is optional without changing the legacy File defaults or public merged output', () => {
  expect(fileConfigSchema.parse({})).toEqual({});
  expect(mergeFileConfig(undefined)).toBe(mergeFileConfig(undefined));
  expect(
    'managedUploads' in mergeFileConfig(fileConfigSchema.parse({ managedUploads: fixture() })),
  ).toBe(false);
});
it('survives the real configSchema route with explicit cohort and typed defaults', () => {
  const parsed = configSchema.parse({
    version: '1.3.16',
    fileConfig: { managedUploads: fixture() },
  });
  expect(parsed.fileConfig?.managedUploads).toEqual({
    ...fixture(),
    storage: { ...fixture().storage, region: 'us-east-1', requestTimeoutMs: 10000 },
    antivirus: { signatureMaxAgeMs: 86400000 },
    health: { ...fixture().health, intervalMs: 60000, maxAgeMs: 90000 },
  });
});
it('supports normal CA/hostname verification without a private key or certificate override', () => {
  const value = {
    ...fixture(),
    storage: { ...fixture().storage, trust: { mode: 'ca-hostname', caFile: '/synthetic/ca.pem' } },
  };
  expect(managedUploadsConfigSchema.parse(value).storage.trust).toEqual(value.storage.trust);
  expect(
    managedUploadsConfigSchema.parse({
      ...value,
      storage: { ...value.storage, trust: { mode: 'ca-hostname' } },
    }).storage.trust,
  ).toEqual({ mode: 'ca-hostname' });
});
it.each([
  'http://nas.synthetic.invalid',
  'https://user:password@nas.synthetic.invalid',
  'https://nas.synthetic.invalid/storage',
  'https://nas.synthetic.invalid/?token=synthetic',
  'https://nas.synthetic.invalid/#fragment',
  'https://nas.synthetic.invalid/?',
  'https://nas.synthetic.invalid/#',
  ' https://nas.synthetic.invalid/',
])('rejects a non-root/non-HTTPS/credential URL: %s', (endpoint) => {
  expect(
    managedUploadsConfigSchema.safeParse({
      ...fixture(),
      storage: { ...fixture().storage, endpoint },
    }).success,
  ).toBe(false);
});
it.each(['credentials', 'accessKeyId', 'secretAccessKey', 'certificatePem'])(
  'rejects raw/unknown private storage field %s',
  (key) => {
    expect(
      managedUploadsConfigSchema.safeParse({
        ...fixture(),
        storage: { ...fixture().storage, [key]: 'synthetic-only' },
      }).success,
    ).toBe(false);
  },
);
it.each([
  'relative.json',
  '/synthetic/../credentials.json',
  '/synthetic/credentials.json\n',
  '/synthetic/',
  'C:\\synthetic\\credentials.json',
])('requires an absolute credential filename: %s', (credentialsFile) => {
  expect(
    managedUploadsConfigSchema.safeParse({
      ...fixture(),
      storage: { ...fixture().storage, credentialsFile },
    }).success,
  ).toBe(false);
});
it.each([999, 300001, NaN, Infinity, 1.5])(
  'rejects invalid request timeout %s',
  (requestTimeoutMs) => {
    expect(
      managedUploadsConfigSchema.safeParse({
        ...fixture(),
        storage: { ...fixture().storage, requestTimeoutMs },
      }).success,
    ).toBe(false);
  },
);
it.each(
  [[], ['cpu2', 'cpu2'], ['../cpu2'], Array.from({ length: 65 }, (_, i) => 'cpu' + i)].map(
    (requiredHosts) => ({ requiredHosts }),
  ),
)('rejects an empty, repeated or unbounded cohort', ({ requiredHosts }) => {
  expect(
    managedUploadsConfigSchema.safeParse({ ...fixture(), health: { requiredHosts } }).success,
  ).toBe(false);
});
it('rejects unknown trust/health/AV fields and freshness shorter than its interval', () => {
  const base = fixture();
  for (const value of [
    {
      ...base,
      storage: { ...base.storage, trust: { ...base.storage.trust, rejectUnauthorized: false } },
    },
    { ...base, health: { ...base.health, skip: false } },
    { ...base, antivirus: { signatureMaxAgeMs: 86400000, skip: true } },
    { ...base, health: { ...base.health, intervalMs: 100000, maxAgeMs: 90000 } },
    { ...base, unknown: true },
  ])
    expect(managedUploadsConfigSchema.safeParse(value).success).toBe(false);
});

it.each(['nas.name', '', 'a'.repeat(129), 'nas/name', 'nas name'])(
  'rejects a UID outside the actual NAS factory grammar: %s',
  (uid) => {
    expect(
      managedUploadsConfigSchema.safeParse({
        ...fixture(),
        storage: { ...fixture().storage, uid },
      }).success,
    ).toBe(false);
  },
);
it('accepts actual NAS UID boundary values and retains dotted host identifiers', () => {
  for (const uid of ['_', 'a'.repeat(128)]) {
    expect(
      managedUploadsConfigSchema.parse({
        ...fixture(),
        storage: { ...fixture().storage, uid },
        health: { requiredHosts: ['cpu2.synthetic'] },
      }).storage.uid,
    ).toBe(uid);
  }
});
it.each([999, 86400001, NaN, Infinity, 1000.5])(
  'rejects a signature age outside the actual AV runtime range: %s',
  (signatureMaxAgeMs) => {
    expect(
      managedUploadsConfigSchema.safeParse({
        ...fixture(),
        antivirus: { signatureMaxAgeMs },
      }).success,
    ).toBe(false);
  },
);
it.each([1000, 86400000])('accepts the signature age boundary %s', (signatureMaxAgeMs) => {
  expect(
    managedUploadsConfigSchema.parse({
      ...fixture(),
      antivirus: { signatureMaxAgeMs },
    }).antivirus.signatureMaxAgeMs,
  ).toBe(signatureMaxAgeMs);
});
