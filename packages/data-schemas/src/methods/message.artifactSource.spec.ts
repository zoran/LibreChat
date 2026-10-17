/** Real Mongo capture/retention fences; scanner and original-storage receipts are explicit fixtures. */
import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { v4 as uuid } from 'uuid';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { uploadDerivedExpiresAt } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { IMessage, IMongoFile } from '~/types';
import { createMessageMethods } from './message';
import { createFileRetentionMethods } from './fileRetention';
import { createUploadStore } from './uploadManagementStore';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createModels } from '~/models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

describe('atomic native artifact source capture', () => {
  const db = new mongoose.Mongoose();
  const messages = createMessageMethods(db);
  const policy = 'c'.repeat(64);
  const lifecycle = createFileRetentionMethods(db, { securityPolicySha256: policy });
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

  async function source() {
    const id = uuid();
    const now = Date.now();
    const text = 'Synthetic approved source.\n';
    const bytes = Buffer.byteLength(text);
    const sha256 = createHash('sha256').update(text).digest('hex');
    await transaction(async (session) => {
      await lifecycle.acceptManagedUpload(
        {
          principal: { ...owner, authentication: 'verified-email' },
          operationId: id,
          filename: 'synthetic.txt',
          mediaType: 'text/plain',
          transferGeneration: 1,
          acceptedAt: now,
          expiresAt: uploadDerivedExpiresAt(now),
          receipt: {
            outcome: 'durable',
            bytes,
            source: 's3',
            filepath: `/api/files/managed/${id}`,
            storageKey: `t/${owner.tenantId}/managed-uploads/${owner.userId}/${id}.1__original`,
            integrity: {
              version: 1,
              algorithm: 'sha256',
              sha256,
              chunkBytes: 262144,
              chunkSha256: [sha256],
            },
          },
          securityApproval: {
            version: 1,
            decision: 'approved',
            policySha256: policy,
            subject: {
              ...owner,
              operationId: id,
              transferGeneration: 1,
              mediaType: 'text/plain',
              bytes,
              sha256,
            },
            scannerVersion: 'explicit-synthetic-scanner/v1',
            checkedAt: new Date(now).toISOString(),
            coverage: { complete: true, pages: 1, parts: 1 },
          },
        },
        session,
      );
      await lifecycle.claimManagedUploadProcessing(owner, id, 1, now, session);
      await lifecycle.publishManagedUpload(
        owner,
        id,
        1,
        {
          text,
          structure: {
            version: 1,
            source: { sha256, bytes, mediaType: 'text/plain' },
            extractor: { name: 'synthetic-fixture', version: '1' },
            pages: [],
            elements: [
              {
                id: 'e1',
                kind: 'paragraph',
                start: 0,
                end: text.length,
                page: null,
                parentId: null,
              },
            ],
            quality: { status: 'complete', warnings: [] },
          },
        },
        now,
        session,
      );
    });
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
    conversationId: row.conversationId,
    messageId: row.messageId,
    expectedVersion: row.__v ?? null,
    artifactIndex: 0,
  });
  const capture = (row: IMessage) =>
    transaction((session) => messages.captureMessageArtifactSource(owner, inputFor(row), session));

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'message-artifact-source-'));
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
    await db.connect(mongo.getUri('message-artifact-source'), { serverSelectionTimeoutMS: 5000 });
    createModels(db);
    await Promise.all([db.models.Message.init(), db.models.File.init()]);
  });
  beforeEach(async () => {
    process.env.UPLOAD_SECURITY_POLICY_SHA256 = policy;
    process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = 'true';
    await createUploadStore(db, { enabled: true, reconciled: true }).initialize();
  });
  afterEach(async () => {
    await runAsSystem(async () => {
      await db.models.Message.deleteMany({});
      await db.models.File.deleteMany({});
    });
    await db.models.UploadCounter.deleteMany({});
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

  it('captures actual artifact bytes and all body sources with transactional fences', async () =>
    run(async () => {
      const ids = [await source(), await source()];
      const row = await message(ids);
      const before = await db.models.File.find({ file_id: { $in: ids } }).lean<IMongoFile[]>();
      const result = await capture(row);
      expect(result.artifact.content).toBe('# Entwurf\nBelegter Text.\n');
      expect(result.sourceFileIds).toEqual([...ids].sort());
      expect(result.anchor).toEqual({
        conversationId: row.conversationId,
        messageId: row.messageId,
        messageVersion: row.__v,
        artifactIndex: 0,
        source: 'text',
      });
      expect(
        (await db.models.Message.findOne({ messageId: row.messageId }).lean<IMessage>())!.__v,
      ).toBe(row.__v! + 1);
      for (const item of before)
        expect(
          (await db.models.File.findOne({ file_id: item.file_id }).lean<IMongoFile>())!
            .retentionRevision,
        ).toBe(item.retentionRevision! + 1);
    }));

  it('includes all native quote sources even when displayed coverage names only a body source', async () =>
    run(async () => {
      const body = await source();
      const quoted = await source();
      const quotedMessage = await message([quoted]);
      const quoteRetention = await messages.resolveQuoteRetention(owner, [
        { text: 'Synthetic quote', sourceRef: { messageId: quotedMessage.messageId } },
      ]);
      const row = await message([body]);
      const retention = await messages.resolveFileRetentionContext(owner, {
        fileIds: [body],
        historyMessageIds: [],
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
          sourceRetention: retention,
          sourceCoverage: {
            version: 1,
            stage: 'prepared',
            scope: 'retained_sources',
            entries: [
              {
                file_id: body,
                source: { kind: 'message', id: row.messageId },
                coverage: { unit: 'utf16', start: 0, end: 4, total: 20, complete: false },
                extraction: 'not_assessed',
              },
            ],
          },
        },
      );
      const current = (await db.models.Message.findOne({
        messageId: row.messageId,
      }).lean<IMessage>())!;
      const result = await capture(current);
      expect(result.sourceFileIds).toEqual([body, quoted].sort());
      expect(result.artifact.content).toBe('# Entwurf\nBelegter Text.\n');
      expect(result).not.toHaveProperty('quotes');
    }));

  it('uses the native content-part reader and returns no surrounding message body', async () =>
    run(async () => {
      const row = await message([await source()], {
        text: 'Not part of the draft.',
        content: [
          {
            type: 'text',
            text: 'Outside.\n:::artifact{identifier="code" type="text/plain" title="Draft"}\nexact\r\nbytes\n:::\nAfter.',
          },
        ],
      });
      const result = await capture(row);
      expect(result.artifact.content).toBe('exact\r\nbytes\n');
      expect(result.anchor).toMatchObject({ source: 'content', partIndex: 0 });
      expect(result.artifact).not.toHaveProperty('text');
    }));

  it.each(['owner', 'tenant', 'conversation', 'version', 'index'] as const)(
    'refuses a foreign or stale %s without changing either fence',
    async (kind) =>
      run(async () => {
        const id = await source();
        const row = await message([id]);
        const before = await db.models.File.findOne({ file_id: id }).lean<IMongoFile>();
        const input = inputFor(row);
        const principal = { ...owner };
        if (kind === 'owner') principal.userId = new mongoose.Types.ObjectId().toString();
        if (kind === 'tenant') principal.tenantId = 'another-tenant';
        if (kind === 'conversation') input.conversationId = uuid();
        if (kind === 'version') input.expectedVersion = row.__v! + 1;
        if (kind === 'index') input.artifactIndex = 1;
        await expect(
          transaction((session) =>
            messages.captureMessageArtifactSource(principal, input, session),
          ),
        ).rejects.toThrow();
        expect(
          (await db.models.Message.findOne({ messageId: row.messageId }).lean<IMessage>())!.__v,
        ).toBe(row.__v);
        expect(
          (await db.models.File.findOne({ file_id: id }).lean<IMongoFile>())!.retentionRevision,
        ).toBe(before!.retentionRevision);
      }),
  );

  it.each([
    'unbound-body',
    'empty-body',
    'unbound-quote',
    'duplicate-quote',
    'expired-quote',
    'removed-body',
    'expired-body',
    'expired-message',
    'unfinished',
    'private',
    'unknown-attachment',
  ] as const)(
    'fails closed for %s rather than inventing a complete provenance proof',
    async (kind) =>
      run(async () => {
        const id = await source();
        const row = await message([id]);
        const collection = db.models.Message.collection;
        const filter = { messageId: row.messageId };
        const future = new Date(Date.now() + 60_000);
        const binding = {
          index: 0,
          sourceRef: { messageId: uuid() },
          sourceFileIds: [id],
          sourceExpiresAt: future,
        };
        if (kind === 'unbound-body')
          await collection.updateOne(filter, { $unset: { sourceFileIds: '' } });
        if (kind === 'empty-body')
          await collection.updateOne(filter, { $set: { sourceFileIds: [] } });
        if (kind === 'unbound-quote')
          await collection.updateOne(filter, { $set: { quotes: ['unknown'] } });
        if (kind === 'duplicate-quote')
          await collection.updateOne(filter, {
            $set: { quotes: ['a', 'b'], quoteSourceRetention: [binding, binding] },
          });
        if (kind === 'expired-quote')
          await collection.updateOne(filter, {
            $set: {
              quotes: ['a'],
              quoteSourceRetention: [{ ...binding, sourceExpiresAt: new Date(0) }],
            },
          });
        if (kind === 'removed-body')
          await collection.updateOne(filter, { $set: { sourceContentRemovedAt: new Date() } });
        if (kind === 'expired-body')
          await collection.updateOne(filter, { $set: { sourceExpiresAt: new Date(0) } });
        if (kind === 'expired-message')
          await collection.updateOne(filter, { $set: { expiredAt: new Date(0) } });
        if (kind === 'unfinished')
          await collection.updateOne(filter, { $set: { unfinished: true } });
        if (kind === 'private')
          await collection.updateOne(filter, { $set: { privateText: 'encrypted-test-fixture' } });
        if (kind === 'unknown-attachment')
          await collection.updateOne(filter, { $set: { attachments: [{ file_id: uuid() }] } });
        await expect(capture(row)).rejects.toThrow();
      }),
  );

  it('retains attachment dependencies and accepts a missing legacy revision only exactly once', async () =>
    run(async () => {
      const body = await source();
      const attachment = await source();
      const row = await message([body], { files: [{ file_id: attachment }] });
      await db.models.Message.collection.updateOne(
        { messageId: row.messageId },
        { $unset: { __v: '' } },
      );
      const legacy = { ...row, __v: undefined } as IMessage;
      expect((await capture(legacy)).sourceFileIds).toEqual([body, attachment].sort());
      await expect(capture(legacy)).rejects.toThrow();
      expect(
        (await db.models.Message.findOne({ messageId: row.messageId }).lean<IMessage>())!.__v,
      ).toBe(1);
    }));

  it.each(['revoked', 'expired', 'missing-approval', 'foreign-policy'] as const)(
    'refuses a %s source even when ordinary upload-management is disabled',
    async (kind) =>
      run(async () => {
        const id = await source();
        const row = await message([id]);
        if (kind === 'revoked')
          await transaction((session) =>
            lifecycle.revokeManagedUpload(owner, id, Date.now(), session),
          );
        if (kind === 'expired')
          await db.models.File.collection.updateOne(
            { file_id: id },
            { $set: { expiredAt: new Date(0) } },
          );
        if (kind === 'missing-approval')
          await db.models.File.collection.updateOne(
            { file_id: id },
            { $unset: { securityApproval: '' } },
          );
        if (kind === 'foreign-policy') process.env.UPLOAD_SECURITY_POLICY_SHA256 = 'd'.repeat(64);
        process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = 'false';
        await expect(capture(row)).rejects.toThrow();
      }),
  );

  it('requires an active session from this Mongo client and never starts its own transaction', async () =>
    run(async () => {
      const row = await message([await source()]);
      const idle = await db.startSession();
      const other = new mongoose.Mongoose();
      await other.connect(mongo.getUri('message-artifact-source'));
      const foreign = await other.startSession();
      try {
        await expect(
          messages.captureMessageArtifactSource(owner, inputFor(row), idle),
        ).rejects.toThrow();
        expect(idle.inTransaction()).toBe(false);
        foreign.startTransaction();
        await expect(
          messages.captureMessageArtifactSource(owner, inputFor(row), foreign),
        ).rejects.toThrow();
      } finally {
        if (foreign.inTransaction()) await foreign.abortTransaction();
        await foreign.endSession();
        await idle.endSession();
        await other.disconnect();
      }
    }));

  it('snapshots identity before awaiting and rejects accessor inputs without invoking them', async () =>
    run(async () => {
      const row = await message([await source()]);
      const input = inputFor(row);
      const result = await transaction(async (session) => {
        const pending = messages.captureMessageArtifactSource(owner, input, session);
        input.messageId = uuid();
        input.conversationId = uuid();
        input.artifactIndex = 500;
        return pending;
      });
      expect(result.anchor.messageId).toBe(row.messageId);
      const getter = jest.fn(() => row.messageId);
      const malformed = { ...inputFor(row) };
      Object.defineProperty(malformed, 'messageId', { get: getter });
      await expect(
        transaction((session) => messages.captureMessageArtifactSource(owner, malformed, session)),
      ).rejects.toThrow();
      expect(getter).not.toHaveBeenCalled();
    }));

  it('rolls Message and File fences back together when the caller aborts', async () =>
    run(async () => {
      const id = await source();
      const row = await message([id]);
      const before = await db.models.File.findOne({ file_id: id }).lean<IMongoFile>();
      await expect(
        transaction(async (session) => {
          await messages.captureMessageArtifactSource(owner, inputFor(row), session);
          throw new Error('caller declined draft');
        }),
      ).rejects.toThrow('caller declined draft');
      expect(
        (await db.models.Message.findOne({ messageId: row.messageId }).lean<IMessage>())!.__v,
      ).toBe(row.__v);
      expect(
        (await db.models.File.findOne({ file_id: id }).lean<IMongoFile>())!.retentionRevision,
      ).toBe(before!.retentionRevision);
      expect((await capture(row)).anchor.messageVersion).toBe(row.__v);
    }));

  it('admits only one capture or edit of the same native message revision', async () =>
    run(async () => {
      const row = await message([await source()]);
      const results = await Promise.allSettled([
        capture(row),
        messages.saveMessage(
          owner,
          { messageId: row.messageId, conversationId: row.conversationId, text: 'concurrent edit' },
          { expectedVersion: row.__v },
        ),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(
        (await db.models.Message.findOne({ messageId: row.messageId }).lean<IMessage>())!.__v,
      ).toBe(row.__v! + 1);
    }));

  it('serializes source revocation against the actual File write fence', async () =>
    run(async () => {
      const id = await source();
      const row = await message([id]);
      const session = await db.startSession();
      try {
        session.startTransaction();
        await messages.captureMessageArtifactSource(owner, inputFor(row), session);
        await expect(
          transaction((other) => lifecycle.revokeManagedUpload(owner, id, Date.now(), other)),
        ).rejects.toThrow();
        await session.commitTransaction();
      } finally {
        if (session.inTransaction()) await session.abortTransaction();
        await session.endSession();
      }
      await transaction((other) => lifecycle.revokeManagedUpload(owner, id, Date.now(), other));
      const latest = (await db.models.Message.findOne({
        messageId: row.messageId,
      }).lean<IMessage>())!;
      await expect(capture(latest)).rejects.toThrow();
    }));

  it('checks the chat lifetime at capture without turning it into a document-source deadline', async () =>
    run(async () => {
      const row = await message([await source()], {
        expiredAt: new Date(Date.now() + 30_000),
        isTemporary: true,
      });
      const result = await capture(row);
      expect(result.sourceExpiresAt.getTime()).toBeGreaterThan(new Date(row.expiredAt!).getTime());
      await db.models.Message.deleteOne({ messageId: row.messageId });
      expect(result.artifact.content).toBe('# Entwurf\nBelegter Text.\n');
      const files = await lifecycle.getManagedUploadAvailability(
        owner,
        result.sourceFileIds,
        Date.now(),
      );
      expect(files.every((file) => file.ready)).toBe(true);
      await expect(capture(row)).rejects.toThrow();
    }));
});
