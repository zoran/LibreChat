/** Real replica-set evidence for the one durable upload store, through two independent clients. */
import mongoose from 'mongoose';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { uploadReservationFingerprint } from 'librechat-data-provider';
import type { UploadPrincipal, UploadLease } from 'librechat-data-provider';
import type { UploadDerivedIntent } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { StoredUpload, CounterRow } from './uploadManagementStore';
import type { HousekeepingJobRecord } from '../models/housekeepingJob';
import type { StoredFileReadReceipt } from '../types/fileActivity';
import {
  uploadSecurityFixture,
  uploadSecuritySettlementFixture,
  bindUploadOriginalFixture,
} from './uploadManagement.security.fixture';
import { createUploadManagementRepository } from './uploadManagement';
import { projectFileActivitySnapshot } from './fileActivitySnapshot';
import { createHousekeepingStore } from './housekeepingStore';
import { FileSourceUnavailableError } from './fileRetention';
import { createFileWorkspaceMethods } from './fileWorkspace';
import { createFileRetentionMethods } from './fileRetention';
import { currentFileDeadline } from './fileSourceAuthority';
import { createModels } from '~/models';

/** Deterministic UUIDv4-shaped test keys keep operation labels out of the public key contract. */
const fixtureKey = (label: string): string => {
  const hex = createHash('sha256').update(label).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

describe('Derived current authority and frozen migration', () => {
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
      processes: mongo.servers.flatMap((server) => {
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
                  kind,
                  pid,
                  port: info?.port,
                  dbPath: kind === 'mongod' ? info?.dbPath : undefined,
                  start: readFileSync(`/proc/${pid}/stat`, 'utf8')
                    .split(')')[1]
                    .trim()
                    .split(' ')[19],
                },
              ]
            : [],
        );
      }),
    };
    registerMongo('running');
    if (process.env.CORTEX_FILE_ACTIVITY_EVIDENCE_DIR)
      writeFileSync(
        `${process.env.CORTEX_FILE_ACTIVITY_EVIDENCE_DIR}/mongo-${process.pid}.json`,
        JSON.stringify(mongoCustody, null, 2),
      );
    await Promise.all([
      a.connect(mongo.getUri('retention_data_derived_private')),
      b.connect(mongo.getUri('retention_data_derived_private'), { monitorCommands: true }),
      replacement.connect(mongo.getUri('retention_data_derived_target')),
    ]);
    for (const db of [a, b, replacement]) createModels(db);
    await Promise.all([
      a.models.File.init(),
      b.models.File.init(),
      replacement.models.File.init(),
      ...[a, b, replacement].map((db) => createHousekeepingStore(db).initialize()),
    ]);
  });
  beforeEach(async () => {
    process.env.UPLOAD_SECURITY_POLICY_SHA256 = securityPolicySha256;
    for (const db of [a, replacement]) {
      for (const name of [
        'User',
        'File',
        'Message',
        'UploadOperation',
        'UploadCounter',
        'FileReadReceipt',
        'HousekeepingJob',
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
      registerMongo('settled');
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

  async function accepted(
    id: string,
    bytes = 8,
    at = now,
    principal = user,
    derived?: UploadDerivedIntent,
  ) {
    const reservation = derived
      ? await first.reserveDerived(
          principal,
          {
            ...request(id, bytes),
            derived,
            fingerprint: uploadReservationFingerprint(
              { ...request(id, bytes), scope: { kind: 'personal' } },
              derived,
            ),
          },
          at,
        )
      : await first.reserve(principal, request(id, bytes), at);
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
      { ...receipt(lease!, bytes), ...(derived ? { filepath: `/api/files/managed/${id}` } : {}) },
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
  async function ready(
    id: string,
    bytes = 8,
    at = now,
    principal = user,
    derived?: UploadDerivedIntent,
  ) {
    const result = await accepted(id, bytes, at, principal, derived);
    const lease = await processing(result.operation.id, at);
    await first.publish(lease, documentResult('document', bytes), at);
    await second.confirmCleanup(localGone(lease), at);
    return result;
  }

  function registerMongo(status: 'running' | 'settled') {
    if (!process.env.RETENTION_RUN_SCOPE || !process.env.RETENTION_RUN_KEY) return;
    execFileSync('python3', [
      `${process.env.RETENTION_RUN_SCOPE}/runner/register-mongo.py`,
      status,
      JSON.stringify(mongoCustody.processes),
    ]);
  }
  const DAY = 86400000;
  const binding = {
    purpose: 'workspace-draft' as const,
    sourceId: 'workspace-a',
    sourceRevision: 1,
  };
  const raw = (id: string, db = a) => db.models.File.collection.findOne({ file_id: id });
  async function transaction<T>(
    action: (session: ClientSession) => Promise<T>,
    db = a,
  ): Promise<T> {
    const session = await db.startSession();
    try {
      return await session.withTransaction(() => action(session));
    } finally {
      await session.endSession();
    }
  }
  async function trackedBaseline(id: string, days: number) {
    // A truthful pre-tracking baseline models a previously accepted source with a shorter remaining life.
    const deadline = new Date(now + days * DAY);
    await a.models.File.collection.updateOne(
      { file_id: id },
      {
        $set: {
          expiredAt: deadline,
          retentionActivity: {
            version: 1,
            baselineDeadlineAt: deadline,
            trackedSince: new Date(now),
            historyConfidence: 'since-tracking',
            readCount: 0,
            processingCount: 0,
            deadlineGeneration: 0,
          },
        },
      },
    );
    await a.models.UploadOperation.updateOne(
      { _id: id },
      { $set: { expiresAt: deadline.getTime() } },
    );
    // This fixture represents a source predating tracking and Housekeeping, not a generation reset.
    await a.models.HousekeepingJob.deleteMany({ 'work.subject.fileId': id });
  }
  async function child(id: string, sources: string[], publish = true) {
    const intent = { binding: { ...binding, sourceId: id }, directSourceFileIds: sources };
    return publish ? ready(id, 8, now, user, intent) : accepted(id, 8, now, user, intent);
  }
  async function claimedRead(id: string, repo = first) {
    const ticket = await repo.fileReads.admitManagedFileRead(user, {
      fileId: id,
      representation: 'original',
    });
    const claim = await repo.fileReads.claimManagedFileRead(user, ticket, worker);
    const evidence = {
      version: 1 as const,
      representation: 'original' as const,
      sourceBindingSha256: claim.sourceBindingSha256,
      contentSha256: 'a'.repeat(64),
      verifiedBytes: 8,
    };
    return { ticket, claim, evidence };
  }
  async function read(id: string, repo = first) {
    const value = await claimedRead(id, repo);
    return repo.fileReads.completeManagedFileRead(user, value.claim, value.evidence);
  }

  it('atomically refreshes multiple sources and descendants under two distinct concurrent reads, retaining own caps and origin witnesses', async () => {
    await ready('parent-a');
    await trackedBaseline('parent-a', 14);
    await ready('parent-b');
    await trackedBaseline('parent-b', 20);
    await child('child', ['parent-a', 'parent-b']);
    await child('grandchild', ['child'], false);
    const beforeChild = (await raw('child'))!;
    const beforeGrandchild = (await raw('grandchild'))!;
    const globals = await a.model<CounterRow>('UploadCounter').findById('global').lean();
    const claims = await Promise.all([
      claimedRead('parent-a', first),
      claimedRead('parent-a', second),
    ]);
    const outcomes = await Promise.all(
      claims.map((value, index) =>
        (index ? second : first).fileReads.completeManagedFileRead(
          user,
          value.claim,
          value.evidence,
        ),
      ),
    );
    expect(outcomes).toEqual([
      expect.objectContaining({ status: 'completed' }),
      expect.objectContaining({ status: 'completed' }),
    ]);
    expect((await raw('parent-a'))!.expiredAt.getTime()).toBe(now + 28 * DAY);
    for (const [id, prior] of [
      ['child', beforeChild],
      ['grandchild', beforeGrandchild],
    ] as const) {
      const file = (await raw(id))!;
      expect(file.expiredAt.getTime()).toBe(now + 20 * DAY);
      expect(file.derivedRetention.ownDeadlineAt.getTime()).toBe(now + 28 * DAY);
      expect(file.derivedRetention.deadlineGeneration).toBe(1);
      expect(file.derivedOrigin).toEqual(prior.derivedOrigin);
      expect((await a.model<StoredUpload>('UploadOperation').findById(id).lean())!.expiresAt).toBe(
        file.expiredAt.getTime(),
      );
    }
    expect(await a.model<CounterRow>('UploadCounter').findById('global').lean()).toEqual(globals);
    const staleOrigin = beforeChild.derivedOrigin;
    const workspace = createFileWorkspaceMethods(a, { securityPolicySha256 });
    expect(
      (
        await workspace.getWorkspaceFile(
          user,
          { fileId: 'child', binding: staleOrigin.binding },
          Date.now(),
        )
      ).expiredAt.getTime(),
    ).toBe(now + 20 * DAY);
    await a.models.UploadOperation.deleteOne({ _id: 'child' });
    await expect(
      workspace.getWorkspaceFile(
        user,
        { fileId: 'child', binding: staleOrigin.binding },
        Date.now(),
      ),
    ).rejects.toThrow(FileSourceUnavailableError);
  });

  it('accepts an already reserved derivative against extended current parents without rewriting its origin capture', async () => {
    await ready('parent');
    await trackedBaseline('parent', 14);
    const derived = { binding, directSourceFileIds: ['parent'] };
    await first.reserveDerived(
      user,
      {
        ...request('child'),
        derived,
        fingerprint: uploadReservationFingerprint(
          { ...request('child'), scope: { kind: 'personal' } },
          derived,
        ),
      },
      now,
    );
    const origin = (await a.model<StoredUpload>('UploadOperation').findById('child').lean())!
      .derivedOrigin;
    await read('parent');
    const lease = (await first.claim({
      kind: 'transfer',
      principal: user,
      operationId: 'child',
      worker,
      now,
    }))!;
    await completeScanner(lease, now);
    await second.accept(
      user,
      lease,
      { ...receipt(lease), filepath: '/api/files/managed/child' },
      approval(lease),
      { filename: 'note.txt' },
      now,
    );
    await first.confirmCleanup(localGone(lease), now);
    const file = (await raw('child'))!;
    expect(file.expiredAt.getTime()).toBe(now + 21 * DAY);
    expect(file.derivedRetention.ownDeadlineAt.getTime()).toBe(now + 28 * DAY);
    expect(file.derivedOrigin).toEqual(origin);
    expect(file.derivedOrigin.ancestors[0].expiresAt).toBe(now + 14 * DAY);
  });

  it('rolls back the root success when a live descendant is frozen or lacks its actual Upload receipt', async () => {
    await ready('parent');
    await trackedBaseline('parent', 14);
    await child('child', ['parent']);
    const original = (await raw('parent'))!;
    const value = await claimedRead('parent');
    await a.models.File.collection.updateOne(
      { file_id: 'child' },
      { $set: { 'derivedRetention.migrationEpoch': 'foreign-freeze' } },
    );
    expect(
      await first.fileReads.completeManagedFileRead(user, value.claim, value.evidence),
    ).toEqual({ status: 'unknown' });
    expect((await raw('parent'))!.expiredAt).toEqual(original.expiredAt);
    await a.models.File.collection.updateOne(
      { file_id: 'child' },
      { $unset: { 'derivedRetention.migrationEpoch': '' } },
    );
    await a.models.UploadOperation.deleteOne({ _id: 'child' });
    expect(
      await first.fileReads.completeManagedFileRead(user, value.claim, value.evidence),
    ).toEqual({ status: 'unknown' });
    expect((await raw('parent'))!.retentionActivity).toEqual(original.retentionActivity);
    expect(
      (await a.model<StoredUpload>('UploadOperation').findById('parent').lean())!.expiresAt,
    ).toBe(original.expiredAt.getTime());
  });

  it('does not resurrect expired descendants and rejects stale cleanup after a parent extension', async () => {
    await ready('parent');
    await trackedBaseline('parent', 14);
    await child('child', ['parent']);
    const before = (await raw('parent'))!;
    const expired = new Date(Date.now() - 1);
    await a.models.File.collection.updateOne(
      { file_id: 'child' },
      { $set: { expiredAt: expired } },
    );
    await a.models.UploadOperation.updateOne(
      { _id: 'child' },
      { $set: { expiresAt: expired.getTime() } },
    );
    await read('parent');
    expect((await raw('child'))!.expiredAt).toEqual(expired);
    const lifecycle = createFileRetentionMethods(a, { securityPolicySha256 });
    expect(
      await transaction((session) =>
        lifecycle.revokeExpiredManagedUpload(
          user,
          'parent',
          before.expiredAt.getTime(),
          now + 100 * DAY,
          session,
        ),
      ),
    ).toBe(false);
    expect((await raw('parent'))!.deletionRequestedAt).toBeUndefined();
    expect(
      await transaction((session) =>
        lifecycle.revokeExpiredManagedUpload(user, 'child', expired.getTime(), Date.now(), session),
      ),
    ).toBe(true);
    expect((await raw('child'))!.retentionRevocationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await a
        .model<HousekeepingJobRecord>('HousekeepingJob')
        .findOne({
          handler: 'file.cleanup',
          'work.subject.fileId': 'child',
        })
        .lean(),
    ).not.toBeNull();
  });

  it('fails the bounded refresh before acknowledging a root read when the descendant bound is exceeded', async () => {
    await ready('parent');
    await trackedBaseline('parent', 14);
    await child('child', ['parent']);
    const prototype = (await raw('child'))!;
    await a.models.File.collection.insertMany(
      Array.from({ length: 64 }, (_, index) => ({
        ...prototype,
        _id: new mongoose.Types.ObjectId(),
        file_id: `capacity-${index}`,
        uploadOperationId: `capacity-${index}`,
      })),
    );
    const before = (await raw('parent'))!;
    expect(await read('parent')).toEqual({ status: 'unknown' });
    expect((await raw('parent'))!.expiredAt).toEqual(before.expiredAt);
  });

  it('refreshes the admitted 64-descendant bound through the ancestor index inside the existing read budget', async () => {
    await ready('parent');
    await trackedBaseline('parent', 14);
    for (let index = 0; index < 64; index++) await child(`bound-${index}`, ['parent'], index < 63);
    const before = await a.model<CounterRow>('UploadCounter').findById('global').lean();
    const plan: unknown = await a.models.File.collection
      .find({
        user: new mongoose.Types.ObjectId(user.userId),
        tenantId: user.tenantId,
        'derivedOrigin.ancestors.subject.operationId': 'parent',
        deletionCompletedAt: null,
      })
      .hint('file_derived_ancestors')
      .limit(65)
      .explain('executionStats');
    const start = performance.now();
    expect(await read('parent')).toMatchObject({ status: 'completed', firstCompletion: true });
    const elapsedMs = performance.now() - start;
    const files = await a.models.File.collection.find({ file_id: /^bound-/ }).toArray();
    expect(files).toHaveLength(64);
    expect(
      files.every(
        (file) =>
          file.expiredAt.getTime() === now + 21 * DAY &&
          file.derivedRetention.deadlineGeneration === 1,
      ),
    ).toBe(true);
    expect(await a.model<CounterRow>('UploadCounter').findById('global').lean()).toEqual(before);
    if (
      !plan ||
      typeof plan !== 'object' ||
      !('queryPlanner' in plan) ||
      !plan.queryPlanner ||
      typeof plan.queryPlanner !== 'object' ||
      !('winningPlan' in plan.queryPlanner) ||
      !('executionStats' in plan) ||
      !plan.executionStats ||
      typeof plan.executionStats !== 'object' ||
      !('totalDocsExamined' in plan.executionStats)
    )
      throw new Error('Mongo explain omitted the indexed query execution evidence');
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain('file_derived_ancestors');
    expect(plan.executionStats.totalDocsExamined).toBe(64);
    if (process.env.CORTEX_FILE_ACTIVITY_EVIDENCE_DIR)
      writeFileSync(
        `${process.env.CORTEX_FILE_ACTIVITY_EVIDENCE_DIR}/bounded-refresh.json`,
        JSON.stringify(
          {
            descendants: 64,
            parentsPerDescendant: 1,
            elapsedMs,
            plan,
            scope: 'one local replica set; no wider source-union or native performance claim',
          },
          null,
          2,
        ),
      );
  }, 60000);

  it('keeps unknown warning evidence and does not schedule another generation on read replay', async () => {
    await ready('parent');
    const warning = await a
      .model<HousekeepingJobRecord>('HousekeepingJob')
      .findOne({
        handler: 'file.warning',
        'work.subject.fileId': 'parent',
        generation: 1,
        'work.offsetDays': 7,
      })
      .lean();
    expect(warning).not.toBeNull();
    await a.connection
      .collection<HousekeepingJobRecord>(a.models.HousekeepingJob.collection.name)
      .updateOne(
        { _id: warning!._id },
        {
          $set: {
            state: 'unknown',
            'execution.phase': 'unknown',
            'execution.receiptRef': 'synthetic-unknown-submission',
          },
        },
      );
    const retained = await a
      .model<HousekeepingJobRecord>('HousekeepingJob')
      .findById(warning!._id)
      .lean();
    const value = await claimedRead('parent');
    expect(
      await first.fileReads.completeManagedFileRead(user, value.claim, value.evidence),
    ).toMatchObject({ status: 'completed', firstCompletion: true });
    const count = await a.models.HousekeepingJob.countDocuments({
      'work.subject.fileId': 'parent',
    });
    expect(
      await second.fileReads.completeManagedFileRead(user, value.claim, value.evidence),
    ).toMatchObject({ status: 'completed', firstCompletion: false });
    expect(
      await a.model<HousekeepingJobRecord>('HousekeepingJob').findById(warning!._id).lean(),
    ).toEqual(retained);
    expect(await a.models.HousekeepingJob.countDocuments({ 'work.subject.fileId': 'parent' })).toBe(
      count,
    );
    expect(
      await a.models.HousekeepingJob.countDocuments({
        'work.subject.fileId': 'parent',
        generation: 2,
      }),
    ).toBe(3);
  });

  it('rolls back File, Upload, descendants and the success receipt when actual Housekeeping projection fails', async () => {
    await ready('parent');
    await trackedBaseline('parent', 14);
    await child('child', ['parent']);
    const beforeParent = (await raw('parent'))!,
      beforeChild = (await raw('child'))!;
    const value = await claimedRead('parent');
    await a.connection.db!.command({
      collMod: 'housekeeping_jobs',
      validator: { $nor: [{ 'work.subject.fileId': 'child', generation: 1 }] },
      validationLevel: 'strict',
    });
    try {
      expect(
        await first.fileReads.completeManagedFileRead(user, value.claim, value.evidence),
      ).toEqual({ status: 'unknown' });
      expect((await raw('parent'))!.expiredAt).toEqual(beforeParent.expiredAt);
      expect((await raw('child'))!.expiredAt).toEqual(beforeChild.expiredAt);
      expect(
        (await a.model<StoredUpload>('UploadOperation').findById('child').lean())!.expiresAt,
      ).toBe(beforeChild.expiredAt.getTime());
      expect(
        (await a
          .model<StoredFileReadReceipt>('FileReadReceipt')
          .findById(value.claim.readKey)
          .lean())!.completion,
      ).toBeUndefined();
    } finally {
      await a.connection.db!.command({ collMod: 'housekeeping_jobs', validator: {} });
    }
  });

  async function frozenPages(legacy = false) {
    await ready('z-parent');
    await trackedBaseline('z-parent', 14);
    await child('a-child', ['z-parent']);
    if (legacy) {
      const file = (await raw('a-child'))!;
      const oldOrigin = {
        ...file.derivedOrigin,
        version: 1,
        ancestors: file.derivedOrigin.ancestors.map(
          ({ sourceBindingSha256: _binding, ...source }: { sourceBindingSha256: string }) => source,
        ),
      };
      await a.models.File.collection.updateOne(
        { file_id: 'a-child' },
        { $set: { derivedOrigin: oldOrigin }, $unset: { derivedRetention: '' } },
      );
      await a.models.UploadOperation.updateOne(
        { _id: 'a-child' },
        { $set: { derivedOrigin: oldOrigin } },
      );
      await a.models.File.collection.updateOne(
        { file_id: 'z-parent' },
        { $unset: { retentionActivity: '' } },
      );
    }
    const firstPage = await first.exportSnapshot({ epoch: 'derived-cutover', limit: 1 });
    expect(firstPage.version).toBe(2);
    expect(firstPage.nextCursor).toBe('a-child');
    const secondPage = await first.exportSnapshot({
      epoch: 'derived-cutover',
      cursor: 'a-child',
      limit: 1,
    });
    expect(secondPage.nextCursor).toBeNull();
    const files = await a.models.File.collection.find({}).toArray();
    await replacement.models.File.collection.insertMany(files);
    return { firstPage, secondPage };
  }

  it('imports a child before its parent across two pages and thaws only after full actual-receipt coverage', async () => {
    const { firstPage, secondPage } = await frozenPages(true);
    await target.importSnapshot(firstPage);
    expect(
      await replacement.model<StoredUpload>('UploadOperation').findById('z-parent').lean(),
    ).toBeNull();
    expect((await raw('a-child', replacement))!.derivedRetention.migrationEpoch).toBe(
      'derived-cutover',
    );
    await expect(
      createFileWorkspaceMethods(replacement, { securityPolicySha256 }).getWorkspaceFile(
        user,
        { fileId: 'a-child', binding: { ...binding, sourceId: 'a-child' } },
        Date.now(),
      ),
    ).rejects.toThrow(FileSourceUnavailableError);
    await target.importSnapshot(secondPage);
    const receipt = await first.completeExport('derived-cutover');
    expect(receipt.fileActivity.files).toBe(2);
    await target.completeImport({ receipt, baseline, lifecycleReconciled: true });
    const childFile = (await raw('a-child', replacement))!;
    const parentFile = (await raw('z-parent', replacement))!;
    expect(childFile.derivedRetention.migrationEpoch).toBeUndefined();
    expect(parentFile.retentionActivity.migrationEpoch).toBeUndefined();
    expect(childFile.derivedRetention.capBasis).toBe('legacy-baseline');
    expect(childFile.derivedRetention.ownDeadlineAt.getTime()).toBe(now + 14 * DAY);
    expect(childFile.derivedOrigin.version).toBe(2);
    expect(projectFileActivitySnapshot(childFile as never, new Date()).readCount).toEqual({
      known: false,
    });
    expect(currentFileDeadline(parentFile as never).deadlineAt.getTime()).toBe(now + 14 * DAY);
    expect(await replacement.models.FileReadReceipt.countDocuments()).toBe(0);
    await expect(
      target.completeImport({ receipt, baseline, lifecycleReconciled: true }),
    ).resolves.toBeUndefined();
  });

  it('fails the final barrier for a missing parent receipt and keeps every imported File frozen', async () => {
    const { firstPage, secondPage } = await frozenPages();
    await target.importSnapshot(firstPage);
    await target.importSnapshot(secondPage);
    const receipt = await first.completeExport('derived-cutover');
    const extra = {
      ...(await raw('a-child', replacement))!,
      _id: new mongoose.Types.ObjectId(),
      file_id: 'unproved-file',
      uploadOperationId: 'unproved-file',
    };
    await replacement.models.File.collection.insertOne(extra);
    await expect(
      target.completeImport({ receipt, baseline, lifecycleReconciled: true }),
    ).rejects.toThrow();
    expect((await raw('unproved-file', replacement))!.derivedRetention.migrationEpoch).toBe(
      'derived-cutover',
    );
    await replacement.models.File.collection.deleteOne({ file_id: 'unproved-file' });
    await replacement.models.UploadOperation.deleteOne({ _id: 'z-parent' });
    await expect(
      target.completeImport({ receipt, baseline, lifecycleReconciled: true }),
    ).rejects.toThrow();
    expect((await raw('a-child', replacement))!.derivedRetention.migrationEpoch).toBe(
      'derived-cutover',
    );
    expect((await raw('z-parent', replacement))!.retentionActivity.migrationEpoch).toBe(
      'derived-cutover',
    );
    const global = await replacement
      .model<CounterRow>('UploadCounter')
      .findById('global')
      .lean()
      .orFail();
    if (!('enabled' in global.value)) throw new Error('Expected the global upload counter');
    expect(global.value.enabled).toBe(false);
  });
});
