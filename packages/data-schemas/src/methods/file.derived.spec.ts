/** Real Mongo/File lifecycle evidence. Scanner and storage acknowledgements are synthetic fixtures. */
import mongoose from 'mongoose';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  FileContext,
  UPLOAD_RETENTION_MS,
  UPLOAD_DERIVED_MAX_DESCENDANTS,
  uploadReservationFingerprint,
} from 'librechat-data-provider';
import type { UploadDerivedIntent, UploadDerivedOrigin } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { FileCleanupProgressResult } from '../types/fileCleanup';
import type { ManagedUploadAcceptance } from '~/types/file';
import type { JobClaim } from '../types/housekeeping';
import {
  createFileRetentionMethods,
  FileSourceCapacityError,
  FileSourceUnavailableError,
  resolveFileSources,
  resizeRetainedDerivatives,
} from './fileRetention';
import { createFileCleanupLifecycleMethods } from './fileCleanupLifecycle';
import { createFileCleanupProgressMethods } from './fileCleanupProgress';
import { createUploadManagementRepository } from './uploadManagement';
import { managedFileRetrievalDeletionSettled } from './fileRetrieval';
import { createFileCleanupClaimMethods } from './fileCleanupClaim';
import { createUploadFileCleanupOwner } from './uploadFileCleanup';
import { createHousekeepingStore } from './housekeepingStore';
import { currentFileDeadline } from './fileSourceAuthority';
import { tenantStorage } from '~/config/tenantContext';
import { createMessageMethods } from './message';
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

describe('private derived File lifecycle using actual Mongo transactions', () => {
  const db = new mongoose.Mongoose();
  let mongo: MongoMemoryReplSet;
  let directory: string;
  let lifecycle: ReturnType<typeof createFileRetentionMethods>;
  let uploads: ReturnType<typeof createUploadManagementRepository>;
  const worker = { hostId: 'fixture-host', instanceId: 'fixture-app' };
  const DAY = 86400_000;
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
    const execution = {
      version: 2 as const,
      custody: { kind: 'none' as const },
      attemptId: `${id}.${transfer.generation}`,
      instanceId: '11111111-1111-4111-8111-111111111111',
      executionId: '22222222-2222-4222-8222-222222222222',
      expiresAt: new Date(now + 60_000).toISOString(),
    };
    await uploads.bindSecurityExecution(transfer, execution, now);
    await uploads.settleSecurityExecution(
      transfer,
      { execution, writerStopped: true, transientDataRemoved: true },
      now,
    );
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
  async function derived(id: string, sources: string[]): Promise<UploadDerivedOrigin> {
    const origin = await capture(sources);
    await ready(acceptance(id, origin));
    return origin;
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
    registerMongo('running');
    await db.connect(mongo.getUri('derived-file'), { serverSelectionTimeoutMS: 5000 });
    createModels(db);
    await Promise.all([
      db.models.File.init(),
      db.models.Message.init(),
      db.models.User.init(),
      createHousekeepingStore(db).initialize(),
    ]);
    files = createFileMethods(db);
    lifecycle = createFileRetentionMethods(db, { securityPolicySha256: policy });
  });
  beforeEach(async () => {
    process.env.UPLOAD_SECURITY_POLICY_SHA256 = policy;
    process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = 'true';
    await db.models.File.deleteMany({});
    for (const name of [
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
      email: 'derived@example.test',
      emailVerified: true,
    });
    uploads = createUploadManagementRepository(db, {
      enabled: true,
      reconciled: true,
      securityPolicySha256: policy,
      baseline: { originalBytes: 0, objectBytes: 0, textBytes: 512, recordBytes: 0, bundles: 0 },
    });
    await uploads.initialize();
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
        registerMongo('settled');
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it('captures actual immutable source identity and inherits its earlier deadline', async () => {
    const root = acceptance('root');
    await ready(root);
    // Model a restored pre-tracking source: retain its real Upload receipt and existing shorter deadline.
    const legacyDeadline = new Date(now + 14 * DAY);
    await db.models.File.collection.updateOne(
      { file_id: 'root' },
      {
        $set: {
          expiredAt: legacyDeadline,
          retentionActivity: {
            version: 1,
            baselineDeadlineAt: legacyDeadline,
            trackedSince: new Date(now),
            historyConfidence: 'since-tracking',
            readCount: 0,
            processingCount: 0,
            deadlineGeneration: 0,
          },
        },
      },
    );
    await db.models.UploadOperation.updateOne(
      { _id: 'root' },
      { $set: { expiresAt: legacyDeadline.getTime() } },
    );
    await db.models.HousekeepingJob.deleteMany({ 'work.subject.fileId': 'root' });
    const before = await raw('root');
    const origin = await capture(['root']);
    expect(origin).toEqual({
      version: 2,
      binding: intent([]).binding,
      directSourceFileIds: ['root'],
      ancestors: [
        {
          subject: root.securityApproval.subject,
          policySha256: policy,
          sourceBindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          expiresAt: before!.expiredAt.getTime(),
        },
      ],
    });
    expect((await raw('root'))!.retentionRevision).toBeGreaterThan(before!.retentionRevision);
    await ready(acceptance('child', origin));
    expect((await raw('child'))!.expiredAt).toEqual(before!.expiredAt);
    expect((await raw('child'))!.derivedRetention.ownDeadlineAt).toEqual(
      new Date(now + UPLOAD_RETENTION_MS),
    );
    expect(
      (await db.models.UploadOperation.findById('child').lean<{ expiresAt: number }>())!.expiresAt,
    ).toBe(before!.expiredAt.getTime());
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
    if (kind === 'owner')
      await db.models.User.create({
        _id: foreign.userId,
        tenantId: foreign.tenantId,
        email: 'foreign@example.test',
        emailVerified: true,
      });
    else
      // Place the real principal in the requested namespace to exercise the File ownership fence.
      await db.models.User.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(owner.userId) },
        { $set: { tenantId: foreign.tenantId } },
      );
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

  it.each(['parent proof', 'File-only extended parent deadline'] as const)(
    'refuses derived acceptance with %s',
    async (invalid) => {
      const root = acceptance('root');
      await ready(root);
      const origin = await capture(['root']);
      const child = acceptance('child', origin);
      if (invalid === 'parent proof') child.securityApproval = root.securityApproval;
      else
        await db.models.File.collection.updateOne(
          { file_id: 'root' },
          { $set: { expiredAt: new Date(now + 42 * DAY) } },
        );
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
    expect((await raw('root'))!.expiredAt).toEqual(new Date(now + UPLOAD_RETENTION_MS + 7 * DAY));
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
    const revokedAt = (await raw('child'))!.deletionRequestedAt;
    expect(revokedAt).toBeInstanceOf(Date);
    expect(revokedAt.getTime()).toBeGreaterThanOrEqual(now);
    expect(revokedAt.getTime()).toBeLessThanOrEqual(Date.now());
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
      FileSourceCapacityError,
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
    await ready(acceptance('root'));
    const origin = await derived('child', ['root']);
    const total = async () =>
      (await db.models.UploadCounter.findById('global').lean<{ value: { textBytes: number } }>())!
        .value.textBytes;
    const originalCharge = await total();
    const childTextCharge = (await db.models.UploadOperation.findById('child').lean<{
      textBytes: number;
    }>())!.textBytes;
    const rootTextCharge = (await db.models.UploadOperation.findById('root').lean<{
      textBytes: number;
    }>())!.textBytes;
    expect(originalCharge).toBeGreaterThan(512);
    expect(childTextCharge).toBeGreaterThan(0);
    expect(rootTextCharge).toBeGreaterThan(0);
    // Synthetic retained-copy liability, charged through the actual shared accounting owner.
    await transaction((session) =>
      resizeRetainedDerivatives(db, owner, [], [{ fileId: 'child', bytes: 2048 }], session),
    );
    expect(await total()).toBe(originalCharge + 2048);
    await lifecycle.revokeFileSources(owner, ['root']);
    const cleanup = await prepareCleanupReceipts(db, ['root', 'child']);
    expect(await total()).toBe(originalCharge + 2048);
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
    const derivedDeadline = currentFileDeadline(prepared as never);
    expect(derivedDeadline.kind).toBe('derived');
    await expect(capture(['child'])).rejects.toBeInstanceOf(FileSourceUnavailableError);
    expect(await total()).toBe(originalCharge);
    // A lost Upload acknowledgment rolls back its transaction and retains the child's lineage.
    const acknowledge = jest
      .spyOn(cleanup.upload, 'acknowledgeAcceptedFileCleanup')
      .mockRejectedValueOnce(new Error('Lost Upload cleanup acknowledgment'));
    try {
      expect(await cleanup.commit('child')).toEqual({ state: 'unknown' });
    } finally {
      acknowledge.mockRestore();
    }
    expect(await total()).toBe(originalCharge);
    expect((await raw('child'))!.deletionCompletedAt).toBeFalsy();
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
    expect(await total()).toBe(originalCharge);
    await cleanup.finish('child');
    expect(await total()).toBe(originalCharge - childTextCharge);
    expect(await freshSweep.finalizeFileSourceDeletion(owner, ['child'])).toEqual({
      completedFileIds: ['child'],
    });
    expect(currentFileDeadline((await raw('child')) as never)).toEqual(derivedDeadline);
    expect(await freshSweep.prepareFileSourceDeletion(owner, ['root'])).toEqual({
      preparedFileIds: ['root'],
    });
    const originalDeadline = currentFileDeadline((await raw('root')) as never);
    expect(originalDeadline.kind).toBe('original');
    expect((await freshSweep.revokeFileSources(owner, ['root'])).revokedFileIds).toEqual(['root']);
    await expect(capture(['root'])).rejects.toBeInstanceOf(FileSourceUnavailableError);
    await cleanup.finish('root');
    expect(await freshSweep.finalizeFileSourceDeletion(owner, ['root'])).toEqual({
      completedFileIds: ['root'],
    });
    expect(currentFileDeadline((await raw('root')) as never)).toEqual(originalDeadline);
    expect(await total()).toBe(originalCharge - childTextCharge - rootTextCharge);
    expect(await total()).toBe(512);
  });

  it('settles expired historical derived custody after the real v2 migration barrier and cleanup re-entry', async () => {
    await ready(acceptance('root'));
    const captured = await derived('legacy-child', ['root']);
    const historical = {
      ...captured,
      version: 1,
      ancestors: captured.ancestors.map(({ sourceBindingSha256: _binding, ...source }) => source),
    };
    await transaction((session) =>
      resizeRetainedDerivatives(db, owner, [], [{ fileId: 'legacy-child', bytes: 2048 }], session),
    );
    const expiredAt = new Date(Date.now() - 1);
    await db.models.File.collection.updateOne(
      { file_id: 'legacy-child' },
      { $set: { derivedOrigin: historical, expiredAt }, $unset: { derivedRetention: '' } },
    );
    await db.models.UploadOperation.updateOne(
      { _id: 'legacy-child' },
      { $set: { derivedOrigin: historical, expiresAt: expiredAt.getTime() } },
    );
    const global = (await db.models.UploadCounter.findById('global').lean<{
      value: {
        baseline: {
          originalBytes: number;
          objectBytes: number;
          textBytes: number;
          recordBytes: number;
          bundles: number;
        };
        textBytes: number;
      };
    }>())!.value;
    const page = await uploads.exportSnapshot({ epoch: 'historical-cleanup', limit: 10 });
    expect(page.version).toBe(2);
    expect(
      page.records.find(
        (row) =>
          row.kind === 'file-retention' &&
          (row.subject as { fileId: string }).fileId === 'legacy-child',
      ),
    ).toMatchObject({ custody: 'cleanup-only' });
    const targetDb = new mongoose.Mongoose();
    try {
      await targetDb.connect(mongo.getUri('historical-cleanup-target'));
      createModels(targetDb);
      await targetDb.models.File.init();
      const target = createUploadManagementRepository(targetDb, {
        enabled: false,
        securityPolicySha256: policy,
      });
      await target.initialize();
      await targetDb.models.File.collection.insertMany(
        await db.models.File.collection.find({}).toArray(),
      );
      await targetDb.models.User.collection.insertMany(
        await db.models.User.collection.find({}).toArray(),
      );
      await target.importSnapshot(page);
      const file = () => targetDb.models.File.collection.findOne({ file_id: 'legacy-child' });
      expect((await file())!.derivedRetention.migrationEpoch).toBe('historical-cleanup');
      const receipt = await uploads.completeExport('historical-cleanup');
      await target.completeImport({
        receipt,
        baseline: global.baseline,
        lifecycleReconciled: true,
      });
      expect((await file())!.derivedOrigin).toEqual(historical);
      expect((await file())!.derivedRetention.migrationEpoch).toBeUndefined();
      const deadline = currentFileDeadline((await file()) as never);
      expect(deadline.deadlineAt).toEqual(expiredAt);
      const unavailable = async () => {
        const session = await targetDb.startSession();
        try {
          await expect(
            session.withTransaction(() =>
              createFileRetentionMethods(targetDb, {
                securityPolicySha256: policy,
              }).captureManagedUploadOrigin(
                owner,
                { binding: captured.binding, directSourceFileIds: ['legacy-child'] },
                Date.now(),
                session,
              ),
            ),
          ).rejects.toBeInstanceOf(FileSourceUnavailableError);
        } finally {
          await session.endSession();
        }
      };
      await unavailable();
      const deletion = createFileRetentionMethods(targetDb, { securityPolicySha256: policy });
      await deletion.revokeFileSources(owner, ['legacy-child']);
      const childTextCharge = (await targetDb.models.UploadOperation.findById('legacy-child').lean<{
        textBytes: number;
      }>())!.textBytes;
      expect(childTextCharge).toBeGreaterThan(0);
      const cleanup = await prepareCleanupReceipts(targetDb, ['legacy-child']);
      expect(await deletion.prepareFileSourceDeletion(owner, ['legacy-child'])).toEqual({
        preparedFileIds: ['legacy-child'],
      });
      expect((await file())!.derivedOrigin).toEqual(historical);
      expect(currentFileDeadline((await file()) as never)).toEqual(deadline);
      const total = async () =>
        (await targetDb.models.UploadCounter.findById('global').lean<{
          value: { textBytes: number };
        }>())!.value.textBytes;
      expect(await total()).toBe(global.textBytes - 2048);
      const resumed = createFileRetentionMethods(targetDb, { securityPolicySha256: policy });
      await resumed.revokeFileSources(owner, ['legacy-child']);
      expect(await resumed.prepareFileSourceDeletion(owner, ['legacy-child'])).toEqual({
        preparedFileIds: ['legacy-child'],
      });
      await unavailable();
      await cleanup.finish('legacy-child');
      expect(await resumed.finalizeFileSourceDeletion(owner, ['legacy-child'])).toEqual({
        completedFileIds: ['legacy-child'],
      });
      expect(await resumed.finalizeFileSourceDeletion(owner, ['legacy-child'])).toEqual({
        completedFileIds: ['legacy-child'],
      });
      expect((await file())!.derivedOrigin).toBeUndefined();
      expect(currentFileDeadline((await file()) as never)).toEqual(deadline);
      expect(await total()).toBe(global.textBytes - 2048 - childTextCharge);
      await unavailable();
    } finally {
      await targetDb.disconnect();
    }
  });

  it('keeps a parent and its locator unresolved until every child is finalized', async () => {
    await ready(acceptance('root'));
    await derived('child', ['root']);
    const result = await lifecycle.revokeFileSources(owner, ['root']);
    expect(result.revokedFileIds.sort()).toEqual(['child', 'root']);
    const cleanup = await prepareCleanupReceipts(db, ['root', 'child']);
    expect(await cleanup.commit('root')).toMatchObject({
      state: 'pending',
      reason: 'descendant_pending',
    });
    expect(await lifecycle.finalizeFileSourceDeletion(owner, ['root'])).toEqual({
      completedFileIds: [],
    });
    expect(await raw('root')).toMatchObject({ storageKey: acceptance('root').receipt.storageKey });
    expect((await raw('root'))!.deletionCompletedAt).toBeFalsy();
    // Native storage replies are fixtures; actual File/Upload owners finalize child before parent.
    await cleanup.finish('child');
    expect(await raw('root')).toMatchObject({ storageKey: acceptance('root').receipt.storageKey });
    expect((await raw('root'))!.deletionCompletedAt).toBeFalsy();
    await cleanup.finish('root');
    expect(await lifecycle.finalizeFileSourceDeletion(owner, ['root', 'child'])).toEqual({
      completedFileIds: ['child', 'root'],
    });
    expect((await raw('root'))!.deletionCompletedAt).toBeInstanceOf(Date);
    expect((await lifecycle.revokeFileSources(owner, ['root'])).revokedFileIds).toContain('root');
  });
});
