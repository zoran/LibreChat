/** Actual Mongo transactions and File models; scanner/storage acknowledgements are explicit fixtures. */
import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type {
  UploadIntakeGrant,
  UploadIntakeRecoveryBinding,
  UploadIntakeLocalSettlement,
  UploadLease,
  UploadPromotionInput,
  UploadPromotionSettlement,
  UploadSecurityApproval,
  UploadStorageReceipt,
} from 'librechat-data-provider';
import type { StoredUpload } from './uploadManagementStore';
import {
  uploadSecurityFixture,
  uploadSecuritySettlementFixture,
  bindUploadOriginalFixture,
} from './uploadManagement.security.fixture';
import { completeUnacceptedUploadCleanup } from './uploadManagement.structure.fixture';
import { createUploadManagementRepository } from './uploadManagement';
import { createModels } from '~/models';

describe('bound technical Intake recovery using actual Mongo transactions', () => {
  let mongo: MongoMemoryReplSet;
  const a = new mongoose.Mongoose();
  const b = new mongoose.Mongoose();
  const replacement = new mongoose.Mongoose();
  let first: ReturnType<typeof createUploadManagementRepository>;
  let second: ReturnType<typeof createUploadManagementRepository>;
  let target: ReturnType<typeof createUploadManagementRepository>;
  const now = Date.now();
  const policy = 'c'.repeat(64);
  const cap = createHash('sha256').update('synthetic-capability-fixture').digest('hex');
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
        sha256,
      },
      scannerVersion: 'explicit-simulated-scanner-fixture',
      checkedAt: new Date(now).toISOString(),
      coverage: { complete: true, pages: 1, parts: 1 },
    }).approval;
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
        email: 'upload-recovery@example.test',
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
      const execution = uploadSecurityFixture(approval(lease), {
        custody: { kind: 'none' as const },
        attemptId: `intake.${lease.generation}`,
        instanceId: '11111111-1111-4111-8111-111111111111',
        executionId: '22222222-2222-4222-8222-222222222222',
        expiresAt: new Date(now + 60_000).toISOString(),
      }).execution;
      await first.bindSecurityExecution(lease, execution, now);
      await second.settleSecurityExecution(
        lease,
        uploadSecuritySettlementFixture(execution, {
          writerStopped: true,
          transientDataRemoved: true,
        }),
        now,
      );
      await bindUploadOriginalFixture(first, lease, receipt(lease), approval(lease), now);
    }
    return lease;
  }
  async function writing() {
    const lease = await transfer();
    await first.preparePromotion(input(lease), now);
    await second.beginPromotion(lease, promotionId, appWorker, now);
    return lease;
  }

  const binding = (lease: UploadLease): UploadIntakeRecoveryBinding => ({
    version: 1,
    operationId: lease.operationId,
    transferGeneration: lease.generation,
    worker: { ...intakeWorker },
    capabilitySha256: cap,
  });
  const local = (lease: UploadLease): UploadIntakeLocalSettlement => ({
    version: 1,
    operationId: lease.operationId,
    transferGeneration: lease.generation,
    worker: { ...intakeWorker },
    localWriterStopped: true,
    localCopiesAbsent: true,
  });
  const global = () => b.models.UploadCounter.findById('global').lean();
  const seal = (lease: UploadLease, time = now) => first.sealIntakeRecovery(binding(lease), time);
  const confirm = (lease: UploadLease, time = now) =>
    second.confirmIntakeRecovery(binding(lease), local(lease), time);

  it('seals an actually bound attempt without asserting writer exit or releasing quota, then shares cleanup accounting', async () => {
    const lease = await transfer(false);
    const before = (await row())!;
    const usage = await first.usage(user, now);
    const result = await seal(lease);
    expect(result).toEqual({
      version: 1,
      operationId: 'intake',
      transferGeneration: lease.generation,
      worker: intakeWorker,
      closed: true,
      acknowledged: false,
      storageOutcome: 'not_started',
      appWriterStopped: true,
    });
    expect(await row()).toMatchObject({
      state: before.state,
      generation: before.generation,
      workerGeneration: lease.generation,
      slot: 'transfer',
      writerStopped: false,
      stagingHeld: true,
      originalBytes: 8,
    });
    expect(await first.usage(user, now)).toEqual(usage);
    await expect(first.readIntake('intake', cap, now)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(first.renew(lease, now)).rejects.toMatchObject({ code: 'lease_lost' });
    await expect(first.preparePromotion(input(lease), now)).rejects.toMatchObject({
      code: 'lease_lost',
    });
    await expect(accept(lease)).rejects.toMatchObject({ code: 'lease_lost' });
    expect(await claim()).toBeNull();
    expect(
      await second.confirmIntakeRecovery(
        binding(lease),
        { ...local(lease), localCopiesAbsent: false },
        now,
      ),
    ).toMatchObject({ acknowledged: false });
    expect(await row()).toMatchObject({ state: 'failed', stagingHeld: true, originalBytes: 8 });
    expect(await confirm(lease)).toMatchObject({ acknowledged: true });
    expect(await row()).toMatchObject({
      intake: { closed: true, cleanupAcknowledged: true, generation: lease.generation },
      writerStopped: true,
      stagingHeld: false,
      originalBytes: 8,
      cleanupPending: true,
    });
    await completeUnacceptedUploadCleanup(first, user, lease);
    expect(await row()).toMatchObject({ originalBytes: 0, cleanupPending: false });
    expect(await first.usage(user, now)).toMatchObject({
      reservedBytes: 0,
      usedBytes: 0,
      retainedBytes: 0,
    });
    expect(await global()).toMatchObject({
      value: { originalBytes: 0, objectBytes: 0, queueBytes: 0, queueCount: 0 },
    });
    expect(await b.models.File.countDocuments({})).toBe(0);
  });

  it.each(['capability', 'host', 'instance', 'generation', 'operation'])(
    'rejects a foreign recovery %s before closing or acknowledging the row',
    async (change) => {
      const lease = await transfer(false);
      const value = binding(lease);
      if (change === 'capability') value.capabilitySha256 = otherCap;
      if (change === 'host') value.worker.hostId = 'foreign-host';
      if (change === 'instance') value.worker.instanceId = 'foreign-incarnation';
      if (change === 'generation') value.transferGeneration++;
      if (change === 'operation') value.operationId = 'foreign-operation';
      const before = await row();
      await expect(first.sealIntakeRecovery(value, now)).rejects.toMatchObject({
        code: 'unauthorized',
      });
      await expect(first.confirmIntakeRecovery(value, local(lease), now)).rejects.toMatchObject({
        code: 'unauthorized',
      });
      expect(await row()).toEqual(before);
    },
  );

  it('rejects an unbound ticket and requires the durable closed fence before confirmation', async () => {
    await reserve();
    const value = {
      version: 1 as const,
      operationId: 'intake',
      transferGeneration: 1,
      worker: intakeWorker,
      capabilitySha256: cap,
    };
    await expect(first.sealIntakeRecovery(value, now)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    const lease = (await claim())!;
    await expect(confirm(lease)).rejects.toMatchObject({ code: 'not_ready' });
    expect((await row())!.intake).not.toHaveProperty('closed');
  });

  it('snapshots bound identities before awaiting Mongo and never invokes input getters', async () => {
    const lease = await transfer(false);
    const value = binding(lease);
    const pending = first.sealIntakeRecovery(value, now);
    value.worker.instanceId = 'mutated-after-call';
    expect(await pending).toMatchObject({ worker: intakeWorker });
    const getter = jest.fn(() => cap);
    const hostile = Object.defineProperty(binding(lease), 'capabilitySha256', {
      enumerable: true,
      get: getter,
    });
    await expect(first.sealIntakeRecovery(hostile, now)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it('permits only technical bound recovery after grant expiry and failed lease generation advance, without a current policy', async () => {
    const lease = await transfer(false);
    await first.fail(lease, 'cancelled', now);
    expect((await row())!.generation).toBeGreaterThan(lease.generation);
    const later = Date.parse(grant().expiresAt) + 1;
    await expect(first.readIntake('intake', cap, later)).rejects.toMatchObject({
      code: 'unauthorized',
    });
    const cleanupOnly = createUploadManagementRepository(b);
    expect(await cleanupOnly.sealIntakeRecovery(binding(lease), later)).toMatchObject({
      acknowledged: false,
    });
    expect(
      await cleanupOnly.confirmIntakeRecovery(binding(lease), local(lease), later),
    ).toMatchObject({ acknowledged: true });
    await expect(first.preparePromotion(input(lease), later)).rejects.toMatchObject({
      code: 'lease_lost',
    });
    expect((await row())!.workerGeneration).toBe(lease.generation);
  });

  it('fences a prepared promotion before it can start and accepts only the original local proof', async () => {
    const lease = await transfer();
    await first.preparePromotion(input(lease), now);
    expect(await seal(lease)).toMatchObject({ storageOutcome: 'not_started', acknowledged: false });
    await expect(first.beginPromotion(lease, promotionId, appWorker, now)).rejects.toMatchObject({
      code: 'lease_lost',
    });
    await expect(
      first.confirmIntakeRecovery(
        binding(lease),
        { ...local(lease), transferGeneration: lease.generation + 1 },
        now,
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      first.confirmIntakeRecovery(binding(lease), { ...local(lease), worker: appWorker }, now),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(await confirm(lease)).toMatchObject({
      acknowledged: true,
      storageOutcome: 'not_started',
    });
  });

  it.each(['missing', 'unknown', 'durable'] as const)(
    'keeps a writing App promotion held with %s receipt even after local join',
    async (outcome) => {
      const lease = await writing();
      if (outcome !== 'missing')
        await first.settlePromotion(
          {
            ...settlement(lease),
            writerStopped: false,
            receipt: { ...receipt(lease), outcome },
          },
          now,
        );
      const before = (await row())!;
      expect(await seal(lease)).toMatchObject({
        storageOutcome: 'unknown',
        appWriterStopped: false,
      });
      expect(await confirm(lease)).toMatchObject({
        acknowledged: false,
        storageOutcome: 'unknown',
      });
      expect(await row()).toMatchObject({
        state: before.state,
        generation: before.generation,
        slot: 'transfer',
        writerStopped: false,
        stagingHeld: true,
        originalBytes: 8,
        queueCharged: true,
      });
      expect((await row())!.intake).not.toHaveProperty('cleanupAcknowledged');
      expect(await b.models.File.countDocuments({})).toBe(0);
    },
  );

  it.each(['durable', 'absent', 'not_started'] as const)(
    'records a real late App join as %s without reviving first acceptance',
    async (outcome) => {
      const lease = await writing();
      await seal(lease);
      const { receipt: _receipt, ...joined } = settlement(lease);
      await first.settlePromotion(
        {
          ...joined,
          ...(outcome === 'not_started' ? {} : { receipt: { ...receipt(lease), outcome } }),
        },
        now + 60_001,
      );
      const result = await confirm(lease, now + 60_001);
      expect(result).toMatchObject({
        acknowledged: true,
        storageOutcome: outcome,
        appWriterStopped: true,
      });
      await expect(accept(lease)).rejects.toMatchObject({ code: 'lease_lost' });
      expect(await row()).toMatchObject({
        state: 'failed',
        originalBytes: 8,
        cleanupPending: true,
        stagingHeld: false,
      });
      if (outcome !== 'durable') {
        await completeUnacceptedUploadCleanup(first, user, lease);
        expect(await row()).toMatchObject({ originalBytes: 0, cleanupPending: false });
      }
      expect(await b.models.File.countDocuments({})).toBe(0);
    },
  );

  it('does not combine partial scanner receipts and can acknowledge the exact complete late scanner join', async () => {
    const lease = await transfer(false);
    const execution = uploadSecurityFixture(approval(lease), {
      custody: { kind: 'none' as const },
      attemptId: `intake.${lease.generation}`,
      instanceId: '11111111-1111-4111-8111-111111111111',
      executionId: '22222222-2222-4222-8222-222222222222',
      expiresAt: new Date(now + 60_000).toISOString(),
    }).execution;
    await first.bindSecurityExecution(lease, execution, now);
    await seal(lease);
    for (const partial of [
      { writerStopped: true, transientDataRemoved: false },
      { writerStopped: false, transientDataRemoved: true },
    ]) {
      expect(
        await first.confirmIntakeRecovery(
          binding(lease),
          {
            ...local(lease),
            securitySettlement: uploadSecuritySettlementFixture(execution, partial),
          },
          now,
        ),
      ).toMatchObject({ acknowledged: false });
    }
    expect(await row()).toMatchObject({
      writerStopped: false,
      stagingHeld: true,
      originalBytes: 8,
    });
    await expect(
      first.confirmIntakeRecovery(
        binding(lease),
        {
          ...local(lease),
          securitySettlement: uploadSecuritySettlementFixture(
            { ...execution, executionId: '33333333-3333-4333-8333-333333333333' },
            { writerStopped: true, transientDataRemoved: true },
          ),
        },
        now,
      ),
    ).rejects.toMatchObject({ code: 'lease_lost' });
    expect(
      await first.confirmIntakeRecovery(
        binding(lease),
        {
          ...local(lease),
          securitySettlement: uploadSecuritySettlementFixture(execution, {
            writerStopped: true,
            transientDataRemoved: true,
          }),
        },
        now + 60_001,
      ),
    ).toMatchObject({ acknowledged: true });
  });

  it.each(['normal', 'recovery'])(
    'preserves a %s acknowledgement across processing generations and makes replay read-only',
    async (mode) => {
      const lease = await writing();
      await first.settlePromotion(settlement(lease), now);
      await accept(lease);
      if (mode === 'normal') {
        await first.confirmCleanup({ ...cleanup(lease), originalAbsent: false }, now);
        expect((await row())!.intake).toMatchObject({ cleanupAcknowledged: true });
        expect((await row())!.intake).not.toHaveProperty('closed');
      } else {
        await seal(lease);
        // Exact acceptance replay remains valid; sealing does not revoke the existing File.
        expect(await accept(lease)).toMatchObject({ state: 'queued_processing' });
        expect(await confirm(lease)).toMatchObject({
          acknowledged: true,
          storageOutcome: 'durable',
        });
      }
      const parser = (await second.claim({ kind: 'processing', worker: appWorker, now }))!;
      expect(parser.generation).toBeGreaterThan(lease.generation);
      const sealed = await seal(lease);
      const before = await row();
      const counter = await global();
      const file = await b.models.File.findOne({ file_id: 'intake' }).lean();
      expect(await confirm(lease, Date.parse(grant().expiresAt) + 1)).toEqual(sealed);
      expect(await seal(lease)).toEqual(sealed);
      expect(await row()).toEqual(before);
      expect(await global()).toEqual(counter);
      expect(await b.models.File.findOne({ file_id: 'intake' }).lean()).toEqual(file);
      expect(await first.getProcessingInput(parser, now)).toMatchObject({
        operationId: 'intake',
        attemptGeneration: lease.generation,
      });
      await expect(
        first.confirmIntakeRecovery(
          { ...binding(lease), transferGeneration: parser.generation },
          {
            ...local(lease),
            transferGeneration: parser.generation,
          },
          now,
        ),
      ).rejects.toMatchObject({ code: 'unauthorized' });
    },
  );

  it('serializes sealing against a concurrent first acceptance without creating a late File', async () => {
    const lease = await writing();
    await first.settlePromotion(settlement(lease), now);
    const [sealed, accepted] = await Promise.allSettled([seal(lease), accept(lease)]);
    expect(sealed.status).toBe('fulfilled');
    const stored = (await row())!;
    if (accepted.status === 'fulfilled') {
      expect(stored.acceptedAt).toBe(now);
      expect(await b.models.File.countDocuments({})).toBe(1);
    } else {
      expect(accepted.reason).toMatchObject({ code: 'lease_lost' });
      expect(stored.acceptedAt).toBeUndefined();
      expect(await b.models.File.countDocuments({})).toBe(0);
    }
    expect(stored.intake!.closed).toBe(true);
    expect(await confirm(lease)).toMatchObject({ acknowledged: true });
  });

  it('preserves closed and historical acknowledgement in actual export/import without new authority', async () => {
    const lease = await transfer(false);
    await seal(lease);
    const expected = await confirm(lease);
    const page = await first.exportSnapshot({ epoch: 'recovery-move' });
    await target.importSnapshot(page);
    expect(await replacement.models.UploadOperation.findById('intake').lean()).toMatchObject({
      intake: {
        closed: true,
        cleanupAcknowledged: true,
        generation: lease.generation,
        worker: intakeWorker,
      },
    });
    expect(await target.sealIntakeRecovery(binding(lease), now)).toEqual(expected);
    expect(await target.confirmIntakeRecovery(binding(lease), local(lease), now)).toEqual(expected);
    await expect(target.readIntake('intake', cap, now)).rejects.toMatchObject({
      code: 'unauthorized',
    });
  });
});
