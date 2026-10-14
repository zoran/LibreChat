import { readFile, statfs } from 'node:fs/promises';
import type { UploadLease } from 'librechat-data-provider';
import type { ResourcePort } from '../contract';
import { UploadManagementError } from '../errors';
export interface UploadLocalMemory {
  currentBytes: number;
  limitBytes: number | null;
  reservedBytes: number;
}
export interface UploadLocalMount {
  slot: string;
  freeBytes: number;
  freeInodes: number;
  usedBytes: number;
  reservedBytes: number;
  requiredBytes: number;
  capacityBytes: number;
  floorBytes: number;
}
export interface UploadLocalResources {
  memory: UploadLocalMemory;
  mounts: readonly UploadLocalMount[];
}
export function assessUploadLocalResources(resources: UploadLocalResources): {
  safe: boolean;
  reason: 'safe' | 'disk' | 'memory' | 'inodes' | 'unknown';
} {
  const safeCount = (n: number | null): n is number =>
    n !== null && Number.isSafeInteger(n) && n >= 0;
  const memory = resources.memory;
  if (
    ![memory.currentBytes, memory.limitBytes, memory.reservedBytes].every(safeCount) ||
    memory.limitBytes === null ||
    memory.limitBytes - memory.currentBytes - memory.reservedBytes < 256 * 1048576
  )
    return { safe: false, reason: 'memory' };
  if (!resources.mounts.length) return { safe: false, reason: 'unknown' };
  for (const mount of resources.mounts) {
    if (
      ![
        mount.freeBytes,
        mount.freeInodes,
        mount.usedBytes,
        mount.reservedBytes,
        mount.requiredBytes,
        mount.capacityBytes,
        mount.floorBytes,
      ].every(safeCount)
    )
      return { safe: false, reason: 'unknown' };
    if (mount.freeInodes < 1024) return { safe: false, reason: 'inodes' };
    const floor = Math.max(16 * 1048576, mount.floorBytes);
    const capacity = Math.min(128 * 1048576, mount.capacityBytes);
    if (
      capacity - mount.usedBytes - mount.reservedBytes - mount.requiredBytes < floor ||
      mount.freeBytes - mount.reservedBytes - mount.requiredBytes < floor
    )
      return { safe: false, reason: 'disk' };
  }
  return { safe: true, reason: 'safe' };
}

/** Trusted composition provides reservation accounting; no directory walk or request path input. */
export interface UploadResourcePortOptions {
  cgroupDirectory: string;
  mounts: readonly { slot: string; path: string; capacityBytes: number; floorBytes: number }[];
  reservations: (
    phase: 'admission' | 'transfer' | 'processing',
    lease?: UploadLease,
  ) => Promise<{
    memoryBytes: number;
    observedAtMs?: number;
    mounts: Readonly<
      Record<string, { usedBytes: number; reservedBytes: number; requiredBytes: number }>
    >;
  }>;
  durability: () => Promise<{
    state: 'safe' | 'unsafe' | 'unknown';
    observedAtMs: number;
    expiresAtMs: number;
    expiresMonotonicMs: number;
  }>;
  clock: () => { nowMs: number; monotonicMs: number };
  observeResources?: (input: { resources: UploadLocalResources; observedAtMs: number }) => void;
}
export function createUploadResourcePort(options: UploadResourcePortOptions): ResourcePort {
  if (
    !options.cgroupDirectory.startsWith('/') ||
    options.mounts.length < 1 ||
    options.mounts.length > 8 ||
    new Set(options.mounts.map((mount) => mount.slot)).size !== options.mounts.length ||
    options.mounts.some((mount) => !mount.path.startsWith('/'))
  )
    throw new Error('invalid_upload_resource_configuration');
  const bytes = (text: string) =>
    /^\d+$/.test(text.trim()) && Number.isSafeInteger(Number(text.trim()))
      ? Number(text.trim())
      : null;
  type LocalRead = {
    started: ReturnType<UploadResourcePortOptions['clock']>;
    currentText: string;
    maxText: string;
    filesystems: { bavail: bigint; bsize: bigint; ffree: bigint }[];
  };
  let localFlight: Promise<LocalRead> | undefined;
  const readLocal = (): Promise<LocalRead> => {
    if (!localFlight) {
      const started = options.clock();
      localFlight = Promise.all([
        Promise.allSettled([
          readFile(`${options.cgroupDirectory}/memory.current`, 'utf8'),
          readFile(`${options.cgroupDirectory}/memory.max`, 'utf8'),
        ]),
        Promise.allSettled(options.mounts.map((mount) => statfs(mount.path, { bigint: true }))),
      ])
        .then(([memory, disks]) => {
          if (memory[0].status !== 'fulfilled' || memory[1].status !== 'fulfilled')
            throw new Error('unknown_upload_memory');
          const filesystems = disks.map((disk) => {
            if (disk.status !== 'fulfilled') throw new Error('unknown_upload_filesystem');
            return disk.value;
          });
          return { started, currentText: memory[0].value, maxText: memory[1].value, filesystems };
        })
        .finally(() => {
          localFlight = undefined;
        });
    }
    return localFlight;
  };
  return {
    async assertSafe({ phase, lease }) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        // A timed-out kernel read remains the only in-flight local read. It is never
        // considered cancelled and cannot cause replacement requests to accumulate IO.
        const [reserved, backend, measured] = await Promise.race([
          Promise.all([options.reservations(phase, lease), options.durability(), readLocal()]),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('upload_resource_timeout')), 3_000);
            timeout.unref();
          }),
        ]);
        const { currentText, maxText, filesystems } = measured;
        const clock = options.clock();
        const wallAge = clock.nowMs - measured.started.nowMs;
        const monoAge = clock.monotonicMs - measured.started.monotonicMs;
        if (
          ![wallAge, monoAge].every(Number.isFinite) ||
          wallAge < 0 ||
          monoAge < 0 ||
          wallAge >= 3_000 ||
          monoAge >= 3_000 ||
          Math.abs(wallAge - monoAge) > 1_000
        )
          throw new Error('expired_upload_resource_read');
        const resources: UploadLocalResources = {
          memory: {
            currentBytes: bytes(currentText) ?? NaN,
            limitBytes: bytes(maxText),
            reservedBytes: reserved.memoryBytes,
          },
          mounts: options.mounts.map((mount, index) => {
            const reservation = reserved.mounts[mount.slot];
            const fs = filesystems[index];
            if (!reservation) throw new Error('missing_upload_reservation');
            return {
              slot: mount.slot,
              capacityBytes: mount.capacityBytes,
              floorBytes: mount.floorBytes,
              usedBytes: reservation.usedBytes,
              reservedBytes: reservation.reservedBytes,
              requiredBytes: reservation.requiredBytes,
              freeBytes: Number(fs.bavail * fs.bsize),
              freeInodes: Number(fs.ffree),
            };
          }),
        };
        const observedAtMs = Math.min(
          reserved.observedAtMs ?? measured.started.nowMs,
          measured.started.nowMs,
        );
        if (reserved.observedAtMs !== undefined && reserved.observedAtMs > clock.nowMs)
          throw new Error('future_upload_reservations');
        if (
          !Number.isSafeInteger(observedAtMs) ||
          observedAtMs > clock.nowMs ||
          clock.nowMs - observedAtMs >= 10000
        )
          throw new Error('expired_upload_reservations');
        options.observeResources?.({ resources, observedAtMs });
        if (
          backend.state !== 'safe' ||
          ![
            backend.observedAtMs,
            backend.expiresAtMs,
            backend.expiresMonotonicMs,
            clock.nowMs,
            clock.monotonicMs,
          ].every(Number.isFinite) ||
          backend.observedAtMs > clock.nowMs ||
          clock.nowMs - backend.observedAtMs >= 70000 ||
          backend.expiresAtMs <= clock.nowMs ||
          backend.expiresMonotonicMs <= clock.monotonicMs
        )
          throw new Error('unsafe_upload_durability');
        if (!assessUploadLocalResources(resources).safe) throw new Error('unsafe_upload_resources');
      } catch {
        throw new UploadManagementError('unavailable');
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
