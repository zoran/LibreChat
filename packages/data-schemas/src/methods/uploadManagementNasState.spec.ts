/** NAS File custody never aliases legacy replica receipts or unconsumed shape-only proof. */
import type { FileCleanupProgress } from '../types/fileCleanup';
import type { IMongoFile } from '../types/file';
import { fileCleanupReady, validateNasFileStorage, validateStorage } from './fileCleanupCustody';
import { uploadDigest } from './uploadManagementState';

function file(): IMongoFile {
  const backend = {
    kind: 'nas-s3' as const,
    uid: 'nas',
    configurationSha256: 'a'.repeat(64),
    protocol: 'acknowledged-only-v1' as const,
  };
  const receipt = {
    protocol: 'nas-acknowledged-delete-v1' as const,
    scope: 'nas-live-key-absent' as const,
    backend,
    bindingSha256: 'b'.repeat(64),
    requestId: '11111111-1111-4111-8111-111111111111',
    originalTerminal: 'acknowledged' as const,
    deleteStatus: 204 as const,
    absenceStatus: 404 as const,
  };
  const receiptSHA256 = uploadDigest(receipt);
  const p = {
    schema: 1,
    revocationId: 'revocation',
    jobId: 'job',
    executionId: 'execution',
    capture: { complete: true, recoveryUnresolved: false, cursor: null },
    generationReceiptRef: 'joined',
    lifecycle: {
      upload: {
        tenantId: 'tenant',
        userId: 'user',
        fileId: 'file',
        operationId: 'operation',
        cleanupGeneration: 3,
        attemptGeneration: 2,
        originalKey: 'key',
        originalSource: 's3',
        originalBytes: 5,
        acceptedObjectSHA256: 'c'.repeat(64),
        backend,
        originalWriteBindingSha256: receipt.bindingSha256,
      },
      derivatives: {
        retrieval: 'complete',
        checkpoints: 'complete',
        messages: 'complete',
        messageCursor: null,
      },
      storage: null,
      nasStorage: {
        state: 'consumed',
        receipt,
        receiptSHA256,
        consumerCommitId: 'consumer',
        uploadAck: {
          reference: 'reference',
          operationId: 'operation',
          cleanupGeneration: 3,
          attemptGeneration: 2,
          revocationId: 'revocation',
          receiptSHA256,
        },
      },
      contentPrepared: true,
      completionRef: 'completion',
    },
  } as FileCleanupProgress;
  return { retentionRevocationId: 'revocation', retentionCleanup: p } as IMongoFile;
}
it('accepts exact consumed NAS custody but never validates it as the old managed receipt', () => {
  const f = file();
  expect(fileCleanupReady(f, true)).toBe(true);
  expect(() => validateStorage(f.retentionCleanup!)).toThrow();
  expect(validateNasFileStorage(f.retentionCleanup!).receipt.scope).toBe('nas-live-key-absent');
});
it.each(['receipt', 'uploadAck', 'consumerCommitId'])(
  'rejects a missing retained consumption prerequisite %s',
  (key) => {
    const f = file();
    delete (f.retentionCleanup!.lifecycle!.nasStorage as unknown as Record<string, unknown>)[key];
    expect(fileCleanupReady(f, true)).toBe(false);
  },
);
it('refuses changed backend identity and cannot merge concurrent old and NAS receipt branches', () => {
  const f = file();
  expect(f.retentionCleanup!.lifecycle!.nasStorage!.receipt.backend.configurationSha256).toMatch(
    /^[a-f0-9]{64}$/,
  );
  f.retentionCleanup!.lifecycle!.upload.backend = {
    ...f.retentionCleanup!.lifecycle!.upload.backend!,
    uid: 'foreign',
  };
  expect(fileCleanupReady(f, true)).toBe(false);
  const g = file();
  g.retentionCleanup!.lifecycle!.storage = { state: 'binding', request: {} } as never;
  expect(fileCleanupReady(g, true)).toBe(false);
});
