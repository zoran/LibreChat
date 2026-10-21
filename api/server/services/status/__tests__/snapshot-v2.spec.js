/** @jest-environment node */
// Rolling readers share no v1 cache state; classification freshness uses the real v2 validator.
const {
  readStatusSnapshot,
  encodeStatusSnapshot,
  STATUS_METRICS,
} = require('librechat-data-provider');
const fixture = require('../../../../../packages/data-provider/src/status-fixtures/representative.json');
const { createProjector } = require('../projection');
const { createStatusCache, CLAIM, PUBLISH, RELEASE } = require('../cache');

it('ages inventory classifications without inventing observed placement or health', () => {
  const projector = createProjector({ readStatusSnapshot, encodeStatusSnapshot, STATUS_METRICS });
  const aged = projector.age(readStatusSnapshot(fixture), fixture.generatedAt + 86401);
  expect(readStatusSnapshot(encodeStatusSnapshot(aged))).not.toBeNull();
  expect(
    aged.nodes.filter((n) => n.classification).every((n) => n.classification.state === 'stale'),
  ).toBe(true);
  expect(aged.nodes.find((n) => n.id === 'physical:host:control-a').assessments[0].state).toBe(
    'unknown',
  );
  expect(aged.edges.filter((e) => e.kind === 'placement').every((e) => e.basis === 'desired')).toBe(
    true,
  );
  expect(() => projector.age({ ...fixture, version: 1 }, fixture.generatedAt)).toThrow(
    'STATUS_DTO_INVALID',
  );
});

it('isolates all three cache keys while preserving an old reader snapshot', async () => {
  const oldBody = JSON.stringify({
    ok: true,
    value: { ...fixture, version: 1 },
    validUntilMs: null,
  });
  const redis = new Map([['{cortex-status-v1}:snapshot', oldBody]]);
  const commands = [];
  const client = {
    status: 'ready',
    options: { enableOfflineQueue: false, autoResendUnfulfilledCommands: false },
    eval: async (script, keyCount, snapshotKey, leaseKey, waitersKey, _token, envelope) => {
      commands.push({ keyCount, keys: [snapshotKey, leaseKey, waitersKey] });
      if (script === CLAIM)
        return redis.has(snapshotKey) ? ['cached', redis.get(snapshotKey)] : ['leader'];
      if (script === PUBLISH) {
        redis.set(snapshotKey, envelope);
        return 1;
      }
      if (script === RELEASE) return 1;
      throw new Error('Unexpected Redis script');
    },
  };
  const load = jest.fn(async () => JSON.stringify(fixture));
  const snapshot = createStatusCache({ client, load });
  expect(readStatusSnapshot(JSON.parse((await snapshot()).body))).not.toBeNull();
  expect(readStatusSnapshot(JSON.parse((await snapshot()).body))).not.toBeNull();
  expect(load).toHaveBeenCalledTimes(1);
  expect(commands.length).toBeGreaterThanOrEqual(5);
  for (const command of commands) {
    expect(command.keyCount).toBe(3);
    expect(command.keys).toEqual([
      '{cortex-status-v3}:snapshot',
      '{cortex-status-v3}:lease',
      '{cortex-status-v3}:waiters',
    ]);
  }
  expect(redis.get('{cortex-status-v1}:snapshot')).toBe(oldBody);
});
