/** Real local tree/cgroup fixtures; injected measurements only model unavailable/stale kernel work. */
import path from 'node:path';
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import type { UploadAttemptLocalReservation } from '../contract';
import type { UploadDiskObservation } from '../platform/local';
import { attemptOriginalPath, uploadAttemptId } from '../processing/paths';
import { measureUploadDirectory, MiB } from '../platform/local';
import { createIntakeResourceGuard } from './resources';

let root: string;
let stagingRoot: string;
let cgroupDirectory: string;
const now = { nowMs: 1000, monotonicMs: 1000 };
const clock = () => ({ ...now });
const binding = { hostId: 'host', instanceId: 'instance', operationId: 'operation', generation: 1 };
const signal = () => new AbortController().signal;
const create = (extra: Partial<Parameters<typeof createIntakeResourceGuard>[0]> = {}) =>
  createIntakeResourceGuard({ stagingRoot, cgroupDirectory, storage: 'disk', clock, ...extra });
async function file(name: string, bytes: number) {
  await mkdir(path.dirname(name), { recursive: true, mode: 0o700 });
  const handle = await open(name, 'w', 0o600);
  try {
    await handle.truncate(bytes);
  } finally {
    await handle.close();
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(async () => {
  if (!process.env.UPLOAD_TEST_TMPDIR) throw new Error('Explicit owned scratch required');
  root = await mkdtemp(path.join(process.env.UPLOAD_TEST_TMPDIR, 'intake-resources-'));
  stagingRoot = path.join(root, 'staging');
  cgroupDirectory = path.join(root, 'cgroup-fixture');
  await mkdir(stagingRoot, { mode: 0o700 });
  await mkdir(cgroupDirectory, { mode: 0o700 });
  await writeFile(path.join(cgroupDirectory, 'memory.current'), `${100 * MiB}\n`);
  await writeFile(path.join(cgroupDirectory, 'memory.max'), `${1024 * MiB}\n`);
});
afterEach(async () => {
  jest.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

it('measures the real disk and cgroup fixture, including old occupancy and only unwritten original growth', async () => {
  await file(path.join(stagingRoot, 'old-copy'), 80 * MiB);
  await file(attemptOriginalPath(stagingRoot, uploadAttemptId(binding)), 20 * MiB);
  const guard = create();
  await expect(
    guard.assertSafe([{ declaredBytes: 30 * MiB, binding }], signal()),
  ).resolves.toBeUndefined();
  await expect(
    guard.assertSafe([{ declaredBytes: 30 * MiB, binding }, { declaredBytes: 3 * MiB }], signal()),
  ).rejects.toMatchObject({ code: 'unavailable' });
});

it('holds future disk/pagecache growth and a receiver buffer in the actual cgroup budget', async () => {
  await writeFile(path.join(cgroupDirectory, 'memory.max'), `${367 * MiB}\n`);
  const guard = create();
  await expect(
    guard.assertSafe([{ declaredBytes: 10 * MiB, binding }], signal()),
  ).rejects.toThrow();
  await file(attemptOriginalPath(stagingRoot, uploadAttemptId(binding)), 10 * MiB);
  await expect(
    guard.assertSafe([{ declaredBytes: 10 * MiB, binding }], signal()),
  ).resolves.toBeUndefined();
  await writeFile(path.join(cgroupDirectory, 'memory.max'), `${357 * MiB}\n`);
  await expect(
    guard.assertSafe([{ declaredBytes: 10 * MiB, binding }], signal()),
  ).rejects.toThrow();
});

it.each(['max\n', 'unknown', '-1', '9007199254740992'])(
  'rejects unknown cgroup memory limit %s',
  async (limit) => {
    await writeFile(path.join(cgroupDirectory, 'memory.max'), limit);
    await expect(create().assertSafe([], signal())).rejects.toThrow();
  },
);

it('rejects links in the real staging tree and missing cgroup observations without exposing paths', async () => {
  await symlink(path.join(cgroupDirectory, 'memory.max'), path.join(stagingRoot, 'private-marker'));
  await expect(create().assertSafe([], signal())).rejects.toMatchObject({ message: 'unavailable' });
  await rm(path.join(stagingRoot, 'private-marker'));
  await rm(path.join(cgroupDirectory, 'memory.current'));
  await expect(create().assertSafe([], signal())).rejects.toMatchObject({ message: 'unavailable' });
});

it.each([
  ['memory', 0x01021994, true],
  ['memory', 0xef53, false],
  ['memory', 0x858458f6, false],
  ['disk', 0x01021994, false],
  ['disk', 0x858458f6, false],
  ['disk', 0xef53, true],
  ['disk', 0, false],
] as const)('validates the actual measured mount type for %s (%s)', async (storage, type, safe) => {
  const guard = create({ storage, measureFilesystemType: async () => type });
  const check = guard.assertSafe([], signal());
  if (safe) await expect(check).resolves.toBeUndefined();
  else await expect(check).rejects.toThrow();
});

it.each(['old', 'future', 'inodes', 'free', 'used', 'original'])(
  'fails closed for %s directory observation',
  async (failure) => {
    const measured = await measureUploadDirectory(stagingRoot, clock);
    const observations: Record<string, UploadDiskObservation> = {
      old: { ...measured, observedAtMs: -9000, observedMonotonicMs: -9000 },
      future: { ...measured, observedAtMs: 2000 },
      inodes: { ...measured, freeInodes: 1023 },
      free: { ...measured, freeBytes: 15 * MiB },
      used: { ...measured, usedBytes: NaN },
      original: { ...measured, originals: { 'operation.1': 100 * MiB } },
    };
    await expect(
      create({ measureDirectory: async () => observations[failure] }).assertSafe([], signal()),
    ).rejects.toThrow();
  },
);

it('rejects malformed/duplicate snapshots and oversized originals without starting an invalid reservation read', async () => {
  const measureDirectory = jest.fn(measureUploadDirectory);
  const guard = create({ measureDirectory });
  const item = { declaredBytes: MiB, binding };
  const invalid: readonly UploadAttemptLocalReservation[][] = [
    [{ declaredBytes: 0 }],
    [{ declaredBytes: 30 * MiB + 1 }],
    [{ declaredBytes: NaN }],
    [item, { ...item }],
    [{ ...item, binding: { ...binding, generation: 0 } }],
    Array.from({ length: 257 }, () => ({ declaredBytes: 1 })),
    new Array<UploadAttemptLocalReservation>(1),
  ];
  for (const records of invalid)
    await expect(guard.assertSafe(records, signal())).rejects.toThrow();
  expect(measureDirectory).not.toHaveBeenCalled();
  await file(attemptOriginalPath(stagingRoot, uploadAttemptId(binding)), 2 * MiB);
  await expect(guard.assertSafe([item], signal())).rejects.toThrow();
});

it('snapshots before awaiting and rejects accessors without executing them', async () => {
  const disk = await measureUploadDirectory(stagingRoot, clock);
  const pending = deferred<UploadDiskObservation>();
  const guard = create({ measureDirectory: () => pending.promise });
  const getter = jest.fn(() => 1);
  const accessor = Object.defineProperty({}, 'declaredBytes', { enumerable: true, get: getter });
  await expect(
    guard.assertSafe([accessor as UploadAttemptLocalReservation], signal()),
  ).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  const record = { declaredBytes: 30 * MiB };
  const result = guard.assertSafe(
    [record, { declaredBytes: 30 * MiB }, { declaredBytes: 30 * MiB }, { declaredBytes: 30 * MiB }],
    signal(),
  );
  record.declaredBytes = 1;
  pending.resolve(disk);
  await expect(result).rejects.toThrow();
});

it('retains one real measurement flight after timeout and an early sibling failure until every read settles', async () => {
  const disk = await measureUploadDirectory(stagingRoot, clock);
  jest.useFakeTimers();
  const pending = deferred<UploadDiskObservation>();
  const measureDirectory = jest.fn(() => pending.promise);
  const guard = create({
    measureDirectory,
    measureMemory: async () => {
      throw new Error('synthetic unreadable cgroup');
    },
  });
  const first = guard.assertSafe([], signal()).catch((error: unknown) => error);
  await jest.advanceTimersByTimeAsync(3000);
  expect(await first).toMatchObject({ code: 'unavailable' });
  const second = guard.assertSafe([], signal()).catch((error: unknown) => error);
  await jest.advanceTimersByTimeAsync(3000);
  expect(await second).toMatchObject({ code: 'unavailable' });
  expect(measureDirectory).toHaveBeenCalledTimes(1);
  const joined = guard.assertSafe([], signal()).catch((error: unknown) => error);
  pending.resolve(disk);
  expect(await joined).toMatchObject({ code: 'unavailable' });
});

it('keeps an aborted measurement in flight and refuses a late positive result for the aborted caller', async () => {
  const disk = await measureUploadDirectory(stagingRoot, clock);
  const pending = deferred<UploadDiskObservation>();
  const measureDirectory = jest.fn(() => pending.promise);
  const guard = create({ measureDirectory });
  const controller = new AbortController();
  const first = guard.assertSafe([], controller.signal).catch((error: unknown) => error);
  controller.abort();
  expect(await first).toMatchObject({ code: 'unavailable' });
  const second = guard.assertSafe([], signal());
  pending.resolve(disk);
  await expect(second).resolves.toBeUndefined();
  expect(measureDirectory).toHaveBeenCalledTimes(1);
});

it('rejects nonabsolute operating inputs before creating a guard', () => {
  expect(() => create({ stagingRoot: 'relative' })).toThrow();
  expect(() => create({ cgroupDirectory: 'relative' })).toThrow();
});
