import { readFile, statfs } from 'node:fs/promises';
import { assessUploadLocalResources, createUploadResourcePort } from './hardGuards';
jest.mock('node:fs/promises', () => ({ readFile: jest.fn(), statfs: jest.fn() }));

const MiB = 1048576;
const safe = {
  memory: { currentBytes: 256 * MiB, limitBytes: 2048 * MiB, reservedBytes: 0 },
  mounts: [
    {
      slot: 'staging',
      freeBytes: 512 * MiB,
      freeInodes: 10000,
      usedBytes: 0,
      reservedBytes: 60 * MiB,
      requiredBytes: 30 * MiB,
      capacityBytes: 128 * MiB,
      floorBytes: 16 * MiB,
    },
  ],
};
describe('independent upload hard guards', () => {
  it('subtracts occupied and already reserved space before a new reservation', () => {
    expect(assessUploadLocalResources(safe).safe).toBe(true);
    expect(
      assessUploadLocalResources({ ...safe, mounts: [{ ...safe.mounts[0], usedBytes: 30 * MiB }] }),
    ).toEqual({ safe: false, reason: 'disk' });
  });
  it('keeps the real filesystem floor even if the logical mount allowance remains', () => {
    expect(
      assessUploadLocalResources({ ...safe, mounts: [{ ...safe.mounts[0], freeBytes: 100 * MiB }] })
        .safe,
    ).toBe(false);
  });
  it('fails closed on inode exhaustion, unlimited/unknown cgroups and malformed counters', () => {
    expect(
      assessUploadLocalResources({ ...safe, mounts: [{ ...safe.mounts[0], freeInodes: 1023 }] })
        .reason,
    ).toBe('inodes');
    expect(
      assessUploadLocalResources({ ...safe, memory: { ...safe.memory, limitBytes: null } }).reason,
    ).toBe('memory');
    expect(
      assessUploadLocalResources({ ...safe, memory: { ...safe.memory, currentBytes: NaN } }).safe,
    ).toBe(false);
  });
  it('accounts for reserved parser memory independently of API memory', () => {
    expect(
      assessUploadLocalResources({
        ...safe,
        memory: { currentBytes: 500 * MiB, limitBytes: 768 * MiB, reservedBytes: 32 * MiB },
      }).reason,
    ).toBe('memory');
  });
  it('does not permit configuration to raise the fixed working-pool ceiling', () => {
    expect(
      assessUploadLocalResources({
        ...safe,
        mounts: [{ ...safe.mounts[0], capacityBytes: 1024 * MiB, usedBytes: 60 * MiB }],
      }).safe,
    ).toBe(false);
  });
  it('reuses actual local observations without exposing paths and still rejects unknown durability', async () => {
    (readFile as jest.Mock).mockImplementation(async (path: string) =>
      path.endsWith('memory.max') ? String(2048 * MiB) : String(256 * MiB),
    );
    (statfs as jest.Mock).mockResolvedValue({
      bavail: BigInt(1024),
      bsize: BigInt(MiB),
      ffree: BigInt(10000),
    });
    const observeResources = jest.fn();
    let state: 'safe' | 'unknown' = 'safe';
    const port = createUploadResourcePort({
      cgroupDirectory: '/trusted/cgroup',
      mounts: [
        {
          slot: 'staging',
          path: '/trusted/staging',
          capacityBytes: 128 * MiB,
          floorBytes: 16 * MiB,
        },
      ],
      reservations: async () => ({
        memoryBytes: 0,
        mounts: { staging: { usedBytes: 0, reservedBytes: 60 * MiB, requiredBytes: 30 * MiB } },
      }),
      durability: async () => ({
        state,
        observedAtMs: 1800000000000,
        expiresAtMs: 1800000070000,
        expiresMonotonicMs: 70000,
      }),
      clock: () => ({ nowMs: 1800000000000, monotonicMs: 0 }),
      observeResources,
    });
    await expect(port.assertSafe({ phase: 'transfer' })).resolves.toBeUndefined();
    expect(observeResources).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(observeResources.mock.calls)).not.toContain('/trusted/');
    state = 'unknown';
    await expect(port.assertSafe({ phase: 'admission' })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
  it('passes the exact renewal lease and preserves the oldest reservation sample time', async () => {
    const now = 1800000000000;
    (readFile as jest.Mock).mockImplementation(async (path: string) =>
      path.endsWith('memory.max') ? String(2048 * MiB) : String(256 * MiB),
    );
    (statfs as jest.Mock).mockResolvedValue({
      bavail: BigInt(1024),
      bsize: BigInt(MiB),
      ffree: BigInt(10000),
    });
    const lease = {
      hostId: 'host',
      instanceId: 'instance',
      tenantId: 'tenant',
      userId: 'user',
      operationId: 'op',
      generation: 2,
      kind: 'transfer' as const,
      expiresAt: new Date(now + 30000).toISOString(),
    };
    let observedAtMs = now - 4000;
    const reservations = jest.fn(async () => ({
      memoryBytes: 0,
      observedAtMs,
      mounts: { staging: { usedBytes: 30 * MiB, reservedBytes: 0, requiredBytes: 0 } },
    }));
    const observeResources = jest.fn();
    const port = createUploadResourcePort({
      cgroupDirectory: '/trusted/cgroup',
      mounts: [
        {
          slot: 'staging',
          path: '/trusted/staging',
          capacityBytes: 128 * MiB,
          floorBytes: 16 * MiB,
        },
      ],
      reservations,
      observeResources,
      clock: () => ({ nowMs: now, monotonicMs: 1000 }),
      durability: async () => ({
        state: 'safe',
        observedAtMs: now,
        expiresAtMs: now + 70000,
        expiresMonotonicMs: 71000,
      }),
    });
    await port.assertSafe({ phase: 'transfer', lease });
    expect(reservations).toHaveBeenCalledWith('transfer', lease);
    expect(observeResources).toHaveBeenCalledWith(
      expect.objectContaining({ observedAtMs: now - 4000 }),
    );
    observedAtMs = now - 10000;
    await expect(port.assertSafe({ phase: 'transfer', lease })).rejects.toMatchObject({
      code: 'unavailable',
    });
    observedAtMs = now + 1;
    await expect(port.assertSafe({ phase: 'transfer', lease })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
  it('bounds stalled filesystem waits without accumulating replacement kernel reads', async () => {
    jest.useFakeTimers();
    try {
      (readFile as jest.Mock)
        .mockClear()
        .mockImplementation((path: string) =>
          path.endsWith('memory.current')
            ? Promise.reject(new Error('one read failed'))
            : new Promise(() => undefined),
        );
      (statfs as jest.Mock)
        .mockClear()
        .mockResolvedValue({ bavail: BigInt(1024), bsize: BigInt(MiB), ffree: BigInt(10000) });
      const port = createUploadResourcePort({
        cgroupDirectory: '/trusted/cgroup',
        mounts: [
          {
            slot: 'staging',
            path: '/trusted/staging',
            capacityBytes: 128 * MiB,
            floorBytes: 16 * MiB,
          },
        ],
        reservations: async () => ({
          memoryBytes: 0,
          mounts: { staging: { usedBytes: 0, reservedBytes: 0, requiredBytes: 0 } },
        }),
        durability: async () => ({
          state: 'safe',
          observedAtMs: Date.now(),
          expiresAtMs: Date.now() + 70000,
          expiresMonotonicMs: 70000,
        }),
        clock: () => ({ nowMs: Date.now(), monotonicMs: 0 }),
      });
      const first = await expect(port.assertSafe({ phase: 'admission' })).rejects.toMatchObject({
        code: 'unavailable',
      });
      await jest.advanceTimersByTimeAsync(3000);
      await first;
      const second = await expect(port.assertSafe({ phase: 'admission' })).rejects.toMatchObject({
        code: 'unavailable',
      });
      await jest.advanceTimersByTimeAsync(3000);
      await second;
      expect(readFile).toHaveBeenCalledTimes(2);
      expect(statfs).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
