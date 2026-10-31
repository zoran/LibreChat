/** Real replica-set evidence for the one durable upload store, through two independent clients. */
import mongoose from 'mongoose';
import { createHash } from 'crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { serializeManagedFileReadPreview } from 'librechat-data-provider';
import type { UploadPrincipal, UploadLease } from 'librechat-data-provider';
import type { StoredUpload, CounterRow } from './uploadManagementStore';
import type { StoredFileReadReceipt } from '../types/fileActivity';
import type { IMongoFile } from '../types/file';
import {
  uploadSecurityFixture,
  uploadSecuritySettlementFixture,
  bindUploadOriginalFixture,
} from '../../specs/fixtures/uploadManagement.security.fixture';
import { initialFileRetentionActivity } from './fileActivityTransition';
import { createUploadManagementRepository } from './uploadManagement';
import { projectFileActivitySnapshot } from './fileActivitySnapshot';
import { pruneExpiredFileReadReceipts } from './fileReadReceiptGc';
import { createFileActivityStore } from './fileActivityStore';
import { createUploadStore } from './uploadManagementStore';
import { createFileMethods } from './file';
import { createModels } from '~/models';

/** Deterministic UUIDv4-shaped test keys keep operation labels out of the public key contract. */
const fixtureKey = (label: string): string => {
  const hex = createHash('sha256').update(label).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Required File lifecycle fixture value is missing');
  return value;
}

describe('File-owned finite activity lifecycle', () => {
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
      a.connect(mongo.getUri('retention_data_activity_private')),
      b.connect(mongo.getUri('retention_data_activity_private'), { monitorCommands: true }),
      replacement.connect(mongo.getUri('retention_data_activity_unused')),
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

  it('starts at 28 days and adds 7 once for the first successful publication', async () => {
    const { operation } = await accepted('activity-baseline');
    expect(operation.expiresAt).toBe(new Date(now + 28 * 86400000).toISOString());
    const lease = await processing(operation.id);
    const published = await first.publish(lease, documentResult('document'), now);
    expect(published.expiresAt).toBe(new Date(now + 35 * 86400000).toISOString());
    const replay = await second.publish(lease, documentResult('document'), now);
    expect(replay.expiresAt).toBe(published.expiresAt);
    const row = await a
      .model<IMongoFile>('File')
      .findOne({ file_id: operation.id })
      .select('+retentionActivity')
      .lean()
      .orFail();
    expect(row).toMatchObject({
      retentionActivity: { readCount: 0, processingCount: 1, deadlineGeneration: 1 },
    });
  });

  it('adds one week per distinct read and zero for retries without changing quota resources', async () => {
    await ready('activity-reads');
    expect(first.fileReads).toBeDefined();
    const before = await a.model<CounterRow>('UploadCounter').findById('global').lean().orFail();
    const usage = await first.usage(user, now);
    const one = await first.fileReads.admitManagedFileRead(user, {
      fileId: 'activity-reads',
      representation: 'original',
    });
    const claim = await second.fileReads.claimManagedFileRead(user, one, worker);
    const evidence = {
      version: 1 as const,
      representation: 'original' as const,
      sourceBindingSha256: claim.sourceBindingSha256,
      contentSha256: 'a'.repeat(64),
      verifiedBytes: 8,
    };
    expect(await first.fileReads.completeManagedFileRead(user, claim, evidence)).toMatchObject({
      status: 'completed',
      firstCompletion: true,
    });
    expect((await first.get(user, one.fileId, Date.now())).expiresAt).toBe(
      new Date(now + 42 * 86400000).toISOString(),
    );
    expect(await second.fileReads.completeManagedFileRead(user, claim, evidence)).toMatchObject({
      status: 'completed',
      firstCompletion: false,
    });
    const two = await first.fileReads.admitManagedFileRead(user, {
      fileId: one.fileId,
      representation: 'original',
    });
    const three = await second.fileReads.admitManagedFileRead(user, {
      fileId: one.fileId,
      representation: 'original',
    });
    const claims = await Promise.all([
      first.fileReads.claimManagedFileRead(user, two, worker),
      second.fileReads.claimManagedFileRead(user, three, { hostId: 'host-b', instanceId: 'app-b' }),
    ]);
    const results = await Promise.all(
      claims.map((c, i) =>
        (i ? second : first).fileReads.completeManagedFileRead(user, c, {
          ...evidence,
          sourceBindingSha256: c.sourceBindingSha256,
        }),
      ),
    );
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'completed', firstCompletion: true }),
      ]),
    );
    expect(results.every((r) => r.status === 'completed')).toBe(true);
    const row = await a
      .model<IMongoFile>('File')
      .findOne({ file_id: one.fileId })
      .select('+retentionActivity')
      .lean()
      .orFail();
    expect(row).toMatchObject({
      expiredAt: new Date(now + 56 * 86400000),
      retentionActivity: { readCount: 3, processingCount: 1, deadlineGeneration: 4 },
    });
    expect((await first.get(user, one.fileId, Date.now())).expiresAt).toBe(
      new Date(now + 56 * 86400000).toISOString(),
    );
    expect(await a.model<CounterRow>('UploadCounter').findById('global').lean().orFail()).toEqual(
      before,
    );
    expect(await first.usage(user, now)).toEqual(usage);
    const stored = await a
      .model<StoredFileReadReceipt>('FileReadReceipt')
      .findById(claim.readKey)
      .lean()
      .orFail();
    expect(stored).not.toHaveProperty('readId');
    expect(new Date(stored.notAfter).getTime()).toBe(new Date(one.notAfter).getTime());
    expect(await first.fileReads.inspectManagedFileRead(user, one)).toMatchObject({
      status: 'completed',
    });
  });

  const newRead = async (fileId: string, representation: 'original' | 'preview' = 'original') => {
    const ticket = await first.fileReads.admitManagedFileRead(user, { fileId, representation });
    const claim = await first.fileReads.claimManagedFileRead(user, ticket, worker);
    return {
      ticket,
      claim,
      evidence: {
        version: 1 as const,
        representation,
        sourceBindingSha256: claim.sourceBindingSha256,
        contentSha256: 'a'.repeat(64),
        verifiedBytes: 8,
      },
    };
  };

  it('fences stale workers, renews the same claim, and retains immutable completion across failed byte replay', async () => {
    await ready('claim-life');
    const { ticket, claim, evidence } = await newRead('claim-life');
    const fileBefore = await a
      .model<IMongoFile>('File')
      .findOne({ file_id: ticket.fileId })
      .lean()
      .orFail();
    const renewal = await second.fileReads.claimManagedFileRead(user, ticket, worker, claim);
    expect(renewal).toMatchObject({
      claimId: claim.claimId,
      fence: claim.fence,
      notAfter: claim.notAfter,
    });
    expect(
      (await a.model<IMongoFile>('File').findOne({ file_id: ticket.fileId }).lean().orFail())
        .retentionRevision,
    ).toBe(required(fileBefore.retentionRevision) + 1);
    await expect(second.fileReads.claimManagedFileRead(user, ticket, worker)).rejects.toMatchObject(
      { code: 'busy' },
    );
    await a.models.FileReadReceipt.updateOne(
      { _id: claim.readKey },
      { $set: { 'claim.leaseUntil': new Date(Date.now() - 1) } },
    );
    const takeover = await second.fileReads.claimManagedFileRead(user, ticket, {
      hostId: 'host-b',
      instanceId: 'app-b',
    });
    expect(takeover.fence).toBe(claim.fence + 1);
    expect(await first.fileReads.completeManagedFileRead(user, claim, evidence)).toMatchObject({
      status: 'refused',
      reason: 'lease_lost',
    });
    expect(
      await second.fileReads.completeManagedFileRead(user, takeover, {
        ...evidence,
        sourceBindingSha256: takeover.sourceBindingSha256,
      }),
    ).toMatchObject({ status: 'completed', firstCompletion: true });
    const retry = await first.fileReads.claimManagedFileRead(user, ticket, worker);
    expect(await second.fileReads.completeManagedFileRead(user, takeover, evidence)).toMatchObject({
      status: 'completed',
      firstCompletion: false,
    });
    expect(
      required(
        (
          await a
            .model<StoredFileReadReceipt>('FileReadReceipt')
            .findById(claim.readKey)
            .lean()
            .orFail()
        ).claim,
      ).claimId,
    ).toBe(retry.claimId);
    expect(
      await first.fileReads.abandonManagedFileRead(user, retry, { reason: 'read_failed' }),
    ).toMatchObject({ status: 'completed' });
    const finalRetry = await second.fileReads.claimManagedFileRead(user, ticket, worker);
    expect(
      await second.fileReads.completeManagedFileRead(user, finalRetry, evidence),
    ).toMatchObject({ status: 'completed', firstCompletion: false });
    expect(
      required(
        (
          await a
            .model<IMongoFile>('File')
            .findOne({ file_id: ticket.fileId })
            .select('+retentionActivity')
            .lean()
            .orFail()
        ).retentionActivity,
      ).readCount,
    ).toBe(1);
  });

  it.each(['expired', 'revoked', 'frozen', 'disabled'] as const)(
    'refuses current %s authority after admission without extending or refunding',
    async (kind) => {
      await ready(`denied-${kind}`);
      const { ticket, claim, evidence } = await newRead(`denied-${kind}`);
      const before = await a
        .model<IMongoFile>('File')
        .findOne({ file_id: ticket.fileId })
        .select('+retentionActivity')
        .lean()
        .orFail();
      const quota = await a.model<CounterRow>('UploadCounter').findById('global').lean().orFail();
      if (kind === 'expired')
        await a.models.File.updateOne(
          { file_id: ticket.fileId },
          { $set: { expiredAt: new Date(Date.now() - 1) } },
        );
      if (kind === 'revoked')
        await a.models.File.updateOne(
          { file_id: ticket.fileId },
          { $set: { deletionRequestedAt: new Date() }, $inc: { retentionRevision: 1 } },
        );
      if (kind === 'frozen')
        await a.models.File.updateOne(
          { file_id: ticket.fileId },
          {
            $set: { 'retentionActivity.migrationEpoch': 'migration-test' },
            $inc: { retentionRevision: 1 },
          },
        );
      if (kind === 'disabled')
        await a.models.User.updateOne({ _id: user.userId }, { $set: { authDisabled: true } });
      const result = await first.fileReads.completeManagedFileRead(user, claim, evidence);
      expect(result).toMatchObject({
        status: 'refused',
        reason: kind === 'expired' ? 'expired' : 'revoked',
      });
      const after = await a
        .model<IMongoFile>('File')
        .findOne({ file_id: ticket.fileId })
        .select('+retentionActivity')
        .lean()
        .orFail();
      expect(required(after.retentionActivity).readCount).toBe(
        required(before.retentionActivity).readCount,
      );
      expect(required(after.retentionActivity).deadlineGeneration).toBe(
        required(before.retentionActivity).deadlineGeneration,
      );
      expect(
        (await a.model<CounterRow>('UploadCounter').findById('global').lean().orFail()).value,
      ).toEqual(quota.value);
      await expect(
        first.fileReads.claimManagedFileRead(user, ticket, worker, claim),
      ).rejects.toBeDefined();
    },
  );

  it('refuses a processing publication using a captured old time after current expiry', async () => {
    const { operation } = await accepted('late-processing');
    const lease = await processing(operation.id);
    await a.models.File.updateOne(
      { file_id: operation.id },
      { $set: { expiredAt: new Date(Date.now() - 1) } },
    );
    await expect(first.publish(lease, documentResult('document'), now)).rejects.toBeDefined();
    expect(
      required(
        (
          await a
            .model<IMongoFile>('File')
            .findOne({ file_id: operation.id })
            .select('+retentionActivity')
            .lean()
            .orFail()
        ).retentionActivity,
      ).processingCount,
    ).toBe(0);
    expect(
      (await a.model<StoredUpload>('UploadOperation').findById(operation.id).lean().orFail()).state,
    ).toBe('processing');
  });

  it('requires actual serialized preview evidence and refuses a changed immutable source', async () => {
    await ready('preview-life');
    const { ticket, claim, evidence } = await newRead('preview-life', 'preview');
    expect(await first.fileReads.completeManagedFileRead(user, claim, evidence)).toMatchObject({
      status: 'refused',
      reason: 'source_changed',
    });
    const body = serializeManagedFileReadPreview(ticket.fileId, {
      text: 'document',
      structure: documentResult('document').structure,
    });
    const exact = {
      ...evidence,
      contentSha256: createHash('sha256').update(body).digest('hex'),
      verifiedBytes: Buffer.byteLength(body),
    };
    expect(await first.fileReads.completeManagedFileRead(user, claim, exact)).toMatchObject({
      status: 'completed',
      firstCompletion: true,
    });
    await a.models.File.updateOne({ file_id: ticket.fileId }, { $set: { text: 'altered!' } });
    expect(await first.fileReads.inspectManagedFileRead(user, ticket)).toMatchObject({
      status: 'refused',
      reason: 'source_changed',
    });
    await expect(first.fileReads.claimManagedFileRead(user, ticket, worker)).rejects.toMatchObject({
      code: 'source_changed',
    });
  });

  it('never fabricates legacy history and measures inactivity from the latest tracked success', async () => {
    await ready('legacy-history');
    const cutoff = new Date();
    const row = await a
      .model<IMongoFile>('File')
      .findOne({ file_id: 'legacy-history' })
      .select('+retentionActivity')
      .lean()
      .orFail();
    const initial = initialFileRetentionActivity(required(row.expiredAt), cutoff, 'since-tracking');
    await a.models.File.updateOne(
      { file_id: row.file_id },
      { $set: { retentionActivity: initial } },
    );
    let current = await a
      .model<IMongoFile>('File')
      .findOne({ file_id: row.file_id })
      .select('+retentionActivity')
      .orFail();
    const before = projectFileActivitySnapshot(current, cutoff);
    expect(before).toMatchObject({
      lastReadKnown: false,
      lastSuccessfulReadAt: null,
      inactivity: { known: false },
      readCount: { known: true, value: 0, coverage: 'since', since: cutoff.toISOString() },
    });
    const { claim, evidence } = await newRead(row.file_id);
    expect(await first.fileReads.completeManagedFileRead(user, claim, evidence)).toMatchObject({
      status: 'completed',
    });
    current = await a
      .model<IMongoFile>('File')
      .findOne({ file_id: row.file_id })
      .select('+retentionActivity')
      .orFail();
    const last = required(required(current.retentionActivity).lastSuccessfulReadAt);
    const after = projectFileActivitySnapshot(
      current,
      new Date(last.getTime() + 3 * 86400000 + 123),
    );
    expect(after).toMatchObject({
      lastReadKnown: true,
      readCount: { known: true, value: 1, coverage: 'since' },
      processingCount: { known: true, value: 0, coverage: 'since' },
      inactivity: { known: true, fullDays: 3, basis: 'successful-use', since: last.toISOString() },
    });
    expect(required(current.expiredAt).getTime()).toBe(
      required(row.expiredAt).getTime() + 7 * 86400000,
    );
  });

  it('uses finite indexed cleanup, refuses expired or missing IDs, and never upserts a replay', async () => {
    await ready('gc-life');
    const { ticket, claim, evidence } = await newRead('gc-life');
    expect(await first.fileReads.completeManagedFileRead(user, claim, evidence)).toMatchObject({
      status: 'completed',
    });
    const before = await a
      .model<IMongoFile>('File')
      .findOne({ file_id: ticket.fileId })
      .select('+retentionActivity')
      .lean()
      .orFail();
    await a.models.FileReadReceipt.updateOne(
      { _id: claim.readKey },
      { $set: { notAfter: new Date(Date.now() - 1) } },
    );
    expect(await first.fileReads.inspectManagedFileRead(user, ticket)).toMatchObject({
      status: 'refused',
      reason: 'expired',
    });
    expect(await first.fileReads.completeManagedFileRead(user, claim, evidence)).toMatchObject({
      status: 'refused',
      reason: 'expired',
    });
    const store = createFileActivityStore(a, createUploadStore(a, {}), { securityPolicySha256 });
    expect(await pruneExpiredFileReadReceipts(store)).toEqual({ removed: 1, unknown: 0 });
    expect(await first.fileReads.inspectManagedFileRead(user, ticket)).toMatchObject({
      status: 'refused',
      reason: 'not_found',
    });
    expect(await first.fileReads.completeManagedFileRead(user, claim, evidence)).toMatchObject({
      status: 'refused',
      reason: 'not_found',
    });
    expect(await a.models.FileReadReceipt.countDocuments()).toBe(0);
    expect(
      (
        await a
          .model<IMongoFile>('File')
          .findOne({ file_id: ticket.fileId })
          .select('+retentionActivity')
          .lean()
          .orFail()
      ).retentionActivity,
    ).toEqual(before.retentionActivity);
    await a.models.FileReadReceipt.init();
    const indexes = await a.models.FileReadReceipt.collection.indexes();
    expect(
      indexes.some((index) => index.key.notAfter === 1 && index.expireAfterSeconds === undefined),
    ).toBe(true);
    expect(indexes.some((index) => index.expireAfterSeconds !== undefined)).toBe(false);
  });

  it('reports database uncertainty as unknown and recovers using the original durable ticket', async () => {
    await ready('unknown-life');
    const { ticket, claim, evidence } = await newRead('unknown-life');
    const admin = a.connection.db!.admin();
    await admin.command({
      configureFailPoint: 'failCommand',
      mode: { times: 1 },
      data: { failCommands: ['find'], errorCode: 2 },
    });
    expect(await first.fileReads.completeManagedFileRead(user, claim, evidence)).toEqual({
      status: 'unknown',
    });
    expect(await second.fileReads.inspectManagedFileRead(user, ticket)).toMatchObject({
      status: 'reading',
    });
    expect(await second.fileReads.completeManagedFileRead(user, claim, evidence)).toMatchObject({
      status: 'completed',
      firstCompletion: true,
    });
    expect(
      required(
        (
          await a
            .model<IMongoFile>('File')
            .findOne({ file_id: ticket.fileId })
            .select('+retentionActivity')
            .lean()
            .orFail()
        ).retentionActivity,
      ).readCount,
    ).toBe(1);
  });

  it.each(['claim', 'renew'] as const)(
    'conflicts on the same File when a migration freeze wins against %s',
    async (kind) => {
      await ready(`freeze-race-${kind}`);
      const ticket = await first.fileReads.admitManagedFileRead(user, {
        fileId: `freeze-race-${kind}`,
        representation: 'original',
      });
      const previous =
        kind === 'renew'
          ? await first.fileReads.claimManagedFileRead(user, ticket, worker)
          : undefined;
      const held = await a.startSession();
      held.startTransaction({
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });
      await a.models.File.updateOne(
        { file_id: ticket.fileId },
        {
          $set: { 'retentionActivity.migrationEpoch': 'race-fence' },
          $inc: { retentionRevision: 1 },
        },
        { session: held },
      );
      let observed!: () => void;
      const attempted = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const listener = (event: mongoose.mongo.CommandStartedEvent) => {
        if (
          event.commandName === 'update' &&
          event.command.update === b.models.File.collection.name &&
          event.command.updates.some(
            (entry: { u?: { $inc?: { retentionRevision?: unknown } } }) =>
              entry.u?.$inc?.retentionRevision === 1,
          )
        )
          observed();
      };
      b.connection.getClient().on('commandStarted', listener);
      const result = second.fileReads.claimManagedFileRead(user, ticket, worker, previous).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          attempted,
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('File write not observed')), 2000);
          }),
        ]);
        await held.commitTransaction();
        expect(await result).toMatchObject({ error: { code: 'revoked' } });
      } finally {
        clearTimeout(timeout);
        b.connection.getClient().off('commandStarted', listener);
        if (held.inTransaction()) await held.abortTransaction();
        await held.endSession();
        await result;
      }
      const receipt = await a
        .model<StoredFileReadReceipt>('FileReadReceipt')
        .findOne({ fileId: ticket.fileId })
        .lean()
        .orFail();
      expect(receipt.fence).toBe(previous ? previous.fence : 0);
      expect(
        required(
          (
            await a
              .model<IMongoFile>('File')
              .findOne({ file_id: ticket.fileId })
              .select('+retentionActivity')
              .lean()
              .orFail()
          ).retentionActivity,
        ).readCount,
      ).toBe(0);
    },
  );

  it('recovers an actually committed success after lost majority acknowledgement without a second extension', async () => {
    await ready('commit-unknown');
    const { ticket, claim, evidence } = await newRead('commit-unknown');
    const admin = a.connection.db!.admin();
    await admin.command({
      configureFailPoint: 'failCommand',
      mode: 'alwaysOn',
      data: {
        failCommands: ['commitTransaction'],
        writeConcernError: {
          code: 64,
          errmsg: 'private injected majority acknowledgement uncertainty',
        },
        errorLabels: ['UnknownTransactionCommitResult'],
      },
    });
    try {
      expect(await first.fileReads.completeManagedFileRead(user, claim, evidence)).toEqual({
        status: 'unknown',
      });
    } finally {
      await admin.command({ configureFailPoint: 'failCommand', mode: 'off' });
    }
    expect(await second.fileReads.inspectManagedFileRead(user, ticket)).toMatchObject({
      status: 'completed',
    });
    expect(await second.fileReads.completeManagedFileRead(user, claim, evidence)).toMatchObject({
      status: 'completed',
      firstCompletion: false,
    });
    expect(
      required(
        (
          await a
            .model<IMongoFile>('File')
            .findOne({ file_id: ticket.fileId })
            .select('+retentionActivity')
            .lean()
            .orFail()
        ).retentionActivity,
      ).readCount,
    ).toBe(1);
    expect((await first.get(user, ticket.fileId, Date.now())).expiresAt).toBe(
      new Date(now + 42 * 86400000).toISOString(),
    );
  });

  it('keeps private activity outside ordinary File projections and generic File mutations', async () => {
    await ready('protected-activity');
    const file = await a
      .model<IMongoFile>('File')
      .findOne({ file_id: 'protected-activity' })
      .lean()
      .orFail();
    expect(file).not.toHaveProperty('retentionActivity');
    const methods = createFileMethods(a);
    const before = await a
      .model<IMongoFile>('File')
      .findOne({ file_id: file.file_id })
      .select('+retentionActivity')
      .lean()
      .orFail();
    await methods.updateFile({
      file_id: file.file_id,
      retentionActivity: { ...before.retentionActivity, readCount: 999 },
      'retentionActivity.deadlineGeneration': 999,
    } as never);
    expect(
      (
        await a
          .model<IMongoFile>('File')
          .findOne({ file_id: file.file_id })
          .select('+retentionActivity')
          .lean()
          .orFail()
      ).retentionActivity,
    ).toEqual(before.retentionActivity);
    await methods.createFile(
      {
        file_id: 'ordinary-forged',
        user: user.userId,
        tenantId: user.tenantId,
        filename: 'ordinary.txt',
        filepath: '/ordinary',
        bytes: 8,
        type: 'text/plain',
        retentionActivity: before.retentionActivity,
      } as never,
      true,
    );
    expect(
      await a
        .model<IMongoFile>('File')
        .findOne({ file_id: 'ordinary-forged' })
        .select('+retentionActivity')
        .lean()
        .orFail(),
    ).not.toHaveProperty('retentionActivity');
  });
});
