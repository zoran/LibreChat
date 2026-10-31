import { antivirusFixture } from '../../../data-provider/src/__fixtures__/upload-antivirus';
/** Focused real write-owner persistence/fencing behavior; in-memory store port, no Mongo/native claims. */
import type { UploadManagementContext } from './uploadManagementContext';
import type { StoredUpload } from './uploadManagementStore';
import { createUploadWriteMethods } from './uploadManagementWrite';

const now = Date.UTC(2026, 9, 26, 13, 0, 0);
const lease = {
  tenantId: 'tenant',
  userId: 'user',
  operationId: 'operation',
  generation: 2,
  kind: 'transfer' as const,
  hostId: 'host',
  instanceId: 'instance',
  expiresAt: new Date(now + 45000).toISOString(),
};
const input = {
  bucket: 'cortex-managed-uploads',
  key: 't/tenant/managed-uploads/user/operation.2__original',
  operationId: 'operation',
  generation: '2',
  bytes: 5,
  wholeSHA256: 'a'.repeat(64),
  mediaType: 'text/plain',
};
const integrity = {
  version: 1 as const,
  algorithm: 'sha256' as const,
  sha256: input.wholeSHA256,
  chunkBytes: 262144,
  chunkSha256: ['b'.repeat(64)],
};
const antivirus = antivirusFixture(
  {
    tenantId: 'tenant',
    userId: 'user',
    operationId: 'operation',
    transferGeneration: 2,
    mediaType: 'text/plain',
    bytes: 5,
    sha256: input.wholeSHA256,
  },
  now,
);
const execution = {
  version: 3 as const,
  antivirus: antivirus.custody,
  custody: { kind: 'none' as const },
  attemptId: 'operation.2',
  instanceId: '11111111-1111-4111-8111-111111111111',
  executionId: '22222222-2222-4222-8222-222222222222',
  expiresAt: new Date(now + 60000).toISOString(),
};
const policy = 'c'.repeat(64);
const approval = {
  version: 2 as const,
  antivirus: antivirus.approval,
  decision: 'approved' as const,
  policySha256: policy,
  subject: {
    tenantId: 'tenant',
    userId: 'user',
    operationId: 'operation',
    transferGeneration: 2,
    mediaType: 'text/plain',
    bytes: 5,
    sha256: input.wholeSHA256,
  },
  scannerVersion: 'fixture',
  checkedAt: new Date(now).toISOString(),
  coverage: { complete: true as const, pages: 1, parts: 1 },
};
function fixture() {
  let stored = {
    _id: 'operation',
    tenantId: 'tenant',
    userId: 'user',
    generation: 2,
    attemptGeneration: 2,
    slot: 'transfer',
    state: 'transferring',
    worker: { hostId: 'host', instanceId: 'instance' },
    leaseExpiresAt: now + 45000,
    declaredBytes: 5,
    mediaType: 'text/plain',
    securityExecution: execution,
    securitySettlement: {
      execution,
      writerStopped: true,
      transientDataRemoved: true,
      antivirusReceipt: antivirus.receipt,
    },
  } as StoredUpload;
  const read = () => ({
    session: () => ({ lean: async () => JSON.parse(JSON.stringify(stored)) }),
    lean: async () => JSON.parse(JSON.stringify(stored)),
  });
  const store = {
    Operation: {
      findById: read,
      findOne: jest.fn((where) => ({
        lean: async () =>
          where.tenantId === stored.tenantId && where.userId === stored.userId
            ? JSON.parse(JSON.stringify(stored))
            : null,
      })),
    },
    transaction: async <T>(run: (session: { fixture: boolean }) => Promise<T>): Promise<T> =>
      run({ fixture: true }),
    save: jest.fn(async (row) => {
      stored = JSON.parse(JSON.stringify(row));
    }),
  };
  const owner = () =>
    createUploadWriteMethods({
      store,
      securityPolicySha256: policy,
    } as unknown as UploadManagementContext);
  return { owner, store, row: () => stored };
}
it('persists once, survives owner replacement and returns the original deadline on exact retry', async () => {
  const f = fixture();
  const first = await f.owner().bindOriginalWrite(lease, input, integrity, approval, now);
  expect(first.originalDeadline).toBe(new Date(now + 300000).toISOString());
  expect(f.row().writeBinding).toEqual(first);
  (first as { originalDeadline: string }).originalDeadline = '2099-01-01T00:00:00.000Z';
  const again = await f.owner().bindOriginalWrite(lease, input, integrity, approval, now + 1);
  expect(again.originalDeadline).toBe(new Date(now + 300000).toISOString());
  expect(f.store.save).toHaveBeenCalledTimes(1);
});
it.each(['bucket', 'wholeSHA256', 'key', 'bytes', 'mediaType', 'generation', 'operationId'])(
  'refuses changed immutable field %s without replacing the stored binding',
  async (field) => {
    const f = fixture();
    const original = await f.owner().bindOriginalWrite(lease, input, integrity, approval, now);
    const changed = {
      ...input,
      [field]:
        (
          { bytes: 4, bucket: 'another-bucket', wholeSHA256: 'd'.repeat(64) } as Record<
            string,
            unknown
          >
        )[field] ?? 'foreign',
    };
    await expect(
      f.owner().bindOriginalWrite(lease, changed, integrity, approval, now + 1),
    ).rejects.toThrow();
    expect(f.row().writeBinding).toEqual(original);
    expect(f.store.save).toHaveBeenCalledTimes(1);
  },
);
it('rejects stale worker and incomplete security before persisting or minting a deadline', async () => {
  const f = fixture();
  await expect(
    f
      .owner()
      .bindOriginalWrite({ ...lease, instanceId: 'foreign' }, input, integrity, approval, now),
  ).rejects.toThrow();
  f.row().securitySettlement = undefined;
  await expect(
    f.owner().bindOriginalWrite(lease, input, integrity, approval, now),
  ).rejects.toThrow();
  expect(f.store.save).not.toHaveBeenCalled();
});
it('permits scoped read-only reconciliation after expiry without saving or granting a new deadline', async () => {
  const f = fixture();
  const binding = await f.owner().bindOriginalWrite(lease, input, integrity, approval, now);
  f.row().leaseExpiresAt = now;
  expect(
    await f
      .owner()
      .readOriginalWrite(
        { tenantId: 'tenant', userId: 'user', authentication: 'verified-email' },
        'operation',
      ),
  ).toEqual(binding);
  await expect(
    f
      .owner()
      .readOriginalWrite(
        { tenantId: 'foreign', userId: 'user', authentication: 'verified-email' },
        'operation',
      ),
  ).rejects.toThrow();
  expect(f.store.save).toHaveBeenCalledTimes(1);
});
