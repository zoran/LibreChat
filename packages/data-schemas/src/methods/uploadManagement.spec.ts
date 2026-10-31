import { antivirusFixture } from '../../../data-provider/src/__fixtures__/upload-antivirus';
/** Real replica-set evidence for the one durable upload store, through two independent clients. */
import mongoose from 'mongoose';
import { createHash } from 'crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  UPLOAD_MAX_FILE_BYTES,
  UPLOAD_USER_WINDOW_BYTES,
  UPLOAD_WINDOW_MS,
  UPLOAD_RETENTION_MS,
  canonicalManagedJson,
} from 'librechat-data-provider';
import type { UploadPrincipal, UploadLease, UploadMigrationPage } from 'librechat-data-provider';
import type { StoredUpload, GlobalState } from './uploadManagementStore';
import type { FileRetrievalOriginal } from './fileRetrievalOperation';
import {
  copyFrozenUploadFiles,
  completeUnacceptedUploadCleanup,
  completeAcceptedUploadFileCleanup,
} from './uploadManagement.structure.fixture';
import retrievalFixture from '../../../data-provider/src/__fixtures__/managed-retrieval-v1.json';
import { createFileRetentionMethods, FileSourceUnavailableError } from './fileRetention';
import { createFileRetrievalOperationOwner } from './fileRetrievalOperation';
import { createUploadManagementRepository } from './uploadManagement';
import { tenantStorage } from '~/config/tenantContext';
import { RESOURCE_MAX } from './uploadManagementStore';
import { createFileMethods } from './file';
import { createModels } from '~/models';

/** Deterministic UUIDv4-shaped test keys keep operation labels out of the public key contract. */
const fixtureKey = (label: string): string => {
  const hex = createHash('sha256').update(label).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

describe('durable upload management', () => {
  let mongo: MongoMemoryReplSet;
  // The real checkpoint owner uses the default connection; the other clients remain independent.
  const a = mongoose;
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
  const other: UploadPrincipal = { ...user, userId: new mongoose.Types.ObjectId().toString() };
  const guest: UploadPrincipal = {
    tenantId: null,
    userId: new mongoose.Types.ObjectId().toString(),
    authentication: 'guest',
  };
  const stranger: UploadPrincipal = { ...guest, userId: new mongoose.Types.ObjectId().toString() };
  const worker = { hostId: 'host-a', instanceId: 'app-a' };
  const baseline = { originalBytes: 0, objectBytes: 0, textBytes: 0, recordBytes: 0, bundles: 0 };
  const securityPolicySha256 = 'c'.repeat(64);
  const request = (id: string, bytes = 8) => ({
    operationId: id,
    idempotencyKey: fixtureKey(id),
    mediaType: 'text/plain',
    declaredBytes: bytes,
    fingerprint: JSON.stringify([{ kind: 'personal' }, 'text/plain', bytes]),
  });
  const receipt = (lease: UploadLease, bytes = 8) => ({
    outcome: 'durable' as const,
    bytes,
    source: 's3',
    filepath: `/api/files/download/${lease.operationId}`,
    storageKey: `${lease.tenantId === null ? '' : `t/${lease.tenantId}/`}managed-uploads/${lease.userId}/${lease.operationId}.${lease.generation}__original`,
    integrity: {
      version: 1 as const,
      algorithm: 'sha256' as const,
      sha256: 'a'.repeat(64),
      chunkBytes: 262144 as const,
      chunkSha256: Array.from({ length: Math.ceil(bytes / 262144) }, () => 'b'.repeat(64)),
    },
  });
  const documentResult = (text: string, bytes = 8) => ({
    text,
    writerStopped: true as const,
    structure: {
      version: 1 as const,
      source: { sha256: 'a'.repeat(64), bytes, mediaType: 'text/plain' },
      extractor: { name: 'fixture', version: '1' },
      pages: [],
      elements: [
        {
          id: 'e1',
          kind: 'paragraph' as const,
          start: 0,
          end: text.length,
          page: null,
          parentId: null,
        },
      ],
      quality: { status: 'complete' as const, warnings: [] },
    },
  });
  const localGone = (lease: UploadLease) => ({
    operationId: lease.operationId,
    generation: lease.generation,
    writerStopped: true,
    localCopiesAbsent: true,
    originalAbsent: false,
    textAndHistoryRemoved: false,
  });
  const securitySubject = (lease: UploadLease, bytes = 8) => ({
    tenantId: lease.tenantId,
    userId: lease.userId,
    operationId: lease.operationId,
    transferGeneration: lease.generation,
    mediaType: 'text/plain',
    bytes,
    sha256: receipt(lease, bytes).integrity.sha256,
  });
  const approval = (lease: UploadLease, bytes = 8, checkedAt = now) => ({
    version: 2 as const,
    antivirus: antivirusFixture(securitySubject(lease, bytes), checkedAt).approval,
    decision: 'approved' as const,
    policySha256: securityPolicySha256,
    subject: securitySubject(lease, bytes),
    scannerVersion: 'fixture-v1',
    checkedAt: new Date(checkedAt).toISOString(),
    coverage: { complete: true as const, pages: 1, parts: 1 },
  });

  async function completeScanner(lease: UploadLease, at: number, bytes = 8) {
    const av = antivirusFixture(securitySubject(lease, bytes), at);
    const execution = {
      version: 3 as const,
      antivirus: av.custody,
      custody: { kind: 'none' as const },
      attemptId: `${lease.operationId}.${lease.generation}`,
      instanceId: '11111111-1111-4111-8111-111111111111',
      executionId: '22222222-2222-4222-8222-222222222222',
      expiresAt: new Date(at + 60_000).toISOString(),
    };
    await first.bindSecurityExecution(lease, execution, at);
    await second.settleSecurityExecution(
      lease,
      { execution, antivirusReceipt: av.receipt, writerStopped: true, transientDataRemoved: true },
      at,
    );
    const original = receipt(lease, bytes);
    await first.bindOriginalWrite(
      lease,
      {
        bucket: 'isolated',
        key: original.storageKey,
        operationId: lease.operationId,
        generation: String(lease.generation),
        bytes,
        wholeSHA256: original.integrity.sha256,
        mediaType: 'text/plain',
      },
      original.integrity,
      approval(lease, bytes, at),
      at,
    );
  }

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await Promise.all([
      a.connect(mongo.getUri('uploads')),
      b.connect(mongo.getUri('uploads'), { monitorCommands: true }),
      replacement.connect(mongo.getUri('replacement')),
    ]);
    for (const db of [a, b, replacement]) createModels(db);
    await Promise.all([a.models.File.init(), b.models.File.init(), replacement.models.File.init()]);
  });
  beforeEach(async () => {
    for (const db of [a, replacement]) {
      for (const name of [
        'User',
        'File',
        'Message',
        'UploadOperation',
        'UploadCounter',
        'HousekeepingJob',
        'FileCleanupTarget',
      ])
        if (db.models[name]) await db.models[name].deleteMany({});
      await db.models.User.create(
        [user, other, guest, stranger].map((principal) => ({
          _id: principal.userId,
          tenantId: principal.tenantId,
          email: `${principal.userId}@upload.example.test`,
          emailVerified: principal.authentication === 'verified-email',
        })),
      );
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

  async function accepted(id: string, bytes = 8, at = now, principal = user) {
    const reservation = await first.reserve(principal, request(id, bytes), at);
    const lease = await first.claim({
      kind: 'transfer',
      principal,
      operationId: reservation.id,
      worker,
      now: at,
    });
    expect(lease).not.toBeNull();
    await completeScanner(lease!, at, bytes);
    const operation = await second.accept(
      principal,
      lease!,
      receipt(lease!, bytes),
      approval(lease!, bytes, at),
      { filename: 'note.txt' },
      at,
    );
    await first.confirmCleanup(localGone(lease!), at);
    return { operation, lease: lease! };
  }

  it('keeps explicit null guest rows isolated from both other users and missing tenant data', async () => {
    const row = await first.reserve(guest, request('guest-reservation'), now);
    expect(await second.get(guest, row.id, now)).toMatchObject({ id: row.id });
    await expect(second.get(stranger, row.id, now)).rejects.toMatchObject({ code: 'not_found' });
    await expect(second.get(user, row.id, now)).rejects.toMatchObject({ code: 'not_found' });
    await expect(second.get({ ...user, userId: guest.userId }, row.id, now)).rejects.toMatchObject({
      code: 'not_found',
    });
    const stored = await a.models.UploadOperation.findById(row.id).lean();
    expect(stored).toHaveProperty('tenantId', null);
    await a.connection
      .db!.collection<StoredUpload>(a.models.UploadOperation.collection.name)
      .updateOne({ _id: row.id }, { $unset: { tenantId: '' } });
    await expect(second.get(guest, row.id, now)).rejects.toMatchObject({ code: 'not_found' });
  });
  async function processing(id: string, at = now) {
    const lease = await second.claim({ kind: 'processing', worker, now: at });
    expect(lease?.operationId).toBe(id);
    await first.bindProcessingExecution(
      lease!,
      {
        attemptId: `${id}.${lease!.generation}`,
        instanceId: 'parser-a',
        expiresAt: new Date(at + 60_000).toISOString(),
      },
      at,
    );
    return lease!;
  }
  async function ready(id: string, bytes = 8, at = now, principal = user) {
    const result = await accepted(id, bytes, at, principal);
    const lease = await processing(result.operation.id, at);
    await first.publish(lease, documentResult('document', bytes), at);
    await second.confirmCleanup(localGone(lease), at);
    return result;
  }
  async function storeId(db: mongoose.Mongoose) {
    const row = await db.models.UploadCounter.findById('global').lean<{
      value: { storeId: string };
    }>();
    return row!.value.storeId;
  }
  async function initialProof(repo = target, db = replacement) {
    const snapshot = await repo.reconciliationSnapshot(now);
    return {
      storeId: await storeId(db),
      revision: snapshot.revision,
      baseline: snapshot.baseline,
      inventoryEvidenceId: 'positive-empty-inventory-fixture',
      observedAt: snapshot.observedAt,
      historyCopiesAccounted: true as const,
      admission: 'initial-empty' as const,
      originalDeadline: new Date(now + 60_000).toISOString(),
    };
  }

  it.each([
    ['legacy filename', { filename: 'SECRET-before-approval.txt' }],
    ['unknown metadata', { title: 'SECRET-before-approval' }],
    ['free text key', { idempotencyKey: 'SECRET-before-approval.txt' }],
    ['uppercase UUID', { idempotencyKey: fixtureKey('case').toUpperCase() }],
    ['other UUID version', { idempotencyKey: '11111111-1111-5111-8111-111111111111' }],
  ])('rejects %s before creating a durable reservation', async (_label, extra) => {
    await expect(
      first.reserve(user, { ...request('invalid-metadata'), ...extra }, now),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await b.models.UploadOperation.countDocuments()).toBe(0);
    expect(await second.usage(user, now)).toMatchObject({
      usedBytes: 0,
      reservedBytes: 0,
      retainedBytes: 0,
    });
  });

  it('rejects hidden filename and accessor request fields without evaluating them', async () => {
    for (const input of [
      Object.defineProperty(request('hidden-name'), 'filename', { value: 'SECRET' }),
      Object.defineProperty(request('accessor-name'), 'mediaType', {
        get: () => {
          throw new Error('must not execute');
        },
      }),
    ]) {
      await expect(first.reserve(user, input, now)).rejects.toMatchObject({
        code: 'invalid_request',
      });
    }
    expect(await b.models.UploadOperation.countDocuments()).toBe(0);
  });

  it('keeps technical reservations nameless and snapshots caller scope before Mongo waits', async () => {
    const input = { ...request('technical'), scope: { kind: 'personal' as const } };
    const reservation = first.reserve(user, input, now);
    Object.assign(input.scope, { filename: 'SECRET-mutated.txt' });
    input.idempotencyKey = 'SECRET-mutated.txt';
    const operation = await reservation;
    expect(operation).not.toHaveProperty('filename');
    expect((await second.list(user, now))[0]).not.toHaveProperty('filename');
    const row = await b.models.UploadOperation.findById('technical').lean();
    expect(row).not.toHaveProperty('filename');
    expect(row).toMatchObject({
      fingerprint: JSON.stringify([{ kind: 'personal' }, 'text/plain', 8]),
      idempotencyKey: fixtureKey('technical'),
      scope: { kind: 'personal' },
    });
    expect(JSON.stringify(row)).not.toContain('SECRET');
  });

  it('captures Unicode metadata atomically with File and rejects a renamed acceptance replay', async () => {
    await first.reserve(user, request('unicode'), now);
    const lease = (await first.claim({
      kind: 'transfer',
      principal: user,
      operationId: 'unicode',
      worker,
      now,
    }))!;
    await completeScanner(lease, now);
    const metadata = { filename: 'Öffentliche Übersicht 🧪.txt' };
    const filename = metadata.filename;
    const pending = first.accept(user, lease, receipt(lease), approval(lease), metadata, now);
    metadata.filename = 'late-mutated.txt';
    const operation = await pending;
    expect(operation.filename).toBe(filename);
    const row = await b.models.UploadOperation.findById('unicode').lean();
    const file = await b.models.File.findOne({ file_id: 'unicode' })
      .select('+securityApproval')
      .lean();
    expect(row).toMatchObject({
      filename,
      securityApproval: approval(lease),
      state: 'queued_processing',
    });
    expect(file).toMatchObject({ filename, securityApproval: approval(lease) });
    const quota = await second.usage(user, now);
    expect(quota).toMatchObject({ usedBytes: 8, reservedBytes: 0, retainedBytes: 8 });
    expect(
      await second.accept(user, lease, receipt(lease), approval(lease), { filename }, now + 1),
    ).toEqual(operation);
    await expect(
      second.accept(user, lease, receipt(lease), approval(lease), metadata, now + 1),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(await first.usage(user, now)).toEqual(quota);
    expect(await b.models.File.countDocuments({ file_id: 'unicode' })).toBe(1);
    expect(
      (await b.models.UploadOperation.findById('unicode').lean<StoredUpload>())?.filename,
    ).toBe(filename);
  });

  it.each([
    undefined,
    {},
    { filename: '' },
    { filename: '../secret' },
    { filename: 'x', extra: true },
  ])('does not persist malformed accepted metadata %j', async (metadata) => {
    await first.reserve(user, request('bad-accepted-metadata'), now);
    const lease = (await first.claim({
      kind: 'transfer',
      principal: user,
      operationId: 'bad-accepted-metadata',
      worker,
      now,
    }))!;
    await completeScanner(lease, now);
    await expect(
      first.accept(
        user,
        lease,
        receipt(lease),
        approval(lease),
        metadata as { filename: string },
        now,
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    const row = await b.models.UploadOperation.findById(lease.operationId).lean();
    expect(row).not.toHaveProperty('filename');
    expect(row).not.toHaveProperty('acceptedAt');
    expect(await b.models.File.countDocuments()).toBe(0);
    expect(await second.usage(user, now)).toMatchObject({ usedBytes: 0, reservedBytes: 8 });
  });

  it('redacts legacy metadata once at frozen export while retaining accepted names and cleanup fences', async () => {
    await accepted('accepted-legacy');
    await first.reserve(other, request('pending-legacy'), now);
    const lease = (await first.claim({
      kind: 'transfer',
      principal: other,
      operationId: 'pending-legacy',
      worker,
      now,
    }))!;
    await completeScanner(lease, now);
    await first.fail(lease, 'security_rejected', now);
    await first.confirmCleanup(localGone(lease), now);
    await first.reserve(user, request('waiting-legacy'), now);
    for (const id of ['accepted-legacy', 'pending-legacy', 'waiting-legacy']) {
      const filename = id === 'accepted-legacy' ? 'note.txt' : 'SECRET-unaccepted.txt';
      await a.models.UploadOperation.updateOne(
        { _id: id },
        {
          $set: {
            filename,
            idempotencyKey: `SECRET-legacy-key-${id}`,
            fingerprint: JSON.stringify([{ kind: 'personal' }, filename, 'text/plain', 8]),
          },
        },
      );
    }
    const before = await b.models.UploadOperation.findById('pending-legacy').lean<StoredUpload>();
    const quota = await second.usage(other, now);
    const page = await first.exportSnapshot({ epoch: 'metadata-move' });
    expect(await second.exportSnapshot({ epoch: 'metadata-move' })).toEqual(page);
    expect(JSON.stringify(page)).not.toContain('SECRET');
    const source = await b.models.UploadOperation.find().lean<StoredUpload[]>();
    expect(JSON.stringify(source)).not.toContain('SECRET');
    for (const row of source) {
      expect(row.idempotencyKey).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(row.fingerprint).toBe(JSON.stringify([{ kind: 'personal' }, 'text/plain', 8]));
      if (row._id === 'accepted-legacy') expect(row.filename).toBe('note.txt');
      else expect(row).not.toHaveProperty('filename');
    }
    const after = source.find((row) => row._id === 'pending-legacy')!;
    for (const field of [
      'generation',
      'attemptGeneration',
      'workerGeneration',
      'worker',
      'writerStopped',
      'stagingHeld',
      'cleanupPending',
      'originalBytes',
      'pendingBytes',
      'securityExecution',
      'securitySettlement',
    ] as const) {
      expect(after[field]).toEqual(before?.[field]);
    }
    expect(after.cleanupPending).toBe(true);
    expect(after).not.toHaveProperty('securityApproval');
    await copyFrozenUploadFiles(a, replacement);
    await target.importSnapshot(page);
    expect(await replacement.models.UploadOperation.findById('pending-legacy').lean()).toEqual(
      after,
    );
    expect(await second.usage(other, now)).toEqual(quota);
    const tampered = JSON.parse(JSON.stringify(page)) as UploadMigrationPage;
    const record = tampered.records.find(
      (item) =>
        item.type === 'operation' && (item.value as { _id: string })._id === 'waiting-legacy',
    )!;
    (record.value as { filename?: string }).filename = 'SECRET-returned.txt';
    await expect(target.importSnapshot(tampered)).rejects.toMatchObject({
      code: 'migration_conflict',
    });
  });

  it('defaults to disabled and never enables an existing authority through initialization', async () => {
    await expect(target.reserve(user, request('disabled'), now)).rejects.toMatchObject({
      code: 'unavailable',
    });
    await createUploadManagementRepository(replacement, {
      enabled: true,
      reconciled: true,
      baseline,
    }).initialize();
    await expect(target.reserve(user, request('still-disabled'), now)).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('requires a fresh fenced inventory proof for private activation and never rebaselines a live ledger', async () => {
    const snapshot = await target.reconciliationSnapshot(now);
    const inventory = { ...baseline, originalBytes: 10, objectBytes: 10 };
    const proof = {
      storeId: await storeId(replacement),
      revision: snapshot.revision,
      baseline: inventory,
      inventoryEvidenceId: 'isolated-inventory-fixture',
      observedAt: new Date(now).toISOString(),
      historyCopiesAccounted: true as const,
    };
    await expect(
      target.activateReconciled(
        { ...proof, historyCopiesAccounted: false } as unknown as typeof proof,
        now,
      ),
    ).rejects.toMatchObject({ code: 'not_ready' });
    await target.claimController({ ownerId: 'intervening-writer', now });
    await expect(target.activateReconciled(proof, now)).rejects.toMatchObject({
      code: 'not_ready',
    });
    proof.revision = (await target.reconciliationSnapshot(now)).revision;
    await expect(target.activateReconciled(proof, now + 300_001)).rejects.toMatchObject({
      code: 'not_ready',
    });
    await expect(
      target.activateReconciled(
        { ...proof, baseline: { ...inventory, objectBytes: RESOURCE_MAX.objectBytes + 1 } },
        now,
      ),
    ).rejects.toMatchObject({ code: 'capacity_exceeded' });
    await target.activateReconciled(proof, now);
    await target.reserve(user, request('after-activation'), now);
    await target.activateReconciled(proof, now);
    expect((await target.metrics(now)).originalBytes).toBe(18);
    await expect(target.reconciliationSnapshot(now)).rejects.toMatchObject({ code: 'not_ready' });
  });

  it('preserves the all-tenant File liability floor once alongside the native operation ledger', async () => {
    await ready('accounted-source');
    await a.models.File.updateOne(
      { file_id: 'accounted-source' },
      {
        $set: {
          retainedDerivativeBytes: 4352,
          retainedDerivativeReservations: [
            { reservationId: 'a'.repeat(64), bytes: 3072, state: 'held' },
          ],
        },
      },
    );
    await a.models.Message.create({
      messageId: 'accounted-copy',
      conversationId: 'history',
      user: user.userId,
      tenantId: user.tenantId,
      text: 'retained answer',
      sourceFileIds: ['accounted-source'],
      retainedTextAllocations: [{ fileId: 'accounted-source', bytes: 1024 }],
    });
    await a.models.File.create({
      file_id: 'other-tenant-liability',
      user: other.userId,
      tenantId: 'tenant-b',
      filename: 'other.txt',
      filepath: '/owned/other',
      type: 'text/plain',
      bytes: 1,
      retentionAcceptedAt: new Date(now),
      expiredAt: new Date(now + UPLOAD_RETENTION_MS),
      retainedDerivativeBytes: 512,
    });
    const liability = 4864;
    await a.models.UploadCounter.updateOne(
      { _id: 'global' },
      {
        $set: { 'value.enabled': false },
        $inc: { 'value.textBytes': liability, 'value.baseline.textBytes': liability },
      },
    );
    await tenantStorage.run({ tenantId: user.tenantId }, async () => {
      const snapshot = await first.reconciliationSnapshot(now);
      const proof = {
        storeId: await storeId(a),
        revision: snapshot.revision,
        baseline: snapshot.baseline,
        inventoryEvidenceId: 'all-tenant-fixture',
        observedAt: new Date(now).toISOString(),
        historyCopiesAccounted: true as const,
      };
      expect(snapshot.ledgerTotals.textBytes).toBeGreaterThan(0);
      await expect(
        first.activateReconciled(
          { ...proof, baseline: { ...proof.baseline, textBytes: 4352 } },
          now,
        ),
      ).rejects.toMatchObject({ code: 'not_ready' });
      expect((await first.metrics(now)).textBytes).toBe(
        snapshot.ledgerTotals.textBytes + liability,
      );
      await first.activateReconciled(proof, now);
      expect((await first.metrics(now)).textBytes).toBe(
        snapshot.ledgerTotals.textBytes + liability,
      );
    });
  });

  it.each(['missing', 'fractional', 'negative'] as const)(
    'rejects %s retained File accounting instead of inferring a baseline',
    async (kind) => {
      await replacement.models.File.create({
        file_id: 'legacy-file',
        user: user.userId,
        tenantId: user.tenantId,
        filename: 'legacy.txt',
        filepath: '/owned/legacy',
        type: 'text/plain',
        bytes: 1,
        retentionAcceptedAt: new Date(now),
        expiredAt: new Date(now + UPLOAD_RETENTION_MS),
      });
      await replacement.models.File.collection.updateOne(
        { file_id: 'legacy-file' },
        kind === 'missing'
          ? { $unset: { retainedDerivativeBytes: '' } }
          : { $set: { retainedDerivativeBytes: kind === 'negative' ? -1 : 0.5 } },
      );
      const snapshot = await target.reconciliationSnapshot(now);
      const proof = {
        storeId: await storeId(replacement),
        revision: snapshot.revision,
        baseline,
        inventoryEvidenceId: 'legacy-file-fixture',
        observedAt: new Date(now).toISOString(),
        historyCopiesAccounted: true as const,
      };
      await expect(target.activateReconciled(proof, now)).rejects.toMatchObject({
        code: 'not_ready',
      });
      await expect(target.reserve(user, request('unreconciled'), now)).rejects.toMatchObject({
        code: 'unavailable',
      });
    },
  );

  it.each(['body', 'private', 'structured', 'quotation'] as const)(
    'rejects surviving %s copies without stored allocation receipts',
    async (kind) => {
      await replacement.models.Message.create({
        messageId: 'legacy-copy',
        conversationId: 'history',
        user: user.userId,
        tenantId: 'tenant-b',
        text: kind === 'body' ? 'retained answer' : '',
        ...(kind === 'quotation'
          ? {
              quotes: ['retained quotation'],
              quoteSourceRetention: [
                {
                  index: 0,
                  sourceRef: { messageId: 'source' },
                  sourceFileIds: ['source-file'],
                  sourceExpiresAt: new Date(now + UPLOAD_RETENTION_MS),
                },
              ],
            }
          : { sourceFileIds: ['source-file'] }),
        ...(kind === 'private' ? { privateText: 'encrypted document content' } : {}),
        ...(kind === 'structured'
          ? {
              content: [{ type: 'text', text: 'retained structured answer' }],
              retainedTextAllocations: [],
            }
          : {}),
      });
      const snapshot = await target.reconciliationSnapshot(now);
      const proof = {
        storeId: await storeId(replacement),
        revision: snapshot.revision,
        baseline,
        inventoryEvidenceId: 'legacy-message-fixture',
        observedAt: new Date(now).toISOString(),
        historyCopiesAccounted: true as const,
      };
      await expect(
        tenantStorage.run({ tenantId: user.tenantId }, async () =>
          target.activateReconciled(proof, now),
        ),
      ).rejects.toMatchObject({ code: 'not_ready' });
    },
  );

  it('does not invent liability for empty or fully redacted retained history', async () => {
    await replacement.models.Message.create([
      {
        messageId: 'empty-copy',
        conversationId: 'history',
        user: user.userId,
        tenantId: user.tenantId,
        sourceFileIds: ['gone-source'],
        text: '',
        content: [],
        retainedTextAllocations: [],
      },
      {
        messageId: 'removed-copy',
        conversationId: 'history',
        user: user.userId,
        tenantId: user.tenantId,
        sourceFileIds: ['gone-source'],
        text: '',
        content: [],
        sourceContentRemovedAt: new Date(now),
        retainedTextAllocations: [],
      },
      {
        messageId: 'empty-quote',
        conversationId: 'history',
        user: user.userId,
        tenantId: user.tenantId,
        text: 'unbound ordinary body',
        quotes: [''],
        retainedTextAllocations: [],
        quoteSourceRetention: [
          {
            index: 0,
            sourceRef: { messageId: 'source' },
            sourceFileIds: ['gone-source'],
            sourceExpiresAt: new Date(now),
          },
        ],
      },
    ]);
    const snapshot = await target.reconciliationSnapshot(now);
    const proof = {
      storeId: await storeId(replacement),
      revision: snapshot.revision,
      baseline,
      inventoryEvidenceId: 'redacted-message-fixture',
      observedAt: new Date(now).toISOString(),
      historyCopiesAccounted: true as const,
    };
    await target.activateReconciled(proof, now);
    expect((await target.metrics(now)).textBytes).toBe(0);
  });

  describe('initial-empty activation', () => {
    it('returns the persisted store identity and saturated cross-tenant population census', async () => {
      expect(await target.reconciliationSnapshot(now)).toMatchObject({
        storeId: await storeId(replacement),
        initialInventory: { operations: 0, files: 0, sourceMessages: 0 },
      });
      for (const id of ['one', 'two']) {
        await first.reserve(user, request(id), now);
        await a.models.File.create({
          file_id: id,
          user: other.userId,
          tenantId: 'tenant-b',
          filename: `${id}.txt`,
          filepath: `/owned/${id}`,
          type: 'text/plain',
          bytes: 1,
        });
        await a.models.Message.create({
          messageId: id,
          conversationId: 'history',
          user: other.userId,
          tenantId: 'tenant-b',
          text: 'retained answer',
          sourceFileIds: [id],
          retainedTextAllocations: [{ fileId: id, bytes: 1 }],
        });
      }
      await a.models.UploadCounter.updateOne(
        { _id: 'global' },
        { $set: { 'value.enabled': false } },
      );
      await tenantStorage.run({ tenantId: user.tenantId }, async () => {
        expect(await first.reconciliationSnapshot(now)).toMatchObject({
          storeId: await storeId(a),
          initialInventory: { operations: 1, files: 1, sourceMessages: 1 },
        });
      });
    });

    it('allows ordinary history, empty source bodies and removed source quotations without changing the zero baseline', async () => {
      await replacement.models.Message.create([
        {
          messageId: 'ordinary',
          conversationId: 'history',
          user: user.userId,
          text: 'ordinary answer',
        },
        {
          messageId: 'empty',
          conversationId: 'history',
          user: user.userId,
          sourceFileIds: ['gone'],
          text: '',
          content: [],
          retainedTextAllocations: [],
        },
        {
          messageId: 'redacted',
          conversationId: 'history',
          user: user.userId,
          sourceFileIds: ['gone'],
          text: '',
          sourceContentRemovedAt: new Date(now),
          retainedTextAllocations: [],
        },
        {
          messageId: 'quotation',
          conversationId: 'history',
          user: user.userId,
          text: 'ordinary body',
          quotes: [''],
          quoteSourceRetention: [
            {
              index: 0,
              sourceRef: { messageId: 'source' },
              sourceFileIds: ['gone'],
              sourceExpiresAt: new Date(now),
            },
          ],
        },
      ]);
      const proof = await initialProof();
      await target.activateReconciled(proof, now);
      expect(
        (await replacement.models.UploadCounter.findById('global').lean<{ value: GlobalState }>())!
          .value,
      ).toMatchObject({ baseline, enabled: true, reconciled: true });
      expect(await replacement.models.Message.countDocuments()).toBe(4);
    });

    it('rejects a File added after preparation and preserves its row and disabled authority', async () => {
      const proof = await initialProof();
      await replacement.models.File.create({
        file_id: 'late-file',
        user: other.userId,
        tenantId: 'tenant-b',
        filename: 'late.txt',
        filepath: '/owned/late',
        type: 'text/plain',
        bytes: 1,
      });
      await expect(target.activateReconciled(proof, now)).rejects.toMatchObject({
        code: 'not_ready',
      });
      expect(await replacement.models.File.countDocuments()).toBe(1);
      expect(
        (await replacement.models.UploadCounter.findById('global').lean<{ value: GlobalState }>())!
          .value,
      ).toMatchObject({ baseline, enabled: false });
    });

    it.each(['body', 'private', 'structured', 'quotation'] as const)(
      'rejects a surviving accounted %s copy added after preparation',
      async (kind) => {
        const proof = await initialProof();
        await replacement.models.Message.create({
          messageId: 'late-copy',
          conversationId: 'history',
          user: other.userId,
          tenantId: 'tenant-b',
          text: kind === 'body' ? 'retained answer' : '',
          retainedTextAllocations: [{ fileId: 'source', bytes: 1 }],
          ...(kind === 'quotation'
            ? {
                quotes: ['retained quote'],
                quoteSourceRetention: [
                  {
                    index: 0,
                    sourceRef: { messageId: 'source' },
                    sourceFileIds: ['source'],
                    sourceExpiresAt: new Date(now + UPLOAD_RETENTION_MS),
                  },
                ],
              }
            : { sourceFileIds: ['source'] }),
          ...(kind === 'private' ? { privateText: 'encrypted retained answer' } : {}),
          ...(kind === 'structured'
            ? { content: [{ type: 'text', text: 'retained answer' }] }
            : {}),
        });
        await expect(
          tenantStorage.run({ tenantId: user.tenantId }, async () =>
            target.activateReconciled(proof, now),
          ),
        ).rejects.toMatchObject({ code: 'not_ready' });
        expect(await replacement.models.Message.countDocuments()).toBe(1);
      },
    );

    it.each(['baseline', 'ledger'] as const)(
      'rejects nonzero %s without repricing or dropping existing rows',
      async (kind) => {
        const db = kind === 'ledger' ? a : replacement;
        const repo = kind === 'ledger' ? first : target;
        if (kind === 'ledger') {
          await first.reserve(user, request('retained-ledger'), now);
          await a.models.UploadCounter.updateOne(
            { _id: 'global' },
            { $set: { 'value.enabled': false } },
          );
        } else {
          await replacement.models.UploadCounter.updateOne(
            { _id: 'global' },
            {
              $set: {
                'value.originalBytes': 10,
                'value.objectBytes': 10,
                'value.baseline.originalBytes': 10,
                'value.baseline.objectBytes': 10,
              },
            },
          );
        }
        const proof = await initialProof(repo, db);
        const before = await db.models.UploadCounter.findById('global').lean();
        await expect(repo.activateReconciled(proof, now)).rejects.toMatchObject({
          code: 'not_ready',
        });
        expect(await db.models.UploadCounter.findById('global').lean()).toEqual(before);
        expect(await db.models.UploadOperation.countDocuments()).toBe(kind === 'ledger' ? 1 : 0);
      },
    );

    it.each(['missing', 'different'] as const)(
      'rejects a %s store identity even at the same revision',
      async (kind) => {
        await a.models.UploadCounter.updateOne(
          { _id: 'global' },
          { $set: { 'value.enabled': false } },
        );
        const otherProof = await initialProof(first, a);
        const proof = await initialProof();
        expect(otherProof.revision).toBe(proof.revision);
        const invalid = {
          ...proof,
          storeId: kind === 'missing' ? undefined : otherProof.storeId,
        } as typeof proof;
        await expect(target.activateReconciled(invalid, now)).rejects.toMatchObject({
          code: 'not_ready',
        });
      },
    );

    it('checks store identity before an exact copied proof can replay', async () => {
      const proof = { ...(await initialProof()), storeId: 'foreign-store' };
      await replacement.models.UploadCounter.updateOne(
        { _id: 'global' },
        {
          $set: {
            'value.activationProof': proof,
            'value.enabled': true,
            'value.reconciled': true,
          },
        },
      );
      await expect(target.activateReconciled(proof, now)).rejects.toMatchObject({
        code: 'not_ready',
      });
    });

    it.each(['legacy', 'unsettled', 'rebound'] as const)(
      'rejects %s security custody both at activation and committed-proof replay',
      async (kind) => {
        const proof = await initialProof();
        const current = {
          version: 2,
          custody: { kind: 'none' },
          attemptId: 'cutover-fixture.1',
          instanceId: '11111111-1111-4111-8111-111111111111',
          executionId: '22222222-2222-4222-8222-222222222222',
          expiresAt: new Date(now + 60_000).toISOString(),
        };
        for (const replay of [false, true]) {
          if (replay) await target.activateReconciled(proof, now);
          const value = kind === 'legacy' ? { ...current, version: 1 } : current;
          const fixture = {
            _id: 'cutover-fixture',
            mediaType: 'text/plain',
            attemptGeneration: 1,
            securityExecution: value,
            securitySettlement: {
              execution:
                kind === 'rebound'
                  ? { ...value, executionId: '33333333-3333-4333-8333-333333333333' }
                  : value,
              writerStopped: true,
              transientDataRemoved: kind !== 'unsettled',
            },
          };
          const collection = replacement.connection.db!.collection<typeof fixture>(
            replacement.models.UploadOperation.collection.name,
          );
          await collection.insertOne(fixture);
          const before = await replacement.models.UploadCounter.findById('global').lean();
          await expect(target.activateReconciled(proof, now)).rejects.toMatchObject({
            code: 'not_ready',
          });
          expect(await replacement.models.UploadCounter.findById('global').lean()).toEqual(before);
          await collection.deleteOne({ _id: 'cutover-fixture' });
        }
      },
    );

    it('replays only the exact committed active proof after its original deadline without resetting later usage', async () => {
      const proof = await initialProof();
      await target.activateReconciled(proof, now);
      await target.reserve(user, request('after-initial-activation'), now);
      await target.activateReconciled(proof, now + 300_001);
      expect((await target.metrics(now + 300_001)).bundles).toBe(1);
      await expect(
        target.activateReconciled(
          { ...proof, inventoryEvidenceId: 'different-proof' },
          now + 300_001,
        ),
      ).rejects.toMatchObject({ code: 'not_ready' });
    });

    it.each(['disabled', 'unreconciled', 'exporting', 'retired'] as const)(
      'never replays an exact proof from a %s authority',
      async (state) => {
        const proof = await initialProof();
        await target.activateReconciled(proof, now);
        if (state === 'exporting' || state === 'retired') {
          await target.exportSnapshot({ epoch: 'after-activation' });
          if (state === 'retired') await target.completeExport('after-activation');
        } else {
          await replacement.models.UploadCounter.updateOne(
            { _id: 'global' },
            {
              $set: {
                [`value.${state === 'disabled' ? 'enabled' : 'reconciled'}`]: false,
              },
            },
          );
        }
        const before = await replacement.models.UploadCounter.findById('global').lean();
        await expect(target.activateReconciled(proof, now + 300_001)).rejects.toMatchObject({
          code: state === 'exporting' || state === 'retired' ? 'migration_conflict' : 'not_ready',
        });
        expect(await replacement.models.UploadCounter.findById('global').lean()).toEqual(before);
      },
    );

    it.each(['missing', 'noncanonical', 'before-observation', 'beyond-window'] as const)(
      'rejects a %s original deadline',
      async (kind) => {
        const proof = await initialProof();
        let originalDeadline: string | undefined;
        if (kind === 'noncanonical')
          originalDeadline = proof.originalDeadline.replace('Z', '+00:00');
        else if (kind !== 'missing')
          originalDeadline = new Date(
            now + (kind === 'before-observation' ? -1 : 300_001),
          ).toISOString();
        await expect(
          target.activateReconciled({ ...proof, originalDeadline } as typeof proof, now),
        ).rejects.toMatchObject({ code: 'not_ready' });
      },
    );

    it('rejects an uncommitted proof at the original deadline and accepts the 300-second upper boundary before expiry', async () => {
      const proof = await initialProof();
      await expect(target.activateReconciled(proof, now + 60_000)).rejects.toMatchObject({
        code: 'not_ready',
      });
      await target.activateReconciled(
        { ...proof, originalDeadline: new Date(now + 300_000).toISOString() },
        now + 299_999,
      );
    });

    it('propagates an unavailable census instead of recording an empty population', async () => {
      const unavailable = new Error('bounded inventory unavailable');
      const aggregate = jest
        .spyOn(replacement.models.File.collection, 'aggregate')
        .mockImplementationOnce(() => {
          throw unavailable;
        });
      try {
        await expect(target.reconciliationSnapshot(now)).rejects.toBe(unavailable);
      } finally {
        aggregate.mockRestore();
      }
      expect(
        (await replacement.models.UploadCounter.findById('global').lean<{ value: GlobalState }>())!
          .value.reconciliationFence,
      ).toBeUndefined();
    });
  });

  it.each([0, -1, 1.5, UPLOAD_MAX_FILE_BYTES + 1])(
    'rejects invalid size %s before booking',
    async (bytes) => {
      await expect(first.reserve(user, request('bad', bytes), now)).rejects.toMatchObject({
        code: 'invalid_request',
      });
      expect((await first.metrics(now)).bundles).toBe(0);
    },
  );

  it('books one operation across two clients and rejects changed idempotent payloads', async () => {
    const input = request('same');
    const results = await Promise.all([
      first.reserve(user, input, now),
      second.reserve(user, { ...input, operationId: 'other-id' }, now),
    ]);
    expect(results[0].id).toBe(results[1].id);
    expect((await first.metrics(now)).bundles).toBe(1);
    await expect(first.reserve(user, { ...request('same', 9) }, now)).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
  });

  it('atomically enforces two outstanding operations per user', async () => {
    const results = await Promise.allSettled([
      first.reserve(user, request('one'), now),
      second.reserve(user, request('two'), now),
      first.reserve(user, request('three'), now),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'queue_full' },
    });
    expect((await second.usage(user, now)).reservedBytes).toBe(16);
  });

  it('enforces exact rolling quota, activity-extended expiry and deletion without a refund', async () => {
    for (let i = 0; i < 10; i++) await ready(`quota-${i}`, UPLOAD_MAX_FILE_BYTES);
    const before = await first.usage(user, now);
    expect(before).toMatchObject({
      usedBytes: UPLOAD_USER_WINDOW_BYTES,
      reservedBytes: 0,
      availableBytes: 0,
      nextReleaseBytes: UPLOAD_USER_WINDOW_BYTES,
    });
    await expect(second.reserve(user, request('over-quota', 1), now)).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    await first.delete(user, 'quota-0', now + 1);
    expect((await second.usage(user, now + 1)).usedBytes).toBe(UPLOAD_USER_WINDOW_BYTES);
    expect((await first.get(user, 'quota-0', now + 1)).expiresAt).toBe(
      new Date(now + UPLOAD_RETENTION_MS + 7 * 86_400_000).toISOString(),
    );
    expect((await second.usage(user, now + UPLOAD_WINDOW_MS - 1)).usedBytes).toBe(
      UPLOAD_USER_WINDOW_BYTES,
    );
    expect((await first.usage(user, now + UPLOAD_WINDOW_MS)).usedBytes).toBe(0);
  }, 30_000);

  it.each(['concurrent', 'second replica first'] as const)(
    'shares guest quota/idempotence across replicas and retains every accepted debit through delete and replacement (%s)',
    async (ordering) => {
      const duplicate = request('guest-0', UPLOAD_MAX_FILE_BYTES);
      if (ordering === 'second replica first')
        await second.reserve(guest, { ...duplicate, operationId: 'ignored-id' }, now);
      const pair = await Promise.all([
        first.reserve(guest, duplicate, now),
        second.reserve(guest, { ...duplicate, operationId: 'ignored-id' }, now),
      ]);
      expect(pair[0].id).toBe(pair[1].id);
      for (let index = 0; index < 10; index++)
        await ready(`guest-${index}`, UPLOAD_MAX_FILE_BYTES, now, guest);
      expect((await first.usage(guest, now)).usedBytes).toBe(UPLOAD_USER_WINDOW_BYTES);
      expect((await first.usage({ ...user, userId: guest.userId }, now)).usedBytes).toBe(0);
      expect((await first.usage(stranger, now)).usedBytes).toBe(0);
      await expect(second.reserve(guest, request('guest-over', 1), now)).rejects.toMatchObject({
        code: 'quota_exceeded',
      });
      await first.delete(guest, pair[0].id, now + 1);
      expect((await second.usage(guest, now + 1)).usedBytes).toBe(UPLOAD_USER_WINDOW_BYTES);
      const task = await first.cleanupForFile({ tenantId: null, userId: guest.userId }, pair[0].id);
      expect(task?.principal).toEqual(guest);
      expect(task?.original?.storageKey).toBe(
        `managed-uploads/${guest.userId}/${pair[0].id}.1__original`,
      );
      const page = await first.exportSnapshot({ epoch: 'guest-move', limit: 100 });
      await copyFrozenUploadFiles(a, replacement);
      await target.importSnapshot(page);
      const seal = await first.completeExport('guest-move');
      await target.completeImport({ receipt: seal, baseline, lifecycleReconciled: true });
      expect(await target.usage(guest, now)).toEqual(await first.usage(guest, now));
      expect((await target.get(guest, 'guest-1', now)).expiresAt).toBe(
        new Date(now + UPLOAD_RETENTION_MS + 7 * 86_400_000).toISOString(),
      );
      expect((await target.usage(guest, now + UPLOAD_WINDOW_MS - 1)).usedBytes).toBe(
        UPLOAD_USER_WINDOW_BYTES,
      );
      expect((await target.usage(guest, now + UPLOAD_WINDOW_MS)).usedBytes).toBe(0);
    },
    30000,
  );

  it('does not classify missing or malformed tenant snapshots as guest migrations', async () => {
    await first.reserve(guest, request('malformed-guest'), now);
    await a.connection
      .db!.collection<StoredUpload>(a.models.UploadOperation.collection.name)
      .updateOne({ _id: 'malformed-guest' }, { $unset: { tenantId: '' } });
    await expect(
      first.exportSnapshot({ epoch: 'missing-guest', limit: 100 }),
    ).rejects.toMatchObject({ code: 'migration_conflict' });
    await a.connection
      .db!.collection<{ _id: string; tenantId: unknown }>(a.models.UploadOperation.collection.name)
      .updateOne({ _id: 'malformed-guest' }, { $set: { tenantId: 42 } });
    await expect(
      first.exportSnapshot({ epoch: 'invalid-guest', limit: 100 }),
    ).rejects.toMatchObject({ code: 'migration_conflict' });
  });

  it('uses a shared global capacity fence across principals and replicas', async () => {
    await a.models.UploadCounter.deleteMany({});
    await createUploadManagementRepository(a, {
      enabled: true,
      reconciled: true,
      baseline: {
        ...baseline,
        originalBytes: RESOURCE_MAX.originalBytes - UPLOAD_MAX_FILE_BYTES,
        objectBytes: RESOURCE_MAX.originalBytes - UPLOAD_MAX_FILE_BYTES,
      },
    }).initialize();
    const results = await Promise.allSettled([
      first.reserve(user, request('a', UPLOAD_MAX_FILE_BYTES), now),
      second.reserve(other, request('b', UPLOAD_MAX_FILE_BYTES), now),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'capacity_exceeded' },
    });
  });

  it('retains a lost transfer slot and physical reservation until joined cleanup', async () => {
    await first.reserve(user, request('lost'), now);
    const lease = (await first.claim({
      kind: 'transfer',
      principal: user,
      operationId: 'lost',
      worker,
      now,
    }))!;
    expect(await second.activeWorkers()).toEqual([worker]);
    await second.reserve(other, request('next'), now);
    await second.reconcile(now + 46_000);
    expect((await second.usage(user, now + 46_000)).reservedBytes).toBe(0);
    expect((await first.metrics(now)).originalBytes).toBe(16);
    expect(
      await second.claim({
        kind: 'transfer',
        principal: other,
        operationId: 'next',
        worker,
        now: now + 46_000,
      }),
    ).toBeNull();
    await expect(
      first.confirmCleanup(
        { ...localGone(lease), writerStopped: false, originalAbsent: true },
        now + 46_000,
      ),
    ).rejects.toMatchObject({ code: 'not_ready' });
    await first.confirmCleanup({ ...localGone(lease), originalAbsent: true }, now + 46_000);
    expect((await second.metrics(now)).originalBytes).toBe(16);
    await completeUnacceptedUploadCleanup(first, user, lease);
    expect((await second.metrics(now)).originalBytes).toBe(8);
    expect(
      await second.claim({
        kind: 'transfer',
        principal: other,
        operationId: 'next',
        worker,
        now: now + 46_000,
      }),
    ).not.toBeNull();
  });

  it('projects exact local held reservations using staging generation after failure and slot release', async () => {
    await first.reserve(user, request('local-held'), now);
    const lease = (await first.claim({
      kind: 'transfer',
      principal: user,
      operationId: 'local-held',
      worker,
      now,
    }))!;
    await first.fail(lease, 'storage_uncertain', now + 1);
    await second.confirmCleanup({ ...localGone(lease), localCopiesAbsent: false }, now + 2);
    expect(await first.localReservations(worker, now + 46_000)).toEqual({
      worker,
      observedAt: now + 46_000,
      heldBytes: 8,
      counts: { transfer: 1, processing: 0 },
      attempts: [
        {
          operationId: 'local-held',
          generation: lease.generation,
          declaredBytes: 8,
          kind: 'transfer',
          worker,
        },
      ],
    });
    expect(
      (await first.localReservations({ ...worker, hostId: 'another-host' }, now)).heldBytes,
    ).toBe(0);
    expect(
      (await second.localReservations({ ...worker, instanceId: 'another-instance' }, now))
        .heldBytes,
    ).toBe(0);
    await a.models.UploadOperation.updateOne({ _id: 'local-held' }, { $unset: { workerKind: 1 } });
    await expect(second.localReservations(worker, now)).rejects.toMatchObject({
      code: 'unavailable',
    });
    await first.confirmCleanup(localGone(lease), now + 46_000);
    expect((await second.localReservations(worker, now + 46_000)).attempts).toEqual([]);
  });

  it('fails closed instead of truncating an overflowing local reservation inventory', async () => {
    await first.reserve(user, request('inventory-seed'), now);
    await first.claim({
      kind: 'transfer',
      principal: user,
      operationId: 'inventory-seed',
      worker,
      now,
    });
    const seed = await a.models.UploadOperation.findById('inventory-seed').lean();
    // Isolated historical-population fixture, deliberately outside normal queue admission.
    await a.models.UploadOperation.insertMany(
      Array.from({ length: 127 }, (_, i) => ({
        ...seed,
        _id: `held-${i}`,
        idempotencyKey: fixtureKey(`held-${i}`),
        state: 'failed',
        queueCharged: false,
        pendingBytes: 0,
      })),
    );
    expect((await second.localReservations(worker, now)).attempts).toHaveLength(128);
    await a.models.UploadOperation.create({
      ...seed,
      _id: 'overflow-held',
      idempotencyKey: fixtureKey('overflow-held'),
      state: 'failed',
      queueCharged: false,
      pendingBytes: 0,
    });
    await expect(first.localReservations(worker, now)).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('projects queue, rolling quota and physical staging aggregates without identity labels or refunds', async () => {
    const { lease } = await accepted('metrics-original');
    await second.reserve(other, request('metrics-transfer', 5), now + 1000);
    await second.claim({
      kind: 'transfer',
      principal: other,
      operationId: 'metrics-transfer',
      worker,
      now: now + 1000,
    });
    const metrics = await first.metrics(now + 6000);
    expect(metrics).toMatchObject({
      observedAt: now + 6000,
      queue: { count: 2, bytes: 13, oldestAgeSeconds: 6 },
      quota: { usedBytes: 8, reservedBytes: 5, retainedBytes: 8 },
      staging: { count: 1, bytes: 5 },
      transfers: 1,
      processors: 0,
    });
    expect(JSON.stringify(metrics)).not.toContain(user.userId);
    expect(JSON.stringify(metrics)).not.toContain('metrics-original');
    const deletionAt = Date.now();
    await first.delete(user, 'metrics-original', deletionAt);
    await first.confirmCleanup(
      { ...localGone(lease), originalAbsent: true, textAndHistoryRemoved: true },
      deletionAt,
    );
    expect((await second.metrics(now + 6000)).quota.retainedBytes).toBe(8);
    await completeAcceptedUploadFileCleanup(a, user, 'metrics-original');
    expect((await second.metrics(now + 6000)).quota).toEqual({
      usedBytes: 8,
      reservedBytes: 5,
      retainedBytes: 0,
    });
    expect((await first.metrics(now + UPLOAD_WINDOW_MS)).quota.usedBytes).toBe(0);
  });

  it('rotates eligible users while preserving FIFO within each user', async () => {
    await first.reserve(user, request('fair-first'), now);
    await second.reserve(user, request('fair-second'), now + 1);
    await second.reserve(other, request('fair-other'), now + 2);
    const lease = (await first.claim({
      kind: 'transfer',
      principal: user,
      operationId: 'fair-first',
      worker,
      now: now + 3,
    }))!;
    await first.fail(lease, 'cancelled', now + 3);
    await first.confirmCleanup({ ...localGone(lease), originalAbsent: true }, now + 3);
    expect(
      await first.claim({
        kind: 'transfer',
        principal: user,
        operationId: 'fair-second',
        worker,
        now: now + 3,
      }),
    ).toBeNull();
    expect(
      (
        await second.claim({
          kind: 'transfer',
          principal: other,
          operationId: 'fair-other',
          worker,
          now: now + 3,
        })
      )?.operationId,
    ).toBe('fair-other');
  });

  it('replays durable accept and publish without a second debit, and waits for local cleanup', async () => {
    const { lease } = await accepted('replay');
    expect(
      (
        await second.accept(
          user,
          lease,
          receipt(lease),
          approval(lease),
          { filename: 'note.txt' },
          now + 1,
        )
      ).acceptedAt,
    ).toBe(new Date(now).toISOString());
    const parser = await processing('replay');
    const result = documentResult('document');
    const published = await first.publish(parser, result, now);
    expect((await second.publish(parser, result, now + 1)).revision).toBe(published.revision);
    expect(
      (await second.cleanupTasks()).find((row) => row.operationId === 'replay')?.parserExecution
        ?.instanceId,
    ).toBe('parser-a');
    expect((await first.usage(user, now)).usedBytes).toBe(8);
    await expect(first.publish(parser, documentResult('changed'), now + 1)).rejects.toMatchObject({
      code: 'lease_lost',
    });
  });

  it('binds exactly one inert parser receipt to the held processing generation', async () => {
    await accepted('parser');
    const lease = await processing('parser');
    await expect(
      second.bindProcessingExecution(
        lease,
        {
          attemptId: `parser.${lease.generation}`,
          instanceId: 'parser-b',
          expiresAt: new Date(now + 60_000).toISOString(),
        },
        now,
      ),
    ).rejects.toMatchObject({ code: 'lease_lost' });
    await first.delete(user, 'parser', now);
    await expect(second.publish(lease, documentResult('late'), now)).rejects.toMatchObject({
      code: 'lease_lost',
    });
    expect((await first.get(user, 'parser', now)).canUseInComposer).toBe(false);
  });

  it('projects durable cleanup facts by exact File ownership and never infers stop from expiry', async () => {
    await first.reserve(user, request('cleanup-proof'), now);
    const transfer = (await first.claim({
      kind: 'transfer',
      principal: user,
      operationId: 'cleanup-proof',
      worker,
      now,
    }))!;
    await completeScanner(transfer, now);
    await second.accept(
      user,
      transfer,
      receipt(transfer),
      approval(transfer),
      { filename: 'note.txt' },
      now,
    );
    expect(await first.cleanupForFile(other, 'cleanup-proof')).toBeNull();
    expect(
      await first.cleanupForFile({ ...user, tenantId: 'tenant-b' }, 'cleanup-proof'),
    ).toBeNull();
    expect(await first.cleanupForFile(user, 'legacy-file')).toBeNull();
    expect(await first.cleanupForFile(user, 'cleanup-proof')).toMatchObject({
      writerStopped: true,
      localCopiesAbsent: false,
    });
    await first.confirmCleanup(localGone(transfer), now);
    expect(await second.cleanupForFile(user, 'cleanup-proof')).toMatchObject({
      writerStopped: true,
      localCopiesAbsent: true,
    });
    const parser = await processing('cleanup-proof');
    expect(await first.cleanupForFile(user, 'cleanup-proof')).toMatchObject({
      writerStopped: false,
      localCopiesAbsent: false,
    });
    await second.reconcile(now + 46_000);
    expect(
      (await first.cleanupTasks()).find((row) => row.operationId === 'cleanup-proof'),
    ).toMatchObject({ writerStopped: false, localCopiesAbsent: false });
    await first.confirmCleanup({ ...localGone(parser), localCopiesAbsent: false }, now + 46_000);
    expect(await second.cleanupForFile(user, 'cleanup-proof')).toMatchObject({
      writerStopped: true,
      localCopiesAbsent: false,
    });
    await a.models.UploadOperation.updateOne(
      { _id: 'cleanup-proof' },
      { $unset: { writerStopped: 1, stagingHeld: 1 } },
    );
    expect(await first.cleanupForFile(user, 'cleanup-proof')).toMatchObject({
      writerStopped: false,
      localCopiesAbsent: false,
    });
  });

  it('binds a fresh parser receipt on processing retry and resets prior cleanup proofs', async () => {
    await accepted('parser-retry');
    const prior = await processing('parser-retry');
    await first.fail(prior, 'processing_failed', now);
    await second.confirmCleanup({ ...localGone(prior), textAndHistoryRemoved: true }, now);
    await first.retryProcessing(user, 'parser-retry', now + 1);
    const next = await second.claim({ kind: 'processing', worker, now: now + 1 });
    expect(next!.generation).toBeGreaterThan(prior.generation);
    expect(await first.cleanupForFile(user, 'parser-retry')).toMatchObject({
      writerStopped: false,
      localCopiesAbsent: false,
    });
    await first.bindProcessingExecution(
      next!,
      {
        attemptId: `parser-retry.${next!.generation}`,
        instanceId: 'parser-b',
        expiresAt: new Date(now + 60_000).toISOString(),
      },
      now + 1,
    );
    expect((await second.cleanupForFile(user, 'parser-retry'))?.parserExecution?.instanceId).toBe(
      'parser-b',
    );
  });

  it('offers retry only after joined cleanup and while the original File remains available', async () => {
    await accepted('retry');
    const lease = await processing('retry');
    await first.fail(lease, 'processing_failed', now);
    expect((await second.get(user, 'retry', now)).canRetryProcessing).toBe(false);
    await second.confirmCleanup({ ...localGone(lease), textAndHistoryRemoved: true }, now);
    expect((await first.get(user, 'retry', now)).canRetryProcessing).toBe(true);
    await createFileRetentionMethods(b).revokeFileSources(user, ['retry']);
    expect((await first.list(user, now))[0].canRetryProcessing).toBe(false);
    await expect(first.retryProcessing(user, 'retry', now)).rejects.toThrow(
      'Document source unavailable',
    );
  });

  it('lets existing File revocation defeat a concurrent parser publication', async () => {
    await accepted('revoke');
    const lease = await processing('revoke');
    const lifecycle = createFileRetentionMethods(b);
    await Promise.allSettled([
      first.publish(lease, documentResult('late'), now),
      lifecycle.revokeFileSources(user, ['revoke']),
    ]);
    expect((await first.get(user, 'revoke', now)).canUseInComposer).toBe(false);
  });

  it('denies wrong owner, wrong tenant, guests and future workspaces', async () => {
    await first.reserve(user, request('private'), now);
    for (const principal of [other, { ...user, tenantId: 'tenant-b' }]) {
      await expect(second.get(principal, 'private', now)).rejects.toMatchObject({
        code: 'not_found',
      });
    }
    await expect(
      first.reserve(
        { ...user, authentication: 'guest' } as unknown as UploadPrincipal,
        request('guest'),
        now,
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      first.reserve(
        user,
        { ...request('workspace'), scope: { kind: 'workspace', workspaceId: 'future' } },
        now,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('rotates cleanup pages past persistently unknown originals', async () => {
    for (const id of ['clean-a', 'clean-b', 'clean-c']) {
      await first.reserve(user, request(id), now);
      const lease = (await first.claim({
        kind: 'transfer',
        principal: user,
        operationId: id,
        worker,
        now,
      }))!;
      await first.fail(lease, 'storage_uncertain', now);
      await first.confirmCleanup(localGone(lease), now);
    }
    const pageA = await first.cleanupTasks(2);
    const pageB = await second.cleanupTasks(2);
    expect(new Set([...pageA, ...pageB].map((row) => row.operationId)).size).toBe(3);
  });

  it('retains lifecycle tombstone allowance without starving later reconciliation', async () => {
    const { lease } = await accepted('a-tombstone');
    const deletionAt = Date.now();
    await first.delete(user, 'a-tombstone', deletionAt);
    await first.confirmCleanup(
      { ...localGone(lease), originalAbsent: true, textAndHistoryRemoved: true },
      deletionAt,
    );
    await completeAcceptedUploadFileCleanup(a, user, 'a-tombstone');
    const later = now + 32 * 86_400_000;
    await first.reserve(user, request('z-timeout'), later - 601_000);
    await first.reconcile(later, 1);
    await second.reconcile(later, 1);
    expect((await first.get(user, 'z-timeout', later)).state).toBe('failed');
    expect((await first.metrics(later)).bundles).toBe(2);
  });

  it('applies blocked admission while allowing an idempotent replay', async () => {
    await first.reserve(user, request('prior'), now);
    const lease = (await first.claimController({ ownerId: 'controller', now }))!;
    await second.publishControl({
      lease,
      now,
      sourceExpiresAt: now,
      mode: 'blocked',
      limits: { transferPermits: 0, processingPermits: 0, transferBytesPerSecond: 0 },
    });
    expect((await first.metrics(now)).control).toMatchObject({
      mode: 'blocked',
      enabled: true,
      sourceExpiresAt: now,
      leaseExpiresAt: now + 45_000,
      limits: { transferPermits: 0 },
    });
    expect((await second.reserve(user, request('prior'), now)).id).toBe('prior');
    await expect(first.reserve(other, request('blocked'), now)).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('shares byte ceilings, never refunds completed grants, and rejects stale generations', async () => {
    await first.reserve(user, request('bytes', 2 * 1_048_576), now);
    const lease = (await first.claim({
      kind: 'transfer',
      principal: user,
      operationId: 'bytes',
      worker,
      now,
    }))!;
    const grants = [];
    for (let i = 0; i < 4; i++) {
      const grant = await (i % 2 ? first : second).claimWorkBytes({
        lease,
        requestedBytes: 256 * 1024,
        now,
      });
      expect(grant?.bytes).toBe(256 * 1024);
      grants.push(grant!);
      expect(await first.claimWorkBytes({ lease, requestedBytes: 1, now })).toBeNull();
      await second.completeWorkBytes({ lease, generation: grant!.generation, now });
    }
    expect(await first.claimWorkBytes({ lease, requestedBytes: 1, now })).toBeNull();
    expect(await second.claimWorkBytes({ lease, requestedBytes: 1, now: now + 999 })).toBeNull();
    expect(
      await second.claimWorkBytes({ lease, requestedBytes: 1, now: now + 1000 }),
    ).not.toBeNull();
    await expect(
      second.completeWorkBytes({ lease, generation: grants[0].generation, now }),
    ).rejects.toMatchObject({ code: 'lease_lost' });
  });

  it('shares workflow byte caps across processing and transfers without extra permits', async () => {
    await accepted('processing-bytes');
    const parser = await processing('processing-bytes');
    const controller = (await first.claimController({ ownerId: 'controller', now }))!;
    await first.publishControl({
      lease: controller,
      now,
      sourceExpiresAt: now + 70_000,
      mode: 'normal',
      limits: { transferPermits: 6, processingPermits: 3, transferBytesPerSecond: 8 * 1_048_576 },
    });
    await second.reserve(other, request('transfer-bytes'), now);
    const transfer = (await second.claim({
      kind: 'transfer',
      principal: other,
      operationId: 'transfer-bytes',
      worker,
      now,
    }))!;
    await first.reserve(user, request('other-host'), now);
    const otherHost = (await first.claim({
      kind: 'transfer',
      principal: user,
      operationId: 'other-host',
      worker: { hostId: 'host-b', instanceId: 'app-b' },
      now,
    }))!;
    await second.reserve(other, request('last-host'), now);
    const lastHost = (await second.claim({
      kind: 'transfer',
      principal: other,
      operationId: 'last-host',
      worker: { hostId: 'host-c', instanceId: 'app-c' },
      now,
    }))!;
    await expect(
      second.claimWorkBytes({ lease: { ...parser, kind: 'transfer' }, requestedBytes: 1, now }),
    ).rejects.toMatchObject({ code: 'lease_lost' });
    await expect(
      first.claimWorkBytes({ lease: { ...parser, hostId: 'forged-host' }, requestedBytes: 1, now }),
    ).rejects.toMatchObject({ code: 'lease_lost' });
    for (let i = 0; i < 16; i++) {
      const lease = i % 2 ? parser : transfer;
      const grant = await (i % 2 ? first : second).claimWorkBytes({
        lease,
        requestedBytes: 256 * 1024,
        now,
      });
      expect(grant?.bytes).toBe(256 * 1024);
      await second.completeWorkBytes({ lease, generation: grant!.generation, now });
    }
    expect(await first.claimWorkBytes({ lease: parser, requestedBytes: 1, now })).toBeNull();
    expect(await second.claimWorkBytes({ lease: transfer, requestedBytes: 1, now })).toBeNull();
    for (let i = 0; i < 16; i++) {
      const grant = await first.claimWorkBytes({
        lease: otherHost,
        requestedBytes: 256 * 1024,
        now,
      });
      expect(grant?.bytes).toBe(256 * 1024);
      await second.completeWorkBytes({ lease: otherHost, generation: grant!.generation, now });
    }
    expect(await first.claimWorkBytes({ lease: otherHost, requestedBytes: 1, now })).toBeNull();
    expect(await first.claimWorkBytes({ lease: lastHost, requestedBytes: 1, now })).toBeNull();
    expect(
      await second.claimWorkBytes({ lease: parser, requestedBytes: 1, now: now + 1000 }),
    ).not.toBeNull();
    expect(await first.metrics(now)).toMatchObject({ transfers: 3, processors: 1 });
  });

  it('round-trips ordered replayable snapshots, exact counters and one-owner cutover', async () => {
    await accepted('migration-a');
    await first.reserve(other, request('migration-b'), now);
    const pageA = await first.exportSnapshot({ epoch: 'move-1', limit: 1 });
    const replay = await second.exportSnapshot({ epoch: 'move-1', limit: 1 });
    expect(replay).toEqual(pageA);
    const pageB = await second.exportSnapshot({
      epoch: 'move-1',
      cursor: pageA.nextCursor!,
      limit: 1,
    });
    await expect(target.importSnapshot(pageB)).rejects.toMatchObject({
      code: 'migration_conflict',
    });
    await copyFrozenUploadFiles(a, replacement);
    await target.importSnapshot(pageA);
    await target.importSnapshot(pageA);
    await target.importSnapshot(pageB);
    await expect(target.reserve(user, request('early'), now)).rejects.toMatchObject({
      code: 'migration_conflict',
    });
    const seal = await first.completeExport('move-1');
    await expect(
      target.completeImport({
        receipt: seal,
        baseline: { ...baseline, textBytes: 1 },
        lifecycleReconciled: true,
      }),
    ).rejects.toMatchObject({ code: 'migration_conflict' });
    await target.completeImport({ receipt: seal, baseline, lifecycleReconciled: true });
    await target.completeImport({ receipt: seal, baseline, lifecycleReconciled: true });
    expect(await target.usage(user, now)).toEqual(await first.usage(user, now));
    expect((await target.get(user, 'migration-a', now)).expiresAt).toBe(
      new Date(now + UPLOAD_RETENTION_MS).toISOString(),
    );
    await expect(first.reserve(user, request('retired'), now)).rejects.toMatchObject({
      code: 'migration_conflict',
    });
    expect((await target.reserve(user, request('new-owner'), now)).state).toBe('waiting');
  });

  it('retries a transient transaction without duplicate reservations', async () => {
    const error = new mongoose.mongo.MongoServerError({ message: 'injected transient failure' });
    error.addErrorLabel('TransientTransactionError');
    const create = jest.spyOn(a.models.UploadOperation, 'create').mockRejectedValueOnce(error);
    try {
      await first.reserve(user, request('transient'), now);
      expect(create).toHaveBeenCalledTimes(2);
      expect((await second.usage(user, now)).reservedBytes).toBe(8);
      expect((await second.metrics(now)).bundles).toBe(1);
    } finally {
      create.mockRestore();
    }
  });

  it('reconciles an acknowledged commit whose first reply is unknown', async () => {
    const start = a.startSession.bind(a);
    const sessions = jest.spyOn(a, 'startSession').mockImplementation(async (...args) => {
      const session = await start(...args);
      const commit = session.commitTransaction.bind(session);
      let firstReply = true;
      jest.spyOn(session, 'commitTransaction').mockImplementation(async () => {
        await commit();
        if (firstReply) {
          firstReply = false;
          const error = new mongoose.mongo.MongoServerError({
            message: 'injected lost commit reply',
          });
          error.addErrorLabel('UnknownTransactionCommitResult');
          throw error;
        }
      });
      return session;
    });
    try {
      await first.reserve(user, request('unknown'), now);
      expect((await second.reserve(user, request('unknown'), now)).id).toBe('unknown');
      expect((await second.metrics(now)).bundles).toBe(1);
    } finally {
      sessions.mockRestore();
    }
  });

  it('rejects altered replay and inexact resource counters at import', async () => {
    await first.reserve(user, request('migration'), now);
    const page = await first.exportSnapshot({ epoch: 'bad-move' });
    const altered = JSON.parse(JSON.stringify(page)) as UploadMigrationPage;
    const header = altered.records[0].value as { totals: { originalBytes: number } };
    header.totals.originalBytes++;
    await expect(target.importSnapshot(altered)).rejects.toMatchObject({
      code: 'migration_conflict',
    });
    await target.importSnapshot(page);
    await expect(target.importSnapshot(altered)).rejects.toMatchObject({
      code: 'migration_conflict',
    });
  });

  /** Real Mongo effects; controlled backend receipts do not claim external indexing or deletion. */
  describe('managed retrieval Mongo lifecycle', () => {
    let previousSecurityPolicy: string | undefined;
    const fileOwner = { tenantId: user.tenantId, userId: user.userId };
    const extractionPolicySha256 = 'd'.repeat(64);
    const policy = {
      backendIdentity: retrievalFixture.obligation.backendIdentity,
      routePolicySha256: '1'.repeat(64),
      rankingPolicySha256: '2'.repeat(64),
      indexGeneration: retrievalFixture.key.indexGeneration,
      writerEpoch: retrievalFixture.obligation.writerEpoch + 1,
      provenanceSha256: '3'.repeat(64),
    };
    const peer = { backendIdentity: policy.backendIdentity };
    const policySnapshot = {
      version: 1 as const,
      source: { provenanceSha256: policy.provenanceSha256 },
      content: policy,
      purge: [policy],
    };
    const digest = (value: unknown) =>
      createHash('sha256').update(canonicalManagedJson(value)).digest('hex');
    const scope = (id: string) => ({
      tenantId: user.tenantId,
      user: new mongoose.Types.ObjectId(user.userId),
      file_id: id,
    });
    const originalScope = (id: string) => ({
      tenantId: user.tenantId,
      userId: user.userId,
      'original.sources.fileId': id,
    });
    const storedFile = async (id: string) => {
      const result = await b.models.File.collection.findOne(scope(id));
      expect(result).not.toBeNull();
      return result!;
    };
    const originals = (id: string) =>
      b.models.FileRetrievalOperation.collection.find(originalScope(id)).toArray();
    const lifecycle = (db = b) => createFileRetentionMethods(db);
    const indexRequest = (id: string) => ({
      owner: fileOwner,
      operationId: `index-${id}`,
      purpose: 'index' as const,
      fileIds: [id],
      body: { text: 'controlled body; persisted only as a digest' },
    });
    const indexReceipt = (original: FileRetrievalOriginal) => {
      const payload = {
        version: 1 as const,
        operationId: original.operationId,
        requestSha256: original.bodySha256,
        backendIdentity: original.policy.backendIdentity,
        writerEpoch: original.policy.writerEpoch,
        key: original.sources[0].keys[0],
        state: 'ready' as const,
        completedAt: Math.floor(original.admittedAt / 1000),
      };
      return { ...payload, receiptSha256: digest(payload) };
    };
    const purgeReceipt = (original: FileRetrievalOriginal) => {
      const payload = {
        version: 1 as const,
        purgeOperationId: original.operationId,
        keys: original.sources[0].keys,
        backendIdentity: original.policy.backendIdentity,
        fenceEpoch: original.policy.writerEpoch + 1,
        state: 'purged' as const,
        remainingChunks: 0 as const,
        activeWriters: 0 as const,
        completedAt: Math.floor(original.admittedAt / 1000),
      };
      return { ...payload, receiptSha256: digest(payload) };
    };
    async function operations(db: mongoose.Mongoose) {
      // The owner takes the module type; this is an actual independent Mongoose instance.
      const api = createFileRetrievalOperationOwner(db as unknown as typeof import('mongoose'), {
        policySnapshot,
      });
      await api.initialize();
      return api;
    }
    async function retrievalReady(id: string) {
      process.env.UPLOAD_SECURITY_POLICY_SHA256 = securityPolicySha256;
      first = createUploadManagementRepository(a, { securityPolicySha256, extractionPolicySha256 });
      await first.initialize();
      await ready(id);
      return { writer: await operations(a), reader: await operations(b) };
    }
    function gate() {
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { wait, release };
    }
    async function bounded<T>(promise: Promise<T>): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Mongo lifecycle barrier not reached')),
              4000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    beforeEach(async () => {
      previousSecurityPolicy = process.env.UPLOAD_SECURITY_POLICY_SHA256;
      // Existing outer hooks clear File/Upload rows. This collection belongs only to these cases.
      if (a.models.FileRetrievalOperation) await a.models.FileRetrievalOperation.deleteMany({});
    });
    afterEach(() => {
      if (previousSecurityPolicy === undefined) delete process.env.UPLOAD_SECURITY_POLICY_SHA256;
      else process.env.UPLOAD_SECURITY_POLICY_SHA256 = previousSecurityPolicy;
    });

    it('rolls genuine File creation back with acceptance and preserves its unique birth on retry', async () => {
      const id = 'mongo-birth';
      await first.reserve(user, request(id), now);
      const lease = (await first.claim({
        kind: 'transfer',
        principal: user,
        operationId: id,
        worker,
        now,
      }))!;
      await completeScanner(lease, now);
      const inserted = jest.spyOn(a.models.File, 'create');
      const save = jest
        .spyOn(a.models.UploadOperation, 'replaceOne')
        .mockRejectedValueOnce(new Error('after actual File insert'));
      try {
        await expect(
          first.accept(user, lease, receipt(lease), approval(lease), { filename: 'note.txt' }, now),
        ).rejects.toThrow('after actual File insert');
        expect(inserted).toHaveBeenCalledTimes(1);
        expect(await b.models.File.countDocuments(scope(id))).toBe(0);
        const upload = await b.models.UploadOperation.findById(id).lean();
        expect(upload).not.toHaveProperty('acceptedAt');
        expect(await second.usage(user, now)).toMatchObject({ usedBytes: 0, reservedBytes: 8 });
      } finally {
        save.mockRestore();
        inserted.mockRestore();
      }
      await first.accept(
        user,
        lease,
        receipt(lease),
        approval(lease),
        { filename: 'note.txt' },
        now,
      );
      const birth = (await storedFile(id)).retrievalCreation;
      expect(birth).toEqual({
        version: 1,
        owner: fileOwner,
        fileId: id,
        acceptedAt: now,
        state: 'empty',
      });
      await second.accept(
        user,
        lease,
        receipt(lease),
        approval(lease),
        { filename: 'note.txt' },
        now + 1,
      );
      expect((await storedFile(id)).retrievalCreation).toEqual(birth);
      expect(await b.models.File.countDocuments(scope(id))).toBe(1);
      expect(await second.usage(user, now)).toMatchObject({ usedBytes: 8, reservedBytes: 0 });
      expect(await b.models.File.collection.indexes()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'file_identity',
            key: { tenantId: 1, file_id: 1 },
            unique: true,
          }),
        ]),
      );
    });

    it('rolls first admission custody and liability back when the original insert fails', async () => {
      const id = 'mongo-admission';
      const { writer, reader } = await retrievalReady(id);
      const before = (await storedFile(id)).retrievalCreation;
      const create = jest
        .spyOn(a.models.FileRetrievalOperation, 'create')
        .mockRejectedValueOnce(new Error('after actual File admission write'));
      try {
        await expect(writer.admit(indexRequest(id))).rejects.toThrow(
          'after actual File admission write',
        );
        expect(create).toHaveBeenCalledTimes(1);
        expect((await storedFile(id)).retrievalCreation).toEqual(before);
        expect((await storedFile(id)).managedRetrieval.obligations).toEqual([]);
        expect(await originals(id)).toHaveLength(0);
      } finally {
        create.mockRestore();
      }
      const original = await writer.admit(indexRequest(id));
      expect(await reader.admit(indexRequest(id))).toEqual(original);
      const current = await storedFile(id);
      expect(current.retrievalCreation).toEqual({ ...before, state: 'admitted' });
      expect(current.managedRetrieval.obligations).toEqual([
        expect.objectContaining({ operationId: original.operationId, state: 'preparing' }),
      ]);
      expect(await originals(id)).toHaveLength(1);
      await createFileMethods(a).updateFile({ file_id: id, retrievalCreation: before });
      expect((await storedFile(id)).retrievalCreation.state).toBe('admitted');
    });

    it('rejects first admission when revocation commits after its real snapshot read', async () => {
      const id = 'mongo-revoke-first';
      const { writer } = await retrievalReady(id);
      const reached = gate(),
        release = gate();
      const nativeUpdate = a.models.File.updateOne.bind(a.models.File);
      const touch = jest.spyOn(a.models.File, 'updateOne').mockImplementationOnce((...args) => {
        reached.release();
        return release.wait.then(() => nativeUpdate(...args)) as unknown as ReturnType<
          typeof nativeUpdate
        >;
      });
      const admission = writer.admit(indexRequest(id));
      const denied = (async () => {
        await expect(admission).rejects.toMatchObject({
          code: 'managed_retrieval_source_unavailable',
        });
      })();
      try {
        await bounded(reached.wait);
        await lifecycle().revokeFileSources(fileOwner, [id]);
        release.release();
        await bounded(denied);
        expect((await storedFile(id)).retrievalCreation.state).toBe('empty');
        expect((await storedFile(id)).managedRetrieval.obligations).toEqual([]);
        expect(await originals(id)).toHaveLength(0);
      } finally {
        release.release();
        touch.mockRestore();
        await Promise.allSettled([admission, denied]);
      }
    });

    it('retains admitted liabilities when revocation waits for the real File write', async () => {
      const id = 'mongo-admit-first';
      const { writer } = await retrievalReady(id);
      const written = gate(),
        release = gate(),
        revokeSent = gate();
      const nativeUpdate = a.models.File.updateOne.bind(a.models.File);
      const touch = jest.spyOn(a.models.File, 'updateOne').mockImplementationOnce((...args) => {
        const pending = Promise.resolve(nativeUpdate(...args)).then(async (result) => {
          written.release();
          await release.wait;
          return result;
        });
        return pending as unknown as ReturnType<typeof nativeUpdate>;
      });
      const client = b.connection.getClient();
      const onCommand = (event: {
        commandName: string;
        command: {
          update?: string;
          updates?: Array<{ u?: { $set?: { deletionRequestedAt?: unknown } } }>;
        };
      }) => {
        if (
          event.commandName === 'update' &&
          event.command.update === b.models.File.collection.name &&
          event.command.updates?.some((item) => item.u?.$set?.deletionRequestedAt)
        )
          revokeSent.release();
      };
      client.on('commandStarted', onCommand);
      const admission = writer.admit(indexRequest(id));
      let revoke: Promise<unknown> | undefined;
      try {
        await bounded(written.wait);
        revoke = lifecycle().revokeFileSources(fileOwner, [id]);
        await bounded(revokeSent.wait);
        release.release();
        const original = await bounded(admission);
        await bounded(revoke);
        expect((await storedFile(id)).retrievalCreation.state).toBe('admitted');
        expect((await storedFile(id)).managedRetrieval.obligations).toEqual([
          expect.objectContaining({ operationId: original.operationId, state: 'preparing' }),
        ]);
        expect(await originals(id)).toHaveLength(1);
        await expect(
          lifecycle().assertFileSourceDeletionReady(fileOwner, [id]),
        ).rejects.toBeInstanceOf(FileSourceUnavailableError);
      } finally {
        release.release();
        touch.mockRestore();
        client.off('commandStarted', onCommand);
        await Promise.allSettled([admission, ...(revoke ? [revoke] : [])]);
      }
    });

    it('commits the exact index receipt and readiness together across abort and replay', async () => {
      const id = 'mongo-index-ack';
      const { writer, reader } = await retrievalReady(id);
      const original = await writer.admit(indexRequest(id));
      const proof = indexReceipt(original);
      const record = jest.spyOn(a.models.FileRetrievalOperation, 'updateOne');
      const touch = jest
        .spyOn(a.models.File, 'updateOne')
        .mockRejectedValueOnce(new Error('after actual index receipt write'));
      try {
        await expect(
          writer.acknowledgeIndex(
            { owner: fileOwner, operationId: original.operationId, receipt: proof },
            peer,
          ),
        ).rejects.toThrow('after actual index receipt write');
        expect(record).toHaveBeenCalledTimes(1);
        expect((await originals(id))[0]).not.toHaveProperty('indexReceipt');
        expect((await storedFile(id)).managedRetrieval.obligations[0].state).toBe('preparing');
      } finally {
        touch.mockRestore();
        record.mockRestore();
      }
      await writer.acknowledgeIndex(
        { owner: fileOwner, operationId: original.operationId, receipt: proof },
        peer,
      );
      await reader.acknowledgeIndex(
        { owner: fileOwner, operationId: original.operationId, receipt: proof },
        peer,
      );
      expect((await storedFile(id)).managedRetrieval.obligations[0].state).toBe('ready');
      expect((await originals(id))[0]).toMatchObject({ original, indexReceipt: proof });
      const { receiptSha256: _old, ...changed } = { ...proof, completedAt: proof.completedAt + 1 };
      await expect(
        reader.acknowledgeIndex(
          {
            owner: fileOwner,
            operationId: original.operationId,
            receipt: { ...changed, receiptSha256: digest(changed) },
          },
          peer,
        ),
      ).rejects.toThrow();
      expect((await originals(id))[0].indexReceipt).toEqual(proof);
    });

    it('replays pending purge exactly and omits terminal work after its original deadline', async () => {
      const id = 'mongo-purge-retry';
      const { writer, reader } = await retrievalReady(id);
      const index = await writer.admit(indexRequest(id));
      await writer.acknowledgeIndex(
        { owner: fileOwner, operationId: index.operationId, receipt: indexReceipt(index) },
        peer,
      );
      await lifecycle().revokeFileSources(fileOwner, [id]);
      const request = { owner: fileOwner, fileId: id };
      const [purge] = await writer.admitPurge(request);
      expect(purge).toBeDefined();
      expect(await reader.admitPurge(request)).toEqual([purge]);
      expect(await originals(id)).toHaveLength(2);
      const proof = purgeReceipt(purge);
      const pending = (await storedFile(id)).managedRetrieval;
      await expect(
        reader.acknowledgePurge(
          { owner: fileOwner, operationId: purge.operationId, receipt: proof },
          { backendIdentity: 'foreign' },
        ),
      ).rejects.toThrow();
      expect((await storedFile(id)).managedRetrieval).toEqual(pending);
      await reader.acknowledgePurge(
        { owner: fileOwner, operationId: purge.operationId, receipt: proof },
        peer,
      );
      await writer.acknowledgePurge(
        { owner: fileOwner, operationId: purge.operationId, receipt: proof },
        peer,
      );
      const clock = jest.spyOn(Date, 'now').mockReturnValueOnce(purge.workDeadline + 1);
      try {
        expect(await reader.admitPurge(request)).toEqual([]);
      } finally {
        clock.mockRestore();
      }
      const retained = await originals(id);
      expect(retained).toHaveLength(2);
      expect(retained.find((item) => item.operationId === purge.operationId)?.original).toEqual(
        purge,
      );
      expect((await storedFile(id)).managedRetrieval.obligations).toEqual([
        expect.objectContaining({
          state: 'purged',
          purgeOperationId: purge.operationId,
          receiptSha256: proof.receiptSha256,
        }),
      ]);
      await expect(
        lifecycle().assertFileSourceDeletionReady(fileOwner, [id]),
      ).resolves.toBeUndefined();
      expect(await lifecycle().prepareFileSourceDeletion(fileOwner, [id])).toEqual({
        preparedFileIds: [],
      });
      await completeAcceptedUploadFileCleanup(a, user, id);
      expect(await lifecycle().prepareFileSourceDeletion(fileOwner, [id])).toEqual({
        preparedFileIds: [id],
      });
      expect(await lifecycle().finalizeFileSourceDeletion(fileOwner, [id])).toEqual({
        completedFileIds: [id],
      });
      expect((await storedFile(id)).retrievalCreation.state).toBe('admitted');
    });

    it('settles genuine fresh empty custody without a retrieval owner and preserves unknown legacy custody', async () => {
      const id = 'mongo-empty';
      await ready(id);
      const birth = (await storedFile(id)).retrievalCreation;
      expect((await storedFile(id)).managedRetrieval).toBeUndefined();
      expect(await b.models.File.findOne(scope(id)).lean()).not.toHaveProperty('retrievalCreation');
      await lifecycle().revokeFileSources(fileOwner, [id]);
      await expect(
        lifecycle().assertFileSourceDeletionReady(fileOwner, [id]),
      ).resolves.toBeUndefined();
      expect(await lifecycle().prepareFileSourceDeletion(fileOwner, [id])).toEqual({
        preparedFileIds: [],
      });
      await completeAcceptedUploadFileCleanup(a, user, id);
      expect(await lifecycle().prepareFileSourceDeletion(fileOwner, [id])).toEqual({
        preparedFileIds: [id],
      });
      expect(await lifecycle().finalizeFileSourceDeletion(fileOwner, [id])).toEqual({
        completedFileIds: [id],
      });
      expect(await lifecycle().finalizeFileSourceDeletion(fileOwner, [id])).toEqual({
        completedFileIds: [id],
      });
      const tombstone = await storedFile(id);
      expect(tombstone).toMatchObject({ retrievalCreation: birth, uploadOperationId: id });
      expect(tombstone.deletionCompletedAt).toBeInstanceOf(Date);
      expect(await second.usage(user, now)).toMatchObject({ usedBytes: 8 });
      const files = createFileMethods(a);
      const legacyAt = Date.now();
      await files.createFile(
        {
          ...scope('mongo-legacy'),
          filename: 'legacy.txt',
          filepath: '/fixture/legacy',
          bytes: 1,
          type: 'text/plain',
          text: 'x',
        },
        true,
        { retention: { acceptedAt: new Date(legacyAt), expiredAt: new Date(legacyAt + 60_000) } },
      );
      await lifecycle().revokeFileSources(fileOwner, ['mongo-legacy']);
      await expect(
        lifecycle().assertFileSourceDeletionReady(fileOwner, ['mongo-legacy']),
      ).rejects.toBeInstanceOf(FileSourceUnavailableError);
      expect(await lifecycle().finalizeFileSourceDeletion(fileOwner, ['mongo-legacy'])).toEqual({
        completedFileIds: [],
      });
      const legacy = await storedFile('mongo-legacy');
      expect(legacy.retrievalCreation).toBeUndefined();
      expect(legacy.text).toBe('x');
      expect(legacy.deletionCompletedAt).toBeFalsy();
    });
  });
});
