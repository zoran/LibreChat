import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';

/** Only server-issued operation IDs and lease generations enter this namespace. */
export function uploadAttemptId(lease: { operationId: string; generation: number }): string {
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(lease.operationId) ||
    !Number.isSafeInteger(lease.generation) ||
    lease.generation < 1
  ) {
    throw new Error('Invalid upload attempt');
  }
  return `${lease.operationId}.${lease.generation}`;
}

export function attemptOriginalPath(root: string, attemptId: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}\.[1-9][0-9]{0,14}$/.test(attemptId) || !path.isAbsolute(root)) {
    throw new Error('Invalid upload attempt');
  }
  return path.join(root, attemptId, 'original');
}

/** The API creates immutable attempt directories; the sidecar mounts them read-only. */
export async function existingAttemptOriginal(root: string, attemptId: string): Promise<string> {
  const file = attemptOriginalPath(root, attemptId);
  const [actualRoot, actualFile, directory, info] = await Promise.all([
    realpath(root),
    realpath(file),
    lstat(path.dirname(file)),
    lstat(file),
  ]);
  if (
    actualFile !== path.join(actualRoot, attemptId, 'original') ||
    directory.isSymbolicLink() ||
    !directory.isDirectory() ||
    info.isSymbolicLink() ||
    !info.isFile()
  ) {
    throw new Error('Invalid upload attempt');
  }
  return file;
}
