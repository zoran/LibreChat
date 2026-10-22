/** Foreground read-only access to the same File/Upload/HK completion proof used by HK. */
import type {
  FileCleanupCompletionObservation,
  FileCleanupCompletionOptions,
} from '../types/fileCleanup';
import type { HousekeepingJobRecord } from '../models/housekeepingJob';
import type { AcceptedFileCleanupOwner } from './fileCleanupOwners';
import type { FileCleanupRow } from './fileCleanupAuthority';
import type { FileOwnerScope } from '../types/file';
import {
  lifecycle,
  validateStorage,
  derivativesComplete,
  validId,
  same,
} from './fileCleanupCustody';
import { readFileCleanupSnapshot, assertFileCleanupProgress } from './fileCleanupAuthority';
import { managedFileScope, currentFileDeadline } from './fileSourceAuthority';
import { createUploadFileCleanupOwner } from './uploadFileCleanup';

export interface FileCleanupCompletionMethods {
  observeFileCleanupCompletion(
    owner: FileOwnerScope,
    fileIds: readonly string[],
    options: FileCleanupCompletionOptions,
  ): Promise<readonly FileCleanupCompletionObservation[]>;
}
export function createFileCleanupCompletionMethods(
  mongoose: typeof import('mongoose'),
  suppliedUpload?: Pick<AcceptedFileCleanupOwner, 'observeAcceptedFileCleanup'>,
): FileCleanupCompletionMethods {
  // Do not initialize persistence or start a scheduler when composing foreground File methods.
  const upload: Pick<AcceptedFileCleanupOwner, 'observeAcceptedFileCleanup'> = suppliedUpload ?? {
    observeAcceptedFileCleanup: (input, session) =>
      createUploadFileCleanupOwner(mongoose).observeAcceptedFileCleanup(input, session),
  };
  const observeCompletion: FileCleanupCompletionMethods['observeFileCleanupCompletion'] = async (
    who,
    fileIds,
    options,
  ) => {
    const capturedOwner = { userId: who.userId, tenantId: who.tenantId ?? null };
    const scope = managedFileScope(capturedOwner);
    const { signal } = options;
    if (!Array.isArray(fileIds) || !fileIds.every(validId))
      throw new TypeError('FILE_COMPLETION_INPUT');
    const ids = Array.from(new Set(fileIds));
    if (ids.length > 100) throw new TypeError('FILE_COMPLETION_INPUT');
    const unknown = () => ids.map((fileId) => ({ fileId, state: 'unknown' as const }));
    if (!ids.length) return [];
    try {
      return await readFileCleanupSnapshot(mongoose, options, async (session, remaining, endAt) => {
        const results: FileCleanupCompletionObservation[] = [];
        for (const fileId of ids) {
          const file = await mongoose.models.File.findOne({ ...scope, file_id: fileId })
            .select(
              'user tenantId file_id uploadOperationId retentionAcceptedAt expiredAt deletionRequestedAt deletionCompletedAt +retentionActivity +derivedRetention +retentionRevocationId +retentionCleanup',
            )
            .session(session)
            .maxTimeMS(remaining())
            .setOptions({ signal })
            .lean<FileCleanupRow>();
          if (!file) throw new Error('FILE_COMPLETION_UNAVAILABLE');
          const ack = await upload.observeAcceptedFileCleanup(
            { owner: capturedOwner, fileId, deadlineAt: endAt, signal },
            session,
          );
          remaining();
          if (!file.deletionCompletedAt) {
            results.push({ fileId, state: 'pending' });
            continue;
          }
          const value = file.retentionCleanup;
          if (
            !value ||
            !file.deletionRequestedAt ||
            !(file.deletionCompletedAt instanceof Date) ||
            !Number.isSafeInteger(file.deletionCompletedAt.getTime())
          )
            throw new Error('FILE_COMPLETION_CUSTODY');
          const v = lifecycle(value),
            storage = validateStorage(value),
            deadline = currentFileDeadline(file);
          if (
            storage.state !== 'consumed' ||
            v.contentPrepared !== true ||
            !derivativesComplete(value) ||
            !validId(v.completionRef) ||
            deadline.migrationEpoch !== null ||
            v.upload.tenantId !== capturedOwner.tenantId ||
            v.upload.userId !== capturedOwner.userId ||
            v.upload.fileId !== fileId ||
            v.upload.operationId !== file.uploadOperationId
          )
            throw new Error('FILE_COMPLETION_CUSTODY');
          const job = await mongoose.models.HousekeepingJob.findOne({
            _id: value.jobId,
            handler: 'file.cleanup',
            state: 'settled',
            claim: null,
            'execution.id': value.executionId,
            'execution.phase': 'complete',
            'execution.receiptRef': v.completionRef,
            'work.handler': 'file.cleanup',
            'work.subject.tenantId': capturedOwner.tenantId,
            'work.subject.ownerUserId': capturedOwner.userId,
            'work.subject.fileId': fileId,
            'work.revocationId': value.revocationId,
            'work.deadlineGeneration': deadline.deadlineGeneration,
          })
            .session(session)
            .maxTimeMS(remaining())
            .setOptions({ signal })
            .lean<HousekeepingJobRecord>();
          if (
            !job ||
            !(job.terminalAt instanceof Date) ||
            !Number.isSafeInteger(job.terminalAt.getTime())
          )
            throw new Error('FILE_COMPLETION_CUSTODY');
          assertFileCleanupProgress({ file, job });
          if (ack.state === 'pending') throw new Error('FILE_COMPLETION_ACK');
          if (!same(ack.ack, storage.uploadAck)) throw new Error('FILE_COMPLETION_CUSTODY');
          results.push({ fileId, state: 'complete', completionRef: v.completionRef });
        }
        return results;
      });
    } catch {
      return unknown();
    }
  };
  return { observeFileCleanupCompletion: observeCompletion };
}
