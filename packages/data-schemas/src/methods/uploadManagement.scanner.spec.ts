/** Real Mongo fences for scanner execution, settlement and late cleanup across replicas. */
import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { UploadLease, UploadSecurityExecution } from 'librechat-data-provider';
import type { StoredUpload } from './uploadManagementStore';
import { createUploadManagementRepository } from './uploadManagement';
import { createModels } from '~/models';

/** Deterministic UUIDv4-shaped test keys keep operation labels out of the public key contract. */
const fixtureKey = (label: string): string => {
  const hex = createHash('sha256').update(label).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

describe('durable scanner execution', () => {
  let mongo: MongoMemoryReplSet;
  const a = new mongoose.Mongoose();
  const b = new mongoose.Mongoose();
  const replacement = new mongoose.Mongoose();
  let first: ReturnType<typeof createUploadManagementRepository>;
  let second: ReturnType<typeof createUploadManagementRepository>;
  let target: ReturnType<typeof createUploadManagementRepository>;
  const now = Date.now();
  const policy = 'c'.repeat(64);
  const user = {
    tenantId: 'tenant-a',
    userId: new mongoose.Types.ObjectId().toString(),
    authentication: 'verified-email' as const,
  };
  const worker = { hostId: 'host-a', instanceId: 'app-a' };
  const sha256 = createHash('sha256').update('document').digest('hex');
  const documentResult = (text: string, bytes = 8) => ({
    text,
    writerStopped: true as const,
    structure: {
      version: 1 as const,
      source: { sha256: sha256, bytes, mediaType: 'text/plain' },
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
  const execution = (lease: UploadLease): UploadSecurityExecution => ({
    version: 1,
    attemptId: `${lease.operationId}.${lease.generation}`,
    instanceId: '11111111-1111-4111-8111-111111111111',
    executionId: '22222222-2222-4222-8222-222222222222',
    expiresAt: new Date(now + 60_000).toISOString(),
  });
  const settlement = (value: UploadSecurityExecution) => ({
    execution: value,
    writerStopped: true,
    transientDataRemoved: true,
  });
  const cleanup = (lease: UploadLease) => ({
    operationId: lease.operationId,
    generation: lease.generation,
    writerStopped: true,
    localCopiesAbsent: true,
    originalAbsent: true,
    textAndHistoryRemoved: true,
  });
  const receipt = (lease: UploadLease) => ({
    outcome: 'durable' as const,
    source: 's3',
    bytes: 8,
    filepath: `/api/files/download/${lease.operationId}`,
    storageKey: `t/${lease.tenantId}/managed-uploads/${lease.userId}/${lease.operationId}.${lease.generation}__original`,
    integrity: {
      version: 1 as const,
      algorithm: 'sha256' as const,
      sha256,
      chunkBytes: 262144 as const,
      chunkSha256: [sha256],
    },
  });
  const approval = (lease: UploadLease) => ({
    version: 1 as const,
    decision: 'approved' as const,
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
    scannerVersion: 'simulated-scanner-fixture-v1',
    checkedAt: new Date(now).toISOString(),
    coverage: { complete: true as const, pages: 1, parts: 1 },
  });
  const row = () => b.models.UploadOperation.findById('scan').lean<StoredUpload>();
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await Promise.all([
      a.connect(mongo.getUri('scanner')),
      b.connect(mongo.getUri('scanner')),
      replacement.connect(mongo.getUri('replacement')),
    ]);
    for (const db of [a, b, replacement]) createModels(db);
    await Promise.all([a.models.File.init(), b.models.File.init(), replacement.models.File.init()]);
  });
  beforeEach(async () => {
    for (const db of [a, replacement])
      for (const name of ['File', 'Message', 'UploadOperation', 'UploadCounter'])
        if (db.models[name]) await db.models[name].deleteMany({});
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
  async function transfer() {
    await first.reserve(
      user,
      {
        operationId: 'scan',
        idempotencyKey: fixtureKey('scan'),
        mediaType: 'text/plain',
        declaredBytes: 8,
        fingerprint: JSON.stringify([{ kind: 'personal' }, 'text/plain', 8]),
      },
      now,
    );
    return (await first.claim({
      kind: 'transfer',
      principal: user,
      operationId: 'scan',
      worker,
      now,
    }))!;
  }
  async function completed() {
    const lease = await transfer();
    const bound = execution(lease);
    await first.bindSecurityExecution(lease, bound, now);
    await second.settleSecurityExecution(lease, settlement(bound), now);
    return { lease, bound };
  }
  const accept = (lease: UploadLease) =>
    first.accept(user, lease, receipt(lease), approval(lease), { filename: 'note.txt' }, now);

  it('binds one immutable execution across racing replicas and replays only the winner', async () => {
    const lease = await transfer();
    const values = [
      execution(lease),
      { ...execution(lease), executionId: '33333333-3333-4333-8333-333333333333' },
    ];
    const results = await Promise.allSettled([
      first.bindSecurityExecution(lease, values[0], now),
      second.bindSecurityExecution(lease, values[1], now),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'lease_lost' },
    });
    const stored = (await row())!.securityExecution!;
    await second.bindSecurityExecution(lease, stored, now);
    expect((await row())!.securityExecution).toEqual(stored);
  });

  it('snapshots bind and settlement inputs before Mongo awaits', async () => {
    const lease = await transfer();
    const value = execution(lease);
    const expected = { ...value };
    const binding = first.bindSecurityExecution(lease, value, now);
    value.instanceId = '33333333-3333-4333-8333-333333333333';
    await binding;
    const proof = settlement(expected);
    const finishing = second.settleSecurityExecution(lease, proof, now);
    proof.writerStopped = false;
    proof.execution.executionId = value.instanceId;
    await finishing;
    expect(await row()).toMatchObject({
      securityExecution: execution(lease),
      securitySettlement: settlement(execution(lease)),
    });
  });

  it.each(['attempt', 'expired', 'owner', 'worker'])(
    'rejects invalid or foreign binding: %s',
    async (change) => {
      const lease = await transfer();
      const value = execution(lease);
      if (change === 'attempt') value.attemptId = 'another.1';
      if (change === 'expired') value.expiresAt = new Date(now).toISOString();
      const caller = {
        ...lease,
        ...(change === 'owner' ? { userId: 'other' } : {}),
        ...(change === 'worker' ? { instanceId: 'other' } : {}),
      };
      await expect(first.bindSecurityExecution(caller, value, now)).rejects.toMatchObject({
        code: ['attempt', 'expired'].includes(change) ? 'invalid_request' : 'lease_lost',
      });
      expect((await row())!.securityExecution).toBeUndefined();
    },
  );

  it('requires one complete matching settlement and never combines or downgrades partial reports', async () => {
    const lease = await transfer();
    const value = execution(lease);
    await expect(accept(lease)).rejects.toMatchObject({ code: 'security_uninspectable' });
    await expect(
      first.settleSecurityExecution(lease, settlement(value), now),
    ).rejects.toMatchObject({ code: 'lease_lost' });
    await first.bindSecurityExecution(lease, value, now);
    for (const proof of [
      { ...settlement(value), writerStopped: false },
      { ...settlement(value), transientDataRemoved: false },
    ]) {
      await second.settleSecurityExecution(lease, proof, now);
      await expect(accept(lease)).rejects.toMatchObject({ code: 'security_uninspectable' });
    }
    expect((await row())!.securitySettlement).toBeUndefined();
    expect(await b.models.File.countDocuments({})).toBe(0);
    await first.settleSecurityExecution(lease, settlement(value), now);
    await second.settleSecurityExecution(
      lease,
      { ...settlement(value), writerStopped: false },
      now,
    );
    expect((await row())!.securitySettlement).toEqual(settlement(value));
    await expect(accept(lease)).resolves.toMatchObject({ state: 'queued_processing' });
  });

  it('joins after lease expiry only through exact fenced cleanup, preserving every other uncertainty', async () => {
    const lease = await transfer();
    const value = execution(lease);
    await first.bindSecurityExecution(lease, value, now);
    const later = now + 60_001;
    const valid = { ...cleanup(lease), securitySettlement: settlement(value) };
    await expect(
      second.settleSecurityExecution(lease, settlement(value), later),
    ).rejects.toMatchObject({ code: 'lease_lost' });
    await first.reconcile(later);
    for (const proof of [
      cleanup(lease),
      { ...valid, writerStopped: false },
      { ...valid, securitySettlement: { ...settlement(value), transientDataRemoved: false } },
    ])
      await expect(second.confirmCleanup(proof, later)).rejects.toMatchObject({
        code: 'not_ready',
      });
    await expect(
      second.confirmCleanup({ ...valid, generation: lease.generation + 1 }, later),
    ).rejects.toMatchObject({ code: 'lease_lost' });
    await expect(
      second.confirmCleanup(
        {
          ...valid,
          securitySettlement: settlement({
            ...value,
            executionId: '33333333-3333-4333-8333-333333333333',
          }),
        },
        later,
      ),
    ).rejects.toMatchObject({ code: 'lease_lost' });
    expect(await row()).toMatchObject({ stagingHeld: true, originalBytes: 8, slot: 'transfer' });
    expect((await first.cleanupTasks())[0]).toMatchObject({
      securityExecution: value,
      writerStopped: false,
      localCopiesAbsent: false,
    });
    await second.confirmCleanup(valid, later);
    await first.confirmCleanup(valid, later);
    expect(await row()).toMatchObject({
      state: 'failed',
      stagingHeld: false,
      originalBytes: 0,
      securitySettlement: settlement(value),
    });
    expect(await first.usage(user, later)).toMatchObject({
      usedBytes: 0,
      retainedBytes: 0,
      reservedBytes: 0,
    });
  });

  it('serializes competing ordinary acceptance and confirmed cleanup without a partial File or debit', async () => {
    const { lease } = await completed();
    const [accepted] = await Promise.allSettled([
      accept(lease),
      second.confirmCleanup(cleanup(lease), now),
    ]);
    const success = accepted.status === 'fulfilled';
    expect(await b.models.File.countDocuments({})).toBe(success ? 1 : 0);
    expect(await first.usage(user, now)).toMatchObject({
      usedBytes: success ? 8 : 0,
      retainedBytes: success ? 8 : 0,
      reservedBytes: 0,
    });
  });

  it('keeps an expired but completed original receipt valid through processing and rejects its later removal', async () => {
    const { lease } = await completed();
    await accept(lease);
    await first.confirmCleanup({ ...cleanup(lease), originalAbsent: false }, now);
    const parser = (await second.claim({ kind: 'processing', worker, now: now + 60_001 }))!;
    expect(parser.generation).toBeGreaterThan(lease.generation);
    const time = now + 60_001;
    await first.bindProcessingExecution(
      parser,
      {
        attemptId: `scan.${parser.generation}`,
        instanceId: 'parser',
        expiresAt: new Date(time + 60_000).toISOString(),
      },
      time,
    );
    await first.publish(parser, documentResult('document'), time);
    await a.models.UploadOperation.updateOne(
      { _id: 'scan' },
      { $unset: { securitySettlement: 1 } },
    );
    await expect(second.publish(parser, documentResult('document'), time)).rejects.toMatchObject({
      code: 'security_uninspectable',
    });
    await expect(second.retryProcessing(user, 'scan', time)).rejects.toMatchObject({
      code: 'security_uninspectable',
    });
    expect((await first.get(user, 'scan', time)).canUseInComposer).toBe(false);
    expect((await first.list(user, time))[0].canUseInComposer).toBe(false);
  });

  it.each(['missing', 'foreign'])(
    'rejects active snapshot %s execution without inventing completion',
    async (change) => {
      const { lease } = await completed();
      await accept(lease);
      await first.confirmCleanup({ ...cleanup(lease), originalAbsent: false }, now);
      const page = await first.exportSnapshot({ epoch: 'move' });
      const altered = JSON.parse(JSON.stringify(page));
      const operation = altered.records.find(
        (entry: { type: string }) => entry.type === 'operation',
      ).value;
      if (change === 'missing') {
        delete operation.securityExecution;
        delete operation.securitySettlement;
      } else operation.securityExecution.executionId = '33333333-3333-4333-8333-333333333333';
      await expect(target.importSnapshot(altered)).rejects.toMatchObject({
        code: 'migration_conflict',
      });
      expect(await replacement.models.UploadOperation.countDocuments({})).toBe(0);
    },
  );
});
