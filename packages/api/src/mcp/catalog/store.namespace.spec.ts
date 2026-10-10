import calculateSlot from 'cluster-key-slot';
import { createMCPCatalogStore } from './store';

describe('catalog ownership fence namespace', () => {
  it.each(['deployment', 'deployment:{shared}', ''])(
    'keeps global and user fencing inside deployment %j and in the data slot',
    async (prefix) => {
      const physicalPrefix = prefix ? `${prefix}::` : '';
      const commands: string[][] = [];
      const store = createMCPCatalogStore({
        cacheConfig: { REDIS_KEY_PREFIX: prefix, GLOBAL_PREFIX_SEPARATOR: '::' },
        getCache: () => ({
          get: async () => undefined,
          set: async () => true,
          delete: async () => true,
        }),
        ioredisClient: {
          set: async () => 'OK',
          eval: async () => 1,
        },
        keyvRedisClient: {
          eval: async (_script, { keys }) => {
            if (keys.some((key) => !key.startsWith(physicalPrefix))) {
              throw new Error('NOPERM No permissions to access a key');
            }
            if (keys.length > 1) {
              expect(new Set(keys.map(calculateSlot)).size).toBe(1);
            }
            commands.push(keys);
            return 1;
          },
        },
      });

      await expect(store.setCachedTools({})).resolves.toBe(true);
      await expect(
        store.invalidateCachedTools({ invalidateGlobal: true }),
      ).resolves.toBeUndefined();
      await expect(
        store.getMCPToolsCacheGeneration({ userId: 'user', serverName: 'server' }),
      ).resolves.toEqual(expect.any(String));
      const mutations = commands.filter((keys) => keys.length > 1);
      expect(mutations).toHaveLength(3);
      for (const [fence, data] of mutations) {
        expect(fence).toContain('write-fence:');
        expect(calculateSlot(fence)).toBe(calculateSlot(data));
      }
    },
  );
});
