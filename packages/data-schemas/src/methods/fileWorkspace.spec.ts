/** Real File/Mongo fences; scanner and original-storage acknowledgements are synthetic fixtures. */
import mongoose from 'mongoose';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { uploadDerivedExpiresAt } from 'librechat-data-provider';
import type { UploadDerivedOrigin } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { ManagedUploadAcceptance } from '~/types/file';
import { createFileWorkspaceMethods } from './fileWorkspace';
import { createFileRetentionMethods, FileSourceUnavailableError } from './fileRetention';
import { createFileMethods } from './file';
import { createModels } from '~/models';
import { tenantStorage } from '~/config/tenantContext';

describe('Workspace File access through the actual retained File authority', () => {
  const db = new mongoose.Mongoose();
  let mongo: MongoMemoryReplSet;
  let directory: string;
  let lifecycle: ReturnType<typeof createFileRetentionMethods>;
  let workspace: ReturnType<typeof createFileWorkspaceMethods>;
  const policy = 'c'.repeat(64);
  const now = Date.now();
  const text = 'Synthetic approved Workspace source.\n';
  const bytes = Buffer.from(text);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const owner = { tenantId: 'tenant-a', userId: new mongoose.Types.ObjectId().toString() };
  const binding = {
    purpose: 'workspace-draft' as const,
    sourceId: 'workspace-a',
    sourceRevision: 0,
  };
  const reference = (fileId = 'draft') => ({ fileId, binding: { ...binding } });
  const previous = {
    UPLOAD_SECURITY_POLICY_SHA256: process.env.UPLOAD_SECURITY_POLICY_SHA256,
    CORTEX_UPLOAD_MANAGEMENT_ENABLED: process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED,
  };

  const raw = (id: string) => db.models.File.collection.findOne({ file_id: id });
  async function transaction<T>(action: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await db.startSession();
    try {
      return await session.withTransaction(() => action(session));
    } finally {
      await session.endSession();
    }
  }
  function barrier() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }
  function acceptance(id: string, origin?: UploadDerivedOrigin): ManagedUploadAcceptance {
    return {
      principal: { ...owner, authentication: 'verified-email' },
      operationId: id,
      filename: `synthetic-${id}.txt`,
      mediaType: 'text/plain',
      transferGeneration: 1,
      acceptedAt: now,
      expiresAt: uploadDerivedExpiresAt(now, origin),
      ...(origin ? { derivedOrigin: origin } : {}),
      receipt: {
        outcome: 'durable',
        bytes: bytes.length,
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
          bytes: bytes.length,
          sha256,
        },
        scannerVersion: 'synthetic-scanner/v1',
        checkedAt: new Date(now).toISOString(),
        coverage: { complete: true, pages: 1, parts: 1 },
      },
    };
  }
  async function ready(id: string, origin?: UploadDerivedOrigin) {
    await transaction(async (session) => {
      await lifecycle.acceptManagedUpload(acceptance(id, origin), session);
      await lifecycle.claimManagedUploadProcessing(owner, id, 7, now, session);
      await lifecycle.publishManagedUpload(
        owner,
        id,
        7,
        {
          text,
          structure: {
            version: 1,
            source: { sha256, bytes: bytes.length, mediaType: 'text/plain' },
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
  }
  async function draft(sourceIds = ['source'], id = 'draft') {
    const origin = await transaction((session) =>
      lifecycle.captureManagedUploadOrigin(
        owner,
        { binding, directSourceFileIds: sourceIds },
        now,
        session,
      ),
    );
    await ready(id, origin);
    return origin;
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'workspace-file-'));
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
    await db.connect(mongo.getUri('workspace-file'), { serverSelectionTimeoutMS: 5000 });
    createModels(db);
    await db.models.File.init();
    lifecycle = createFileRetentionMethods(db, { securityPolicySha256: policy });
    workspace = createFileWorkspaceMethods(db, { securityPolicySha256: policy });
  });
  beforeEach(async () => {
    process.env.UPLOAD_SECURITY_POLICY_SHA256 = policy;
    process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = 'true';
    await db.models.File.deleteMany({});
    if (db.models.UploadCounter) await db.models.UploadCounter.deleteMany({});
    await db.connection.collection('workspace_commit_fixture').deleteMany({});
  });
  afterEach(() => {
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

  it('reads only the exact private revision and leaves ordinary File consumers closed', async () => {
    await ready('source');
    const origin = await draft();
    const before = await raw('draft');
    const sourceBefore = await raw('source');
    const result = await workspace.getWorkspaceFile(owner, reference(), now);
    expect(result).toMatchObject({
      file_id: 'draft',
      user: owner.userId,
      tenantId: owner.tenantId,
      derivedOrigin: origin,
      securityApproval: acceptance('draft').securityApproval,
    });
    expect(result).not.toHaveProperty('text');
    expect(result).not.toHaveProperty('documentStructure');
    expect((await raw('draft'))!.retentionRevision).toBeGreaterThan(before!.retentionRevision);
    expect((await raw('source'))!.retentionRevision).toBeGreaterThan(
      sourceBefore!.retentionRevision,
    );
    const files = createFileMethods(db);
    expect(
      await files.getFiles({ file_id: 'draft', user: owner.userId, tenantId: owner.tenantId }),
    ).toEqual([]);
    expect(await lifecycle.getManagedUploadAvailability(owner, ['draft'], now)).toEqual([]);
    result.derivedOrigin.binding.sourceId = 'mutated';
    expect((await raw('draft'))!.derivedOrigin.binding.sourceId).toBe(binding.sourceId);
  });

  it('supports a genuinely source-free approved draft without inventing a File source', async () => {
    await draft([]);
    expect(
      (await workspace.getWorkspaceFile(owner, reference(), now)).derivedOrigin.ancestors,
    ).toEqual([]);
  });

  it.each(['owner', 'tenant', 'workspace', 'revision', 'ordinary'] as const)(
    'rejects a foreign %s binding',
    async (kind) => {
      await ready('source');
      await draft();
      const requestedOwner = { ...owner };
      const requested = reference();
      if (kind === 'owner') requestedOwner.userId = new mongoose.Types.ObjectId().toString();
      if (kind === 'tenant') requestedOwner.tenantId = 'tenant-b';
      if (kind === 'workspace') requested.binding.sourceId = 'workspace-b';
      if (kind === 'revision') requested.binding.sourceRevision = 1;
      if (kind === 'ordinary') requested.fileId = 'source';
      await expect(
        workspace.getWorkspaceFile(requestedOwner, requested, now),
      ).rejects.toBeInstanceOf(FileSourceUnavailableError);
    },
  );

  it.each([
    ['pending', { status: 'pending' }],
    ['unprocessed', { embedded: false }],
    ['expired', { expiredAt: new Date(now) }],
    ['revoked', { deletionRequestedAt: new Date(now) }],
    ['completed', { deletionCompletedAt: new Date(now) }],
    ['policy', { 'securityApproval.policySha256': 'd'.repeat(64) }],
    ['origin', { 'derivedOrigin.ancestors.0.subject.sha256': 'd'.repeat(64) }],
    ['extended expiry', { expiredAt: new Date(now + 90 * 86400_000) }],
    ['different storage adapter', { source: 'local' }],
    ['non-native locator', { filepath: '/unrelated' }],
    ['oversized original', { bytes: 65_537, 'securityApproval.subject.bytes': 65_537 }],
  ])('rejects an unavailable or corrupt private source: %s', async (_label, change) => {
    await ready('source');
    await draft();
    await db.models.File.collection.updateOne({ file_id: 'draft' }, { $set: change });
    await expect(workspace.getWorkspaceFile(owner, reference(), now)).rejects.toBeInstanceOf(
      FileSourceUnavailableError,
    );
  });

  it('revalidates immutable ancestor identity even when the own File row remains ready', async () => {
    await ready('source');
    await draft();
    await db.models.File.collection.updateOne(
      { file_id: 'source' },
      { $set: { 'securityApproval.subject.sha256': 'd'.repeat(64) } },
    );
    await expect(workspace.getWorkspaceFile(owner, reference(), now)).rejects.toBeInstanceOf(
      FileSourceUnavailableError,
    );
  });

  it('captures caller references before its first await', async () => {
    await draft([]);
    const requested = reference();
    const requestedOwner = { ...owner };
    const result = workspace.getWorkspaceFile(requestedOwner, requested, now);
    requested.fileId = 'other';
    requested.binding.sourceId = 'other';
    requestedOwner.userId = new mongoose.Types.ObjectId().toString();
    expect((await result).file_id).toBe('draft');
  });

  it('requires an active transaction and rolls back the File fence with the caller write', async () => {
    await draft([]);
    const session = await db.startSession();
    try {
      await expect(
        workspace.touchWorkspaceFile(owner, reference(), now, session),
      ).rejects.toBeInstanceOf(FileSourceUnavailableError);
    } finally {
      await session.endSession();
    }
    const before = await raw('draft');
    await expect(
      transaction(async (active) => {
        await workspace.touchWorkspaceFile(owner, reference(), now, active);
        await db.connection
          .collection('workspace_commit_fixture')
          .insertOne({ fileId: 'draft' }, { session: active });
        throw new Error('synthetic caller rollback');
      }),
    ).rejects.toThrow('synthetic caller rollback');
    expect((await raw('draft'))!.retentionRevision).toBe(before!.retentionRevision);
    expect(await db.connection.collection('workspace_commit_fixture').countDocuments()).toBe(0);
  });

  it('revoke-first: an old caller snapshot cannot commit a workspace head', async () => {
    await ready('source');
    await draft();
    const read = barrier();
    const proceed = barrier();
    const outcome = Promise.allSettled([
      transaction(async (session) => {
        await db.models.File.findOne({ file_id: 'draft' }).session(session).lean();
        read.release();
        await proceed.promise;
        await workspace.touchWorkspaceFile(owner, reference(), now, session);
        await db.connection
          .collection('workspace_commit_fixture')
          .insertOne({ fileId: 'draft' }, { session });
      }),
    ]);
    try {
      await read.promise;
      await lifecycle.revokeFileSources(owner, ['source']);
    } finally {
      proceed.release();
    }
    expect((await outcome)[0]).toMatchObject({
      status: 'rejected',
      reason: expect.any(FileSourceUnavailableError),
    });
    expect(await db.connection.collection('workspace_commit_fixture').countDocuments()).toBe(0);
  });

  it('commit-first: a stale revoker retries and subsequently makes the committed head unreadable', async () => {
    await ready('source');
    await draft();
    const read = barrier();
    const proceed = barrier();
    const revoking = transaction(async (session) => {
      await db.models.File.findOne({ file_id: 'source' }).session(session).lean();
      read.release();
      await proceed.promise;
      return lifecycle.revokeManagedUpload(owner, 'source', now, session);
    });
    try {
      await read.promise;
      await transaction(async (session) => {
        await workspace.touchWorkspaceFile(owner, reference(), now, session);
        await db.connection
          .collection('workspace_commit_fixture')
          .insertOne({ fileId: 'draft' }, { session });
      });
    } finally {
      proceed.release();
    }
    expect((await revoking).revokedFileIds.sort()).toEqual(['draft', 'source']);
    expect(await db.connection.collection('workspace_commit_fixture').countDocuments()).toBe(1);
    await expect(workspace.getWorkspaceFile(owner, reference(), now)).rejects.toBeInstanceOf(
      FileSourceUnavailableError,
    );
  });

  it('enumerates expired, revoked and pending private files for account cleanup without leaking their content', async () => {
    await ready('source');
    await draft();
    await draft([], 'expired');
    await draft([], 'pending');
    await draft([], 'finished');
    await db.models.File.collection.updateOne(
      { file_id: 'expired' },
      { $set: { expiredAt: new Date(now) } },
    );
    await db.models.File.collection.updateOne(
      { file_id: 'pending' },
      { $set: { status: 'pending' } },
    );
    await db.models.File.collection.updateOne(
      { file_id: 'finished' },
      { $set: { deletionCompletedAt: new Date(now) } },
    );
    await lifecycle.revokeFileSources(owner, ['source']);
    const foreign = {
      ...(await raw('draft'))!,
      _id: new mongoose.Types.ObjectId(),
      file_id: 'foreign',
      user: new mongoose.Types.ObjectId(),
    };
    const otherTenant = {
      ...foreign,
      _id: new mongoose.Types.ObjectId(),
      file_id: 'foreign-tenant',
      user: new mongoose.Types.ObjectId(owner.userId),
      tenantId: 'tenant-b',
    };
    await db.models.File.collection.insertMany([foreign, otherTenant]);
    const found = await workspace.getAccountFileCleanupCandidates(owner);
    expect(found.map((file) => file.file_id).sort()).toEqual([
      'draft',
      'expired',
      'pending',
      'source',
    ]);
    for (const file of found) {
      expect(file).not.toHaveProperty('text');
      expect(file).not.toHaveProperty('securityApproval');
      expect(file).not.toHaveProperty('derivedOrigin');
      expect(file).not.toHaveProperty('documentStructure');
    }
    await expect(
      tenantStorage.run({ tenantId: 'tenant-b' }, () =>
        workspace.getAccountFileCleanupCandidates(owner),
      ),
    ).rejects.toBeInstanceOf(FileSourceUnavailableError);
  });

  it('preserves existing Code cleanup routes while excluding unrelated metadata and tenant rows', async () => {
    const codeRef = {
      kind: 'user',
      id: owner.userId,
      storage_session_id: 'session-fixture',
      file_id: 'code-fixture',
      executionProfile: 'default',
    };
    const user = new mongoose.Types.ObjectId(owner.userId);
    const common = {
      user,
      source: 'code',
      filepath: '/code-fixture',
      bytes: 12,
      filename: 'synthetic.txt',
      type: 'text/plain',
      text: 'private source text',
    };
    await db.models.File.collection.insertMany([
      {
        ...common,
        file_id: 'code',
        tenantId: owner.tenantId,
        metadata: {
          codeEnvRef: codeRef,
          codeEnvRefs: { default: codeRef },
          sourceDispatchedAt: 1,
          unrelated: 'must not leave Mongo',
        },
      },
      { ...common, file_id: 'legacy-unscoped' },
      { ...common, file_id: 'explicit-null', tenantId: null },
    ]);
    const scoped = await workspace.getAccountFileCleanupCandidates(owner);
    expect(scoped.map((file) => file.file_id)).toEqual(['code']);
    expect(scoped[0]).toMatchObject({
      metadata: { codeEnvRef: codeRef, codeEnvRefs: { default: codeRef } },
    });
    expect(scoped[0]).not.toHaveProperty('text');
    expect(scoped[0]).not.toHaveProperty('metadata.unrelated');
    expect(scoped[0]).not.toHaveProperty('metadata.sourceDispatchedAt');
    const legacy = await workspace.getAccountFileCleanupCandidates({
      userId: owner.userId,
      tenantId: null,
    });
    expect(legacy.map((file) => file.file_id).sort()).toEqual(['explicit-null', 'legacy-unscoped']);
  });
});
