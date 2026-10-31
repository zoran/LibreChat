/** Real Mongo evidence for private File approvals and native API enforcement; no mocked guards. */
import mongoose from 'mongoose';
import { createHash, randomUUID } from 'crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { FileContext, UPLOAD_RETENTION_MS } from 'librechat-data-provider';
import type { UploadLease, UploadSecurityApproval } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { ManagedUploadAcceptance } from './fileRetention';
import {
  uploadSecurityFixture,
  originalWriteBindingFixture,
  bindUploadOriginalFixture,
  uploadSecuritySettlementFixture,
} from './uploadManagement.security.fixture';
import {
  createFileRetentionMethods,
  FileSourceUnavailableError,
  resolveFileSources,
} from './fileRetention';
import { createUploadManagementRepository } from './uploadManagement';
import { tenantStorage } from '~/config/tenantContext';
import { createFileMethods } from './file';
import { createModels } from '~/models';

describe('native File security boundary', () => {
  const db = new mongoose.Mongoose();
  let mongo: MongoMemoryReplSet;
  let files: ReturnType<typeof createFileMethods>;
  let lifecycle: ReturnType<typeof createFileRetentionMethods>;
  let repository: ReturnType<typeof createUploadManagementRepository>;
  const policy = 'c'.repeat(64);
  const now = Date.now();
  const bytes = Buffer.from('fixture\n');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const owner = { tenantId: 'tenant-a', userId: new mongoose.Types.ObjectId().toString() };
  const previous = {
    policy: process.env.UPLOAD_SECURITY_POLICY_SHA256,
    enabled: process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED,
  };

  function acceptance(id = 'approved', scope = owner): ManagedUploadAcceptance {
    const input: ManagedUploadAcceptance = {
      principal: { ...scope, authentication: 'verified-email' },
      operationId: id,
      filename: `private-${id}.txt`,
      mediaType: 'text/plain',
      transferGeneration: 1,
      acceptedAt: now,
      receipt: {
        outcome: 'durable',
        bytes: bytes.length,
        source: 's3',
        filepath: `/api/files/managed/${id}`,
        storageKey: `t/${scope.tenantId}/managed-uploads/${scope.userId}/${id}.1__original`,
        integrity: {
          version: 1,
          algorithm: 'sha256',
          sha256,
          chunkBytes: 262144,
          chunkSha256: [sha256],
        },
      },
      securityApproval: uploadSecurityFixture({
        decision: 'approved',
        policySha256: policy,
        subject: {
          ...scope,
          operationId: id,
          transferGeneration: 1,
          mediaType: 'text/plain',
          bytes: bytes.length,
          sha256,
        },
        scannerVersion: 'trusted-fixture/v1',
        checkedAt: new Date(now).toISOString(),
        coverage: { complete: true, pages: 1, parts: 1 },
      }).approval,
    };
    return {
      ...input,
      writeBinding: originalWriteBindingFixture(
        input.receipt,
        input.securityApproval,
        input.acceptedAt,
      ),
    };
  }

  async function transaction(action: (session: ClientSession) => Promise<void>): Promise<void> {
    const session = await db.startSession();
    try {
      await session.withTransaction(async () => action(session));
    } finally {
      await session.endSession();
    }
  }

  const localGone = (lease: UploadLease) => ({
    operationId: lease.operationId,
    generation: lease.generation,
    writerStopped: true,
    localCopiesAbsent: true,
    originalAbsent: false,
    textAndHistoryRemoved: false,
  });

  async function ready(
    input = acceptance(),
  ): Promise<ManagedUploadAcceptance & { processingGeneration: number }> {
    const at = input.acceptedAt;
    const worker = { hostId: 'host-a', instanceId: 'app-a' };
    await repository.reserve(
      input.principal,
      {
        operationId: input.operationId,
        idempotencyKey: randomUUID(),
        mediaType: input.mediaType,
        declaredBytes: input.receipt.bytes,
        fingerprint: JSON.stringify([{ kind: 'personal' }, input.mediaType, input.receipt.bytes]),
      },
      at,
    );
    const transfer = await repository.claim({
      kind: 'transfer',
      principal: input.principal,
      operationId: input.operationId,
      worker,
      now: at,
    });
    if (!transfer) throw new Error('Fixture transfer claim unavailable');
    expect(transfer.generation).toBe(input.transferGeneration);
    const security = uploadSecurityFixture(input.securityApproval, {
      custody: { kind: 'none' as const },
      attemptId: `${input.operationId}.${transfer.generation}`,
      instanceId: randomUUID(),
      executionId: randomUUID(),
      expiresAt: new Date(at + 60_000).toISOString(),
    });
    const execution = security.execution;
    await repository.bindSecurityExecution(transfer, execution, at);
    await repository.settleSecurityExecution(
      transfer,
      uploadSecuritySettlementFixture(execution, {
        writerStopped: true,
        transientDataRemoved: true,
      }),
      at,
    );
    input.writeBinding = await bindUploadOriginalFixture(
      repository,
      transfer,
      input.receipt,
      input.securityApproval,
      at,
    );
    await repository.accept(
      input.principal,
      transfer,
      input.receipt,
      input.securityApproval,
      { filename: input.filename },
      at,
    );
    await repository.confirmCleanup(localGone(transfer), at);
    const processing = await repository.claim({ kind: 'processing', worker, now: at });
    if (!processing) throw new Error('Fixture processing claim unavailable');
    expect(processing.operationId).toBe(input.operationId);
    await repository.bindProcessingExecution(
      processing,
      {
        attemptId: `${input.operationId}.${processing.generation}`,
        instanceId: 'parser-a',
        expiresAt: new Date(at + 60_000).toISOString(),
      },
      at,
    );
    await repository.publish(
      processing,
      {
        text: `private content for ${input.operationId}`,
        writerStopped: true,
        structure: {
          version: 1,
          source: { sha256, bytes: bytes.length, mediaType: 'text/plain' },
          extractor: { name: 'fixture', version: '1' },
          pages: [],
          elements: [
            {
              id: 'e1',
              kind: 'paragraph',
              start: 0,
              end: `private content for ${input.operationId}`.length,
              page: null,
              parentId: null,
            },
          ],
          quality: { status: 'complete', warnings: [] },
        },
      },
      at,
    );
    await repository.confirmCleanup(localGone(processing), at);
    return { ...input, processingGeneration: processing.generation };
  }

  const raw = (id = 'approved') => db.models.File.collection.findOne({ file_id: id });
  const ownedFilter = (id: string) => ({
    file_id: id,
    user: owner.userId,
    tenantId: owner.tenantId,
  });
  const ordinary = (id = 'legacy') => ({
    file_id: id,
    user: new mongoose.Types.ObjectId(owner.userId),
    tenantId: owner.tenantId,
    filename: `private-${id}.txt`,
    filepath: `/uploads/${id}`,
    type: 'text/plain',
    bytes: bytes.length,
    source: 'local',
    context: FileContext.message_attachment,
    embedded: true,
    text: `private content for ${id}`,
  });

  async function hidden(id = 'approved'): Promise<void> {
    expect(await files.findFileById(id, ownedFilter(id))).toBeNull();
    expect(await files.getFiles(ownedFilter(id), {}, {})).toEqual([]);
    expect(await files.getProjectFiles({ ...owner, fileIds: [id], includeContent: true })).toEqual(
      [],
    );
    expect(await files.getAvailableProjectFiles({ ...owner, search: `private-${id}` })).toEqual({
      files: [],
      nextCursor: null,
    });
    expect(await files.getRunFileCandidates([id], owner.tenantId)).toEqual([]);
    await expect(resolveFileSources(db, owner, [id])).rejects.toThrow(
      'Document source unavailable',
    );
  }

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await db.connect(mongo.getUri('file-security'));
    createModels(db);
    await Promise.all([db.models.File.init(), db.models.Message.init()]);
    files = createFileMethods(db);
    lifecycle = createFileRetentionMethods(db, { securityPolicySha256: policy });
  });
  beforeEach(async () => {
    process.env.UPLOAD_SECURITY_POLICY_SHA256 = policy;
    process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = 'true';
    for (const name of [
      'User',
      'File',
      'Message',
      'UploadOperation',
      'UploadCounter',
      'FileReadReceipt',
      'HousekeepingJob',
    ])
      if (db.models[name]) await db.models[name].deleteMany({});
    await db.models.User.create({
      _id: owner.userId,
      tenantId: owner.tenantId,
      email: 'file-security@example.test',
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
  afterEach(() => {
    for (const [key, value] of [
      ['UPLOAD_SECURITY_POLICY_SHA256', previous.policy],
      ['CORTEX_UPLOAD_MANAGEMENT_ENABLED', previous.enabled],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  afterAll(async () => {
    await db.disconnect();
    await mongo?.stop();
  });

  const invalid: [string, (input: ManagedUploadAcceptance) => void][] = [
    [
      'missing proof',
      (input) => {
        input.securityApproval = undefined as unknown as UploadSecurityApproval;
      },
    ],
    [
      'foreign tenant',
      (input) => {
        input.securityApproval.subject.tenantId = 'tenant-b';
      },
    ],
    [
      'foreign owner',
      (input) => {
        input.securityApproval.subject.userId = new mongoose.Types.ObjectId().toString();
      },
    ],
    [
      'different operation',
      (input) => {
        input.securityApproval.subject.operationId = 'other-operation';
      },
    ],
    [
      'different transfer generation',
      (input) => {
        input.securityApproval.subject.transferGeneration++;
      },
    ],
    [
      'different bytes',
      (input) => {
        input.securityApproval.subject.bytes++;
      },
    ],
    [
      'different digest',
      (input) => {
        input.securityApproval.subject.sha256 = 'a'.repeat(64);
      },
    ],
    [
      'different media type',
      (input) => {
        input.securityApproval.subject.mediaType = 'application/pdf';
      },
    ],
    [
      'different policy',
      (input) => {
        input.securityApproval.policySha256 = 'd'.repeat(64);
      },
    ],
    [
      'future check',
      (input) => {
        input.securityApproval.checkedAt = new Date(now + 1).toISOString();
      },
    ],
  ];
  it.each(invalid)('refuses %s before transactional File acceptance', async (_name, change) => {
    const input = acceptance();
    change(input);
    await expect(
      transaction(async (session) => {
        await lifecycle.acceptManagedUpload(input, session);
      }),
    ).rejects.toBeInstanceOf(FileSourceUnavailableError);
    expect(await db.models.File.countDocuments()).toBe(0);
  });

  it('requires a real transaction and rolls back an otherwise valid acceptance on abort', async () => {
    const session = await db.startSession();
    try {
      await expect(lifecycle.acceptManagedUpload(acceptance(), session)).rejects.toBeInstanceOf(
        FileSourceUnavailableError,
      );
    } finally {
      await session.endSession();
    }
    await expect(
      transaction(async (active) => {
        await lifecycle.acceptManagedUpload(acceptance(), active);
        throw new Error('fixture transaction abort');
      }),
    ).rejects.toThrow('fixture transaction abort');
    expect(await db.models.File.countDocuments()).toBe(0);
  });

  it('admits a bound receipt, preserves the transfer generation and keeps proof private', async () => {
    const input = await ready();
    expect(await raw()).toMatchObject({
      securityApproval: input.securityApproval,
      previewRevision: String(input.processingGeneration),
      status: 'ready',
    });
    const lean = await db.models.File.findOne({ file_id: input.operationId }).lean();
    expect(lean).not.toHaveProperty('securityApproval');
    const document = await db.models.File.findOne({ file_id: input.operationId }).select(
      '+securityApproval',
    );
    expect(document.get('securityApproval')).toEqual(input.securityApproval);
    expect(document.toObject()).not.toHaveProperty('securityApproval');
    expect(document.toJSON()).not.toHaveProperty('securityApproval');
    const list = await files.getFiles(ownedFilter(input.operationId));
    expect(list).toHaveLength(1);
    expect(list![0]).not.toHaveProperty('securityApproval');
    expect(list![0]).not.toHaveProperty('text');
    const project = await files.getProjectFiles({
      ...owner,
      fileIds: [input.operationId],
      includeContent: true,
    });
    expect(project).toHaveLength(1);
    expect(project[0]).toMatchObject({ text: 'private content for approved' });
    expect(project[0]).not.toHaveProperty('securityApproval');
    const picker = await files.getAvailableProjectFiles(owner);
    expect(picker.files.map((file) => file.file_id)).toEqual(['approved']);
    expect(picker.files[0]).not.toHaveProperty('text');
    expect(picker.files[0]).not.toHaveProperty('securityApproval');
    const candidates = await files.getRunFileCandidates(['approved'], owner.tenantId);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).not.toHaveProperty('securityApproval');
    await expect(resolveFileSources(db, owner, ['approved'])).resolves.toMatchObject({
      sourceFileIds: ['approved'],
    });
  });

  it('snapshots the approved receipt before acceptance yields to Mongo', async () => {
    const input = acceptance();
    const original = JSON.parse(JSON.stringify(input.securityApproval));
    await transaction(async (session) => {
      const pending = lifecycle.acceptManagedUpload(input, session);
      input.securityApproval.subject.sha256 = 'd'.repeat(64);
      input.securityApproval.coverage.pages = 500;
      await pending;
    });
    expect((await raw())!.securityApproval).toEqual(original);
  });

  it.each(['changed', 'missing', 'invalid'] as const)(
    'closes every read when current policy is %s',
    async (state) => {
      await ready();
      if (state === 'missing') delete process.env.UPLOAD_SECURITY_POLICY_SHA256;
      else
        process.env.UPLOAD_SECURITY_POLICY_SHA256 =
          state === 'changed' ? 'd'.repeat(64) : 'invalid';
      await expect(hidden()).resolves.toBeUndefined();
    },
  );

  it.each([
    'missing proof',
    'wrong owner',
    'wrong operation',
    'wrong type',
    'wrong bytes',
    'wrong generation',
    'expired',
    'revoked',
  ] as const)('withholds all normal views for %s', async (state) => {
    await ready();
    const changes: Record<string, unknown> = {
      'missing proof': null,
      'wrong owner': new mongoose.Types.ObjectId().toString(),
      'wrong operation': 'another-operation',
      'wrong type': 'application/pdf',
      'wrong bytes': bytes.length + 1,
      'wrong generation': 2,
      expired: new Date(now - 1),
      revoked: new Date(now),
    };
    const fields = {
      'missing proof': 'securityApproval',
      'wrong owner': 'securityApproval.subject.userId',
      'wrong operation': 'securityApproval.subject.operationId',
      'wrong type': 'type',
      'wrong bytes': 'bytes',
      'wrong generation': 'securityApproval.subject.transferGeneration',
      expired: 'expiredAt',
      revoked: 'deletionRequestedAt',
    };
    await db.models.File.collection.updateOne(
      { file_id: 'approved' },
      { $set: { [fields[state]]: changes[state] } },
    );
    await expect(hidden()).resolves.toBeUndefined();
  });

  it('keeps filenames, content and pagination private when a blocked row is newer than a valid row', async () => {
    await ready(acceptance('visible'));
    await ready(acceptance('blocked'));
    await db.models.File.collection.updateOne(
      { file_id: 'blocked' },
      { $unset: { securityApproval: '' } },
    );
    const result = await files.getAvailableProjectFiles({ ...owner, limit: 1 });
    expect(result.files.map((file) => file.file_id)).toEqual(['visible']);
    expect(result.nextCursor).toBeNull();
    expect(JSON.stringify(result)).not.toContain('blocked');
    expect(JSON.stringify(result)).not.toContain('private content');
    expect(await files.getAvailableProjectFiles({ ...owner, search: 'blocked' })).toEqual({
      files: [],
      nextCursor: null,
    });
  });

  it('denies foreign owners and tenants through owner-scoped consumers', async () => {
    await ready();
    for (const foreign of [
      { ...owner, userId: new mongoose.Types.ObjectId().toString() },
      { ...owner, tenantId: 'tenant-b' },
    ]) {
      expect(
        await files.getFiles(
          { file_id: 'approved', user: foreign.userId, tenantId: foreign.tenantId },
          {},
          {},
        ),
      ).toEqual([]);
      expect(
        await files.getProjectFiles({ ...foreign, fileIds: ['approved'], includeContent: true }),
      ).toEqual([]);
      expect(await files.getAvailableProjectFiles(foreign)).toEqual({
        files: [],
        nextCursor: null,
      });
      await expect(resolveFileSources(db, foreign, ['approved'])).rejects.toBeInstanceOf(
        FileSourceUnavailableError,
      );
    }
    // This hydration API has a tenant argument; its caller owns the separate agent/owner ACL.
    expect(await files.getRunFileCandidates(['approved'], 'tenant-b')).toEqual([]);
  });

  it.each([
    ['fractional coverage', { 'securityApproval.coverage.pages': 1.5 }],
    ['noncanonical time', { 'securityApproval.checkedAt': '0000' }],
    ['invalid calendar date', { 'securityApproval.checkedAt': '2026-02-30T00:00:00.000Z' }],
    ['missing scanner revision', { 'securityApproval.scannerVersion': null }],
  ])('refuses stored receipt corruption: %s', async (_name, change) => {
    await ready();
    await db.models.File.collection.updateOne({ file_id: 'approved' }, { $set: change });
    await expect(hidden()).resolves.toBeUndefined();
  });

  it('strips direct and dotted proof forgery from ordinary create and update', async () => {
    const input = acceptance('forged');
    await tenantStorage.run(owner, async () =>
      files.createFile(
        {
          ...ordinary('forged'),
          securityApproval: input.securityApproval,
          uploadOperationId: 'forged',
          'securityApproval.policySha256': policy,
        } as Parameters<typeof files.createFile>[0],
        true,
      ),
    );
    expect(await raw('forged')).not.toHaveProperty('securityApproval');
    expect(await raw('forged')).not.toHaveProperty('uploadOperationId');
    await hidden('forged');
    const accepted = await ready();
    await files.updateFile({
      file_id: 'approved',
      securityApproval: { ...accepted.securityApproval, policySha256: 'd'.repeat(64) },
      'securityApproval.subject.sha256': 'd'.repeat(64),
      uploadOperationId: 'forged',
    } as Parameters<typeof files.updateFile>[0]);
    expect((await raw())!.securityApproval).toEqual(accepted.securityApproval);
    expect((await raw())!.uploadOperationId).toBe('approved');
  });

  it.each(['$set', '$setOnInsert'])(
    'cannot smuggle an approval through ordinary create %s',
    async (operator) => {
      const input = acceptance('forged');
      const malicious = {
        ...ordinary('forged'),
        [operator]: {
          securityApproval: input.securityApproval,
          uploadOperationId: input.operationId,
          retentionAcceptedAt: new Date(now),
          expiredAt: new Date(input.acceptedAt + UPLOAD_RETENTION_MS),
          source: 's3',
          storageKey: input.receipt.storageKey,
          filepath: input.receipt.filepath,
          status: 'ready',
        },
      };
      // Refusing the whole write or stripping its authority is safe; persisting it is not.
      await tenantStorage.run(owner, async () =>
        files
          .createFile(malicious as Parameters<typeof files.createFile>[0], true)
          .catch(() => undefined),
      );
      const stored = await raw('forged');
      expect(stored?.securityApproval).toBeUndefined();
      expect(stored?.uploadOperationId).toBeUndefined();
      await hidden('forged');
    },
  );

  it('keeps accepted original identity/content immutable through ordinary updates and bulk URL refresh', async () => {
    const input = await ready();
    for (const change of [
      { text: 'replacement' },
      { filename: 'replacement.txt' },
      { filepath: '/replacement' },
      { storageKey: 'replacement' },
      { bytes: bytes.length + 1 },
      { type: 'application/pdf' },
      { source: 'local' },
      { tenantId: 'tenant-b' },
    ]) {
      await expect(files.updateFile({ file_id: 'approved', ...change })).rejects.toBeInstanceOf(
        FileSourceUnavailableError,
      );
    }
    await files.batchUpdateFiles([
      { file_id: 'approved', filepath: '/replacement', storageKey: 'replacement' },
    ]);
    expect(await raw()).toMatchObject({
      filepath: input.receipt.filepath,
      storageKey: input.receipt.storageKey,
      text: 'private content for approved',
      securityApproval: input.securityApproval,
    });
  });

  it('preserves upstream files with management disabled and closes the same legacy row when enabled', async () => {
    // Native upsert obtains the namespace from request context; caller tenant fields are stripped.
    await tenantStorage.run(owner, async () => {
      delete process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED;
      delete process.env.UPLOAD_SECURITY_POLICY_SHA256;
      await files.createFile(ordinary(), true);
      expect(await files.findFileById('legacy', ownedFilter('legacy'))).toMatchObject({
        file_id: 'legacy',
      });
      expect(
        (await files.getProjectFiles({ ...owner, fileIds: ['legacy'], includeContent: true }))[0],
      ).toMatchObject({ text: 'private content for legacy' });
      expect((await files.getAvailableProjectFiles(owner)).files).toHaveLength(1);
      expect(await files.getRunFileCandidates(['legacy'], owner.tenantId)).toHaveLength(1);
      await expect(resolveFileSources(db, owner, ['legacy'])).resolves.toBeUndefined();
      await files.updateFile({ file_id: 'legacy', text: 'ordinary update' });
      await files.batchUpdateFiles([{ file_id: 'legacy', filepath: '/ordinary-new-url' }]);
      expect(await raw('legacy')).toMatchObject({
        text: 'ordinary update',
        filepath: '/ordinary-new-url',
      });
      process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = 'true';
      process.env.UPLOAD_SECURITY_POLICY_SHA256 = policy;
      await hidden('legacy');
    });
  });
});
