/** Actual Mongo transactions and File models; scanner/storage acknowledgements are explicit fixtures. */
import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { canonicalStorageDeletionReceipt } from 'librechat-data-provider';
import type {
  UploadIntakeGrant,
  UploadLease,
  UploadPromotionInput,
  UploadPromotionSettlement,
  UploadSecurityApproval,
  UploadStorageReceipt,
} from 'librechat-data-provider';
import type { IntakeControlOptions } from '../../../api/src/uploads/intake/control';
import type { StoredUpload } from './uploadManagementStore';
import { createUploadActorSettlement } from '../../../api/src/uploads/actorSettlement';
import { createIntakeControlHandlers } from '../../../api/src/uploads/intake/control';
import { createUploadAttemptJournal } from '../../../api/src/uploads/attempts';
import { createUploadManagementRepository } from './uploadManagement';
import { createModels } from '~/models';

describe('private Intake and App-promotion transaction fences', () => {
  let mongo: MongoMemoryReplSet;
  const a = new mongoose.Mongoose();
  const b = new mongoose.Mongoose();
  const replacement = new mongoose.Mongoose();
  let first: ReturnType<typeof createUploadManagementRepository>;
  let second: ReturnType<typeof createUploadManagementRepository>;
  let target: ReturnType<typeof createUploadManagementRepository>;
  const now = Date.now();
  const policy = 'c'.repeat(64);
  const cap = createHash('sha256').update('a'.repeat(43)).digest('hex');
  const otherCap = 'd'.repeat(64);
  const user = {
    tenantId: 'tenant-a',
    userId: new mongoose.Types.ObjectId().toString(),
    authentication: 'verified-email' as const,
  };
  const intakeWorker = { hostId: 'intake-host', instanceId: 'intake-a' };
  const appWorker = { hostId: 'app-host', instanceId: 'app-a' };
  const promotionId = '33333333-3333-4333-8333-333333333333';
  const sha256 = createHash('sha256').update('document').digest('hex');
  const integrity = {
    version: 1 as const,
    algorithm: 'sha256' as const,
    sha256,
    chunkBytes: 262144 as const,
    chunkSha256: [sha256],
  };
  const grant = (): UploadIntakeGrant => ({
    version: 1,
    principal: { ...user },
    sessionId: '111111111111111111111111',
    authVersion: 0,
    policyVersion: 1,
    expiresAt: new Date(now + 600_000).toISOString(),
  });
  const receipt = (lease: UploadLease): UploadStorageReceipt => ({
    outcome: 'durable',
    source: 's3',
    bytes: 8,
    filepath: `/api/files/download/${lease.operationId}`,
    storageKey: `t/${lease.tenantId}/managed-uploads/${lease.userId}/${lease.operationId}.${lease.generation}__original`,
    integrity: { ...integrity, chunkSha256: [...integrity.chunkSha256] },
  });
  const approval = (lease: UploadLease): UploadSecurityApproval => ({
    version: 1,
    decision: 'approved',
    policySha256: policy,
    subject: {
      tenantId: lease.tenantId,
      userId: lease.userId,
      operationId: lease.operationId,
      transferGeneration: lease.generation,
      mediaType: 'text/plain',
      bytes: 8,
      sha256,
    },
    scannerVersion: 'explicit-simulated-scanner-fixture',
    checkedAt: new Date(now).toISOString(),
    coverage: { complete: true, pages: 1, parts: 1 },
  });
  const input = (lease: UploadLease): UploadPromotionInput => ({
    version: 1,
    promotionId,
    lease: { ...lease },
    worker: { ...appWorker },
    approval: approval(lease),
    integrity: { ...integrity, chunkSha256: [...integrity.chunkSha256] },
    metadata: { filename: 'Freigegeben – Notiz.txt' },
  });
  const settlement = (lease: UploadLease): UploadPromotionSettlement => ({
    operationId: lease.operationId,
    transferGeneration: lease.generation,
    promotionId,
    worker: { ...appWorker },
    writerStopped: true,
    receipt: receipt(lease),
  });
  const cleanup = (lease: UploadLease) => ({
    operationId: lease.operationId,
    generation: lease.generation,
    writerStopped: true,
    localCopiesAbsent: true,
    originalAbsent: true,
    textAndHistoryRemoved: true,
  });
  const row = () => b.models.UploadOperation.findById('intake').lean<StoredUpload>();
  const accept = (lease: UploadLease, time = now) =>
    first.accept(user, lease, receipt(lease), approval(lease), input(lease).metadata, time);
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await Promise.all([
      a.connect(mongo.getUri('intake')),
      b.connect(mongo.getUri('intake')),
      replacement.connect(mongo.getUri('replacement')),
    ]);
    for (const db of [a, b, replacement]) createModels(db);
    await Promise.all([a.models.File.init(), b.models.File.init(), replacement.models.File.init()]);
  });
  beforeEach(async () => {
    for (const db of [a, replacement]) {
      for (const name of ['User', 'File', 'Message', 'UploadOperation', 'UploadCounter'])
        if (db.models[name]) await db.models[name].deleteMany({});
      await db.models.User.create({
        _id: user.userId,
        tenantId: user.tenantId,
        email: 'upload-intake@example.test',
        emailVerified: true,
      });
    }
    first = createUploadManagementRepository(a, {
      enabled: true,
      reconciled: true,
      baseline: { originalBytes: 0, objectBytes: 0, textBytes: 0, recordBytes: 0, bundles: 0 },
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
  async function reserve(capability = true) {
    await first.reserve(
      user,
      {
        operationId: 'intake',
        idempotencyKey: '44444444-4444-4444-8444-444444444444',
        mediaType: 'text/plain',
        declaredBytes: 8,
        fingerprint: JSON.stringify([{ kind: 'personal' }, 'text/plain', 8]),
      },
      now,
    );
    if (capability) await first.issueIntake(user, 'intake', cap, grant(), now);
  }
  const claim = (capability: string | undefined = cap, time = now) =>
    second.claim({
      kind: 'transfer',
      principal: user,
      operationId: 'intake',
      worker: intakeWorker,
      now: time,
      ...(capability === undefined ? {} : { intake: { capabilitySha256: capability } }),
    });
  async function transfer(scanned = true) {
    await reserve();
    const lease = (await claim())!;
    if (scanned) {
      const execution = {
        version: 2 as const,
        custody: { kind: 'none' as const },
        attemptId: `intake.${lease.generation}`,
        instanceId: '11111111-1111-4111-8111-111111111111',
        executionId: '22222222-2222-4222-8222-222222222222',
        expiresAt: new Date(now + 60_000).toISOString(),
      };
      await first.bindSecurityExecution(lease, execution, now);
      await second.settleSecurityExecution(
        lease,
        { execution, writerStopped: true, transientDataRemoved: true },
        now,
      );
    }
    return lease;
  }
  async function writing() {
    const lease = await transfer();
    await first.preparePromotion(input(lease), now);
    await second.beginPromotion(lease, promotionId, appWorker, now);
    return lease;
  }

  async function completeStorageCleanup(lease: UploadLease) {
    const authority = {
      operationId: lease.operationId,
      principal: user,
      generation: lease.generation,
      attemptGeneration: lease.generation,
    };
    const pending = await first.prepareCleanupStorage(authority);
    if (pending.state !== 'binding') throw Error('Expected original cleanup binding');
    const binding = {
      ...pending.request,
      bucket: 'private-bucket',
      key: receipt(lease).storageKey!,
    };
    await first.prepareCleanupStorage(authority, binding);
    const terminal = {
      ...binding,
      state: 'durable_delete_complete' as const,
      obligationId: 'obligation',
      aggregateRevision: '1',
      proofSHA256: 'e'.repeat(64),
    };
    const committed = await first.recordCleanupStorage(authority, { result: terminal });
    if (committed.state !== 'consume') throw Error('Expected committed cleanup receipt');
    await first.recordCleanupStorage(authority, {
      consumption: {
        state: 'recorded',
        obligationId: terminal.obligationId,
        receiptSHA256: createHash('sha256')
          .update(canonicalStorageDeletionReceipt(terminal))
          .digest('hex'),
        consumerCommitId: committed.consumerCommitId,
      },
    });
  }

  it('joins actual control unknown PUT, original Intake recovery, actor settlement and committed owner receipt', async () => {
    const env = { ...process.env };
    Object.assign(process.env, {
      AUTH_MODE: 'email_code',
      EMAIL_CODE_TENANT_ID: user.tenantId,
      EMAIL_CODE_ALLOWED_DOMAINS: 'employees.example.test',
      EMAIL_CODE_HMAC_KEY: 'test-only-separate-key-'.repeat(3),
      EMAIL_CODE_POLICY_VERSION: '1',
    });
    const appJournal = createUploadAttemptJournal(appWorker);
    const intakeJournal = createUploadAttemptJournal(intakeWorker);
    try {
      const lease = await transfer();
      await first.preparePromotion(input(lease), now);
      const recoverBinding = {
        version: 1 as const,
        operationId: 'intake',
        transferGeneration: lease.generation,
        worker: intakeWorker,
        capabilitySha256: cap,
      };
      const intakeRegistration = intakeJournal.attempts.begin(jest.fn());
      intakeRegistration.bind({
        ...intakeWorker,
        operationId: 'intake',
        generation: lease.generation,
      });
      intakeRegistration.recover!(async (proof) =>
        first.confirmIntakeRecovery(
          recoverBinding,
          {
            version: 1,
            operationId: 'intake',
            transferGeneration: lease.generation,
            worker: intakeWorker,
            localWriterStopped: true,
            localCopiesAbsent: proof.localCopiesAbsent,
          },
          now,
        ),
      );
      const handlers = createIntakeControlHandlers({
        repository: first,
        worker: appWorker,
        attempts: appJournal.attempts,
        now: () => now,
        resources: { assertSafe: async () => {} },
        management: {} as IntakeControlOptions['management'],
        identityRepository: {
          readEmailCodeIdentity: async () =>
            ({
              user: { email: 'person@employees.example.test' },
              grant: {
                ...grant(),
                userId: user.userId,
                tenantId: user.tenantId,
                refreshGeneration: 4,
                createdAt: now - 1000,
                idleExpiresAt: now + 600_000,
                absoluteExpiresAt: now + 900_000,
              },
            }) as never,
        },
        storage: {
          put: async (value) => {
            for await (const chunk of value.body)
              expect(Buffer.from(chunk).toString()).toBe('document');
            return { ...receipt(lease), outcome: 'unknown' };
          },
        },
      });
      const upload = await handlers.promote(
        { operationId: 'intake', capability: 'a'.repeat(43), worker: intakeWorker },
        promotionId,
        8,
        new AbortController().signal,
      );
      await upload.consume(
        (async function* () {
          yield Buffer.from('document');
        })(),
      );
      await upload.close();
      const appTask = { operationId: 'intake', generation: lease.generation, worker: appWorker };
      expect(
        await appJournal.attempts.stopAndJoin(appTask, new AbortController().signal),
      ).toMatchObject({
        localWriterStopped: true,
        localCopiesAbsent: true,
        writerStopped: false,
        storageOutcome: 'unknown',
      });
      expect(await appJournal.recoverPending(new AbortController().signal)).toMatchObject({
        settled: 0,
        pending: 1,
      });
      await first.cancel(user, 'intake', now);
      await first.sealIntakeRecovery(recoverBinding, now);
      // A stale foreign incarnation cannot contribute strong stop/copy facts to this join.
      await a.models.UploadOperation.updateOne(
        { _id: 'intake' },
        {
          $set: {
            actorSettlement: {
              generation: lease.generation,
              worker: { ...intakeWorker, instanceId: 'old-incarnation' },
              writerStopped: true,
              localCopiesAbsent: true,
            },
          },
        },
      );
      intakeRegistration.settle({
        writerStopped: false,
        localWriterStopped: true,
        localCopiesAbsent: true,
        storageOutcome: 'unknown',
        acknowledgementPending: true,
      });
      expect(await intakeJournal.recoverPending(new AbortController().signal)).toMatchObject({
        settled: 0,
        pending: 1,
      });
      expect((await row())!.actorSettlement).toMatchObject({
        worker: intakeWorker,
        generation: lease.generation,
        localWriterStopped: true,
        writerStopped: false,
        localCopiesAbsent: true,
      });
      const actors = createUploadActorSettlement({
        repository: first,
        worker: appWorker,
        attempts: appJournal.attempts,
        stagingRoot: process.env.UPLOAD_TEST_TMPDIR!,
        documents: { cancel: async () => ({ writerStopped: false }) } as never,
        now: () => now,
      });
      await actors.reconcile(new AbortController().signal);
      expect((await row())!.cleanupCustody!.promotionLocal).toMatchObject({
        worker: appWorker,
        generation: lease.generation,
        promotionId,
      });
      const authority = {
        operationId: 'intake',
        principal: user,
        generation: lease.generation,
        attemptGeneration: lease.generation,
      };
      const prepared = await first.prepareCleanupStorage(authority);
      if (prepared.state !== 'binding') throw Error('Expected binding');
      const binding = {
        ...prepared.request,
        bucket: 'private-bucket',
        key: receipt(lease).storageKey!,
      };
      await first.prepareCleanupStorage(authority, binding);
      await first.recordCleanupStorage(authority, {
        result: { ...binding, state: 'namespace_absent', obligationId: 'obligation' },
      });
      expect((await row())!.originalBytes).toBe(8);
      expect(
        await first.readActorCleanupRecovery({
          operationId: 'intake',
          attemptGeneration: lease.generation,
          worker: appWorker,
        }),
      ).toBeNull();
      const terminal = {
        ...binding,
        state: 'durable_delete_complete' as const,
        obligationId: 'obligation',
        aggregateRevision: '1',
        proofSHA256: 'e'.repeat(64),
      };
      const committed = await first.recordCleanupStorage(authority, { result: terminal });
      expect(committed.state).toBe('consume');
      if (committed.state !== 'consume') throw Error('Expected consumer commit');
      expect((await row())!.promotion).toMatchObject({
        writerStopped: false,
        state: 'writing',
        receipt: { outcome: 'unknown' },
      });
      expect(
        await first.readActorCleanupRecovery({
          operationId: 'intake',
          attemptGeneration: lease.generation + 1,
          worker: appWorker,
        }),
      ).toBeNull();
      expect(
        await first.readActorCleanupRecovery({
          operationId: 'intake',
          attemptGeneration: lease.generation,
          worker: { ...appWorker, instanceId: 'replacement' },
        }),
      ).toBeNull();
      expect(await appJournal.recoverPending(new AbortController().signal)).toEqual({
        attempted: 1,
        settled: 1,
        pending: 0,
      });
      expect(await intakeJournal.recoverPending(new AbortController().signal)).toEqual({
        attempted: 1,
        settled: 1,
        pending: 0,
      });
      expect(
        await appJournal.attempts.stopAndJoin(appTask, new AbortController().signal),
      ).toMatchObject({
        storageOutcome: 'unknown',
        writerStopped: false,
        localWriterStopped: true,
        acknowledgementPending: false,
      });
      const consumption = {
        state: 'recorded' as const,
        obligationId: terminal.obligationId,
        receiptSHA256: createHash('sha256')
          .update(canonicalStorageDeletionReceipt(terminal))
          .digest('hex'),
        consumerCommitId: committed.consumerCommitId,
      };
      await first.recordCleanupStorage(authority, { consumption });
      expect(await first.cleanupForWorker(appWorker, { limit: 16, cursor: null })).toMatchObject({
        tasks: [],
      });
      // Durable owner observation survives retirement and an otherwise empty cleanup selection.
      expect(
        await first.readActorCleanupRecovery({
          operationId: 'intake',
          attemptGeneration: lease.generation,
          worker: appWorker,
        }),
      ).toMatchObject({
        acknowledged: true,
        storageOutcome: 'unknown',
        cleanupReceipt: { consumerCommitId: committed.consumerCommitId },
      });
      expect(await appJournal.close()).toEqual({ complete: true });
      expect(await intakeJournal.close()).toEqual({ complete: true });
    } finally {
      process.env = env;
    }
  });

  it('stores only a private hash/grant, rotates waiting tickets, and snapshots the supplied grant', async () => {
    await reserve(false);
    const value = grant();
    const pending = first.issueIntake(user, 'intake', cap, value, now);
    value.principal.userId = 'f'.repeat(24);
    await pending;
    expect(await second.readIntake('intake', cap, now)).toEqual({ grant: grant() });
    const stored = (await row())!;
    expect(stored.intake).toEqual({ capabilitySha256: cap, grant: grant() });
    expect(JSON.stringify(stored)).not.toContain('synthetic-capability-fixture');
    expect(await first.get(user, 'intake', now)).not.toHaveProperty('intake');
    await second.issueIntake(user, 'intake', otherCap, grant(), now);
    await expect(first.readIntake('intake', cap, now)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    expect(await first.readIntake('intake', otherCap, now)).toEqual({ grant: grant() });
  });

  it.each(['owner', 'expired', 'too-long'])(
    'rejects an invalid %s grant without changing the reservation',
    async (change) => {
      await reserve(false);
      const value = grant();
      if (change === 'owner') value.principal.tenantId = 'tenant-b';
      if (change === 'expired') value.expiresAt = new Date(now).toISOString();
      if (change === 'too-long') value.expiresAt = new Date(now + 720_001).toISOString();
      await expect(first.issueIntake(user, 'intake', cap, value, now)).rejects.toMatchObject({
        code: 'invalid_request',
      });
      expect((await row())!.intake).toBeUndefined();
    },
  );

  it.each(['missing', 'foreign', 'expired'])(
    'fails the %s capability in the actual transfer transaction',
    async (change) => {
      await reserve();
      if (change === 'expired')
        await first.issueIntake(
          user,
          'intake',
          cap,
          { ...grant(), expiresAt: new Date(now + 1000).toISOString() },
          now,
        );
      const request = {
        kind: 'transfer' as const,
        principal: user,
        operationId: 'intake',
        worker: intakeWorker,
        now: change === 'expired' ? now + 1000 : now,
        ...(change === 'missing'
          ? {}
          : { intake: { capabilitySha256: change === 'foreign' ? otherCap : cap } }),
      };
      await expect(first.claim(request)).rejects.toMatchObject({ code: 'unauthorized' });
      expect(await row()).toMatchObject({ generation: 0, state: 'waiting', stagingHeld: false });
      expect(await first.usage(user, now)).toMatchObject({ usedBytes: 0, reservedBytes: 8 });
    },
  );

  it('rejects a capability on an unissued reservation and on a processing claim', async () => {
    await reserve(false);
    await expect(claim()).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      first.claim({
        kind: 'processing',
        worker: appWorker,
        intake: { capabilitySha256: cap },
        now,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('binds one actual worker/generation across replicas and prevents active rotation', async () => {
    await reserve();
    const outcomes = await Promise.all([claim(), claim()]);
    const lease = outcomes.find(Boolean)!;
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await first.readIntake('intake', cap, now)).toEqual({
      grant: grant(),
      worker: intakeWorker,
      generation: lease.generation,
    });
    await expect(first.issueIntake(user, 'intake', otherCap, grant(), now)).rejects.toMatchObject({
      code: 'not_ready',
    });
    expect(await second.readIntake('intake', cap, Date.parse(lease.expiresAt))).toEqual({
      grant: grant(),
      worker: intakeWorker,
      generation: lease.generation,
    });
  });

  it('serializes rotation with a claim so the old ticket never acquires the new generation', async () => {
    await reserve();
    const results = await Promise.allSettled([
      claim(),
      first.issueIntake(user, 'intake', otherCap, grant(), now),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const stored = (await row())!;
    if (stored.state === 'transferring')
      expect(stored.intake).toMatchObject({
        capabilitySha256: cap,
        worker: intakeWorker,
        generation: stored.attemptGeneration,
      });
    else {
      expect(stored.intake).toMatchObject({ capabilitySha256: otherCap });
      await expect(claim()).rejects.toMatchObject({ code: 'unauthorized' });
    }
  });

  it('requires App promotion even if Intake presents a plausible durable receipt directly', async () => {
    const lease = await transfer();
    await expect(accept(lease)).rejects.toMatchObject({ code: 'not_ready' });
    expect(await b.models.File.countDocuments({})).toBe(0);
    expect((await row())!.filename).toBeUndefined();
  });

  it.each(['unfinished-scan', 'changed-policy', 'absent-policy'])(
    'refuses promotion with %s',
    async (change) => {
      const lease = await transfer(change !== 'unfinished-scan');
      let owner = first;
      if (change === 'changed-policy')
        owner = createUploadManagementRepository(b, { securityPolicySha256: otherCap });
      if (change === 'absent-policy') owner = createUploadManagementRepository(b);
      await expect(owner.preparePromotion(input(lease), now)).rejects.toMatchObject({
        code: 'security_uninspectable',
      });
      expect((await row())!.promotion).toBeUndefined();
    },
  );

  it('prepares bodyless private metadata only after approval and permits only exact replay', async () => {
    const lease = await transfer();
    const value = input(lease);
    const pending = first.preparePromotion(value, now);
    value.metadata.filename = 'mutated.txt';
    const prepared = await pending;
    expect(prepared).toMatchObject({
      state: 'prepared',
      writerStopped: true,
      metadata: input(lease).metadata,
    });
    expect(await second.preparePromotion(input(lease), now)).toEqual(prepared);
    expect(await first.get(user, 'intake', now)).not.toHaveProperty('promotion');
    expect((await row())!.filename).toBeUndefined();
    expect(await b.models.File.countDocuments({})).toBe(0);
    expect(await first.usage(user, now)).toMatchObject({ usedBytes: 0, reservedBytes: 8 });
    await expect(
      second.preparePromotion({ ...input(lease), metadata: { filename: 'different.txt' } }, now),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(
      second.preparePromotion({ ...input(lease), worker: intakeWorker }, now),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it.each(['subject', 'hash', 'generation'])(
    'rejects promotion with foreign %s binding',
    async (change) => {
      const lease = await transfer();
      const value = input(lease);
      if (change === 'subject') value.approval.subject.userId = 'f'.repeat(24);
      if (change === 'hash') value.integrity.sha256 = otherCap;
      if (change === 'generation') value.approval.subject.transferGeneration++;
      await expect(first.preparePromotion(value, now)).rejects.toMatchObject({
        code: 'invalid_request',
      });
      expect((await row())!.promotion).toBeUndefined();
    },
  );

  it('admits exactly one App body writer even after a lost begin reply', async () => {
    const lease = await transfer();
    await first.preparePromotion(input(lease), now);
    await expect(
      second.beginPromotion(lease, promotionId, intakeWorker, now),
    ).rejects.toMatchObject({ code: 'lease_lost' });
    const results = await Promise.allSettled([
      first.beginPromotion(lease, promotionId, appWorker, now),
      second.beginPromotion(lease, promotionId, appWorker, now),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await expect(first.beginPromotion(lease, promotionId, appWorker, now)).rejects.toMatchObject({
      code: 'not_ready',
    });
    expect(await second.getPromotion(user, 'intake', now)).toMatchObject({
      state: 'writing',
      writerStopped: false,
      worker: appWorker,
    });
    await expect(
      second.getPromotion({ ...user, tenantId: 'tenant-b' }, 'intake', now),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it.each(['key', 'bytes', 'integrity', 'writer', 'generation', 'promotion'])(
    'rejects a forged %s settlement',
    async (change) => {
      const lease = await writing();
      const value = settlement(lease);
      if (change === 'key') value.receipt!.storageKey += '-foreign';
      if (change === 'bytes') value.receipt!.bytes++;
      if (change === 'integrity') value.receipt!.integrity = { ...integrity, sha256: otherCap };
      if (change === 'writer') value.worker = intakeWorker;
      if (change === 'generation') value.transferGeneration++;
      if (change === 'promotion') value.promotionId = '44444444-4444-4444-8444-444444444444';
      await expect(first.settlePromotion(value, now)).rejects.toMatchObject({
        code: ['writer', 'generation', 'promotion'].includes(change)
          ? 'lease_lost'
          : 'invalid_request',
      });
      expect(await second.getPromotion(user, 'intake', now)).toMatchObject({
        state: 'writing',
        writerStopped: false,
      });
    },
  );

  it('keeps unknown and unjoined PUT observations from acceptance or cleanup', async () => {
    const lease = await writing();
    const unknown = { ...receipt(lease), outcome: 'unknown' as const };
    await expect(
      first.settlePromotion({ ...settlement(lease), receipt: unknown }, now),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await first.settlePromotion(
      { ...settlement(lease), receipt: unknown, writerStopped: false },
      now,
    );
    await expect(accept(lease)).rejects.toMatchObject({ code: 'not_ready' });
    await expect(second.confirmCleanup(cleanup(lease), now)).rejects.toMatchObject({
      code: 'not_ready',
    });
    await first.settlePromotion({ ...settlement(lease), writerStopped: false }, now);
    await expect(accept(lease)).rejects.toMatchObject({ code: 'not_ready' });
    expect((await row())!.originalBytes).toBe(8);
    await second.settlePromotion(settlement(lease), now);
    expect((await accept(lease)).state).toBe('queued_processing');
  });

  it('commits the exact App receipt and filename with one File/debit; contradictory replays cannot replace it', async () => {
    const lease = await writing();
    const done = await second.settlePromotion(settlement(lease), now);
    expect(await first.settlePromotion(settlement(lease), now)).toEqual(done);
    const result = await accept(lease);
    expect(await accept(lease)).toEqual(result);
    expect(await b.models.File.countDocuments({})).toBe(1);
    expect(
      await first.readActorCleanupRecovery({
        operationId: 'intake',
        attemptGeneration: lease.generation,
        worker: appWorker,
      }),
    ).toBeNull();
    expect(await b.models.File.findOne({ file_id: 'intake' }).lean()).toMatchObject({
      filename: input(lease).metadata.filename,
    });
    expect(await first.usage(user, now)).toMatchObject({
      usedBytes: 8,
      reservedBytes: 0,
      retainedBytes: 8,
    });
    await expect(
      first.accept(
        user,
        lease,
        { ...receipt(lease), filepath: '/changed' },
        approval(lease),
        input(lease).metadata,
        now,
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(
      first.accept(user, lease, receipt(lease), approval(lease), { filename: 'changed.txt' }, now),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(
      first.settlePromotion({ ...settlement(lease), writerStopped: false }, now),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(
      first.settlePromotion(
        { ...settlement(lease), receipt: { ...receipt(lease), outcome: 'absent' } },
        now,
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(await second.getPromotion(user, 'intake', now)).toEqual(done);
  });

  it.each(['cancel', 'expire'])(
    'records late App join after %s without accepting, and requires separate Intake cleanup',
    async (change) => {
      const lease = await writing();
      const later = Date.parse(lease.expiresAt) + 1;
      if (change === 'cancel') await first.cancel(user, 'intake', now);
      else await first.reconcile(later);
      expect((await first.cleanupTasks())[0]).toMatchObject({
        promotion: { state: 'writing', writerStopped: false },
        localCopiesAbsent: false,
        writerStopped: false,
      });
      await expect(second.confirmCleanup(cleanup(lease), later)).rejects.toMatchObject({
        code: 'not_ready',
      });
      await second.settlePromotion(settlement(lease), later);
      await expect(accept(lease, later)).rejects.toMatchObject({ code: 'lease_lost' });
      await expect(
        first.confirmCleanup({ ...cleanup(lease), writerStopped: false }, later),
      ).rejects.toMatchObject({ code: 'not_ready' });
      expect((await row())!.originalBytes).toBe(8);
      await first.confirmCleanup(cleanup(lease), later);
      expect(await row()).toMatchObject({ originalBytes: 8, cleanupPending: true });
      await completeStorageCleanup(lease);
      expect(await row()).toMatchObject({
        originalBytes: 0,
        stagingHeld: false,
        cleanupPending: false,
      });
      expect(await b.models.File.countDocuments({})).toBe(0);
      expect(await first.usage(user, later)).toMatchObject({
        usedBytes: 0,
        reservedBytes: 0,
        retainedBytes: 0,
      });
    },
  );

  it('requires storage receipt cleanup after a joined no-receipt outcome, without promoting unknown storage', async () => {
    const lease = await writing();
    await first.settlePromotion(
      {
        ...settlement(lease),
        writerStopped: false,
        receipt: { ...receipt(lease), outcome: 'unknown' },
      },
      now,
    );
    const { receipt: _receipt, ...joined } = settlement(lease);
    const done = await second.settlePromotion(joined, now);
    expect(done).toMatchObject({ state: 'settled', writerStopped: true });
    expect(done.receipt).toBeUndefined();
    expect(await first.settlePromotion(joined, now)).toEqual(done);
    await expect(accept(lease)).rejects.toMatchObject({ code: 'not_ready' });
    await first.confirmCleanup(cleanup(lease), now);
    expect((await row())!.cleanupPending).toBe(true);
    await first.cancel(user, 'intake', now);
    await completeStorageCleanup(lease);
    expect((await row())!.cleanupPending).toBe(false);
  });

  it('invalidates an unclaimed capability atomically in source and frozen replay', async () => {
    await reserve();
    const page = await first.exportSnapshot({ epoch: 'move' });
    const record = page.records.find((entry) => entry.type === 'operation')!.value as StoredUpload;
    expect(record.intake).toBeUndefined();
    expect((await row())!.intake).toBeUndefined();
    expect(await second.exportSnapshot({ epoch: 'move' })).toEqual(page);
    await expect(first.readIntake('intake', cap, now)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await target.importSnapshot(page);
    expect(await replacement.models.UploadOperation.findById('intake').lean()).toMatchObject({
      state: 'waiting',
      generation: 0,
      originalBytes: 8,
    });
  });

  it('retains the original private reference after acceptance for exact cleanup and replay, across processing generations', async () => {
    const lease = await writing();
    await first.settlePromotion(settlement(lease), now);
    const accepted = await accept(lease);
    const reference = { grant: grant(), worker: intakeWorker, generation: lease.generation };
    expect(await second.readIntake('intake', cap, now)).toEqual(reference);
    expect(await accept(lease)).toEqual(accepted);
    await first.confirmCleanup({ ...cleanup(lease), originalAbsent: false }, now);
    const parser = (await second.claim({ kind: 'processing', worker: appWorker, now }))!;
    expect(parser.generation).toBeGreaterThan(lease.generation);
    expect(await first.readIntake('intake', cap, now)).toEqual(reference);
    await expect(first.confirmCleanup(cleanup(lease), now)).rejects.toMatchObject({
      code: 'lease_lost',
    });
    await expect(second.beginPromotion(lease, promotionId, appWorker, now)).rejects.toMatchObject({
      code: 'lease_lost',
    });
    await expect(
      first.readIntake('intake', cap, Date.parse(grant().expiresAt)),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('allows a still-valid original reference after cancellation, without reviving a transfer or an expired grant', async () => {
    const lease = await writing();
    await first.cancel(user, 'intake', now);
    expect(await second.readIntake('intake', cap, now)).toEqual({
      grant: grant(),
      worker: intakeWorker,
      generation: lease.generation,
    });
    await expect(first.preparePromotion(input(lease), now)).rejects.toMatchObject({
      code: 'lease_lost',
    });
    expect(await claim()).toBeNull();
    await second.settlePromotion(settlement(lease), now);
    await first.confirmCleanup(cleanup(lease), now);
    await expect(first.readIntake('intake', otherCap, now)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(
      first.readIntake('intake', cap, Date.parse(grant().expiresAt)),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('preserves settled promotion and original Intake identity through private migration', async () => {
    const lease = await writing();
    await first.settlePromotion(settlement(lease), now);
    await accept(lease);
    await first.confirmCleanup({ ...cleanup(lease), originalAbsent: false }, now);
    const page = await first.exportSnapshot({ epoch: 'move' });
    const stored = (await row())!;
    // File owns accepted custody; migration must observe the real matching destination File.
    await replacement.models.File.collection.insertMany(
      await a.models.File.collection.find({ file_id: 'intake' }).toArray(),
    );
    await target.importSnapshot(page);
    expect(await replacement.models.UploadOperation.findById('intake').lean()).toMatchObject({
      intake: stored.intake,
      promotion: stored.promotion,
    });
    const altered = JSON.parse(JSON.stringify(page));
    const record = altered.records.find(
      (entry: { type: string }) => entry.type === 'operation',
    ).value;
    record.promotion.writerStopped = false;
    record.promotion.state = 'writing';
    // Independent target import validation must reject an active App writer before changing rows.
    await replacement.models.UploadOperation.deleteMany({});
    await replacement.models.UploadCounter.deleteMany({});
    target = createUploadManagementRepository(replacement, { securityPolicySha256: policy });
    await target.initialize();
    await expect(target.importSnapshot(altered)).rejects.toMatchObject({
      code: 'migration_conflict',
    });
    expect(await replacement.models.UploadOperation.countDocuments({})).toBe(0);
  });

  it('blocks migration of a still-writing promotion even if old local fields wrongly claim cleanup', async () => {
    const lease = await writing();
    await first.cancel(user, 'intake', now);
    // Historical/corrupt local acknowledgement fixture; never an App join proof.
    await a.models.UploadOperation.updateOne(
      { _id: 'intake' },
      { $set: { stagingHeld: false, writerStopped: true }, $unset: { slot: 1, leaseExpiresAt: 1 } },
    );
    await expect(first.exportSnapshot({ epoch: 'move' })).rejects.toMatchObject({
      code: 'migration_conflict',
    });
    expect((await row())!.promotion).toMatchObject({ state: 'writing', writerStopped: false });
    expect((await row())!.intake!.capabilitySha256).toBe(cap);
    await second.settlePromotion(settlement(lease), now);
    await second.confirmCleanup(cleanup(lease), now);
  });
});
