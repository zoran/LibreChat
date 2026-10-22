/** Fixed mounted configuration acquisition. The original I/O and handle remain owned through abort. */
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { ManagedFileDeploymentExpectations } from './configuration';
import type { TrustedManagedFileConfiguration } from './managed';
import {
  MANAGED_FILE_DEPLOYMENT_MAX_BYTES,
  managedFileConfigurationUnavailable,
  parseManagedFileDeploymentConfiguration,
  snapshotManagedFileDeploymentExpectations,
} from './configuration';

export const MANAGED_FILE_DEPLOYMENT_PATH = '/etc/cortex-retrieval-client/managed-file.json';

export type ManagedFileDeploymentOptions = {
  signal: AbortSignal;
  /** Synchronous first-failure notification; the returned promise still owns all I/O and cleanup. */
  onFailure?: (error: unknown) => void;
} & (
  | { mode: 'required'; expected: ManagedFileDeploymentExpectations }
  /** Absence may omit expectations; every present file still requires independently trusted values. */
  | { mode: 'optional'; expected?: ManagedFileDeploymentExpectations }
);

function absent(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

/** Native proof must already exist at composition. A parsed file never certifies global inventory. */
export function loadManagedFileDeploymentConfiguration(
  options: ManagedFileDeploymentOptions & { mode: 'required' },
): Promise<TrustedManagedFileConfiguration>;
export function loadManagedFileDeploymentConfiguration(
  options: ManagedFileDeploymentOptions,
): Promise<TrustedManagedFileConfiguration | undefined>;
export async function loadManagedFileDeploymentConfiguration(
  options: ManagedFileDeploymentOptions,
): Promise<TrustedManagedFileConfiguration | undefined> {
  if (!options) throw managedFileConfigurationUnavailable();
  const { signal, mode, onFailure } = options;
  if (!(signal instanceof AbortSignal) || (mode !== 'required' && mode !== 'optional')) {
    throw managedFileConfigurationUnavailable();
  }
  let failed = false;
  let firstFailure: unknown;
  const notifyFailure = (error: unknown) => {
    if (failed) return;
    failed = true;
    firstFailure = error;
    // Shutdown may abort the signal or throw here; neither can replace the first failure or its cleanup.
    try {
      onFailure?.(error);
    } catch {
      // The original failure remains authoritative; the caller still owns the returned promise.
    }
  };
  let handle: FileHandle | undefined;
  let configuration: TrustedManagedFileConfiguration | undefined;
  try {
    signal.throwIfAborted();
    const expected =
      mode === 'optional' && options.expected === undefined
        ? undefined
        : snapshotManagedFileDeploymentExpectations(options.expected!);
    try {
      handle = await open(MANAGED_FILE_DEPLOYMENT_PATH, 'r');
    } catch (error) {
      signal.throwIfAborted();
      if (mode === 'optional' && absent(error)) return undefined;
      throw error;
    }
    signal.throwIfAborted();
    if (expected === undefined) throw managedFileConfigurationUnavailable();
    const stat = await handle.stat();
    signal.throwIfAborted();
    if (!stat.isFile() || stat.size > MANAGED_FILE_DEPLOYMENT_MAX_BYTES) {
      throw managedFileConfigurationUnavailable();
    }
    const bytes = Buffer.alloc(MANAGED_FILE_DEPLOYMENT_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      signal.throwIfAborted();
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MANAGED_FILE_DEPLOYMENT_MAX_BYTES) throw managedFileConfigurationUnavailable();
    // Parse before close so malformed input can start the caller's shutdown deadline immediately.
    configuration = parseManagedFileDeploymentConfiguration(bytes.subarray(0, length), expected);
  } catch {
    notifyFailure(signal.aborted ? signal.reason : managedFileConfigurationUnavailable());
  } finally {
    // Do not race or detach an open/read/close original when the caller's deadline expires.
    if (handle) {
      try {
        await handle.close();
      } catch {
        notifyFailure(signal.aborted ? signal.reason : managedFileConfigurationUnavailable());
      }
    }
  }
  if (signal.aborted) notifyFailure(signal.reason);
  if (failed) throw firstFailure;
  return configuration;
}
