/** Real Mongo upload transactions; scanner/storage acknowledgements below are synthetic boundaries. */
import mongoose from 'mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  UPLOAD_RETENTION_MS,
  UPLOAD_RECORD_BYTES,
  uploadReservationFingerprint,
  readUploadDerivedOrigin,
  readUploadPromotionRecord,
} from 'librechat-data-provider';
import type {
  UploadDerivedIntent,
  UploadLease,
  UploadPrincipal,
  UploadSecurityApproval,
  UploadStorageReceipt,
} from 'librechat-data-provider';
import type { StoredUpload } from './uploadManagementStore';
import { createUploadManagementRepository } from './uploadManagement';
import { createFileRetentionMethods } from './fileRetention';
import { createModels } from '~/models';

describe('private derived upload reservations', () => {
  const db = new mongoose.Mongoose();
  let mongo: MongoMemoryReplSet;
  let repository: ReturnType<typeof createUploadManagementRepository>;
  const now = Date.now();
  const policy = 'c'.repeat(64);
  const user: UploadPrincipal = {
    authentication: 'verified-email',
    tenantId: 'tenant',
    userId: new mongoose.Types.ObjectId().toString(),
  };
  const worker = { hostId: 'host', instanceId: 'process' };
  const bytes = 8;
  const sha256 = createHash('sha256').update('document').digest('hex');
  const intent = (): UploadDerivedIntent => ({
    binding: { purpose: 'workspace-draft', sourceId: 'draft', sourceRevision: 1 },
    directSourceFileIds: ['source'],
  });
  const reservation = (id: string, derived?: UploadDerivedIntent, key = randomUUID()) => ({
    operationId: id,
    idempotencyKey: key,
    mediaType: 'text/plain',
    declaredBytes: bytes,
    fingerprint: uploadReservationFingerprint(
      { scope: { kind: 'personal' }, mediaType: 'text/plain', declaredBytes: bytes },
      derived,
    ),
    ...(derived ? { derived } : {}),
  });
  const original = (lease: UploadLease): UploadStorageReceipt => ({
    outcome: 'durable',
    source: 's3',
    bytes,
    filepath: `/api/files/managed/${lease.operationId}`,
    storageKey: `t/${user.tenantId}/managed-uploads/${user.userId}/${lease.operationId}.${lease.generation}__original`,
    integrity: {
      version: 1,
      algorithm: 'sha256',
      sha256,
      chunkBytes: 262144,
      chunkSha256: [sha256],
    },
  });
  const approval = (lease: UploadLease, at: number): UploadSecurityApproval => ({
    version: 1,
    decision: 'approved',
    policySha256: policy,
    subject: {
      tenantId: user.tenantId,
      userId: user.userId,
      operationId: lease.operationId,
      transferGeneration: lease.generation,
      mediaType: 'text/plain',
      bytes,
      sha256,
    },
    scannerVersion: 'synthetic-fixture',
    checkedAt: new Date(at).toISOString(),
    coverage: { complete: true, pages: 1, parts: 1 },
  });
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await db.connect(mongo.getUri('upload-derived'));
    createModels(db);
    await db.models.File.init();
  });
  beforeEach(async () => {
    for (const name of ['User', 'File', 'Message', 'UploadOperation', 'UploadCounter'])
      if (db.models[name]) await db.models[name].deleteMany({});
    await db.models.User.create({
      _id: user.userId,
      tenantId: user.tenantId,
      email: 'derived@example.test',
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
  afterAll(async () => {
    await db.disconnect();
    await mongo?.stop();
  });
  async function transfer(id: string, at: number) {
    const lease = (await repository.claim({
      kind: 'transfer',
      principal: user,
      operationId: id,
      worker,
      now: at,
    }))!;
    const execution = {
      version: 1 as const,
      attemptId: `${id}.${lease.generation}`,
      instanceId: randomUUID(),
      executionId: randomUUID(),
      expiresAt: new Date(at + 60_000).toISOString(),
    };
    await repository.bindSecurityExecution(lease, execution, at);
    await repository.settleSecurityExecution(
      lease,
      { execution, writerStopped: true, transientDataRemoved: true },
      at,
    );
    return lease;
  }
  async function accept(lease: UploadLease, at: number) {
    return repository.accept(
      user,
      lease,
      original(lease),
      approval(lease, at),
      { filename: 'document.txt' },
      at,
    );
  }
  async function process(lease: UploadLease, at: number, beforePublish?: () => Promise<void>) {
    await repository.confirmCleanup(
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
    const processing = (await repository.claim({ kind: 'processing', worker, now: at }))!;
    const execution = {
      attemptId: `${processing.operationId}.${processing.generation}`,
      instanceId: 'parser',
      expiresAt: new Date(at + 60_000).toISOString(),
    };
    await repository.bindProcessingExecution(processing, execution, at);
    const result = {
      writerStopped: true as const,
      text: 'document',
      structure: {
        version: 1 as const,
        source: { sha256, bytes, mediaType: 'text/plain' },
        extractor: { name: 'fixture', version: '1' },
        pages: [],
        elements: [
          { id: 'e1', kind: 'paragraph' as const, start: 0, end: 8, page: null, parentId: null },
        ],
        quality: { status: 'complete' as const, warnings: [] },
      },
    };
    await beforePublish?.();
    await repository.publish(processing, result, at);
    await repository.confirmCleanup(
      {
        operationId: processing.operationId,
        generation: processing.generation,
        writerStopped: true,
        localCopiesAbsent: true,
        originalAbsent: false,
        textAndHistoryRemoved: false,
      },
      at,
    );
    return { processing, execution, result };
  }
  async function source(id = 'source') {
    await repository.reserve(user, reservation(id), now - 1000);
    const lease = await transfer(id, now - 1000);
    await accept(lease, now - 1000);
    await process(lease, now - 1000);
  }
  const operations = () =>
    db.connection.db!.collection<StoredUpload>(db.models.UploadOperation.collection.name);
  const raw = (id: string) => operations().findOne({ _id: id });

  async function fenceUser() {
    await db.models.User.updateOne(
      { _id: user.userId },
      { $set: { agentTriggerDeletionStartedAt: new Date(now) } },
    );
  }
  it('rejects an earlier save intent and ordinary admission after account deletion without new Files', async () => {
    await source();
    const derived = intent();
    const request = { ...reservation('derived', derived), derived };
    await db.models.User.deleteOne({ _id: user.userId });
    await expect(repository.reserveDerived(user, request, now)).rejects.toMatchObject({
      code: 'principal_unavailable',
    });
    await expect(repository.reserve(user, reservation('ordinary'), now)).rejects.toMatchObject({
      code: 'principal_unavailable',
    });
    expect(await raw('derived')).toBeNull();
    expect(await raw('ordinary')).toBeNull();
    expect(await db.models.File.countDocuments()).toBe(1);
  });
  it('fences both reservation replay paths while preserving cancellation for a deleted account', async () => {
    const request = reservation('pending');
    await repository.reserve(user, request, now);
    await db.models.User.deleteOne({ _id: user.userId });
    await expect(repository.reserve(user, request, now)).rejects.toMatchObject({
      code: 'principal_unavailable',
    });
    await expect(
      repository.findReservation(user, request.idempotencyKey, request.fingerprint, now),
    ).rejects.toMatchObject({ code: 'principal_unavailable' });
    expect((await repository.cancel(user, 'pending', now)).state).toBe('cancelled');
    expect(await db.models.File.countDocuments()).toBe(0);
  });
  it.each([false, true])(
    'fences acceptance including replay=%s after native deletion starts',
    async (replay) => {
      await repository.reserve(user, reservation('pending'), now);
      const lease = await transfer('pending', now);
      if (replay) await accept(lease, now);
      await fenceUser();
      await expect(accept(lease, now)).rejects.toMatchObject({ code: 'principal_unavailable' });
      expect(await db.models.File.countDocuments()).toBe(replay ? 1 : 0);
      if (!replay) expect((await raw('pending'))!.acceptedAt).toBeUndefined();
    },
  );
  it.each([false, true])(
    'fences publishing including replay=%s without materializing late results',
    async (replay) => {
      await repository.reserve(user, reservation('pending'), now);
      const lease = await transfer('pending', now);
      await accept(lease, now);
      if (replay) {
        const { processing, result } = await process(lease, now);
        await fenceUser();
        await expect(repository.publish(processing, result, now)).rejects.toMatchObject({
          code: 'principal_unavailable',
        });
      } else {
        await expect(process(lease, now, fenceUser)).rejects.toMatchObject({
          code: 'principal_unavailable',
        });
        expect((await raw('pending'))!.state).toBe('processing');
        expect((await raw('pending'))!.publishedDigest).toBeUndefined();
      }
    },
  );
  it('reads only the exact private derived binding before File acceptance and hides internal receipts', async () => {
    await source();
    const derived = intent();
    await repository.reserveDerived(user, { ...reservation('derived', derived), derived }, now);
    const status = await repository.getDerivedOperation(user, 'derived', derived.binding, now);
    expect(status).toMatchObject({ id: 'derived', state: 'waiting' });
    expect(status).not.toHaveProperty('derivedOrigin');
    expect(status).not.toHaveProperty('securityApproval');
    expect(status).not.toHaveProperty('original');
    await expect(
      repository.getDerivedOperation(user, 'source', derived.binding, now),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      repository.getDerivedOperation(
        user,
        'derived',
        { ...derived.binding, sourceRevision: 2 },
        now,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
    await fenceUser();
    await expect(
      repository.getDerivedOperation(user, 'derived', derived.binding, now),
    ).rejects.toMatchObject({ code: 'principal_unavailable' });
  });

  it('keeps ordinary exact28-day admission and rejects derived injection into its port', async () => {
    await source();
    expect((await repository.get(user, 'source', now)).expiresAt).toBe(
      new Date(now - 1000 + UPLOAD_RETENTION_MS).toISOString(),
    );
    await expect(repository.reserve(user, reservation('bad', intent()), now)).rejects.toMatchObject(
      { code: 'invalid_request' },
    );
  });
  it('captures origin once, inherits expiry, charges new bytes and never projects private composer authority', async () => {
    await source();
    const derived = intent();
    await repository.reserveDerived(user, { ...reservation('derived', derived), derived }, now);
    const captured = (await raw('derived'))!.derivedOrigin;
    expect(captured!.ancestors[0].subject.operationId).toBe('source');
    const lease = await transfer('derived', now);
    const accepted = await accept(lease, now);
    expect(accepted.acceptedAt).toBe(new Date(now).toISOString());
    expect(accepted.expiresAt).toBe(new Date(now - 1000 + UPLOAD_RETENTION_MS).toISOString());
    await process(lease, now);
    const publicRow = await repository.get(user, 'derived', now);
    expect(publicRow.canUseInComposer).toBe(false);
    expect(publicRow).not.toHaveProperty('derivedOrigin');
    expect((await repository.usage(user, now)).usedBytes).toBe(16);
    expect((await raw('derived'))!.derivedOrigin).toEqual(captured);
  });
  it('replays an exact intent after source revocation without recapture but rejects a changed intent', async () => {
    await source();
    const derived = intent();
    const request = { ...reservation('derived', derived), derived };
    const first = await repository.reserveDerived(user, request, now);
    await createFileRetentionMethods(db, { securityPolicySha256: policy }).revokeFileSources(user, [
      'source',
    ]);
    expect(await repository.reserveDerived(user, request, now + 1)).toEqual(first);
    const changed = { ...derived, binding: { ...derived.binding, sourceRevision: 2 } };
    await expect(
      repository.reserveDerived(
        user,
        {
          ...request,
          derived: changed,
          fingerprint: uploadReservationFingerprint(
            { ...request, scope: { kind: 'personal' } },
            changed,
          ),
        },
        now + 1,
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });
  it('refuses missing sources without creating a reservation', async () => {
    const derived = intent();
    await expect(
      repository.reserveDerived(user, { ...reservation('derived', derived), derived }, now),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await raw('derived')).toBeNull();
  });
  it('rejects origin headroom overflow before admission and rolls source touches back', async () => {
    const ids = Array.from(
      { length: 26 },
      (_, index) => `${'x'.repeat(124)}${index.toString().padStart(4, '0')}`,
    );
    for (const id of ids) await source(id);
    const derived: UploadDerivedIntent = {
      binding: {
        purpose: 'workspace-draft',
        sourceId: 'd'.repeat(128),
        sourceRevision: Number.MAX_SAFE_INTEGER,
      },
      directSourceFileIds: ids,
    };
    const revisions = await db.models.File.find({}).select('file_id retentionRevision').lean();
    const counter = await db.models.UploadCounter.findById('global').lean();
    await expect(
      repository.reserveDerived(user, { ...reservation('overflow', derived), derived }, now),
    ).rejects.toMatchObject({ code: 'capacity_exceeded' });
    expect(await raw('overflow')).toBeNull();
    expect(await db.models.UploadCounter.findById('global').lean()).toEqual(counter);
    expect(await db.models.File.find({}).select('file_id retentionRevision').lean()).toEqual(
      revisions,
    );
  });
  it('keeps a durable-new-byte obligation when its captured source was revoked before acceptance', async () => {
    await source();
    const derived = intent();
    await repository.reserveDerived(user, { ...reservation('derived', derived), derived }, now);
    const lease = await transfer('derived', now);
    await createFileRetentionMethods(db, { securityPolicySha256: policy }).revokeFileSources(user, [
      'source',
    ]);
    await expect(accept(lease, now)).rejects.toThrow();
    expect(await db.models.File.findOne({ file_id: 'derived' })).toBeNull();
    expect((await raw('derived'))!.stagingHeld).toBe(true);
  });
  it('requires a fresh approval for derived bytes rather than inheriting the source approval', async () => {
    await source();
    const derived = intent();
    await repository.reserveDerived(user, { ...reservation('derived', derived), derived }, now);
    const lease = await transfer('derived', now);
    const wrong = approval(lease, now);
    wrong.subject.operationId = 'source';
    await expect(
      repository.accept(user, lease, original(lease), wrong, { filename: 'document.txt' }, now),
    ).rejects.toMatchObject({ code: 'security_uninspectable' });
  });
  it('rejects a nonnative locator for derived acceptance before persisting it', async () => {
    await source();
    const derived = intent();
    await repository.reserveDerived(user, { ...reservation('derived', derived), derived }, now);
    const lease = await transfer('derived', now);
    await expect(
      repository.accept(
        user,
        lease,
        { ...original(lease), filepath: 'https://elsewhere.invalid/source' },
        approval(lease, now),
        { filename: 'document.txt' },
        now,
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await db.models.File.findOne({ file_id: 'derived' })).toBeNull();
  });
  it('fits the native maximal metadata and three one-chunk integrity copies inside the unchanged BSON charge', async () => {
    await source();
    const derived = intent();
    await repository.reserveDerived(user, { ...reservation('derived', derived), derived }, now);
    const lease = await transfer('derived', now);
    await accept(lease, now);
    let origin = readUploadDerivedOrigin({
      version: 1,
      ...derived,
      ancestors: [
        {
          subject: { ...approval(lease, now).subject, operationId: 'source' },
          policySha256: policy,
          expiresAt: now + 1000,
        },
      ],
    })!;
    for (let count = 1; count <= 64; count++) {
      const ids = Array.from(
        { length: count },
        (_, index) => `${'x'.repeat(124)}${index.toString().padStart(4, '0')}`,
      );
      const candidate = readUploadDerivedOrigin({
        version: 1,
        binding: {
          ...derived.binding,
          sourceId: 'x'.repeat(128),
          sourceRevision: Number.MAX_SAFE_INTEGER,
        },
        directSourceFileIds: ids,
        ancestors: ids.map((id) => ({
          subject: { ...approval(lease, now).subject, operationId: id },
          policySha256: policy,
          expiresAt: now + 1000,
        })),
      });
      if (!candidate) break;
      const fingerprint = uploadReservationFingerprint(
        { scope: { kind: 'personal' }, mediaType: 'text/plain', declaredBytes: 65536 },
        { binding: candidate.binding, directSourceFileIds: candidate.directSourceFileIds },
      );
      if (
        mongoose.mongo.BSON.calculateObjectSize({ derivedOrigin: candidate, fingerprint }) >
        UPLOAD_RECORD_BYTES / 2
      )
        break;
      origin = candidate;
    }
    const wideLease = {
      ...lease,
      tenantId: 't'.repeat(128),
      operationId: 'x'.repeat(128),
      hostId: 'h'.repeat(128),
      instanceId: 'i'.repeat(128),
      generation: Number.MAX_SAFE_INTEGER,
    };
    const proof = approval(wideLease, now);
    proof.subject.tenantId = wideLease.tenantId;
    proof.subject.bytes = 65536;
    proof.scannerVersion = 's'.repeat(128);
    const receipt = {
      ...original(wideLease),
      bytes: 65536,
      storageKey: `t/${wideLease.tenantId}/managed-uploads/${user.userId}/${wideLease.operationId}.${wideLease.generation}__original`,
      etag: 'e'.repeat(1024),
      versionId: 'v'.repeat(1024),
    };
    const promotion = {
      version: 1,
      promotionId: randomUUID(),
      lease: wideLease,
      worker: { hostId: 'w'.repeat(128), instanceId: 'i'.repeat(128) },
      approval: proof,
      integrity: receipt.integrity,
      metadata: { filename: '文'.repeat(255) },
      state: 'settled',
      writerStopped: true,
      receipt,
    };
    expect(readUploadPromotionRecord(promotion)).not.toBeNull();
    const execution = {
      version: 1,
      attemptId: `${wideLease.operationId}.${wideLease.generation}`,
      instanceId: 's'.repeat(128),
      executionId: randomUUID(),
      expiresAt: new Date(now + 60_000).toISOString(),
    };
    const maximum = {
      ...(await raw('derived')),
      tenantId: wideLease.tenantId,
      _id: wideLease.operationId,
      fileId: wideLease.operationId,
      filename: '文'.repeat(255),
      derivedOrigin: origin,
      fingerprint: uploadReservationFingerprint(
        { scope: { kind: 'personal' }, mediaType: 'text/plain', declaredBytes: 65536 },
        { binding: origin.binding, directSourceFileIds: origin.directSourceFileIds },
      ),
      declaredBytes: 65536,
      actualBytes: 65536,
      original: receipt,
      promotion,
      securityApproval: proof,
      securityExecution: execution,
      securitySettlement: { execution, writerStopped: true, transientDataRemoved: true },
      worker: { hostId: wideLease.hostId, instanceId: wideLease.instanceId },
      parserExecution: {
        attemptId: execution.attemptId,
        instanceId: 'p'.repeat(128),
        expiresAt: execution.expiresAt,
      },
      intake: {
        capabilitySha256: 'a'.repeat(64),
        grant: {
          version: 1,
          principal: { ...user, tenantId: wideLease.tenantId },
          sessionId: 'a'.repeat(24),
          authVersion: Number.MAX_SAFE_INTEGER,
          policyVersion: Number.MAX_SAFE_INTEGER,
          expiresAt: execution.expiresAt,
        },
        worker: { hostId: wideLease.hostId, instanceId: wideLease.instanceId },
        generation: wideLease.generation,
        closed: true,
        cleanupAcknowledged: true,
      },
      publishedDigest: 'a'.repeat(64),
      workerGeneration: wideLease.generation,
      byteLeaseGeneration: wideLease.generation,
      byteLeaseUntil: Number.MAX_SAFE_INTEGER,
      leaseExpiresAt: Number.MAX_SAFE_INTEGER,
      slot: 'processing',
      workerKind: 'processing',
      originalRemoved: true,
      textRemoved: true,
      attemptGeneration: Number.MAX_SAFE_INTEGER,
      processingQueuedAt: Number.MAX_SAFE_INTEGER,
      error: 'processing_failed',
      writerStopped: true,
      idempotencyKey: 'i'.repeat(128),
    };
    const journal = { ...maximum };
    Reflect.deleteProperty(journal, 'derivedOrigin');
    Reflect.deleteProperty(journal, 'fingerprint');
    const originBytes = mongoose.mongo.BSON.calculateObjectSize({
      derivedOrigin: maximum.derivedOrigin,
      fingerprint: maximum.fingerprint,
    });
    const journalBytes = mongoose.mongo.BSON.calculateObjectSize(journal);
    const totalBytes = mongoose.mongo.BSON.calculateObjectSize(maximum);
    expect(originBytes).toBeLessThanOrEqual(UPLOAD_RECORD_BYTES / 2);
    expect(journalBytes).toBeLessThanOrEqual(UPLOAD_RECORD_BYTES / 2);
    expect(totalBytes).toBeLessThanOrEqual(UPLOAD_RECORD_BYTES);
    console.info('Native derived BSON bounds', { originBytes, journalBytes, totalBytes });
  });
  it('fences both processing input and parser binding after File revocation despite a current Upload lease', async () => {
    await source();
    const derived = intent();
    await repository.reserveDerived(user, { ...reservation('derived', derived), derived }, now);
    const lease = await transfer('derived', now);
    await accept(lease, now);
    await repository.confirmCleanup(
      {
        operationId: 'derived',
        generation: lease.generation,
        writerStopped: true,
        localCopiesAbsent: true,
        originalAbsent: false,
        textAndHistoryRemoved: false,
      },
      now,
    );
    const processing = (await repository.claim({ kind: 'processing', worker, now }))!;
    await createFileRetentionMethods(db, { securityPolicySha256: policy }).revokeFileSources(user, [
      'source',
    ]);
    await expect(repository.getProcessingInput(processing, now)).rejects.toThrow();
    await expect(
      repository.bindProcessingExecution(
        processing,
        {
          attemptId: `derived.${processing.generation}`,
          instanceId: 'parser',
          expiresAt: new Date(now + 60_000).toISOString(),
        },
        now,
      ),
    ).rejects.toThrow();
  });
  it('keeps derived origin through frozen export/import and refuses a renewed source deadline', async () => {
    await source();
    const derived = intent();
    await repository.reserveDerived(user, { ...reservation('derived', derived), derived }, now);
    const lease = await transfer('derived', now);
    await accept(lease, now);
    await process(lease, now);
    const before = await raw('derived');
    const page = await repository.exportSnapshot({ epoch: randomUUID(), limit: 10 });
    const exported = page.records.find(
      (record) =>
        record.type === 'operation' && (record.value as { _id?: string })._id === 'derived',
    )?.value;
    expect(exported).toMatchObject({
      derivedOrigin: before!.derivedOrigin,
      fingerprint: before!.fingerprint,
      expiresAt: now - 1000 + UPLOAD_RETENTION_MS,
    });
    const targetDb = new mongoose.Mongoose();
    try {
      await targetDb.connect(mongo.getUri('upload-derived-import'));
      createModels(targetDb);
      const target = createUploadManagementRepository(targetDb, {
        enabled: false,
        securityPolicySha256: policy,
      });
      await target.initialize();
      const tampered = JSON.parse(JSON.stringify(page)) as typeof page;
      const record = tampered.records.find(
        (record) => record.type === 'operation' && (record.value as StoredUpload)._id === 'derived',
      )!.value as StoredUpload;
      record.expiresAt = record.acceptedAt! + UPLOAD_RETENTION_MS;
      await expect(target.importSnapshot(tampered)).rejects.toMatchObject({
        code: 'migration_conflict',
      });
      expect(await targetDb.models.UploadOperation.countDocuments()).toBe(0);
      await target.importSnapshot(page);
      expect(await targetDb.models.UploadOperation.findById('derived').lean()).toMatchObject({
        derivedOrigin: before!.derivedOrigin,
        fingerprint: before!.fingerprint,
        acceptedAt: before!.acceptedAt,
        expiresAt: before!.expiresAt,
      });
    } finally {
      await targetDb.disconnect();
    }
  });
  it('refuses migration if a derived fingerprint loses its origin', async () => {
    await source();
    const derived = intent();
    await repository.reserveDerived(user, { ...reservation('derived', derived), derived }, now);
    await operations().updateOne({ _id: 'derived' }, { $unset: { derivedOrigin: '' } });
    await expect(
      repository.exportSnapshot({ epoch: randomUUID(), limit: 10 }),
    ).rejects.toMatchObject({ code: 'migration_conflict' });
  });
});
