/** Real Mongo transaction and selective-message lifecycle evidence; no external services. */
import mongoose from 'mongoose';
import { v4 as uuid } from 'uuid';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { IMessage } from '~/types';
import { FileSourceUnavailableError, touchFileSources } from './fileRetention';
import { CLIENT_MESSAGE_SELECT, createMessageMethods } from './message';
import { createUploadStore } from './uploadManagementStore';
import { createFileMethods } from './file';
import { createModels } from '~/models';

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
    await Promise.all([mongoose.models.File.init(), mongoose.models.Message.init()]);
    files = createFileMethods(mongoose);
    messages = createMessageMethods(mongoose);
  });
  beforeEach(async () => {
    await mongoose.models.Message.deleteMany({});
    await mongoose.models.File.deleteMany({});
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
    await expect(files.deleteFiles([], user)).rejects.toBeInstanceOf(FileSourceUnavailableError);
    expect(await mongoose.models.File.countDocuments({ file_id: sourceId })).toBe(1);
    await files.revokeFileSources(owner, [sourceId]);
    await files.finalizeFileSourceDeletion(owner, [sourceId]);
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
});
