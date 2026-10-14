/** Pure validation of the one private managed-original identity contract. */
import {
  UPLOAD_INTEGRITY_CHUNK_BYTES,
  UPLOAD_MAX_FILE_BYTES,
  isUploadOriginalIntegrity,
  isUploadStorageReceipt,
  isUploadPrincipal,
} from './upload-management';

const hash = 'a'.repeat(64);
const integrity = (bytes = 8) => ({
  version: 1,
  algorithm: 'sha256',
  sha256: hash,
  chunkBytes: 262144,
  chunkSha256: Array.from({ length: Math.ceil(bytes / 262144) }, () => hash),
});

describe('bounded private storage receipt', () => {
  const receipt = () => ({
    outcome: 'durable',
    bytes: 8,
    source: 's3',
    filepath: '/file',
    storageKey: 't/tenant/managed-uploads/user/id.1__original',
    integrity: integrity(),
  });

  it.each(['durable', 'unknown', 'absent'])(
    'permits %s history without inventing integrity',
    (outcome) => {
      const { integrity: _unused, ...value } = receipt();
      expect(isUploadStorageReceipt({ ...value, outcome })).toBe(true);
    },
  );

  it('accepts bounded opaque metadata without interpreting ETag as a content digest', () => {
    expect(
      isUploadStorageReceipt({
        ...receipt(),
        etag: 'opaque-' + 'a'.repeat(1017),
        versionId: 'é'.repeat(512),
      }),
    ).toBe(true);
  });

  it.each([
    ['unknown metadata', { checksum: 'forged' }],
    ['oversized ETag', { etag: 'a'.repeat(1025) }],
    ['oversized UTF-8 version', { versionId: 'é'.repeat(513) }],
    ['nonstring ETag', { etag: 1 }],
    ['invalid present integrity', { integrity: { ...integrity(), chunkSha256: [] } }],
    ['null integrity', { integrity: null }],
  ])('rejects %s', (_name, change) => {
    expect(isUploadStorageReceipt({ ...receipt(), ...change })).toBe(false);
  });
});

describe('managed original integrity contract', () => {
  it('fixes the bounded block size at 256 KiB', () => {
    expect(UPLOAD_INTEGRITY_CHUNK_BYTES).toBe(262144);
  });

  it.each([1, 262143, 262144, 262145, UPLOAD_MAX_FILE_BYTES])(
    'accepts the exact canonical manifest for %i bytes without changing it',
    (bytes) => {
      const value = integrity(bytes);
      const before = JSON.stringify(value);
      expect(isUploadOriginalIntegrity(value, bytes)).toBe(true);
      expect(JSON.stringify(value)).toBe(before);
    },
  );

  it.each([0, -1, 0.5, NaN, Infinity, UPLOAD_MAX_FILE_BYTES + 1, Number.MAX_SAFE_INTEGER])(
    'rejects unsupported byte count %s',
    (bytes) => expect(isUploadOriginalIntegrity(integrity(), bytes)).toBe(false),
  );

  it.each([
    ['absent', undefined],
    ['null', null],
    ['array', []],
    ['string', JSON.stringify(integrity())],
    ['missing whole hash', { ...integrity(), sha256: undefined }],
    ['unknown key', { ...integrity(), checksum: hash }],
    ['unknown undefined key', { ...integrity(), checksum: undefined }],
    ['future version', { ...integrity(), version: 2 }],
    ['string version', { ...integrity(), version: '1' }],
    ['other algorithm', { ...integrity(), algorithm: 'sha512' }],
    ['other block size', { ...integrity(), chunkBytes: 65536 }],
    ['uppercase hash', { ...integrity(), sha256: hash.toUpperCase() }],
    ['base64 hash', { ...integrity(), sha256: Buffer.alloc(32).toString('base64') }],
    ['newline hash', { ...integrity(), sha256: hash + '\n' }],
    ['short hash', { ...integrity(), sha256: hash.slice(1) }],
    ['nonhex hash', { ...integrity(), sha256: 'g'.repeat(64) }],
    ['missing blocks', { ...integrity(), chunkSha256: [] }],
    ['extra block', { ...integrity(), chunkSha256: [hash, hash] }],
    ['nonarray blocks', { ...integrity(), chunkSha256: { 0: hash, length: 1 } }],
    ['sparse blocks', { ...integrity(), chunkSha256: Array(1) }],
    ['invalid block hash', { ...integrity(), chunkSha256: [hash + '\n'] }],
    ['nonstring block hash', { ...integrity(), chunkSha256: [null] }],
  ])('rejects %s', (_name, value) => {
    expect(isUploadOriginalIntegrity(value, 8)).toBe(false);
  });

  it('rejects a maximum-size manifest with one missing or surplus block', () => {
    const value = integrity(UPLOAD_MAX_FILE_BYTES);
    expect(value.chunkSha256).toHaveLength(120);
    expect(
      isUploadOriginalIntegrity(
        { ...value, chunkSha256: value.chunkSha256.slice(1) },
        UPLOAD_MAX_FILE_BYTES,
      ),
    ).toBe(false);
    expect(
      isUploadOriginalIntegrity(
        { ...value, chunkSha256: [...value.chunkSha256, hash] },
        UPLOAD_MAX_FILE_BYTES,
      ),
    ).toBe(false);
  });
});

describe('explicit personal upload principal namespaces', () => {
  it.each([
    { authentication: 'guest', tenantId: null, userId: 'guest' },
    { authentication: 'verified-email', tenantId: 'tenant-a', userId: 'email' },
  ])('accepts only the declared namespace %j', (value) =>
    expect(isUploadPrincipal(value)).toBe(true),
  );
  it.each([
    { authentication: 'guest', userId: 'guest' },
    { authentication: 'guest', tenantId: 'tenant-a', userId: 'guest' },
    { authentication: 'verified-email', tenantId: null, userId: 'email' },
    { authentication: 'verified-email', tenantId: '', userId: 'email' },
    { authentication: 'verified-email', tenantId: '__SYSTEM__', userId: 'email' },
    { authentication: 'service', tenantId: 'tenant-a', userId: 'email' },
    { authentication: 'guest', tenantId: null, userId: '' },
    { authentication: 'guest', tenantId: null, userId: { $ne: null } },
  ])('rejects ambiguous or foreign authority %j', (value) =>
    expect(isUploadPrincipal(value)).toBe(false),
  );
});
