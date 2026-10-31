/** Real Workspace/File transactions; scanner and storage receipts are explicit synthetic fixtures. */
import mongoose from 'mongoose';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { uploadReservationFingerprint } from 'librechat-data-provider';
import type { UploadDerivedIntent } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { ManagedUploadAcceptance } from '~/types/file';
import {
  uploadSecurityFixture,
  bindUploadOriginalFixture,
  uploadSecuritySettlementFixture,
} from './uploadManagement.security.fixture';
import { createUploadManagementRepository } from './uploadManagement';
import { createDocumentWorkspaceMethods } from './documentWorkspace';
import { createHousekeepingStore } from './housekeepingStore';
import { createFileRetentionMethods } from './fileRetention';
import { tenantStorage } from '~/config/tenantContext';
import { createUserMethods } from './user';
import { createModels } from '~/models';

describe('independent document workspace metadata and native File commits', () => {
  const db = new mongoose.Mongoose();
  const owner = { userId: new mongoose.Types.ObjectId().toString(), tenantId: 'workspace-test' };
  const policy = 'c'.repeat(64);
  const at = Date.now();
  const text = 'Synthetisches freigegebenes Testdokument.\n';
  const bytes = Buffer.from(text);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let mongo: MongoMemoryReplSet;
  let methods: ReturnType<typeof createDocumentWorkspaceMethods>;
  let lifecycle: ReturnType<typeof createFileRetentionMethods>;
  let uploads: ReturnType<typeof createUploadManagementRepository>;
  const worker = { hostId: 'fixture-host', instanceId: 'fixture-app' };
  const previousEnabled = process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED;

  async function approved(id: string, intent: UploadDerivedIntent, target = owner) {
    const input: ManagedUploadAcceptance = {
      principal: { ...target, authentication: 'verified-email' },
      operationId: id,
      filename: 'synthetisch.txt',
      mediaType: 'text/plain',
      transferGeneration: 1,
      acceptedAt: at,
      receipt: {
        outcome: 'durable',
        bytes: bytes.length,
        source: 's3',
        filepath: `/api/files/managed/${id}`,
        storageKey: `t/${target.tenantId}/managed-uploads/${target.userId}/${id}.1__original`,
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
          ...target,
          operationId: id,
          transferGeneration: 1,
          mediaType: 'text/plain',
          bytes: bytes.length,
          sha256,
        },
        scannerVersion: 'explicit-synthetic-fixture/v1',
        checkedAt: new Date(at).toISOString(),
        coverage: { complete: true, pages: 1, parts: 1 },
      }).approval,
    };
    await ready(input, intent);
  }
  async function ready(
    input: ManagedUploadAcceptance,
    derived?: UploadDerivedIntent,
  ): Promise<void> {
    const id = input.operationId;
    const now = input.acceptedAt;
    const principal = input.principal;
    derived ??= input.derivedOrigin && {
      binding: input.derivedOrigin.binding,
      directSourceFileIds: input.derivedOrigin.directSourceFileIds,
    };
    const key = createHash('sha256').update(id).digest('hex');
    const request = {
      operationId: id,
      idempotencyKey: `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-8${key.slice(17, 20)}-${key.slice(20, 32)}`,
      mediaType: input.mediaType,
      declaredBytes: input.receipt.bytes,
      fingerprint: uploadReservationFingerprint(
        {
          mediaType: input.mediaType,
          declaredBytes: input.receipt.bytes,
          scope: { kind: 'personal' },
        },
        derived,
      ),
    };
    if (derived) await uploads.reserveDerived(principal, { ...request, derived }, now);
    else await uploads.reserve(principal, request, now);
    const transfer = (await uploads.claim({
      kind: 'transfer',
      principal,
      operationId: id,
      worker,
      now,
    }))!;
    expect(transfer.generation).toBe(input.transferGeneration);
    const security = uploadSecurityFixture(input.securityApproval!, {
      custody: { kind: 'none' as const },
      attemptId: `${id}.${transfer.generation}`,
      instanceId: '11111111-1111-4111-8111-111111111111',
      executionId: '22222222-2222-4222-8222-222222222222',
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    const execution = security.execution;
    await uploads.bindSecurityExecution(transfer, execution, now);
    await uploads.settleSecurityExecution(
      transfer,
      uploadSecuritySettlementFixture(execution, {
        writerStopped: true,
        transientDataRemoved: true,
      }),
      now,
    );
    await bindUploadOriginalFixture(uploads, transfer, input.receipt, input.securityApproval!, now);
    await uploads.accept(
      principal,
      transfer,
      input.receipt,
      input.securityApproval!,
      { filename: input.filename },
      now,
    );
    const gone = (lease: typeof transfer) => ({
      operationId: id,
      generation: lease.generation,
      writerStopped: true,
      localCopiesAbsent: true,
      originalAbsent: false,
      textAndHistoryRemoved: false,
    });
    await uploads.confirmCleanup(gone(transfer), now);
    const lease = (await uploads.claim({ kind: 'processing', worker, now }))!;
    expect(lease.operationId).toBe(id);
    await uploads.bindProcessingExecution(
      lease,
      {
        attemptId: `${id}.${lease.generation}`,
        instanceId: 'fixture-parser',
        expiresAt: new Date(now + 60_000).toISOString(),
      },
      now,
    );
    await uploads.publish(
      lease,
      {
        text,
        writerStopped: true,
        structure: {
          version: 1,
          source: { sha256, bytes: bytes.length, mediaType: 'text/plain' },
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
    await uploads.confirmCleanup(gone(lease), now);
  }
  const draft = () => methods.createDocumentWorkspace(owner);
  async function firstVersion(fileId = 'version-one', target = owner) {
    const workspace = await methods.createDocumentWorkspace(target);
    await approved(
      fileId,
      await methods.getDocumentWorkspaceSaveIntent(target, workspace.workspaceId, 0),
      target,
    );
    await methods.commitDocumentWorkspaceVersion(target, workspace.workspaceId, 0, fileId);
    return workspace.workspaceId;
  }
  let registeredMongo: Array<{
    pid: number;
    kind: string;
    start: string;
    port?: number;
    dbPath?: string;
  }> = [];
  function registerMongo(status: 'running' | 'settled') {
    if (!process.env.RETENTION_RUN_SCOPE || !process.env.RETENTION_RUN_KEY) return;
    if (status === 'running')
      registeredMongo = mongo.servers.flatMap((server) => {
        const info = server.instanceInfo;
        const instance = info?.instance as unknown as {
          mongodProcess?: { pid?: number };
          killerProcess?: { pid?: number };
        };
        return [
          ['mongod', instance?.mongodProcess?.pid],
          ['killer', instance?.killerProcess?.pid],
        ].flatMap(([kind, pid]) =>
          typeof pid === 'number'
            ? [
                {
                  kind: String(kind),
                  pid,
                  start: readFileSync(`/proc/${pid}/stat`, 'utf8')
                    .split(')')[1]
                    .trim()
                    .split(' ')[19],
                  port: info?.port,
                  dbPath: kind === 'mongod' ? info?.dbPath : undefined,
                },
              ]
            : [],
        );
      });
    execFileSync('python3', [
      `${process.env.RETENTION_RUN_SCOPE}/runner/register-mongo.py`,
      status,
      JSON.stringify(registeredMongo),
    ]);
  }
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      binary: { version: '7.0.43', systemBinary: process.env.MONGOMS_SYSTEM_BINARY },
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    registerMongo('running');
    await db.connect(mongo.getUri('workspace'), { serverSelectionTimeoutMS: 5000 });
    createModels(db);
    await Promise.all(
      ['User', 'File', 'Message', 'DocumentWorkspace', 'DocumentWorkspaceRevision'].map((name) =>
        db.models[name].init(),
      ),
    );
    await createHousekeepingStore(db).initialize();
    lifecycle = createFileRetentionMethods(db, { securityPolicySha256: policy });
    methods = createDocumentWorkspaceMethods(db, { securityPolicySha256: policy, now: () => at });
  });
  beforeEach(async () => {
    process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = 'true';
    for (const name of [
      'DocumentWorkspaceRevision',
      'DocumentWorkspace',
      'File',
      'Message',
      'User',
      'UploadCounter',
      'UploadOperation',
      'HousekeepingJob',
      'FileReadReceipt',
    ])
      if (db.models[name]) await db.models[name].deleteMany({});
    await db.models.User.create({
      _id: owner.userId,
      tenantId: owner.tenantId,
      email: 'workspace@example.test',
      emailVerified: true,
    });
    uploads = createUploadManagementRepository(db, {
      enabled: true,
      reconciled: true,
      securityPolicySha256: policy,
      baseline: { originalBytes: 0, objectBytes: 0, textBytes: 0, recordBytes: 0, bundles: 0 },
    });
    await uploads.initialize();
  });
  afterEach(() => {
    if (previousEnabled === undefined) delete process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED;
    else process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = previousEnabled;
  });
  afterAll(async () => {
    await db.disconnect();
    await mongo?.stop();
    registerMongo('settled');
  });

  it('persists an empty private draft without content, File copies or Message lifecycle coupling', async () => {
    const created = await draft();
    expect(created).toMatchObject({
      revision: 0,
      headFileId: null,
      title: 'Neuer Entwurf',
      format: 'markdown',
    });
    await db.models.Message.deleteMany({ user: owner.userId });
    expect(await methods.getDocumentWorkspace(owner, created.workspaceId)).toEqual(created);
    expect(await db.models.File.countDocuments()).toBe(0);
    const raw = await db.models.DocumentWorkspace.collection.findOne({
      workspaceId: created.workspaceId,
    });
    expect(raw).not.toHaveProperty('text');
    expect(raw).not.toHaveProperty('content');
    expect(raw).not.toHaveProperty('expiredAt');
  });
  it('keeps owners, explicit tenants and ambient tenant scope isolated', async () => {
    const created = await draft();
    for (const other of [
      { ...owner, userId: new mongoose.Types.ObjectId().toString() },
      { ...owner, tenantId: 'foreign' },
    ]) {
      await expect(methods.getDocumentWorkspace(other, created.workspaceId)).rejects.toMatchObject({
        code: 'not_found',
      });
      await expect(methods.listDocumentWorkspaces(other)).rejects.toMatchObject({
        code: 'not_found',
      });
    }
    await expect(
      tenantStorage.run({ tenantId: 'foreign' }, () =>
        methods.getDocumentWorkspace(owner, created.workspaceId),
      ),
    ).rejects.toThrow();
  });
  it('commits only an actually approved native File, then reopens the stored immutable reference', async () => {
    const id = await firstVersion();
    const read = await methods.getDocumentWorkspace(owner, id);
    expect(read).toMatchObject({ revision: 1, headFileId: 'version-one' });
    const original = await methods.getDocumentWorkspaceVersionFile(owner, id, 1);
    expect(original).toMatchObject({ file_id: 'version-one', bytes: bytes.length });
    expect(original.derivedOrigin.binding).toEqual({
      purpose: 'workspace-draft',
      sourceId: id,
      sourceRevision: 0,
    });
    expect(read).not.toHaveProperty('securityApproval');
    expect(read).not.toHaveProperty('derivedOrigin');
    await db.models.Message.deleteMany({});
    expect((await methods.getDocumentWorkspace(owner, id)).revision).toBe(1);
  });
  it('rejects a missing/unapproved file and a file bound to another workspace', async () => {
    const a = await draft();
    const b = await draft();
    await expect(
      methods.commitDocumentWorkspaceVersion(owner, a.workspaceId, 0, 'missing'),
    ).rejects.toMatchObject({ code: 'source_unavailable' });
    await approved(
      'other-workspace',
      await methods.getDocumentWorkspaceSaveIntent(owner, b.workspaceId, 0),
    );
    await expect(
      methods.commitDocumentWorkspaceVersion(owner, a.workspaceId, 0, 'other-workspace'),
    ).rejects.toMatchObject({ code: 'source_unavailable' });
    expect((await methods.getDocumentWorkspace(owner, a.workspaceId)).revision).toBe(0);
  });
  it('retains predecessor provenance and refuses a source-free replacement of sourced content', async () => {
    const id = await firstVersion();
    const intent = await methods.getDocumentWorkspaceSaveIntent(owner, id, 1);
    expect(intent.directSourceFileIds).toEqual(['version-one']);
    await approved('wrong-lineage', { ...intent, directSourceFileIds: [] });
    await expect(
      methods.commitDocumentWorkspaceVersion(owner, id, 1, 'wrong-lineage'),
    ).rejects.toMatchObject({ code: 'source_unavailable' });
    await approved('version-two', intent);
    expect(
      (await methods.commitDocumentWorkspaceVersion(owner, id, 1, 'version-two')).revision,
    ).toBe(2);
    expect(
      (await methods.getDocumentWorkspaceVersionFile(owner, id, 2)).derivedOrigin.ancestors.map(
        (entry) => entry.subject.operationId,
      ),
    ).toContain('version-one');
  });
  it('has one winner for concurrent saves and idempotently acknowledges only the same File', async () => {
    const workspace = await draft();
    const intent = await methods.getDocumentWorkspaceSaveIntent(owner, workspace.workspaceId, 0);
    await approved('candidate-a', intent);
    await approved('candidate-b', intent);
    const results = await Promise.allSettled(
      ['candidate-a', 'candidate-b'].map((id) =>
        methods.commitDocumentWorkspaceVersion(owner, workspace.workspaceId, 0, id),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const head = await methods.getDocumentWorkspace(owner, workspace.workspaceId);
    expect(
      await db.models.DocumentWorkspaceRevision.countDocuments({
        workspaceId: workspace.workspaceId,
      }),
    ).toBe(1);
    expect(
      (
        await methods.commitDocumentWorkspaceVersion(
          owner,
          workspace.workspaceId,
          0,
          head.headFileId!,
        )
      ).revision,
    ).toBe(1);
    await expect(
      methods.getDocumentWorkspaceSaveIntent(owner, workspace.workspaceId, 0),
    ).rejects.toMatchObject({ code: 'revision_conflict' });
  });
  it('rolls back actual File fences and the Version when the Head CAS fails', async () => {
    const workspace = await draft();
    await approved(
      'rollback',
      await methods.getDocumentWorkspaceSaveIntent(owner, workspace.workspaceId, 0),
    );
    const before = await db.models.File.collection.findOne({ file_id: 'rollback' });
    const update = jest
      .spyOn(db.models.DocumentWorkspace, 'updateOne')
      .mockImplementationOnce(() => {
        throw new Error('synthetic metadata write failure');
      });
    await expect(
      methods.commitDocumentWorkspaceVersion(owner, workspace.workspaceId, 0, 'rollback'),
    ).rejects.toThrow('synthetic metadata write failure');
    update.mockRestore();
    expect(await db.models.DocumentWorkspaceRevision.countDocuments()).toBe(0);
    expect(
      (await db.models.File.collection.findOne({ file_id: 'rollback' }))?.retentionRevision,
    ).toBe(before?.retentionRevision);
    expect((await methods.getDocumentWorkspace(owner, workspace.workspaceId)).revision).toBe(0);
  });
  it('never reads or lists a head after native File revocation and rejects historical source access', async () => {
    const id = await firstVersion();
    await lifecycle.revokeFileSources(owner, ['version-one']);
    await expect(methods.getDocumentWorkspace(owner, id)).rejects.toMatchObject({
      code: 'source_unavailable',
    });
    await expect(methods.getDocumentWorkspaceVersionFile(owner, id, 1)).rejects.toMatchObject({
      code: 'source_unavailable',
    });
    expect((await methods.listDocumentWorkspaces(owner)).workspaces).toEqual([]);
  });
  it('keeps pagination bounded and callable without an implicit this binding', async () => {
    for (let index = 0; index < 21; index++) await draft();
    const { listDocumentWorkspaces } = methods;
    const first = await listDocumentWorkspaces(owner);
    expect(first.workspaces).toHaveLength(20);
    expect(first.nextCursor).toBeTruthy();
    const second = await listDocumentWorkspaces(owner, first.nextCursor!);
    expect(second.workspaces).toHaveLength(1);
    expect(
      new Set([...first.workspaces, ...second.workspaces].map((row) => row.workspaceId)).size,
    ).toBe(21);
  });
  it('enforces Workspace quota atomically across two concurrent factory instances', async () => {
    const limited = () =>
      createDocumentWorkspaceMethods(db, {
        securityPolicySha256: policy,
        now: () => at,
        maxWorkspaces: 1,
      });
    const results = await Promise.allSettled([
      limited().createDocumentWorkspace(owner),
      limited().createDocumentWorkspace(owner),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: 'quota_exceeded' }) }),
    ]);
    const stored = await db.models.DocumentWorkspace.collection.find({}).toArray();
    expect(stored).toHaveLength(1);
    const winner = results.find((result) => result.status === 'fulfilled');
    expect(stored[0]).toMatchObject({
      workspaceId: winner?.value.workspaceId,
      user: owner.userId,
      tenantId: owner.tenantId,
      revision: 0,
    });
    expect(await db.models.DocumentWorkspaceRevision.countDocuments()).toBe(0);
  });

  it('keeps Workspace quota independent for a second real owner in the same tenant', async () => {
    const limited = createDocumentWorkspaceMethods(db, {
      securityPolicySha256: policy,
      now: () => at,
      maxWorkspaces: 1,
    });
    const other = { ...owner, userId: new mongoose.Types.ObjectId().toString() };
    await db.models.User.create({
      _id: other.userId,
      tenantId: other.tenantId,
      email: 'quota-owner@example.test',
      emailVerified: true,
    });
    await limited.createDocumentWorkspace(owner);
    await expect(limited.createDocumentWorkspace(owner)).rejects.toMatchObject({
      code: 'quota_exceeded',
    });

    await expect(limited.createDocumentWorkspace(other)).resolves.toMatchObject({ revision: 0 });
    await expect(limited.createDocumentWorkspace(other)).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    for (const target of [owner, other]) {
      expect(
        await db.models.DocumentWorkspace.countDocuments({
          user: target.userId,
          tenantId: target.tenantId,
        }),
      ).toBe(1);
    }
    expect(await db.models.DocumentWorkspace.countDocuments()).toBe(2);
  });

  it('rejects create, reads, intents and commits after the real native account deletion fence', async () => {
    const id = await firstVersion();
    const fence = new Date(at);
    expect(await createUserMethods(db).beginAgentTriggerUserDeletion(owner.userId, fence)).toBe(
      'acquired',
    );
    for (const action of [
      () => draft(),
      () => methods.listDocumentWorkspaces(owner),
      () => methods.getDocumentWorkspace(owner, id),
      () => methods.getDocumentWorkspaceSaveIntent(owner, id, 1),
      () => methods.getDocumentWorkspaceVersionFile(owner, id, 1),
      () => methods.commitDocumentWorkspaceVersion(owner, id, 0, 'version-one'),
    ]) {
      await expect(action()).rejects.toMatchObject({ code: 'not_found' });
    }
    expect(await db.models.DocumentWorkspace.countDocuments()).toBe(1);
    expect(await db.models.DocumentWorkspaceRevision.countDocuments()).toBe(1);
  });
  it('rejects a disabled or physically deleted principal and preserves the native auth version', async () => {
    const before = await db.models.User.findById(owner.userId).lean<{
      authVersion?: number;
      updatedAt?: Date;
    }>();
    await draft();
    const after = await db.models.User.findById(owner.userId).lean<{
      authVersion?: number;
      updatedAt?: Date;
    }>();
    expect(after?.authVersion).toBe(before?.authVersion);
    expect(after?.updatedAt).toEqual(before?.updatedAt);
    await db.models.User.updateOne({ _id: owner.userId }, { $set: { authDisabled: true } });
    await expect(draft()).rejects.toMatchObject({ code: 'not_found' });
    await db.models.User.deleteOne({ _id: owner.userId });
    await expect(draft()).rejects.toMatchObject({ code: 'not_found' });
    expect(await db.models.DocumentWorkspace.countDocuments()).toBe(1);
  });

  it('purges both metadata collections only for the fenced owner and safely repeats while the native fence remains active', async () => {
    const ownId = await firstVersion();
    const foreignScopes = [
      { ...owner, userId: new mongoose.Types.ObjectId().toString() },
      { userId: new mongoose.Types.ObjectId().toString(), tenantId: 'foreign-tenant' },
    ];
    for (const [index, target] of foreignScopes.entries()) {
      await db.models.User.create({
        _id: target.userId,
        tenantId: target.tenantId,
        email: `foreign-${index}@example.test`,
        emailVerified: true,
      });
      await firstVersion(`foreign-version-${index}`, target);
    }
    const foreignBefore = await Promise.all(
      ['DocumentWorkspace', 'DocumentWorkspaceRevision'].map((name) =>
        db.models[name].collection
          .find({ workspaceId: { $ne: ownId } })
          .sort({ workspaceId: 1 })
          .toArray(),
      ),
    );
    const users = createUserMethods(db);
    const fence = new Date(at);
    expect(await users.beginAgentTriggerUserDeletion(owner.userId, fence)).toBe('acquired');

    await expect(methods.deleteAccountDocumentWorkspaces(owner, fence)).resolves.toBeUndefined();
    for (const [index, name] of ['DocumentWorkspace', 'DocumentWorkspaceRevision'].entries()) {
      expect(await db.models[name].countDocuments({ workspaceId: ownId })).toBe(0);
      expect(await db.models[name].collection.find({}).sort({ workspaceId: 1 }).toArray()).toEqual(
        foreignBefore[index],
      );
    }
    await expect(methods.deleteAccountDocumentWorkspaces(owner, fence)).resolves.toBeUndefined();
    expect(await db.models.User.countDocuments()).toBe(3);
    // Content deletion remains at the File owner and is confirmed by the account controller.
    expect(await db.models.File.countDocuments()).toBe(3);
    expect(await users.cancelAgentTriggerUserDeletion(owner.userId, fence)).toBe(true);
    await expect(methods.deleteAccountDocumentWorkspaces(owner, fence)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it.each(['foreign owner', 'foreign tenant', 'stale marker', 'missing marker'])(
    'refuses metadata purge with %s without changing either collection',
    async (reason) => {
      await firstVersion();
      const metadata = ['DocumentWorkspace', 'DocumentWorkspaceRevision'];
      const before = await Promise.all(
        metadata.map((name) => db.models[name].collection.find({}).toArray()),
      );
      const fence = new Date(at);
      if (reason !== 'missing marker') {
        expect(await createUserMethods(db).beginAgentTriggerUserDeletion(owner.userId, fence)).toBe(
          'acquired',
        );
      }
      const foreign = { ...owner, userId: new mongoose.Types.ObjectId().toString() };
      if (reason === 'foreign owner') {
        await db.models.User.create({
          _id: foreign.userId,
          tenantId: foreign.tenantId,
          email: 'other-owner@example.test',
          emailVerified: true,
        });
      }
      let target = owner;
      if (reason === 'foreign owner') target = foreign;
      else if (reason === 'foreign tenant') target = { ...owner, tenantId: 'foreign-tenant' };
      const suppliedFence = reason === 'stale marker' ? new Date(at - 1) : fence;

      await expect(
        methods.deleteAccountDocumentWorkspaces(target, suppliedFence),
      ).rejects.toMatchObject({
        code: 'not_found',
      });

      for (const [index, name] of metadata.entries()) {
        expect(await db.models[name].collection.find({}).toArray()).toEqual(before[index]);
      }
      expect(await db.models.File.countDocuments()).toBe(1);
    },
  );

  it('rolls back the actual revision deletion and User touch when the second metadata deletion fails', async () => {
    await firstVersion();
    const fence = new Date(at);
    expect(await createUserMethods(db).beginAgentTriggerUserDeletion(owner.userId, fence)).toBe(
      'acquired',
    );
    const metadata = ['DocumentWorkspace', 'DocumentWorkspaceRevision'];
    const before = await Promise.all(
      metadata.map((name) => db.models[name].collection.find({}).toArray()),
    );
    const principalBefore = await db.models.User.collection.findOne({
      _id: new mongoose.Types.ObjectId(owner.userId),
    });
    const originalDelete = db.models.DocumentWorkspace.deleteMany.bind(db.models.DocumentWorkspace);
    const secondDelete = jest
      .spyOn(db.models.DocumentWorkspace, 'deleteMany')
      .mockImplementationOnce(
        (filter: Parameters<typeof originalDelete>[0], options?: { session?: ClientSession }) => {
          const query = originalDelete(filter, options);
          jest.spyOn(query, 'exec').mockImplementationOnce(async () => {
            expect(options?.session?.inTransaction()).toBe(true);
            expect(
              await db.models.DocumentWorkspaceRevision.countDocuments({}).session(
                options!.session!,
              ),
            ).toBe(0);
            expect(await db.models.DocumentWorkspaceRevision.countDocuments({})).toBe(1);
            throw new Error('synthetic second metadata deletion failure');
          });
          return query;
        },
      );
    try {
      await expect(methods.deleteAccountDocumentWorkspaces(owner, fence)).rejects.toThrow(
        'synthetic second metadata deletion failure',
      );
      expect(secondDelete).toHaveBeenCalledTimes(1);
    } finally {
      secondDelete.mockRestore();
    }

    for (const [index, name] of metadata.entries()) {
      expect(await db.models[name].collection.find({}).toArray()).toEqual(before[index]);
    }
    expect(
      await db.models.User.collection.findOne({ _id: new mongoose.Types.ObjectId(owner.userId) }),
    ).toEqual(principalBefore);
    await expect(methods.deleteAccountDocumentWorkspaces(owner, fence)).resolves.toBeUndefined();
    expect(await db.models.DocumentWorkspace.countDocuments()).toBe(0);
    expect(await db.models.DocumentWorkspaceRevision.countDocuments()).toBe(0);
  });
});
