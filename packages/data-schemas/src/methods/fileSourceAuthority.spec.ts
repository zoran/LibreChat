/** Real replica-set evidence for the one durable upload store, through two independent clients. */
import mongoose from 'mongoose';
import { createHash } from 'crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import type { UploadPrincipal, UploadLease } from 'librechat-data-provider';
import type { IMongoFile } from '../types/file';
import {
  uploadSecurityFixture,
  uploadSecuritySettlementFixture,
  bindUploadOriginalFixture,
} from './uploadManagement.security.fixture';
import {
  FileSourceUnavailableError,
  resolveFileSources,
  touchFileSources,
  inspectFileSources,
} from './fileRetention';
import { createUploadManagementRepository } from './uploadManagement';
import { createModels } from '~/models';

/** Deterministic UUIDv4-shaped test keys keep operation labels out of the public key contract. */
const fixtureKey = (label: string): string => {
  const hex = createHash('sha256').update(label).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

describe('File-owned current source authority', () => {
  let mongo: MongoMemoryReplSet;
  let mongoCustody: {
    owner: string;
    status: string;
    processes: Array<{ pid?: number; port?: number; dbPath?: string; start?: string }>;
  };
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
  const approval = (lease: UploadLease, bytes = 8, checkedAt = now) =>
    uploadSecurityFixture({
      decision: 'approved' as const,
      policySha256: securityPolicySha256,
      subject: {
        tenantId: lease.tenantId,
        userId: lease.userId,
        operationId: lease.operationId,
        transferGeneration: lease.generation,
        mediaType: 'text/plain',
        bytes,
        sha256: receipt(lease, bytes).integrity.sha256,
      },
      scannerVersion: 'fixture-v1',
      checkedAt: new Date(checkedAt).toISOString(),
      coverage: { complete: true as const, pages: 1, parts: 1 },
    }).approval;

  async function completeScanner(lease: UploadLease, at: number, bytes = 8) {
    const execution = uploadSecurityFixture(approval(lease, bytes, at), {
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
      approval(lease, bytes, at),
      at,
    );
  }

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      replSet: { count: 1 },
      instanceOpts: [{ args: ['--setParameter', 'enableTestCommands=1'] }],
    });
    mongoCustody = {
      owner: '/root/retention_data',
      status: 'running',
      processes: mongo.servers.map((server) => {
        const info = server.instanceInfo;
        const pid = info?.instance.mongodProcess?.pid;
        return {
          pid,
          port: info?.port,
          dbPath: info?.dbPath,
          start: pid ? readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[21] : undefined,
        };
      }),
    };
    if (process.env.CORTEX_FILE_ACTIVITY_EVIDENCE_DIR)
      writeFileSync(
        `${process.env.CORTEX_FILE_ACTIVITY_EVIDENCE_DIR}/mongo-${process.pid}.json`,
        JSON.stringify(mongoCustody, null, 2),
      );
    await Promise.all([
      a.connect(mongo.getUri('retention_data_source_authority_private')),
      b.connect(mongo.getUri('retention_data_source_authority_private'), { monitorCommands: true }),
      replacement.connect(mongo.getUri('retention_data_source_authority_unused')),
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
        'FileReadReceipt',
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
    if (process.env.CORTEX_FILE_ACTIVITY_EVIDENCE_DIR && mongoCustody) {
      mongoCustody.status = 'reaped';
      writeFileSync(
        `${process.env.CORTEX_FILE_ACTIVITY_EVIDENCE_DIR}/mongo-${process.pid}.json`,
        JSON.stringify(
          {
            ...mongoCustody,
            remainingPaths: mongoCustody.processes.flatMap((p) =>
              p.dbPath && existsSync(p.dbPath) ? [p.dbPath] : [],
            ),
          },
          null,
          2,
        ),
      );
    }
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
    await completeScanner(lease!, at);
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

  it('refuses a managed File whose actual Upload receipt row is missing', async () => {
    process.env.UPLOAD_SECURITY_POLICY_SHA256 = securityPolicySha256;
    await ready('source-missing-receipt');
    await a.models.UploadOperation.deleteOne({ _id: 'source-missing-receipt' });
    await expect(resolveFileSources(a, user, ['source-missing-receipt'])).rejects.toThrow(
      FileSourceUnavailableError,
    );
  });

  it('shares the immutable read binding and observes the current extended deadline', async () => {
    process.env.UPLOAD_SECURITY_POLICY_SHA256 = securityPolicySha256;
    await ready('source-current');
    const before = await a.models.UploadCounter.findById('global').lean();
    const observed = await inspectFileSources(a, user, [
      'source-current',
      'missing',
      'source-current',
    ]);
    expect(observed).toHaveLength(2);
    expect(observed[0]).toMatchObject({
      state: 'managed',
      fileId: 'source-current',
      sourceExpiresAt: new Date(now + 35 * 86400000),
    });
    expect(observed[1]).toEqual({ state: 'unavailable', fileId: 'missing' });
    const ticket = await first.fileReads.admitManagedFileRead(user, {
      fileId: 'source-current',
      representation: 'original',
    });
    const claim = await second.fileReads.claimManagedFileRead(user, ticket, worker);
    expect(claim.sourceBindingSha256).toBe(
      observed[0].state === 'managed' ? observed[0].sourceBindingSha256 : undefined,
    );
    await second.fileReads.completeManagedFileRead(user, claim, {
      version: 1,
      representation: 'original',
      sourceBindingSha256: claim.sourceBindingSha256,
      contentSha256: 'a'.repeat(64),
      verifiedBytes: 8,
    });
    const after = await inspectFileSources(a, user, ['source-current']);
    expect(after[0]).toEqual({ ...observed[0], sourceExpiresAt: new Date(now + 42 * 86400000) });
    expect((await resolveFileSources(a, user, ['source-current']))?.sourceExpiresAt).toEqual(
      new Date(now + 42 * 86400000),
    );
    expect(await a.models.UploadCounter.findById('global').lean()).toEqual(before);
  });

  it('conceals source, owner and freeze failures while propagating database uncertainty', async () => {
    process.env.UPLOAD_SECURITY_POLICY_SHA256 = securityPolicySha256;
    await ready('source-guards');
    expect(await inspectFileSources(a, other, ['source-guards'])).toEqual([
      { state: 'unavailable', fileId: 'source-guards' },
    ]);
    await a.models.UploadOperation.updateOne(
      { _id: 'source-guards' },
      { $set: { 'original.bytes': 9 } },
    );
    expect(await inspectFileSources(a, user, ['source-guards'])).toEqual([
      { state: 'unavailable', fileId: 'source-guards' },
    ]);
    await a.models.UploadOperation.updateOne(
      { _id: 'source-guards' },
      { $set: { 'original.bytes': 8 } },
    );
    await a.models.File.updateOne(
      { file_id: 'source-guards' },
      { $set: { 'retentionActivity.migrationEpoch': 'source-freeze' } },
    );
    expect(await inspectFileSources(a, user, ['source-guards'])).toEqual([
      { state: 'unavailable', fileId: 'source-guards' },
    ]);
    await a.models.File.updateOne(
      { file_id: 'source-guards' },
      { $unset: { 'retentionActivity.migrationEpoch': 1 } },
    );
    await a.models.User.updateOne({ _id: user.userId }, { $set: { authDisabled: true } });
    expect(await inspectFileSources(a, user, ['source-guards'])).toEqual([
      { state: 'unavailable', fileId: 'source-guards' },
    ]);
    await a.models.User.updateOne({ _id: user.userId }, { $unset: { authDisabled: 1 } });
    const failure = jest.spyOn(a.models.UploadOperation, 'findOne').mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });
    await expect(inspectFileSources(a, user, ['source-guards'])).rejects.toThrow(
      'database unavailable',
    );
    failure.mockRestore();
  });

  it('retains ordinary and legacy capped unmanaged semantics only behind the existing gate', async () => {
    const previous = process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED;
    process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = 'false';
    try {
      const deadline = new Date(now + 86400000);
      for (const [id, retained] of [
        ['source-ordinary', false],
        ['source-legacy', true],
      ] as const) {
        await a.models.File.create({
          user: user.userId,
          tenantId: user.tenantId,
          file_id: id,
          filename: 'legacy.txt',
          filepath: '/legacy.txt',
          source: 'local',
          bytes: 8,
          type: 'text/plain',
          ...(retained ? { retentionAcceptedAt: new Date(now), expiredAt: deadline } : {}),
        });
      }
      expect(await inspectFileSources(a, user, ['source-ordinary', 'source-legacy'])).toEqual([
        { state: 'unmanaged', fileId: 'source-ordinary', sourceExpiresAt: null },
        { state: 'unmanaged', fileId: 'source-legacy', sourceExpiresAt: deadline },
      ]);
      expect(await resolveFileSources(a, user, ['source-ordinary', 'source-legacy'])).toEqual({
        sourceFileIds: ['source-legacy'],
        sourceExpiresAt: deadline,
      });
      for (const [id, explicit] of [
        ['guest-legacy-explicit', true],
        ['guest-legacy-missing', false],
      ] as const) {
        await a.models.File.create({
          user: guest.userId,
          ...(explicit ? { tenantId: null } : {}),
          file_id: id,
          filename: 'legacy.txt',
          filepath: '/legacy.txt',
          source: 'local',
          bytes: 8,
          type: 'text/plain',
          retentionAcceptedAt: new Date(now),
          expiredAt: deadline,
        });
      }
      expect(
        await inspectFileSources(a, guest, ['guest-legacy-explicit', 'guest-legacy-missing']),
      ).toEqual([
        { state: 'unmanaged', fileId: 'guest-legacy-explicit', sourceExpiresAt: deadline },
        { state: 'unavailable', fileId: 'guest-legacy-missing' },
      ]);
      process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = 'true';
      expect(await inspectFileSources(a, user, ['source-ordinary', 'source-legacy'])).toEqual([
        { state: 'unavailable', fileId: 'source-ordinary' },
        { state: 'unavailable', fileId: 'source-legacy' },
      ]);
    } finally {
      if (previous === undefined) delete process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED;
      else process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = previous;
    }
  });

  it('conflicts with a winning File freeze inside an existing source transaction', async () => {
    process.env.UPLOAD_SECURITY_POLICY_SHA256 = securityPolicySha256;
    await ready('source-transaction');
    const session = await a.startSession();
    try {
      session.startTransaction();
      await resolveFileSources(a, user, ['source-transaction'], session);
      await b.models.File.updateOne(
        { file_id: 'source-transaction' },
        { $set: { 'retentionActivity.migrationEpoch': 'winner' }, $inc: { retentionRevision: 1 } },
      );
      await expect(touchFileSources(a, user, ['source-transaction'], session)).rejects.toThrow();
      await session.abortTransaction();
    } finally {
      await session.endSession();
    }
    expect(
      (
        await a
          .model<IMongoFile>('File')
          .findOne({ file_id: 'source-transaction' })
          .select('+retentionActivity')
          .lean()
      )?.retentionActivity?.migrationEpoch,
    ).toBe('winner');
  });
});
