/** Historical projection specimens and the original port-boundary cohort; actual Mongo/BSON cases remain in the owner spec. */
import { UPLOAD_REPLAY_MS, UPLOAD_RECORD_BYTES } from 'librechat-data-provider';
import type mongoose from 'mongoose';
import type { StoredUpload } from '../../src/methods/uploadManagementStore';
import type { HousekeepingJobRecord } from '../../src/models/housekeepingJob';
import type { HousekeepingStore } from '../../src/methods/housekeepingStore';
import {
  createUploadHousekeepingProjection,
  uploadHousekeepingDue,
  uploadHousekeepingWork,
} from '../../src/methods/uploadHousekeepingProjection';
import { WAIT_MS } from '../../src/methods/uploadManagementStore';

export const row = (): StoredUpload => ({
  _id: 'operation',
  tenantId: null,
  userId: '111111111111111111111111',
  scope: { kind: 'personal' },
  idempotencyKey: '11111111-1111-4111-8111-111111111111',
  fingerprint: 'fixture',
  mediaType: 'text/plain',
  declaredBytes: 8,
  state: 'waiting',
  revision: 0,
  createdAt: 1_700_000_000_000,
  cleanupPending: false,
  generation: 0,
  originalBytes: 8,
  textBytes: 0,
  recordBytes: UPLOAD_RECORD_BYTES,
  queueCharged: true,
  pendingBytes: 8,
  stagingHeld: false,
  writerStopped: true,
});
export function job(operation: StoredUpload): HousekeepingJobRecord {
  const dueAt = uploadHousekeepingDue(operation);
  return {
    _id: 'a'.repeat(64),
    version: 1,
    identityHash: 'a'.repeat(64),
    handler: 'upload.cleanup',
    work: uploadHousekeepingWork(operation),
    subjectId: operation._id,
    generation: operation.generation,
    dueAt,
    nextAttemptAt: dueAt,
    state: 'queued',
    fence: 0,
    progressRevision: 0,
    attempts: 0,
    recoveries: 0,
    lastRecoveryAt: null,
    claim: null,
    execution: { id: 'execution', phase: 'awaiting_owner_transition', receiptRef: null },
    lastCode: 'scheduled',
    createdAt: new Date(),
    updatedAt: new Date(),
    terminalAt: null,
  };
}

export function registerUploadSchedulingProjectionCases(
  describe: jest.Describe,
  it: jest.It,
): void {
  describe('Upload scheduling projection port boundary', () => {
    // Only the session boundary is simulated here; real transaction assertions are below.
    const session = { inTransaction: () => true } as mongoose.ClientSession;
    const ports = () => ({
      observeWork: jest.fn<
        ReturnType<HousekeepingStore['observeWork']>,
        Parameters<HousekeepingStore['observeWork']>
      >(),
      project: jest
        .fn<ReturnType<HousekeepingStore['project']>, Parameters<HousekeepingStore['project']>>()
        .mockResolvedValue('a'.repeat(64)),
      refreshDue: jest
        .fn<
          ReturnType<HousekeepingStore['refreshDue']>,
          Parameters<HousekeepingStore['refreshDue']>
        >()
        .mockResolvedValue('unchanged'),
      invalidate: jest
        .fn<
          ReturnType<HousekeepingStore['invalidate']>,
          Parameters<HousekeepingStore['invalidate']>
        >()
        .mockResolvedValue(false),
    });
    it('projects generation zero and the waiting deadline in the supplied transaction', async () => {
      const owner = ports();
      owner.observeWork.mockResolvedValue(null);
      const operation = row();
      await expect(
        createUploadHousekeepingProjection(owner)(null, operation, session),
      ).resolves.toBe(true);
      expect(owner.project).toHaveBeenCalledWith(
        uploadHousekeepingWork(operation),
        new Date(operation.createdAt + WAIT_MS),
        session,
      );
    });
    it('never turns accepted File expiry or extension into an Upload expiry job', () => {
      const operation = {
        ...row(),
        state: 'ready' as const,
        acceptedAt: row().createdAt,
        expiresAt: row().createdAt + 1,
        fileId: 'operation',
      };
      expect(uploadHousekeepingDue(operation).getTime()).toBe(
        operation.createdAt + UPLOAD_REPLAY_MS,
      );
      expect(
        uploadHousekeepingDue({ ...operation, expiresAt: operation.expiresAt + 7 * 86400000 }),
      ).toEqual(uploadHousekeepingDue(operation));
    });
    it('keeps pending cleanup scheduling stable across repeated observations', () => {
      const operation = { ...row(), state: 'failed' as const, cleanupPending: true };
      expect(uploadHousekeepingDue(operation)).toEqual(new Date(operation.createdAt));
    });
    it('reports an updated current projection so callers stop using the fenced claim', async () => {
      const owner = ports();
      const operation = row();
      const current = job(operation);
      owner.observeWork.mockResolvedValue(current);
      owner.refreshDue.mockResolvedValue('updated');
      await expect(
        createUploadHousekeepingProjection(owner)(null, operation, session),
      ).resolves.toBe(true);
      expect(owner.refreshDue).toHaveBeenCalledWith(
        uploadHousekeepingWork(operation),
        { jobId: current._id, executionId: current.execution.id, progressRevision: 0 },
        current.dueAt,
        session,
      );
    });
    it('preserves a started predecessor while projecting the new generation', async () => {
      const owner = ports();
      const previous = row();
      const next = { ...previous, generation: 1 };
      const old = { ...job(previous), state: 'unknown' as const };
      old.execution.phase = 'removing_unaccepted_original';
      owner.observeWork.mockResolvedValueOnce(old).mockResolvedValueOnce(null);
      await expect(
        createUploadHousekeepingProjection(owner)(previous, next, session),
      ).resolves.toBe(true);
      expect(owner.invalidate).toHaveBeenCalledWith(old._id, 0, session);
      expect(owner.project).toHaveBeenCalledWith(
        uploadHousekeepingWork(next),
        uploadHousekeepingDue(next),
        session,
      );
      expect(old.state).toBe('unknown');
      expect(old.execution.phase).toBe('removing_unaccepted_original');
    });
    it('leaves preserved/unknown current work intact without regenerating execution identity', async () => {
      const owner = ports();
      const operation = row();
      owner.observeWork.mockResolvedValue(job(operation));
      owner.refreshDue.mockResolvedValue('preserved');
      await expect(
        createUploadHousekeepingProjection(owner)(null, operation, session),
      ).resolves.toBe(false);
      expect(owner.project).not.toHaveBeenCalled();
      expect(owner.invalidate).not.toHaveBeenCalled();
    });
    it('fails a stale projection CAS without an internal generic retry', async () => {
      const owner = ports();
      const operation = row();
      owner.observeWork.mockResolvedValue(job(operation));
      owner.refreshDue.mockResolvedValue('stale');
      await expect(
        createUploadHousekeepingProjection(owner)(null, operation, session),
      ).rejects.toThrow('UPLOAD_HOUSEKEEPING_CAS_LOST');
      expect(owner.refreshDue).toHaveBeenCalledTimes(1);
    });
  });
}
