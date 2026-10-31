/** Actual cohort charge/upgrade/refund primitives preserve historical32KiB and the4GiB pool. */
import { mongo } from 'mongoose';
import { UPLOAD_RECORD_BYTES, UPLOAD_AV_RECORD_BYTES } from 'librechat-data-provider';
import type { StoredUpload, GlobalState } from './uploadManagementStore';
import type { UploadManagementContext } from './uploadManagementContext';
import {
  uploadRecordBudget,
  releaseUploadRecordCharge,
  assertUploadCleanupCapacity,
} from './uploadManagementState';
import { antivirusFixture } from '../../../data-provider/src/__fixtures__/upload-antivirus';
import { createUploadProcessingMethods } from './uploadManagementProcessing';
import { upgradeUploadAvRecord } from './uploadManagement.security';
import { RESOURCE_MAX } from './uploadManagementStore';
const old = (): StoredUpload =>
  ({ recordBytes: UPLOAD_RECORD_BYTES, state: 'waiting' }) as StoredUpload;
it('does not retag an old record on read and refunds each actual mixed cohort charge', () => {
  const legacy = old(),
    current = { ...old(), recordBytes: UPLOAD_AV_RECORD_BYTES };
  const global = { recordBytes: legacy.recordBytes + current.recordBytes };
  expect(uploadRecordBudget(legacy)).toBe(32768);
  expect(legacy.recordBytes).toBe(32768);
  releaseUploadRecordCharge(legacy, global);
  expect(global.recordBytes).toBe(65536);
  releaseUploadRecordCharge(current, global);
  expect(global.recordBytes).toBe(0);
  expect(RESOURCE_MAX.recordBytes).toBe(4 * 1073741824);
  expect(RESOURCE_MAX.bundles).toBe(100000);
});
it('charges the delta exactly once before a new AV binding and preserves aggregate totals', () => {
  const row = old(),
    global = { recordBytes: 32768 + 65536, reconciled: true } as GlobalState;
  upgradeUploadAvRecord(row, global);
  expect(row.recordBytes).toBe(65536);
  expect(global.recordBytes).toBe(131072);
  upgradeUploadAvRecord(row, global);
  expect(global.recordBytes).toBe(131072);
});
it('denies a full pool or accepted historical upcharge before changing either owner', () => {
  for (const acceptedAt of [undefined, 1]) {
    const row = { ...old(), ...(acceptedAt === undefined ? {} : { acceptedAt }) };
    const global = { recordBytes: RESOURCE_MAX.recordBytes, reconciled: true } as GlobalState;
    expect(() => upgradeUploadAvRecord(row, global)).toThrow('capacity_exceeded');
    expect(row.recordBytes).toBe(32768);
    expect(global.recordBytes).toBe(RESOURCE_MAX.recordBytes);
  }
});
it('bounds actual BSON by its charged cohort, never by a raised global fallback', () => {
  const oldRow = { ...old(), extra: 'x'.repeat(40000) },
    current = { ...oldRow, recordBytes: 65536 };
  expect(() => assertUploadCleanupCapacity(oldRow, mongo.BSON.calculateObjectSize)).toThrow(
    'capacity_exceeded',
  );
  expect(() => assertUploadCleanupCapacity(current, mongo.BSON.calculateObjectSize)).not.toThrow();
});
it('binds through the real processing owner only after its same-transaction capacity upgrade', async () => {
  const now = Date.UTC(2026, 9, 30, 21);
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
  const av = antivirusFixture(
    {
      tenantId: 'tenant',
      userId: 'user',
      operationId: 'operation',
      transferGeneration: 2,
      mediaType: 'text/plain',
      bytes: 5,
      sha256: 'a'.repeat(64),
    },
    now,
  );
  const execution = {
    version: 3 as const,
    attemptId: 'operation.2',
    instanceId: '11111111-1111-4111-8111-111111111111',
    executionId: '22222222-2222-4222-8222-222222222222',
    expiresAt: av.custody.expiresAt,
    custody: { kind: 'none' as const },
    antivirus: av.custody,
  };
  for (const full of [false, true]) {
    let row = {
      ...old(),
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
    } as StoredUpload;
    const global = {
      recordBytes: full ? RESOURCE_MAX.recordBytes : 32768,
      reconciled: true,
    } as GlobalState;
    const save = jest.fn(async (value: StoredUpload) => {
      row = JSON.parse(JSON.stringify(value));
    });
    const store = {
      Operation: {
        findById: () => ({
          session: () => ({ lean: async () => JSON.parse(JSON.stringify(row)) }),
        }),
      },
      save,
      transaction: async (run: (s: unknown, g: GlobalState) => Promise<void>) => run({}, global),
    };
    const owner = createUploadProcessingMethods({ store } as unknown as UploadManagementContext);
    if (full) {
      await expect(owner.bindSecurityExecution(lease, execution, now)).rejects.toMatchObject({
        code: 'capacity_exceeded',
      });
      expect(save).not.toHaveBeenCalled();
      expect(row.securityExecution).toBeUndefined();
      expect(row.recordBytes).toBe(32768);
      expect(global.recordBytes).toBe(RESOURCE_MAX.recordBytes);
    } else {
      await owner.bindSecurityExecution(lease, execution, now);
      expect(row.recordBytes).toBe(65536);
      expect(global.recordBytes).toBe(65536);
      expect(row.securityExecution).toEqual(execution);
      await owner.bindSecurityExecution(lease, execution, now + 1);
      expect(save).toHaveBeenCalledTimes(1);
      expect(global.recordBytes).toBe(65536);
    }
  }
});
