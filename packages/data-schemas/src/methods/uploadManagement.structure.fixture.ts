/// <reference types="jest" />
/** Shared original-upload lifecycle fixture for publication, structure and Status scenarios. */
import mongoose from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type {
  ManagedDocumentResult,
  UploadLease,
  UploadPrincipal,
  UploadCleanupProof,
} from 'librechat-data-provider';
import { createUploadManagementRepository } from './uploadManagement';
import { createModels } from '~/models';

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
    for (const name of ['User', 'File', 'Message', 'UploadOperation', 'UploadCounter'])
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
    const execution = {
      version: 2 as const,
      custody: { kind: 'none' as const },
      attemptId: `structure.${transfer.generation}`,
      instanceId: randomUUID(),
      executionId: randomUUID(),
      expiresAt: new Date(now + 60_000).toISOString(),
    };
    await repository.bindSecurityExecution(transfer, execution, now);
    await repository.settleSecurityExecution(
      transfer,
      { execution, writerStopped: true, transientDataRemoved: true },
      now,
    );
    await repository.accept(
      principal,
      transfer,
      {
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
      },
      {
        version: 1,
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
      },
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
