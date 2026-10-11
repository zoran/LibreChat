import { EventEmitter } from 'events';
import type { RedisStore } from 'rate-limit-redis';

const makeIoClient = () => {
  const { Command } = jest.requireActual<typeof import('ioredis')>('ioredis');
  const client = Object.assign(new EventEmitter(), {
    status: 'connecting',
    keyPrefix: '',
    commands: [] as InstanceType<typeof Command>[],
    call: jest.fn(async (command: string, ...args: string[]) => {
      if (client.status !== 'ready') {
        throw new Error("Stream isn't writeable and enableOfflineQueue options is false");
      }
      client.commands.push(new Command(command, args, { keyPrefix: client.keyPrefix }));
      return command.toLowerCase() === 'script' ? 'loaded-script-sha' : [1, 60_000];
    }),
  });
  return client;
};
let mockIoClient = makeIoClient();
const mockNodeClient = Object.assign(new EventEmitter(), {
  connect: jest.fn().mockResolvedValue(undefined),
  destroy: jest.fn().mockResolvedValue(undefined),
  isReady: true,
  isOpen: true,
});
jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn((options: { keyPrefix?: string }) => {
    mockIoClient.keyPrefix = options.keyPrefix ?? '';
    return mockIoClient;
  }),
}));
jest.mock('@keyv/redis', () => ({ createSentinel: jest.fn(() => mockNodeClient) }));
jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../cacheConfig', () => ({
  cacheConfig: {
    USE_REDIS: true,
    REDIS_CA: 'data-ca',
    REDIS_SENTINEL_CA: 'sentinel-ca',
    REDIS_KEY_PREFIX: 'test',
    GLOBAL_PREFIX_SEPARATOR: '::',
    REDIS_MAX_LISTENERS: 40,
    REDIS_CONNECT_TIMEOUT: 1000,
    REDIS_PING_INTERVAL: 0,
    REDIS_READONLY_RECOVERY_INTERVAL: 0,
    SHARED_STATE: {
      mode: 'sentinel',
      endpoints: [{ host: 'sentinel.test', port: 26379 }],
      name: 'test',
      username: 'app',
      password: 'test-data',
      sentinelUsername: 'app',
      sentinelPassword: 'test-sentinel',
    },
  },
}));

/** The real limiter constructor starts both Lua loads while its transport is still connecting. */
describe('Sentinel limiter startup', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    mockIoClient = makeIoClient();
    mockNodeClient.removeAllListeners();
  });

  afterEach(() => {
    mockIoClient.emit('end');
    jest.useRealTimers();
  });

  it('defers real constructor scripts until initial readiness and preserves later offline rejection', async () => {
    const { limiterCache } = await import('../cacheFactory');
    const store = limiterCache('startup')!;
    store.init({ windowMs: 60_000 } as Parameters<RedisStore['init']>[0]);
    const scripts = Promise.allSettled([store.incrementScriptSha, store.getScriptSha]);
    try {
      await Promise.resolve();
      expect(mockIoClient.call).not.toHaveBeenCalled();
    } finally {
      mockIoClient.status = 'ready';
      mockIoClient.emit('ready');
      await scripts;
    }
    expect(await scripts).toEqual([
      { status: 'fulfilled', value: 'loaded-script-sha' },
      { status: 'fulfilled', value: 'loaded-script-sha' },
    ]);
    expect((await store.get('user'))?.totalHits).toBe(1);
    expect((await store.increment('user')).totalHits).toBe(1);
    mockIoClient.status = 'reconnecting';
    await expect(store.sendCommand('SET', 'owned-key', 'value')).rejects.toThrow(
      'enableOfflineQueue',
    );
    const calls = mockIoClient.call.mock.calls.length;
    mockIoClient.status = 'ready';
    mockIoClient.emit('ready');
    await Promise.resolve();
    expect(mockIoClient.call).toHaveBeenCalledTimes(calls);
  });

  it.each(['timeout', 'end'])(
    'settles initial %s without sending or later replaying scripts',
    async (failure) => {
      const { limiterCache } = await import('../cacheFactory');
      const store = limiterCache('failed-startup')!;
      const scripts = Promise.allSettled([store.incrementScriptSha, store.getScriptSha]);
      if (failure === 'timeout') {
        await jest.advanceTimersByTimeAsync(1000);
      } else {
        mockIoClient.status = 'end';
        mockIoClient.emit('end');
      }
      expect((await scripts).map((result) => result.status)).toEqual(['rejected', 'rejected']);
      expect(mockIoClient.call).not.toHaveBeenCalled();
      expect(mockIoClient.listenerCount('end')).toBe(0);
      // The normal client logger keeps its ready listener; the initial waiter is gone.
      expect(mockIoClient.listenerCount('ready')).toBe(1);
      mockIoClient.status = 'ready';
      mockIoClient.emit('ready');
      await Promise.resolve();
      expect(mockIoClient.call).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['test', 'test::wire:user', 'test::test::wire:user'],
    ['', 'wire:user', '::wire:user'],
  ])(
    'serializes limiter keys once with deployment prefix "%s"',
    async (prefix, wireKey, extraPrefixKey) => {
      const { cacheConfig } = await import('../cacheConfig');
      cacheConfig.REDIS_KEY_PREFIX = prefix;
      const { limiterCache } = await import('../cacheFactory');
      const store = limiterCache('wire')!;
      store.init({ windowMs: 60_000 } as Parameters<RedisStore['init']>[0]);
      mockIoClient.status = 'ready';
      mockIoClient.emit('ready');
      await store.increment('user');
      await store.get('user');
      await store.decrement('user');
      await store.resetKey('user');
      const keyedCommands = mockIoClient.commands.filter(
        (command) => command.name.toLowerCase() !== 'script',
      );
      expect(keyedCommands).toHaveLength(4);
      for (const command of keyedCommands) {
        // Uppercase dynamic commands have no ioredis key metadata; inspect the actual RESP payload.
        const payload = command.toWritable({}).toString();
        expect(payload.split(`\r\n${wireKey}\r\n`)).toHaveLength(2);
        expect(payload).not.toContain(`\r\n${extraPrefixKey}\r\n`);
        if (prefix) expect(payload).not.toContain('\r\nwire:user\r\n');
      }
    },
  );

  it('does not wait again when the first limiter is created after an earlier successful connection', async () => {
    await import('../redisClients');
    mockIoClient.status = 'ready';
    mockIoClient.emit('ready');
    mockIoClient.status = 'reconnecting';
    const { limiterCache } = await import('../cacheFactory');
    const store = limiterCache('late-construction')!;
    const scripts = Promise.allSettled([store.incrementScriptSha, store.getScriptSha]);
    expect((await scripts).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(mockIoClient.call).toHaveBeenCalledTimes(2);
    expect(mockIoClient.listenerCount('end')).toBe(0);
  });
});
