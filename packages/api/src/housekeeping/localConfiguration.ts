/** Standalone Housekeeping's one bounded local YAML read; original acquisition and close stay joined. */
import yaml from 'js-yaml';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { checkpointerSchema, managedUploadsConfigSchema } from 'librechat-data-provider';
import type { ManagedUploadsConfig, TCheckpointerConfig } from 'librechat-data-provider';
import type { ResolvedCheckpointerConfig } from '../agents/checkpoints/config';

const CONFIG_PATH = '/app/librechat.yaml';
const CONFIG_MAX_BYTES = 1048576;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailable = (): Error => new Error('Housekeeping configuration unavailable');

export interface HousekeepingLocalConfiguration {
  checkpointConfig: {
    type: 'mongo' | 'memory';
    ttl: number;
    checkpointCollectionName: string;
    checkpointWritesCollectionName: string;
  };
  managedUploads?: ManagedUploadsConfig;
}

/** The caller owns startup cancellation/deadline and the checkpointer's existing default resolver. */
export interface HousekeepingLocalConfigurationOptions {
  signal: AbortSignal;
  resolveCheckpointerConfig(config: TCheckpointerConfig): ResolvedCheckpointerConfig;
  onFailure(): void;
}

/** A timeout may revoke startup; it never substitutes for joining the original descriptor close. */
export async function readHousekeepingLocalConfiguration(
  options: HousekeepingLocalConfigurationOptions,
): Promise<HousekeepingLocalConfiguration> {
  const { signal, resolveCheckpointerConfig, onFailure } = options;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let result: HousekeepingLocalConfiguration | undefined;
  let failure: unknown;
  try {
    signal.throwIfAborted();
    handle = await open(CONFIG_PATH, constants.O_RDONLY | constants.O_NOFOLLOW);
    signal.throwIfAborted();
    const stat = await handle.stat();
    signal.throwIfAborted();
    if (!stat.isFile() || stat.size < 1 || stat.size > CONFIG_MAX_BYTES) throw unavailable();
    const bytes = Buffer.alloc(CONFIG_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      signal.throwIfAborted();
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > CONFIG_MAX_BYTES) throw unavailable();
    const config: unknown = yaml.load(bytes.subarray(0, length).toString('utf8'), {
      schema: yaml.JSON_SCHEMA,
    });
    if (!record(config)) throw unavailable();
    const endpoints = config.endpoints;
    if (endpoints !== undefined && !record(endpoints)) throw unavailable();
    const agents = endpoints?.agents;
    if (agents !== undefined && !record(agents)) throw unavailable();
    const value = agents?.checkpointer;
    const block = checkpointerSchema
      .unwrap()
      .strict()
      .parse(value === undefined ? {} : value);
    if (Buffer.byteLength(JSON.stringify(block)) > 16384) throw unavailable();
    const resolved = resolveCheckpointerConfig(block);
    const fileConfig = config.fileConfig;
    if (fileConfig !== undefined && !record(fileConfig)) throw unavailable();
    const managedUploads = fileConfig?.managedUploads;
    result = {
      checkpointConfig: {
        type: resolved.type,
        ttl: resolved.ttlSeconds,
        checkpointCollectionName: resolved.checkpointCollectionName,
        checkpointWritesCollectionName: resolved.checkpointWritesCollectionName,
      },
      ...(managedUploads === undefined
        ? {}
        : { managedUploads: managedUploadsConfigSchema.parse(managedUploads) }),
    };
  } catch {
    const aborted = signal.aborted;
    onFailure();
    failure = aborted ? signal.reason : unavailable();
  }
  if (handle) {
    try {
      await handle.close();
    } catch {
      onFailure();
      failure ??= unavailable();
    }
  }
  if (failure !== undefined) throw failure;
  if (!result) throw unavailable();
  return result;
}
