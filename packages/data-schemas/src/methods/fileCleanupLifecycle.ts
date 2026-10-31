import type { AcceptedFileCleanupOwner } from './fileCleanupOwners';
export type { AcceptedFileCleanupOwner, AcceptedFileCleanupInput } from './fileCleanupOwners';
import {
  lifecycle,
  derivativesComplete,
  validateStorage,
  validateNasFileStorage,
  validId,
  same,
  digest,
  assertFileStorageHeadroom,
} from './fileCleanupCustody';
import { createFileCleanupCompletionMethods } from './fileCleanupCompletion';
export { assertFileStorageHeadroom } from './fileCleanupCustody';
/** Accepted File cleanup; the File owns request/receipt custody, Upload owns its accounting. */
import { randomUUID } from 'node:crypto';
import {
  isStorageDeletionBinding,
  isStorageDeletionResult,
  isStorageDeletionConsumptionResult,
  canonicalStorageDeletionReceipt,
} from 'librechat-data-provider';
import type {
  StorageDeletionBinding,
  StorageDeletionResult,
  StorageDeletionConsumptionResult,
} from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type {
  FileCleanupProgress,
  FileCleanupExpectation,
  FileCleanupProgressResult,
  FileCleanupCompletionObservation,
  FileCleanupCompletionOptions,
} from '../types/fileCleanup';
import type { MessageSourceCleanupMethod } from './messageSourceCleanup';
import type { HousekeepingStore } from './housekeepingStore';
import type { JobClaim } from '../types/housekeeping';
import type { FileOwnerScope } from '../types/file';
import {
  createFileCleanupAuthority,
  FileCleanupPending as Pending,
  FileCleanupLost as Lost,
} from './fileCleanupAuthority';
import { managedFileRetrievalDeletionSettled } from './fileRetrieval';
import { tenantStorage } from '../config/tenantContext';
import { currentTenantScope } from '../tenant/policy';

export interface FileCleanupRetentionOwner {
  settleFileSourceDeletionInSession(
    owner: FileOwnerScope,
    fileId: string,
    finalize: boolean,
    session: ClientSession,
  ): Promise<boolean>;
}
/** Required actual owner operations; no caller-supplied derivative completion flags exist. */
export interface FileCleanupDerivativeOwners {
  purgeRetrieval(
    owner: FileOwnerScope,
    fileIds: readonly string[],
    signal: AbortSignal,
  ): Promise<void>;
  purgeCheckpoints(owner: FileOwnerScope, fileIds: readonly string[]): Promise<void>;
  redactFileSourceContent: MessageSourceCleanupMethod;
}
export interface FileCleanupLifecycleMethods {
  observeCompletion(
    owner: FileOwnerScope,
    fileIds: readonly string[],
    options: FileCleanupCompletionOptions,
  ): Promise<readonly FileCleanupCompletionObservation[]>;
  begin(claim: JobClaim, signal: AbortSignal): Promise<FileCleanupProgressResult>;
  observe(claim: JobClaim, signal: AbortSignal): Promise<FileCleanupProgressResult>;
  purgeDerivatives(claim: JobClaim, signal: AbortSignal): Promise<FileCleanupProgressResult>;
  prepareStorage(claim: JobClaim, signal: AbortSignal): Promise<FileCleanupProgressResult>;
  bindStorage(
    claim: JobClaim,
    expected: FileCleanupExpectation,
    binding: StorageDeletionBinding,
    signal: AbortSignal,
  ): Promise<FileCleanupProgressResult>;
  recordStorage(
    claim: JobClaim,
    expected: FileCleanupExpectation,
    result: StorageDeletionResult,
    signal: AbortSignal,
  ): Promise<FileCleanupProgressResult>;
  commitConsumption(claim: JobClaim, signal: AbortSignal): Promise<FileCleanupProgressResult>;
  recordConsumption(
    claim: JobClaim,
    expected: FileCleanupExpectation,
    result: StorageDeletionConsumptionResult,
    signal: AbortSignal,
  ): Promise<FileCleanupProgressResult>;
  finalize(claim: JobClaim, signal: AbortSignal): Promise<FileCleanupProgressResult>;
}
function owner(claim: JobClaim): FileOwnerScope {
  if (claim.work.handler !== 'file.cleanup') throw new Pending('owner_pending');
  return { userId: claim.work.subject.ownerUserId, tenantId: claim.work.subject.tenantId };
}
export function createFileCleanupLifecycleMethods(
  mongoose: typeof import('mongoose'),
  store: HousekeepingStore,
  upload: AcceptedFileCleanupOwner,
  retention: FileCleanupRetentionOwner,
  derivatives: FileCleanupDerivativeOwners,
): FileCleanupLifecycleMethods {
  const a = createFileCleanupAuthority(mongoose, store);
  const mustOwner = <T extends { state: string }>(result: T): T => {
    if (result.state === 'lost') throw new Lost();
    if (result.state === 'pending') throw new Pending('owner_pending');
    return result;
  };
  async function authorize(
    claim: JobClaim,
    context: import('./fileCleanupAuthority').FileCleanupContext,
    session: ClientSession,
  ): Promise<void> {
    const value = a.progress(context);
    const v = lifecycle(value);
    const scope = a.targetScope(claim);
    if (
      v.upload.tenantId !== scope.tenantId ||
      v.upload.userId !== scope.ownerUserId ||
      v.upload.fileId !== scope.fileId ||
      v.upload.operationId !== context.file.uploadOperationId
    )
      throw new Pending('invalid_upload_binding');
    const storage = v.nasStorage ? validateNasFileStorage(value) : v.storage;
    if (storage && !v.nasStorage) validateStorage(value);
    if (storage?.state === 'committed' || storage?.state === 'consumed') {
      if (!v.nasStorage) validateStorage(value);
      const result = mustOwner(await upload.acknowledgeAcceptedFileCleanup({ claim }, session));
      if (result.state !== 'acknowledged' || !same(result.ack, storage.uploadAck))
        throw new Pending('owner_pending');
    } else {
      const result = mustOwner(await upload.fenceAcceptedFileCleanup({ claim }, session));
      if (result.state !== 'bound' || !same(result.binding, v.upload))
        throw new Pending('owner_pending');
    }
  }
  const observe: FileCleanupLifecycleMethods['observe'] = (claim, signal) =>
    a.transaction(signal, async (session) => {
      const c = await a.load(claim, session);
      await authorize(claim, c, session);
      return a.save(claim, c, a.progress(c), c.job.execution.phase, session);
    });
  const { observeFileCleanupCompletion: observeCompletion } = createFileCleanupCompletionMethods(
    mongoose,
    upload,
  );
  return {
    observe,
    observeCompletion,
    begin(claim, signal) {
      return a.transaction(signal, async (session) => {
        const c = await a.load(claim, session);
        if (c.file.retentionCleanup?.lifecycle) {
          await authorize(claim, c, session);
          return a.save(claim, c, a.progress(c), c.job.execution.phase, session);
        }
        if (c.job.execution.phase !== 'revoked') throw new Pending('owner_pending');
        const bound = mustOwner(await upload.fenceAcceptedFileCleanup({ claim }, session));
        if (bound.state !== 'bound') throw new Pending('owner_pending');
        const scope = a.targetScope(claim);
        if (
          bound.binding.tenantId !== scope.tenantId ||
          bound.binding.userId !== scope.ownerUserId ||
          bound.binding.fileId !== scope.fileId ||
          bound.binding.operationId !== c.file.uploadOperationId
        )
          throw new Pending('invalid_upload_binding');
        const value: FileCleanupProgress = c.file.retentionCleanup ?? {
          schema: 1,
          revocationId: scope.revocationId,
          jobId: claim.jobId,
          executionId: claim.executionId,
          capture: { cursor: null, complete: false, recoveryUnresolved: false },
          generationReceiptRef: null,
        };
        value.lifecycle = {
          upload: bound.binding,
          derivatives: {
            retrieval: 'pending',
            checkpoints: 'pending',
            messages: 'pending',
            messageCursor: null,
          },
          storage: null,
          contentPrepared: false,
          completionRef: null,
        };
        lifecycle(value);
        // Budget only, never persisted or used as a receipt: JSON escaping is worst-case per character.
        assertFileStorageHeadroom(value, {
          protocol: 1,
          requestId: 'x'.repeat(128),
          generation: String(bound.binding.attemptGeneration),
          authorityBindingSHA256: 'a'.repeat(64),
          acceptedObjectSHA256: bound.binding.acceptedObjectSHA256,
          bucket: '\ud800'.repeat(255),
          key: bound.binding.originalKey,
        });
        return a.save(claim, c, value, 'revoked', session);
      });
    },
    async purgeDerivatives(claim, signal) {
      const ambient = tenantStorage.getStore();
      const active = currentTenantScope();
      // A background claim never permits crossing a real request's tenant scope.
      if (active.kind === 'scoped' && active.tenantId !== owner(claim).tenantId)
        return { state: 'unknown' };
      const before = await a.transaction(signal, async (session) => {
        const c = await a.load(claim, session);
        await authorize(claim, c, session);
        const value = a.progress(c);
        lifecycle(value);
        if (
          c.job.execution.phase !== 'purging_derivatives' ||
          !value.generationReceiptRef ||
          value.capture.recoveryUnresolved
        )
          throw new Pending('owner_pending');
        return a.save(claim, c, value, 'purging_derivatives', session);
      });
      if (before.state !== 'progress') return before;
      const v = lifecycle(before.progress);
      const who = { userId: v.upload.userId, tenantId: v.upload.tenantId };
      const ids = [v.upload.fileId];
      let stage: 'retrieval' | 'checkpoints' | 'messages' = 'messages';
      if (v.derivatives.retrieval !== 'complete') stage = 'retrieval';
      else if (v.derivatives.checkpoints !== 'complete') stage = 'checkpoints';
      if (derivativesComplete(before.progress)) return before;
      try {
        a.checkSignal(signal);
        let messageResult: Awaited<ReturnType<MessageSourceCleanupMethod>> | undefined;
        if (stage === 'retrieval') await derivatives.purgeRetrieval(who, ids, signal);
        else if (stage === 'checkpoints') await derivatives.purgeCheckpoints(who, ids);
        else {
          // This exact File/Upload/HK owner was authorized above. Narrow even a system
          // discovery context, and await the original operation inside the async scope.
          messageResult = await tenantStorage.run(
            { ...ambient, tenantId: who.tenantId ?? undefined, userId: who.userId },
            async () =>
              await derivatives.redactFileSourceContent(who, ids, {
                signal,
                deadlineAt: Date.now() + 10000,
                limit: 25,
                cursor: v.derivatives.messageCursor,
              }),
          );
        }
        return await a.transaction(signal, async (session) => {
          const c = await a.load(claim, session);
          const value = a.progress(c);
          const current = lifecycle(value);
          if (
            c.job.progressRevision !== before.expected.jobRevision ||
            c.job.execution.phase !== 'purging_derivatives'
          )
            throw new Lost();
          if (stage === 'retrieval' && !managedFileRetrievalDeletionSettled(c.file))
            throw new Pending('retrieval_pending');
          if (stage === 'messages') {
            if (!messageResult) throw new Pending('message_pending');
            current.derivatives.messageCursor = messageResult.cursor;
            current.derivatives.messages = messageResult.complete ? 'complete' : 'pending';
          } else current.derivatives[stage] = 'complete';
          return a.save(claim, c, value, 'purging_derivatives', session);
        });
      } catch {
        return { state: 'unknown' };
      }
    },
    prepareStorage(claim, signal) {
      return a.transaction(signal, async (session) => {
        const c = await a.load(claim, session);
        const value = a.progress(c);
        const v = lifecycle(value);
        if (v.storage) {
          validateStorage(value);
          return a.observation(c);
        }
        if (
          c.job.execution.phase !== 'purging_derivatives' ||
          !derivativesComplete(value) ||
          claim.work.handler !== 'file.cleanup'
        )
          throw new Pending('owner_pending');
        const u = v.upload;
        if (u.backend?.kind === 'nas-s3')
          return a.save(claim, c, value, 'removing_original', session);
        v.storage = {
          state: 'binding',
          request: {
            protocol: 1,
            requestId: randomUUID(),
            generation: String(u.attemptGeneration),
            acceptedObjectSHA256: u.acceptedObjectSHA256,
            authorityBindingSHA256: digest(
              JSON.stringify([
                'file-cleanup-authority-v1',
                u.tenantId,
                u.userId,
                u.fileId,
                value.revocationId,
                claim.work.deadlineGeneration,
                u.operationId,
                u.attemptGeneration,
                u.cleanupGeneration,
                u.originalKey,
              ]),
            ),
          },
        };
        return a.save(claim, c, value, 'removing_original', session);
      });
    },
    bindStorage(claim, expected, binding, signal) {
      return a.transaction(signal, async (session) => {
        const c = await a.load(claim, session, expected);
        const value = a.progress(c);
        const v = lifecycle(value);
        const storage = validateStorage(value);
        if (storage.state !== 'binding') return a.observation(c);
        if (
          c.job.execution.phase !== 'removing_original' ||
          !isStorageDeletionBinding(binding) ||
          binding.key !== v.upload.originalKey ||
          !Object.entries(storage.request).every(
            ([key, value]) => binding[key as keyof StorageDeletionBinding] === value,
          )
        )
          throw new Pending('invalid_binding');
        assertFileStorageHeadroom(value, binding);
        v.storage = {
          state: 'observing',
          request: storage.request,
          binding,
          obligationId: null,
          lastState: null,
        };
        return a.save(claim, c, value, 'removing_original', session);
      });
    },
    recordStorage(claim, expected, result, signal) {
      return a.transaction(signal, async (session) => {
        const c = await a.load(claim, session, expected);
        const value = a.progress(c);
        const v = lifecycle(value);
        const storage = validateStorage(value);
        if (storage.state !== 'observing') return a.observation(c);
        if (!isStorageDeletionResult(result, storage.binding, storage.obligationId ?? undefined))
          throw new Pending('invalid_receipt');
        v.storage =
          result.state === 'durable_delete_complete'
            ? {
                state: 'terminal',
                request: storage.request,
                binding: storage.binding,
                receipt: result,
                receiptSHA256: digest(canonicalStorageDeletionReceipt(result)),
              }
            : {
                ...storage,
                obligationId: result.obligationId ?? storage.obligationId,
                lastState: result.state,
              };
        return a.save(claim, c, value, c.job.execution.phase, session);
      });
    },
    commitConsumption(claim, signal) {
      return a.transaction(signal, async (session) => {
        const c = await a.load(claim, session);
        const value = a.progress(c);
        const v = lifecycle(value);
        const storage = validateStorage(value);
        if (storage.state === 'committed' || storage.state === 'consumed') return a.observation(c);
        if (storage.state !== 'terminal' || !derivativesComplete(value))
          throw new Pending('owner_pending');
        if (
          !(await retention.settleFileSourceDeletionInSession(
            owner(claim),
            v.upload.fileId,
            false,
            session,
          ))
        )
          throw new Pending('descendant_pending');
        v.contentPrepared = true;
        await a.save(claim, c, value, 'finalizing', session);
        const result = mustOwner(await upload.acknowledgeAcceptedFileCleanup({ claim }, session));
        if (result.state !== 'acknowledged') throw new Pending('owner_pending');
        const ack = result.ack;
        if (
          !validId(ack.reference) ||
          ack.operationId !== v.upload.operationId ||
          ack.cleanupGeneration !== v.upload.cleanupGeneration ||
          ack.attemptGeneration !== v.upload.attemptGeneration ||
          ack.revocationId !== value.revocationId ||
          ack.receiptSHA256 !== storage.receiptSHA256
        )
          throw new Pending('invalid_upload_ack');
        v.storage = {
          ...storage,
          state: 'committed',
          uploadAck: ack,
          consumerCommitId: randomUUID(),
        };
        return a.save(claim, c, value, 'finalizing', session);
      });
    },
    recordConsumption(claim, expected, result, signal) {
      return a.transaction(signal, async (session) => {
        const c = await a.load(claim, session, expected);
        const value = a.progress(c);
        const v = lifecycle(value);
        const storage = validateStorage(value);
        if (storage.state === 'consumed') return a.observation(c);
        if (storage.state !== 'committed') throw new Pending('owner_pending');
        if (
          !isStorageDeletionConsumptionResult(result, {
            obligationId: storage.receipt.obligationId,
            receiptSHA256: storage.receiptSHA256,
            consumerCommitId: storage.consumerCommitId,
          })
        )
          throw new Pending('invalid_consumption');
        if (result.state === 'unknown') return a.observation(c);
        v.storage = { ...storage, state: 'consumed', consumption: result };
        return a.save(claim, c, value, 'finalizing', session);
      });
    },
    finalize(claim, signal) {
      return a.transaction(signal, async (session) => {
        const c = await a.load(claim, session);
        const value = a.progress(c);
        const v = lifecycle(value);
        const storage = v.nasStorage ? validateNasFileStorage(value) : validateStorage(value);
        if (
          storage.state !== 'consumed' ||
          v.contentPrepared !== true ||
          !derivativesComplete(value)
        )
          throw new Pending('owner_pending');
        const result = mustOwner(await upload.acknowledgeAcceptedFileCleanup({ claim }, session));
        if (result.state !== 'acknowledged' || !same(result.ack, storage.uploadAck))
          throw new Pending('owner_pending');
        v.completionRef ??= `file:${randomUUID()}`;
        const observation = await a.save(claim, c, value, 'complete', session);
        if (
          !(await retention.settleFileSourceDeletionInSession(
            owner(claim),
            v.upload.fileId,
            true,
            session,
          ))
        )
          throw new Pending('descendant_pending');
        return observation;
      });
    },
  };
}
