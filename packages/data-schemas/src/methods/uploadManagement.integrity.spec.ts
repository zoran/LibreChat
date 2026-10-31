/** Durable original identity, replay and replacement evidence through independent Mongo clients. */
import mongoose from 'mongoose';
import { createHash } from 'crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_MAX_TEXT_BYTES,
  UPLOAD_AV_RECORD_BYTES,
  UPLOAD_RETENTION_MS,
} from 'librechat-data-provider';
import type { UploadLease, UploadPrincipal, UploadStorageReceipt } from 'librechat-data-provider';
import type { StoredUpload } from './uploadManagementStore';
import {
  uploadSecurityFixture,
  uploadSecuritySettlementFixture,
  bindUploadOriginalFixture,
} from '../../specs/fixtures/uploadManagement.security.fixture';
import {
  completeAcceptedUploadFileCleanup,
  copyFrozenUploadFiles,
} from '../../specs/fixtures/uploadManagement.structure.fixture';
import { createUploadManagementRepository } from './uploadManagement';
import { createModels } from '~/models';

const manifest = (bytes = 8) => ({
  version: 1 as const,
  algorithm: 'sha256' as const,
  sha256: 'a'.repeat(64),
  chunkBytes: 262144 as const,
  chunkSha256: Array.from({ length: Math.ceil(bytes / 262144) }, () => 'b'.repeat(64)),
});

/** Deterministic UUIDv4-shaped test keys keep operation labels out of the public key contract. */
const fixtureKey = (label: string): string => {
  const hex = createHash('sha256').update(label).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

describe('durable managed original integrity', () => {
  let mongo: MongoMemoryReplSet;
  const a = new mongoose.Mongoose();
  const b = new mongoose.Mongoose();
  const replacement = new mongoose.Mongoose();
  let first: ReturnType<typeof createUploadManagementRepository>;
  let second: ReturnType<typeof createUploadManagementRepository>;
  let target: ReturnType<typeof createUploadManagementRepository>;
  const now = Date.now();
  const user: UploadPrincipal = {
    tenantId: 'tenant-a',
    userId: new mongoose.Types.ObjectId().toString(),
    authentication: 'verified-email',
  };
  const worker = { hostId: 'host-a', instanceId: 'app-a' };
  const baseline = { originalBytes: 0, objectBytes: 0, textBytes: 0, recordBytes: 0, bundles: 0 };
  const securityPolicySha256 = 'c'.repeat(64);
  const request = (id: string, bytes = 8, mediaType = 'text/plain') => ({
    operationId: id,
    idempotencyKey: fixtureKey(id),
    mediaType,
    declaredBytes: bytes,
    fingerprint: JSON.stringify([{ kind: 'personal' }, mediaType, bytes]),
  });
  const receipt = (lease: UploadLease, bytes = 8) => ({
    outcome: 'durable' as const,
    bytes,
    source: 's3',
    filepath: `/api/files/download/${lease.operationId}`,
    storageKey: `t/${lease.tenantId}/managed-uploads/${lease.userId}/${lease.operationId}.${lease.generation}__original`,
    etag: 'opaque-etag',
    versionId: 'opaque-version',
    integrity: manifest(bytes),
  });
  const localGone = (lease: UploadLease) => ({
    operationId: lease.operationId,
    generation: lease.generation,
    writerStopped: true,
    localCopiesAbsent: true,
    originalAbsent: false,
    textAndHistoryRemoved: false,
  });
  const approval = (lease: UploadLease, original = receipt(lease)) =>
    uploadSecurityFixture({
      decision: 'approved' as const,
      policySha256: securityPolicySha256,
      subject: {
        tenantId: lease.tenantId,
        userId: lease.userId,
        operationId: lease.operationId,
        transferGeneration: lease.generation,
        mediaType: 'text/plain',
        bytes: original.bytes,
        sha256: original.integrity.sha256,
      },
      scannerVersion: 'fixture-v1',
      checkedAt: new Date(now).toISOString(),
      coverage: { complete: true as const, pages: 1, parts: 1 },
    }).approval;

  async function completeScanner(lease: UploadLease, at: number, bytes = 8) {
    const execution = uploadSecurityFixture(approval(lease, receipt(lease, bytes)), {
      custody: { kind: 'none' as const },
      attemptId: `${lease.operationId}.${lease.generation}`,
      instanceId: '11111111-1111-4111-8111-111111111111',
      executionId: '22222222-2222-4222-8222-222222222222',
      expiresAt: new Date(at + 60_000).toISOString(),
    }).execution;
    await first.bindSecurityExecution(lease, execution, at);
    await second.settleSecurityExecution(
      lease,
      uploadSecuritySettlementFixture(execution, {
        writerStopped: true,
        transientDataRemoved: true,
      }),
      at,
    );
    await bindUploadOriginalFixture(
      first,
      lease,
      receipt(lease, bytes),
      approval(lease, receipt(lease, bytes)),
      at,
    );
  }

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await Promise.all([
      a.connect(mongo.getUri('integrity')),
      b.connect(mongo.getUri('integrity')),
      replacement.connect(mongo.getUri('replacement')),
    ]);
    for (const db of [a, b, replacement]) createModels(db);
    await Promise.all([a.models.File.init(), b.models.File.init(), replacement.models.File.init()]);
  });
  beforeEach(async () => {
    for (const db of [a, replacement]) {
      for (const name of ['User', 'File', 'UploadOperation', 'UploadCounter'])
        if (db.models[name]) await db.models[name].deleteMany({});
      await db.models.User.create({
        _id: user.userId,
        tenantId: user.tenantId,
        email: 'upload-integrity@example.test',
        emailVerified: true,
      });
    }
    first = createUploadManagementRepository(a, {
      enabled: true,
      reconciled: true,
      baseline,
      securityPolicySha256,
    });
    second = createUploadManagementRepository(b, { securityPolicySha256 });
    target = createUploadManagementRepository(replacement, { securityPolicySha256 });
    await first.initialize();
    await Promise.all([second.initialize(), target.initialize()]);
  });
  afterAll(async () => {
    await Promise.all([a.disconnect(), b.disconnect(), replacement.disconnect()]);
    await mongo?.stop();
  });

  async function transfer(id = 'identity', bytes = 8) {
    await first.reserve(user, request(id, bytes), now);
    const lease = await first.claim({
      kind: 'transfer',
      principal: user,
      operationId: id,
      worker,
      now,
    });
    expect(lease).not.toBeNull();
    await completeScanner(lease!, now);
    return lease!;
  }
  async function accepted(id = 'identity') {
    const lease = await transfer(id);
    const original = receipt(lease);
    const operation = await first.accept(
      user,
      lease,
      original,
      approval(lease, original),
      { filename: 'note.txt' },
      now,
    );
    await first.confirmCleanup(localGone(lease), now);
    return { lease, original, operation };
  }

  it.each([
    ['missing manifest', { integrity: undefined }],
    ['malformed manifest', { integrity: { ...manifest(), chunkSha256: [] } }],
    ['unknown receipt key', { backendChecksum: 'not-authority' }],
    ['oversized ETag', { etag: 'a'.repeat(1025) }],
    ['oversized UTF-8 version', { versionId: 'é'.repeat(513) }],
  ])(
    'refuses first acceptance with %s and retains the unconfirmed storage obligation',
    async (_name, change) => {
      const lease = await transfer();
      await expect(
        first.accept(
          user,
          lease,
          { ...receipt(lease), ...change } as UploadStorageReceipt,
          approval(lease),
          { filename: 'note.txt' },
          now,
        ),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      const row = await b.models.UploadOperation.findById(lease.operationId).lean<StoredUpload>();
      expect(row).toMatchObject({
        state: 'transferring',
        pendingBytes: 8,
        originalBytes: 8,
        stagingHeld: true,
      });
      expect(row!.acceptedAt).toBeUndefined();
      expect(row!.original).toBeUndefined();
      expect(await b.models.File.countDocuments({})).toBe(0);
      expect(await second.usage(user, now)).toMatchObject({
        usedBytes: 0,
        reservedBytes: 8,
        retainedBytes: 0,
      });
    },
  );

  it('persists one exact private manifest and replays it across clients without another debit', async () => {
    const lease = await transfer();
    const original = receipt(lease);
    const expected = JSON.parse(JSON.stringify(original));
    const acceptance = first.accept(
      user,
      lease,
      original,
      approval(lease, original),
      { filename: 'note.txt' },
      now,
    );
    original.integrity.chunkSha256[0] = 'c'.repeat(64);
    const operation = await acceptance;
    const stored = await b.models.UploadOperation.findById(lease.operationId).lean<StoredUpload>();
    expect(stored!.original).toEqual(expected);
    const replay = Object.fromEntries(Object.entries(expected).reverse()) as UploadStorageReceipt;
    expect(
      await second.accept(user, lease, replay, approval(lease), { filename: 'note.txt' }, now + 1),
    ).toEqual(operation);
    expect(await first.usage(user, now + 1)).toMatchObject({
      usedBytes: 8,
      reservedBytes: 0,
      retainedBytes: 8,
    });
    expect((await second.cleanupTasks())[0].original).toEqual(expected);
    const file = await b.models.File.findOne({ file_id: lease.operationId }).lean();
    expect(file).not.toHaveProperty('integrity');
    expect(JSON.stringify(await second.list(user, now))).not.toContain('chunkSha256');
    expect(JSON.stringify(await second.metrics(now))).not.toContain('chunkSha256');
    expect(operation.expiresAt).toBe(new Date(now + UPLOAD_RETENTION_MS).toISOString());
  });

  it.each([
    ['same-length identity', { integrity: { ...manifest(), sha256: 'c'.repeat(64) } }],
    ['block identity', { integrity: { ...manifest(), chunkSha256: ['d'.repeat(64)] } }],
    ['missing identity', { integrity: undefined }],
    ['opaque version', { versionId: 'different-version' }],
    ['storage key', { storageKey: 'different-object' }],
  ])(
    'refuses an altered accepted replay (%s) without rewriting or refunding it',
    async (_name, change) => {
      const { lease, original } = await accepted();
      const before = await b.models.UploadOperation.findById(
        lease.operationId,
      ).lean<StoredUpload>();
      await expect(
        second.accept(
          user,
          lease,
          { ...original, ...change } as UploadStorageReceipt,
          approval(lease),
          { filename: 'note.txt' },
          now + 1,
        ),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' });
      expect(await a.models.UploadOperation.findById(lease.operationId).lean()).toEqual(before);
      expect(await first.usage(user, now + 1)).toMatchObject({
        usedBytes: 8,
        reservedBytes: 0,
        retainedBytes: 8,
      });
    },
  );

  it('binds an accepted replay to the original transfer generation', async () => {
    const { lease, original } = await accepted();
    await expect(
      second.accept(
        user,
        { ...lease, generation: lease.generation + 1 },
        original,
        approval(lease),
        { filename: 'note.txt' },
        now + 1,
      ),
    ).rejects.toMatchObject({ code: 'lease_lost' });
    expect(await first.usage(user, now + 1)).toMatchObject({ usedBytes: 8 });
  });

  it('settles competing first acknowledgements to one immutable manifest and one debit', async () => {
    const lease = await transfer();
    const originals = [
      receipt(lease),
      { ...receipt(lease), integrity: { ...manifest(), sha256: 'c'.repeat(64) } },
    ];
    const results = await Promise.allSettled([
      first.accept(
        user,
        lease,
        originals[0],
        approval(lease, originals[0]),
        { filename: 'note.txt' },
        now,
      ),
      second.accept(
        user,
        lease,
        originals[1],
        approval(lease, originals[1]),
        { filename: 'note.txt' },
        now,
      ),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'idempotency_conflict' });
    const winner = results.findIndex((result) => result.status === 'fulfilled');
    expect(
      (await a.models.UploadOperation.findById(lease.operationId).lean<StoredUpload>())!.original,
    ).toEqual(originals[winner]);
    expect(await second.usage(user, now)).toMatchObject({
      usedBytes: 8,
      reservedBytes: 0,
      retainedBytes: 8,
    });
  });

  it('does not issue a live processing input for a historical missing manifest', async () => {
    const { lease } = await accepted();
    await a.models.UploadOperation.updateOne(
      { _id: lease.operationId },
      { $unset: { 'original.integrity': 1 } },
    );
    const parser = await second.claim({ kind: 'processing', worker, now });
    expect(parser).toBeNull();
    expect(await first.usage(user, now)).toMatchObject({ usedBytes: 8, retainedBytes: 8 });
  });

  it.each(['missing', 'malformed', 'unbounded'] as const)(
    'refuses live-original %s metadata at both migration boundaries',
    async (kind) => {
      const { lease } = await accepted();
      const page = await first.exportSnapshot({ epoch: 'move' });
      const altered = JSON.parse(JSON.stringify(page));
      const row = altered.records.find(
        (record: { type: string }) => record.type === 'operation',
      ).value;
      if (kind === 'missing') delete row.original.integrity;
      if (kind === 'malformed') row.original.integrity.chunkSha256 = [];
      if (kind === 'unbounded') row.original.versionId = 'é'.repeat(513);
      await expect(target.importSnapshot(altered)).rejects.toMatchObject({
        code: 'migration_conflict',
      });
      expect(await replacement.models.UploadOperation.countDocuments({})).toBe(0);
      await a.models.UploadOperation.updateOne(
        { _id: lease.operationId },
        { $set: { original: row.original } },
      );
      await expect(second.exportSnapshot({ epoch: 'move' })).rejects.toMatchObject({
        code: 'migration_conflict',
      });
      expect(await first.usage(user, now)).toMatchObject({ usedBytes: 8, retainedBytes: 8 });
    },
  );

  it('round-trips the exact live manifest and retained quota through the existing replacement protocol', async () => {
    const { lease, original } = await accepted();
    const page = await first.exportSnapshot({ epoch: 'move' });
    await replacement.models.File.insertMany(
      await a.models.File.find({})
        .select(
          '+securityApproval +originalWriteBinding +originalIntegrity +retentionActivity +derivedRetention +derivedOrigin +retentionRevocationId',
        )
        .lean(),
    );
    await target.importSnapshot(page);
    await target.importSnapshot(page);
    const seal = await first.completeExport('move');
    await target.completeImport({ receipt: seal, baseline, lifecycleReconciled: true });
    expect(
      (await replacement.models.UploadOperation.findById(lease.operationId).lean<StoredUpload>())!
        .original,
    ).toEqual(original);
    expect(await target.usage(user, now)).toEqual(await first.usage(user, now));
    const parser = await target.claim({ kind: 'processing', worker, now });
    expect((await target.getProcessingInput(parser!, now)).original).toEqual(original);
  });

  it('preserves fully removed legacy history and its debit without fabricating an original identity', async () => {
    const { lease, original } = await accepted();
    const fileQuery = { file_id: lease.operationId };
    expect(await a.models.File.collection.findOne(fileQuery)).toMatchObject({
      filename: 'note.txt',
      type: 'text/plain',
      filepath: original.filepath,
      bytes: original.bytes,
    });
    await first.delete(user, lease.operationId, now + 1);
    await first.confirmCleanup(
      { ...localGone(lease), originalAbsent: true, textAndHistoryRemoved: true },
      now + 1,
    );
    await completeAcceptedUploadFileCleanup(a, user, lease.operationId, mongo.getUri('integrity'));
    expect(
      await a.models.UploadOperation.findById(lease.operationId).lean<StoredUpload>(),
    ).toMatchObject({
      originalBytes: 0,
      originalRemoved: true,
      textRemoved: true,
      cleanupPending: false,
      actualBytes: 8,
    });
    const cleanedFile = await a.models.File.collection.findOne(fileQuery);
    expect(cleanedFile).toMatchObject({
      deletionCompletedAt: expect.any(Date),
      retainedDerivativeBytes: 0,
    });
    const removedFields = ['filename', 'type', 'filepath', 'bytes'];
    for (const field of removedFields) expect(cleanedFile).not.toHaveProperty(field);
    // Model a historical tombstone that predates receipt custody after actual owner cleanup.
    // Remove both current proof projections instead of rebinding them to a missing identity.
    await a.models.UploadOperation.updateOne(
      { _id: lease.operationId },
      {
        $unset: {
          cleanupCustody: 1,
          'original.integrity': 1,
          securityApproval: 1,
          securityExecution: 1,
          securitySettlement: 1,
        },
      },
    );
    await a.models.File.updateOne(
      { file_id: lease.operationId, user: user.userId, tenantId: user.tenantId },
      { $unset: { retentionCleanup: 1 } },
    );
    const page = await first.exportSnapshot({ epoch: 'removed' });
    const frozenFile = await a.models.File.collection.findOne(fileQuery);
    await copyFrozenUploadFiles(a, replacement);
    expect(await replacement.models.File.collection.findOne(fileQuery)).toEqual(frozenFile);
    await target.importSnapshot(page);
    const seal = await first.completeExport('removed');
    await target.completeImport({ receipt: seal, baseline, lifecycleReconciled: true });
    const importedFile = await replacement.models.File.collection.findOne(fileQuery);
    expect(importedFile).toMatchObject({ deletionCompletedAt: cleanedFile!.deletionCompletedAt });
    for (const field of removedFields) expect(importedFile).not.toHaveProperty(field);
    const stored = await replacement.models.UploadOperation.findById(
      lease.operationId,
    ).lean<StoredUpload>();
    expect(stored!.original).not.toHaveProperty('integrity');
    expect(stored).not.toHaveProperty('cleanupCustody');
    expect(stored).not.toHaveProperty('securityApproval');
    expect(stored).not.toHaveProperty('securityExecution');
    expect(stored).not.toHaveProperty('securitySettlement');
    expect(stored).toMatchObject({ originalBytes: 0, originalRemoved: true, actualBytes: 8 });
    expect(await target.usage(user, now + 1)).toMatchObject({
      usedBytes: 8,
      reservedBytes: 0,
      retainedBytes: 0,
    });
  });

  it('keeps the maximum supported original manifest and bounded record inside its existing AV charge', async () => {
    const id = 'a'.repeat(128);
    const owner = {
      ...user,
      userId: new mongoose.Types.ObjectId().toString(),
      tenantId: 't'.repeat(128),
    };
    await a.models.User.create({
      _id: owner.userId,
      tenantId: owner.tenantId,
      email: 'upload-long-tenant@example.test',
      emailVerified: true,
    });
    const filename = '界'.repeat(255);
    const input = {
      ...request(id, UPLOAD_MAX_FILE_BYTES, 'text/plain'),
    };
    await first.reserve(owner, input, now);
    const lease = (await first.claim({
      kind: 'transfer',
      principal: owner,
      operationId: id,
      worker,
      now,
    }))!;
    const prefix = '/api/files/download/';
    const original = {
      ...receipt(lease, UPLOAD_MAX_FILE_BYTES),
      filepath: prefix + '界'.repeat(4096 - prefix.length),
      etag: 'é'.repeat(512),
      versionId: 'é'.repeat(512),
    };
    await completeScanner(lease, now, UPLOAD_MAX_FILE_BYTES);
    await first.accept(owner, lease, original, approval(lease, original), { filename }, now);
    const row = (await b.models.UploadOperation.findById(id).lean<StoredUpload>())!;
    const largest: StoredUpload = {
      ...row,
      revision: Number.MAX_SAFE_INTEGER,
      generation: Number.MAX_SAFE_INTEGER,
      worker: { hostId: '界'.repeat(128), instanceId: '界'.repeat(128) },
      slot: 'processing',
      leaseExpiresAt: 8.64e15,
      workerGeneration: Number.MAX_SAFE_INTEGER,
      workerKind: 'processing',
      byteLeaseUntil: 8.64e15,
      byteLeaseGeneration: Number.MAX_SAFE_INTEGER,
      textBytes: UPLOAD_MAX_TEXT_BYTES,
      parserExecution: {
        attemptId: `${id}.${Number.MAX_SAFE_INTEGER}`,
        instanceId: '界'.repeat(128),
        expiresAt: new Date(8.64e15).toISOString(),
      },
      publishedDigest: 'f'.repeat(64),
      error: 'idempotency_conflict',
      originalRemoved: false,
      textRemoved: false,
    };
    expect(original.integrity.chunkSha256).toHaveLength(120);
    expect(row.recordBytes).toBe(UPLOAD_AV_RECORD_BYTES);
    expect(mongoose.mongo.BSON.calculateObjectSize(largest)).toBeLessThanOrEqual(
      UPLOAD_AV_RECORD_BYTES,
    );
  });
});
