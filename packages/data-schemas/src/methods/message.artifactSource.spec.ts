/** Real Mongo capture/retention fences; scanner and original-storage receipts are explicit fixtures. */
import mongoose from 'mongoose';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v4 as uuid } from 'uuid';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { UploadLease } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { IMessage, IMongoFile } from '~/types';
import {
  uploadSecurityFixture,
  bindUploadOriginalFixture,
  uploadSecuritySettlementFixture,
} from '../../specs/fixtures/uploadManagement.security.fixture';
import { createUploadManagementRepository } from './uploadManagement';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createFileRetentionMethods } from './fileRetention';
import { readCompleteMessageSource } from './messageSource';
import { createMessageMethods } from './message';
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
  let uploads: ReturnType<typeof createUploadManagementRepository>;

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
    const principal = { ...owner, authentication: 'verified-email' as const };
    const worker = { hostId: 'message-fixture', instanceId: 'message-fixture' };
    const reserved = await uploads.reserve(
      principal,
      {
        operationId: id,
        idempotencyKey: uuid(),
        mediaType: 'text/plain',
        declaredBytes: bytes,
        fingerprint: JSON.stringify([{ kind: 'personal' }, 'text/plain', bytes]),
      },
      now,
    );
    const transfer = await uploads.claim({
      kind: 'transfer',
      principal,
      operationId: reserved.id,
      worker,
      now,
    });
    expect(transfer).not.toBeNull();
    const security = uploadSecurityFixture(
      uploadSecurityFixture({
        decision: 'approved',
        policySha256: policy,
        subject: {
          ...owner,
          operationId: id,
          transferGeneration: transfer!.generation,
          mediaType: 'text/plain',
          bytes,
          sha256,
        },
        scannerVersion: 'explicit-synthetic-scanner/v1',
        checkedAt: new Date(now).toISOString(),
        coverage: { complete: true, pages: 1, parts: 1 },
      }).approval,
      {
        custody: { kind: 'none' as const },
        attemptId: `${id}.${transfer!.generation}`,
        instanceId: uuid(),
        executionId: uuid(),
        expiresAt: new Date(now + 60_000).toISOString(),
      },
    );
    const execution = security.execution;
    const originalFixture: Parameters<typeof uploads.accept>[2] = {
      outcome: 'durable',
      bytes,
      source: 's3',
      filepath: `/api/files/download/${id}`,
      storageKey: `t/${owner.tenantId}/managed-uploads/${owner.userId}/${id}.${transfer!.generation}__original`,
      integrity: {
        version: 1,
        algorithm: 'sha256',
        sha256,
        chunkBytes: 262144,
        chunkSha256: [sha256],
      },
    };
    await uploads.bindSecurityExecution(transfer!, execution, now);
    await uploads.settleSecurityExecution(
      transfer!,
      uploadSecuritySettlementFixture(execution, {
        writerStopped: true,
        transientDataRemoved: true,
      }),
      now,
    );
    await bindUploadOriginalFixture(
      uploads,
      transfer!,
      originalFixture,
      uploadSecurityFixture({
        decision: 'approved',
        policySha256: policy,
        subject: {
          ...owner,
          operationId: id,
          transferGeneration: transfer!.generation,
          mediaType: 'text/plain',
          bytes,
          sha256,
        },
        scannerVersion: 'explicit-synthetic-scanner/v1',
        checkedAt: new Date(now).toISOString(),
        coverage: { complete: true, pages: 1, parts: 1 },
      }).approval,
      now,
    );
    await uploads.accept(
      principal,
      transfer!,
      originalFixture,
      uploadSecurityFixture({
        decision: 'approved',
        policySha256: policy,
        subject: {
          ...owner,
          operationId: id,
          transferGeneration: transfer!.generation,
          mediaType: 'text/plain',
          bytes,
          sha256,
        },
        scannerVersion: 'explicit-synthetic-scanner/v1',
        checkedAt: new Date(now).toISOString(),
        coverage: { complete: true, pages: 1, parts: 1 },
      }).approval,
      { filename: 'synthetic.txt' },
      now,
    );
    const localGone = (lease: UploadLease) => ({
      operationId: lease.operationId,
      generation: lease.generation,
      writerStopped: true,
      localCopiesAbsent: true,
      originalAbsent: false,
      textAndHistoryRemoved: false,
    });
    await uploads.confirmCleanup(localGone(transfer!), now);
    const processing = await uploads.claim({ kind: 'processing', worker, now });
    expect(processing?.operationId).toBe(id);
    await uploads.bindProcessingExecution(
      processing!,
      {
        attemptId: `${id}.${processing!.generation}`,
        instanceId: 'message-parser',
        expiresAt: new Date(now + 60_000).toISOString(),
      },
      now,
    );
    await uploads.publish(
      processing!,
      {
        text,
        writerStopped: true,
        structure: {
          version: 1,
          source: { sha256, bytes, mediaType: 'text/plain' },
          extractor: { name: 'synthetic-fixture', version: '1' },
          pages: [],
          elements: [
            { id: 'e1', kind: 'paragraph', start: 0, end: text.length, page: null, parentId: null },
          ],
          quality: { status: 'complete', warnings: [] },
        },
      },
      now,
    );
    await uploads.confirmCleanup(localGone(processing!), now);
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
    await run(async () =>
      db.models.User.create({
        _id: owner.userId,
        tenantId: owner.tenantId,
        email: 'message-source@example.test',
        emailVerified: true,
      }),
    );
    uploads = createUploadManagementRepository(db, {
      enabled: true,
      reconciled: true,
      securityPolicySha256: policy,
      baseline: { originalBytes: 0, objectBytes: 0, textBytes: 0, recordBytes: 0, bundles: 0 },
    });
    await uploads.initialize();
  });
  afterEach(async () => {
    await runAsSystem(async () => {
      await db.models.Message.deleteMany({});
      await db.models.File.deleteMany({});
      await db.models.User.deleteMany({});
      await db.models.UploadOperation.deleteMany({});
      await db.models.FileReadReceipt.deleteMany({});
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

  it('uses current File deadlines beyond captured Message and quote expiry without changing source identity', async () =>
    run(async () => {
      const id = await source();
      const row = await message([id]);
      const quoteRetention = await messages.resolveQuoteRetention(owner, [
        { text: 'Bound quote', sourceRef: { messageId: row.messageId } },
      ]);
      const quoted = await message([id], { quotes: ['Bound quote'] });
      await db.models.Message.collection.updateOne(
        { messageId: quoted.messageId },
        { $set: { quoteSourceRetention: quoteRetention.quoteSourceRetention } },
      );
      const before = await transaction((session) =>
        readCompleteMessageSource(db, owner, inputFor(quoted), session),
      );
      const file = await db.models.File.findOne({ file_id: id }).lean<IMongoFile>();
      const current = new Date(file!.expiredAt!.getTime() + 7 * 86_400_000);
      const principal = { ...owner, authentication: 'verified-email' as const };
      const ticket = await uploads.fileReads.admitManagedFileRead(principal, {
        fileId: id,
        representation: 'original',
      });
      const claim = await uploads.fileReads.claimManagedFileRead(principal, ticket, {
        hostId: 'message-fixture',
        instanceId: 'message-reader',
      });
      const original = 'Synthetic approved source.\n';
      expect(
        await uploads.fileReads.completeManagedFileRead(principal, claim, {
          version: 1,
          representation: 'original',
          sourceBindingSha256: claim.sourceBindingSha256,
          contentSha256: createHash('sha256').update(original).digest('hex'),
          verifiedBytes: Buffer.byteLength(original),
        }),
      ).toMatchObject({ status: 'completed', firstCompletion: true });
      expect((await db.models.File.findOne({ file_id: id }).lean<IMongoFile>())!.expiredAt).toEqual(
        current,
      );
      await db.models.Message.collection.updateOne(
        { messageId: quoted.messageId },
        {
          $set: {
            sourceExpiresAt: new Date(0),
            quoteSourceRetention: quoteRetention.quoteSourceRetention.map((binding) => ({
              ...binding,
              sourceExpiresAt: new Date(0),
            })),
          },
        },
      );
      const after = await transaction((session) =>
        readCompleteMessageSource(db, owner, inputFor(quoted), session),
      );
      expect(after.bodySha256).toBe(before.bodySha256);
      expect(after.sourceExpiresAt).toEqual(current);
      expect(
        (await messages.getMessage({ user: owner.userId, messageId: quoted.messageId }))?.text,
      ).toBe(quoted.text);
      expect(
        await messages.resolveFileRetentionContext(owner, {
          fileIds: [],
          historyMessageIds: [quoted.messageId],
        }),
      ).toEqual({ sourceFileIds: [id], sourceExpiresAt: current });
      const refreshed = await messages.resolveQuoteRetention(owner, [
        {
          text: 'Selected quote',
          sourceRef: { messageId: quoted.messageId, quoteIndex: 0, messageVersion: quoted.__v! },
        },
      ]);
      expect(refreshed.quoteSourceRetention[0].sourceExpiresAt).toEqual(current);
      await db.models.Message.collection.updateOne(
        { messageId: row.messageId },
        { $set: { sourceFileIds: [] } },
      );
      expect(
        (await messages.getMessage({ user: owner.userId, messageId: row.messageId }))?.text,
      ).toBe('');
      await db.models.Message.collection.updateOne(
        { messageId: quoted.messageId },
        { $set: { sourceFileIds: [] } },
      );
      await expect(
        messages.resolveFileRetentionContext(owner, {
          fileIds: [],
          historyMessageIds: [quoted.messageId],
        }),
      ).rejects.toThrow();
      await expect(
        messages.resolveQuoteRetention(owner, [
          { text: 'No lineage', sourceRef: { messageId: quoted.messageId } },
        ]),
      ).rejects.toThrow();
      await db.models.Message.collection.updateOne(
        { messageId: quoted.messageId },
        { $set: { sourceFileIds: [id] } },
      );
      await messages.saveMessage(
        owner,
        {
          messageId: quoted.messageId,
          conversationId: quoted.conversationId,
          isCreatedByUser: false,
          text: quoted.text,
        },
        {
          sourceRetention: { sourceFileIds: [id], sourceExpiresAt: new Date(0) },
        },
      );
      const written = (await db.models.Message.findOne({ messageId: quoted.messageId })
        .select('+quoteSourceRetention')
        .lean<IMessage>())!;
      expect(written.sourceExpiresAt).toEqual(current);
      expect(written.quoteSourceRetention![0].sourceExpiresAt).toEqual(current);
      expect((await capture(written)).sourceExpiresAt).toEqual(current);
      await db.models.Message.collection.updateOne(
        { messageId: quoted.messageId },
        { $set: { expiredAt: new Date(0) } },
      );
      await expect(
        messages.resolveQuoteRetention(owner, [
          { text: 'Expired Message', sourceRef: { messageId: quoted.messageId } },
        ]),
      ).rejects.toThrow();
      await db.models.File.updateOne(
        { file_id: id },
        { $set: { deletionRequestedAt: new Date() } },
      );
      await expect(
        messages.resolveFileRetentionContext(owner, { fileIds: [id], historyMessageIds: [] }),
      ).rejects.toThrow();
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
    'removed-body',
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
        if (kind === 'removed-body')
          await collection.updateOne(filter, { $set: { sourceContentRemovedAt: new Date() } });
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
        expect(
          (await messages.getMessage({ user: owner.userId, messageId: row.messageId }))?.text,
        ).toBe('');
        await expect(
          messages.resolveFileRetentionContext(owner, {
            fileIds: [],
            historyMessageIds: [row.messageId],
          }),
        ).rejects.toThrow();
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
