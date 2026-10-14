/** Fixed local working-pool measurements; no queue, path input or admission authority. */
import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open, opendir, readFile, statfs } from 'node:fs/promises';
import type { UploadLease, UploadLocalReservations, UploadWorker } from 'librechat-data-provider';
import type { FileHandle } from 'node:fs/promises';
import type { UploadClock } from '../control/types';

export const MiB: number = 1048576;
export const LOCAL_POOL_BYTES: number = 128 * MiB;
export const LOCAL_FLOOR_BYTES: number = 16 * MiB;
export const LOCAL_MAX_AGE_MS: number = 10_000;
export const PARSER_MEMORY_RESERVATION: number = 320 * MiB;
export const PARSER_SCRATCH_RESERVATION: number = 100 * MiB;

export interface UploadDiskObservation {
  observedAtMs: number;
  observedMonotonicMs: number;
  usedBytes: number;
  freeBytes: number;
  freeInodes: number;
  /** Logical lengths only, keyed by server-owned relative attempt directory. */
  originals: Readonly<Record<string, number>>;
}
export interface UploadMemoryObservation {
  currentBytes: number;
  limitBytes: number;
}
export interface UploadLocalSampler {
  refresh(): Promise<void>;
  current(): UploadDiskObservation | undefined;
  start(): Promise<void>;
  close(): void;
}
export interface UploadLocalReservationResult {
  memoryBytes: number;
  mounts: { staging: { usedBytes: number; reservedBytes: number; requiredBytes: number } };
}

function count(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_local_measurement');
  return value;
}
export function freshLocal(
  observed: { observedAtMs: number; observedMonotonicMs: number },
  now: UploadClock,
): boolean {
  const wallAge = now.nowMs - observed.observedAtMs;
  const monoAge = now.monotonicMs - observed.observedMonotonicMs;
  return (
    [wallAge, monoAge].every(Number.isFinite) &&
    wallAge >= 0 &&
    monoAge >= 0 &&
    wallAge < LOCAL_MAX_AGE_MS &&
    monoAge < LOCAL_MAX_AGE_MS &&
    Math.abs(wallAge - monoAge) <= 1_000
  );
}

/** A bounded private-tree walk includes unjournaled files and never follows links. */
export async function measureUploadDirectory(
  root: string,
  clock: () => UploadClock,
): Promise<UploadDiskObservation> {
  if (!path.isAbsolute(root)) throw new Error('invalid_local_root');
  const started = clock();
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const rootHandle = await open(root, flags);
  try {
    const rootInfo = await rootHandle.stat();
    const uid = process.getuid?.();
    const trustedMountRoot = rootInfo.uid === 0 && rootInfo.gid === process.getgid?.();
    if (!rootInfo.isDirectory() || (rootInfo.uid !== uid && !trustedMountRoot))
      throw new Error('invalid_local_root');
    const originals: Record<string, number> = Object.create(null);
    let entries = 0;
    let usedBytes = count(Math.max(rootInfo.size, rootInfo.blocks * 512));
    async function walk(directory: FileHandle, depth: number, relative: string): Promise<void> {
      if (depth > 4) throw new Error('local_measurement_depth');
      // This Linux cgroup deployment uses an owned descriptor, so renaming a directory
      // after lstat cannot redirect the walk through a caller-created symlink.
      const anchored = `/proc/self/fd/${directory.fd}`;
      const handle = await opendir(anchored);
      for await (const entry of handle) {
        if (++entries > 1024 || clock().monotonicMs - started.monotonicMs >= 3_000)
          throw new Error('local_measurement_limit');
        const filename = path.join(anchored, entry.name);
        const info = await lstat(filename);
        if (
          info.dev !== rootInfo.dev ||
          info.uid !== uid ||
          info.isSymbolicLink() ||
          (!info.isDirectory() && !info.isFile()) ||
          (info.isFile() && info.nlink !== 1)
        )
          throw new Error('invalid_local_entry');
        usedBytes = count(usedBytes + count(Math.max(info.size, info.blocks * 512)));
        if (info.isDirectory()) {
          const child = await open(filename, flags);
          try {
            const actual = await child.stat();
            if (actual.ino !== info.ino || actual.dev !== info.dev || actual.uid !== info.uid)
              throw new Error('changed_local_entry');
            await walk(child, depth + 1, path.join(relative, entry.name));
          } finally {
            await child.close();
          }
        } else if (entry.name === 'original' && depth === 1) originals[relative] = count(info.size);
      }
    }
    await walk(rootHandle, 0, '');
    const fs = await statfs(`/proc/self/fd/${rootHandle.fd}`, { bigint: true });
    const result = {
      observedAtMs: started.nowMs,
      observedMonotonicMs: started.monotonicMs,
      usedBytes,
      freeBytes: count(Number(fs.bavail * fs.bsize)),
      freeInodes: count(Number(fs.ffree)),
      originals,
    };
    if (!freshLocal(result, clock())) throw new Error('expired_local_measurement');
    return result;
  } finally {
    await rootHandle.close();
  }
}

export async function measureUploadMemory(
  cgroupDirectory: string,
): Promise<UploadMemoryObservation> {
  if (!path.isAbsolute(cgroupDirectory)) throw new Error('invalid_cgroup_root');
  const settled = await Promise.allSettled(
    ['memory.current', 'memory.max'].map((name) =>
      readFile(path.join(cgroupDirectory, name), 'utf8'),
    ),
  );
  const [current, limit] = settled.map((result) => {
    if (result.status !== 'fulfilled') throw new Error('unknown_cgroup_limit');
    return result.value;
  });
  if (![current, limit].every((value) => /^\d{1,18}\n?$/.test(value)))
    throw new Error('unknown_cgroup_limit');
  return { currentBytes: count(Number(current.trim())), limitBytes: count(Number(limit.trim())) };
}

/** A timed-out kernel read stays one in-flight read; no replacement walkers accumulate. */
export function createUploadLocalSampler(options: {
  root: string;
  clock: () => UploadClock;
  measure?: typeof measureUploadDirectory;
}): UploadLocalSampler {
  let current: UploadDiskObservation | undefined;
  let flight: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  async function refresh(): Promise<void> {
    if (closed) return;
    if (!flight) {
      const start = options.clock();
      flight = (options.measure ?? measureUploadDirectory)(options.root, options.clock)
        .then(
          (value) => {
            if (
              !closed &&
              options.clock().monotonicMs - start.monotonicMs < 3_000 &&
              freshLocal(value, options.clock())
            )
              current = value;
            else current = undefined;
          },
          () => {
            current = undefined;
          },
        )
        .finally(() => {
          flight = undefined;
        });
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      flight,
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          current = undefined;
          resolve();
        }, 3_000);
        timeout.unref();
      }),
    ]).finally(() => clearTimeout(timeout));
  }
  return {
    refresh,
    current(): UploadDiskObservation | undefined {
      return current && freshLocal(current, options.clock())
        ? { ...current, originals: { ...current.originals } }
        : undefined;
    },
    async start(): Promise<void> {
      if (closed || timer) return;
      await refresh();
      if (!closed && !timer) {
        timer = setInterval(() => {
          void refresh();
        }, 5_000);
        timer.unref();
      }
    },
    close(): void {
      closed = true;
      clearInterval(timer);
      timer = undefined;
      current = undefined;
    },
  };
}

/** Physical occupancy plus unwritten reservations; already-written originals are not charged twice. */
export function uploadLocalReservation(input: {
  worker: UploadWorker;
  journal: UploadLocalReservations;
  disk: UploadDiskObservation;
  phase: 'admission' | 'transfer' | 'processing';
  lease?: UploadLease;
  clock: UploadClock;
}): UploadLocalReservationResult {
  const { worker, journal, disk, phase, lease, clock } = input;
  if (
    !freshLocal(disk, clock) ||
    !Number.isSafeInteger(journal.observedAt) ||
    journal.observedAt > clock.nowMs ||
    clock.nowMs - journal.observedAt >= 3_000 ||
    journal.worker.hostId !== worker.hostId ||
    journal.worker.instanceId !== worker.instanceId ||
    journal.attempts.length > 128
  )
    throw new Error('unknown_local_reservations');
  const seen = new Set<string>();
  const counts = { transfer: 0, processing: 0 };
  let total = 0;
  let reservedBytes = 0;
  let owned = !lease;
  for (const attempt of journal.attempts) {
    if (
      !/^[a-zA-Z0-9_-]{1,128}$/.test(attempt.operationId) ||
      !Number.isSafeInteger(attempt.generation) ||
      attempt.generation < 1 ||
      !['transfer', 'processing'].includes(attempt.kind) ||
      attempt.worker.hostId !== worker.hostId ||
      attempt.worker.instanceId !== worker.instanceId ||
      !Number.isSafeInteger(attempt.declaredBytes) ||
      attempt.declaredBytes < 1 ||
      attempt.declaredBytes > 30 * MiB
    ) {
      throw new Error('invalid_local_reservation');
    }
    const id = `${attempt.operationId}.${attempt.generation}`;
    if (seen.has(id)) throw new Error('duplicate_local_reservation');
    seen.add(id);
    counts[attempt.kind]++;
    total += attempt.declaredBytes;
    const written = disk.originals[id] ?? 0;
    count(written);
    reservedBytes += Math.max(0, attempt.declaredBytes - written);
    if (
      lease &&
      lease.kind === attempt.kind &&
      phase === lease.kind &&
      lease.operationId === attempt.operationId &&
      lease.generation === attempt.generation &&
      lease.hostId === worker.hostId &&
      lease.instanceId === worker.instanceId
    )
      owned = true;
  }
  if (
    !owned ||
    total !== journal.heldBytes ||
    counts.transfer !== journal.counts.transfer ||
    counts.processing !== journal.counts.processing
  )
    throw new Error('invalid_local_reservation_total');
  let prospective = 0;
  if (!lease) prospective = phase === 'transfer' ? 2 * MiB : 64 * MiB;
  return {
    memoryBytes: count(counts.transfer * 2 * MiB + counts.processing * 64 * MiB + prospective),
    mounts: {
      staging: {
        usedBytes: disk.usedBytes,
        reservedBytes: count(reservedBytes),
        requiredBytes: lease ? 0 : 30 * MiB,
      },
    },
  };
}
