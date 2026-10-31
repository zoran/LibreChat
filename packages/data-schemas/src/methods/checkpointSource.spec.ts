/** Real Mongo capture/retention fences; scanner and original-storage receipts are explicit fixtures. */
import mongoose from 'mongoose';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v4 as uuid } from 'uuid';
import { mkdtemp, rm } from 'node:fs/promises';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { UploadLease, UploadPrincipal } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { IMessage, IMongoFile } from '~/types';
import {
  uploadSecurityFixture,
  bindUploadOriginalFixture,
  uploadSecuritySettlementFixture,
} from './uploadManagement.security.fixture';
import { createCheckpointSourceMethods, snapshotCheckpointSourceBinding } from './checkpointSource';
import { createFileRetentionMethods, resizeRetainedDerivatives } from './fileRetention';
import { createUploadManagementRepository } from './uploadManagement';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createUploadStore } from './uploadManagementStore';
import { createMessageMethods } from './message';
import { sourceSha256 } from './messageSource';
import { createFileMethods } from './file';
import { createModels } from '~/models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

describe('atomic checkpoint source witnesses', () => {
  const db = new mongoose.Mongoose();
  const messages = createMessageMethods(db);
  const policy = 'c'.repeat(64);
  createFileRetentionMethods(db, { securityPolicySha256: policy });
  const owner = { userId: new mongoose.Types.ObjectId().toString(), tenantId: 'artifact-source' };
  const run = <T>(action: () => Promise<T>) =>
    tenantStorage.run({ tenantId: owner.tenantId }, action);
  const previous = {
    UPLOAD_SECURITY_POLICY_SHA256: process.env.UPLOAD_SECURITY_POLICY_SHA256,
    CORTEX_UPLOAD_MANAGEMENT_ENABLED: process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED,
  };
  let mongo: MongoMemoryReplSet;
  let directory: string;

  async function transaction<T>(action: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await db.startSession();
    try {
      session.startTransaction();
      const result = await action(session);
      await session.commitTransaction();
      return result;
    } catch (error) {
      if (session.inTransaction()) await session.abortTransaction();
      throw error;
    } finally {
      await session.endSession();
    }
  }

  /** Managed fixtures retain the actual receipt and birth inventory from their owning lifecycle. */
  async function managedSource(fileId: string, at: number) {
    const uploads = createUploadManagementRepository(db, {
      enabled: true,
      reconciled: true,
      securityPolicySha256: policy,
    });
    await uploads.initialize();
    const principal: UploadPrincipal = {
      tenantId: owner.tenantId,
      userId: owner.userId,
      authentication: 'verified-email',
    };
    const worker = { hostId: 'fixture-host', instanceId: 'fixture-instance' };
    const reservation = await uploads.reserve(
      principal,
      {
        operationId: fileId,
        idempotencyKey: uuid(),
        mediaType: 'text/plain',
        declaredBytes: 6,
        fingerprint: JSON.stringify([{ kind: 'personal' }, 'text/plain', 6]),
      },
      at,
    );
    const transfer = await uploads.claim({
      kind: 'transfer',
      principal,
      operationId: reservation.id,
      worker,
      now: at,
    });
    if (!transfer) throw new Error('Managed fixture transfer was not admitted');
    const security = uploadSecurityFixture(
      uploadSecurityFixture({
        decision: 'approved',
        policySha256: policy,
        subject: {
          userId: owner.userId,
          tenantId: owner.tenantId,
          operationId: fileId,
          transferGeneration: transfer.generation,
          mediaType: 'text/plain',
          bytes: 6,
          sha256: 'a'.repeat(64),
        },
        scannerVersion: 'fixture-v1',
        checkedAt: new Date(at).toISOString(),
        coverage: { complete: true, pages: 1, parts: 1 },
      }).approval,
      {
        custody: { kind: 'none' as const },
        attemptId: `${fileId}.${transfer.generation}`,
        instanceId: uuid(),
        executionId: uuid(),
        expiresAt: new Date(at + 60000).toISOString(),
      },
    );
    const execution = security.execution;
    const originalFixture: Parameters<typeof uploads.accept>[2] = {
      outcome: 'durable',
      bytes: 6,
      source: 's3',
      filepath: `/api/files/download/${fileId}`,
      storageKey: `t/${owner.tenantId}/managed-uploads/${owner.userId}/${fileId}.${transfer.generation}__original`,
      integrity: {
        version: 1,
        algorithm: 'sha256',
        sha256: 'a'.repeat(64),
        chunkBytes: 262144,
        chunkSha256: ['b'.repeat(64)],
      },
    };
    await uploads.bindSecurityExecution(transfer, execution, at);
    await uploads.settleSecurityExecution(
      transfer,
      uploadSecuritySettlementFixture(execution, {
        writerStopped: true,
        transientDataRemoved: true,
      }),
      at,
    );
    await bindUploadOriginalFixture(
      uploads,
      transfer,
      originalFixture,
      uploadSecurityFixture({
        decision: 'approved',
        policySha256: policy,
        subject: {
          userId: owner.userId,
          tenantId: owner.tenantId,
          operationId: fileId,
          transferGeneration: transfer.generation,
          mediaType: 'text/plain',
          bytes: 6,
          sha256: 'a'.repeat(64),
        },
        scannerVersion: 'fixture-v1',
        checkedAt: new Date(at).toISOString(),
        coverage: { complete: true, pages: 1, parts: 1 },
      }).approval,
      at,
    );
    await uploads.accept(
      principal,
      transfer,
      originalFixture,
      uploadSecurityFixture({
        decision: 'approved',
        policySha256: policy,
        subject: {
          userId: owner.userId,
          tenantId: owner.tenantId,
          operationId: fileId,
          transferGeneration: transfer.generation,
          mediaType: 'text/plain',
          bytes: 6,
          sha256: 'a'.repeat(64),
        },
        scannerVersion: 'fixture-v1',
        checkedAt: new Date(at).toISOString(),
        coverage: { complete: true, pages: 1, parts: 1 },
      }).approval,
      { filename: 'A.txt' },
      at,
    );
    const settleLocalCopies = (lease: UploadLease) =>
      uploads.confirmCleanup(
        {
          operationId: lease.operationId,
          generation: lease.generation,
          writerStopped: true,
          localCopiesAbsent: true,
          originalAbsent: false,
          textAndHistoryRemoved: false,
        },
        at,
      );
    await settleLocalCopies(transfer);
    const processing = await uploads.claim({ kind: 'processing', worker, now: at });
    if (!processing || processing.operationId !== fileId)
      throw new Error('Managed fixture processing was not admitted');
    await uploads.bindProcessingExecution(
      processing,
      {
        attemptId: `${fileId}.${processing.generation}`,
        instanceId: 'fixture-parser',
        expiresAt: new Date(at + 60000).toISOString(),
      },
      at,
    );
    await uploads.publish(
      processing,
      {
        text: 'secret',
        writerStopped: true,
        structure: {
          version: 1,
          source: { sha256: 'a'.repeat(64), bytes: 6, mediaType: 'text/plain' },
          extractor: { name: 'fixture', version: '1' },
          pages: [],
          elements: [{ id: 'e1', kind: 'paragraph', start: 0, end: 6, page: null, parentId: null }],
          quality: { status: 'complete', warnings: [] },
        },
      },
      at,
    );
    await settleLocalCopies(processing);
  }

  async function source() {
    const id = uuid();
    await managedSource(id, Date.now());
    return id;
  }

  async function message(fileIds: string[], fields: Partial<IMessage> = {}) {
    const input = {
      messageId: uuid(),
      conversationId: uuid(),
      isCreatedByUser: false,
      text: 'Intro\n:::artifact{identifier="report" type="text/markdown" title="Report"}\n# Entwurf\nBelegter Text.\n:::\n',
      ...fields,
    };
    const retention = await messages.resolveFileRetentionContext(owner, {
      fileIds,
      historyMessageIds: [],
    });
    await messages.saveMessage(
      { ...owner, isTemporary: fields.isTemporary, expiredAt: fields.expiredAt ?? undefined },
      input,
      { sourceRetention: retention },
    );
    return (await db.models.Message.findOne({ messageId: input.messageId }).lean<IMessage>())!;
  }
  const inputFor = (row: IMessage) => ({
    messages: [
      {
        conversationId: row.conversationId,
        messageId: row.messageId,
        expectedVersion: row.__v ?? null,
      },
    ],
    fileIds: [],
  });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'checkpoint-source-witness-'));
    mongo = await MongoMemoryReplSet.create({
      binary: {
        version: process.env.MONGOMS_VERSION ?? '7.0.43',
        ...(process.env.MONGOMS_SYSTEM_BINARY
          ? { systemBinary: process.env.MONGOMS_SYSTEM_BINARY }
          : {}),
      },
      instanceOpts: [{ dbPath: directory }],
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    await db.connect(mongo.getUri('checkpoint-source-witness'), { serverSelectionTimeoutMS: 5000 });
    createModels(db);
    await Promise.all([db.models.Message.init(), db.models.File.init()]);
  });
  beforeEach(async () => {
    process.env.UPLOAD_SECURITY_POLICY_SHA256 = policy;
    process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = 'true';
    await db.models.User.create({
      _id: owner.userId,
      tenantId: owner.tenantId,
      name: 'Synthetic checkpoint owner',
      email: 'checkpoint@example.invalid',
      provider: 'local',
    });
    await createUploadStore(db, { enabled: true, reconciled: true }).initialize();
  });
  afterEach(async () => {
    await runAsSystem(async () => {
      await db.models.User.deleteMany({});
      await db.models.Message.deleteMany({});
      await db.models.File.deleteMany({});
    });
    await db.models.UploadCounter.deleteMany({});
    await db.models.UploadOperation.deleteMany({});
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  afterAll(async () => {
    try {
      await db.disconnect();
    } finally {
      try {
        await mongo?.stop();
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it('captures a complete approved Message and repeatedly fences its unchanged body', async () =>
    run(async () => {
      const id = await source();
      const row = await message([id]);
      expect(createCheckpointSourceMethods).toEqual(expect.any(Function));
      const checkpoint = createCheckpointSourceMethods(db);
      const captured = await transaction((session) =>
        checkpoint.captureCheckpointSources(owner, inputFor(row), session),
      );
      expect(captured.messages).toEqual([
        {
          conversationId: row.conversationId,
          messageId: row.messageId,
          text: row.text,
          content: row.content,
          quotes: row.quotes,
        },
      ]);
      expect(captured.binding.files.map((file) => file.fileId)).toEqual([id]);
      expect(JSON.stringify(captured.binding)).not.toContain('Entwurf');
      expect(Object.isFrozen(captured.binding)).toBe(true);
      await transaction((session) =>
        checkpoint.fenceCheckpointSources(owner, captured.binding, session),
      );
      await transaction((session) =>
        checkpoint.fenceCheckpointSources(owner, captured.binding, session),
      );
    }));

  const checkpoint = () => createCheckpointSourceMethods(db);
  const capture = (row: IMessage) =>
    transaction((session) => checkpoint().captureCheckpointSources(owner, inputFor(row), session));
  const revisions = async (row: IMessage, id: string) => ({
    user: (await db.models.User.findById(owner.userId).lean<{ __v: number }>())!.__v,
    message: (await db.models.Message.findOne({ messageId: row.messageId }).lean<IMessage>())!.__v,
    file: (await db.models.File.findOne({ file_id: id }).lean<IMongoFile>())!.retentionRevision,
  });

  it('captures full text/content, quote and attachment sources without relying on displayed coverage', async () =>
    run(async () => {
      const ids = [await source(), await source(), await source(), await source()];
      const quoted = await message([ids[1]]);
      const quoteRetention = await messages.resolveQuoteRetention(owner, [
        { text: 'Synthetic quotation', sourceRef: { messageId: quoted.messageId } },
      ]);
      const row = await message([ids[0]], {
        content: [{ type: 'text', text: 'Full synthetic content' }],
      });
      await messages.saveMessage(
        owner,
        {
          messageId: row.messageId,
          conversationId: row.conversationId,
          isCreatedByUser: false,
          quotes: quoteRetention.quotes,
        },
        {
          quoteRetention,
          sourceRetention: await messages.resolveFileRetentionContext(owner, {
            fileIds: [ids[0]],
            historyMessageIds: [],
          }),
        },
      );
      await db.models.Message.collection.updateOne(
        { messageId: row.messageId },
        {
          $set: { files: [{ file_id: ids[2] }], attachments: [{ file_id: ids[3] }] },
        },
      );
      const current = (await db.models.Message.findOne({
        messageId: row.messageId,
      }).lean<IMessage>())!;
      const result = await capture(current);
      expect(result.binding.files.map((file) => file.fileId)).toEqual([...ids].sort());
      expect(result.binding.messages[0].sourceFileIds).toEqual([...ids].sort());
      expect(result.messages[0]).toMatchObject({
        text: row.text,
        content: row.content,
        quotes: ['Synthetic quotation'],
      });
      result.messages[0].text = 'Caller changed detached snapshot';
      expect(
        (await db.models.Message.findOne({ messageId: row.messageId }).lean<IMessage>())!.text,
      ).toBe(row.text);
      expect(Object.isFrozen(result.binding.files)).toBe(true);
      expect(Object.isFrozen(result.binding.owner)).toBe(true);
      expect(Object.isFrozen(result.binding.messages[0].sourceFileIds)).toBe(true);
    }));

  it('captures direct approved File sources without inventing a Message or artifact reference', async () =>
    run(async () => {
      const id = await source();
      const result = await transaction((session) =>
        checkpoint().captureCheckpointSources(owner, { messages: [], fileIds: [id] }, session),
      );
      expect(result.messages).toEqual([]);
      expect(result.binding.messages).toEqual([]);
      await transaction((session) =>
        checkpoint().fenceCheckpointSources(owner, result.binding, session),
      );
    }));

  it.each([
    'text',
    'content',
    'quote',
    'quote-ref',
    'quote-sources',
    'body-sources',
    'attachment',
    'expired',
    'removed',
    'unfinished',
    'error',
    'private',
    'missing',
    'foreign-owner',
    'foreign-tenant',
  ] as const)('rejects a changed or unavailable Message source: %s', async (kind) =>
    run(async () => {
      const id = await source();
      const row = await message([id]);
      const binding = {
        index: 0,
        sourceRef: { messageId: uuid() },
        sourceFileIds: [id],
        sourceExpiresAt: new Date(Date.now() + 60000),
      };
      await db.models.Message.collection.updateOne(
        { messageId: row.messageId },
        {
          $set: { quotes: ['original synthetic quote'], quoteSourceRetention: [binding] },
        },
      );
      const captured = await capture(row);
      const changes: Record<string, unknown> = {};
      if (kind === 'text') changes.text = 'Changed complete body';
      if (kind === 'content') changes.content = [{ type: 'text', text: 'Changed part' }];
      if (kind === 'quote') changes.quotes = ['Changed quotation'];
      if (kind === 'quote-ref') changes['quoteSourceRetention.0.sourceRef.messageId'] = uuid();
      if (kind === 'quote-sources')
        changes['quoteSourceRetention.0.sourceFileIds'] = [await source()];
      if (kind === 'body-sources') changes.sourceFileIds = [await source()];
      if (kind === 'attachment') changes.attachments = [{ file_id: await source() }];
      if (kind === 'expired') changes.expiredAt = new Date(0);
      if (kind === 'removed') changes.sourceContentRemovedAt = new Date();
      if (kind === 'unfinished') changes.unfinished = true;
      if (kind === 'error') changes.error = true;
      if (kind === 'private') changes.privateText = 'synthetic-ciphertext';
      if (kind === 'foreign-owner') changes.user = new mongoose.Types.ObjectId().toString();
      if (kind === 'foreign-tenant') changes.tenantId = 'another-tenant';
      if (kind === 'missing')
        await db.models.Message.collection.deleteOne({ messageId: row.messageId });
      else
        await db.models.Message.collection.updateOne(
          { messageId: row.messageId },
          { $set: changes },
        );
      await expect(
        transaction((session) =>
          checkpoint().fenceCheckpointSources(owner, captured.binding, session),
        ),
      ).rejects.toThrow();
    }),
  );

  it.each([
    'approval',
    'policy',
    'expiry',
    'revocation',
    'removed',
    'owner',
    'tenant',
    'unapproved',
  ] as const)('rejects a changed File witness: %s', async (kind) =>
    run(async () => {
      const id = await source();
      const row = await message([id]);
      const captured = await capture(row);
      const before = await revisions(row, id);
      const changes: Record<string, unknown> = {};
      if (kind === 'approval') changes['securityApproval.scannerVersion'] = 'synthetic-other/v2';
      if (kind === 'policy') process.env.UPLOAD_SECURITY_POLICY_SHA256 = 'd'.repeat(64);
      if (kind === 'expiry') changes.expiredAt = new Date(Date.now() + 1000);
      if (kind === 'revocation') changes.deletionRequestedAt = new Date();
      if (kind === 'owner') changes.user = new mongoose.Types.ObjectId();
      if (kind === 'tenant') changes.tenantId = 'another-tenant';
      if (kind === 'unapproved') changes.securityApproval = null;
      if (kind === 'removed') await db.models.File.collection.deleteOne({ file_id: id });
      else if (Object.keys(changes).length)
        await db.models.File.collection.updateOne({ file_id: id }, { $set: changes });
      await expect(
        transaction((session) =>
          checkpoint().fenceCheckpointSources(owner, captured.binding, session),
        ),
      ).rejects.toThrow();
      expect((await db.models.User.findById(owner.userId).lean<{ __v: number }>())!.__v).toBe(
        before.user,
      );
      expect(
        (await db.models.Message.findOne({ messageId: row.messageId }).lean<IMessage>())!.__v,
      ).toBe(before.message);
    }),
  );

  it.each(['deleted', 'deleting', 'disabled', 'tenant'] as const)(
    'fences the real User principal for capture and resume: %s',
    async (kind) =>
      run(async () => {
        const id = await source();
        const row = await message([id]);
        const captured = await capture(row);
        if (kind === 'deleted')
          await db.models.User.collection.deleteOne({
            _id: new mongoose.Types.ObjectId(owner.userId),
          });
        else {
          const changes = {
            deleting: { agentTriggerDeletionStartedAt: new Date() },
            disabled: { authDisabled: true },
            tenant: { tenantId: 'another-tenant' },
          };
          await db.models.User.collection.updateOne(
            { _id: new mongoose.Types.ObjectId(owner.userId) },
            { $set: changes[kind] },
          );
        }
        await expect(
          transaction((session) =>
            checkpoint().fenceCheckpointSources(owner, captured.binding, session),
          ),
        ).rejects.toThrow();
        await expect(capture(row)).rejects.toThrow();
      }),
  );

  it('rolls back User, Message, File fences and retained copy liability with the caller write', async () =>
    run(async () => {
      const id = await source();
      const row = await message([id]);
      const before = await revisions(row, id);
      const file = await db.models.File.findOne({ file_id: id })
        .select('+retainedDerivativeBytes')
        .lean<IMongoFile>();
      await expect(
        transaction(async (session) => {
          const captured = await checkpoint().captureCheckpointSources(
            owner,
            inputFor(row),
            session,
          );
          await checkpoint().fenceCheckpointSources(owner, captured.binding, session);
          await resizeRetainedDerivatives(db, owner, [], [{ fileId: id, bytes: 200 }], session);
          throw new Error('synthetic checkpoint write failure');
        }),
      ).rejects.toThrow('synthetic checkpoint write failure');
      expect(await revisions(row, id)).toEqual(before);
      expect(
        (await db.models.File.findOne({ file_id: id })
          .select('+retainedDerivativeBytes')
          .lean<IMongoFile>())!.retainedDerivativeBytes,
      ).toBe(file!.retainedDerivativeBytes);
    }));

  it('uses the same File write conflict boundary as revoke, even from an older transaction snapshot', async () =>
    run(async () => {
      const id = await source();
      const row = await message([id]);
      const captured = await capture(row);
      const session = await db.startSession();
      try {
        session.startTransaction();
        await db.models.File.findOne({ file_id: id }).session(session).lean();
        await createFileMethods(db).revokeFileSources(owner, [id]);
        await expect(
          checkpoint().fenceCheckpointSources(owner, captured.binding, session),
        ).rejects.toThrow();
      } finally {
        if (session.inTransaction()) await session.abortTransaction();
        await session.endSession();
      }
      expect(
        (await db.models.File.findOne({ file_id: id }).lean<IMongoFile>())!.deletionRequestedAt,
      ).toBeInstanceOf(Date);
    }));

  it('rejects inactive, ended and foreign-client transactions instead of nesting a reservation', async () =>
    run(async () => {
      const id = await source();
      const row = await message([id]);
      const session = await db.startSession();
      await expect(
        checkpoint().captureCheckpointSources(owner, inputFor(row), session),
      ).rejects.toThrow();
      await session.endSession();
      await expect(
        checkpoint().captureCheckpointSources(owner, inputFor(row), session),
      ).rejects.toThrow();
      const foreign = new mongoose.Mongoose();
      await foreign.connect(mongo.getUri('checkpoint-source-witness'));
      const otherSession = await foreign.startSession();
      try {
        otherSession.startTransaction();
        await expect(
          checkpoint().captureCheckpointSources(owner, inputFor(row), otherSession),
        ).rejects.toThrow();
      } finally {
        if (otherSession.inTransaction()) await otherSession.abortTransaction();
        await otherSession.endSession();
        await foreign.disconnect();
      }
    }));

  it('requires the exact captured version, while supported unversioned source-bound rows use an absent-version CAS', async () =>
    run(async () => {
      const id = await source();
      const row = await message([id]);
      await expect(
        transaction((session) =>
          checkpoint().captureCheckpointSources(
            owner,
            {
              ...inputFor(row),
              messages: [{ ...inputFor(row).messages[0], expectedVersion: row.__v! + 1 }],
            },
            session,
          ),
        ),
      ).rejects.toThrow();
      await db.models.Message.collection.updateOne(
        { messageId: row.messageId },
        { $unset: { __v: '' } },
      );
      const captured = await capture({ ...row, __v: undefined } as IMessage);
      expect(captured.binding.messages[0].capturedVersion).toBeNull();
      await transaction((session) =>
        checkpoint().fenceCheckpointSources(owner, captured.binding, session),
      );
    }));

  it.each(['unbound', 'unbound-quote', 'duplicate-quote', 'expired-quote', 'legacy-file'] as const)(
    'requires complete provenance and current authority: %s',
    async (kind) =>
      run(async () => {
        const id = await source();
        const row = await message([id]);
        const binding = {
          index: 0,
          sourceRef: { messageId: uuid() },
          sourceFileIds: [id],
          sourceExpiresAt: new Date(Date.now() + 60000),
        };
        if (kind === 'unbound')
          await db.models.Message.collection.updateOne(
            { messageId: row.messageId },
            { $unset: { sourceFileIds: '' } },
          );
        if (kind === 'unbound-quote')
          await db.models.Message.collection.updateOne(
            { messageId: row.messageId },
            { $set: { quotes: ['unknown'] } },
          );
        if (kind === 'duplicate-quote')
          await db.models.Message.collection.updateOne(
            { messageId: row.messageId },
            { $set: { quotes: ['a', 'b'], quoteSourceRetention: [binding, binding] } },
          );
        if (kind === 'expired-quote')
          await db.models.Message.collection.updateOne(
            { messageId: row.messageId },
            {
              $set: {
                quotes: ['a'],
                quoteSourceRetention: [{ ...binding, sourceExpiresAt: new Date(0) }],
              },
            },
          );
        if (kind === 'legacy-file')
          await db.models.File.collection.updateOne(
            { file_id: id },
            { $unset: { retentionAcceptedAt: '', securityApproval: '', uploadOperationId: '' } },
          );
        if (kind === 'expired-quote')
          await expect(capture(row)).resolves.toMatchObject({
            binding: { files: [{ fileId: id }] },
          });
        else await expect(capture(row)).rejects.toThrow();
      }),
  );

  it('rejects malformed or forged binding data before the first User or source write', async () =>
    run(async () => {
      const id = await source();
      const row = await message([id]);
      const { binding } = await capture(row);
      const before = await revisions(row, id);
      let reads = 0;
      const accessor = { ...binding };
      Object.defineProperty(accessor, 'bindingSha256', {
        enumerable: true,
        get() {
          reads++;
          return binding.bindingSha256;
        },
      });
      for (const value of [
        accessor,
        Object.assign(Object.create({ inherited: true }), binding),
        new Proxy(binding, {}),
        { ...binding, bindingSha256: 'f'.repeat(64) },
        {
          ...binding,
          owner: { ...binding.owner, userId: new mongoose.Types.ObjectId().toString() },
        },
        { ...binding, unexpected: 'x' },
        { ...binding, unexpected: 'x'.repeat(32769) },
        { ...binding, files: [...binding.files, ...binding.files] },
        { ...binding, files: Array.from({ length: 65 }, () => binding.files[0]) },
      ]) {
        expect(() => snapshotCheckpointSourceBinding(owner, value)).toThrow();
        await expect(
          transaction((session) => checkpoint().fenceCheckpointSources(owner, value, session)),
        ).rejects.toThrow();
      }
      expect(reads).toBe(0);
      expect(await revisions(row, id)).toEqual(before);
    }));

  it('snapshots an intact expired binding without time authorization and rejects its live fence before writes', async () =>
    run(async () => {
      const id = await source();
      const row = await message([id]);
      const { binding } = await capture(row);
      const expired = '2000-01-01T00:00:00.000Z';
      const payload = {
        version: binding.version,
        owner: binding.owner,
        files: binding.files.map((file) => ({ ...file, expiresAt: expired })),
        messages: binding.messages.map((message) => ({ ...message, expiresAt: expired })),
        expiresAt: expired,
      };
      const value = { ...payload, bindingSha256: sourceSha256(payload) };
      const now = jest.spyOn(Date, 'now').mockImplementation(() => {
        throw new Error('Snapshot must not consult time');
      });
      let snapshot;
      try {
        snapshot = snapshotCheckpointSourceBinding(owner, value);
      } finally {
        now.mockRestore();
      }
      expect(snapshot).toEqual(value);
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.owner)).toBe(true);
      expect(Object.isFrozen(snapshot.files[0])).toBe(true);
      expect(Object.isFrozen(snapshot.messages[0].sourceFileIds)).toBe(true);
      value.files[0].bindingSha256 = 'f'.repeat(64);
      expect(snapshot.files[0].bindingSha256).toBe(binding.files[0].bindingSha256);
      expect(Reflect.set(snapshot.files, '1', binding.files[0])).toBe(false);
      const before = await revisions(row, id);
      await expect(
        transaction((session) => checkpoint().fenceCheckpointSources(owner, snapshot, session)),
      ).rejects.toThrow();
      expect(await revisions(row, id)).toEqual(before);
    }));

  it('detaches a caller binding before its first await', async () =>
    run(async () => {
      const row = await message([await source()]);
      const captured = await capture(row);
      const detached = JSON.parse(JSON.stringify(captured.binding));
      await transaction(async (session) => {
        const pending = checkpoint().fenceCheckpointSources(owner, detached, session);
        detached.messages[0].bodySha256 = 'f'.repeat(64);
        detached.files.length = 0;
        await expect(pending).resolves.toBeUndefined();
      });
    }));

  it('enforces count and encoded metadata limits before a transaction can write', async () =>
    run(async () => {
      const id = await source();
      const row = await message([id]);
      const before = await revisions(row, id);
      for (const input of [
        { messages: [], fileIds: [] },
        { messages: [], fileIds: Array.from({ length: 65 }, () => uuid()) },
        { messages: Array.from({ length: 65 }, () => inputFor(row).messages[0]), fileIds: [] },
        { ...inputFor(row), huge: 'x'.repeat(32769) },
      ])
        await expect(
          transaction((session) => checkpoint().captureCheckpointSources(owner, input, session)),
        ).rejects.toThrow();
      expect(await revisions(row, id)).toEqual(before);
    }));

  it('enforces a combined four MiB body budget across otherwise valid messages', async () =>
    run(async () => {
      const id = await source();
      const rows = [await message([id]), await message([id])];
      for (const row of rows)
        await db.models.Message.collection.updateOne(
          { messageId: row.messageId },
          { $set: { text: 'x'.repeat(2200000) } },
        );
      const before = await revisions(rows[0], id);
      await expect(
        transaction((session) =>
          checkpoint().captureCheckpointSources(
            owner,
            {
              messages: rows.flatMap((row) => inputFor(row).messages),
              fileIds: [],
            },
            session,
          ),
        ),
      ).rejects.toThrow();
      expect(await revisions(rows[0], id)).toEqual(before);
    }));
});
