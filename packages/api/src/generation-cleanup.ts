/** Finite Housekeeping composition. Importing this entry never constructs a manager. */
import Redis from 'ioredis';
import { readFileSync } from 'node:fs';
import { parseSharedState } from 'librechat-data-provider';
import type { RedisOptions } from 'ioredis';
import type { GenerationCleanupPort } from './stream/sourceCleanup';
import { RedisEventTransport } from './stream/implementations/RedisEventTransport';
import { RedisJobStore } from './stream/implementations/RedisJobStore';
import { createGenerationCleanupPort } from './stream/sourceCleanup';

export type {
  GenerationCleanupScope,
  GenerationCleanupTarget,
  GenerationCleanupPage,
  GenerationCleanupResult,
  GenerationCleanupEvidence,
  GenerationCleanupPort,
  SourceActorSettlement,
} from './stream/sourceCleanup';

/** Caller owns the publisher; subscriber must be a dedicated connection transferred to this port.
 * Bounded commands and no offline queue keep disconnection an explicit unknown outcome. */
export function createRedisGenerationCleanupPort(options: {
  publisher: Redis;
  subscriber: Redis;
}): GenerationCleanupPort {
  if (options.publisher === options.subscriber)
    throw new Error('generation_cleanup_dedicated_subscriber_required');
  for (const client of [options.publisher, options.subscriber]) {
    if (
      client.options.enableOfflineQueue !== false ||
      !Number.isFinite(client.options.commandTimeout) ||
      client.options.commandTimeout! <= 0 ||
      client.options.commandTimeout! > 5_000
    )
      throw new Error('generation_cleanup_finite_redis_required');
  }
  const store = new RedisJobStore(options.publisher);
  const transport = new RedisEventTransport(options.publisher, options.subscriber);
  return createGenerationCleanupPort({ store, transport, close: () => transport.destroy() });
}

export interface OwnedRedisGenerationCleanup {
  port: GenerationCleanupPort;
  /** Settles original port work, then both owned connections' terminal end events. */
  close(): Promise<void>;
}

const COMMAND_TIMEOUT_MS = 5_000;
const ACQUISITION_TIMEOUT_MS = 10_000;

function requiredCA(path: string): string {
  try {
    const value = readFileSync(path, 'utf8');
    if (!value.trim()) throw new Error();
    return value;
  } catch {
    throw new Error('Shared-state CA could not be loaded');
  }
}

/** No cache singleton, reconnect loop, background heartbeat, or actor manager is acquired. */
export async function createOwnedRedisGenerationCleanup(
  env: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
): Promise<OwnedRedisGenerationCleanup> {
  if (signal?.aborted) throw new Error('generation_cleanup_acquisition_aborted');
  const shared = parseSharedState(env);
  if (
    !['true', '1'].includes(env.USE_REDIS ?? '') ||
    (env.USE_REDIS_STREAMS !== undefined && !['true', '1'].includes(env.USE_REDIS_STREAMS)) ||
    ['true', '1'].includes(env.USE_REDIS_CLUSTER ?? '')
  ) {
    throw new Error('generation_cleanup_shared_redis_required');
  }
  if (env.REDIS_KEY_PREFIX_VAR && env.REDIS_KEY_PREFIX)
    throw new Error('Only either REDIS_KEY_PREFIX_VAR or REDIS_KEY_PREFIX can be set.');
  const prefix = env[env.REDIS_KEY_PREFIX_VAR ?? ''] || env.REDIS_KEY_PREFIX || '';
  const options: RedisOptions = {
    lazyConnect: true,
    keyPrefix: `${prefix}::`,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    autoResubscribe: false,
    enableReadyCheck: false,
    commandTimeout: COMMAND_TIMEOUT_MS,
    sentinelCommandTimeout: COMMAND_TIMEOUT_MS,
    connectTimeout: COMMAND_TIMEOUT_MS,
    disconnectTimeout: 1_000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    sentinelRetryStrategy: () => null,
    sentinelReconnectStrategy: () => null,
    reconnectOnError: () => false,
    failoverDetector: false,
    updateSentinels: false,
  };
  let uri: string | undefined;
  if (shared.mode === 'sentinel') {
    Object.assign(options, {
      sentinels: shared.endpoints,
      name: shared.name,
      role: 'master',
      username: shared.username,
      password: shared.password,
      sentinelUsername: shared.sentinelUsername,
      sentinelPassword: shared.sentinelPassword,
      enableTLSForSentinelMode: true,
      tls: { ca: requiredCA(shared.caPath), rejectUnauthorized: true },
      sentinelTLS: { ca: requiredCA(shared.sentinelCaPath), rejectUnauthorized: true },
    });
  } else {
    try {
      if (!env.REDIS_URI || env.REDIS_URI.includes(',')) throw new Error();
      const parsed = new URL(env.REDIS_URI);
      if (
        !['redis:', 'rediss:'].includes(parsed.protocol) ||
        parsed.search ||
        parsed.hash ||
        (env.REDIS_CA && parsed.protocol !== 'rediss:')
      )
        throw new Error();
      // ioredis gives URI query options precedence over the finite options selected above.
      uri = env.REDIS_URI;
      options.username = parsed.username || env.REDIS_USERNAME;
      options.password = parsed.password || env.REDIS_PASSWORD;
      if (parsed.protocol === 'rediss:')
        options.tls = {
          ...(env.REDIS_CA ? { ca: requiredCA(env.REDIS_CA) } : {}),
          rejectUnauthorized: true,
        };
    } catch {
      throw new Error('generation_cleanup_invalid_redis_transport');
    }
  }
  const clients: Redis[] = [];
  const originals: Promise<void>[] = [];
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    for (const client of clients) if (client.status !== 'end') client.disconnect();
  };
  const ended = (client: Redis, disconnect: boolean): Promise<void> => {
    if (client.status === 'end') return Promise.resolve();
    const original = new Promise<void>((resolve) => client.once('end', resolve));
    if (disconnect) client.disconnect();
    return original;
  };
  // This bounds acquisition; expiration requests actual closure and still awaits originals.
  const timer = setTimeout(stop, ACQUISITION_TIMEOUT_MS);
  signal?.addEventListener('abort', stop, { once: true });
  try {
    for (let i = 0; i < 2; i++) {
      if (stopped || signal?.aborted) throw new Error('generation_cleanup_acquisition_aborted');
      const client = uri === undefined ? new Redis(options) : new Redis(uri, options);
      clients.push(client);
      client.on('error', () => {
        /* Acquisition/commands own their original rejection. */
      });
      originals.push(
        (async () => {
          await client.connect();
          if (stopped) throw new Error('generation_cleanup_acquisition_aborted');
          // One bounded check instead of ioredis's indefinitely repeating LOADING ready loop.
          const info = await client.info();
          const fields = new Map<string, string>(
            info
              .split('\r\n')
              .filter((line) => line.includes(':'))
              .map(
                (line) =>
                  [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)] as const,
              ),
          );
          if (fields.get('role') !== 'master' || fields.get('loading') !== '0')
            throw new Error('generation_cleanup_redis_not_ready');
        })(),
      );
    }
    const results = await Promise.allSettled(originals);
    if (stopped || signal?.aborted || results.some((result) => result.status === 'rejected'))
      throw new Error('generation_cleanup_acquisition_failed');
    const port = createRedisGenerationCleanupPort({
      publisher: clients[0],
      subscriber: clients[1],
    });
    let closing: Promise<void> | undefined;
    return {
      port,
      close(): Promise<void> {
        closing ??= (async () => {
          try {
            await port.close();
          } finally {
            await Promise.all(clients.map((client, index) => ended(client, index === 0)));
          }
        })();
        return closing;
      },
    };
  } catch {
    stop();
    await Promise.allSettled(originals);
    await Promise.all(clients.map((client) => ended(client, false)));
    throw new Error('generation_cleanup_acquisition_failed');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}
