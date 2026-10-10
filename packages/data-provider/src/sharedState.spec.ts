import { parseSharedState, sharedStateSchema } from './sharedState';
const env = {
  REDIS_CONNECTION_MODE: 'sentinel',
  USE_REDIS: 'true',
  REDIS_SENTINEL_ENDPOINTS: '[{"host":"sentinel.test","port":26379}]',
  REDIS_SENTINEL_NAME: 'app',
  REDIS_USERNAME: 'data',
  REDIS_PASSWORD: 'secret-data',
  REDIS_CA: '/data-ca',
  REDIS_SENTINEL_USERNAME: 'discovery',
  REDIS_SENTINEL_PASSWORD: 'secret-sentinel',
  REDIS_SENTINEL_CA: '/sentinel-ca',
};
describe('shared-state bootstrap contract', () => {
  it('preserves legacy mode and accepts one discovery seed independent of quorum', () => {
    expect(parseSharedState({})).toEqual({ mode: 'uri' });
    expect(parseSharedState(env)).toMatchObject({
      mode: 'sentinel',
      username: 'data',
      sentinelUsername: 'discovery',
    });
  });
  it.each([
    '[]',
    '[{"host":"bad/path","port":1}]',
    '[{"host":"x","port":0}]',
    '[{"host":"A","port":1},{"host":"a","port":1}]',
    JSON.stringify(Array.from({ length: 17 }, (_, i) => ({ host: `s${i}`, port: 1 }))),
  ])('rejects invalid endpoint list %s', (endpoints) => {
    expect(() => parseSharedState({ ...env, REDIS_SENTINEL_ENDPOINTS: endpoints })).toThrow(
      'Invalid shared-state',
    );
  });
  it.each([
    { REDIS_URI: 'redis://x' },
    { USE_REDIS_STREAMS: 'false' },
    { USE_REDIS: 'false' },
    { USE_REDIS_CLUSTER: 'true' },
    { REDIS_CA: '' },
    { REDIS_SENTINEL_PASSWORD: '' },
  ])('rejects ambiguous or incomplete selected mode', (overrides) => {
    expect(() => parseSharedState({ ...env, ...overrides })).toThrow('Invalid shared-state');
  });
  it('rejects extra endpoint options and does not disclose secrets', () => {
    expect(() => parseSharedState({ ...env, REDIS_SENTINEL_ENDPOINTS: 'secret-data' })).toThrow(
      /^Invalid shared-state transport configuration$/,
    );
    expect(sharedStateSchema.safeParse({ mode: 'uri', password: 'secret' }).success).toBe(false);
  });
});
