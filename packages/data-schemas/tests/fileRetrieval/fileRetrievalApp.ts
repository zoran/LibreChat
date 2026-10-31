/** Actual App composition and File/Upload/HK transactions; native storage receipts are explicit fixtures. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { canonicalManagedJson } from 'librechat-data-provider';
import type { ManagedRetrievalState } from 'librechat-data-provider';
import type { IMongoFile } from '../../src/types/file';
import type { FileCleanupProgressResult } from '../../src/types/fileCleanup';
import type { JobClaim } from '../../src/types/housekeeping';
const {
  createFileDeletionWorkOwner,
}: Pick<
  typeof import('@librechat/api', { with: { 'resolution-mode': 'require' } }),
  'createFileDeletionWorkOwner'
> = jest.requireActual('@librechat/api');
const {
  requestManagedFileDeletion,
}: { requestManagedFileDeletion: (...args: unknown[]) => Promise<unknown> } = jest.requireActual(
  '../../../api/src/files/managedDeletion',
);
import type { FileCleanupLifecycleMethods, FileOwnerScope } from '@librechat/data-schemas';
interface ManagedFileDeletionPorts {
  revokeFileSources: (
    owner: FileOwnerScope,
    ids: readonly string[],
  ) => Promise<{ revokedFileIds: string[] }>;
  revokeFileSourceGenerations: (
    owner: FileOwnerScope,
    ids: string[],
  ) => Promise<{ complete: boolean; pending: readonly unknown[] }>;
  assertFileSourceDeletionReady: (owner: FileOwnerScope, ids: readonly string[]) => Promise<void>;
  observeFileCleanupCompletion: FileCleanupLifecycleMethods['observeCompletion'];
  removeAgentResourceFilesFromAllAgents: (input: { file_ids: string[] }) => Promise<unknown>;
}
import { acceptedRetrievalPublication } from './fileRetrievalPublication';
import { prepareNonemptyFileCleanup } from '../../specs/fixtures/fileUploadCleanup';
import { createMethods } from '../../src/methods/index';
import { createFileRetentionMethods } from '../../src/methods/fileRetention';
import { createFileCleanupLifecycleMethods } from '../../src/methods/fileCleanupLifecycle';
import { createFileCleanupClaimMethods } from '../../src/methods/fileCleanupClaim';
import { createFileCleanupProgressMethods } from '../../src/methods/fileCleanupProgress';
import { createHousekeepingStore } from '../../src/methods/housekeepingStore';
import { createUploadFileCleanupOwner } from '../../src/methods/uploadFileCleanup';
import { createUploadStore } from '../../src/methods/uploadManagementStore';
import { createUploadActivationMethods } from '../../src/methods/uploadManagementActivation';
import { captureManagedRetrievalInventoryEvidence } from '../../src/methods/fileRetrieval';
import fixture from '../../../data-provider/src/__fixtures__/managed-retrieval-v1.json';

export function actualAppConsumer(
  db: Omit<ManagedFileDeletionPorts, 'revokeFileSourceGenerations'>,
  generation: Pick<ManagedFileDeletionPorts, 'revokeFileSourceGenerations'>,
): {
  work: ReturnType<typeof createFileDeletionWorkOwner>;
  remove(
    owner: { userId: string; tenantId?: string | null },
    files: unknown[],
  ): Promise<{ deletedFileIds: string[]; failedFileIds: string[] }>;
} {
  const source = readFileSync(
    resolve(__dirname, '../../../../api/server/services/Files/process.js'),
    'utf8',
  );
  const start = source.indexOf('const processDeleteRequest =');
  const end = source.indexOf('\nconst processFileURL =', start);
  if (start < 0 || end < 0) throw Error('Actual App deletion consumer missing');
  const exported = {} as {
    processDeleteRequest(
      input: unknown,
    ): Promise<{ deletedFileIds: string[]; failedFileIds: string[] }>;
  };
  const work = createFileDeletionWorkOwner();
  runInNewContext(
    source.slice(start, end) + '\nexports.processDeleteRequest = processDeleteRequest;',
    {
      exports: exported,
      db,
      fileDeletionWorkOwner: work,
      requestManagedFileDeletion,
      GenerationJobManager: generation,
      FileSources: { local: 'local', text: 'text', openai: 'openai', azure: 'azure' },
      EModelEndpoint: {},
      logger: { error: () => {}, warn: () => {} },
    },
  );
  return {
    work,
    remove: (owner, files) =>
      exported.processDeleteRequest({
        req: { user: { id: owner.userId, tenantId: owner.tenantId }, config: {}, body: {} },
        files,
      }),
  };
}

const observed = (
  value: FileCleanupProgressResult,
): Extract<FileCleanupProgressResult, { state: 'progress' }> => {
  if (value.state !== 'progress') throw Error(JSON.stringify(value));
  return value;
};
const unavailable = async (): Promise<never> => {
  throw Error('Derivative owner must be composed before effect');
};

export async function actualFileCleanup(
  generation: Pick<ManagedFileDeletionPorts, 'revokeFileSourceGenerations'>,
): Promise<{
  accepted: Awaited<ReturnType<typeof acceptedRetrievalPublication>>;
  consumer: ReturnType<typeof actualAppConsumer>;
  file(): Promise<IMongoFile>;
  remove(): Promise<{ deletedFileIds: string[]; failedFileIds: string[] }>;
  reconcile(): Promise<void>;
  cleanup(interruptAcknowledgment?: boolean): Promise<void>;
  resume(): Promise<void>;
}> {
  const accepted = await acceptedRetrievalPublication(Date.now());
  const { db, principal, repository } = accepted;
  try {
    const methods = createMethods(db);
    const consumer = actualAppConsumer(methods, generation);
    const file = async (): Promise<IMongoFile> => {
      const row = await db.models.File.findOne({
        file_id: 'source-a',
        tenantId: principal.tenantId,
        user: principal.userId,
      })
        .select(
          '+managedRetrieval +retrievalCreation +securityApproval +documentStructure +retentionCleanup +retentionRevocationId +retainedDerivativeBytes +retentionActivity',
        )
        .lean<IMongoFile>();
      if (!row) throw Error('Actual accepted File missing');
      return row;
    };
    // Historical representation is explicit input, never cleanup custody or a completion proof.
    await db.models.File.updateOne(
      { file_id: 'source-a' },
      {
        $set: {
          text: fixture.revisionInput.document.text,
          documentStructure: fixture.revisionInput.document.structure,
        },
        $unset: { retrievalCreation: 1 },
      },
    );
    const jobs = createHousekeepingStore(db);
    await jobs.initialize();
    const owner = createUploadFileCleanupOwner(db);
    const retention = createFileRetentionMethods(db);
    const targets = createFileCleanupProgressMethods(db, jobs);
    await targets.initialize();
    let lifecycle = createFileCleanupLifecycleMethods(db, jobs, owner, retention, {
      purgeRetrieval: unavailable,
      purgeCheckpoints: unavailable,
      redactFileSourceContent: unavailable,
    });
    let claim: JobClaim;
    const signal = new AbortController().signal;
    const resume = async (): Promise<void> => {
      let step = observed(await lifecycle.observe(claim, signal));
      if (step.progress.lifecycle?.storage?.state === 'terminal')
        step = observed(await lifecycle.commitConsumption(claim, signal));
      const storage = step.progress.lifecycle!.storage!;
      if (storage.state !== 'committed') throw Error('Actual consumption commit required');
      observed(
        await lifecycle.recordConsumption(
          claim,
          step.expected,
          {
            state: 'recorded',
            obligationId: storage.receipt.obligationId,
            receiptSHA256: storage.receiptSHA256,
            consumerCommitId: storage.consumerCommitId,
          },
          signal,
        ),
      );
      observed(await lifecycle.finalize(claim, signal));
    };
    return {
      accepted,
      consumer,
      file,
      remove: async () => consumer.remove(principal, [await file()]),
      async reconcile(): Promise<void> {
        await repository.delete(principal, 'source-a', Date.now());
        const store = createUploadStore(db, {});
        // Explicit retired-writer configuration for this legacy migration fixture.
        await store.transaction(async (_session, global) => {
          global.enabled = false;
        });
        const snapshot = await createUploadActivationMethods(store).reconciliationSnapshot(
          Date.now(),
        );
        const row = await file();
        const evidenceSha256 = captureManagedRetrievalInventoryEvidence(
          row as unknown as Record<string, unknown>,
        ).evidenceSha256;
        const capturedOwner = { userId: principal.userId, tenantId: principal.tenantId };
        const payload = {
          backendIdentity: fixture.obligation.backendIdentity,
          owner: capturedOwner,
          fileId: 'source-a',
          evidenceSha256,
          observedAt: Date.now(),
          complete: true as const,
          obligations: [] as ManagedRetrievalState['obligations'],
        };
        const inventoryReceiptSha256 = createHash('sha256')
          .update(canonicalManagedJson(payload))
          .digest('hex');
        const authority = {
          topologySha256: '1'.repeat(64),
          writers: [
            { writerId: 'retired-legacy-rag-writer', retirementReceiptSha256: '2'.repeat(64) },
          ],
          backends: [{ backendIdentity: payload.backendIdentity, inventoryReceiptSha256 }],
        };
        await createUploadActivationMethods(store, {
          retrievalInventoryAuthority: authority,
        }).reconcileFileRetrievalInventory(
          {
            reconciliationId: 'app-inventory-fixture',
            storeId: snapshot.storeId,
            revision: snapshot.revision,
            observedAt: payload.observedAt,
            owner: capturedOwner,
            fileId: 'source-a',
            evidenceSha256,
            backends: [{ ...payload, inventoryReceiptSha256 }],
          },
          Date.now(),
        );
      },
      async cleanup(interruptAcknowledgment = false): Promise<void> {
        const next = await jobs.claimNext('file.cleanup', {
          podUid: 'app-test',
          incarnation: 'boot',
          source: 'fixture',
          hostId: 'local',
        });
        if (!next) throw Error('Actual File cleanup claim missing');
        claim = next;
        expect(
          await createFileCleanupClaimMethods(db, jobs, retention).enter(claim, signal),
        ).toMatchObject({ state: 'progress' });
        observed(await lifecycle.begin(claim, signal));
        const composed = await prepareNonemptyFileCleanup({
          db,
          user: { userId: principal.userId, tenantId: principal.tenantId! },
          now: Date.now(),
          claim,
          signal,
          owner,
          retention,
          jobs,
          generation: targets,
          step: observed(await targets.beginCapture(claim, signal)),
          fileId: 'source-a',
        });
        lifecycle = composed.lifecycle;
        let step = observed(await lifecycle.prepareStorage(claim, signal));
        let storage = step.progress.lifecycle!.storage!;
        if (storage.state !== 'binding') throw Error('Actual persisted storage request required');
        step = observed(
          await lifecycle.bindStorage(
            claim,
            step.expected,
            {
              ...storage.request,
              bucket: 'originals-fixture',
              key: step.progress.lifecycle!.upload.originalKey,
            },
            signal,
          ),
        );
        storage = step.progress.lifecycle!.storage!;
        if (storage.state !== 'observing') throw Error('Actual persisted storage binding required');
        observed(
          await lifecycle.recordStorage(
            claim,
            step.expected,
            {
              ...storage.binding,
              state: 'durable_delete_complete',
              obligationId: 'native-fixture',
              aggregateRevision: '1',
              proofSHA256: 'e'.repeat(64),
            },
            signal,
          ),
        );
        if (interruptAcknowledgment) {
          const ack = jest
            .spyOn(owner, 'acknowledgeAcceptedFileCleanup')
            .mockRejectedValueOnce(Error('lost acknowledgement'));
          try {
            expect(await lifecycle.commitConsumption(claim, signal)).toEqual({ state: 'unknown' });
          } finally {
            ack.mockRestore();
          }
          return;
        }
        await resume();
      },
      resume,
    };
  } catch (error) {
    await accepted.close();
    throw error;
  }
}
