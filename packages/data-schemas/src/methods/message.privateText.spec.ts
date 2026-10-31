import mongoose from 'mongoose';
import { v4 as uuid } from 'uuid';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { UploadLease, UploadPrincipal } from 'librechat-data-provider';
import type {
  MessageSourceCleanupCursor,
  MessageSourceCleanupResult,
} from './messageSourceCleanup';
import type { CounterRow } from './uploadManagementStore';
import {
  uploadSecurityFixture,
  bindUploadOriginalFixture,
  uploadSecuritySettlementFixture,
} from './uploadManagement.security.fixture';
import { completeAcceptedUploadFileCleanup } from './uploadManagement.structure.fixture';
import { createUploadStore, RESOURCE_MAX } from './uploadManagementStore';
import { createMessageMethods, CLIENT_MESSAGE_SELECT } from './message';
import { initialFileRetentionActivity } from './fileActivityTransition';
import { createUploadManagementRepository } from './uploadManagement';
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
  server = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ args: ['--setParameter', 'enableTestCommands=1'] }],
  });
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
  if (mongoose.models.UploadOperation) await mongoose.models.UploadOperation.deleteMany({});
  if (mongoose.models.HousekeepingJob) await mongoose.models.HousekeepingJob.deleteMany({});
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
    const acceptedAt = new Date();
    const expiresAt = new Date(acceptedAt.getTime() + 60_000);
    await mongoose.models.File.create({
      user: userId,
      file_id: fileId,
      filename: 'source.txt',
      filepath: '/owned/source',
      type: 'text/plain',
      bytes: 10,
      text: 'source text',
      retainedDerivativeBytes: 0,
      retentionAcceptedAt: acceptedAt,
      expiredAt: expiresAt,
      retentionActivity: initialFileRetentionActivity(expiresAt, acceptedAt, 'complete'),
    });
    return { sourceFileIds: [fileId], sourceExpiresAt: new Date(Date.now() + 60_000) };
  }
  let previousCleanupPolicy: string | undefined;
  beforeEach(async () => {
    previousCleanupPolicy = process.env.UPLOAD_SECURITY_POLICY_SHA256;
    await run(() =>
      mongoose.models.User.updateOne(
        { _id: userId, tenantId: owner.tenantId },
        {
          $setOnInsert: {
            email: `${userId}@example.invalid`,
            emailVerified: true,
            provider: 'local',
          },
        },
        { upsert: true },
      ),
    );
  });
  afterEach(() => {
    if (previousCleanupPolicy === undefined) delete process.env.UPLOAD_SECURITY_POLICY_SHA256;
    else process.env.UPLOAD_SECURITY_POLICY_SHA256 = previousCleanupPolicy;
  });
  async function managedSource(policy = 'c'.repeat(64)) {
    process.env.UPLOAD_SECURITY_POLICY_SHA256 = policy;
    const sourceId = uuid();
    await mongoose.models.User.updateOne(
      { _id: userId },
      {
        $setOnInsert: {
          name: 'Synthetic Message cleanup owner',
          email: `${userId}@example.invalid`,
          provider: 'local',
          emailVerified: true,
        },
      },
      { upsert: true },
    );
    const uploads = createUploadManagementRepository(mongoose, {
      enabled: true,
      reconciled: true,
      securityPolicySha256: policy,
    });
    await uploads.initialize();
    const principal: UploadPrincipal = {
      tenantId: owner.tenantId,
      userId,
      authentication: 'verified-email',
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
    const security = uploadSecurityFixture(
      uploadSecurityFixture({
        decision: 'approved',
        policySha256: policy,
        subject: {
          userId,
          tenantId: owner.tenantId,
          operationId: sourceId,
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
        attemptId: `${sourceId}.${transfer.generation}`,
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
      filepath: `/api/files/download/${sourceId}`,
      storageKey: `t/${owner.tenantId}/managed-uploads/${userId}/${sourceId}.${transfer.generation}__original`,
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
          userId,
          tenantId: owner.tenantId,
          operationId: sourceId,
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
          userId,
          tenantId: owner.tenantId,
          operationId: sourceId,
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
    return (await methods.resolveFileRetentionContext(owner, {
      fileIds: [sourceId],
      historyMessageIds: [],
    }))!;
  }

  async function derivativeTotal() {
    const counter = await mongoose.models.UploadCounter.findById('global')
      .lean<CounterRow>()
      .orFail();
    if (!('textBytes' in counter.value)) throw new Error('Expected the global text counter');
    // UploadOperation owns its extracted document bytes; this is the retained Message ledger.
    return counter.value.baseline.textBytes;
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
      const context = await managedSource();
      const operationId = context.sourceFileIds[0];
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
                source: { sha256: 'a'.repeat(64), bytes: 6, mediaType: 'text/plain' },
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
      const context = await managedSource();
      const original = await mongoose.models.UploadOperation.findById(context.sourceFileIds[0])
        .lean<{ textBytes: number }>()
        .orFail();
      const originalCharge = original.textBytes;
      expect(originalCharge).toBeGreaterThan(0);
      expect(await total()).toBe(originalCharge);
      const input = {
        reservationId: 'a'.repeat(64),
        sourceFileIds: context.sourceFileIds,
        bytes: 4096,
      };
      const receipt = await files.reserveFileSourceCopies(owner, input);
      expect(await total()).toBe(originalCharge + 4096 + 256);
      expect(await files.reserveFileSourceCopies(owner, input)).toEqual(receipt);
      expect(await total()).toBe(originalCharge + 4096 + 256);
      await expect(
        files.releaseFileSourceCopies(
          { ...owner, userId: new mongoose.Types.ObjectId().toString() },
          receipt,
        ),
      ).rejects.toThrow();
      await files.releaseFileSourceCopies(owner, { ...receipt, bytes: RESOURCE_MAX.textBytes });
      expect(await total()).toBe(originalCharge + 256);
      await files.releaseFileSourceCopies(owner, receipt);
      expect(await total()).toBe(originalCharge + 256);
      await expect(files.reserveFileSourceCopies(owner, input)).rejects.toThrow();
      await files.revokeFileSources(owner, context.sourceFileIds);
      await completeAcceptedUploadFileCleanup(
        mongoose,
        { ...owner, authentication: 'verified-email' },
        context.sourceFileIds[0],
      );
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
      const context = await managedSource();
      const message = row();
      await methods.saveMessage(owner, message, { sourceRetention: context });
      const charged = await derivativeTotal();
      await methods.deleteMessages({ user: userId, messageId: message.messageId });
      expect(await derivativeTotal()).toBe(charged);
      await files.revokeFileSources(owner, context.sourceFileIds);
      await methods.redactFileSourceContent(owner, context.sourceFileIds);
      await completeAcceptedUploadFileCleanup(
        mongoose,
        { ...owner, authentication: 'verified-email' },
        context.sourceFileIds[0],
      );
      await files.finalizeFileSourceDeletion(owner, context.sourceFileIds);
      expect(await derivativeTotal()).toBe(0);
      await files.finalizeFileSourceDeletion(owner, context.sourceFileIds);
      expect(await derivativeTotal()).toBe(0);
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
      const context = await managedSource();
      const original = row();
      await methods.saveMessage(owner, original, { sourceRetention: context });
      const saved = await methods.getMessage({ user: userId, messageId: original.messageId });
      const copyId = uuid();
      const before = await derivativeTotal();
      await methods.bulkSaveMessages([{ ...saved, _id: undefined, messageId: copyId }], true, {
        privateTextTokens: new Map(),
        nativeSources: new Map([
          [copyId, { messageId: original.messageId, messageVersion: saved!.__v ?? null }],
        ]),
      });
      expect(await derivativeTotal()).toBeGreaterThan(before);
      const copy = await methods.getMessage({ user: userId, messageId: copyId });
      expect(copy?.sourceFileIds).toEqual(context.sourceFileIds);
      await files.revokeFileSources(owner, context.sourceFileIds);
      await methods.redactFileSourceContent(owner, context.sourceFileIds);
      expect((await methods.getMessage({ user: userId, messageId: copyId }))?.text).toBe('');
      expect(await derivativeTotal()).toBe(0);
    }));
  it('charges quote components separately and leaves unrelated quotes after one source is removed', async () =>
    run(async () => {
      await initialize();
      const first = await managedSource();
      const second = await managedSource();
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
      const beforeEdit = await derivativeTotal();
      await methods.updateMessageText(userId, {
        messageId: question.messageId,
        text: 'ordinary words '.repeat(500),
      });
      expect(await derivativeTotal()).toBe(beforeEdit);
      await files.revokeFileSources(owner, first.sourceFileIds);
      await methods.redactFileSourceContent(owner, first.sourceFileIds);
      const saved = await methods.getMessage({ user: userId, messageId: question.messageId });
      expect(saved?.quotes).toEqual(['second quotation']);
      expect(await derivativeTotal()).toBeGreaterThan(0);
      expect(await derivativeTotal()).toBeLessThan(beforeEdit);
      const raw = await models.Message.findOne({ messageId: question.messageId })
        .select('+retainedTextAllocations')
        .lean()
        .orFail();
      expect(raw.retainedTextAllocations?.map((entry: { fileId: string }) => entry.fileId)).toEqual(
        second.sourceFileIds,
      );
    }));

  describe('bounded Message source cleanup', () => {
    const options = (
      cursor: MessageSourceCleanupCursor | null = null,
      limit = 1,
      signal = new AbortController().signal,
    ) => ({
      deadlineAt: Date.now() + 10_000,
      signal,
      cursor,
      limit,
    });
    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve: () => resolve() };
    };
    async function fixture(count = 1) {
      await initialize();
      const context = await managedSource();
      const messages = Array.from({ length: count }, () => row());
      for (const message of messages)
        await methods.saveMessage(owner, message, { sourceRetention: context });
      await files.revokeFileSources(owner, context.sourceFileIds);
      return { context, messages };
    }

    it('pages actual body, quote and attachment effects and proves final absence', async () =>
      run(async () => {
        await initialize();
        const context = await managedSource();
        const messages = [row(), row(), row()];
        for (const message of messages)
          await methods.saveMessage(owner, message, { sourceRetention: context });
        const quoteRetention = await methods.resolveQuoteRetention(owner, [
          { text: 'owned quotation', sourceRef: { messageId: messages[0].messageId } },
        ]);
        await methods.saveMessage(
          owner,
          { ...row(), isCreatedByUser: true, quotes: quoteRetention.quotes },
          { quoteRetention },
        );
        const reference = await models.Message.create({
          ...row(),
          user: userId,
          files: [{ file_id: context.sourceFileIds[0] }],
        });
        await files.revokeFileSources(owner, context.sourceFileIds);
        const bulk = jest.spyOn(models.Message, 'updateMany');
        let cursor: MessageSourceCleanupCursor | null = null;
        let redacted = 0,
          detached = 0,
          complete = false;
        for (let attempt = 0; attempt < 12; attempt++) {
          const result: MessageSourceCleanupResult = await methods.redactFileSourceContent(
            owner,
            context.sourceFileIds,
            options(cursor),
          );
          expect(result.redactedMessages + result.detachedMessages).toBeLessThanOrEqual(1);
          if (attempt === 0) expect(result.complete).toBe(false);
          redacted += result.redactedMessages;
          detached += result.detachedMessages;
          if (result.complete) {
            complete = true;
            expect(result.cursor).toBeNull();
            break;
          }
          cursor = result.cursor;
        }
        expect(complete).toBe(true);
        expect({ redacted, detached }).toEqual({ redacted: 4, detached: 1 });
        expect((await models.Message.findById(reference._id).lean())?.files).toEqual([]);
        expect(await derivativeTotal()).toBe(0);
        expect(bulk).not.toHaveBeenCalled();
        await expect(
          methods.redactFileSourceContent(owner, context.sourceFileIds),
        ).resolves.toEqual({ redactedMessages: 0, detachedMessages: 0 });
      }));

    it('does not infer completion from a cursor beyond pending rows and revisits their phase', async () =>
      run(async () => {
        const { context } = await fixture(2);
        const first = await methods.redactFileSourceContent(
          owner,
          context.sourceFileIds,
          options(),
        );
        expect(first.complete).toBe(false);
        const skipped = await methods.redactFileSourceContent(
          owner,
          context.sourceFileIds,
          options({ ...first.cursor!, after: 'f'.repeat(24) }),
        );
        expect(skipped).toMatchObject({
          complete: false,
          redactedMessages: 0,
          cursor: { phase: 'detach', after: null },
        });
        const reset = await methods.redactFileSourceContent(
          owner,
          context.sourceFileIds,
          options(skipped.cursor),
        );
        expect(reset).toMatchObject({ complete: false, cursor: { phase: 'redact', after: null } });
        await expect(
          methods.redactFileSourceContent(owner, context.sourceFileIds, options(reset.cursor)),
        ).resolves.toMatchObject({ complete: true, redactedMessages: 1 });
        expect(await derivativeTotal()).toBe(0);
      }));

    it('observes a pending historical row inserted behind its cursor before the final proof', async () =>
      run(async () => {
        const { context } = await fixture();
        const find = models.Message.findOne.bind(models.Message);
        let inserted = false;
        jest.spyOn(models.Message, 'findOne').mockImplementation((...args) => {
          const query = find(...args);
          if (query.getFilter().$or?.length === 4) {
            const execute = query.exec.bind(query);
            jest.spyOn(query, 'exec').mockImplementation(async () => {
              if (!inserted) {
                inserted = true;
                await models.Message.create({
                  ...row(),
                  _id: new mongoose.Types.ObjectId('000000000000000000000001'),
                  user: userId,
                  ...context,
                });
              }
              return execute();
            });
          }
          return query;
        });
        const result = await methods.redactFileSourceContent(
          owner,
          context.sourceFileIds,
          options(),
        );
        expect(inserted).toBe(true);
        expect(result.complete).toBe(false);
        await expect(
          methods.redactFileSourceContent(owner, context.sourceFileIds),
        ).resolves.toEqual({ redactedMessages: 1, detachedMessages: 0 });
        expect(await derivativeTotal()).toBe(0);
      }));

    it('retries the existing version CAS and preserves an independent concurrent quote', async () =>
      run(async () => {
        const { context, messages } = await fixture();
        const initial = await models.Message.findOne({ messageId: messages[0].messageId })
          .lean()
          .orFail();
        const replace = models.Message.collection.replaceOne.bind(models.Message.collection);
        jest
          .spyOn(models.Message.collection, 'replaceOne')
          .mockImplementationOnce(async (...args) => {
            await models.Message.updateOne(
              { messageId: messages[0].messageId },
              { $set: { quotes: ['independent quote'] }, $inc: { __v: 1 } },
            );
            return replace(...args);
          });
        await expect(
          methods.redactFileSourceContent(owner, context.sourceFileIds, options()),
        ).resolves.toMatchObject({ complete: true, redactedMessages: 1 });
        const stored = await models.Message.findOne({ messageId: messages[0].messageId }).lean();
        expect(stored?.quotes).toEqual(['independent quote']);
        expect(stored?.text).toBe('');
        expect(stored?.__v).toBe((initial.__v ?? 0) + 2);
        expect(await derivativeTotal()).toBe(0);
      }));

    it('rejects an unrevoked source before Message effects', async () =>
      run(async () => {
        await initialize();
        const context = await managedSource();
        const message = row();
        await methods.saveMessage(owner, message, { sourceRetention: context });
        await expect(
          methods.redactFileSourceContent(owner, context.sourceFileIds, options()),
        ).rejects.toMatchObject({ name: 'FileSourceUnavailableError' });
        expect((await models.Message.findOne({ messageId: message.messageId }).lean())?.text).toBe(
          message.text,
        );
      }));

    it.each([0, 101, 1.5, Number.NaN])(
      'rejects invalid page size %s before a query',
      async (limit) =>
        run(async () => {
          const find = jest.spyOn(models.File, 'find');
          await expect(
            methods.redactFileSourceContent(owner, [], options(null, limit)),
          ).rejects.toBeInstanceOf(TypeError);
          expect(find).not.toHaveBeenCalled();
        }),
    );

    it('rejects foreign scope and malformed cursors before a query', async () =>
      run(async () => {
        const { context } = await fixture(2);
        const first = await methods.redactFileSourceContent(
          owner,
          context.sourceFileIds,
          options(),
        );
        const find = jest.spyOn(models.File, 'find');
        await expect(
          methods.redactFileSourceContent(
            { ...owner, userId: new mongoose.Types.ObjectId().toString() },
            context.sourceFileIds,
            options(first.cursor),
          ),
        ).rejects.toBeInstanceOf(TypeError);
        await expect(
          methods.redactFileSourceContent(owner, [uuid()], options(first.cursor)),
        ).rejects.toBeInstanceOf(TypeError);
        await expect(
          methods.redactFileSourceContent(
            owner,
            context.sourceFileIds,
            options({ ...first.cursor!, after: 'invalid' }),
          ),
        ).rejects.toBeInstanceOf(TypeError);
        expect(find).not.toHaveBeenCalled();
      }));

    it('rejects a pre-aborted signal and expired deadline before a query', async () =>
      run(async () => {
        const signal = new AbortController();
        signal.abort();
        const find = jest.spyOn(models.File, 'find');
        await expect(
          methods.redactFileSourceContent(owner, [], options(null, 1, signal.signal)),
        ).rejects.toMatchObject({ name: 'AbortError' });
        await expect(
          methods.redactFileSourceContent(owner, [], { ...options(), deadlineAt: Date.now() - 1 }),
        ).rejects.toMatchObject({ name: 'TimeoutError' });
        expect(find).not.toHaveBeenCalled();
      }));

    it.each(['abort', 'deadline'] as const)(
      'joins its original stalled query after %s instead of reporting success',
      async (kind) =>
        run(async () => {
          const { context, messages } = await fixture();
          const controller = new AbortController(),
            entered = deferred(),
            release = deferred();
          const find = models.File.find.bind(models.File);
          jest.spyOn(models.File, 'find').mockImplementationOnce((...args) => {
            const query = find(...args),
              execute = query.exec.bind(query);
            jest.spyOn(query, 'exec').mockImplementation(async () => {
              expect(query.getOptions().timeoutMS).toBeGreaterThan(0);
              expect(query.getOptions().timeoutMS).toBeLessThanOrEqual(10_000);
              expect(query.getOptions().signal).toBe(controller.signal);
              entered.resolve();
              await release.promise;
              return execute();
            });
            return query;
          });
          let settled = false;
          const result = methods.redactFileSourceContent(
            owner,
            context.sourceFileIds,
            options(null, 1, controller.signal),
          );
          const observed = result
            .then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            )
            .finally(() => {
              settled = true;
            });
          await entered.promise;
          try {
            if (kind === 'abort') controller.abort();
            else jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 20_000);
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(settled).toBe(false);
          } finally {
            release.resolve();
          }
          expect(await observed).toHaveProperty('error');
          jest.restoreAllMocks();
          expect(
            (await models.Message.findOne({ messageId: messages[0].messageId }).lean())?.text,
          ).toBe(messages[0].text);
          expect(await derivativeTotal()).toBeGreaterThan(0);
        }),
    );

    it('rolls back actual redaction and accounting when aborted inside the transaction', async () =>
      run(async () => {
        const { context, messages } = await fixture();
        const before = await derivativeTotal(),
          controller = new AbortController();
        const replace = models.Message.collection.replaceOne.bind(models.Message.collection);
        jest
          .spyOn(models.Message.collection, 'replaceOne')
          .mockImplementationOnce(async (...args) => {
            const result = await replace(...args);
            controller.abort();
            return result;
          });
        await expect(
          methods.redactFileSourceContent(
            owner,
            context.sourceFileIds,
            options(null, 1, controller.signal),
          ),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(
          (await models.Message.findOne({ messageId: messages[0].messageId }).lean())?.text,
        ).toBe(messages[0].text);
        expect(await derivativeTotal()).toBe(before);
      }));

    it.each(['abort', 'unknown acknowledgement'] as const)(
      'retains partial committed progress after %s and safely retries the prior cursor',
      async (kind) =>
        run(async () => {
          const { context } = await fixture(2);
          const controller = new AbortController(),
            start = mongoose.startSession.bind(mongoose);
          const sessionSpy = jest
            .spyOn(mongoose, 'startSession')
            .mockImplementationOnce(async (...args) => {
              const session = await start(...args),
                commit = session.commitTransaction.bind(session);
              jest
                .spyOn(session, 'commitTransaction')
                .mockImplementationOnce(async (...commitArgs) => {
                  await commit(...commitArgs);
                  if (kind === 'abort') controller.abort();
                  else throw new Error('Unknown commit acknowledgement');
                });
              return session;
            });
          await expect(
            methods.redactFileSourceContent(
              owner,
              context.sourceFileIds,
              options(null, 2, controller.signal),
            ),
          ).rejects.toBeInstanceOf(Error);
          sessionSpy.mockRestore();
          expect(
            await models.Message.countDocuments({
              sourceFileIds: { $in: context.sourceFileIds },
              sourceContentRemovedAt: { $ne: null },
            }),
          ).toBe(1);
          await expect(
            methods.redactFileSourceContent(owner, context.sourceFileIds, options(null, 2)),
          ).resolves.toMatchObject({ complete: true, redactedMessages: 1 });
          expect(await derivativeTotal()).toBe(0);
        }),
    );

    it('bounds an actual stalled Mongo command with its native remaining deadline', async () =>
      run(async () => {
        const { context, messages } = await fixture();
        const admin = mongoose.connection.db!.admin();
        await admin.command({
          configureFailPoint: 'failCommand',
          mode: { times: 1 },
          data: {
            failCommands: ['find'],
            blockConnection: true,
            blockTimeMS: 750,
          },
        });
        const started = Date.now();
        try {
          await expect(
            methods.redactFileSourceContent(owner, context.sourceFileIds, {
              ...options(),
              deadlineAt: started + 100,
            }),
          ).rejects.toBeInstanceOf(Error);
          expect(Date.now() - started).toBeLessThan(1000);
        } finally {
          await admin.command({ configureFailPoint: 'failCommand', mode: 'off' });
        }
        expect(
          (await models.Message.findOne({ messageId: messages[0].messageId }).lean())?.text,
        ).toBe(messages[0].text);
        expect(await derivativeTotal()).toBeGreaterThan(0);
      }));

    it('does not enlarge the original page budget when the wall clock moves backward', async () =>
      run(async () => {
        const { context } = await fixture();
        const find = models.File.find.bind(models.File);
        const messageFind = models.Message.find.bind(models.Message);
        let originalRemaining = 0;
        jest.spyOn(models.File, 'find').mockImplementationOnce((...args) => {
          const query = find(...args),
            execute = query.exec.bind(query);
          jest.spyOn(query, 'exec').mockImplementation(async () => {
            originalRemaining = query.getOptions().timeoutMS;
            const found = await execute();
            jest.spyOn(Date, 'now').mockReturnValue(Date.now() - 60_000);
            return found;
          });
          return query;
        });
        jest.spyOn(models.Message, 'find').mockImplementationOnce((...args) => {
          const query = messageFind(...args),
            execute = query.exec.bind(query);
          jest.spyOn(query, 'exec').mockImplementation(async () => {
            expect(query.getOptions().timeoutMS).toBeLessThanOrEqual(originalRemaining);
            expect(query.getOptions().timeoutMS).toBeGreaterThan(0);
            return execute();
          });
          return query;
        });
        try {
          await expect(
            methods.redactFileSourceContent(owner, context.sourceFileIds, {
              ...options(),
              deadlineAt: Date.now() + 1000,
            }),
          ).resolves.toMatchObject({ complete: true });
        } finally {
          jest.restoreAllMocks();
        }
        expect(await derivativeTotal()).toBe(0);
      }));

    it('keeps the compatibility drain within its original finite overall deadline', async () =>
      run(async () => {
        const { context } = await fixture(2);
        const start = Date.now(),
          find = models.Message.findOne.bind(models.Message);
        jest.spyOn(models.Message, 'findOne').mockImplementation((...args) => {
          const query = find(...args);
          if (query.getFilter().$or?.length === 4) {
            const execute = query.exec.bind(query);
            jest.spyOn(query, 'exec').mockImplementation(async () => {
              const result = await execute();
              jest.spyOn(Date, 'now').mockReturnValue(start + 60_001);
              return result;
            });
          }
          return query;
        });
        try {
          await expect(
            methods.redactFileSourceContent(owner, context.sourceFileIds),
          ).rejects.toMatchObject({ name: 'TimeoutError' });
        } finally {
          jest.restoreAllMocks();
        }
        expect(await derivativeTotal()).toBe(0);
      }));

    it('does not convert a failed final proof into completion after a committed page', async () =>
      run(async () => {
        const { context } = await fixture();
        const find = models.Message.findOne.bind(models.Message);
        const proof = jest.spyOn(models.Message, 'findOne').mockImplementation((...args) => {
          const query = find(...args);
          if (query.getFilter().$or?.length === 4)
            jest.spyOn(query, 'exec').mockImplementationOnce(async () => {
              expect(query.getOptions().readConcern).toEqual({ level: 'majority' });
              throw new Error('Final query unavailable');
            });
          return query;
        });
        await expect(
          methods.redactFileSourceContent(owner, context.sourceFileIds, options()),
        ).rejects.toThrow('Final query unavailable');
        proof.mockRestore();
        await expect(
          methods.redactFileSourceContent(owner, context.sourceFileIds, options()),
        ).resolves.toMatchObject({ complete: true, redactedMessages: 0 });
        expect(await derivativeTotal()).toBe(0);
      }));
  });
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
