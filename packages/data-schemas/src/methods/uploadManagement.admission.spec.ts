/** Operational admission policy through independent clients of the real transactional store. */
import mongoose from 'mongoose';
import { createHash } from 'crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type {
  UploadAdmissionCommand,
  UploadLease,
  UploadPrincipal,
  UploadSecurityApproval,
} from 'librechat-data-provider';
import type { GlobalState } from './uploadManagementStore';
import { createUploadManagementRepository } from './uploadManagement';
import { createModels } from '~/models';

/** Deterministic UUIDv4-shaped test keys keep operation labels out of the public key contract. */
const fixtureKey = (label: string): string => {
  const hex = createHash('sha256').update(label).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

describe('durable upload admission pause', () => {
  let mongo: MongoMemoryReplSet;
  const a = new mongoose.Mongoose();
  const b = new mongoose.Mongoose();
  const replacement = new mongoose.Mongoose();
  let first: ReturnType<typeof createUploadManagementRepository>;
  let second: ReturnType<typeof createUploadManagementRepository>;
  let target: ReturnType<typeof createUploadManagementRepository>;
  const baseline = { originalBytes: 0, objectBytes: 0, textBytes: 0, recordBytes: 0, bundles: 0 };
  const securityPolicySha256 = 'c'.repeat(64);
  const original = Buffer.from('document');
  const originalSha256 = createHash('sha256').update(original).digest('hex');
  const user: UploadPrincipal = {
    tenantId: 'tenant-a',
    userId: new mongoose.Types.ObjectId().toString(),
    authentication: 'verified-email',
  };
  const worker = { hostId: 'host-a', instanceId: 'app-a' };
  const request = (id: string, bytes = 8) => ({
    operationId: id,
    idempotencyKey: fixtureKey(id),
    mediaType: 'text/plain',
    declaredBytes: bytes,
    fingerprint: JSON.stringify([{ kind: 'personal' }, 'text/plain', bytes]),
  });
  const receipt = (lease: UploadLease) => ({
    outcome: 'durable' as const,
    bytes: original.length,
    source: 's3',
    filepath: `/api/files/download/${lease.operationId}`,
    storageKey: `t/${lease.tenantId}/managed-uploads/${lease.userId}/${lease.operationId}.${lease.generation}__original`,
    integrity: {
      version: 1 as const,
      algorithm: 'sha256' as const,
      sha256: originalSha256,
      chunkBytes: 262144 as const,
      chunkSha256: [originalSha256],
    },
  });
  const approval = (lease: UploadLease, now: number): UploadSecurityApproval => ({
    version: 1,
    decision: 'approved',
    policySha256: securityPolicySha256,
    subject: {
      tenantId: lease.tenantId,
      userId: lease.userId,
      operationId: lease.operationId,
      transferGeneration: lease.generation,
      mediaType: 'text/plain',
      bytes: original.length,
      sha256: originalSha256,
    },
    scannerVersion: 'simulated-admission-fixture-v1',
    checkedAt: new Date(now).toISOString(),
    coverage: { complete: true, pages: 1, parts: 1 },
  });
  const documentResult = (text: string, bytes = 8) => ({
    text,
    writerStopped: true as const,
    structure: {
      version: 1 as const,
      source: { sha256: originalSha256, bytes, mediaType: 'text/plain' },
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
    const execution = {
      version: 2 as const,
      custody: { kind: 'none' as const },
      attemptId: `${lease.operationId}.${lease.generation}`,
      instanceId: '11111111-1111-4111-8111-111111111111',
      executionId: '22222222-2222-4222-8222-222222222222',
      expiresAt: new Date(at + 60_000).toISOString(),
    };
    await first.bindSecurityExecution(lease, execution, at);
    await second.settleSecurityExecution(
      lease,
      { execution, writerStopped: true, transientDataRemoved: true },
      at,
    );
  }

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await Promise.all([
      a.connect(mongo.getUri('admission')),
      b.connect(mongo.getUri('admission')),
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
        email: 'upload-admission@example.test',
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
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await Promise.all([a.disconnect(), b.disconnect(), replacement.disconnect()]);
    await mongo?.stop();
  });

  async function counter(db = a) {
    const row = await db.models.UploadCounter.findById('global').lean<{
      _id: string;
      revision: number;
      value: GlobalState;
    }>();
    expect(row).not.toBeNull();
    return row!;
  }
  async function command(paused = true, expectedRevision = 0, db = a) {
    return {
      storeId: (await counter(db)).value.storeId,
      expectedRevision,
      paused,
      originalDeadline: new Date(Date.now() + 60_000).toISOString(),
    } satisfies UploadAdmissionCommand;
  }

  it('reads initial policy without changing any Counter fields or exposing retry evidence', async () => {
    const before = await counter();
    expect(await second.getAdmissionPolicy()).toEqual({
      storeId: before.value.storeId,
      revision: 0,
      paused: false,
    });
    expect(await counter()).toEqual(before);
    expect((await first.metrics(Date.now())).admissionsPaused).toBe(false);
  });

  it('never recreates a missing Counter through status or mutation', async () => {
    const input = await command();
    await a.models.UploadCounter.deleteOne({ _id: 'global' });
    await expect(first.getAdmissionPolicy()).rejects.toMatchObject({ code: 'unavailable' });
    await expect(second.setAdmissionPolicy(input)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await a.models.UploadCounter.countDocuments({})).toBe(0);
  });

  it('reads an absent legacy field as open without materializing it', async () => {
    await a.models.UploadCounter.updateOne({ _id: 'global' }, { $unset: { 'value.admission': 1 } });
    const before = await counter();
    expect(await first.getAdmissionPolicy()).toMatchObject({ paused: false, revision: 0 });
    expect(await counter()).toEqual(before);
    expect((await first.reserve(user, request('legacy'), Date.now())).state).toBe('waiting');
  });

  it.each([
    { admission: null },
    { admission: [] },
    { admission: true },
    { admission: { paused: 'false', revision: 0 } },
    { admission: { paused: true, revision: 0 } },
    { admission: { paused: false, revision: -1 } },
    { admission: { paused: false, revision: 0, lastRequestSha256: 'a'.repeat(64) } },
    { admission: { paused: true, revision: 1 } },
    { admission: { paused: true, revision: 1, lastRequestSha256: 'A'.repeat(64) } },
    { admission: { paused: false, revision: 0, extra: true } },
  ])('fails closed for malformed stored admission metadata: $admission', async ({ admission }) => {
    await a.models.UploadCounter.updateOne(
      { _id: 'global' },
      { $set: { 'value.admission': admission } },
    );
    const before = await counter();
    await expect(second.reserve(user, request('malformed'), Date.now())).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(first.getAdmissionPolicy()).rejects.toMatchObject({ code: 'unavailable' });
    expect((await first.metrics(Date.now())).admissionsPaused).toBeNull();
    expect(await counter()).toEqual(before);
    expect(await a.models.UploadOperation.countDocuments({})).toBe(0);
  });

  it('enforces the durable policy even when this repository did not write it', async () => {
    await a.models.UploadCounter.updateOne(
      { _id: 'global' },
      {
        $set: {
          'value.admission': { paused: true, revision: 1, lastRequestSha256: 'a'.repeat(64) },
        },
      },
    );
    const before = await counter();
    await expect(
      second.reserve(user, request('persisted-pause'), Date.now()),
    ).rejects.toMatchObject({
      code: 'admission_paused',
    });
    expect((await second.metrics(Date.now())).admissionsPaused).toBe(true);
    expect(await counter()).toEqual(before);
  });

  it('refuses a new reservation without charges while preserving exact scoped reservation replay', async () => {
    const now = Date.now();
    const previous = await first.reserve(user, request('prior'), now);
    await second.setAdmissionPolicy(await command());
    expect(await first.reserve(user, request('prior'), now)).toEqual(previous);
    await expect(first.reserve(user, request('prior', 9), now)).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    const counters = await a.models.UploadCounter.find({}).sort({ _id: 1 }).lean();
    const usage = await second.usage(user, now);
    await expect(second.reserve(user, request('new'), now)).rejects.toMatchObject({
      code: 'admission_paused',
    });
    expect(await a.models.UploadCounter.find({}).sort({ _id: 1 }).lean()).toEqual(counters);
    expect(await first.usage(user, now)).toEqual(usage);
    expect(await a.models.UploadOperation.countDocuments({})).toBe(1);
  });

  it('serializes pause against a concurrent reservation through independent clients', async () => {
    const now = Date.now();
    const input = await command();
    const [reservation, pause] = await Promise.allSettled([
      first.reserve(user, request('racing'), now),
      second.setAdmissionPolicy(input),
    ]);
    expect(pause.status).toBe('fulfilled');
    if (reservation.status === 'rejected')
      expect(reservation.reason).toMatchObject({ code: 'admission_paused' });
    const admitted = reservation.status === 'fulfilled' ? 1 : 0;
    expect(await a.models.UploadOperation.countDocuments({})).toBe(admitted);
    expect((await counter()).value).toMatchObject({
      originalBytes: admitted * 8,
      objectBytes: admitted * 8,
      queueBytes: admitted * 8,
      queueCount: admitted,
      bundles: admitted,
    });
    await expect(first.reserve(user, request('after-pause'), now)).rejects.toMatchObject({
      code: 'admission_paused',
    });
  });

  it('confirms only the exact committed command after a lost reply and expired deadline', async () => {
    const input = await command();
    await first.setAdmissionPolicy(input);
    const committed = await counter();
    const expectedDigest = createHash('sha256')
      .update(
        JSON.stringify(['upload-admission/v1', input.storeId, 0, true, input.originalDeadline]),
      )
      .digest('hex');
    expect(committed.value).toMatchObject({
      admission: { paused: true, revision: 1, lastRequestSha256: expectedDigest },
    });
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse(input.originalDeadline) + 1);
    expect(await second.setAdmissionPolicy(input)).toEqual({
      storeId: input.storeId,
      revision: 1,
      paused: true,
    });
    expect((await counter()).value).toMatchObject({
      ...baseline,
      admission: committed.value.admission,
    });
    await expect(
      second.setAdmissionPolicy({
        ...input,
        originalDeadline: new Date(Date.parse(input.originalDeadline) + 1).toISOString(),
      }),
    ).rejects.toMatchObject({ code: 'not_ready' });
    await expect(second.setAdmissionPolicy({ ...input, paused: false })).rejects.toMatchObject({
      code: 'not_ready',
    });
    await expect(
      second.setAdmissionPolicy({ ...input, storeId: 'another-store' }),
    ).rejects.toMatchObject({ code: 'not_ready' });
  });

  it('advances same-state commands once and invalidates earlier acknowledgement proofs', async () => {
    const earlier = await command(false);
    expect(await first.setAdmissionPolicy(earlier)).toMatchObject({ revision: 1, paused: false });
    const later = await command(false, 1);
    expect(await second.setAdmissionPolicy(later)).toMatchObject({ revision: 2, paused: false });
    await expect(first.setAdmissionPolicy(earlier)).rejects.toMatchObject({ code: 'not_ready' });
    expect(await first.setAdmissionPolicy(later)).toMatchObject({ revision: 2, paused: false });
  });

  it('captures command primitives before awaiting Mongo', async () => {
    const input = await command();
    const retained = { ...input };
    const pending = first.setAdmissionPolicy(input);
    input.paused = false;
    input.expectedRevision = 9;
    input.originalDeadline = new Date(Date.now() + 120_000).toISOString();
    expect(await pending).toMatchObject({ revision: 1, paused: true });
    expect(await second.setAdmissionPolicy(retained)).toMatchObject({ revision: 1, paused: true });
    await expect(second.setAdmissionPolicy(input)).rejects.toMatchObject({ code: 'not_ready' });
  });

  it.each([
    { expectedRevision: -1 },
    { expectedRevision: 0.5 },
    { expectedRevision: Number.MAX_SAFE_INTEGER },
    { paused: 'true' },
    { storeId: 'x'.repeat(129) },
    { originalDeadline: '2026-10-14T04:00:00Z' },
    { now: 1 },
  ])('rejects malformed command primitives without a transition: %p', async (invalid) => {
    const input = { ...(await command()), ...invalid } as unknown as UploadAdmissionCommand;
    const before = await counter();
    await expect(first.setAdmissionPolicy(input)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(await counter()).toEqual(before);
  });

  it.each([-1, 300_001])(
    'rejects an uncommitted command outside its original window: %i',
    async (offset) => {
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);
      const input = {
        ...(await command()),
        originalDeadline: new Date(now + offset).toISOString(),
      };
      const before = await counter();
      await expect(first.setAdmissionPolicy(input)).rejects.toMatchObject({ code: 'not_ready' });
      expect(await counter()).toEqual(before);
    },
  );

  it('rechecks the repository clock after a real transaction retries', async () => {
    let now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const input = { ...(await command()), originalDeadline: new Date(now + 1000).toISOString() };
    const before = await counter();
    const conflict = new mongoose.mongo.MongoServerError({
      message: 'injected transaction conflict',
    });
    conflict.addErrorLabel('TransientTransactionError');
    jest.spyOn(a.models.UploadCounter, 'updateOne').mockImplementationOnce(() => {
      now += 1001;
      throw conflict;
    });
    await expect(first.setAdmissionPolicy(input)).rejects.toMatchObject({ code: 'not_ready' });
    expect(await counter()).toEqual(before);
  });

  it.each([
    { field: 'enabled', value: false, code: 'not_ready' },
    { field: 'reconciled', value: false, code: 'not_ready' },
    { field: 'migration', value: {}, code: 'not_ready' },
    { field: 'migrationEpoch', value: 'active-migration', code: 'migration_conflict' },
  ])('requires current authority when $field changes', async ({ field, value, code }) => {
    const input = await command();
    await first.setAdmissionPolicy(input);
    await a.models.UploadCounter.updateOne(
      { _id: 'global' },
      { $set: { [`value.${field}`]: value } },
    );
    const before = await counter();
    // Neither an exact acknowledgement replay nor a fresh command can revive stale authority.
    await expect(first.setAdmissionPolicy(input)).rejects.toMatchObject({ code });
    await expect(
      second.setAdmissionPolicy({ ...input, expectedRevision: 1, paused: false }),
    ).rejects.toMatchObject({ code });
    expect(await counter()).toEqual(before);
  });

  it('keeps pause across controller publication, initialization and repository reconstruction', async () => {
    await first.setAdmissionPolicy(await command());
    const now = Date.now();
    const lease = (await second.claimController({ ownerId: 'controller', now }))!;
    await second.publishControl({
      lease,
      now,
      mode: 'normal',
      limits: { transferPermits: 2, processingPermits: 2, transferBytesPerSecond: 2 * 1_048_576 },
      sourceExpiresAt: now + 60_000,
    });
    await first.initialize();
    expect(await createUploadManagementRepository(a).getAdmissionPolicy()).toMatchObject({
      paused: true,
      revision: 1,
    });
    expect((await second.metrics(now)).admissionsPaused).toBe(true);
  });

  it('preserves admitted transfer, parser retry, publication and cleanup during pause', async () => {
    const now = Date.now();
    await first.reserve(user, request('continuing'), now);
    await second.setAdmissionPolicy(await command());
    const transfer = (await first.claim({
      kind: 'transfer',
      principal: user,
      operationId: 'continuing',
      worker,
      now,
    }))!;
    expect(transfer).not.toBeNull();
    await second.renew(transfer, now);
    const grant = await first.claimWorkBytes({ lease: transfer, requestedBytes: 8, now });
    expect(grant?.bytes).toBe(8);
    await second.completeWorkBytes({ lease: transfer, generation: grant!.generation, now });
    await completeScanner(transfer, now);
    await first.accept(
      user,
      transfer,
      receipt(transfer),
      approval(transfer, now),
      { filename: 'note.txt' },
      now,
    );
    await second.confirmCleanup(localGone(transfer), now);
    const prior = (await first.claim({ kind: 'processing', worker, now }))!;
    await first.bindProcessingExecution(
      prior,
      {
        attemptId: `continuing.${prior.generation}`,
        instanceId: 'parser-a',
        expiresAt: new Date(now + 60_000).toISOString(),
      },
      now,
    );
    await first.fail(prior, 'processing_failed', now);
    await second.confirmCleanup({ ...localGone(prior), textAndHistoryRemoved: true }, now);
    await first.retryProcessing(user, 'continuing', now + 1);
    const parser = (await second.claim({ kind: 'processing', worker, now: now + 1 }))!;
    await first.bindProcessingExecution(
      parser,
      {
        attemptId: `continuing.${parser.generation}`,
        instanceId: 'parser-b',
        expiresAt: new Date(now + 60_000).toISOString(),
      },
      now + 1,
    );
    expect(await first.publish(parser, documentResult('document'), now + 1)).toMatchObject({
      state: 'ready',
    });
    await second.confirmCleanup(localGone(parser), now + 1);
    expect(await first.get(user, 'continuing', now + 1)).toMatchObject({ state: 'ready' });
    expect((await first.metrics(now + 1)).staging.count).toBe(0);
  });

  it('still cancels and expires admitted waiting work with accounting release', async () => {
    const now = Date.now();
    await first.reserve(user, request('cancel'), now);
    await first.reserve(user, request('expire'), now - 601_000);
    await second.setAdmissionPolicy(await command());
    expect(await first.cancel(user, 'cancel', now)).toMatchObject({ state: 'cancelled' });
    await second.reconcile(now);
    expect(await first.get(user, 'expire', now)).toMatchObject({
      state: 'failed',
      error: 'expired',
    });
    expect(await first.usage(user, now)).toMatchObject({ reservedBytes: 0 });
    expect((await counter()).value).toMatchObject({
      queueCount: 0,
      queueBytes: 0,
      originalBytes: 0,
    });
  });

  it('checks current security custody before replaying an acknowledged complete import', async () => {
    const page = await first.exportSnapshot({ epoch: 'current-security-cutover' });
    await target.importSnapshot(page);
    const seal = await first.completeExport('current-security-cutover');
    const input = { receipt: seal, baseline, lifecycleReconciled: true as const };
    await target.completeImport(input);
    await expect(target.completeImport(input)).resolves.toBeUndefined();
    const execution = {
      version: 2,
      custody: { kind: 'none' },
      attemptId: 'current-fixture.1',
      instanceId: '11111111-1111-4111-8111-111111111111',
      executionId: '22222222-2222-4222-8222-222222222222',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    const settlement = { execution, writerStopped: true, transientDataRemoved: true };
    const currentRecord = {
      _id: 'current-fixture',
      tenantId: user.tenantId,
      userId: user.userId,
      idempotencyKey: fixtureKey('current-fixture'),
      mediaType: 'text/plain',
      attemptGeneration: 1,
      securityExecution: execution,
      securitySettlement: settlement,
    };
    const current = replacement.connection.db!.collection<typeof currentRecord>(
      replacement.models.UploadOperation.collection.name,
    );
    await current.insertOne(currentRecord);
    await expect(target.completeImport(input)).resolves.toBeUndefined();
    await current.updateOne({ _id: 'current-fixture' }, { $unset: { securitySettlement: 1 } });
    await expect(target.completeImport(input)).rejects.toMatchObject({ code: 'not_ready' });
    expect(await current.countDocuments({ _id: 'current-fixture' })).toBe(1);
    await current.updateOne(
      { _id: 'current-fixture' },
      { $set: { securitySettlement: settlement } },
    );
    await expect(target.completeImport(input)).resolves.toBeUndefined();
    const legacy = {
      _id: 'legacy-fixture',
      tenantId: user.tenantId,
      userId: user.userId,
      idempotencyKey: fixtureKey('legacy-fixture'),
      mediaType: 'text/plain',
      attemptGeneration: 1,
      securityExecution: {
        version: 1,
        attemptId: 'legacy-fixture.1',
        instanceId: '11111111-1111-4111-8111-111111111111',
        executionId: '22222222-2222-4222-8222-222222222222',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    };
    await replacement.connection
      .db!.collection<typeof legacy>(replacement.models.UploadOperation.collection.name)
      .insertOne(legacy);
    await expect(target.completeImport(input)).rejects.toMatchObject({ code: 'not_ready' });
    expect(await replacement.models.UploadOperation.countDocuments({ _id: 'legacy-fixture' })).toBe(
      1,
    );
  });

  it('preserves pause through migration while fencing the source identity and permitting completed imports', async () => {
    const input = await command();
    await first.setAdmissionPolicy(input);
    const policy = (await counter()).value.admission;
    const page = await first.exportSnapshot({ epoch: 'admission-move' });
    expect(page.records[0]).toMatchObject({ type: 'global', value: { admission: policy } });
    await target.importSnapshot(page);
    const seal = await first.completeExport('admission-move');
    await target.completeImport({ receipt: seal, baseline, lifecycleReconciled: true });
    const destination = await target.getAdmissionPolicy();
    expect(destination).toMatchObject({ paused: true, revision: 1 });
    expect(destination.storeId).not.toBe(input.storeId);
    expect((await counter(replacement)).value.admission).toEqual(policy);
    await expect(target.setAdmissionPolicy(input)).rejects.toMatchObject({ code: 'not_ready' });
    await expect(
      target.reserve(user, request('destination-paused'), Date.now()),
    ).rejects.toMatchObject({
      code: 'admission_paused',
    });
    expect(await target.setAdmissionPolicy(await command(false, 1, replacement))).toMatchObject({
      paused: false,
      revision: 2,
    });
    expect((await target.reserve(user, request('destination-open'), Date.now())).state).toBe(
      'waiting',
    );
  });

  it('accepts a legacy missing migration policy but rejects malformed present metadata', async () => {
    const page = await first.exportSnapshot({ epoch: 'legacy-move' });
    const header = page.records[0].value as Record<string, unknown>;
    delete header.admission;
    await target.importSnapshot(page);
    expect(await target.getAdmissionPolicy()).toMatchObject({ paused: false, revision: 0 });
    await replacement.models.UploadCounter.deleteMany({});
    await target.initialize();
    header.admission = { paused: 'false', revision: 0 };
    const before = await counter(replacement);
    await expect(target.importSnapshot(page)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await counter(replacement)).toEqual(before);
  });
});
