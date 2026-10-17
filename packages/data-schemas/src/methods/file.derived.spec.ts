/** Real Mongo/File lifecycle evidence. Scanner and storage acknowledgements are synthetic fixtures. */
import mongoose from 'mongoose';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  FileContext,
  UPLOAD_RETENTION_MS,
  UPLOAD_DERIVED_MAX_DESCENDANTS,
  uploadDerivedExpiresAt,
} from 'librechat-data-provider';
import type { UploadDerivedIntent, UploadDerivedOrigin } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { ManagedUploadAcceptance } from './fileRetention';
import {
  createFileRetentionMethods,
  FileSourceUnavailableError,
  resolveFileSources,
  resizeRetainedDerivatives,
} from './fileRetention';
import { createUploadStore } from './uploadManagementStore';
import { tenantStorage } from '~/config/tenantContext';
import { createFileMethods } from './file';
import { createModels } from '~/models';

describe('private derived File lifecycle using actual Mongo transactions', () => {
  const db = new mongoose.Mongoose();
  let mongo: MongoMemoryReplSet;
  let directory: string;
  let lifecycle: ReturnType<typeof createFileRetentionMethods>;
  let files: ReturnType<typeof createFileMethods>;
  const policy = 'c'.repeat(64);
  const now = Date.now();
  const text = 'Synthetic approved UTF-8 source.\n';
  const bytes = Buffer.from(text);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const owner = { tenantId: 'tenant-a', userId: new mongoose.Types.ObjectId().toString() };
  const previous = {
    UPLOAD_SECURITY_POLICY_SHA256: process.env.UPLOAD_SECURITY_POLICY_SHA256,
    CORTEX_UPLOAD_MANAGEMENT_ENABLED: process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED,
  };

  function acceptance(
    id: string,
    origin?: UploadDerivedOrigin,
    acceptedAt = now,
  ): ManagedUploadAcceptance {
    return {
      principal: { ...owner, authentication: 'verified-email' },
      operationId: id,
      filename: `synthetic-${id}.txt`,
      mediaType: 'text/plain',
      transferGeneration: 1,
      acceptedAt,
      expiresAt: uploadDerivedExpiresAt(acceptedAt, origin),
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
        scannerVersion: 'explicit-synthetic-scanner/v1',
        checkedAt: new Date(acceptedAt).toISOString(),
        coverage: { complete: true, pages: 1, parts: 1 },
      },
    };
  }
  const intent = (ids: string[]): UploadDerivedIntent => ({
    binding: { purpose: 'workspace-draft', sourceId: 'workspace-fixture', sourceRevision: 0 },
    directSourceFileIds: ids,
  });
  async function transaction<T>(action: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await db.startSession();
    let result!: T;
    try {
      await session.withTransaction(async () => {
        result = await action(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }
  const capture = (ids: string[], scope = owner) =>
    transaction((session) =>
      lifecycle.captureManagedUploadOrigin(scope, intent(ids), now, session),
    );
  const raw = (id: string) => db.models.File.collection.findOne({ file_id: id });
  const filter = (id: string) => ({ file_id: id, user: owner.userId, tenantId: owner.tenantId });
  function barrier() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }
  async function ready(input: ManagedUploadAcceptance): Promise<void> {
    await transaction(async (session) => {
      await lifecycle.acceptManagedUpload(input, session);
      await lifecycle.claimManagedUploadProcessing(owner, input.operationId, 7, now, session);
      await lifecycle.publishManagedUpload(
        owner,
        input.operationId,
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
  async function derived(id: string, sources: string[]): Promise<UploadDerivedOrigin> {
    const origin = await capture(sources);
    await ready(acceptance(id, origin));
    return origin;
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'derived-file-'));
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
    await db.connect(mongo.getUri('derived-file'), { serverSelectionTimeoutMS: 5000 });
    createModels(db);
    await Promise.all([db.models.File.init(), db.models.Message.init()]);
    files = createFileMethods(db);
    lifecycle = createFileRetentionMethods(db, { securityPolicySha256: policy });
  });
  beforeEach(async () => {
    process.env.UPLOAD_SECURITY_POLICY_SHA256 = policy;
    process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = 'true';
    await db.models.File.deleteMany({});
    if (db.models.UploadCounter) await db.models.UploadCounter.deleteMany({});
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

  it('captures actual immutable source identity and inherits its earlier deadline', async () => {
    const root = acceptance('root', undefined, now - 10_000);
    await ready(root);
    const before = await raw('root');
    const origin = await capture(['root']);
    expect(origin).toEqual({
      version: 1,
      binding: intent([]).binding,
      directSourceFileIds: ['root'],
      ancestors: [
        { subject: root.securityApproval.subject, policySha256: policy, expiresAt: root.expiresAt },
      ],
    });
    expect((await raw('root'))!.retentionRevision).toBeGreaterThan(before!.retentionRevision);
    await ready(acceptance('child', origin));
    expect((await raw('child'))!.expiredAt).toEqual(new Date(root.expiresAt));
    expect((await raw('child'))!.retentionAcceptedAt).toEqual(new Date(now));
    origin.ancestors[0].subject.sha256 = 'a'.repeat(64);
    expect((await raw('child'))!.derivedOrigin.ancestors[0].subject.sha256).toBe(sha256);
  });

  it('flattens a chain and diamond without losing a shared ancestor or duplicating it', async () => {
    await ready(acceptance('root'));
    await derived('left', ['root']);
    await derived('right', ['root']);
    const diamond = await derived('head', ['right', 'left']);
    expect(diamond.directSourceFileIds).toEqual(['left', 'right']);
    expect(diamond.ancestors.map((source) => source.subject.operationId)).toEqual([
      'left',
      'right',
      'root',
    ]);
    expect((await capture(['head'])).ancestors.map((source) => source.subject.operationId)).toEqual(
      ['head', 'left', 'right', 'root'],
    );
  });

  it.each(['owner', 'tenant'] as const)('refuses a foreign %s source scope', async (kind) => {
    await ready(acceptance('root'));
    const foreign =
      kind === 'owner'
        ? { ...owner, userId: new mongoose.Types.ObjectId().toString() }
        : { ...owner, tenantId: 'tenant-b' };
    await expect(capture(['root'], foreign)).rejects.toBeInstanceOf(FileSourceUnavailableError);
  });

  it.each([
    ['missing proof', { securityApproval: null }],
    ['stale policy', { 'securityApproval.policySha256': 'd'.repeat(64) }],
    [
      'foreign proof owner',
      { 'securityApproval.subject.userId': new mongoose.Types.ObjectId().toString() },
    ],
    ['wrong proof operation', { 'securityApproval.subject.operationId': 'another-source' }],
    ['wrong proof bytes', { 'securityApproval.subject.bytes': bytes.length + 1 }],
    ['expired', { expiredAt: new Date(now - 1) }],
    ['revoked', { deletionRequestedAt: new Date(now) }],
    ['not ready', { status: 'pending' }],
  ])('refuses actual source corruption: %s', async (_label, change) => {
    await ready(acceptance('root'));
    await db.models.File.collection.updateOne({ file_id: 'root' }, { $set: change });
    await expect(capture(['root'])).rejects.toBeInstanceOf(FileSourceUnavailableError);
    expect(await raw('child')).toBeNull();
  });

  it('refuses a missing source instead of capturing a smaller lineage', async () => {
    await ready(acceptance('root'));
    await expect(capture(['root', 'missing'])).rejects.toBeInstanceOf(FileSourceUnavailableError);
  });

  it('rechecks captured source identity at acceptance, even if the replacement proof is well shaped', async () => {
    await ready(acceptance('root'));
    const origin = await capture(['root']);
    await db.models.File.collection.updateOne(
      { file_id: 'root' },
      {
        $set: { 'securityApproval.subject.sha256': 'b'.repeat(64) },
      },
    );
    await expect(
      transaction((session) => lifecycle.acceptManagedUpload(acceptance('child', origin), session)),
    ).rejects.toBeInstanceOf(FileSourceUnavailableError);
    expect(await raw('child')).toBeNull();
  });

  it('rejects malformed stored lineage and a self-cycle rather than silently treating either as a root', async () => {
    await ready(acceptance('root'));
    await derived('child', ['root']);
    const valid = (await raw('child'))!.derivedOrigin;
    for (const corrupted of [
      { ...valid, ancestors: [] },
      {
        ...valid,
        ancestors: [
          ...valid.ancestors,
          { ...valid.ancestors[0], subject: acceptance('child').securityApproval.subject },
        ],
      },
    ]) {
      await db.models.File.collection.updateOne(
        { file_id: 'child' },
        { $set: { derivedOrigin: corrupted } },
      );
      await expect(capture(['child'])).rejects.toBeInstanceOf(FileSourceUnavailableError);
    }
  });

  it.each(['parent proof', 'extended deadline'] as const)(
    'refuses derived acceptance with %s',
    async (invalid) => {
      const root = acceptance('root', undefined, now - 10_000);
      await ready(root);
      const origin = await capture(['root']);
      const child = acceptance('child', origin);
      if (invalid === 'parent proof') child.securityApproval = root.securityApproval;
      else child.expiresAt = now + UPLOAD_RETENTION_MS;
      await expect(
        transaction((session) => lifecycle.acceptManagedUpload(child, session)),
      ).rejects.toBeInstanceOf(FileSourceUnavailableError);
      expect(await raw('child')).toBeNull();
    },
  );

  it('snapshots private origin before acceptance yields to Mongo', async () => {
    await ready(acceptance('root'));
    const origin = await capture(['root']);
    const expected = JSON.parse(JSON.stringify(origin));
    const child = acceptance('child', origin);
    await transaction(async (session) => {
      const pending = lifecycle.acceptManagedUpload(child, session);
      origin.binding.sourceId = 'changed-after-call';
      origin.ancestors[0].subject.sha256 = 'e'.repeat(64);
      await pending;
    });
    expect((await raw('child'))!.derivedOrigin).toEqual(expected);
  });

  it('keeps lineage private and excludes derived files from every ordinary File consumer', async () => {
    await ready(acceptance('root'));
    const origin = await derived('child', ['root']);
    expect(await db.models.File.findOne({ file_id: 'child' }).lean()).not.toHaveProperty(
      'derivedOrigin',
    );
    const privateRow = await db.models.File.findOne({ file_id: 'child' }).select('+derivedOrigin');
    expect(privateRow!.get('derivedOrigin')).toEqual(origin);
    expect(privateRow!.toJSON()).not.toHaveProperty('derivedOrigin');
    expect(privateRow!.toObject()).not.toHaveProperty('derivedOrigin');
    expect(await files.findFileById('child', filter('child'))).toBeNull();
    expect(await files.getFiles(filter('child'), {}, {})).toEqual([]);
    expect(
      await files.getProjectFiles({ ...owner, fileIds: ['child'], includeContent: true }),
    ).toEqual([]);
    expect(await files.getAvailableProjectFiles({ ...owner, search: 'synthetic-child' })).toEqual({
      files: [],
      nextCursor: null,
    });
    expect(await files.getRunFileCandidates(['child'], owner.tenantId)).toEqual([]);
    await expect(resolveFileSources(db, owner, ['child'])).rejects.toBeInstanceOf(
      FileSourceUnavailableError,
    );
    expect(
      (await files.getAvailableProjectFiles({ ...owner, limit: 1 })).files.map(
        (file) => file.file_id,
      ),
    ).toEqual(['root']);
    expect((await capture(['child'])).directSourceFileIds).toEqual(['child']);
  });

  it('strips top-level and dotted origin forgery from generic create/update', async () => {
    await ready(acceptance('root'));
    const origin = await capture(['root']);
    await tenantStorage.run(owner, () =>
      files.createFile(
        {
          file_id: 'generic',
          user: new mongoose.Types.ObjectId(owner.userId),
          tenantId: owner.tenantId,
          filename: 'synthetic-generic.txt',
          filepath: '/uploads/generic',
          source: 'local',
          type: 'text/plain',
          bytes: bytes.length,
          context: FileContext.message_attachment,
          derivedOrigin: origin,
          'derivedOrigin.binding.sourceId': 'forged-workspace',
        } as Parameters<typeof files.createFile>[0],
        true,
      ),
    );
    expect(await raw('generic')).not.toHaveProperty('derivedOrigin');
    await files.updateFile({
      file_id: 'root',
      derivedOrigin: origin,
      'derivedOrigin.binding.sourceId': 'forged-workspace',
    } as Parameters<typeof files.updateFile>[0]);
    expect(await raw('root')).not.toHaveProperty('derivedOrigin');
  });

  it('forbids generic managed deadline changes while retaining unmanaged execute_code semantics', async () => {
    await ready(acceptance('root'));
    await expect(
      files.updateFile({ file_id: 'root', expiredAt: new Date(now + 1000) }),
    ).rejects.toBeInstanceOf(FileSourceUnavailableError);
    expect((await raw('root'))!.expiredAt).toEqual(new Date(now + UPLOAD_RETENTION_MS));
    process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = 'false';
    await tenantStorage.run(owner, () =>
      files.createFile(
        {
          file_id: 'code',
          user: new mongoose.Types.ObjectId(owner.userId),
          tenantId: owner.tenantId,
          filename: 'output.txt',
          filepath: '/uploads/code',
          source: 'local',
          type: 'text/plain',
          bytes: bytes.length,
          context: FileContext.execute_code,
        },
        true,
      ),
    );
    await files.updateFile({ file_id: 'code', expiredAt: new Date(now + 1000) });
    expect((await raw('code'))!.expiredAt).toEqual(new Date(now + 1000));
  });

  it('accept-first: an already-open stale revoke transaction retries and includes the committed child', async () => {
    await ready(acceptance('root'));
    const origin = await capture(['root']);
    const snapshot = barrier();
    const proceed = barrier();
    const revoking = transaction(async (session) => {
      await db.models.File.findOne({ file_id: 'root' }).session(session).lean();
      snapshot.release();
      await proceed.promise;
      return lifecycle.revokeManagedUpload(owner, 'root', now, session);
    });
    try {
      await snapshot.promise;
      await transaction((session) =>
        lifecycle.acceptManagedUpload(acceptance('child', origin), session),
      );
    } finally {
      proceed.release();
    }
    expect((await revoking).revokedFileIds.sort()).toEqual(['child', 'root']);
    expect((await raw('child'))!.deletionRequestedAt).toEqual(new Date(now));
  });

  it('revoke-first: acceptance with an already-open old snapshot cannot publish a child', async () => {
    await ready(acceptance('root'));
    const origin = await capture(['root']);
    const snapshot = barrier();
    const proceed = barrier();
    const outcome = Promise.allSettled([
      transaction(async (session) => {
        await db.models.File.findOne({ file_id: 'root' }).session(session).lean();
        snapshot.release();
        await proceed.promise;
        await lifecycle.acceptManagedUpload(acceptance('child', origin), session);
      }),
    ]);
    try {
      await snapshot.promise;
      expect((await lifecycle.revokeFileSources(owner, ['root'])).revokedFileIds).toEqual(['root']);
    } finally {
      proceed.release();
    }
    const [result] = await outcome;
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected')
      expect(result.reason).toBeInstanceOf(FileSourceUnavailableError);
    expect(await raw('child')).toBeNull();
  });

  it('allows only one of two real transactions competing for the last descendant slot', async () => {
    await ready(acceptance('root'));
    const origin = await capture(['root']);
    await transaction(async (session) => {
      for (let index = 0; index < UPLOAD_DERIVED_MAX_DESCENDANTS - 1; index++) {
        await lifecycle.acceptManagedUpload(acceptance(`seed-${index}`, origin), session);
      }
    });
    const snapshots = [barrier(), barrier()];
    const proceed = barrier();
    const outcomes = Promise.allSettled(
      snapshots.map((snapshot, index) =>
        transaction(async (session) => {
          await db.models.File.findOne({ file_id: 'root' }).session(session).lean();
          snapshot.release();
          await proceed.promise;
          await lifecycle.acceptManagedUpload(acceptance(`racer-${index}`, origin), session);
        }),
      ),
    );
    try {
      await Promise.all(snapshots.map((snapshot) => snapshot.promise));
    } finally {
      proceed.release();
    }
    const results = await outcomes;
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected!.status === 'rejected' && rejected!.reason).toBeInstanceOf(
      FileSourceUnavailableError,
    );
    expect(
      await db.models.File.countDocuments({
        'derivedOrigin.ancestors.subject.operationId': 'root',
        deletionCompletedAt: null,
      }),
    ).toBe(UPLOAD_DERIVED_MAX_DESCENDANTS);
  }, 30_000);

  it('fences processing after cascade without resetting or reviving the old generation', async () => {
    await ready(acceptance('root'));
    const origin = await capture(['root']);
    await transaction(async (session) => {
      await lifecycle.acceptManagedUpload(acceptance('child', origin), session);
      await lifecycle.claimManagedUploadProcessing(owner, 'child', 7, now, session);
    });
    await transaction((session) =>
      lifecycle.assertManagedUploadProcessing(owner, 'child', 7, now, session),
    );
    await expect(
      transaction((session) =>
        lifecycle.assertManagedUploadProcessing(owner, 'child', 8, now, session),
      ),
    ).rejects.toBeInstanceOf(FileSourceUnavailableError);
    expect((await raw('child'))!.previewRevision).toBe('7');
    await lifecycle.revokeFileSources(owner, ['root']);
    await expect(
      transaction((session) =>
        lifecycle.assertManagedUploadProcessing(owner, 'child', 7, now, session),
      ),
    ).rejects.toBeInstanceOf(FileSourceUnavailableError);
    expect((await raw('child'))!.previewRevision).toBe('7');
  });

  it('preserves unfinished child lineage across preparation and unknown Upload completion, without double debit', async () => {
    await createUploadStore(db, {
      enabled: true,
      reconciled: true,
      baseline: { textBytes: 512 },
    }).initialize();
    await ready(acceptance('root'));
    const origin = await derived('child', ['root']);
    // Synthetic retained-copy liability, charged through the actual shared accounting owner.
    await transaction((session) =>
      resizeRetainedDerivatives(db, owner, [], [{ fileId: 'child', bytes: 2048 }], session),
    );
    const total = async () =>
      (await db.models.UploadCounter.findById('global').lean<{ value: { textBytes: number } }>())!
        .value.textBytes;
    expect(await total()).toBe(2560);
    await lifecycle.revokeFileSources(owner, ['root']);
    expect(await lifecycle.prepareFileSourceDeletion(owner, ['root'])).toEqual({
      preparedFileIds: [],
    });
    expect(await lifecycle.prepareFileSourceDeletion(owner, ['child'])).toEqual({
      preparedFileIds: ['child'],
    });
    const prepared = await raw('child');
    expect(prepared).toMatchObject({
      derivedOrigin: origin,
      uploadOperationId: 'child',
      retainedDerivativeBytes: 0,
    });
    expect(prepared).not.toHaveProperty('text');
    expect(prepared).not.toHaveProperty('securityApproval');
    expect(prepared!.deletionCompletedAt).toBeFalsy();
    expect(await total()).toBe(512);
    // Unknown external Uploadfinish acknowledgement: deliberately do not finalize the child.
    const freshSweep = createFileRetentionMethods(db, { securityPolicySha256: policy });
    expect((await freshSweep.revokeFileSources(owner, ['root'])).revokedFileIds.sort()).toEqual([
      'child',
      'root',
    ]);
    expect(await freshSweep.finalizeFileSourceDeletion(owner, ['root'])).toEqual({
      completedFileIds: [],
    });
    expect(await freshSweep.prepareFileSourceDeletion(owner, ['child'])).toEqual({
      preparedFileIds: ['child'],
    });
    expect(await total()).toBe(512);
    expect(await freshSweep.finalizeFileSourceDeletion(owner, ['child'])).toEqual({
      completedFileIds: ['child'],
    });
    expect(await freshSweep.finalizeFileSourceDeletion(owner, ['root'])).toEqual({
      completedFileIds: ['root'],
    });
    expect(await total()).toBe(512);
  });

  it('keeps a parent and its locator unresolved until every child is finalized', async () => {
    await ready(acceptance('root'));
    await derived('child', ['root']);
    const result = await lifecycle.revokeFileSources(owner, ['root']);
    expect(result.revokedFileIds.sort()).toEqual(['child', 'root']);
    expect(await lifecycle.finalizeFileSourceDeletion(owner, ['root'])).toEqual({
      completedFileIds: [],
    });
    expect(await raw('root')).toMatchObject({ storageKey: acceptance('root').receipt.storageKey });
    expect((await raw('root'))!.deletionCompletedAt).toBeFalsy();
    // Only exercises File finalization after a synthetic cleanup acknowledgement, not S3 deletion.
    expect(await lifecycle.finalizeFileSourceDeletion(owner, ['root', 'child'])).toEqual({
      completedFileIds: ['child', 'root'],
    });
    expect((await raw('root'))!.deletionCompletedAt).toBeInstanceOf(Date);
    expect((await lifecycle.revokeFileSources(owner, ['root'])).revokedFileIds).toContain('root');
  });
});
