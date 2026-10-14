import IoRedis from 'ioredis';
import calculateSlot from 'cluster-key-slot';
import { logger } from '@librechat/data-schemas';
import { createClient, createCluster, createSentinel } from '@keyv/redis';
import type { RedisClientType, RedisClusterType, RedisSentinelType } from '@redis/client';
import type { ScanOptions } from '@redis/client/dist/lib/commands/SCAN';
import type { Redis, Cluster } from 'ioredis';
import type { ReadonlyRecoveryHandler } from './recovery';
import { createReadonlyRecovery, isReadonlyReplicaError } from './recovery';
import { startRedisHeartbeat } from './heartbeat';
import { cacheConfig } from './cacheConfig';

const sentinel =
  cacheConfig.SHARED_STATE?.mode === 'sentinel' ? cacheConfig.SHARED_STATE : undefined;
const urls = cacheConfig.REDIS_URI?.split(',').map((uri) => new URL(uri)) || [];
const username = urls?.[0]?.username || cacheConfig.REDIS_USERNAME;
const password = urls?.[0]?.password || cacheConfig.REDIS_PASSWORD;
const ca = cacheConfig.REDIS_CA;
const protocols = new Set(urls.map((url) => url.protocol));
const useTls = !!sentinel || urls[0]?.protocol === 'rediss:';
const isRedisCluster = !sentinel && (urls.length !== 1 || cacheConfig.USE_REDIS_CLUSTER);

if (cacheConfig.USE_REDIS && protocols.size > 1) {
  throw new Error('All REDIS_URI entries must use the same protocol');
}

if (cacheConfig.USE_REDIS && ca && !useTls) {
  throw new Error('REDIS_CA requires REDIS_URI to use rediss://');
}

let resolveKeyvRedisClientReady: (() => void) | undefined;
let rejectKeyvRedisClientReady: ((reason?: unknown) => void) | undefined;
const keyvRedisClientReady: Promise<void> | null = cacheConfig.USE_REDIS
  ? new Promise<void>((resolve, reject) => {
      resolveKeyvRedisClientReady = resolve;
      rejectKeyvRedisClientReady = reject;
    })
  : null;

/** Waits for the stable shared Keyv Redis readiness gate. */
async function waitForKeyvRedisClient(): Promise<void> {
  await keyvRedisClientReady;
}

let ioredisClient: Redis | Cluster | null = null;
let initialIoRedisReady: Promise<void> | undefined;

/** Wait once for Sentinel startup; later disconnects must still reject without queuing writes. */
function waitForInitialIoRedisReady(): Promise<void> {
  if (!sentinel || !ioredisClient) {
    return Promise.resolve();
  }
  if (initialIoRedisReady) {
    return initialIoRedisReady;
  }
  const client = ioredisClient;
  initialIoRedisReady = new Promise<void>((resolve, reject) => {
    if (client.status === 'ready') {
      resolve();
      return;
    }
    if (client.status === 'end') {
      reject(new Error('Redis initial connection ended'));
      return;
    }
    const finish = (error?: Error) => {
      clearTimeout(timer);
      client.off('ready', ready);
      client.off('end', ended);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const ready = () => finish();
    const ended = () => finish(new Error('Redis initial connection ended'));
    const timer = setTimeout(
      () => finish(new Error('Redis initial connection timed out')),
      cacheConfig.REDIS_CONNECT_TIMEOUT,
    );
    timer.unref();
    client.once('ready', ready);
    client.once('end', ended);
  });
  return initialIoRedisReady;
}

let redisStartupReady: Promise<void> | undefined;

/** Bounds initial client readiness once; later disconnects must not queue or replay work. */
function waitForRedisStartup(): Promise<void> {
  if (!cacheConfig.USE_REDIS) {
    return Promise.resolve();
  }
  redisStartupReady ??= (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Redis startup timed out')),
            cacheConfig.REDIS_CONNECT_TIMEOUT,
          );
          timer.unref();
        }),
        Promise.all([waitForKeyvRedisClient(), waitForInitialIoRedisReady()]),
      ]);
    } finally {
      clearTimeout(timer);
    }
  })();
  return redisStartupReady;
}

if (cacheConfig.USE_REDIS) {
  const redisOptions: Record<string, unknown> = {
    username: username,
    password: password,
    tls: useTls ? { ca: ca ?? undefined } : undefined,
    keyPrefix: `${cacheConfig.REDIS_KEY_PREFIX}${cacheConfig.GLOBAL_PREFIX_SEPARATOR}`,
    maxListeners: cacheConfig.REDIS_MAX_LISTENERS,
    retryStrategy: (times: number) => {
      if (
        cacheConfig.REDIS_RETRY_MAX_ATTEMPTS > 0 &&
        times > cacheConfig.REDIS_RETRY_MAX_ATTEMPTS
      ) {
        logger.error(
          `ioredis giving up after ${cacheConfig.REDIS_RETRY_MAX_ATTEMPTS} reconnection attempts`,
        );
        return null;
      }
      const base = Math.min(Math.pow(2, times) * 50, cacheConfig.REDIS_RETRY_MAX_DELAY);
      const jitter = Math.floor(Math.random() * Math.min(base, 1000));
      const delay = Math.min(base + jitter, cacheConfig.REDIS_RETRY_MAX_DELAY);
      logger.info(`ioredis reconnecting... attempt ${times}, delay ${delay}ms`);
      return delay;
    },
    reconnectOnError: (err: Error) => {
      if (isReadonlyReplicaError(err)) {
        logger.warn('ioredis reconnecting due to READONLY error');
        return 2; // Return retry delay instead of boolean
      }
      return false;
    },
    enableOfflineQueue: cacheConfig.REDIS_ENABLE_OFFLINE_QUEUE,
    connectTimeout: cacheConfig.REDIS_CONNECT_TIMEOUT,
    maxRetriesPerRequest: 3,
    keepAlive: cacheConfig.REDIS_KEEP_ALIVE,
  };

  if (sentinel) {
    ioredisClient = new IoRedis({
      ...redisOptions,
      sentinels: sentinel.endpoints,
      name: sentinel.name,
      role: 'master',
      username: sentinel.username,
      password: sentinel.password,
      sentinelUsername: sentinel.sentinelUsername,
      sentinelPassword: sentinel.sentinelPassword,
      enableTLSForSentinelMode: true,
      tls: { ca: ca ?? undefined, rejectUnauthorized: true },
      sentinelTLS: { ca: cacheConfig.REDIS_SENTINEL_CA ?? undefined, rejectUnauthorized: true },
      enableOfflineQueue: false,
      autoResendUnfulfilledCommands: false,
    });
  } else if (!isRedisCluster) {
    ioredisClient = new IoRedis(cacheConfig.REDIS_URI!, redisOptions);
  } else {
    ioredisClient = new IoRedis.Cluster(
      urls.map((url) => ({ host: url.hostname, port: parseInt(url.port, 10) || 6379 })),
      {
        ...(cacheConfig.REDIS_USE_ALTERNATIVE_DNS_LOOKUP
          ? {
              dnsLookup: (
                address: string,
                callback: (err: Error | null, address: string) => void,
              ) => callback(null, address),
            }
          : {}),
        redisOptions,
        clusterRetryStrategy: (times: number) => {
          if (
            cacheConfig.REDIS_RETRY_MAX_ATTEMPTS > 0 &&
            times > cacheConfig.REDIS_RETRY_MAX_ATTEMPTS
          ) {
            logger.error(
              `ioredis cluster giving up after ${cacheConfig.REDIS_RETRY_MAX_ATTEMPTS} reconnection attempts`,
            );
            return null;
          }
          const base = Math.min(Math.pow(2, times) * 100, cacheConfig.REDIS_RETRY_MAX_DELAY);
          const jitter = Math.floor(Math.random() * Math.min(base, 1000));
          const delay = Math.min(base + jitter, cacheConfig.REDIS_RETRY_MAX_DELAY);
          logger.info(`ioredis cluster reconnecting... attempt ${times}, delay ${delay}ms`);
          return delay;
        },
        enableOfflineQueue: cacheConfig.REDIS_ENABLE_OFFLINE_QUEUE,
      },
    );
  }

  ioredisClient.on('error', (err) => {
    logger.error('ioredis client error:', err);
  });

  ioredisClient.on('connect', () => {
    logger.info('ioredis client connected');
  });

  ioredisClient.on('ready', () => {
    // Remember initial readiness even if the first limiter is constructed after a disconnect.
    initialIoRedisReady ??= Promise.resolve();
    logger.info('ioredis client ready');
  });

  ioredisClient.on('reconnecting', (delay: number) => {
    logger.info(`ioredis client reconnecting in ${delay}ms`);
  });

  ioredisClient.on('close', () => {
    logger.warn('ioredis client connection closed');
  });

  /** Deadline-bounded keepalive PINGs; an unanswered probe forces a reconnect. */
  if (cacheConfig.REDIS_PING_INTERVAL > 0) {
    startRedisHeartbeat({
      client: ioredisClient,
      intervalMs: cacheConfig.REDIS_PING_INTERVAL * 1000,
      timeoutMs: cacheConfig.REDIS_PING_TIMEOUT,
      label: 'ioredis client',
    });
  }
}

export type SentinelClient = RedisSentinelType & {
  disconnect(): Promise<void>;
  scanIterator(options?: ScanOptions): AsyncGenerator<string[]>;
};
export type SharedRedisClient = (RedisClientType | RedisClusterType | SentinelClient) & {
  scanIterator(options?: ScanOptions): AsyncGenerator<string[]>;
};

/** Hold one primary lease for a complete scan; never mix cursors across failover nodes. */
export function withSentinelScan(client: RedisSentinelType): SentinelClient {
  return Object.assign(client, {
    disconnect: () => client.destroy(),
    async *scanIterator(options?: ScanOptions) {
      const primary = await client.acquire();
      try {
        let cursor = '0';
        do {
          const page = await primary.scan(cursor, options);
          cursor = page.cursor;
          yield page.keys;
        } while (cursor !== '0');
      } finally {
        await primary.release();
      }
    },
  });
}

let keyvRedisClient: SharedRedisClient | null = null;
let recoverKeyvRedisClient: ReadonlyRecoveryHandler | undefined;

/**
 * Routes a Keyv Redis client error through READONLY failover recovery.
 * Cluster clients follow MOVED to the owning master on their own, so the hook
 * only exists for the standalone client. Returns whether a reconnect was started.
 */
function handleKeyvRedisError(error: unknown): boolean {
  return recoverKeyvRedisClient?.(error) ?? false;
}

type RedisEvalOptions = { keys: string[]; arguments: string[] };

async function runKeyvRedisScript(
  client: SharedRedisClient,
  script: string,
  options: RedisEvalOptions,
): Promise<unknown> {
  if (!('masters' in client) || options.keys.length === 0) {
    return client.eval(script, options);
  }

  const slot = calculateSlot(options.keys[0]);
  if (options.keys.some((key) => calculateSlot(key) !== slot)) {
    throw new Error('Redis catalog script keys must share one cluster slot');
  }
  const master = client.getSlotMaster(slot);
  const nodeClient = await client.nodeClient(master);
  return nodeClient.eval(script, options);
}

/**
 * Runs a Lua script on the master that owns its keys. Node Redis can execute a
 * cluster EVAL through an arbitrary node while the slot map is settling, which
 * leaks a MOVED reply instead of following it. Catalog scripts are deliberately
 * single-slot, so selecting the owning master also makes that invariant explicit.
 *
 * Script failures reject straight to the caller without passing through any
 * client error event, so READONLY replies are routed to failover recovery here.
 */
async function evalKeyvRedisScript(script: string, options: RedisEvalOptions): Promise<unknown> {
  await waitForKeyvRedisClient();
  if (!keyvRedisClient) {
    throw new Error('Keyv Redis client is not configured');
  }
  try {
    return await runKeyvRedisScript(keyvRedisClient, script, options);
  } catch (error) {
    handleKeyvRedisError(error);
    throw error;
  }
}

if (cacheConfig.USE_REDIS) {
  /**
   * ** WARNING ** Keyv Redis client does not support Prefix like ioredis above.
   * The prefix feature will be handled by the Keyv-Redis store in cacheFactory.js
   */
  const redisOptions: Record<string, unknown> = {
    username,
    password,
    socket: {
      ...(isRedisCluster ? { tls: useTls } : {}),
      ...(ca ? { ca } : {}),
      connectTimeout: cacheConfig.REDIS_CONNECT_TIMEOUT,
      reconnectStrategy: (retries: number) => {
        if (
          cacheConfig.REDIS_RETRY_MAX_ATTEMPTS > 0 &&
          retries > cacheConfig.REDIS_RETRY_MAX_ATTEMPTS
        ) {
          logger.error(
            `@keyv/redis client giving up after ${cacheConfig.REDIS_RETRY_MAX_ATTEMPTS} reconnection attempts`,
          );
          return new Error('Max reconnection attempts reached');
        }
        const base = Math.min(Math.pow(2, retries) * 100, cacheConfig.REDIS_RETRY_MAX_DELAY);
        const jitter = Math.floor(Math.random() * Math.min(base, 1000));
        const delay = Math.min(base + jitter, cacheConfig.REDIS_RETRY_MAX_DELAY);
        logger.info(`@keyv/redis reconnecting... attempt ${retries}, delay ${delay}ms`);
        return delay;
      },
    },
    disableOfflineQueue: !cacheConfig.REDIS_ENABLE_OFFLINE_QUEUE,
    ...(cacheConfig.REDIS_PING_INTERVAL > 0
      ? { pingInterval: cacheConfig.REDIS_PING_INTERVAL * 1000 }
      : {}),
  };

  const selectedClient = (() => {
    if (sentinel) {
      return withSentinelScan(
        createSentinel({
          name: sentinel.name,
          sentinelRootNodes: sentinel.endpoints,
          replicaPoolSize: 0,
          nodeClientOptions: {
            username: sentinel.username,
            password: sentinel.password,
            socket: {
              tls: true,
              ca: ca ?? undefined,
              rejectUnauthorized: true,
              connectTimeout: cacheConfig.REDIS_CONNECT_TIMEOUT,
            },
            disableOfflineQueue: true,
          },
          sentinelClientOptions: {
            username: sentinel.sentinelUsername,
            password: sentinel.sentinelPassword,
            socket: {
              tls: true,
              ca: cacheConfig.REDIS_SENTINEL_CA ?? undefined,
              rejectUnauthorized: true,
              connectTimeout: cacheConfig.REDIS_CONNECT_TIMEOUT,
            },
            disableOfflineQueue: true,
          },
        }),
      );
    }
    if (!isRedisCluster) {
      return createClient({ url: cacheConfig.REDIS_URI, ...redisOptions });
    }
    return createCluster({
      rootNodes: urls.map((url) => ({ url: url.href })),
      defaults: redisOptions,
    });
  })();

  if ('masters' in selectedClient) {
    keyvRedisClient = Object.assign(selectedClient, {
      async *scanIterator(options?: ScanOptions) {
        for (const master of selectedClient.masters) {
          const node = await selectedClient.nodeClient(master);
          yield* node.scanIterator(options);
        }
      },
    });
  } else if ('getSentinelNode' in selectedClient) {
    keyvRedisClient = selectedClient;
  } else {
    const scan = selectedClient.scanIterator;
    keyvRedisClient = Object.assign(selectedClient, {
      scanIterator: (options?: ScanOptions) => scan.call(selectedClient, options),
    });
  }

  keyvRedisClient.setMaxListeners(cacheConfig.REDIS_MAX_LISTENERS);

  if (!('masters' in keyvRedisClient)) {
    recoverKeyvRedisClient = createReadonlyRecovery({
      client: keyvRedisClient,
      minIntervalMs: cacheConfig.REDIS_READONLY_RECOVERY_INTERVAL,
    });
  }

  keyvRedisClient.on('error', (err) => {
    logger.error('@keyv/redis client error:', err);
  });

  keyvRedisClient.on('connect', () => {
    logger.info('@keyv/redis client connected');
  });

  keyvRedisClient.on('ready', () => {
    logger.info('@keyv/redis client ready');
  });

  keyvRedisClient.on('reconnecting', () => {
    logger.info('@keyv/redis client reconnecting...');
  });

  keyvRedisClient.on('disconnect', () => {
    logger.warn('@keyv/redis client disconnected');
  });

  // Start connection immediately and settle the gate created before client initialization.
  void keyvRedisClient.connect().then(resolveKeyvRedisClientReady, rejectKeyvRedisClientReady);

  void keyvRedisClientReady?.catch((err): void => {
    logger.error('@keyv/redis initial connection failed:', err);
  });
}

export {
  ioredisClient,
  keyvRedisClient,
  keyvRedisClientReady,
  waitForInitialIoRedisReady,
  waitForKeyvRedisClient,
  waitForRedisStartup,
  evalKeyvRedisScript,
  handleKeyvRedisError,
};
