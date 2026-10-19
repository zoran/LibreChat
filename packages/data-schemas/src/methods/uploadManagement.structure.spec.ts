/** Real Mongo publication, accounting and cleanup of one private original-bound derivation. */
import mongoose from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { UPLOAD_MAX_TEXT_BYTES } from 'librechat-data-provider';
import type { ManagedDocumentResult, UploadLease, UploadPrincipal } from 'librechat-data-provider';
import { createUploadManagementRepository } from './uploadManagement';
import { createFileRetentionMethods } from './fileRetention';
import { createFileMethods } from './file';
import { createModels } from '~/models';

describe('original-bound managed document structure', () => {
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
  const raw = () => db.models.File.collection.findOne({ file_id: 'structure' });
  async function processing() {
    await repository.reserve(
      user,
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
      principal: user,
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
      user,
      transfer,
      {
        outcome: 'durable',
        bytes: bytes.length,
        source: 's3',
        filepath: '/api/files/download/structure',
        storageKey: `t/${user.tenantId}/managed-uploads/${user.userId}/structure.${transfer.generation}__original`,
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
          tenantId: user.tenantId,
          userId: user.userId,
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

  it('commits text and private structure together and charges both exactly once', async () => {
    const lease = await processing();
    const document = result('Ünicode 😀');
    const expected =
      Buffer.byteLength(document.text) + Buffer.byteLength(JSON.stringify(document.structure));
    const before = structuredClone(document);
    const ready = await repository.publish(lease, document, now);
    expect(document).toEqual(before);
    expect(await raw()).toMatchObject({
      text: document.text,
      documentStructure: document.structure,
      status: 'ready',
    });
    expect((await repository.metrics(now)).textBytes).toBe(expected);
    const second = createUploadManagementRepository(db, { securityPolicySha256: policy });
    expect((await second.publish(lease, document, now + 1)).revision).toBe(ready.revision);
    expect((await second.metrics(now)).textBytes).toBe(expected);
    expect(await db.models.File.findOne({ file_id: 'structure' }).lean()).not.toHaveProperty(
      'documentStructure',
    );
    const selected = await db.models.File.findOne({ file_id: 'structure' }).select(
      '+documentStructure',
    );
    expect(selected!.toJSON()).not.toHaveProperty('documentStructure');
    expect(selected!.toObject()).not.toHaveProperty('documentStructure');
  });

  it.each(['sha256', 'bytes', 'mediaType'] as const)(
    'rejects other original %s without partial commit',
    async (field) => {
      const lease = await processing();
      const document = result();
      if (field === 'sha256') document.structure.source.sha256 = 'f'.repeat(64);
      if (field === 'bytes') document.structure.source.bytes++;
      if (field === 'mediaType') document.structure.source.mediaType = 'application/pdf';
      await expect(repository.publish(lease, document, now)).rejects.toMatchObject({
        code: 'processing_failed',
      });
      expect(await raw()).toMatchObject({ status: 'pending' });
      expect(await raw()).not.toHaveProperty('documentStructure');
      expect(await raw()).not.toHaveProperty('text');
      expect((await repository.metrics(now)).textBytes).toBe(UPLOAD_MAX_TEXT_BYTES);
    },
  );

  it('refuses changed structure on retry while canonical object key order remains idempotent', async () => {
    const lease = await processing();
    const document = result();
    await repository.publish(lease, document, now);
    const reordered = {
      ...document,
      structure: {
        quality: document.structure.quality,
        elements: document.structure.elements,
        pages: [],
        extractor: document.structure.extractor,
        source: document.structure.source,
        version: 1 as const,
      },
    };
    await expect(repository.publish(lease, reordered, now)).resolves.toMatchObject({
      state: 'ready',
    });
    document.structure.extractor.version = '2';
    await expect(repository.publish(lease, document, now)).rejects.toMatchObject({
      code: 'lease_lost',
    });
    expect((await raw())!.documentStructure.extractor.version).toBe('1');
  });

  it('includes structure in the existing representation ceiling', async () => {
    const lease = await processing();
    await expect(
      repository.publish(lease, result('x'.repeat(UPLOAD_MAX_TEXT_BYTES)), now),
    ).rejects.toMatchObject({ code: 'processing_failed' });
    expect(await raw()).not.toHaveProperty('documentStructure');
    expect((await repository.metrics(now)).textBytes).toBe(UPLOAD_MAX_TEXT_BYTES);
  });

  it('rejects malformed publication and unjoined writers without reading accessors', async () => {
    const lease = await processing();
    const getter = jest.fn(() => result().text);
    const accessor = Object.defineProperty(result(), 'text', { get: getter });
    const invalid = result();
    invalid.structure.elements[0].end++;
    for (const value of [
      accessor,
      invalid,
      { ...result(), writerStopped: false },
      { text: 'legacy', writerStopped: true },
    ]) {
      await expect(repository.publish(lease, value as never, now)).rejects.toMatchObject({
        code: 'processing_failed',
      });
    }
    expect(getter).not.toHaveBeenCalled();
    expect(await raw()).not.toHaveProperty('documentStructure');
    expect((await repository.metrics(now)).textBytes).toBe(UPLOAD_MAX_TEXT_BYTES);
  });

  it('also binds the native File publication to its approved original inside the transaction', async () => {
    const lease = await processing();
    const document = result();
    const { text, structure } = document;
    structure.source.sha256 = 'd'.repeat(64);
    const lifecycle = createFileRetentionMethods(db, { securityPolicySha256: policy });
    const session = await db.startSession();
    try {
      await expect(
        session.withTransaction(async () =>
          lifecycle.publishManagedUpload(
            user,
            lease.operationId,
            lease.generation,
            { text, structure },
            now,
            session,
          ),
        ),
      ).rejects.toThrow('Document source unavailable');
    } finally {
      await session.endSession();
    }
    expect(await raw()).not.toHaveProperty('documentStructure');
  });

  it('removes private structure through the existing retained File deletion and cleanup fence', async () => {
    const lease = await processing();
    await repository.publish(lease, result(), now);
    await repository.confirmCleanup(localGone(lease), now);
    await repository.delete(user, 'structure', now);
    await createFileRetentionMethods(db).finalizeFileSourceDeletion(user, ['structure']);
    await repository.confirmCleanup(
      { ...localGone(lease), originalAbsent: true, textAndHistoryRemoved: true },
      now,
    );
    expect(await raw()).not.toHaveProperty('documentStructure');
    expect(await raw()).not.toHaveProperty('text');
    expect((await repository.metrics(now)).textBytes).toBe(0);
  });

  it('does not admit structure through generic File creation or dotted updates', async () => {
    const files = createFileMethods(db);
    const document = result();
    await files.createFile(
      {
        file_id: 'legacy',
        user: new mongoose.Types.ObjectId(user.userId),
        filename: 'legacy.txt',
        filepath: '/legacy',
        bytes: 8,
        type: 'text/plain',
        text: 'legacy text',
        documentStructure: document.structure,
      },
      true,
    );
    await files.updateFile({
      file_id: 'legacy',
      'documentStructure.source.sha256': sha256,
    } as never);
    const file = await db.models.File.collection.findOne({ file_id: 'legacy' });
    expect(file).not.toHaveProperty('documentStructure');
    expect(file!.text).toBe('legacy text');
  });
});
