import path from 'node:path';
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import type { UploadLocalReservations } from 'librechat-data-provider';
import {
  createUploadLocalSampler,
  measureUploadDirectory,
  uploadLocalReservation,
  MiB,
  LOCAL_POOL_BYTES,
} from './local';
import { decodeParserResources, parserResourcesSafe } from './parserResources';

const worker = { hostId: 'host', instanceId: 'instance' };
const at = 1800000000000;
const clock = { nowMs: at, monotonicMs: 1000 };
const lease = {
  ...worker,
  tenantId: 'tenant',
  userId: 'user',
  operationId: 'operation',
  generation: 2,
  kind: 'transfer' as const,
  expiresAt: new Date(at + 30000).toISOString(),
};
const journal: UploadLocalReservations = {
  worker,
  observedAt: at,
  heldBytes: 30 * MiB,
  counts: { transfer: 1, processing: 0 },
  attempts: [
    { operationId: 'operation', generation: 2, declaredBytes: 30 * MiB, kind: 'transfer', worker },
  ],
};
const disk = {
  observedAtMs: at,
  observedMonotonicMs: 1000,
  usedBytes: 12 * MiB,
  freeBytes: 512 * MiB,
  freeInodes: 10000,
  originals: { 'operation.2': 10 * MiB },
};

describe('local held copies and independent parser resources', () => {
  it('charges unwritten growth and orphan occupancy without duplicating written bytes', () => {
    const value = uploadLocalReservation({ worker, journal, disk, phase: 'transfer', clock });
    expect(value.mounts.staging).toEqual({
      usedBytes: 12 * MiB,
      reservedBytes: 20 * MiB,
      requiredBytes: 30 * MiB,
    });
    expect(value.memoryBytes).toBe(4 * MiB);
  });
  it('requires no new copy on exact lease renewal and refuses another generation or instance', () => {
    expect(
      uploadLocalReservation({ worker, journal, disk, phase: 'transfer', clock, lease }).mounts
        .staging.requiredBytes,
    ).toBe(0);
    expect(() =>
      uploadLocalReservation({
        worker,
        journal,
        disk,
        phase: 'transfer',
        clock,
        lease: { ...lease, generation: 3 },
      }),
    ).toThrow();
    expect(() =>
      uploadLocalReservation({
        worker,
        journal,
        disk,
        phase: 'transfer',
        clock,
        lease: { ...lease, instanceId: 'other' },
      }),
    ).toThrow();
  });
  it('keeps failed/stale held copies charged and rejects an incomplete reservation journal', () => {
    const complete = { ...disk, usedBytes: 32 * MiB, originals: { 'operation.2': 30 * MiB } };
    expect(
      uploadLocalReservation({ worker, journal, disk: complete, phase: 'admission', clock }).mounts
        .staging.reservedBytes,
    ).toBe(0);
    expect(() =>
      uploadLocalReservation({
        worker,
        journal: { ...journal, heldBytes: 0 },
        disk,
        phase: 'admission',
        clock,
      }),
    ).toThrow();
    expect(() =>
      uploadLocalReservation({
        worker,
        journal,
        disk,
        phase: 'admission',
        clock: { ...clock, nowMs: at + 10000, monotonicMs: 11000 },
      }),
    ).toThrow();
  });
  it('never starts replacement walkers while a previous filesystem read is stalled', async () => {
    jest.useFakeTimers();
    try {
      const measure = jest.fn(() => new Promise<typeof disk>(() => undefined));
      const sampler = createUploadLocalSampler({ root: '/trusted', clock: () => clock, measure });
      const first = sampler.refresh();
      await jest.advanceTimersByTimeAsync(3000);
      await first;
      const next = sampler.refresh();
      await jest.advanceTimersByTimeAsync(3000);
      await next;
      expect(measure).toHaveBeenCalledTimes(1);
      expect(sampler.current()).toBeUndefined();
      sampler.close();
    } finally {
      jest.useRealTimers();
    }
  });
  it('reserves parser memory in its own768MiB cgroup and scratch in its own128MiB pool', () => {
    const input = {
      schema: 1,
      instanceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      observedAtMs: at,
      active: false,
      memory: { currentBytes: 100 * MiB, limitBytes: 768 * MiB, reservedBytes: 0 },
      scratch: {
        usedBytes: MiB,
        reservedBytes: 0,
        freeBytes: 512 * MiB,
        freeInodes: 10000,
        capacityBytes: LOCAL_POOL_BYTES,
      },
    };
    const value = decodeParserResources(input, at);
    expect(parserResourcesSafe(value, true)).toBe(true);
    expect(
      parserResourcesSafe({ ...value, memory: { ...value.memory, currentBytes: 200 * MiB } }, true),
    ).toBe(false);
    expect(parserResourcesSafe({ ...value, active: true }, true)).toBe(false);
    expect(() => decodeParserResources(input, at + 10000)).toThrow();
    expect(() =>
      decodeParserResources(
        { ...input, memory: { incorrect: 0, limitBytes: 768 * MiB, reservedBytes: 0 } },
        at,
      ),
    ).toThrow();
  });
});

describe('private upload tree measurement', () => {
  let root: string;
  beforeEach(async () => {
    if (!process.env.UPLOAD_TEST_TMPDIR)
      throw new Error('Explicit isolated upload test directory required');
    await mkdir(process.env.UPLOAD_TEST_TMPDIR, { recursive: true });
    root = await mkdtemp(path.join(process.env.UPLOAD_TEST_TMPDIR, 'local-'));
  });
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });
  it('counts orphan allocation while recording only exact original logical lengths', async () => {
    await mkdir(path.join(root, 'operation.2'));
    await writeFile(path.join(root, 'operation.2', 'original'), Buffer.alloc(10));
    await writeFile(path.join(root, 'orphan'), Buffer.alloc(4096));
    const value = await measureUploadDirectory(root, () => clock);
    expect(value.originals).toEqual({ 'operation.2': 10 });
    expect(value.usedBytes).toBeGreaterThanOrEqual(4106);
    expect(value.freeBytes).toBeGreaterThan(0);
    expect(value.observedAtMs).toBe(at);
  });
  it('rejects links instead of omitting them from occupied space', async () => {
    await writeFile(path.join(root, 'orphan'), 'fixture');
    await symlink('orphan', path.join(root, 'alias'));
    await expect(measureUploadDirectory(root, () => clock)).rejects.toThrow('invalid_local_entry');
    await rm(path.join(root, 'alias'));
    await link(path.join(root, 'orphan'), path.join(root, 'alias'));
    await expect(measureUploadDirectory(root, () => clock)).rejects.toThrow('invalid_local_entry');
  });
});
