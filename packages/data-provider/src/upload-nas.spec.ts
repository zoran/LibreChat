/** Closed NAS binding contracts preserve legacy provider identity and reject hostile DTOs. */
import { readNasS3Backend, readNasUploadWriteBinding } from './upload-nas';
import { isUploadStorageReceipt } from './upload-management';

const backend = {
  kind: 'nas-s3',
  uid: 'private-nas',
  configurationSha256: 'a'.repeat(64),
  protocol: 'acknowledged-only-v1',
};
const binding = {
  version: 2,
  backend,
  bucket: 'cortex-files',
  key: 'unique-owned-key',
  operationId: 'operation',
  generation: '1',
  bytes: 5,
  wholeSHA256: 'b'.repeat(64),
  mediaType: 'text/plain',
  originalDeadline: '2026-10-30T22:00:00.000Z',
};
it('copies exact backend/binding fields and leaves existing receipts legacy-bound', () => {
  const parsed = readNasUploadWriteBinding(binding);
  expect(parsed).toEqual(binding);
  expect(parsed?.backend).not.toBe(backend);
  const old = { outcome: 'unknown', bytes: 5, source: 's3', filepath: '/owned', storageKey: 'old' };
  expect(isUploadStorageReceipt(old)).toBe(true);
  expect('backend' in old).toBe(false);
  expect(isUploadStorageReceipt({ ...old, backend })).toBe(true);
  expect(isUploadStorageReceipt({ ...old, backend: { ...backend, uid: '' } })).toBe(false);
});
it.each([
  { ...binding, version: 1 },
  { ...binding, originalDeadline: 'renew' },
  { ...binding, backend: { ...backend, protocol: 'fence-v1' } },
  { ...binding, backend: { ...backend, credentials: 'forbidden' } },
  { ...binding, extra: true },
  { ...binding, bytes: 0 },
])('refuses unknown/ambiguous NAS identity', (value) => {
  expect(readNasUploadWriteBinding(value)).toBeNull();
});
it('does not invoke a getter or accept forged backend authority', () => {
  const get = jest.fn(() => 'nas-s3');
  const hostile = { ...backend };
  Object.defineProperty(hostile, 'kind', { enumerable: true, get });
  expect(readNasS3Backend(hostile)).toBeNull();
  expect(get).not.toHaveBeenCalled();
  expect(readNasS3Backend({ ...backend, configurationSha256: 'unknown' })).toBeNull();
});
