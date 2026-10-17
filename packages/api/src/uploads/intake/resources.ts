/** Intake-local physical capacity guard; the existing attempt journal owns all reservations. */
import path from 'node:path';
import { constants } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { open, statfs } from 'node:fs/promises';
import type { UploadAttemptLocalGuard, UploadAttemptLocalReservation } from '../contract';
import type { UploadClock } from '../control/types';
import {
  freshLocal,
  measureUploadDirectory,
  measureUploadMemory,
  LOCAL_POOL_BYTES,
  LOCAL_FLOOR_BYTES,
  MiB,
} from '../platform/local';
import { attemptOriginalPath, uploadAttemptId } from '../processing/paths';
import { assessUploadLocalResources } from '../control/hardGuards';
import { UploadManagementError } from '../errors';

const TIMEOUT_MS = 3_000;
const TMPFS = 0x01021994;
const RAMFS = 0x858458f6;

async function filesystemType(root: string): Promise<number> {
  const directory = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    return Number((await statfs(`/proc/self/fd/${directory.fd}`, { bigint: true })).type);
  } finally {
    await directory.close();
  }
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Journal snapshots are detached before the first await; malformed/accessor data is unknown. */
function data(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid_snapshot');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('invalid_snapshot');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      (!required.includes(key) && !optional.includes(key)) ||
      !descriptor?.enumerable ||
      !('value' in descriptor)
    )
      throw new Error('invalid_snapshot');
    result[key] = descriptor.value;
  }
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(result, key)))
    throw new Error('invalid_snapshot');
  return result;
}

export function createIntakeResourceGuard(options: {
  stagingRoot: string;
  cgroupDirectory: string;
  storage: 'memory' | 'disk';
  clock?: () => UploadClock;
  /** Trusted measurement seams for bounded failure fixtures, never request input. */
  measureDirectory?: typeof measureUploadDirectory;
  measureMemory?: typeof measureUploadMemory;
  measureFilesystemType?: (root: string) => Promise<number>;
}): UploadAttemptLocalGuard {
  const { stagingRoot, cgroupDirectory, storage } = options;
  if (
    ![stagingRoot, cgroupDirectory].every(
      (value) => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0'),
    ) ||
    !['memory', 'disk'].includes(storage)
  )
    throw new Error('invalid_intake_resource_configuration');
  const clock = options.clock ?? (() => ({ nowMs: Date.now(), monotonicMs: performance.now() }));
  const directory = options.measureDirectory ?? measureUploadDirectory;
  const memory = options.measureMemory ?? measureUploadMemory;
  const mountType = options.measureFilesystemType ?? filesystemType;
  async function measure() {
    const started = clock();
    // allSettled is essential: a failed sibling read does not imply the walker has stopped.
    const settled = await Promise.allSettled([
      Promise.resolve().then(() => directory(stagingRoot, clock)),
      Promise.resolve().then(() => memory(cgroupDirectory)),
      Promise.resolve().then(() => mountType(stagingRoot)),
    ]);
    const [disk, ram, mount] = settled;
    if (disk.status !== 'fulfilled' || ram.status !== 'fulfilled' || mount.status !== 'fulfilled')
      throw new Error('unknown_local_resources');
    return { started, disk: disk.value, memory: ram.value, type: mount.value };
  }
  let flight: ReturnType<typeof measure> | undefined;

  function snapshot(reservations: readonly UploadAttemptLocalReservation[]) {
    // The journal bounds active records at 128 and all retained records together at 256.
    if (
      !Array.isArray(reservations) ||
      reservations.length > 256 ||
      Object.keys(reservations).length !== reservations.length
    )
      throw new Error('invalid_snapshot');
    const seen = new Set<string>();
    const objects = new Set<UploadAttemptLocalReservation>();
    return reservations.map((reservation) => {
      if (objects.has(reservation)) throw new Error('duplicate_reservation');
      objects.add(reservation);
      const record = data(reservation, ['declaredBytes'], ['binding']);
      if (
        !count(record.declaredBytes) ||
        record.declaredBytes < 1 ||
        record.declaredBytes > 30 * MiB
      )
        throw new Error('invalid_snapshot');
      let original: string | undefined;
      if (Object.prototype.hasOwnProperty.call(record, 'binding')) {
        const binding = data(record.binding, ['hostId', 'instanceId', 'operationId', 'generation']);
        if (
          ![binding.hostId, binding.instanceId].every(
            (value) => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(value),
          ) ||
          typeof binding.operationId !== 'string' ||
          !count(binding.generation)
        )
          throw new Error('invalid_snapshot');
        const attempt = uploadAttemptId({
          operationId: binding.operationId,
          generation: binding.generation,
        });
        original = path.relative(
          stagingRoot,
          path.dirname(attemptOriginalPath(stagingRoot, attempt)),
        );
        if (seen.has(original)) throw new Error('duplicate_reservation');
        seen.add(original);
      }
      return { declaredBytes: record.declaredBytes, original };
    });
  }

  return {
    async assertSafe(reservations, signal): Promise<void> {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let aborted: (() => void) | undefined;
      try {
        if (signal.aborted) throw new Error('aborted');
        const records = snapshot(reservations);
        if (!flight)
          flight = measure().finally(() => {
            flight = undefined;
          });
        const value = await Promise.race([
          flight,
          new Promise<never>((_, reject) => {
            aborted = () => reject(new Error('aborted'));
            signal.addEventListener('abort', aborted, { once: true });
            timeout = setTimeout(() => reject(new Error('measurement_timeout')), TIMEOUT_MS);
            timeout.unref();
            if (signal.aborted) aborted();
          }),
        ]);
        const now = clock();
        if (
          signal.aborted ||
          !freshLocal(
            { observedAtMs: value.started.nowMs, observedMonotonicMs: value.started.monotonicMs },
            now,
          ) ||
          now.monotonicMs - value.started.monotonicMs >= TIMEOUT_MS ||
          now.nowMs - value.started.nowMs >= TIMEOUT_MS ||
          !freshLocal(value.disk, now)
        )
          throw new Error('expired_measurement');
        if (
          !count(value.type) ||
          value.type === 0 ||
          (storage === 'memory'
            ? value.type !== TMPFS
            : value.type === TMPFS || value.type === RAMFS)
        )
          throw new Error('invalid_staging_mount');
        const disk = value.disk;
        if (
          !count(disk.usedBytes) ||
          !count(disk.freeBytes) ||
          !count(disk.freeInodes) ||
          !disk.originals ||
          typeof disk.originals !== 'object' ||
          Array.isArray(disk.originals) ||
          Object.getOwnPropertySymbols(disk.originals).length
        )
          throw new Error('invalid_measurement');
        const originals = Object.getOwnPropertyDescriptors(disk.originals);
        if (Reflect.ownKeys(originals).length > 1024) throw new Error('invalid_measurement');
        let originalBytes = 0;
        for (const descriptor of Object.values(originals)) {
          if (!('value' in descriptor) || !count(descriptor.value))
            throw new Error('invalid_measurement');
          originalBytes += descriptor.value;
        }
        if (!count(originalBytes) || originalBytes > disk.usedBytes)
          throw new Error('invalid_measurement');
        let growth = 0;
        for (const record of records) {
          const written = record.original ? (originals[record.original]?.value ?? 0) : 0;
          if (!count(written) || written > record.declaredBytes)
            throw new Error('invalid_measurement');
          growth += Math.max(0, record.declaredBytes - written);
        }
        if (
          !assessUploadLocalResources({
            memory: { ...value.memory, reservedBytes: growth + records.length * 2 * MiB },
            mounts: [
              {
                slot: 'intake',
                ...disk,
                reservedBytes: growth,
                requiredBytes: 0,
                capacityBytes: LOCAL_POOL_BYTES,
                floorBytes: LOCAL_FLOOR_BYTES,
              },
            ],
          }).safe
        )
          throw new Error('unsafe_local_resources');
      } catch {
        throw new UploadManagementError('unavailable');
      } finally {
        clearTimeout(timeout);
        if (aborted) signal.removeEventListener('abort', aborted);
      }
    },
  };
}
