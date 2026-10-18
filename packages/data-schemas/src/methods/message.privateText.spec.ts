import mongoose from 'mongoose';
import { v4 as uuid } from 'uuid';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { CounterRow } from './uploadManagementStore';
import { createUploadStore, RESOURCE_MAX } from './uploadManagementStore';
import { createMessageMethods, CLIENT_MESSAGE_SELECT } from './message';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createFileRetentionMethods } from './fileRetention';
import { createFileMethods } from './file';
import { createModels } from '../models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let server: MongoMemoryReplSet;
let models: ReturnType<typeof createModels>;
const methods = createMessageMethods(mongoose);
const tenant = <T>(id: string, fn: () => T) => tenantStorage.run({ tenantId: id }, fn);

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  models = createModels(mongoose);
  Object.assign(mongoose.models, models);
  await mongoose.connect(server.getUri());
  await mongoose.models.Message.createIndexes();
  await mongoose.models.File.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
afterEach(async () => {
  await runAsSystem(() => mongoose.models.Message.deleteMany({}));
  await runAsSystem(() => mongoose.models.File.deleteMany({}));
  if (mongoose.models.UploadCounter) await mongoose.models.UploadCounter.deleteMany({});
});

describe('managed document derivative storage', () => {
  const userId = new mongoose.Types.ObjectId().toString();
  const owner = { userId, tenantId: 'tenant-a' };
  const files = createFileRetentionMethods(mongoose);
  const run = <T>(work: () => T) => tenant('tenant-a', work);
  const row = (messageId = uuid(), text = 'answer') => ({
    messageId,
    conversationId: uuid(),
    text,
    isCreatedByUser: false,
  });
  async function source() {
    const fileId = uuid();
    await mongoose.models.File.create({
      user: userId,
      file_id: fileId,
      filename: 'source.txt',
      filepath: '/owned/source',
      type: 'text/plain',
      bytes: 10,
      text: 'source text',
      retainedDerivativeBytes: 0,
      retentionAcceptedAt: new Date(),
      expiredAt: new Date(Date.now() + 60_000),
    });
    return { sourceFileIds: [fileId], sourceExpiresAt: new Date(Date.now() + 60_000) };
  }
  async function total() {
    const counter = await mongoose.models.UploadCounter.findById('global')
      .lean<CounterRow>()
      .orFail();
    if (!('textBytes' in counter.value)) throw new Error('Expected the global text counter');
    return counter.value.textBytes;
  }
  async function initialize(textBytes = 0) {
    await createUploadStore(mongoose, {
      enabled: true,
      reconciled: true,
      baseline: { textBytes },
    }).initialize();
  }
  it('keeps unbound insert-only chats independent of upload state and strips forged allocation paths', async () =>
    run(async () => {
      const message = {
        ...row(),
        isCreatedByUser: true,
        retainedTextAllocations: [{ fileId: 'forged', bytes: 123 }],
        'retainedTextAllocations.0.bytes': 999,
        'sourceFileIds.0': 'forged',
      };
      await methods.saveMessage(owner, message, { insertOnly: true });
      const raw = await models.Message.findOne({ messageId: message.messageId })
        .select('+retainedTextAllocations')
        .lean()
        .orFail();
      expect(raw.text).toBe(message.text);
      expect(raw.retainedTextAllocations).toBeUndefined();
      expect(raw.sourceFileIds).toBeUndefined();
    }));
  it('protects private liability fields from generic File creation and updates', async () =>
    run(async () => {
      const crud = createFileMethods(mongoose);
      const fileId = uuid();
      await crud.createFile(
        {
          file_id: fileId,
          user: userId,
          filename: 'ordinary.txt',
          filepath: '/owned',
          bytes: 1,
          type: 'text/plain',
          retainedDerivativeBytes: 999,
          'retainedDerivativeReservations.0.bytes': 999,
        } as never,
        true,
      );
      await crud.updateFile({
        file_id: fileId,
        retainedDerivativeBytes: 123,
        'retainedDerivativeBytes.value': 999,
        'retainedDerivativeReservations.0.bytes': 888,
      } as never);
      const raw = await models.File.findOne({ file_id: fileId })
        .select('+retainedDerivativeBytes +retainedDerivativeReservations')
        .lean()
        .orFail();
      expect(raw.retainedDerivativeBytes).toBe(0);
      expect(raw.retainedDerivativeReservations).toBeUndefined();
    }));
  it('publishes usable embedded text atomically through the existing File lifecycle', async () =>
    run(async () => {
      const managedFiles = createFileRetentionMethods(mongoose, {
        securityPolicySha256: 'c'.repeat(64),
      });
      const context = await source();
      const operationId = context.sourceFileIds[0];
      await mongoose.models.File.updateOne(
        { file_id: operationId },
        {
          $set: {
            uploadOperationId: operationId,
            embedded: false,
            status: 'pending',
            source: 's3',
            storageKey: `t/${owner.tenantId}/managed-uploads/${owner.userId}/${operationId}.1__original`,
            securityApproval: {
              version: 1,
              decision: 'approved',
              policySha256: 'c'.repeat(64),
              subject: {
                ...owner,
                operationId,
                transferGeneration: 1,
                bytes: 10,
                mediaType: 'text/plain',
                sha256: 'a'.repeat(64),
              },
              scannerVersion: 'fixture-v1',
              checkedAt: new Date().toISOString(),
              coverage: { complete: true, pages: 1, parts: 1 },
            },
          },
        },
      );
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          await managedFiles.claimManagedUploadProcessing(
            owner,
            operationId,
            3,
            Date.now(),
            session,
          );
          await managedFiles.publishManagedUpload(
            owner,
            operationId,
            3,
            {
              text: 'usable parsed text',
              structure: {
                version: 1,
                source: { sha256: 'a'.repeat(64), bytes: 10, mediaType: 'text/plain' },
                extractor: { name: 'fixture', version: '1' },
                pages: [],
                elements: [
                  { id: 'e1', kind: 'paragraph', start: 0, end: 18, page: null, parentId: null },
                ],
                quality: { status: 'complete', warnings: [] },
              },
            },
            Date.now(),
            session,
          );
        });
      } finally {
        await session.endSession();
      }
      const stored = await models.File.findOne({ file_id: operationId }).lean().orFail();
      expect(stored).toMatchObject({
        text: 'usable parsed text',
        textFormat: 'text',
        status: 'ready',
        embedded: true,
        previewRevision: '3',
      });
    }));
  it('charges the durable payload once, resizes an edit, and forbids forged receipts', async () =>
    run(async () => {
      await initialize();
      const context = await source();
      const message = row();
      await methods.saveMessage(
        owner,
        { ...message, retainedTextAllocations: [{ fileId: 'forged', bytes: 0 }] },
        { sourceRetention: context },
      );
      const charged = await total();
      expect(charged).toBeGreaterThanOrEqual(Buffer.byteLength(message.text));
      await methods.saveMessage(owner, message, { sourceRetention: context });
      expect(await total()).toBe(charged);
      await methods.updateMessageText(userId, { messageId: message.messageId, text: 'x' });
      expect(await total()).toBeLessThan(charged);
      const saved = await methods.getMessage({ user: userId, messageId: message.messageId });
      expect(saved).not.toHaveProperty('retainedTextAllocations');
      const raw = await models.Message.findOne({ messageId: message.messageId })
        .select('+retainedTextAllocations')
        .lean()
        .orFail();
      expect(raw.retainedTextAllocations).toEqual([
        { fileId: context.sourceFileIds[0], bytes: await total() },
      ]);
    }));
  it('rolls back a retained write when the shared extracted-text pool is full', async () =>
    run(async () => {
      await initialize(RESOURCE_MAX.textBytes);
      const context = await source();
      const message = row();
      await expect(
        methods.saveMessage(owner, message, { sourceRetention: context }),
      ).rejects.toMatchObject({ code: 'document_capacity_exceeded' });
      expect(await mongoose.models.Message.exists({ messageId: message.messageId })).toBeNull();
      expect(await total()).toBe(RESOURCE_MAX.textBytes);
      expect(
        (
          await models.File.findOne({ file_id: context.sourceFileIds[0] })
            .select('+retainedDerivativeBytes')
            .lean()
            .orFail()
        ).retainedDerivativeBytes,
      ).toBe(0);
    }));
  it('reserves source-job copies idempotently and refunds only stored content bytes after purge', async () =>
    run(async () => {
      await initialize();
      const context = await source();
      const input = {
        reservationId: 'a'.repeat(64),
        sourceFileIds: context.sourceFileIds,
        bytes: 4096,
      };
      const receipt = await files.reserveFileSourceCopies(owner, input);
      expect(await total()).toBe(4096 + 256);
      expect(await files.reserveFileSourceCopies(owner, input)).toEqual(receipt);
      expect(await total()).toBe(4096 + 256);
      await expect(
        files.releaseFileSourceCopies(
          { ...owner, userId: new mongoose.Types.ObjectId().toString() },
          receipt,
        ),
      ).rejects.toThrow();
      await files.releaseFileSourceCopies(owner, { ...receipt, bytes: RESOURCE_MAX.textBytes });
      expect(await total()).toBe(256);
      await files.releaseFileSourceCopies(owner, receipt);
      expect(await total()).toBe(256);
      await expect(files.reserveFileSourceCopies(owner, input)).rejects.toThrow();
      await files.revokeFileSources(owner, context.sourceFileIds);
      await files.finalizeFileSourceDeletion(owner, context.sourceFileIds);
      expect(await total()).toBe(0);
      await files.releaseFileSourceCopies(owner, receipt);
      expect(await total()).toBe(0);
    }));
  it('fences an intent cancelled before its delayed source-copy reservation', async () =>
    run(async () => {
      await initialize();
      const context = await source();
      const input = {
        reservationId: 'c'.repeat(64),
        sourceFileIds: context.sourceFileIds,
        bytes: 4096,
      };
      const intent = {
        fileId: context.sourceFileIds[0],
        reservationId: input.reservationId,
        bytes: input.bytes,
        state: 'held' as const,
      };
      await files.releaseFileSourceCopies(owner, intent);
      await files.releaseFileSourceCopies(owner, { ...intent, bytes: RESOURCE_MAX.textBytes });
      expect(await total()).toBe(256);
      const file = await models.File.findOne({ file_id: intent.fileId })
        .select('+retainedDerivativeBytes +retainedDerivativeReservations')
        .lean()
        .orFail();
      expect(file.retainedDerivativeBytes).toBe(256);
      expect(file.retainedDerivativeReservations).toEqual([
        { reservationId: input.reservationId, bytes: 0, state: 'released' },
      ]);
      await expect(files.reserveFileSourceCopies(owner, input)).rejects.toThrow();
      expect(await total()).toBe(256);
    }));
  it('serializes reserve/cancel and repeated stored refunds across two Mongo clients', async () =>
    run(async () => {
      await initialize();
      const context = await source();
      const input = {
        reservationId: 'd'.repeat(64),
        sourceFileIds: context.sourceFileIds,
        bytes: 4096,
      };
      const intent = {
        fileId: context.sourceFileIds[0],
        reservationId: input.reservationId,
        bytes: input.bytes,
        state: 'held' as const,
      };
      const other = new mongoose.Mongoose();
      try {
        await other.connect(server.getUri());
        createModels(other);
        createUploadStore(other, {});
        const competing = createFileRetentionMethods(other);
        const outcomes = await Promise.allSettled([
          files.reserveFileSourceCopies(owner, input),
          competing.releaseFileSourceCopies(owner, intent),
        ]);
        expect(outcomes[1].status).toBe('fulfilled');
        if (outcomes[0].status === 'rejected')
          expect(outcomes[0].reason.name).toBe('FileSourceUnavailableError');
        await Promise.all([
          files.releaseFileSourceCopies(owner, intent),
          competing.releaseFileSourceCopies(owner, intent),
        ]);
        expect(await total()).toBe(256);
        await expect(competing.reserveFileSourceCopies(owner, input)).rejects.toThrow();

        const held = await files.reserveFileSourceCopies(owner, {
          ...input,
          reservationId: 'e'.repeat(64),
        });
        expect(await total()).toBe(4096 + 512);
        await Promise.all([
          files.releaseFileSourceCopies(owner, { ...held, bytes: RESOURCE_MAX.textBytes }),
          competing.releaseFileSourceCopies(owner, held),
        ]);
        expect(await total()).toBe(512);
        const file = await models.File.findOne({ file_id: intent.fileId })
          .select('+retainedDerivativeReservations')
          .lean()
          .orFail();
        expect(file.retainedDerivativeReservations).toHaveLength(2);
        expect(
          file.retainedDerivativeReservations?.every(
            (entry: { state: string }) => entry.state === 'released',
          ),
        ).toBe(true);
      } finally {
        await other.disconnect();
      }
    }));
  it.each(['budget', 'receipts', 'unknown'] as const)(
    'keeps cancellation pending when its tombstone lacks %s capacity evidence',
    async (reason) =>
      run(async () => {
        let charged = 0;
        if (reason === 'budget') charged = RESOURCE_MAX.textBytes;
        else if (reason === 'receipts') charged = 1024 * 256;
        await initialize(charged);
        const context = await source();
        const fileId = context.sourceFileIds[0];
        if (reason === 'receipts') {
          await mongoose.models.File.updateOne(
            { file_id: fileId },
            {
              $set: {
                retainedDerivativeBytes: charged,
                retainedDerivativeReservations: Array.from({ length: 1024 }, (_, index) => ({
                  reservationId: index.toString(16).padStart(64, '0'),
                  bytes: 0,
                  state: 'released',
                })),
              },
            },
          );
        } else if (reason === 'unknown') {
          await mongoose.models.File.collection.updateOne(
            { file_id: fileId },
            { $unset: { retainedDerivativeBytes: '' } },
          );
        }
        const intent = {
          fileId,
          reservationId: 'f'.repeat(64),
          bytes: 4096,
          state: 'held' as const,
        };
        await expect(files.releaseFileSourceCopies(owner, intent)).rejects.toMatchObject({
          code:
            reason === 'unknown' ? 'document_inventory_unreconciled' : 'document_capacity_exceeded',
        });
        expect(await total()).toBe(charged);
        const file = await models.File.findOne({ file_id: fileId })
          .select('+retainedDerivativeReservations')
          .lean()
          .orFail();
        expect(
          file.retainedDerivativeReservations?.some(
            (entry: { reservationId: string }) => entry.reservationId === intent.reservationId,
          ) ?? false,
        ).toBe(false);
      }),
  );
  it('makes retained job reservations compete with Message copies in the existing text pool', async () =>
    run(async () => {
      await initialize(RESOURCE_MAX.textBytes - 1024);
      const context = await source();
      await files.reserveFileSourceCopies(owner, {
        reservationId: 'b'.repeat(64),
        sourceFileIds: context.sourceFileIds,
        bytes: 768,
      });
      expect(await total()).toBe(RESOURCE_MAX.textBytes);
      await expect(
        methods.saveMessage(owner, row(), { sourceRetention: context }),
      ).rejects.toMatchObject({ code: 'document_capacity_exceeded' });
    }));
  it('keeps deleted-history liabilities until the existing File cleanup completes', async () =>
    run(async () => {
      await initialize();
      const context = await source();
      const message = row();
      await methods.saveMessage(owner, message, { sourceRetention: context });
      const charged = await total();
      await methods.deleteMessages({ user: userId, messageId: message.messageId });
      expect(await total()).toBe(charged);
      await files.revokeFileSources(owner, context.sourceFileIds);
      await methods.redactFileSourceContent(owner, context.sourceFileIds);
      await files.finalizeFileSourceDeletion(owner, context.sourceFileIds);
      expect(await total()).toBe(0);
      await files.finalizeFileSourceDeletion(owner, context.sourceFileIds);
      expect(await total()).toBe(0);
    }));
  it('does not infer a zero charge from an unreconciled retained row', async () =>
    run(async () => {
      await initialize();
      const context = await source();
      const message = row();
      await mongoose.models.Message.create({ ...message, user: userId, ...context });
      await expect(
        methods.updateMessageText(userId, { messageId: message.messageId, text: 'next' }),
      ).rejects.toMatchObject({ code: 'document_inventory_unreconciled' });
      expect(await total()).toBe(0);
    }));
  it('resizes a source-bound background tool result within the same budget', async () =>
    run(async () => {
      await initialize();
      const context = await source();
      const message = {
        ...row(),
        content: [{ type: 'tool_call', tool_call: { id: 'call', name: 'tool', output: 'old' } }],
      };
      await methods.saveMessage(owner, message as never, { sourceRetention: context });
      const previous = await total();
      await methods.updateToolCallResult({
        userId,
        messageId: message.messageId,
        conversationId: message.conversationId,
        toolCallId: 'call',
        output: 'a larger result',
      });
      expect(await total()).toBeGreaterThan(previous);
      const charged = await total();
      await methods.updateToolCallResult({
        userId,
        messageId: message.messageId,
        conversationId: message.conversationId,
        toolCallId: 'call',
        output: 'a larger result',
      });
      expect(await total()).toBe(charged);
    }));
  it('charges native history copies and preserves source deletion on their new identities', async () =>
    run(async () => {
      await initialize();
      const context = await source();
      const original = row();
      await methods.saveMessage(owner, original, { sourceRetention: context });
      const saved = await methods.getMessage({ user: userId, messageId: original.messageId });
      const copyId = uuid();
      const before = await total();
      await methods.bulkSaveMessages([{ ...saved, _id: undefined, messageId: copyId }], true, {
        privateTextTokens: new Map(),
        nativeSources: new Map([
          [copyId, { messageId: original.messageId, messageVersion: saved!.__v ?? null }],
        ]),
      });
      expect(await total()).toBeGreaterThan(before);
      const copy = await methods.getMessage({ user: userId, messageId: copyId });
      expect(copy?.sourceFileIds).toEqual(context.sourceFileIds);
      await files.revokeFileSources(owner, context.sourceFileIds);
      await methods.redactFileSourceContent(owner, context.sourceFileIds);
      expect((await methods.getMessage({ user: userId, messageId: copyId }))?.text).toBe('');
      expect(await total()).toBe(0);
    }));
  it('charges quote components separately and leaves unrelated quotes after one source is removed', async () =>
    run(async () => {
      await initialize();
      const first = await source();
      const second = await source();
      const firstAnswer = row();
      const secondAnswer = row();
      await methods.saveMessage(owner, firstAnswer, { sourceRetention: first });
      await methods.saveMessage(owner, secondAnswer, { sourceRetention: second });
      const quoteRetention = await methods.resolveQuoteRetention(owner, [
        { text: 'first quotation', sourceRef: { messageId: firstAnswer.messageId } },
        { text: 'second quotation', sourceRef: { messageId: secondAnswer.messageId } },
      ]);
      const question = { ...row(), isCreatedByUser: true, quotes: quoteRetention.quotes };
      await methods.saveMessage(owner, question, { quoteRetention });
      const beforeEdit = await total();
      await methods.updateMessageText(userId, {
        messageId: question.messageId,
        text: 'ordinary words '.repeat(500),
      });
      expect(await total()).toBe(beforeEdit);
      await files.revokeFileSources(owner, first.sourceFileIds);
      await methods.redactFileSourceContent(owner, first.sourceFileIds);
      const saved = await methods.getMessage({ user: userId, messageId: question.messageId });
      expect(saved?.quotes).toEqual(['second quotation']);
      expect(await total()).toBeGreaterThan(0);
      expect(await total()).toBeLessThan(beforeEdit);
      const raw = await models.Message.findOne({ messageId: question.messageId })
        .select('+retainedTextAllocations')
        .lean()
        .orFail();
      expect(raw.retainedTextAllocations?.map((entry: { fileId: string }) => entry.fileId)).toEqual(
        second.sourceFileIds,
      );
    }));
  it('serializes concurrent source writes from two independent Mongo clients at the cap', async () =>
    run(async () => {
      await initialize();
      const context = await source();
      const probe = row(uuid(), 'identical body');
      await methods.saveMessage(owner, probe, { sourceRetention: context });
      const needed = await total();
      const remaining = RESOURCE_MAX.textBytes - needed * 2;
      await mongoose.models.UploadCounter.updateOne(
        { _id: 'global' },
        { $inc: { 'value.textBytes': remaining, 'value.baseline.textBytes': remaining } },
      );
      const other = new mongoose.Mongoose();
      try {
        await other.connect(server.getUri());
        createModels(other);
        createUploadStore(other, {});
        const competing = createMessageMethods(other);
        const outcomes = await Promise.allSettled([
          methods.saveMessage(owner, row(uuid(), 'identical body'), { sourceRetention: context }),
          competing.saveMessage(owner, row(uuid(), 'identical body'), { sourceRetention: context }),
        ]);
        expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(1);
        expect(await total()).toBe(RESOURCE_MAX.textBytes);
      } finally {
        await other.disconnect();
      }
    }));
});

it('stores both views atomically and excludes ciphertext from ordinary and client reads', async () => {
  const conversationId = uuid();
  const messageId = uuid();
  await tenant('tenant-a', async () => {
    const saved = await methods.saveMessage(
      { userId: 'owner' },
      {
        messageId,
        conversationId,
        text: '[EMAIL_1_turn]',
        isCreatedByUser: true,
      },
      { privateText: { envelope: 'v1:ciphertext', revision: 'turn' } },
    );
    expect(saved?.privacyRevision).toBe('turn');
    expect(saved).not.toHaveProperty('privateText');
    for (const projection of [undefined, CLIENT_MESSAGE_SELECT]) {
      const rows = await methods.getMessages({ conversationId, user: 'owner' }, projection);
      expect(rows[0].text).toBe('[EMAIL_1_turn]');
      expect(rows[0]).not.toHaveProperty('privateText');
    }
    const own = await methods.getPrivateMessageTexts({
      userId: 'owner',
      tenantId: 'tenant-a',
      conversationId,
      messageIds: [messageId],
    });
    expect(own[0]).toMatchObject({
      privateText: 'v1:ciphertext',
      privacyRevision: 'turn',
      text: '[EMAIL_1_turn]',
    });
    const protectedRow = {
      userId: 'owner',
      tenantId: 'tenant-a',
      conversationId,
      messageId,
      text: '[EMAIL_1_turn]',
      privacyRevision: 'turn',
    };
    expect(await methods.hasPersistedPrivateText(protectedRow)).toBe(true);
    expect(await methods.getPersistedPrivateTextId(protectedRow)).toBe(String(saved?._id));
    for (const mismatch of [
      { userId: 'other' },
      { tenantId: 'tenant-b' },
      { conversationId: uuid() },
      { messageId: uuid() },
      { text: 'changed text' },
      { privacyRevision: 'wrong' },
    ]) {
      expect(await methods.hasPersistedPrivateText({ ...protectedRow, ...mismatch })).toBe(false);
    }

    expect(
      await methods.getPrivateMessageTexts({
        userId: 'other',
        tenantId: 'tenant-a',
        conversationId,
        messageIds: [messageId],
      }),
    ).toEqual([]);
    expect(
      await methods.getPrivateMessageTexts({
        userId: 'owner',
        tenantId: 'tenant-b',
        conversationId,
        messageIds: [messageId],
      }),
    ).toEqual([]);
  });
  expect(
    await tenant('tenant-b', () =>
      methods.getPrivateMessageTexts({
        userId: 'owner',
        tenantId: 'tenant-b',
        conversationId,
        messageIds: [messageId],
      }),
    ),
  ).toEqual([]);
  await tenant('tenant-a', async () => {
    await methods.deleteMessages({ conversationId, user: 'owner' });
    expect(
      await methods.getPrivateMessageTexts({
        userId: 'owner',
        tenantId: 'tenant-a',
        conversationId,
        messageIds: [messageId],
      }),
    ).toEqual([]);
  });
});

it('inserts a missing Stop prerequisite once without overwriting a stored or concurrent protected row', async () => {
  await tenant('tenant-a', async () => {
    const conversationId = uuid();
    const messageId = uuid();
    const context = { userId: 'owner', expiredAt: new Date(Date.now() + 60_000) };
    const user = {
      messageId,
      conversationId,
      isCreatedByUser: true,
      text: '[EMAIL_1_turn]',
    };
    const inserted = await methods.saveMessage(context, user, { insertOnly: true });
    expect(inserted?.text).toBe(user.text);
    expect(inserted?.expiredAt).toEqual(context.expiredAt);
    await methods.saveMessage(context, user, {
      privateText: { envelope: 'v1:owner', revision: 'turn' },
    });
    const retry = await methods.saveMessage(context, user, { insertOnly: true });
    expect(retry?.privacyRevision).toBe('turn');
    expect(retry).not.toHaveProperty('privateText');
    const stored = await mongoose.models.Message.findOne({ messageId })
      .select('+privateText')
      .lean();
    expect(stored).toMatchObject({
      text: user.text,
      privateText: 'v1:owner',
      privacyRevision: 'turn',
    });

    const concurrentId = uuid();
    await Promise.all([
      methods.saveMessage(context, { ...user, messageId: concurrentId }, { insertOnly: true }),
      methods.saveMessage(
        context,
        { ...user, messageId: concurrentId },
        {
          privateText: { envelope: 'v1:concurrent', revision: 'turn' },
        },
      ),
    ]);
    expect(await mongoose.models.Message.countDocuments({ messageId: concurrentId })).toBe(1);
    const concurrent = await mongoose.models.Message.findOne({ messageId: concurrentId })
      .select('+privateText')
      .lean();
    expect(concurrent).toMatchObject({ privateText: 'v1:concurrent', privacyRevision: 'turn' });
  });
});

it('does not accept sidecar writes from message parameters or generic edits', async () => {
  await tenant('tenant-a', async () => {
    const messageId = uuid();
    const conversationId = uuid();
    const saved = await methods.saveMessage(
      { userId: 'owner' },
      {
        messageId,
        conversationId,
        isCreatedByUser: true,
        text: 'clean',
        privateText: 'untrusted',
        privacyRevision: 'untrusted',
      },
    );
    expect(saved).not.toHaveProperty('privateText');
    expect(saved).not.toHaveProperty('privacyRevision');
    await methods.updateMessage('owner', {
      messageId,
      privateText: 'forged',
      privacyRevision: 'forged',
    });
    expect(
      await methods.getPrivateMessageTexts({
        userId: 'owner',
        tenantId: 'tenant-a',
        conversationId,
        messageIds: [messageId],
      }),
    ).toEqual([]);
  });
});

it('invalidates an encrypted original when an untyped canonical edit sets text to null', async () => {
  await tenant('tenant-a', async () => {
    const conversationId = uuid();
    const messageId = uuid();
    await methods.saveMessage(
      { userId: 'owner' },
      { conversationId, messageId, text: '[EMAIL_1]', isCreatedByUser: true },
      { privateText: { envelope: 'v1:owner', revision: 'original' } },
    );
    await methods.updateMessage('owner', { messageId, text: null as unknown as string });
    const stored = await mongoose.models.Message.findOne({ messageId })
      .select('+privateText')
      .lean();
    expect(stored).toMatchObject({ text: null });
    expect(stored).not.toHaveProperty('privateText');
    expect(stored).not.toHaveProperty('privacyRevision');
  });
});

it('does not return expired originals even before the TTL sweeper runs', async () => {
  await tenant('tenant-a', async () => {
    const messageId = uuid();
    const conversationId = uuid();
    await methods.saveMessage(
      { userId: 'owner', expiredAt: new Date(0), isTemporary: true },
      {
        messageId,
        conversationId,
        text: '[EMAIL_1]',
        isCreatedByUser: true,
      },
      { privateText: { envelope: 'v1:ciphertext', revision: 'turn' } },
    );
    expect(
      await methods.getPrivateMessageTexts({
        userId: 'owner',
        tenantId: 'tenant-a',
        conversationId,
        messageIds: [messageId],
      }),
    ).toEqual([]);
  });
});

it('strips private fields from bulk copies, including overwrites of protected rows', async () => {
  await tenant('tenant-a', async () => {
    const conversationId = uuid();
    const messageId = uuid();
    await methods.saveMessage(
      { userId: 'owner' },
      { conversationId, messageId, text: '[EMAIL_1]', isCreatedByUser: true },
      { privateText: { envelope: 'v1:owner', revision: 'original' } },
    );
    await methods.bulkSaveMessages([
      {
        user: 'owner',
        conversationId,
        messageId,
        text: 'clean copied',
        isCreatedByUser: true,
        privateText: 'forged',
        privacyRevision: 'forged',
      },
      {
        user: 'owner',
        conversationId,
        messageId: uuid(),
        text: 'fresh copied',
        isCreatedByUser: true,
        privateText: 'forged',
        privacyRevision: 'forged',
      },
    ]);
    const rows = await mongoose.models.Message.find({ conversationId })
      .select('+privateText')
      .lean();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).not.toHaveProperty('privateText');
      expect(row).not.toHaveProperty('privacyRevision');
    }
  });
});

it.each([
  'updateMessage',
  'updateMessageWithProvenance',
  'updateMessageText',
  'saveMessage',
  'recordMessage',
])('removes stored private text atomically when %s rewrites text', async (method) => {
  await tenant('tenant-a', async () => {
    const conversationId = uuid();
    const messageId = uuid();
    await methods.saveMessage(
      { userId: 'owner' },
      { conversationId, messageId, text: '[EMAIL_1]', isCreatedByUser: true },
      { privateText: { envelope: 'v1:owner', revision: 'original' } },
    );
    if (method === 'updateMessage' || method === 'updateMessageWithProvenance') {
      const updated = await methods.updateMessage('owner', {
        messageId,
        text: 'clean edited',
        ...(method === 'updateMessageWithProvenance' && { userSubmittedPaths: ['/text'] }),
      });
      expect(updated).not.toHaveProperty('privacyRevision');
    } else if (method === 'updateMessageText') {
      await methods.updateMessageText('owner', { messageId, text: 'clean edited' });
    } else if (method === 'recordMessage') {
      await methods.recordMessage({
        user: 'owner',
        conversationId,
        messageId,
        text: 'clean edited',
        isCreatedByUser: true,
      });
    } else {
      await methods.saveMessage(
        { userId: 'owner' },
        {
          conversationId,
          messageId,
          text: 'clean edited',
          isCreatedByUser: true,
        },
      );
    }
    const stored = await mongoose.models.Message.findOne({ conversationId, messageId })
      .select('+privateText')
      .lean();
    expect(stored).toMatchObject({ text: 'clean edited' });
    expect(stored).not.toHaveProperty('privateText');
    expect(stored).not.toHaveProperty('privacyRevision');
    expect(
      await methods.getPrivateMessageTexts({
        userId: 'owner',
        tenantId: 'tenant-a',
        conversationId,
        messageIds: [messageId],
      }),
    ).toEqual([]);
    expect(
      await methods.hasPersistedPrivateText({
        userId: 'owner',
        tenantId: 'tenant-a',
        conversationId,
        messageId,
        text: '[EMAIL_1]',
        privacyRevision: 'turn',
      }),
    ).toBe(false);
  });
});

it('persists native-copy token provenance only from metadata and clears it on canonical edits', async () => {
  const token = `[EMAIL_1_${'a'.repeat(32)}]`;
  const conversationId = uuid();
  const messageId = uuid();
  const message = {
    messageId,
    conversationId,
    user: 'owner',
    text: token,
    isCreatedByUser: true,
    privateTextTokens: [token],
    privacyRevision: 'forged',
    privateText: 'forged',
  };
  await tenant('tenant-a', async () => {
    await methods.bulkSaveMessages([message]);
    expect(
      (await methods.getMessages({ messageId, user: 'owner' }, '+privateTextTokens'))[0],
    ).not.toHaveProperty('privateTextTokens');
    await methods.bulkSaveMessages([message], true, {
      privateTextTokens: new Map([[messageId, [token]]]),
    });
    const internal = (
      await methods.getMessages({ messageId, user: 'owner' }, '+privateTextTokens')
    )[0];
    expect(internal.privateTextTokens).toEqual([token]);
    expect(internal).not.toHaveProperty('privacyRevision');
    expect(internal).not.toHaveProperty('privateText');
    for (const select of [undefined, CLIENT_MESSAGE_SELECT]) {
      expect(
        (await methods.getMessages({ messageId, user: 'owner' }, select))[0],
      ).not.toHaveProperty('privateTextTokens');
    }
    await methods.updateMessageText('owner', { messageId, text: 'Clean edit' });
    expect(
      (await methods.getMessages({ messageId, user: 'owner' }, '+privateTextTokens'))[0],
    ).not.toHaveProperty('privateTextTokens');
  });
});

it.each(['saveMessage', 'recordMessage', 'updateMessage', 'bulkSaveMessages'] as const)(
  'clears native-copy provenance when %s overwrites canonical text',
  async (writer) => {
    const token = `[EMAIL_1_${'a'.repeat(32)}]`;
    const messageId = uuid();
    const conversationId = uuid();
    await tenant('tenant-a', async () => {
      await methods.bulkSaveMessages(
        [{ user: 'owner', conversationId, messageId, text: token, isCreatedByUser: true }],
        true,
        { privateTextTokens: new Map([[messageId, [token]]]) },
      );
      const edited = {
        conversationId,
        messageId,
        text: 'Edited text',
        isCreatedByUser: true,
        privateTextTokens: [token],
      };
      if (writer === 'saveMessage') {
        await methods.saveMessage({ userId: 'owner' }, edited);
      } else if (writer === 'recordMessage') {
        await methods.recordMessage({ user: 'owner', ...edited });
      } else if (writer === 'updateMessage') {
        await methods.updateMessage('owner', edited);
      } else {
        await methods.bulkSaveMessages([{ user: 'owner', ...edited }]);
      }
      expect(
        (await methods.getMessages({ user: 'owner', messageId }, '+privateTextTokens'))[0],
      ).not.toHaveProperty('privateTextTokens');
    });
  },
);
