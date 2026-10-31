/** promotionOriginal.spec.ts preserves the same-row binding and original owner for both protocols. */
import { readUploadPromotionRecord } from 'librechat-data-provider';
import type {
  UploadPromotionRecord,
  UploadOriginalWriteBinding,
  UploadStorageReceipt,
  UploadPrincipal,
  UploadSecurityApproval,
} from 'librechat-data-provider';
import { reconcilePromotionOriginal } from './promotionOriginal';

/** Synthetic accepted-row metadata only; no engine execution or AV readiness is claimed. */
function syntheticNasApproval(base: UploadSecurityApproval): UploadSecurityApproval {
  const checkedAt = base.checkedAt;
  return {
    ...base,
    version: 2,
    antivirus: {
      engineVersion: 'synthetic-1.4.6',
      readyObservedAt: checkedAt,
      cleanAt: checkedAt,
      custody: {
        version: 1,
        slot: 'synthetic-slot',
        podUid: 'synthetic-pod',
        runtimeImage: 'synthetic@sha256:' + 'd'.repeat(64),
        sourceRevision: 'e'.repeat(40),
        engineArtifactSha256: '1'.repeat(64),
        profileSha256: '2'.repeat(64),
        signatureManifestSha256: '3'.repeat(64),
        signatureVerificationSha256: '4'.repeat(64),
        dailyDatabaseVersion: 1,
        dailyPublishedAt: checkedAt,
        subject: { ...base.subject },
        expiresAt: new Date(Date.parse(checkedAt) + 60000).toISOString(),
        original: {
          id: '11111111-1111-4111-8111-111111111111',
          pid: 123,
          startTicks: '1',
          bootId: '22222222-2222-4222-8222-222222222222',
          configurationSha256: '5'.repeat(64),
        },
      },
    },
  };
}

function fixture(version: 1 | 2) {
  const principal: UploadPrincipal = {
    authentication: 'verified-email',
    tenantId: 'tenant',
    userId: 'owner',
  };
  const backend = {
    kind: 'nas-s3' as const,
    protocol: 'acknowledged-only-v1' as const,
    uid: 'private-backend',
    configurationSha256: 'a'.repeat(64),
  };
  const key =
    version === 2 ? 'originals/opaque-server-key' : 't/tenant/managed-uploads/owner/op.2__original';
  const base = {
    bucket: 'private-files',
    key,
    operationId: 'op',
    generation: '2',
    bytes: 5,
    wholeSHA256: 'b'.repeat(64),
    mediaType: 'text/plain',
    originalDeadline: '2099-01-01T00:00:00.000Z',
  };
  const binding: UploadOriginalWriteBinding =
    version === 2 ? { ...base, version: 2, backend } : { ...base, version: 1 };
  const record: UploadPromotionRecord = {
    version: 1,
    promotionId: '11111111-1111-4111-8111-111111111111',
    lease: {
      tenantId: principal.tenantId,
      userId: principal.userId,
      operationId: 'op',
      generation: 2,
      kind: 'transfer',
      hostId: 'host',
      instanceId: 'instance',
      expiresAt: base.originalDeadline,
    },
    worker: { hostId: 'writer', instanceId: 'original' },
    state: 'writing',
    writerStopped: false,
    metadata: { filename: 'note.txt' },
    integrity: {
      version: 1,
      algorithm: 'sha256',
      sha256: 'b'.repeat(64),
      chunkBytes: 262144,
      chunkSha256: ['b'.repeat(64)],
    },
    approval: {
      version: 1,
      decision: 'approved',
      policySha256: 'c'.repeat(64),
      scannerVersion: 'synthetic',
      checkedAt: '2026-10-30T00:00:00.000Z',
      coverage: { complete: true, pages: 1, parts: 1 },
      subject: {
        tenantId: principal.tenantId,
        userId: principal.userId,
        operationId: 'op',
        transferGeneration: 2,
        mediaType: 'text/plain',
        bytes: 5,
        sha256: 'b'.repeat(64),
      },
    },
  };
  if (version === 2) record.approval = syntheticNasApproval(record.approval);
  const receipt: UploadStorageReceipt = {
    outcome: 'durable',
    source: version === 2 ? 'nas-s3' : 's3',
    storageKey: key,
    bytes: 5,
    filepath: '/api/files/managed/op',
    ...(version === 2 ? { backend } : {}),
    integrity: record.integrity,
  };
  const repository = {
    readOriginalWrite: jest.fn(
      async (
        _principal: UploadPrincipal,
        _id: string,
      ): Promise<UploadOriginalWriteBinding | null> => binding,
    ),
    settlePromotion: jest.fn(async () => ({
      ...record,
      state: 'settled' as const,
      writerStopped: true,
      receipt,
    })),
  };
  const storage = { observeOriginal: jest.fn(async () => receipt) };
  const run = () =>
    reconcilePromotionOriginal({
      record,
      repository,
      options: { storage },
      ctx: { operationId: 'op' },
      auth: { principal },
      signal: new AbortController().signal,
      now: () => 1,
    });
  return { principal, binding, record, receipt, repository, storage, run };
}

it.each([1, 2] as const)(
  'uses exactly the same persisted v%s row and authenticated owner',
  async (version) => {
    const f = fixture(version);
    expect(readUploadPromotionRecord(f.record, version === 1)).not.toBeNull();
    await f.run();
    expect(f.repository.readOriginalWrite).toHaveBeenCalledTimes(1);
    expect(f.repository.readOriginalWrite).toHaveBeenCalledWith(f.principal, 'op');
    expect(f.storage.observeOriginal).toHaveBeenCalledWith(
      expect.objectContaining({ principal: f.principal, binding: f.binding }),
    );
    expect(f.repository.settlePromotion).toHaveBeenCalledTimes(1);
  },
);
it('keeps an unknown NAS original pending without replacement dispatch or settlement', async () => {
  const f = fixture(2);
  f.receipt.outcome = 'unknown';
  await expect(f.run()).resolves.toBe(f.record);
  expect(f.repository.readOriginalWrite).toHaveBeenCalledTimes(1);
  expect(f.repository.settlePromotion).not.toHaveBeenCalled();
});
it('does not observe another original content binding', async () => {
  const f = fixture(2);
  f.repository.readOriginalWrite.mockResolvedValue({ ...f.binding, wholeSHA256: 'd'.repeat(64) });
  await expect(f.run()).resolves.toBe(f.record);
  expect(f.storage.observeOriginal).not.toHaveBeenCalled();
});
