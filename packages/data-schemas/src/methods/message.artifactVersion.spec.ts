/** Real Mongo compare-and-swap at the existing message/retention persistence owner. */
import mongoose from 'mongoose';
import { v4 as uuid } from 'uuid';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MCP_APP_MIME_TYPE, Tools } from 'librechat-data-provider';
import type { IMessage } from '~/types';
import {
  createMessageMethods,
  MessageVersionConflictError,
  CLIENT_MESSAGE_SELECT,
} from './message';
import { createUploadStore, RESOURCE_MAX } from './uploadManagementStore';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createFileRetentionMethods } from './fileRetention';
import { createModels } from '../models';
import logger from '~/config/winston';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let server: MongoMemoryReplSet;
const methods = createMessageMethods(mongoose, { getMCPAppMessageBudget: async () => 100_000 });
const files = createFileRetentionMethods(mongoose);
const owner = { userId: new mongoose.Types.ObjectId().toString(), tenantId: 'artifact-cas' };
const run = <T>(fn: () => T) => tenantStorage.run({ tenantId: owner.tenantId }, fn);
const row = () => ({
  messageId: uuid(),
  conversationId: uuid(),
  text: 'original',
  isCreatedByUser: false,
});
const raw = (messageId: string) => mongoose.models.Message.findOne({ messageId }).lean<IMessage>();
async function stored(messageId: string) {
  const message = await raw(messageId);
  if (!message) throw new Error('Expected fixture message');
  return message;
}
async function source() {
  const file_id = uuid();
  const expiredAt = new Date(Date.now() + 60_000);
  await mongoose.models.File.create({
    user: owner.userId,
    file_id,
    filename: 'fixture.txt',
    filepath: '/fixture/source',
    type: 'text/plain',
    bytes: 11,
    text: 'source text',
    retainedDerivativeBytes: 0,
    retentionAcceptedAt: new Date(),
    expiredAt,
  });
  return { sourceFileIds: [file_id], sourceExpiresAt: expiredAt };
}

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  Object.assign(mongoose.models, createModels(mongoose));
  await mongoose.connect(server.getUri());
  await mongoose.models.Message.createIndexes();
  await mongoose.models.File.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  jest.clearAllMocks();
  await createUploadStore(mongoose, { enabled: true, reconciled: true }).initialize();
});
afterEach(async () => {
  await runAsSystem(() => mongoose.models.Message.deleteMany({}));
  await runAsSystem(() => mongoose.models.File.deleteMany({}));
  await mongoose.models.UploadCounter.deleteMany({});
});

describe('trusted expectedVersion on native messages', () => {
  it('preserves the actual revision in the authorized client projection while hiding private fields', async () =>
    run(async () => {
      const message = row();
      await methods.saveMessage(owner, message);
      const saved = await stored(message.messageId);
      const [visible] = await methods.getMessages(
        { messageId: message.messageId, user: owner.userId },
        CLIENT_MESSAGE_SELECT,
      );
      expect(typeof saved.__v).toBe('number');
      expect(visible.__v).toBe(saved.__v);
      expect(visible).not.toHaveProperty('_id');
      expect(visible).not.toHaveProperty('user');
      expect(visible).not.toHaveProperty('contextMeta');
      expect(visible).not.toHaveProperty('privateText');
    }));

  it.each(['fast', 'provenance', 'app', 'retained'] as const)(
    'admits exactly one concurrent writer on the %s path',
    async (path) =>
      run(async () => {
        const message = row();
        const retention = path === 'retained' ? await source() : undefined;
        const attachments =
          path === 'app'
            ? ([
                {
                  type: Tools.ui_resources,
                  file_id: 'fixture-app',
                  toolCallId: 'fixture-call',
                  [Tools.ui_resources]: [
                    {
                      uri: 'ui://fixture/app',
                      mimeType: MCP_APP_MIME_TYPE,
                      serverName: 'fixture',
                      serverBinding: 'authenticated-binding',
                      resourceId: 'fixture',
                      toolName: 'show_app',
                      content: [{ type: 'text', text: 'canonical' }],
                      text: 'app',
                    },
                  ],
                },
              ] as unknown as IMessage['attachments'])
            : undefined;
        await methods.saveMessage(
          owner,
          { ...message, attachments },
          { sourceRetention: retention },
        );
        const before = await stored(message.messageId);
        const outcomes = await Promise.allSettled(
          ['left', 'right'].map((text) => {
            const edit = {
              ...message,
              text,
              isEdited: true,
              ...(path === 'provenance' && {
                userSubmittedPaths: [`/content/${text === 'left' ? 0 : 1}`],
              }),
            };
            return methods.saveMessage(owner, edit, { expectedVersion: before.__v });
          }),
        );
        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
        const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
        expect(rejected).toMatchObject({ reason: { code: 'MESSAGE_VERSION_CONFLICT' } });
        if (rejected?.status === 'rejected')
          expect(rejected.reason).toBeInstanceOf(MessageVersionConflictError);
        const after = await stored(message.messageId);
        expect(after.__v).toBe(before.__v! + 1);
        const winner = outcomes.find((outcome) => outcome.status === 'fulfilled');
        if (winner?.status !== 'fulfilled') throw new Error('Missing winner');
        expect(after.text).toBe(winner.value?.text);
        if (path === 'app') expect(after.attachments).toEqual(before.attachments);
        if (path === 'retained') expect(after.sourceFileIds).toEqual(retention?.sourceFileIds);
        if (path === 'provenance')
          expect(after.userSubmittedPaths).toEqual([`/content/${after.text === 'left' ? 0 : 1}`]);
        expect(logger.error).not.toHaveBeenCalled();
      }),
  );

  it('never rebases a stale save or reports an existing row as the saved artifact', async () =>
    run(async () => {
      const message = row();
      const first = await methods.saveMessage(owner, message);
      await methods.saveMessage(
        owner,
        { ...message, text: 'winner' },
        { expectedVersion: first!.__v },
      );
      await expect(
        methods.saveMessage(owner, { ...message, text: 'stale' }, { expectedVersion: first!.__v }),
      ).rejects.toMatchObject({ code: 'MESSAGE_VERSION_CONFLICT' });
      expect((await stored(message.messageId)).text).toBe('winner');
      expect(logger.error).not.toHaveBeenCalled();
    }));

  it('binds null to a legacy missing version once, without treating it as an insert', async () =>
    run(async () => {
      const message = row();
      await methods.saveMessage(owner, message);
      await mongoose.models.Message.collection.updateOne(
        { messageId: message.messageId },
        { $unset: { __v: 1 } },
      );
      const result = await methods.saveMessage(
        owner,
        { ...message, text: 'legacy edit' },
        { expectedVersion: null },
      );
      expect(result?.__v).toBe(1);
      await expect(
        methods.saveMessage(owner, message, { expectedVersion: null }),
      ).rejects.toMatchObject({ code: 'MESSAGE_VERSION_CONFLICT' });
    }));

  it.each([null, 0, 7])('does not insert an absent row for version %s', async (expectedVersion) =>
    run(async () => {
      const message = row();
      await expect(methods.saveMessage(owner, message, { expectedVersion })).rejects.toMatchObject({
        code: 'MESSAGE_VERSION_CONFLICT',
      });
      expect(await raw(message.messageId)).toBeNull();
    }),
  );

  it.each([0, null])(
    'does not confuse stored version %s with the absent legacy field',
    async (version) =>
      run(async () => {
        const message = row();
        await methods.saveMessage(owner, message);
        await mongoose.models.Message.collection.updateOne(
          { messageId: message.messageId },
          { $set: { __v: version } },
        );
        await expect(
          methods.saveMessage(
            owner,
            { ...message, text: 'wrong legacy' },
            { expectedVersion: null },
          ),
        ).rejects.toBeInstanceOf(MessageVersionConflictError);
        expect((await stored(message.messageId)).text).toBe('original');
      }),
  );

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, '1'])(
    'rejects malformed trusted versions before mutation: %s',
    async (value) =>
      run(async () => {
        const message = row();
        await methods.saveMessage(owner, message);
        await expect(
          methods.saveMessage(
            owner,
            { ...message, text: 'bad' },
            {
              expectedVersion: value as number,
            },
          ),
        ).rejects.toThrow(TypeError);
        expect((await stored(message.messageId)).text).toBe('original');
      }),
  );

  it.each(['copy', 'insert-only'] as const)('rejects incompatible %s semantics', async (mode) =>
    run(async () => {
      const message = row();
      const before = await methods.saveMessage(owner, message);
      await expect(
        methods.saveMessage(
          owner,
          { ...message, ...(mode === 'copy' && { newMessageId: uuid() }) },
          {
            expectedVersion: before!.__v,
            ...(mode === 'insert-only' && { insertOnly: true }),
          },
        ),
      ).rejects.toThrow(TypeError);
      expect(await mongoose.models.Message.countDocuments({})).toBe(1);
      expect((await stored(message.messageId)).__v).toBe(before!.__v);
    }),
  );

  it('cannot use a matching version to cross owner or tenant scope', async () =>
    run(async () => {
      const message = row();
      const before = await methods.saveMessage(owner, message);
      await expect(
        methods.saveMessage({ userId: new mongoose.Types.ObjectId().toString() }, message, {
          expectedVersion: before!.__v,
        }),
      ).rejects.toMatchObject({ code: 'MESSAGE_VERSION_CONFLICT' });
      await expect(
        tenantStorage.run({ tenantId: 'foreign' }, () =>
          methods.saveMessage(owner, message, {
            expectedVersion: before!.__v,
          }),
        ),
      ).rejects.toMatchObject({ code: 'MESSAGE_VERSION_CONFLICT' });
      expect((await stored(message.messageId)).__v).toBe(before!.__v);
    }));

  it('preserves prior user provenance while applying the version fence', async () =>
    run(async () => {
      const message = { ...row(), userSubmittedPaths: ['/content/0'] };
      const before = await methods.saveMessage(owner, message);
      const after = await methods.saveMessage(
        owner,
        { ...message, text: 'edit', userSubmittedPaths: ['/content/1'] },
        {
          expectedVersion: before!.__v,
        },
      );
      expect(after?.userSubmittedPaths).toEqual(['/content/0', '/content/1']);
    }));

  it('retains source ownership and atomically invalidates old coverage on an edit', async () =>
    run(async () => {
      const retention = await source();
      const message = row();
      await methods.saveMessage(owner, message, {
        sourceRetention: retention,
        sourceCoverage: {
          version: 1,
          stage: 'prepared',
          scope: 'retained_sources',
          entries: [
            {
              file_id: retention.sourceFileIds[0],
              source: { kind: 'message', id: uuid() },
              coverage: { unit: 'utf16', start: 0, end: 11, total: 11, complete: true },
              extraction: 'not_assessed',
            },
          ],
        },
      });
      const before = await stored(message.messageId);
      expect(before.metadata?.sourceCoverage).toBeDefined();
      const edit = { ...message, text: 'edited', isEdited: true };
      const after = await methods.saveMessage(owner, edit, { expectedVersion: before.__v });
      expect(after?.metadata?.sourceCoverage).toBeUndefined();
      expect(after?.sourceFileIds).toEqual(retention.sourceFileIds);
      expect(after?.sourceExpiresAt).toEqual(before.sourceExpiresAt);
    }));

  it('cannot edit a revoked retained source even with the current native version', async () =>
    run(async () => {
      const retention = await source();
      const message = row();
      await methods.saveMessage(owner, message, { sourceRetention: retention });
      await files.revokeFileSources(owner, retention.sourceFileIds);
      const before = await stored(message.messageId);
      await expect(
        methods.saveMessage(
          owner,
          { ...message, text: 'revived' },
          { expectedVersion: before.__v },
        ),
      ).rejects.toThrow();
      const after = await stored(message.messageId);
      expect(after.__v).toBe(before.__v);
      expect(after.text).toBe(before.text);
    }));

  it('rolls back a correctly versioned edit when the retained text budget is exhausted', async () =>
    run(async () => {
      const retention = await source();
      const message = row();
      await methods.saveMessage(owner, message, { sourceRetention: retention });
      const before = await stored(message.messageId);
      await mongoose.models.UploadCounter.updateOne(
        { _id: 'global' },
        { $set: { 'value.textBytes': RESOURCE_MAX.textBytes } },
      );
      await expect(
        methods.saveMessage(
          owner,
          { ...message, text: 'large'.repeat(1000) },
          { expectedVersion: before.__v },
        ),
      ).rejects.toThrow();
      const after = await stored(message.messageId);
      expect(after.text).toBe(before.text);
      expect(after.__v).toBe(before.__v);
      expect(after.sourceFileIds).toEqual(retention.sourceFileIds);
    }));
});
