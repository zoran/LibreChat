/** Real Mongo evidence for private approval, original identity and policy changes across clients. */
import mongoose from 'mongoose';
import { createHash } from 'crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { UploadLease, UploadPrincipal, UploadSecurityApproval } from 'librechat-data-provider';
import type { StoredUpload } from './uploadManagementStore';
import {
  uploadSecurityFixture,
  uploadSecuritySettlementFixture,
  bindUploadOriginalFixture,
} from '../../specs/fixtures/uploadManagement.security.fixture';
import { completeAcceptedUploadFileCleanup } from '../../specs/fixtures/uploadManagement.structure.fixture';
import { createUploadManagementRepository } from './uploadManagement';
import { createModels } from '~/models';

/** Deterministic UUIDv4-shaped test keys keep operation labels out of the public key contract. */
const fixtureKey = (label: string): string => {
  const hex = createHash('sha256').update(label).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

describe('durable upload security approval', () => {
  let mongo: MongoMemoryReplSet;
  const a = new mongoose.Mongoose();
  const b = new mongoose.Mongoose();
  const replacement = new mongoose.Mongoose();
  let first: ReturnType<typeof createUploadManagementRepository>;
  let second: ReturnType<typeof createUploadManagementRepository>;
  let target: ReturnType<typeof createUploadManagementRepository>;
  const now = Date.now();
  const policy = 'c'.repeat(64);
  const user: UploadPrincipal = {
    tenantId: 'tenant-a',
    userId: new mongoose.Types.ObjectId().toString(),
    authentication: 'verified-email',
  };
  const worker = { hostId: 'host-a', instanceId: 'app-a' };
  const baseline = { originalBytes: 0, objectBytes: 0, textBytes: 0, recordBytes: 0, bundles: 0 };
  const receipt = (lease: UploadLease) => ({
    outcome: 'durable' as const,
    bytes: 8,
    source: 's3',
    filepath: `/api/files/download/${lease.operationId}`,
    storageKey: `t/${lease.tenantId}/managed-uploads/${lease.userId}/${lease.operationId}.${lease.generation}__original`,
    integrity: {
      version: 1 as const,
      algorithm: 'sha256' as const,
      sha256: 'a'.repeat(64),
      chunkBytes: 262144 as const,
      chunkSha256: ['b'.repeat(64)],
    },
  });
  const approval = (lease: UploadLease): UploadSecurityApproval =>
    uploadSecurityFixture({
      decision: 'approved',
      policySha256: policy,
      subject: {
        tenantId: lease.tenantId,
        userId: lease.userId,
        operationId: lease.operationId,
        transferGeneration: lease.generation,
        mediaType: 'text/plain',
        bytes: 8,
        sha256: receipt(lease).integrity.sha256,
      },
      scannerVersion: 'trusted-fixture-v1',
      checkedAt: new Date(now).toISOString(),
      coverage: { complete: true, pages: 1, parts: 1 },
    }).approval;
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
  async function completeScanner(lease: UploadLease, at: number) {
    const execution = uploadSecurityFixture(approval(lease), {
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
    await bindUploadOriginalFixture(first, lease, receipt(lease), approval(lease), at);
  }

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await Promise.all([
      a.connect(mongo.getUri('security')),
      b.connect(mongo.getUri('security')),
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
      ])
        if (db.models[name]) await db.models[name].deleteMany({});
      await db.models.User.create({
        _id: user.userId,
        tenantId: user.tenantId,
        email: 'upload-security@example.test',
        emailVerified: true,
      });
    }
    first = createUploadManagementRepository(a, {
      enabled: true,
      reconciled: true,
      baseline,
      securityPolicySha256: policy,
    });
    second = createUploadManagementRepository(b, { securityPolicySha256: policy });
    target = createUploadManagementRepository(replacement, { securityPolicySha256: policy });
    await first.initialize();
    await Promise.all([second.initialize(), target.initialize()]);
  });
  afterAll(async () => {
    await Promise.all([a.disconnect(), b.disconnect(), replacement.disconnect()]);
    await mongo?.stop();
  });
  async function transfer(id = 'secured') {
    await first.reserve(
      user,
      {
        operationId: id,
        idempotencyKey: fixtureKey(id),
        mediaType: 'text/plain',
        declaredBytes: 8,
        fingerprint: JSON.stringify([{ kind: 'personal' }, 'text/plain', 8]),
      },
      now,
    );
    const lease = (await first.claim({
      kind: 'transfer',
      principal: user,
      operationId: id,
      worker,
      now,
    }))!;
    await completeScanner(lease, now);
    return lease;
  }
  async function accepted() {
    const lease = await transfer();
    const proof = approval(lease);
    await first.accept(user, lease, receipt(lease), proof, { filename: 'note.txt' }, now);
    await first.confirmCleanup(localGone(lease), now);
    return { lease, proof };
  }
  async function processing() {
    const lease = (await second.claim({ kind: 'processing', worker, now }))!;
    expect(lease).not.toBeNull();
    await first.bindProcessingExecution(
      lease,
      {
        attemptId: `${lease.operationId}.${lease.generation}`,
        instanceId: 'parser-a',
        expiresAt: new Date(now + 60_000).toISOString(),
      },
      now,
    );
    return lease;
  }

  const invalid: [string, (proof: UploadSecurityApproval) => unknown][] = [
    ['missing', () => undefined],
    ['foreign tenant', (p) => ({ ...p, subject: { ...p.subject, tenantId: 'tenant-b' } })],
    ['foreign owner', (p) => ({ ...p, subject: { ...p.subject, userId: 'another-user' } })],
    [
      'foreign operation',
      (p) => ({ ...p, subject: { ...p.subject, operationId: 'another-operation' } }),
    ],
    ['other generation', (p) => ({ ...p, subject: { ...p.subject, transferGeneration: 2 } })],
    [
      'other media type',
      (p) => ({ ...p, subject: { ...p.subject, mediaType: 'application/pdf' } }),
    ],
    ['other size', (p) => ({ ...p, subject: { ...p.subject, bytes: 7 } })],
    ['same-size other bytes', (p) => ({ ...p, subject: { ...p.subject, sha256: 'd'.repeat(64) } })],
    ['old policy', (p) => ({ ...p, policySha256: 'd'.repeat(64) })],
    ['future check', (p) => ({ ...p, checkedAt: new Date(now + 1).toISOString() })],
    ['incomplete', (p) => ({ ...p, coverage: { ...p.coverage, complete: false } })],
    ['empty coverage', (p) => ({ ...p, coverage: { ...p.coverage, pages: 0 } })],
    ['rejected', () => ({ version: 1, decision: 'rejected', reason: 'classification_marking' })],
    [
      'uninspectable',
      () => ({ version: 1, decision: 'uninspectable', reason: 'incomplete_coverage' }),
    ],
  ];
  it.each(invalid)(
    'refuses %s approval atomically before ordinary File acceptance',
    async (_name, change) => {
      const lease = await transfer();
      await expect(
        first.accept(
          user,
          lease,
          receipt(lease),
          change(approval(lease)) as UploadSecurityApproval,
          { filename: 'note.txt' },
          now,
        ),
      ).rejects.toMatchObject({
        code: 'security_uninspectable',
        message: 'security_uninspectable',
      });
      const row = await b.models.UploadOperation.findById(lease.operationId).lean<StoredUpload>();
      expect(row).toMatchObject({ state: 'transferring', pendingBytes: 8, originalBytes: 8 });
      expect(row).not.toHaveProperty('acceptedAt');
      expect(row).not.toHaveProperty('securityApproval');
      expect(await b.models.File.countDocuments({})).toBe(0);
      expect(await second.usage(user, now)).toMatchObject({ usedBytes: 0, reservedBytes: 8 });
    },
  );

  it.each([undefined, '', 'INVALID', 'd'.repeat(64)])(
    'refuses initial acceptance under policy %s without charging the rolling quota',
    async (securityPolicySha256) => {
      const lease = await transfer();
      const changed = createUploadManagementRepository(b, { securityPolicySha256 });
      await changed.initialize();
      await expect(
        changed.accept(user, lease, receipt(lease), approval(lease), { filename: 'note.txt' }, now),
      ).rejects.toMatchObject({ code: 'security_uninspectable' });
      expect(await b.models.File.countDocuments({})).toBe(0);
      expect(await first.usage(user, now)).toMatchObject({ usedBytes: 0, reservedBytes: 8 });
    },
  );

  it('snapshots one private proof and permits only its exact replay across independent clients', async () => {
    const lease = await transfer();
    const proof = approval(lease);
    const expected = JSON.parse(JSON.stringify(proof));
    const pending = first.accept(user, lease, receipt(lease), proof, { filename: 'note.txt' }, now);
    proof.subject.sha256 = 'd'.repeat(64);
    proof.coverage.pages = 99;
    await pending;
    expect(
      (await b.models.UploadOperation.findById(lease.operationId).lean<StoredUpload>())!
        .securityApproval,
    ).toEqual(expected);
    expect(await b.models.File.findOne({ file_id: lease.operationId }).lean()).not.toHaveProperty(
      'securityApproval',
    );
    expect(
      await b.models.File.findOne({ file_id: lease.operationId })
        .select('+securityApproval')
        .lean(),
    ).toMatchObject({ securityApproval: expected });
    await expect(
      second.accept(user, lease, receipt(lease), expected, { filename: 'note.txt' }, now + 1),
    ).resolves.toMatchObject({ state: 'queued_processing' });
    await expect(
      second.accept(
        user,
        lease,
        receipt(lease),
        { ...expected, scannerVersion: 'new-proof' },
        { filename: 'note.txt' },
        now + 1,
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(
      second.accept(
        user,
        lease,
        receipt(lease),
        undefined as unknown as UploadSecurityApproval,
        { filename: 'note.txt' },
        now + 1,
      ),
    ).rejects.toMatchObject({ code: 'security_uninspectable' });
    expect(await first.usage(user, now)).toMatchObject({
      usedBytes: 8,
      retainedBytes: 8,
      reservedBytes: 0,
    });
    expect(JSON.stringify(await second.list(user, now))).not.toContain('securityApproval');
    expect(JSON.stringify(await second.metrics(now))).not.toContain('trusted-fixture');
  });

  it('keeps the original transfer proof through failed processing and a later generation', async () => {
    const { lease: original, proof } = await accepted();
    const failed = await processing();
    await first.fail(failed, 'processing_failed', now);
    await first.confirmCleanup(localGone(failed), now);
    await second.retryProcessing(user, original.operationId, now);
    const retry = await processing();
    expect(retry.generation).toBeGreaterThan(failed.generation);
    const input = await first.getProcessingInput(retry, now);
    expect(input.securityApproval).toEqual(proof);
    expect(input.attemptGeneration).toBe(original.generation);
    await first.publish(retry, documentResult('approved text'), now);
    await second.publish(retry, documentResult('approved text'), now);
    expect(await first.usage(user, now)).toMatchObject({ usedBytes: 8 });
  });

  it.each([undefined, '', 'INVALID', 'd'.repeat(64)])(
    'denies dependent work under policy %s while retaining cleanup',
    async (securityPolicySha256) => {
      const { lease: original, proof } = await accepted();
      const changed = createUploadManagementRepository(b, { securityPolicySha256 });
      await changed.initialize();
      expect(await changed.claim({ kind: 'processing', worker, now })).toBeNull();
      const lease = await processing();
      await expect(
        changed.bindProcessingExecution(
          lease,
          {
            attemptId: `${lease.operationId}.${lease.generation}`,
            instanceId: 'parser-a',
            expiresAt: new Date(now + 60_000).toISOString(),
          },
          now,
        ),
      ).rejects.toMatchObject({ code: 'security_uninspectable' });
      await expect(changed.getProcessingInput(lease, now)).rejects.toMatchObject({
        code: 'security_uninspectable',
      });
      await expect(changed.publish(lease, documentResult('blocked'), now)).rejects.toMatchObject({
        code: 'security_uninspectable',
      });
      await expect(changed.retryProcessing(user, original.operationId, now)).rejects.toMatchObject({
        code: 'security_uninspectable',
      });
      await expect(
        changed.accept(user, original, receipt(original), proof, { filename: 'note.txt' }, now),
      ).rejects.toMatchObject({ code: 'security_uninspectable' });
      await changed.delete(user, original.operationId, now);
      await changed.confirmCleanup(
        { ...localGone(lease), originalAbsent: true, textAndHistoryRemoved: true },
        now,
      );
      expect((await changed.usage(user, now)).retainedBytes).toBe(8);
      await completeAcceptedUploadFileCleanup(
        a,
        user,
        original.operationId,
        mongo.getUri('security'),
      );
      expect(await changed.usage(user, now)).toMatchObject({
        usedBytes: 8,
        reservedBytes: 0,
        retainedBytes: 0,
      });
    },
  );

  it('refuses legacy missing proofs before claiming processing and after a lease was issued', async () => {
    const { lease: original, proof } = await accepted();
    await a.models.UploadOperation.updateOne(
      { _id: original.operationId },
      { $unset: { securityApproval: 1 } },
    );
    expect(await second.claim({ kind: 'processing', worker, now })).toBeNull();
    await a.models.UploadOperation.updateOne(
      { _id: original.operationId },
      { $set: { securityApproval: proof } },
    );
    const lease = await processing();
    await a.models.UploadOperation.updateOne(
      { _id: original.operationId },
      { $unset: { securityApproval: 1 } },
    );
    await expect(second.getProcessingInput(lease, now)).rejects.toMatchObject({
      code: 'security_uninspectable',
    });
    await expect(second.publish(lease, documentResult('blocked'), now)).rejects.toMatchObject({
      code: 'security_uninspectable',
    });
    await first.delete(user, original.operationId, now);
    await first.confirmCleanup(
      { ...localGone(lease), originalAbsent: true, textAndHistoryRemoved: true },
      now,
    );
    expect(
      (await a.models.UploadOperation.findById(original.operationId).lean<StoredUpload>())!
        .securityApproval,
    ).toBeUndefined();
  });

  it('rechecks policy even when replaying an already published result', async () => {
    await accepted();
    const lease = await processing();
    const result = documentResult('approved text');
    await first.publish(lease, result, now);
    const changed = createUploadManagementRepository(b, { securityPolicySha256: 'd'.repeat(64) });
    await expect(changed.publish(lease, result, now)).rejects.toMatchObject({
      code: 'security_uninspectable',
    });
  });

  it.each(['missing', 'foreign', 'policy'] as const)(
    'rejects unsafe active migration (%s) without inventing approval',
    async (change) => {
      const { proof } = await accepted();
      const page = await first.exportSnapshot({ epoch: 'move' });
      const altered = JSON.parse(JSON.stringify(page));
      const row = altered.records.find(
        (entry: { type: string }) => entry.type === 'operation',
      ).value;
      if (change === 'missing') delete row.securityApproval;
      if (change === 'foreign') row.securityApproval.subject.operationId = 'foreign';
      if (change === 'policy')
        target = createUploadManagementRepository(replacement, {
          securityPolicySha256: 'd'.repeat(64),
        });
      await expect(target.importSnapshot(altered)).rejects.toMatchObject({
        code: 'migration_conflict',
      });
      expect(await replacement.models.UploadOperation.countDocuments({})).toBe(0);
      expect(
        (await a.models.UploadOperation.findById('secured').lean<StoredUpload>())!.securityApproval,
      ).toEqual(proof);
    },
  );
});
