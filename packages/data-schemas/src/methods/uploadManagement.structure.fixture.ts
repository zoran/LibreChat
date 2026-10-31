/// <reference types="jest" />
/** Shared original-upload lifecycle fixture for publication, structure and Status scenarios. */
import mongoose from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { canonicalStorageDeletionReceipt } from 'librechat-data-provider';
import type {
  ManagedDocumentResult,
  UploadLease,
  UploadPrincipal,
  UploadCleanupProof,
} from 'librechat-data-provider';
import type { FileCleanupProgressResult } from '../types/fileCleanup';
import type { IMongoFile } from '../types/file';
import {
  uploadSecurityFixture,
  bindUploadOriginalFixture,
  uploadSecuritySettlementFixture,
} from './uploadManagement.security.fixture';
import { createFileCleanupLifecycleMethods } from './fileCleanupLifecycle';
import { createFileCleanupProgressMethods } from './fileCleanupProgress';
import { createUploadManagementRepository } from './uploadManagement';
import { managedFileRetrievalDeletionSettled } from './fileRetrieval';
import { createUploadFileCleanupOwner } from './uploadFileCleanup';
import { createHousekeepingStore } from './housekeepingStore';
import { createFileRetentionMethods } from './fileRetention';
import { createMessageMethods } from './message';
import { createModels } from '~/models';

/** Copy the File owner's frozen database rows before importing its accepted Upload rows. */
export async function copyFrozenUploadFiles(
  source: mongoose.Mongoose,
  target: mongoose.Mongoose,
): Promise<void> {
  // Completed deletion tombstones intentionally lack live-file fields. Preserve every frozen
  // field without applying new-File validation, defaults, timestamps or private-field projections.
  // eslint-disable-next-line no-restricted-syntax -- Isolated frozen Mongo fixture must read every retained BSON field, including completed File tombstones.
  const files = await source.models.File.collection.find({}).toArray();
  if (files.length > 0) {
    // eslint-disable-next-line no-restricted-syntax -- Isolated frozen Mongo fixture restores existing File rows without new-File validation, defaults or timestamps.
    await target.models.File.collection.insertMany(files);
  }
}

/** Local exit is separate from storage deletion and consumption; only storage is a protocol fixture. */
export async function completeUnacceptedUploadCleanup(
  repository: ReturnType<typeof createUploadManagementRepository>,
  principal: UploadPrincipal,
  lease: UploadLease,
): Promise<void> {
  const authority = {
    operationId: lease.operationId,
    generation: lease.generation,
    attemptGeneration: lease.generation,
    principal,
  };
  const prepared = await repository.prepareCleanupStorage(authority);
  if (prepared.state !== 'binding') throw Error('Expected storage binding preparation');
  const binding = {
    ...prepared.request,
    bucket: 'private-bucket',
    key: `${principal.tenantId === null ? '' : `t/${principal.tenantId}/`}managed-uploads/${principal.userId}/${lease.operationId}.${lease.generation}__original`,
  };
  expect(await repository.prepareCleanupStorage(authority, binding)).toMatchObject({
    state: 'observe',
    binding,
  });
  const receipt = {
    ...binding,
    state: 'durable_delete_complete' as const,
    obligationId: 'native-obligation',
    aggregateRevision: '4',
    proofSHA256: 'a'.repeat(64),
  };
  const committed = await repository.recordCleanupStorage(authority, { result: receipt });
  if (committed.state !== 'consume') throw Error('Expected exact persisted consumer commit');
  const receiptSHA256 = createHash('sha256')
    .update(canonicalStorageDeletionReceipt(receipt))
    .digest('hex');
  expect(
    await repository.recordCleanupStorage(authority, { consumption: { state: 'unknown' } }),
  ).toEqual(committed);
  expect(
    await repository.recordCleanupStorage(authority, {
      consumption: {
        state: 'recorded',
        obligationId: receipt.obligationId,
        receiptSHA256,
        consumerCommitId: committed.consumerCommitId,
      },
    }),
  ).toEqual({ state: 'complete', receiptRef: receiptSHA256 });
}

/** Complete the actual File/HK/Upload join for an empty generation census and settled retrieval. */
export async function completeAcceptedUploadFileCleanup(
  db: mongoose.Mongoose,
  principal: UploadPrincipal,
  fileId: string,
  checkpointUri?: string,
): Promise<void> {
  let ownsCheckpointConnection = false;
  try {
    if (db !== mongoose) {
      if (!checkpointUri || mongoose.connection.readyState !== 0)
        throw Error('Expected an unused checkpoint fixture connection');
      const uri = new URL(checkpointUri);
      if (
        uri.protocol !== 'mongodb:' ||
        uri.username ||
        uri.password ||
        uri.hostname !== '127.0.0.1' ||
        uri.port !== String(db.connection.port) ||
        uri.pathname !== `/${db.connection.name}` ||
        db.connection.readyState !== 1
      )
        throw Error('Checkpoint connection must use the same local fixture database');
      ownsCheckpointConnection = true;
      await mongoose.connect(checkpointUri);
      expect(mongoose.connection.name).toBe(db.connection.name);
      expect(mongoose.connection.host).toBe(db.connection.host);
      expect(mongoose.connection.port).toBe(db.connection.port);
      createModels(mongoose);
    }
    const observed = (result: FileCleanupProgressResult) => {
      if (result.state !== 'progress') throw Error(JSON.stringify(result));
      return result;
    };
    const jobs = createHousekeepingStore(db);
    await jobs.initialize();
    const generation = createFileCleanupProgressMethods(db, jobs);
    await generation.initialize();
    const retention = createFileRetentionMethods(db);
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Actual cross-package owner composition in the existing Mongo fixture.
    const { InMemoryJobStore } = require('@librechat/api');
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Actual cross-package owner composition in the existing Mongo fixture.
    const { createGenerationCleanupPort } = require('../../../api/src/stream/sourceCleanup');
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Actual checkpoint owner shares the default Mongoose connection.
    const { purgeCheckpointRows } = require('../../../api/src/agents/checkpoints/source-retention');
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Use the checkpoint owner's canonical namespace.
    const { checkpointOwnerNamespacePrefix } = require('../../../api/src/stream/checkpoints');
    const source = new InMemoryJobStore();
    const unavailable = async () => {
      throw Error('Unexpected nonempty generation transport');
    };
    const port = createGenerationCleanupPort({
      store: source,
      transport: {
        emitAbortConfirmed: unavailable,
        purgeSourceRetention: unavailable,
        hasProviderDrain: unavailable,
      },
      close: () => source.destroy(),
    });
    const lifecycle = createFileCleanupLifecycleMethods(
      db,
      jobs,
      createUploadFileCleanupOwner(db),
      retention,
      {
        purgeRetrieval: async (owner, fileIds) => {
          expect(fileIds).toEqual([fileId]);
          const current = await db.models.File.findOne({
            file_id: fileId,
            tenantId: owner.tenantId,
            user: owner.userId,
          })
            .select('+retrievalCreation +managedRetrieval')
            .lean<IMongoFile>();
          if (!current || !managedFileRetrievalDeletionSettled(current))
            throw Error('Retrieval requires actual transport settlement before File cleanup');
        },
        purgeCheckpoints: async (owner, fileIds) =>
          purgeCheckpointRows(
            {
              checkpointCollectionName: 'fixture_checkpoints',
              checkpointWritesCollectionName: 'fixture_writes',
            },
            { lc_owner: checkpointOwnerNamespacePrefix(owner.userId, owner.tenantId ?? undefined) },
            { sourceFileIds: fileIds },
          ),
        redactFileSourceContent: createMessageMethods(db).redactFileSourceContent,
      },
    );
    const signal = new AbortController().signal;
    try {
      const claim = await jobs.claimNext('file.cleanup', {
        podUid: 'fixture-pod',
        incarnation: 'fixture-boot',
        source: 'fixture-source',
        hostId: 'fixture-host',
      });
      if (!claim) throw Error('Expected actual revoked File claim');
      const session = await db.startSession();
      try {
        await session.withTransaction(() =>
          jobs.advance(
            claim,
            { revision: claim.progressRevision, phase: 'awaiting_deadline' },
            { phase: 'revoked', code: 'progress' },
            session,
          ),
        );
      } finally {
        await session.endSession();
      }
      observed(await lifecycle.begin(claim, signal));
      let step = observed(await generation.beginCapture(claim, signal));
      const scope = {
        userId: principal.userId,
        tenantId: principal.tenantId ?? undefined,
        revocationId: step.progress.revocationId,
        sourceFileIds: [fileId],
      };
      let cursor: string | undefined;
      // Even an empty tenant has separate scoped, legacy-owner and replay-intent pages.
      for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
        const page = await port.capture(scope, cursor);
        expect(page.targets).toEqual([]);
        expect(page.reason).toBeUndefined();
        step = observed(await generation.recordCapturePage(claim, step.expected, page, signal));
        if (page.complete) break;
        expect(page.cursor).toEqual(expect.any(String));
        expect(page.cursor).not.toBe(cursor);
        cursor = page.cursor;
      }
      expect(step.progress.capture.complete).toBe(true);
      expect(step.progress.capture.recoveryUnresolved).toBe(false);
      step = observed(await generation.finishGenerationStage(claim, step.expected, signal));
      for (let i = 0; i < 4; i++) {
        step = observed(await lifecycle.purgeDerivatives(claim, signal));
        if (step.progress.lifecycle!.derivatives.messages === 'complete') break;
      }
      expect(step.progress.lifecycle!.derivatives).toMatchObject({
        retrieval: 'complete',
        checkpoints: 'complete',
        messages: 'complete',
      });
      step = observed(await lifecycle.prepareStorage(claim, signal));
      const prepared = step.progress.lifecycle!.storage!;
      if (prepared.state !== 'binding') throw Error('Expected File storage request');
      step = observed(
        await lifecycle.bindStorage(
          claim,
          step.expected,
          {
            ...prepared.request,
            bucket: 'originals',
            key: step.progress.lifecycle!.upload.originalKey,
          },
          signal,
        ),
      );
      const bound = step.progress.lifecycle!.storage!;
      if (bound.state !== 'observing') throw Error('Expected bound File storage');
      observed(
        await lifecycle.recordStorage(
          claim,
          step.expected,
          {
            ...bound.binding,
            state: 'durable_delete_complete',
            obligationId: 'native-fixture',
            aggregateRevision: '1',
            proofSHA256: 'e'.repeat(64),
          },
          signal,
        ),
      );
      step = observed(await lifecycle.commitConsumption(claim, signal));
      const committed = step.progress.lifecycle!.storage!;
      if (committed.state !== 'committed') throw Error('Expected accepted File consumer commit');
      step = observed(
        await lifecycle.recordConsumption(
          claim,
          step.expected,
          {
            state: 'recorded',
            obligationId: committed.receipt.obligationId,
            receiptSHA256: committed.receiptSHA256,
            consumerCommitId: committed.consumerCommitId,
          },
          signal,
        ),
      );
      expect(step.progress.lifecycle!.storage!.state).toBe('consumed');
      observed(await lifecycle.finalize(claim, signal));
      expect(
        await lifecycle.observeCompletion(principal, [fileId], {
          deadlineAt: Date.now() + 5000,
          signal,
        }),
      ).toEqual([{ fileId, state: 'complete', completionRef: expect.any(String) }]);
    } finally {
      await port.close();
    }
  } finally {
    if (ownsCheckpointConnection) await mongoose.connection.close();
  }
}

interface UploadStructureFixture {
  db: mongoose.Mongoose;
  readonly mongo: MongoMemoryReplSet;
  repository: ReturnType<typeof createUploadManagementRepository>;
  user: UploadPrincipal;
  worker: { hostId: string; instanceId: string };
  now: number;
  policy: string;
  bytes: Buffer;
  sha256: string;
  result(text?: string): ManagedDocumentResult & { writerStopped: true };
  localGone(lease: UploadLease): UploadCleanupProof;
  raw(): Promise<mongoose.mongo.WithId<mongoose.mongo.Document> | null>;
  processing(principal?: UploadPrincipal): Promise<UploadLease>;
}

/** Shared real Mongo/Upload lifecycle fixture; callers own their assertions. */
export function useUploadStructureFixture(): UploadStructureFixture {
  const db = new mongoose.Mongoose();
  let mongo: MongoMemoryReplSet;
  let repository: ReturnType<typeof createUploadManagementRepository>;
  const now = Date.now();
  const policy = 'c'.repeat(64);
  const bytes = Buffer.from('original');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const user: UploadPrincipal = {
    tenantId: 'tenant-a',
    userId: new mongoose.Types.ObjectId().toString(),
    authentication: 'verified-email',
  };
  const worker = { hostId: 'host-a', instanceId: 'app-a' };
  const result = (text = 'Derived text'): ManagedDocumentResult & { writerStopped: true } => ({
    text,
    writerStopped: true,
    structure: {
      version: 1,
      source: { sha256, bytes: bytes.length, mediaType: 'text/plain' },
      extractor: { name: 'fixture', version: '1' },
      pages: [],
      elements: [
        { id: 'e1', kind: 'paragraph', start: 0, end: text.length, page: null, parentId: null },
      ],
      quality: { status: 'complete', warnings: [] },
    },
  });
  const localGone = (lease: UploadLease) => ({
    operationId: lease.operationId,
    generation: lease.generation,
    writerStopped: true,
    localCopiesAbsent: true,
    originalAbsent: false,
    textAndHistoryRemoved: false,
  });
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await db.connect(mongo.getUri('document-structure'));
    createModels(db);
    await db.models.File.init();
  });
  beforeEach(async () => {
    for (const name of [
      'User',
      'File',
      'Message',
      'UploadOperation',
      'UploadCounter',
      'HousekeepingJob',
    ])
      if (db.models[name]) await db.models[name].deleteMany({});
    await db.models.User.create({
      _id: user.userId,
      tenantId: user.tenantId,
      email: 'upload-structure@example.test',
      emailVerified: true,
    });
    repository = createUploadManagementRepository(db, {
      enabled: true,
      reconciled: true,
      securityPolicySha256: policy,
      baseline: { originalBytes: 0, objectBytes: 0, textBytes: 0, recordBytes: 0, bundles: 0 },
    });
    await repository.initialize();
  });
  afterAll(async () => {
    await db.disconnect();
    await mongo?.stop();
  });
  // eslint-disable-next-line no-restricted-syntax -- Isolated Mongo fixture must inspect private BSON fields hidden by the public File reader.
  const raw = () => db.models.File.collection.findOne({ file_id: 'structure' });
  async function processing(principal: UploadPrincipal = user) {
    await repository.reserve(
      principal,
      {
        operationId: 'structure',
        idempotencyKey: randomUUID(),
        mediaType: 'text/plain',
        declaredBytes: bytes.length,
        fingerprint: JSON.stringify([{ kind: 'personal' }, 'text/plain', bytes.length]),
      },
      now,
    );
    const transfer = (await repository.claim({
      kind: 'transfer',
      principal: principal,
      operationId: 'structure',
      worker,
      now,
    }))!;
    const security = uploadSecurityFixture(
      uploadSecurityFixture({
        decision: 'approved',
        policySha256: policy,
        subject: {
          tenantId: principal.tenantId,
          userId: principal.userId,
          operationId: 'structure',
          transferGeneration: transfer.generation,
          mediaType: 'text/plain',
          bytes: bytes.length,
          sha256,
        },
        scannerVersion: 'fixture-v1',
        checkedAt: new Date(now).toISOString(),
        coverage: { complete: true, pages: 1, parts: 1 },
      }).approval,
      {
        custody: { kind: 'none' as const },
        attemptId: `structure.${transfer.generation}`,
        instanceId: randomUUID(),
        executionId: randomUUID(),
        expiresAt: new Date(now + 60_000).toISOString(),
      },
    );
    const execution = security.execution;
    const originalFixture: Parameters<typeof repository.accept>[2] = {
      outcome: 'durable',
      bytes: bytes.length,
      source: 's3',
      filepath: '/api/files/download/structure',
      storageKey: `${principal.tenantId === null ? '' : `t/${principal.tenantId}/`}managed-uploads/${principal.userId}/structure.${transfer.generation}__original`,
      integrity: {
        version: 1,
        algorithm: 'sha256',
        sha256,
        chunkBytes: 262144,
        chunkSha256: [sha256],
      },
    };
    await repository.bindSecurityExecution(transfer, execution, now);
    await repository.settleSecurityExecution(
      transfer,
      uploadSecuritySettlementFixture(execution, {
        writerStopped: true,
        transientDataRemoved: true,
      }),
      now,
    );
    await bindUploadOriginalFixture(
      repository,
      transfer,
      originalFixture,
      uploadSecurityFixture({
        decision: 'approved',
        policySha256: policy,
        subject: {
          tenantId: principal.tenantId,
          userId: principal.userId,
          operationId: 'structure',
          transferGeneration: transfer.generation,
          mediaType: 'text/plain',
          bytes: bytes.length,
          sha256,
        },
        scannerVersion: 'fixture-v1',
        checkedAt: new Date(now).toISOString(),
        coverage: { complete: true, pages: 1, parts: 1 },
      }).approval,
      now,
    );
    await repository.accept(
      principal,
      transfer,
      originalFixture,
      uploadSecurityFixture({
        decision: 'approved',
        policySha256: policy,
        subject: {
          tenantId: principal.tenantId,
          userId: principal.userId,
          operationId: 'structure',
          transferGeneration: transfer.generation,
          mediaType: 'text/plain',
          bytes: bytes.length,
          sha256,
        },
        scannerVersion: 'fixture-v1',
        checkedAt: new Date(now).toISOString(),
        coverage: { complete: true, pages: 1, parts: 1 },
      }).approval,
      { filename: 'original.txt' },
      now,
    );
    await repository.confirmCleanup(localGone(transfer), now);
    const lease = (await repository.claim({ kind: 'processing', worker, now }))!;
    await repository.bindProcessingExecution(
      lease,
      {
        attemptId: `structure.${lease.generation}`,
        instanceId: 'parser-a',
        expiresAt: new Date(now + 60_000).toISOString(),
      },
      now,
    );
    return lease;
  }

  return {
    db,
    get mongo() {
      return mongo;
    },
    user,
    worker,
    now,
    policy,
    bytes,
    sha256,
    result,
    localGone,
    raw,
    processing,
    get repository() {
      return repository;
    },
    set repository(value) {
      repository = value;
    },
  };
}
