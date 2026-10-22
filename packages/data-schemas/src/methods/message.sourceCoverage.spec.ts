/** Real retained-message lifecycle: only the trusted write option may publish preparation receipts. */
import mongoose from 'mongoose';
import { v4 as uuid } from 'uuid';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { SourceCoverage } from 'librechat-data-provider';
import type { IMessage } from '~/types';
import { createUploadStore, RESOURCE_MAX } from './uploadManagementStore';
import { initialFileRetentionActivity } from './fileActivityTransition';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createFileRetentionMethods } from './fileRetention';
import { createMessageMethods } from './message';
import { createModels } from '../models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let server: MongoMemoryReplSet;
const methods = createMessageMethods(mongoose);
const files = createFileRetentionMethods(mongoose);
const owner = { userId: new mongoose.Types.ObjectId().toString(), tenantId: 'coverage-tenant' };
const run = <T>(fn: () => T) => tenantStorage.run({ tenantId: owner.tenantId }, fn);
const row = () => ({
  messageId: uuid(),
  conversationId: uuid(),
  text: 'answer',
  isCreatedByUser: false,
  metadata: { usage: { input: 12 } },
});
const coverage = (fileId = uuid()): SourceCoverage => ({
  version: 1,
  stage: 'prepared',
  scope: 'retained_sources',
  entries: [
    {
      file_id: fileId,
      source: { kind: 'message', id: uuid() },
      coverage: { unit: 'utf16', start: 0, end: 4, total: 11, complete: false },
      extraction: 'not_assessed',
    },
  ],
});
const raw = (messageId: string) =>
  mongoose.models.Message.findOne({ messageId })
    .select('+retainedTextAllocations')
    .lean<IMessage>();
async function stored(messageId: string) {
  const message = await raw(messageId);
  if (!message) throw new Error('Expected the retained message to exist');
  return message;
}
const total = async () => {
  const counter = await mongoose.models.UploadCounter.findById('global').lean<{
    value: { textBytes: number };
  }>();
  if (!counter) throw new Error('Expected the initialized upload counter');
  return counter.value.textBytes;
};
async function source() {
  const fileId = uuid();
  const acceptedAt = new Date(Date.now() - 60_000);
  const deadlineAt = new Date(Date.now() + 60_000);
  await mongoose.models.File.create({
    user: owner.userId,
    file_id: fileId,
    filename: 'source.txt',
    filepath: '/fixture/source',
    type: 'text/plain',
    bytes: 11,
    text: 'source text',
    retainedDerivativeBytes: 0,
    retentionAcceptedAt: acceptedAt,
    expiredAt: deadlineAt,
    retentionActivity: initialFileRetentionActivity(deadlineAt, acceptedAt, 'complete'),
  });
  return { sourceFileIds: [fileId], sourceExpiresAt: deadlineAt };
}
async function expireSource(fileId: string) {
  const expiredAt = new Date(Date.now() - 1);
  await mongoose.models.File.updateOne(
    { file_id: fileId },
    { $set: { expiredAt, 'retentionActivity.baselineDeadlineAt': expiredAt } },
  );
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
  await run(() =>
    mongoose.models.User.create({
      _id: owner.userId,
      tenantId: owner.tenantId,
      email: 'source-coverage@example.test',
      emailVerified: true,
    }),
  );
  await createUploadStore(mongoose, { enabled: true, reconciled: true }).initialize();
});
afterEach(async () => {
  await runAsSystem(() => mongoose.models.Message.deleteMany({}));
  await runAsSystem(() => mongoose.models.File.deleteMany({}));
  await runAsSystem(() => mongoose.models.User.deleteMany({}));
  await mongoose.models.UploadCounter.deleteMany({});
});

describe('server-owned source coverage', () => {
  it.each(['save', 'insert-only', 'record', 'update', 'bulk'] as const)(
    'strips forged nested and dotted receipts through %s without dropping other metadata',
    async (method) =>
      run(async () => {
        const proof = coverage();
        for (const forgery of [
          { metadata: { usage: { input: 12 }, sourceCoverage: proof } },
          { metadata: { usage: { input: 12 }, 'sourceCoverage.entries': proof.entries } },
          { 'metadata.sourceCoverage': proof, 'metadata.usage': { input: 12 } },
          {
            'metadata.sourceCoverage.entries.0.file_id': 'forged',
            'metadata.usage': { input: 12 },
          },
        ]) {
          const { metadata: _metadata, ...base } = row();
          const input = { ...base, ...forgery, user: owner.userId };
          if (method === 'save') await methods.saveMessage(owner, input);
          else if (method === 'insert-only')
            await methods.saveMessage(owner, input, { insertOnly: true });
          else if (method === 'record') await methods.recordMessage(input);
          else if (method === 'bulk') await methods.bulkSaveMessages([input]);
          else {
            await methods.saveMessage(owner, base);
            await methods.updateMessage(owner.userId, input);
          }
          const saved = await stored(base.messageId);
          expect(saved.metadata).toEqual({ usage: { input: 12 } });
        }
      }),
  );

  it('persists a trusted receipt with the actual retained source and charges its bytes', async () =>
    run(async () => {
      const context = await source();
      const message = row();
      await methods.saveMessage(owner, message, { sourceRetention: context });
      const before = await total();
      const proof = coverage(context.sourceFileIds[0]);
      const saved = await methods.saveMessage(owner, message, {
        sourceRetention: context,
        sourceCoverage: proof,
      });
      expect(saved?.metadata).toEqual({ usage: { input: 12 }, sourceCoverage: proof });
      expect(saved?.sourceFileIds).toEqual(context.sourceFileIds);
      expect(await total()).toBeGreaterThan(before);
      const charged = await total();
      expect((await stored(message.messageId)).retainedTextAllocations?.[0].bytes).toBe(charged);
      await methods.saveMessage(owner, message, {
        sourceRetention: context,
        sourceCoverage: proof,
      });
      expect(await total()).toBe(charged);
    }));

  it('rejects coverage that expires after trusted intake before transaction admission', async () =>
    run(async () => {
      const context = await source();
      context.sourceExpiresAt = new Date(Date.now() + 1_000);
      const message = row();
      const originalStartSession = mongoose.startSession.bind(mongoose);
      const admission = jest
        .spyOn(mongoose, 'startSession')
        .mockImplementationOnce(async (...args) => {
          const session = await originalStartSession(...args);
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, context.sourceExpiresAt.getTime() - Date.now() + 5)),
          );
          return session;
        });
      const principalWrite = jest.spyOn(mongoose.models.User, 'updateOne');
      try {
        await expect(
          methods.saveMessage(owner, message, {
            sourceRetention: context,
            sourceCoverage: coverage(context.sourceFileIds[0]),
          }),
        ).rejects.toThrow('Document source unavailable');
        expect(admission).toHaveBeenCalledTimes(1);
        expect(principalWrite).not.toHaveBeenCalled();
        const current = await mongoose.models.File.findOne({
          file_id: context.sourceFileIds[0],
        }).orFail();
        expect(current.expiredAt.getTime()).toBeGreaterThan(Date.now());
        expect(await raw(message.messageId)).toBeNull();
        expect(await total()).toBe(0);
      } finally {
        admission.mockRestore();
        principalWrite.mockRestore();
      }
    }));

  it.each([
    'missing',
    'foreign-id',
    'invalid',
    'user',
    'imported',
    'edited',
    'copy',
    'expired-context',
  ] as const)('rejects a trusted option with %s binding or message eligibility', async (reason) =>
    run(async () => {
      const context = await source();
      const proof = coverage(reason === 'foreign-id' ? uuid() : context.sourceFileIds[0]);
      const message = {
        ...row(),
        ...(reason === 'user' && { isCreatedByUser: true }),
        ...(reason === 'imported' && { isUserSubmitted: true }),
        ...(reason === 'edited' && { isEdited: true }),
        ...(reason === 'copy' && { newMessageId: uuid() }),
      };
      if (reason === 'invalid') proof.entries[0].coverage.end = 100;
      if (reason === 'expired-context') context.sourceExpiresAt = new Date(0);
      await expect(
        methods.saveMessage(owner, message, {
          sourceCoverage: proof,
          ...(reason !== 'missing' && { sourceRetention: context }),
        }),
      ).rejects.toThrow();
      expect(await raw(message.messageId)).toBeNull();
      expect(await total()).toBe(0);
    }),
  );

  it.each([undefined, false])(
    'rejects a stored edited row despite request isEdited=%s',
    async (isEdited) =>
      run(async () => {
        const context = await source();
        const message = row();
        await methods.saveMessage(owner, message, { sourceRetention: context });
        await mongoose.models.Message.collection.updateOne(
          { messageId: message.messageId },
          { $set: { isEdited: true } },
        );
        const charged = await total();
        const candidate = { ...message, isEdited };
        await expect(
          methods.saveMessage(owner, candidate, {
            sourceRetention: context,
            sourceCoverage: coverage(context.sourceFileIds[0]),
          }),
        ).rejects.toThrow();
        expect((await stored(message.messageId)).metadata).toEqual(message.metadata);
        expect(await total()).toBe(charged);
      }),
  );

  it.each([
    'foreign-owner',
    'foreign-tenant',
    'revoked',
    'expired',
    'budget',
    'missing-principal',
    'disabled-principal',
    'deleting-principal',
  ] as const)(
    'retains real transactional %s admission instead of trusting receipt IDs',
    async (reason) =>
      run(async () => {
        const context = await (reason === 'foreign-tenant'
          ? tenantStorage.run({ tenantId: 'another-tenant' }, source)
          : source());
        const proof = coverage(context.sourceFileIds[0]);
        if (reason === 'missing-principal')
          await mongoose.models.User.deleteOne({ _id: owner.userId });
        if (reason === 'disabled-principal' || reason === 'deleting-principal')
          await mongoose.models.User.updateOne(
            { _id: owner.userId },
            {
              $set:
                reason === 'disabled-principal'
                  ? { authDisabled: true }
                  : { agentTriggerDeletionStartedAt: new Date() },
            },
          );
        if (reason === 'foreign-owner')
          await mongoose.models.File.updateOne(
            { file_id: context.sourceFileIds[0] },
            { $set: { user: new mongoose.Types.ObjectId() } },
          );
        if (reason === 'revoked') await files.revokeFileSources(owner, context.sourceFileIds);
        if (reason === 'expired') await expireSource(context.sourceFileIds[0]);
        if (reason === 'budget')
          await mongoose.models.UploadCounter.updateOne(
            { _id: 'global' },
            { $set: { 'value.textBytes': RESOURCE_MAX.textBytes } },
          );
        const message = row();
        const write = methods.saveMessage(owner, message, {
          sourceRetention: context,
          sourceCoverage: proof,
        });
        if (reason.endsWith('-principal')) {
          await expect(write).rejects.toMatchObject({ code: 'principal_unavailable' });
          expect(await total()).toBe(0);
        } else await expect(write).rejects.toThrow();
        expect(await raw(message.messageId)).toBeNull();
      }),
  );

  it.each(['text', 'content', 'save', 'record', 'bulk'] as const)(
    'invalidates a receipt on %s mutation while preserving unrelated usage metadata',
    async (method) =>
      run(async () => {
        const context = await source();
        const message = row();
        await methods.saveMessage(owner, message, {
          sourceRetention: context,
          sourceCoverage: coverage(context.sourceFileIds[0]),
        });
        const before = await total();
        if (method === 'text')
          await methods.updateMessageText(owner.userId, {
            messageId: message.messageId,
            text: 'edited',
          });
        else if (method === 'content') {
          const contentUpdate = {
            messageId: message.messageId,
            'content.0': { type: 'text', text: 'edited' },
          };
          await methods.updateMessage(owner.userId, contentUpdate);
        } else if (method === 'save')
          await methods.saveMessage(owner, { ...message, text: 'edited' });
        else if (method === 'record')
          await methods.recordMessage({ ...message, user: owner.userId, text: 'edited' });
        else await methods.bulkSaveMessages([{ ...message, user: owner.userId, text: 'edited' }]);
        expect((await stored(message.messageId)).metadata).toEqual({ usage: { input: 12 } });
        expect(await total()).toBeLessThan(before);
      }),
  );

  it('strips copied native metadata while preserving its existing source-retention lineage', async () =>
    run(async () => {
      const context = await source();
      const message = row();
      await methods.saveMessage(owner, message, {
        sourceRetention: context,
        sourceCoverage: coverage(context.sourceFileIds[0]),
      });
      const saved = await methods.getMessage({ user: owner.userId, messageId: message.messageId });
      const copyId = uuid();
      await methods.bulkSaveMessages([{ ...saved, _id: undefined, messageId: copyId }], true, {
        privateTextTokens: new Map(),
        nativeSources: new Map([
          [copyId, { messageId: message.messageId, messageVersion: saved!.__v ?? null }],
        ]),
      });
      const copy = await stored(copyId);
      expect(copy.metadata).toEqual({ usage: { input: 12 } });
      expect(copy.sourceFileIds).toEqual(context.sourceFileIds);
    }));

  it.each(['delete', 'expire'] as const)(
    'removes receipt visibility and allocations on source %s',
    async (reason) =>
      run(async () => {
        const context = await source();
        const message = row();
        await methods.saveMessage(owner, message, {
          sourceRetention: context,
          sourceCoverage: coverage(context.sourceFileIds[0]),
        });
        expect(await total()).toBeGreaterThan(0);
        if (reason === 'expire') {
          await expireSource(context.sourceFileIds[0]);
          expect(
            (await methods.getMessage({ user: owner.userId, messageId: message.messageId }))
              ?.metadata,
          ).toBeUndefined();
        }
        await files.revokeFileSources(owner, context.sourceFileIds);
        await methods.redactFileSourceContent(owner, context.sourceFileIds);
        expect((await stored(message.messageId)).metadata).toBeUndefined();
        expect(await total()).toBe(0);
      }),
  );
});
