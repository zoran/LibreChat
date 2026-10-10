import { EventEmitter } from 'events';
const makeClient = () =>
  Object.assign(new EventEmitter(), {
    connect: jest.fn().mockResolvedValue(undefined),
    isReady: true,
    isOpen: true,
    destroy: jest.fn().mockResolvedValue(undefined),
    acquire: jest.fn(),
  });
const mockNodeClient = makeClient();
const mockIoClient = Object.assign(makeClient(), { status: 'ready', duplicate: jest.fn() });
jest.mock('@keyv/redis', () => ({
  createSentinel: jest.fn(() => mockNodeClient),
  createClient: jest.fn(),
  createCluster: jest.fn(),
}));
jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn(() => mockIoClient) }));
jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../cacheConfig', () => ({
  cacheConfig: {
    USE_REDIS: true,
    USE_REDIS_STREAMS: true,
    REDIS_CA: 'data-ca',
    REDIS_SENTINEL_CA: 'sentinel-ca',
    REDIS_KEY_PREFIX: 'app',
    GLOBAL_PREFIX_SEPARATOR: '::',
    REDIS_MAX_LISTENERS: 40,
    REDIS_CONNECT_TIMEOUT: 1000,
    REDIS_PING_INTERVAL: 0,
    REDIS_SUBSCRIBER_PING_INTERVAL: 0,
    REDIS_READONLY_RECOVERY_INTERVAL: 0,
    SHARED_STATE: {
      mode: 'sentinel',
      endpoints: [{ host: 'sentinel.test', port: 26379 }],
      name: 'app',
      username: 'data',
      password: 'data-password',
      sentinelUsername: 'discovery',
      sentinelPassword: 'discovery-password',
    },
  },
}));
import IoRedis from 'ioredis';
import { createSentinel, createCluster } from '@keyv/redis';
const { keyvRedisClient, withSentinelScan, handleKeyvRedisError } =
  jest.requireActual<typeof import('../redisClients')>('../redisClients');
describe('native Sentinel adapters', () => {
  it('uses distinct verified TLS/auth and primary-only reads without Cluster reinterpretation', () => {
    expect(createCluster).not.toHaveBeenCalled();
    expect(createSentinel).toHaveBeenCalledWith(
      expect.objectContaining({
        replicaPoolSize: 0,
        nodeClientOptions: expect.objectContaining({
          username: 'data',
          disableOfflineQueue: true,
          socket: expect.objectContaining({ tls: true, ca: 'data-ca', rejectUnauthorized: true }),
        }),
        sentinelClientOptions: expect.objectContaining({
          username: 'discovery',
          socket: expect.objectContaining({
            tls: true,
            ca: 'sentinel-ca',
            rejectUnauthorized: true,
          }),
        }),
      }),
    );
    expect(IoRedis).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'master',
        enableTLSForSentinelMode: true,
        sentinelUsername: 'discovery',
        tls: { ca: 'data-ca', rejectUnauthorized: true },
        sentinelTLS: { ca: 'sentinel-ca', rejectUnauthorized: true },
        autoResendUnfulfilledCommands: false,
      }),
    );
    expect(keyvRedisClient).toBe(mockNodeClient);
  });
  it('leases one primary for cursor scan and releases on caller cancellation', async () => {
    const primary = {
      scan: jest.fn().mockResolvedValue({ cursor: '4', keys: ['a'] }),
      release: jest.fn(),
    };
    mockNodeClient.acquire.mockResolvedValue(primary);
    // The mock is constructed to the adapter port; production typing uses real Sentinel API.
    const iterator = withSentinelScan(mockNodeClient as never).scanIterator();
    expect(await iterator.next()).toEqual({ value: ['a'], done: false });
    await iterator.return(undefined);
    expect(primary.release).toHaveBeenCalledTimes(1);
  });
  it('awaits async destroy before Sentinel rediscovery', async () => {
    mockNodeClient.connect.mockClear();
    let finish!: () => void;
    mockNodeClient.destroy.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    expect(handleKeyvRedisError(new Error('READONLY primary changed'))).toBe(true);
    expect(mockNodeClient.connect).not.toHaveBeenCalled();
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockNodeClient.connect).toHaveBeenCalledTimes(1);
  });
});

jest.mock('../../stream/implementations/InMemoryEventTransport', () => ({
  InMemoryEventTransport: jest.fn(),
}));
jest.mock('../../stream/implementations/InMemoryJobStore', () => ({ InMemoryJobStore: jest.fn() }));
jest.mock('../../stream/implementations/RedisEventTransport', () => ({
  RedisEventTransport: jest.fn(),
}));
jest.mock('../../stream/implementations/RedisJobStore', () => ({
  RedisJobStore: jest.fn(() => {
    throw new Error('store initialization failed');
  }),
}));
const { createStreamServices } = jest.requireActual<
  typeof import('../../stream/createStreamServices')
>('../../stream/createStreamServices');
import { InMemoryJobStore } from '../../stream/implementations/InMemoryJobStore';
it('does not fall back to memory on selected construction failure or explicit local override', () => {
  expect(() => createStreamServices({ useRedis: false })).toThrow(
    'Shared-state stream client unavailable',
  );
  expect(() => createStreamServices({ redisSubscriber: mockIoClient as never })).toThrow(
    'store initialization failed',
  );
  expect(InMemoryJobStore).not.toHaveBeenCalled();
});

it('disconnects only its own duplicated subscriber when construction fails', () => {
  const subscriber = Object.assign(new EventEmitter(), { disconnect: jest.fn() });
  mockIoClient.duplicate.mockReturnValueOnce(subscriber);
  expect(() => createStreamServices()).toThrow('store initialization failed');
  expect(subscriber.disconnect).toHaveBeenCalledTimes(1);
});
