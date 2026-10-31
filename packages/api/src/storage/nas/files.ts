/** Local NAS configuration inputs; reject network mounts and aliases before opening secrets. */
import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import type { NasS3ClientOptions } from './client';

const unavailable = () => new Error('NAS storage configuration unavailable');
const localFilesystems = new Set([
  'overlay',
  'tmpfs',
  'ramfs',
  'ext4',
  'xfs',
  'btrfs',
  'zfs',
  'squashfs',
  'erofs',
]);
const hasControl = (value: string): boolean =>
  Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
const same = (a: Stats, b: Stats): boolean =>
  ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeMs', 'ctimeMs'].every(
    (key) => Reflect.get(a, key) === Reflect.get(b, key),
  );

/** Mount information is local even when a mounted NAS has stopped responding. */
async function localPath(filename: string, signal: AbortSignal): Promise<void> {
  if (
    !path.isAbsolute(filename) ||
    filename.length > 4096 ||
    path.normalize(filename) !== filename ||
    hasControl(filename) ||
    filename.includes('\\')
  )
    throw unavailable();
  const mountinfo = await readFile('/proc/self/mountinfo', 'utf8');
  signal.throwIfAborted();
  if (Buffer.byteLength(mountinfo) > 2 * 1024 * 1024) throw unavailable();
  // A deeper local bind cannot make an earlier remote/autofs ancestor safe to traverse.
  // All relevant mounts are classified before the first target lstat/open.
  let rootSeen = false;
  for (const line of mountinfo.split('\n')) {
    if (!line) continue;
    const [left, right, extra] = line.split(' - ');
    if (!right || extra !== undefined || left.split(' ').length < 6) throw unavailable();
    const mount = left
      .split(' ')[4]
      ?.replace(/\\([0-7]{3})/g, (_, octal: string) =>
        String.fromCharCode(Number.parseInt(octal, 8)),
      );
    if (!mount || !path.isAbsolute(mount)) throw unavailable();
    if (filename === mount || filename.startsWith(mount === '/' ? '/' : mount + '/')) {
      if (!localFilesystems.has(right.split(' ')[0])) throw unavailable();
      if (mount === '/') rootSeen = true;
    }
  }
  if (!rootSeen) throw unavailable();
  const parts = filename.split('/').filter(Boolean);
  let current = '';
  for (const part of parts.slice(0, -1)) {
    current += '/' + part;
    const info = await lstat(current);
    signal.throwIfAborted();
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.uid !== 0 && info.uid !== process.getuid?.()) ||
      ((info.mode & 0o022) !== 0 && !(info.uid === 0 && (info.mode & 0o1000) !== 0))
    )
      throw unavailable();
  }
}

/** Read the original descriptor to EOF within a bound and join its close on every outcome. */
async function readTrustedNasLocalFile(
  filename: string,
  input: { secret: boolean; signal: AbortSignal },
): Promise<Buffer> {
  const { signal, secret } = input;
  signal.throwIfAborted();
  await localPath(filename, signal);
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let output: Buffer | undefined;
  let bytes: Buffer | undefined;
  let failed = false;
  try {
    signal.throwIfAborted();
    const before = await handle.stat();
    const bound = secret ? 16 * 1024 : 64 * 1024;
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > bound ||
      (before.uid !== 0 && before.uid !== process.getuid?.()) ||
      (before.mode & (0o7000 | 0o111 | 0o022)) !== 0 ||
      (secret && (before.mode & 0o007) !== 0)
    )
      throw unavailable();
    bytes = Buffer.alloc(bound + 1);
    let length = 0;
    while (length < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      signal.throwIfAborted();
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (
      length !== before.size ||
      length > bound ||
      !same(before, await handle.stat()) ||
      !same(before, await lstat(filename))
    )
      throw unavailable();
    output = Buffer.from(bytes.subarray(0, length));
  } catch {
    output?.fill(0);
    failed = true;
  } finally {
    bytes?.fill(0);
    try {
      await handle.close();
    } catch {
      output?.fill(0);
      failed = true;
    }
  }
  if (failed || signal.aborted || !output) {
    output?.fill(0);
    throw unavailable();
  }
  return output;
}

/** Translate filesystem/open failures here so neither a private path nor submitted JSON escapes. */
export async function readNasLocalFile(
  filename: string,
  input: { secret: boolean; signal: AbortSignal },
): Promise<Buffer> {
  try {
    return await readTrustedNasLocalFile(filename, input);
  } catch {
    throw unavailable();
  }
}

/** Runtime Secret contains only this schema and key pair; the human credential owner is separate. */
export function parseNasCredentials(bytes: Uint8Array): NasS3ClientOptions['credentials'] {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'accessKeyId,schema,secretAccessKey'
    )
      throw unavailable();
    const schema: unknown = Reflect.get(value, 'schema');
    const accessKeyId: unknown = Reflect.get(value, 'accessKeyId');
    const secretAccessKey: unknown = Reflect.get(value, 'secretAccessKey');
    if (
      schema !== 1 ||
      typeof accessKeyId !== 'string' ||
      typeof secretAccessKey !== 'string' ||
      [accessKeyId, secretAccessKey].some(
        (value) => !value || value.length > 1024 || hasControl(value),
      )
    )
      throw unavailable();
    return Object.freeze({ accessKeyId, secretAccessKey });
  } catch {
    throw unavailable();
  }
}
