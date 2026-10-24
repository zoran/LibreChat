/** Real Mongo lifecycle evidence; native storage replies and empty generation/checkpoint inventories are fixtures. */
import mongoose from 'mongoose';
import { v4 as uuid } from 'uuid';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { UploadLease, UploadPrincipal } from 'librechat-data-provider';
import type { FileCleanupProgressResult } from '../types/fileCleanup';
import type { JobClaim } from '../types/housekeeping';
import type { IMessage } from '~/types';
import {
  createFileRetentionMethods,
  FileSourceUnavailableError,
  touchFileSources,
} from './fileRetention';
import { createCheckpointSourceMethods, snapshotCheckpointSourceBinding } from './checkpointSource';
import { createFileCleanupLifecycleMethods } from './fileCleanupLifecycle';
import { createFileCleanupProgressMethods } from './fileCleanupProgress';
import { CLIENT_MESSAGE_SELECT, createMessageMethods } from './message';
import { createUploadManagementRepository } from './uploadManagement';
import { managedFileRetrievalDeletionSettled } from './fileRetrieval';
import { createFileCleanupClaimMethods } from './fileCleanupClaim';
import { createUploadFileCleanupOwner } from './uploadFileCleanup';
import { createHousekeepingStore } from './housekeepingStore';
import { createUploadStore } from './uploadManagementStore';
import { sourceSha256 } from './messageSource';
import { createFileMethods } from './file';
import { createModels } from '~/models';

/** Real File/Upload/HK transitions; these fixtures create no generation or checkpoint rows. */
async function prepareCleanupReceipts(database: typeof mongoose, fileIds: string[]) {
  const observed = (result: FileCleanupProgressResult) => {
    if (result.state !== 'progress') throw new Error(JSON.stringify(result));
    return result;
  };
  const signal = new AbortController().signal;
  const jobs = createHousekeepingStore(database);
  await jobs.initialize();
  const generation = createFileCleanupProgressMethods(database, jobs);
  await generation.initialize();
  const upload = createUploadFileCleanupOwner(database);
  const retention = createFileRetentionMethods(database);
  const cleanup = createFileCleanupLifecycleMethods(database, jobs, upload, retention, {
    purgeRetrieval: async (scope, ids) => {
      const rows = await database.models.File.collection
        .find<Parameters<typeof managedFileRetrievalDeletionSettled>[0]>({
          user: new mongoose.Types.ObjectId(scope.userId),
          tenantId: scope.tenantId ?? null,
          file_id: { $in: [...ids] },
        })
        .toArray();
      expect(rows).toHaveLength(ids.length);
      for (const row of rows) expect(managedFileRetrievalDeletionSettled(row)).toBe(true);
    },
    purgeCheckpoints: async () => {
      const collections = await database.connection
        .db!.listCollections({}, { nameOnly: true })
        .toArray();
      expect(collections.filter(({ name }) => name.includes('checkpoint'))).toEqual([]);
    },
    redactFileSourceContent: createMessageMethods(database).redactFileSourceContent,
  });
  const claims = new Map<string, JobClaim>();
  for (let index = 0; index < fileIds.length; index++) {
    const claim = await jobs.claimNext('file.cleanup', {
      podUid: 'retention-fixture',
      incarnation: 'boot',
      source: 'fixture',
      hostId: 'local',
    });
    if (!claim || claim.work.handler !== 'file.cleanup')
      throw new Error('Expected actual revoked File cleanup claim');
    claims.set(claim.work.subject.fileId, claim);
  }
  expect([...claims.keys()].sort()).toEqual([...fileIds].sort());
  const claimFor = (fileId: string) => {
    const claim = claims.get(fileId);
    if (!claim) throw new Error('File cleanup claim missing');
    return claim;
  };
  for (const [fileId, claim] of claims) {
    expect(
      await createFileCleanupClaimMethods(database, jobs, retention).enter(claim, signal),
    ).toMatchObject({ state: 'progress' });
    observed(await cleanup.begin(claim, signal));
    let step = observed(await generation.beginCapture(claim, signal));
    step = observed(
      await generation.recordCapturePage(
        claim,
        step.expected,
        { targets: [], complete: true },
        signal,
      ),
    );
    step = observed(await generation.finishGenerationStage(claim, step.expected, signal));
    for (let attempt = 0; attempt < 5; attempt++) {
      step = observed(await cleanup.purgeDerivatives(claim, signal));
      if (step.progress.lifecycle!.derivatives.messages === 'complete') break;
    }
    expect(step.progress.lifecycle!.derivatives).toMatchObject({
      retrieval: 'complete',
      checkpoints: 'complete',
      messages: 'complete',
    });
    step = observed(await cleanup.prepareStorage(claim, signal));
    const request = step.progress.lifecycle!.storage!;
    if (request.state !== 'binding') throw new Error('Persisted storage request missing');
    step = observed(
      await cleanup.bindStorage(
        claim,
        step.expected,
        {
          ...request.request,
          bucket: 'originals-fixture',
          key: step.progress.lifecycle!.upload.originalKey,
        },
        signal,
      ),
    );
    const storage = step.progress.lifecycle!.storage!;
    if (storage.state !== 'observing') throw new Error('Persisted storage binding missing');
    // Native storage is outside this Mongo fixture; the actual owner validates and retains its receipt.
    observed(
      await cleanup.recordStorage(
        claim,
        step.expected,
        {
          ...storage.binding,
          state: 'durable_delete_complete',
          obligationId: `native-fixture-${fileId}`,
          aggregateRevision: '1',
          proofSHA256: 'e'.repeat(64),
        },
        signal,
      ),
    );
  }
  return {
    upload,
    commit: (fileId: string) => cleanup.commitConsumption(claimFor(fileId), signal),
    async finish(fileId: string) {
      const claim = claimFor(fileId);
      const step = observed(await cleanup.commitConsumption(claim, signal));
      const storage = step.progress.lifecycle!.storage!;
      if (storage.state !== 'committed') throw new Error('Actual Upload acknowledgment missing');
      observed(
        await cleanup.recordConsumption(
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
      observed(await cleanup.finalize(claim, signal));
    },
  };
}

describe('source-dependent message retention', () => {
  let mongo: MongoMemoryReplSet;
  let files: ReturnType<typeof createFileMethods>;
  let messages: ReturnType<typeof createMessageMethods>;
  const user = new mongoose.Types.ObjectId().toString();
  const owner = { userId: user };
  let conversationId: string;
  let sourceId: string;

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongo.getUri(), { monitorCommands: true });
    createModels(mongoose);
    await Promise.all([
      mongoose.models.File.init(),
      mongoose.models.Message.init(),
      mongoose.models.User.init(),
    ]);
    files = createFileMethods(mongoose);
    messages = createMessageMethods(mongoose);
  });
  beforeEach(async () => {
    await mongoose.models.Message.deleteMany({});
    await mongoose.models.File.deleteMany({});
    await mongoose.models.User.deleteMany({});
    await mongoose.models.User.create({
      _id: user,
      tenantId: null,
      name: 'Synthetic retained message owner',
      email: 'retained-message@example.invalid',
      provider: 'local',
      emailVerified: true,
    });
    if (mongoose.models.UploadCounter) await mongoose.models.UploadCounter.deleteMany({});
    await createUploadStore(mongoose, { enabled: true, reconciled: true }).initialize();
    conversationId = uuid();
    sourceId = uuid();
    await files.createFile(
      {
        file_id: sourceId,
        user: new mongoose.Types.ObjectId(user),
        filename: 'A.txt',
        filepath: '/owned/A',
        bytes: 6,
        type: 'text/plain',
        text: 'secret',
      },
      true,
      {
        retention: {
          acceptedAt: new Date(Date.now() - 1000),
          expiredAt: new Date(Date.now() + 60000),
        },
      },
    );
  });
  afterAll(async () => {
    await mongoose.disconnect();
    mongoose.deleteModel(/.*/);
    await mongo.stop();
  });

  const row = (messageId: string, text: string, isCreatedByUser = false) => ({
    messageId,
    conversationId,
    text,
    isCreatedByUser,
    sender: isCreatedByUser ? 'User' : 'Assistant',
  });
  const context = () =>
    messages.resolveFileRetentionContext(owner, { fileIds: [sourceId], historyMessageIds: [] });

  /** Managed fixtures retain the actual receipt and birth inventory from their owning lifecycle. */
  async function managedSource(policy: string) {
    await mongoose.models.File.deleteOne({ file_id: sourceId });
    await mongoose.models.UploadOperation.deleteMany({});
    const uploads = createUploadManagementRepository(mongoose, {
      enabled: true,
      reconciled: true,
      securityPolicySha256: policy,
    });
    await uploads.initialize();
    const principal: UploadPrincipal = {
      tenantId: null,
      userId: user,
      authentication: 'guest',
    };
    const at = Date.now();
    const worker = { hostId: 'fixture-host', instanceId: 'fixture-instance' };
    const reservation = await uploads.reserve(
      principal,
      {
        operationId: sourceId,
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
    const execution = {
      version: 2 as const,
      custody: { kind: 'none' as const },
      attemptId: `${sourceId}.${transfer.generation}`,
      instanceId: uuid(),
      executionId: uuid(),
      expiresAt: new Date(at + 60000).toISOString(),
    };
    await uploads.bindSecurityExecution(transfer, execution, at);
    await uploads.settleSecurityExecution(
      transfer,
      { execution, writerStopped: true, transientDataRemoved: true },
      at,
    );
    await uploads.accept(
      principal,
      transfer,
      {
        outcome: 'durable',
        bytes: 6,
        source: 's3',
        filepath: `/api/files/download/${sourceId}`,
        storageKey: `managed-uploads/${user}/${sourceId}.${transfer.generation}__original`,
        integrity: {
          version: 1,
          algorithm: 'sha256',
          sha256: 'a'.repeat(64),
          chunkBytes: 262144,
          chunkSha256: ['b'.repeat(64)],
        },
      },
      {
        version: 1,
        decision: 'approved',
        policySha256: policy,
        subject: {
          userId: user,
          tenantId: null,
          operationId: sourceId,
          transferGeneration: transfer.generation,
          mediaType: 'text/plain',
          bytes: 6,
          sha256: 'a'.repeat(64),
        },
        scannerVersion: 'fixture-v1',
        checkedAt: new Date(at).toISOString(),
        coverage: { complete: true, pages: 1, parts: 1 },
      },
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
    if (!processing || processing.operationId !== sourceId)
      throw new Error('Managed fixture processing was not admitted');
    await uploads.bindProcessingExecution(
      processing,
      {
        attemptId: `${sourceId}.${processing.generation}`,
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

  it('requires explicit null on managed guest sources while retaining ordinary tenantless files', async () => {
    await mongoose.models.File.collection.updateOne(
      { file_id: sourceId },
      { $set: { tenantId: null } },
    );
    await expect(context()).resolves.toMatchObject({ sourceFileIds: [sourceId] });
    await mongoose.models.File.collection.updateOne(
      { file_id: sourceId },
      { $unset: { tenantId: '' } },
    );
    await expect(context()).rejects.toBeInstanceOf(FileSourceUnavailableError);
    await mongoose.models.File.collection.updateOne(
      { file_id: sourceId },
      { $unset: { retentionAcceptedAt: '', expiredAt: '' } },
    );
    await expect(context()).resolves.toBeUndefined();
  });

  it('preserves pending managed File custody through account bulk delete and retains finalized tombstones', async () => {
    await managedSource('c'.repeat(64));
    await expect(files.deleteFiles([], user)).rejects.toBeInstanceOf(FileSourceUnavailableError);
    expect(await mongoose.models.File.countDocuments({ file_id: sourceId })).toBe(1);
    await files.revokeFileSources(owner, [sourceId]);
    expect(await files.finalizeFileSourceDeletion(owner, [sourceId])).toEqual({
      completedFileIds: [],
    });
    const cleanup = await prepareCleanupReceipts(mongoose, [sourceId]);
    await cleanup.finish(sourceId);
    expect(await files.finalizeFileSourceDeletion(owner, [sourceId])).toEqual({
      completedFileIds: [sourceId],
    });
    await expect(files.deleteFiles([], user)).resolves.toMatchObject({ deletedCount: 0 });
    expect(
      await mongoose.models.File.countDocuments({
        file_id: sourceId,
        deletionCompletedAt: { $ne: null },
      }),
    ).toBe(1);
  });

  it.each(['list', 'cursor'] as const)(
    'keeps the canonical %s client projection readable without extra source-free queries',
    async (kind) => {
      const messageId = uuid();
      await messages.saveMessage(owner, {
        ...row(messageId, 'ordinary transcript'),
        quotes: ['independent quotation'],
      });
      await mongoose.models.Message.updateOne({ messageId }, { $set: { __v: 3 } });
      const findMessages = jest.spyOn(mongoose.models.Message, 'find');
      const findFiles = jest.spyOn(mongoose.models.File, 'find');
      try {
        const filter = { user, conversationId };
        const rows =
          kind === 'list'
            ? await messages.getMessages(filter, CLIENT_MESSAGE_SELECT)
            : (await messages.getMessagesByCursor(filter, { select: CLIENT_MESSAGE_SELECT }))
                .messages;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          __v: 3,
          text: 'ordinary transcript',
          quotes: ['independent quotation'],
          quoteSourceRefs: [{ messageId, quoteIndex: 0, messageVersion: 3 }],
        });
        for (const field of ['_id', 'user', 'quoteSourceRetention']) {
          expect(rows[0]).not.toHaveProperty(field);
        }
        expect(findMessages).toHaveBeenCalledTimes(1);
        expect(findFiles).not.toHaveBeenCalled();
      } finally {
        findMessages.mockRestore();
        findFiles.mockRestore();
      }
    },
  );

  it('rejects a late save, insertOnly and attached-reference write after revoke', async () => {
    const sourceRetention = await context();
    await files.revokeFileSources(owner, [sourceId]);
    for (const insertOnly of [false, true]) {
      await expect(
        messages.saveMessage(owner, row(uuid(), 'late'), { sourceRetention, insertOnly }),
      ).rejects.toBeInstanceOf(FileSourceUnavailableError);
    }
    await expect(
      messages.saveMessage(owner, {
        ...row(uuid(), 'independent question', true),
        files: [{ file_id: sourceId }],
      }),
    ).rejects.toBeInstanceOf(FileSourceUnavailableError);
    expect(await mongoose.models.Message.countDocuments()).toBe(0);
  });

  it('preserves independent user text/topology and masks before physical redaction', async () => {
    const question = uuid(),
      answer = uuid(),
      independent = uuid();
    await messages.saveMessage(owner, {
      ...row(question, 'please compare', true),
      files: [{ file_id: sourceId }],
    });
    await messages.saveMessage(
      owner,
      { ...row(answer, 'secret answer'), parentMessageId: question },
      { sourceRetention: await context() },
    );
    await messages.saveMessage(owner, row(independent, 'ordinary answer'));
    expect(
      (await mongoose.models.Message.findOne({ messageId: question })).sourceFileIds,
    ).toBeUndefined();
    await files.revokeFileSources(owner, [sourceId]);
    const masked = await messages.getMessage({ user, messageId: answer });
    expect(masked?.text).toBe('');
    expect(masked?.parentMessageId).toBe(question);
    const result = await messages.redactFileSourceContent(owner, [sourceId]);
    expect(result.redactedMessages).toBe(1);
    expect((await messages.getMessage({ user, messageId: question }))?.text).toBe('please compare');
    expect((await messages.getMessage({ user, messageId: question }))?.files).toEqual([]);
    expect((await messages.getMessage({ user, messageId: independent }))?.text).toBe(
      'ordinary answer',
    );
    await expect(
      messages.updateMessage(user, { messageId: answer, text: 'revive', sourceFileIds: [] }),
    ).rejects.toBeInstanceOf(FileSourceUnavailableError);
    await expect(
      messages.bulkSaveMessages([{ ...row(answer, 'import revival'), user }]),
    ).rejects.toBeInstanceOf(FileSourceUnavailableError);
  });

  it.each(['list', 'cursor'] as const)(
    'masks revoked sources through the canonical %s projection while preserving independent text',
    async (kind) => {
      const answer = uuid();
      const question = uuid();
      await messages.saveMessage(owner, row(answer, 'document answer'), {
        sourceRetention: await context(),
      });
      const quoteRetention = await messages.resolveQuoteRetention(owner, [
        { text: 'document excerpt', sourceRef: { messageId: answer } },
        { text: 'independent excerpt' },
      ]);
      await messages.saveMessage(
        owner,
        { ...row(question, 'independent question', true), quotes: quoteRetention.quotes },
        { quoteRetention },
      );
      await files.revokeFileSources(owner, [sourceId]);
      const filter = { user, conversationId };
      const visible =
        kind === 'list'
          ? await messages.getMessages(filter, CLIENT_MESSAGE_SELECT)
          : (await messages.getMessagesByCursor(filter, { select: CLIENT_MESSAGE_SELECT }))
              .messages;
      expect(visible.find((message) => message.messageId === answer)?.text).toBe('');
      expect(visible.find((message) => message.messageId === question)).toMatchObject({
        text: 'independent question',
        quotes: ['independent excerpt'],
      });
      for (const message of visible) {
        expect(Number.isSafeInteger(message.__v)).toBe(true);
        for (const field of ['_id', 'user', 'quoteSourceRetention']) {
          expect(message).not.toHaveProperty(field);
        }
      }
    },
  );

  it('keeps the source-free read/write fast path and selectively preserves B-only content', async () => {
    const start = jest.spyOn(mongoose, 'startSession');
    const findFiles = jest.spyOn(mongoose.models.File, 'find');
    try {
      await messages.saveMessage(owner, row(uuid(), 'ordinary'));
      await messages.getMessages({ user, conversationId });
      expect(start).not.toHaveBeenCalled();
      expect(findFiles).not.toHaveBeenCalled();
    } finally {
      start.mockRestore();
      findFiles.mockRestore();
    }
    const second = uuid();
    await files.createFile(
      {
        file_id: second,
        user: new mongoose.Types.ObjectId(user),
        filename: 'B.txt',
        filepath: '/owned/B',
        type: 'text/plain',
        bytes: 1,
        text: 'B',
      },
      true,
      { retention: { acceptedAt: new Date(), expiredAt: new Date(Date.now() + 120000) } },
    );
    const onlyB = uuid();
    const sourceRetention = await messages.resolveFileRetentionContext(owner, {
      fileIds: [second],
      historyMessageIds: [],
    });
    await messages.saveMessage(owner, row(onlyB, 'B-only answer'), { sourceRetention });
    const combined = uuid();
    const both = await messages.resolveFileRetentionContext(owner, {
      fileIds: [sourceId, second],
      historyMessageIds: [],
    });
    expect(both?.sourceExpiresAt).toEqual((await context())?.sourceExpiresAt);
    await messages.saveMessage(owner, row(combined, 'A plus B'), { sourceRetention: both });
    await files.revokeFileSources(owner, [sourceId]);
    await messages.redactFileSourceContent(owner, [sourceId]);
    expect((await messages.getMessage({ user, messageId: onlyB }))?.text).toBe('B-only answer');
    expect((await messages.getMessage({ user, messageId: combined }))?.text).toBe('');
    await mongoose.models.File.updateOne({ file_id: second }, { $set: { expiredAt: new Date(0) } });
    expect((await messages.getMessage({ user, messageId: onlyB }))?.text).toBe('');
  });

  it('isolates owners and keeps the original deadline through history inheritance', async () => {
    const sourceRetention = await context();
    const answer = uuid();
    await messages.saveMessage(owner, row(answer, 'source answer'), { sourceRetention });
    expect(
      await messages.resolveFileRetentionContext(owner, {
        fileIds: [],
        historyMessageIds: [answer],
      }),
    ).toEqual(sourceRetention);
    await expect(
      messages.resolveFileRetentionContext(
        { userId: new mongoose.Types.ObjectId().toString() },
        { fileIds: [sourceId], historyMessageIds: [] },
      ),
    ).rejects.toBeInstanceOf(FileSourceUnavailableError);
  });

  it('conflicts with revoke on the real source row, then purges the committed-before-revoke body', async () => {
    const session = await mongoose.startSession();
    const messageId = uuid();
    session.startTransaction();
    try {
      const sourceRetention = await touchFileSources(mongoose, owner, [sourceId], session);
      await mongoose.models.Message.create(
        [{ ...row(messageId, 'committed source'), user, ...sourceRetention }],
        { session },
      );
      const client = mongoose.connection.getClient();
      let observed!: () => void;
      const sent = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const onCommand = (event: {
        commandName: string;
        command: { updates?: Array<{ u?: { $set?: { deletionRequestedAt?: unknown } } }> };
      }) => {
        if (
          event.commandName === 'update' &&
          event.command.updates?.some(
            (update: { u?: { $set?: { deletionRequestedAt?: unknown } } }) =>
              update.u?.$set?.deletionRequestedAt,
          )
        )
          observed();
      };
      client.on('commandStarted', onCommand);
      try {
        const revoke = files.revokeFileSources(owner, [sourceId]);
        await sent;
        await session.commitTransaction();
        await revoke;
      } finally {
        client.off('commandStarted', onCommand);
      }
      await messages.redactFileSourceContent(owner, [sourceId]);
      expect((await messages.getMessage({ user, messageId }))?.text).toBe('');
      expect(
        (await mongoose.models.File.findOne({ file_id: sourceId })).retentionRevision,
      ).toBeGreaterThanOrEqual(2);
    } finally {
      if (session.inTransaction()) await session.abortTransaction();
      await session.endSession();
    }
  });

  async function sourceAnswer() {
    const messageId = uuid();
    await messages.saveMessage(owner, row(messageId, 'document answer'), {
      sourceRetention: await context(),
    });
    return messageId;
  }

  it('redacts only bound quotes, preserves independent text/quotes, and masks private lineage', async () => {
    const answer = await sourceAnswer();
    const messageId = uuid();
    const quoteRetention = await messages.resolveQuoteRetention(owner, [
      { text: 'document excerpt', sourceRef: { messageId: answer } },
      { text: 'independent excerpt' },
    ]);
    const saved = await messages.saveMessage(
      owner,
      { ...row(messageId, 'independent question', true), quotes: quoteRetention.quotes },
      { quoteRetention },
    );
    expect(saved?.quoteSourceRetention).toBeUndefined();
    expect(saved?.quoteSourceRefs).toEqual([
      { messageId, quoteIndex: 0, messageVersion: saved!.__v ?? 0 },
      { messageId, quoteIndex: 1, messageVersion: saved!.__v ?? 0 },
    ]);
    expect(
      await messages.resolveFileRetentionContext(owner, {
        fileIds: [],
        historyMessageIds: [messageId],
      }),
    ).toEqual(await context());
    // The stored source version changed, but the same already committed metadata stays valid.
    await messages.saveMessage(owner, row(messageId, 'edited question', true), { quoteRetention });
    const selected = (await messages.getMessage({ user, messageId }))!;
    const selection = {
      fileIds: [],
      historyMessageIds: [messageId],
      historyQuoteSnapshots: [
        {
          messageId,
          messageVersion: selected.__v ?? null,
          quotes: selected.quotes!,
        },
      ],
    };
    await expect(messages.resolveFileRetentionContext(owner, selection)).resolves.toEqual(
      await context(),
    );
    await files.revokeFileSources(owner, [sourceId]);
    await expect(messages.resolveFileRetentionContext(owner, selection)).rejects.toBeInstanceOf(
      FileSourceUnavailableError,
    );
    const visible = await messages.getMessage({ user, messageId });
    expect(visible?.text).toBe('edited question');
    expect(visible?.quotes).toEqual(['independent excerpt']);
    expect(visible?.quoteSourceRetention).toBeUndefined();
    expect(
      await messages.resolveFileRetentionContext(owner, {
        fileIds: [],
        historyMessageIds: [messageId],
      }),
    ).toBeUndefined();
    await messages.redactFileSourceContent(owner, [sourceId]);
    const raw = await mongoose.models.Message.findOne({ messageId })
      .select('+quoteSourceRetention')
      .lean<IMessage>()
      .orFail();
    expect(raw.quoteSourceRetention).toEqual([]);
    expect(raw.__v).toBeGreaterThan(saved!.__v!);
    await expect(messages.resolveFileRetentionContext(owner, selection)).rejects.toBeInstanceOf(
      FileSourceUnavailableError,
    );
    await messages.updateMessage(user, {
      messageId,
      text: 'still useful',
      quotes: ['revival'],
      quoteSourceRetention: [],
    });
    expect((await messages.getMessage({ user, messageId }))?.quotes).toEqual([
      'independent excerpt',
    ]);
    await messages.bulkSaveMessages([
      { ...row(messageId, 'import edit', true), user, quotes: ['revival'] },
    ]);
    expect((await messages.getMessage({ user, messageId }))?.quotes).toEqual([
      'independent excerpt',
    ]);
    const retry = await messages.saveMessage(
      owner,
      { ...row(messageId, 'ignored', true), quotes: ['revival'] },
      { insertOnly: true },
    );
    expect(retry?.quotes).toEqual(['independent excerpt']);
  });

  it('keeps projected quote bytes and bindings coherent when redaction wins between reads', async () => {
    const answer = await sourceAnswer();
    const messageId = uuid();
    const quoteRetention = await messages.resolveQuoteRetention(owner, [
      { text: 'removed excerpt', sourceRef: { messageId: answer } },
      { text: 'independent excerpt' },
    ]);
    await messages.saveMessage(owner, row(messageId, 'independent question', true), {
      quoteRetention,
    });
    const Message = mongoose.models.Message;
    const find = Message.find.bind(Message);
    let interleaved = false;
    const spy = jest.spyOn(Message, 'find').mockImplementation((...args: unknown[]) => {
      const query = Reflect.apply(find, Message, args);
      if (!interleaved && (args[0] as { messageId?: string })?.messageId === messageId) {
        interleaved = true;
        const lean = query.lean.bind(query);
        query.lean = async (...params: unknown[]) => {
          const prior = await Reflect.apply(lean, query, params);
          await files.revokeFileSources(owner, [sourceId]);
          await messages.redactFileSourceContent(owner, [sourceId]);
          return prior;
        };
      }
      return query;
    });
    let visible;
    try {
      [visible] = await messages.getMessages({ user, messageId }, 'messageId text quotes __v');
    } finally {
      spy.mockRestore();
    }
    expect(interleaved).toBe(true);
    expect(visible).toMatchObject({
      text: 'independent question',
      quotes: ['independent excerpt'],
    });
    expect(visible?.quoteSourceRetention).toBeUndefined();
    const copied = await messages.resolveQuoteRetention(owner, [
      {
        text: 'independent excerpt',
        sourceRef: visible!.quoteSourceRefs![0],
      },
    ]);
    expect(copied.quoteSourceRetention).toEqual([]);
  });

  it('inherits only the selected owned field and rejects stale or masked indices', async () => {
    const answer = await sourceAnswer();
    const question = uuid();
    const quoteRetention = await messages.resolveQuoteRetention(owner, [
      { text: 'same', sourceRef: { messageId: answer } },
      { text: 'same' },
    ]);
    await messages.saveMessage(owner, row(question, 'independent question', true), {
      quoteRetention,
    });
    const stored = await messages.getMessage({ user, messageId: question });
    const body = await messages.resolveQuoteRetention(owner, [
      { text: 'question', sourceRef: { messageId: question } },
    ]);
    expect(body.quoteSourceRetention).toEqual([]);
    const nested = await messages.resolveQuoteRetention(owner, [
      {
        text: 'same',
        sourceRef: {
          messageId: question,
          quoteIndex: 0,
          messageVersion: stored!.__v,
        },
      },
    ]);
    expect(nested.quoteSourceRetention[0].sourceExpiresAt).toEqual(
      quoteRetention.quoteSourceRetention[0].sourceExpiresAt,
    );
    const independent = await messages.resolveQuoteRetention(owner, [
      {
        text: 'same',
        sourceRef: {
          messageId: question,
          quoteIndex: 1,
          messageVersion: stored!.__v,
        },
      },
    ]);
    expect(independent.quoteSourceRetention).toEqual([]);
    await files.revokeFileSources(owner, [sourceId]);
    // Visible independent quote moved to index zero, but the stored version is still old.
    expect((await messages.getMessage({ user, messageId: question }))?.quotes).toEqual(['same']);
    await expect(
      messages.resolveQuoteRetention(owner, [
        {
          text: 'same',
          sourceRef: {
            messageId: question,
            quoteIndex: 0,
            messageVersion: stored!.__v,
          },
        },
      ]),
    ).rejects.toBeInstanceOf(FileSourceUnavailableError);
    await messages.redactFileSourceContent(owner, [sourceId]);
    await expect(
      messages.saveMessage(owner, row(uuid(), 'late'), { quoteRetention: nested }),
    ).rejects.toBeInstanceOf(FileSourceUnavailableError);
    await expect(
      messages.saveMessage(owner, row(uuid(), 'stale independent'), {
        quoteRetention: independent,
      }),
    ).rejects.toBeInstanceOf(FileSourceUnavailableError);
  });

  it('rejects foreign, out-of-range and unversioned refs without granting client metadata', async () => {
    const answer = await sourceAnswer();
    await expect(
      messages.resolveQuoteRetention({ userId: new mongoose.Types.ObjectId().toString() }, [
        { text: 'x', sourceRef: { messageId: answer } },
      ]),
    ).rejects.toBeInstanceOf(FileSourceUnavailableError);
    for (const sourceRef of [
      { messageId: uuid() },
      { messageId: answer, quoteIndex: 0 },
      { messageId: answer, quoteIndex: -1, messageVersion: 0 },
    ])
      await expect(
        messages.resolveQuoteRetention(owner, [{ text: 'x', sourceRef }]),
      ).rejects.toBeInstanceOf(FileSourceUnavailableError);
    const messageId = uuid();
    await messages.saveMessage(owner, {
      ...row(messageId, 'plain', true),
      quoteSourceRetention: [
        {
          index: 0,
          sourceRef: { messageId: answer },
          sourceFileIds: [sourceId],
          sourceExpiresAt: new Date(),
        },
      ],
    });
    const raw = await mongoose.models.Message.findOne({ messageId })
      .select('+quoteSourceRetention')
      .lean<IMessage>()
      .orFail();
    expect(raw.quoteSourceRetention).toBeUndefined();
    await expect(
      messages.resolveQuoteRetention(
        owner,
        Array.from({ length: 11 }, () => ({ text: 'x' })),
      ),
    ).rejects.toBeInstanceOf(FileSourceUnavailableError);
  });

  it('rolls source-message touches back when quote File admission fails', async () => {
    const answer = await sourceAnswer();
    const quoteRetention = await messages.resolveQuoteRetention(owner, [
      { text: 'secret', sourceRef: { messageId: answer } },
    ]);
    const before = await mongoose.models.Message.findOne({ messageId: answer })
      .lean<IMessage>()
      .orFail();
    await files.revokeFileSources(owner, [sourceId]);
    await expect(
      messages.saveMessage(owner, row(uuid(), 'question', true), { quoteRetention }),
    ).rejects.toBeInstanceOf(FileSourceUnavailableError);
    const after = await mongoose.models.Message.findOne({ messageId: answer })
      .lean<IMessage>()
      .orFail();
    expect(after.__v).toBe(before.__v);
    expect(await mongoose.models.Message.countDocuments()).toBe(1);
  });

  it('preserves independent quotes in a body tombstone and reindexes surviving B binding', async () => {
    const answer = await sourceAnswer();
    const otherId = uuid();
    await files.createFile(
      {
        file_id: otherId,
        user: new mongoose.Types.ObjectId(user),
        filename: 'B.txt',
        filepath: '/owned/B',
        bytes: 1,
        type: 'text/plain',
      },
      true,
      { retention: { acceptedAt: new Date(), expiredAt: new Date(Date.now() + 120000) } },
    );
    const bContext = await messages.resolveFileRetentionContext(owner, {
      fileIds: [otherId],
      historyMessageIds: [],
    });
    const bAnswer = uuid();
    await messages.saveMessage(owner, row(bAnswer, 'B'), { sourceRetention: bContext });
    const quoteRetention = await messages.resolveQuoteRetention(owner, [
      { text: 'A', sourceRef: { messageId: answer } },
      { text: 'C' },
      { text: 'B', sourceRef: { messageId: bAnswer } },
    ]);
    const question = uuid();
    await messages.saveMessage(owner, row(question, 'question', true), { quoteRetention });
    const body = uuid();
    await messages.saveMessage(
      owner,
      { ...row(body, 'dependent body'), quotes: ['independent quote'] },
      { sourceRetention: await context() },
    );
    await files.revokeFileSources(owner, [sourceId]);
    await messages.redactFileSourceContent(owner, [sourceId]);
    const raw = await mongoose.models.Message.findOne({ messageId: question })
      .select('+quoteSourceRetention')
      .lean<IMessage>()
      .orFail();
    expect(raw.quotes).toEqual(['C', 'B']);
    expect(raw.quoteSourceRetention?.map((item) => item.index)).toEqual([1]);
    const tombstone = await messages.getMessage({ user, messageId: body });
    expect(tombstone?.text).toBe('');
    expect(tombstone?.quotes).toEqual(['independent quote']);
  });

  describe('checkpoint-bound historical quote admission', () => {
    const policy = 'c'.repeat(64);
    let previousPolicy: string | undefined;
    let previousEnabled: string | undefined;
    beforeEach(async () => {
      previousPolicy = process.env.UPLOAD_SECURITY_POLICY_SHA256;
      previousEnabled = process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED;
      process.env.UPLOAD_SECURITY_POLICY_SHA256 = policy;
      process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = 'true';
      await managedSource(policy);
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      if (previousPolicy === undefined) delete process.env.UPLOAD_SECURITY_POLICY_SHA256;
      else process.env.UPLOAD_SECURITY_POLICY_SHA256 = previousPolicy;
      if (previousEnabled === undefined) delete process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED;
      else process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = previousEnabled;
      await mongoose.models.User.deleteOne({ _id: user });
    });
    const checkpoint = createCheckpointSourceMethods(mongoose);
    const transaction = async <T>(work: (session: mongoose.ClientSession) => Promise<T>) => {
      const session = await mongoose.startSession();
      try {
        session.startTransaction();
        const result = await work(session);
        await session.commitTransaction();
        return result;
      } finally {
        await session.endSession();
      }
    };
    const capturedQuote = async () => {
      const parent = uuid();
      const messageId = uuid();
      const sourceRetention = await context();
      await messages.saveMessage(owner, row(parent, 'Source text'), { sourceRetention });
      const quoteRetention = await messages.resolveQuoteRetention(owner, [
        { text: 'Selected quotation', sourceRef: { messageId: parent } },
      ]);
      await messages.saveMessage(
        owner,
        {
          ...row(messageId, 'Complete retained answer'),
          content: [{ type: 'text', text: 'Full answer content' }],
          quotes: quoteRetention.quotes,
        },
        { sourceRetention, quoteRetention },
      );
      const loaded = (await mongoose.models.Message.findOne({ messageId }).lean<IMessage>())!;
      const captured = await transaction((session) =>
        checkpoint.captureCheckpointSources(
          owner,
          {
            fileIds: [],
            messages: [{ conversationId, messageId, expectedVersion: loaded.__v ?? null }],
          },
          session,
        ),
      );
      return {
        messageId,
        captured,
        input: {
          fileIds: [],
          historyMessageIds: [messageId],
          checkpointSourceBinding: captured.binding,
          historyQuoteSnapshots: [
            { messageId, messageVersion: loaded.__v ?? null, quotes: [...loaded.quotes!] },
          ],
        },
      };
    };

    it('holds retired v1 envelopes without rewriting their hash or expiry', async () => {
      const fixture = await capturedQuote();
      const current = fixture.captured.binding;
      const payload = {
        version: 1,
        owner: current.owner,
        files: current.files.map(({ fileId, expiresAt }) => ({
          fileId,
          approvalSha256: 'a'.repeat(64),
          expiresAt,
        })),
        messages: current.messages,
        expiresAt: current.expiresAt,
      };
      const historical = { ...payload, bindingSha256: sourceSha256(payload) };
      const bytes = JSON.stringify(historical);
      expect(() =>
        snapshotCheckpointSourceBinding(owner, historical as unknown as typeof current),
      ).toThrow(FileSourceUnavailableError);
      expect(JSON.stringify(historical)).toBe(bytes);
    });

    it.each(['receipt', 'File'] as const)(
      'rejects a missing actual %s at the current fence',
      async (kind) => {
        const fixture = await capturedQuote();
        if (kind === 'receipt') await mongoose.models.UploadOperation.deleteOne({ _id: sourceId });
        else await mongoose.models.File.deleteOne({ file_id: sourceId });
        await expect(
          transaction((session) =>
            checkpoint.fenceCheckpointSources(owner, fixture.captured.binding, session),
          ),
        ).rejects.toBeInstanceOf(FileSourceUnavailableError);
      },
    );

    it('allows a successful +7 read before the original envelope bound without renewing it', async () => {
      const fixture = await capturedQuote();
      const before = JSON.stringify(fixture.captured.binding);
      const deadline = Date.parse(fixture.captured.binding.expiresAt);
      const uploads = createUploadManagementRepository(mongoose, { securityPolicySha256: policy });
      const principal: UploadPrincipal = { tenantId: null, userId: user, authentication: 'guest' };
      const ticket = await uploads.fileReads.admitManagedFileRead(principal, {
        fileId: sourceId,
        representation: 'original',
      });
      const claim = await uploads.fileReads.claimManagedFileRead(principal, ticket, {
        hostId: 'checkpoint-reader',
        instanceId: 'checkpoint-reader-instance',
      });
      await uploads.fileReads.completeManagedFileRead(principal, claim, {
        version: 1,
        representation: 'original',
        sourceBindingSha256: claim.sourceBindingSha256,
        contentSha256: 'a'.repeat(64),
        verifiedBytes: 6,
      });
      const current = await mongoose.models.File.findOne({ file_id: sourceId }).lean<{
        expiredAt: Date;
      }>();
      expect(current!.expiredAt.getTime()).toBe(deadline + 7 * 86400000);
      await expect(
        transaction((session) =>
          checkpoint.fenceCheckpointSources(owner, fixture.captured.binding, session),
        ),
      ).resolves.toBeUndefined();
      await expect(
        messages.resolveFileRetentionContext(owner, fixture.input),
      ).resolves.toMatchObject({
        sourceFileIds: [sourceId],
      });
      expect(JSON.stringify(fixture.captured.binding)).toBe(before);
      const clock = jest.spyOn(Date, 'now').mockReturnValue(deadline);
      try {
        await expect(
          transaction((session) =>
            checkpoint.fenceCheckpointSources(owner, fixture.captured.binding, session),
          ),
        ).rejects.toBeInstanceOf(FileSourceUnavailableError);
      } finally {
        clock.mockRestore();
      }
      expect(JSON.stringify(fixture.captured.binding)).toBe(before);
    });

    it('rejects original receipt substitution with unchanged File approval and deadline', async () => {
      const fixture = await capturedQuote();
      await mongoose.models.UploadOperation.updateOne(
        { _id: sourceId },
        { $set: { 'original.etag': 'substituted-storage-version' } },
      );
      await expect(
        transaction((session) =>
          checkpoint.fenceCheckpointSources(owner, fixture.captured.binding, session),
        ),
      ).rejects.toBeInstanceOf(FileSourceUnavailableError);
    });

    it('accepts the exact quote after repeated native checkpoint touches and keeps every read in the fence transaction', async () => {
      const fixture = await capturedQuote();
      for (let i = 0; i < 3; i++)
        await transaction((session) =>
          checkpoint.fenceCheckpointSources(owner, fixture.captured.binding, session),
        );
      const reads: Array<{ lsid?: unknown; txnNumber?: unknown; autocommit?: boolean }> = [];
      const observe = (event: {
        commandName: string;
        command: { find?: string; lsid?: unknown; txnNumber?: unknown; autocommit?: boolean };
      }) => {
        if (
          event.commandName === 'find' &&
          ['messages', 'files'].includes(event.command.find ?? '')
        )
          reads.push(event.command);
      };
      mongoose.connection.getClient().on('commandStarted', observe);
      try {
        await expect(
          messages.resolveFileRetentionContext(owner, fixture.input),
        ).resolves.toMatchObject({ sourceFileIds: [sourceId] });
      } finally {
        mongoose.connection.getClient().off('commandStarted', observe);
      }
      expect(reads.length).toBeGreaterThan(3);
      expect(
        reads.every(
          (read) => read.lsid != null && read.txnNumber != null && read.autocommit === false,
        ),
      ).toBe(true);
      await expect(
        messages.resolveFileRetentionContext(owner, {
          ...fixture.input,
          checkpointSourceBinding: undefined,
        }),
      ).rejects.toBeInstanceOf(FileSourceUnavailableError);
    });

    it('detaches the owner, source binding and quote selection before its first await', async () => {
      const fixture = await capturedQuote();
      const selectedOwner = { ...owner };
      const selected = {
        ...fixture.input,
        historyMessageIds: [...fixture.input.historyMessageIds],
        historyQuoteSnapshots: fixture.input.historyQuoteSnapshots.map((snapshot) => ({
          ...snapshot,
          quotes: [...snapshot.quotes],
        })),
      };
      const binding = {
        ...selected.checkpointSourceBinding,
        files: selected.checkpointSourceBinding.files.map((file) => ({ ...file })),
      };
      const pending = messages.resolveFileRetentionContext(selectedOwner, {
        ...selected,
        checkpointSourceBinding: binding,
      });
      selectedOwner.userId = new mongoose.Types.ObjectId().toString();
      selected.historyMessageIds.push(uuid());
      selected.historyQuoteSnapshots[0].quotes[0] = 'Changed after entry';
      binding.files[0].bindingSha256 = 'e'.repeat(64);
      await expect(pending).resolves.toMatchObject({ sourceFileIds: [sourceId] });
    });

    it.each(['captured-version', 'missing-witness', 'conversation', 'owner', 'tenant'] as const)(
      'rejects %s identity mismatch',
      async (kind) => {
        const fixture = await capturedQuote();
        let selectedOwner = owner;
        if (kind === 'captured-version')
          fixture.input.historyQuoteSnapshots[0].messageVersion =
            (fixture.input.historyQuoteSnapshots[0].messageVersion ?? 0) + 1;
        if (kind === 'missing-witness') fixture.input.historyMessageIds.push(uuid());
        if (kind === 'conversation')
          await mongoose.models.Message.collection.updateOne(
            { messageId: fixture.messageId },
            { $set: { conversationId: uuid() } },
          );
        if (kind === 'owner') selectedOwner = { userId: new mongoose.Types.ObjectId().toString() };
        const scope =
          kind === 'tenant' ? { ...selectedOwner, tenantId: 'foreign-tenant' } : selectedOwner;
        await expect(
          messages.resolveFileRetentionContext(scope, fixture.input),
        ).rejects.toBeInstanceOf(FileSourceUnavailableError);
      },
    );

    it.each([
      'text',
      'content',
      'quotes',
      'source-ref',
      'expiry',
      'approval',
      'revocation',
      'deletion',
    ] as const)('rejects changed %s after capture', async (kind) => {
      const fixture = await capturedQuote();
      if (kind === 'text')
        await mongoose.models.Message.collection.updateOne(
          { messageId: fixture.messageId },
          { $set: { text: 'Changed complete body' } },
        );
      if (kind === 'content')
        await mongoose.models.Message.collection.updateOne(
          { messageId: fixture.messageId },
          { $set: { content: [{ type: 'text', text: 'Changed' }] } },
        );
      if (kind === 'quotes')
        await mongoose.models.Message.collection.updateOne(
          { messageId: fixture.messageId },
          { $set: { quotes: ['Changed quotation'] } },
        );
      if (kind === 'source-ref')
        await mongoose.models.Message.collection.updateOne(
          { messageId: fixture.messageId },
          { $set: { 'quoteSourceRetention.0.sourceRef.messageId': uuid() } },
        );
      if (kind === 'expiry')
        await mongoose.models.File.collection.updateOne(
          { file_id: sourceId },
          { $set: { expiredAt: new Date(0) } },
        );
      if (kind === 'approval')
        await mongoose.models.File.collection.updateOne(
          { file_id: sourceId },
          { $set: { 'securityApproval.policySha256': 'd'.repeat(64) } },
        );
      if (kind === 'revocation') await files.revokeFileSources(owner, [sourceId]);
      if (kind === 'deletion')
        await mongoose.models.Message.deleteOne({ messageId: fixture.messageId });
      await expect(
        messages.resolveFileRetentionContext(owner, fixture.input),
      ).rejects.toBeInstanceOf(FileSourceUnavailableError);
    });

    it.each(['commit', 'close'] as const)(
      'returns no context after a committed result loses %s acknowledgment',
      async (stage) => {
        const fixture = await capturedQuote();
        const start = mongoose.startSession.bind(mongoose);
        jest.spyOn(mongoose, 'startSession').mockImplementation(async (...args) => {
          const session = await start(...args);
          const name = stage === 'commit' ? 'commitTransaction' : 'endSession';
          const original = session[name].bind(session);
          jest.spyOn(session, name).mockImplementation(async () => {
            await original();
            throw new Error('Injected lost acknowledgment');
          });
          return session;
        });
        await expect(messages.resolveFileRetentionContext(owner, fixture.input)).rejects.toThrow(
          'Injected lost acknowledgment',
        );
      },
    );
  });
});
