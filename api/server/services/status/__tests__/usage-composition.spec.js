/** @jest-environment node */
const dto = require('librechat-data-provider');
const fixture = require('../../../../../packages/data-provider/src/status-fixtures/representative.json');
const fullFixture = require('../../../../../e2e/presentation/status.full-usage.fixture.json');
const { createUsageRuntime, mergeStatusUsage } = require('../usage');
const { createStatusService } = require('../service');
const { createProjector } = require('../projection');
const { CLAIM, PUBLISH, RELEASE } = require('../cache');

const at = 1792504800000;
const policy = {
  configured: true,
  tenantId: 'tenant-a',
  policyVersion: 1,
  domains: ['example.org'],
  uploadSecurityPolicySha256: 'a'.repeat(64),
};
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const emptyWindow = (startMs, endMs) => ({
  startMs,
  endMs,
  activeUsers: null,
  publishedDocuments: null,
  complete: false,
  gap: 'not_instrumented',
});
function setup({ asOfMs = at, monotonic, shutdownSignal } = {}) {
  const boundary = Math.floor(asOfMs / 3600000) * 3600000;
  const current = {
    readCurrentAccounts: jest.fn(async () => ({
      value: 0,
      asOfMs,
      queryCompleted: true,
      gap: null,
    })),
    readCurrentOriginalDocuments: jest.fn(async () => ({
      value: 0,
      asOfMs,
      queryCompleted: true,
      gap: null,
    })),
  };
  const store = {
    initialize: jest.fn(async () => {}),
    readTrailingHour: jest.fn(async () => emptyWindow(asOfMs - 3600000, asOfMs)),
    readCompletedHours: jest.fn(async () =>
      Array.from({ length: 168 }, (_, i) =>
        emptyWindow(boundary - (168 - i) * 3600000, boundary - (167 - i) * 3600000),
      ),
    ),
  };
  const createCurrent = jest.fn(() => current);
  const createStore = jest.fn(() => store);
  const runtime = createUsageRuntime({
    mongoose: {},
    policy,
    shutdownSignal,
    createCurrent,
    createStore,
    monotonic,
  });
  return { runtime, current, store, createCurrent, createStore };
}
function snapshot(now = at / 1000) {
  return createProjector(dto).age(dto.readStatusSnapshot(fixture), now);
}
const roundTrip = (value) => dto.readStatusSnapshot(dto.encodeStatusSnapshot(value));

test('configured ports initialize once and exact zero requires completed query evidence', async () => {
  const { runtime, current, store, createStore } = setup();
  expect((await runtime.read({ asOfMs: at })).source).toBeNull();
  await runtime.initialize();
  const result = await runtime.read({ asOfMs: at });
  expect(createStore).toHaveBeenCalledWith(
    {},
    {
      scopeId: 'cortex.application.usage.v1',
      tenantId: 'tenant-a',
    },
  );
  expect(store.initialize).toHaveBeenCalledTimes(1);
  for (const port of [
    current.readCurrentAccounts,
    current.readCurrentOriginalDocuments,
    store.readTrailingHour,
    store.readCompletedHours,
  ])
    expect(port).toHaveBeenCalledWith(at);
  expect(result.usage.current.grants).toMatchObject({
    quality: 'complete',
    values: { signedInUsers: 0 },
    coverage: { expected: 1, observed: 1, basis: 'query_partitions' },
  });
  expect(result.usage.current.presence.values.concurrentUsers).toBeNull();
  expect(result.usage.lastHour.groups.users.values.active).toBeNull();
  const value = snapshot();
  expect(mergeStatusUsage(value, result, at)).toBe(at / 1000 + 90);
  expect(roundTrip(value)).not.toBeNull();
  expect(value.sources.at(-1)).toEqual({
    id: 'application-usage',
    kind: 'application_usage',
    observerId: 'cortex-application',
    capturedAt: at / 1000,
  });
  expect(result.usage.history.rows).toHaveLength(168);
  expect(
    result.usage.history.rows.every((row) =>
      Object.values(row.groups).every((group) =>
        Object.values(group.values).every((v) => v === null),
      ),
    ),
  ).toBe(true);
  await runtime.close();
});

test('observed history stays partial with uncovered concurrency, tokens and retained boundaries', async () => {
  const { runtime, store } = setup();
  store.readTrailingHour.mockResolvedValue({
    ...emptyWindow(at - 3600000, at),
    activeUsers: 2,
    publishedDocuments: 3,
  });
  const rows = await store.readCompletedHours();
  rows[167] = { ...rows[167], activeUsers: 4, publishedDocuments: 5 };
  store.readCompletedHours.mockResolvedValue(rows);
  await runtime.initialize();
  const result = await runtime.read({ asOfMs: at });
  expect(result.usage.lastHour.groups.users).toMatchObject({
    quality: 'partial',
    values: { active: 2, concurrentMeanMicros: null, concurrentPeak: null },
    coverage: { expected: 3600, observed: 0, basis: 'scheduled_seconds' },
  });
  expect(result.usage.history.rows[167].groups.documents).toMatchObject({
    quality: 'partial',
    values: { published: 5, retainedEnd: null },
  });
  expect(result.usage.lastHour.groups.tokens.quality).toBe('unknown');
  expect(result.usage.lastHour.groups.latency.quality).toBe('unknown');
  expect(result.usage.lastHour.groups.valuation.quality).toBe('unknown');
  const value = snapshot();
  mergeStatusUsage(value, result, at);
  expect(roundTrip(value)).not.toBeNull();
  await runtime.close();
});

test.each(['purged_activity', 'owner_conflict', 'capacity', 'producer_gap', 'query_timeout'])(
  '%s cannot advertise the affected active-user subtotal as exact',
  async (gap) => {
    const { runtime, store } = setup();
    store.readTrailingHour.mockResolvedValue({
      ...emptyWindow(at - 3600000, at),
      activeUsers: 8,
      publishedDocuments: 9,
      gap,
    });
    await runtime.initialize();
    const result = await runtime.read({ asOfMs: at });
    expect(result.usage.lastHour.groups.users.values.active).toBeNull();
    expect(result.usage.lastHour.groups.users.quality).toBe('unknown');
    await runtime.close();
  },
);

test('failed, late and mismatched proofs remain unknown without invented zero', async () => {
  const { runtime, current } = setup();
  current.readCurrentAccounts.mockResolvedValue({
    value: 0,
    asOfMs: at,
    queryCompleted: false,
    gap: 'query_timeout',
  });
  current.readCurrentOriginalDocuments.mockResolvedValue({
    value: 1,
    asOfMs: at - 1000,
    queryCompleted: true,
    gap: null,
  });
  await runtime.initialize();
  const result = await runtime.read({ asOfMs: at });
  expect(result.source).toBeNull();
  expect(result.usage.current.grants.values.signedInUsers).toBeNull();
  await runtime.close();
  const late = setup({ monotonic: jest.fn().mockReturnValueOnce(0).mockReturnValueOnce(4000) });
  await late.runtime.initialize();
  expect((await late.runtime.read({ asOfMs: at })).source).toBeNull();
  await late.runtime.close();
});

test('abort and early port rejection retain all original reads until shutdown drains them', async () => {
  const { runtime, current, store } = setup();
  const pending = deferred();
  const controller = new AbortController();
  current.readCurrentAccounts.mockRejectedValue(Error('query unavailable'));
  current.readCurrentOriginalDocuments.mockReturnValue(pending.promise);
  await runtime.initialize();
  const first = runtime.read({ asOfMs: at, signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  expect((await runtime.read({ asOfMs: at })).source).toBeNull();
  let closed = false;
  const closing = runtime.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(store.readCompletedHours).toHaveBeenCalledTimes(1);
  pending.resolve({ value: 7, asOfMs: at, queryCompleted: true, gap: null });
  expect((await first).source).toBeNull();
  await closing;
  expect(closed).toBe(true);
  expect((await runtime.read({ asOfMs: at })).source).toBeNull();
  expect(current.readCurrentOriginalDocuments).toHaveBeenCalledTimes(1);
});

test('shutdown signal stops new admission and discards an already pending result', async () => {
  const shutdown = new AbortController();
  const { runtime, current } = setup({ shutdownSignal: shutdown.signal });
  const pending = deferred();
  current.readCurrentAccounts.mockReturnValue(pending.promise);
  await runtime.initialize();
  const first = runtime.read({ asOfMs: at });
  shutdown.abort();
  expect((await runtime.read({ asOfMs: at })).source).toBeNull();
  pending.resolve({ value: 1, asOfMs: at, queryCompleted: true, gap: null });
  expect((await first).source).toBeNull();
  await runtime.close();
});

test('source saturation preserves the complete topology and bounds the actual compact fixture', async () => {
  const { runtime } = setup({ asOfMs: fullFixture.generatedAt * 1000 });
  await runtime.initialize();
  const result = await runtime.read({ asOfMs: fullFixture.generatedAt * 1000 });
  const value = dto.readStatusSnapshot(fullFixture);
  const sources = JSON.stringify(value.sources);
  expect(value.sources).toHaveLength(16);
  expect(mergeStatusUsage(value, result, fullFixture.generatedAt * 1000)).toBeNull();
  expect(JSON.stringify(value.sources)).toBe(sources);
  expect(value.usage.current.grants.values.signedInUsers).toBeNull();
  const wire = dto.encodeStatusSnapshot(value);
  expect(dto.readStatusSnapshot(wire)).not.toBeNull();
  expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThanOrEqual(512 * 1024);
  await runtime.close();
});

test('one Redis leader joins usage and reuses the bounded cache with the actual DTO', async () => {
  const asOfMs = Math.floor(Date.now() / 1000) * 1000;
  const { runtime, current } = setup({ asOfMs });
  await runtime.initialize();
  const seed = dto.readStatusSnapshot(fixture);
  seed.selectedObserverId = null;
  seed.sources = seed.sources.filter((source) => source.kind !== 'prometheus');
  for (const measurement of seed.measurements)
    Object.assign(measurement, {
      state: 'unknown',
      reason: 'not_measured',
      value: null,
      selectedSourceId: null,
      samples: [],
    });
  const topology = dto.encodeStatusSnapshot(seed);
  expect(dto.readStatusSnapshot(topology)).not.toBeNull();
  let cached;
  const client = {
    status: 'ready',
    options: { enableOfflineQueue: false, autoResendUnfulfilledCommands: false },
    eval: async (script, _count, _snapshot, _lease, _waiters, _token, envelope) => {
      if (script === CLAIM) return cached ? ['cached', cached] : ['leader'];
      if (script === PUBLISH) {
        cached = envelope;
        return 1;
      }
      if (script === RELEASE) return 1;
      throw Error('Unexpected Redis script');
    },
  };
  const readUsage = jest.fn((input) => runtime.read(input));
  const observe = jest.fn(async () => null);
  const service = createStatusService({
    ...dto,
    client,
    readUsage,
    observe,
    env: {
      CORTEX_STATUS_ENABLED: 'true',
      CORTEX_STATUS_OBSERVERS_JSON: JSON.stringify(
        [2, 3].map((n) => ({
          id: `lx-s-bwi-cpu-${n}`,
          host: `192.0.2.${n}`,
          servername: `lx-s-bwi-cpu-${n}`,
        })),
      ),
    },
    readFile: async (path) =>
      Buffer.from(path.endsWith('topology.json') ? JSON.stringify(topology) : 'test-only material'),
    now: () => asOfMs / 1000,
  });
  for (let i = 0; i < 2; i++) {
    const response = await service();
    expect(response.validUntilMs).toBe(asOfMs + 90000);
    const decoded = dto.readStatusSnapshot(JSON.parse(response.body));
    expect(decoded.usage.current.grants.values.signedInUsers).toBe(0);
    expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(512 * 1024);
  }
  expect(readUsage).toHaveBeenCalledTimes(1);
  expect(current.readCurrentAccounts).toHaveBeenCalledTimes(1);
  expect(observe).toHaveBeenCalledTimes(2);
  await runtime.close();
});

test('startup selects public policy fields, awaits initialization and registers the existing drain owner', async () => {
  let initializeStatusUsage;
  let readStatusUsage;
  jest.isolateModules(() => {
    ({ initializeStatusUsage, readStatusUsage } = require('../usage'));
  });
  const initialized = deferred();
  const runtime = {
    initialize: jest.fn(() => initialized.promise),
    read: jest.fn(async () => ({ marker: 'configured read' })),
    close: jest.fn(async () => {}),
  };
  const secret = jest.fn(() => {
    throw Error('Secret must not be accessed');
  });
  const settings = { ...policy, qualification: undefined };
  Object.defineProperty(settings, 'secret', { get: secret, enumerable: true });
  const owners = {
    getAuthMode: () => 'email_code',
    getEmailCodeSettings: () => settings,
    getShutdownSignal: () => new AbortController().signal,
    registerShutdownTask: jest.fn(),
  };
  const createRuntime = jest.fn(() => runtime);
  const start = initializeStatusUsage({
    mongoose: {},
    identity: { incarnation: '52345678-1234-4234-8234-123456789012' },
    owners,
    createRuntime,
    env: {
      CORTEX_STATUS_ENABLED: 'true',
      UPLOAD_SECURITY_POLICY_SHA256: policy.uploadSecurityPolicySha256,
    },
  });
  expect((await readStatusUsage({ asOfMs: at })).source).toBeNull();
  initialized.resolve();
  expect(await start).toBe(runtime);
  expect(secret).not.toHaveBeenCalled();
  expect(createRuntime.mock.calls[0][0].policy).toEqual({
    ...policy,
    qualification: undefined,
  });
  expect(owners.registerShutdownTask).toHaveBeenCalledWith(
    'application usage reads',
    expect.any(Function),
    { phase: 'pre-drain', priority: 110 },
  );
  await owners.registerShutdownTask.mock.calls[0][1]();
  expect(runtime.close).toHaveBeenCalledTimes(1);
});

test.each(['disabled', 'default', 'unconfigured', 'missing policy'])(
  'startup remains unknown for %s and does not construct database ports',
  async (mode) => {
    let initializeStatusUsage;
    jest.isolateModules(() => {
      ({ initializeStatusUsage } = require('../usage'));
    });
    const createRuntime = jest.fn();
    const owners = {
      getAuthMode: () => (mode === 'default' ? 'default' : 'email_code'),
      getEmailCodeSettings: () => ({ ...policy, configured: mode !== 'unconfigured' }),
    };
    expect(
      await initializeStatusUsage({
        mongoose: {},
        owners,
        createRuntime,
        env: {
          CORTEX_STATUS_ENABLED: mode === 'disabled' ? 'false' : 'true',
          UPLOAD_SECURITY_POLICY_SHA256:
            mode === 'missing policy' ? undefined : policy.uploadSecurityPolicySha256,
        },
      }),
    ).toBeNull();
    expect(createRuntime).not.toHaveBeenCalled();
  },
);

test('publication bridge retains trusted scope and remains open through upload drain', async () => {
  const { runtime, store } = setup();
  store.recordOriginalPublication = jest.fn(async () => 'capacity');
  await runtime.initialize();
  const session = { marker: 'existing upload transaction' };
  const input = { tenantId: policy.tenantId, operationId: 'original', publishedAtMs: at };
  await runtime.close();
  await expect(runtime.recordOriginalPublication(input, session)).resolves.toBeUndefined();
  expect(store.recordOriginalPublication).toHaveBeenCalledWith(input, session);
  await expect(
    runtime.recordOriginalPublication({ ...input, tenantId: 'other' }, session),
  ).resolves.toBeUndefined();
  await expect(
    runtime.recordOriginalPublication({ ...input, tenantId: null }, session),
  ).resolves.toBeUndefined();
  expect(store.recordOriginalPublication).toHaveBeenCalledTimes(1);
  store.recordOriginalPublication.mockRejectedValueOnce(Error('database failure'));
  await expect(runtime.recordOriginalPublication(input, session)).rejects.toThrow(
    'database failure',
  );
});

test('retention collector owns one pending original and shutdown waits for settlement', async () => {
  const pending = deferred();
  const callbacks = [];
  const store = {
    initialize: jest.fn(async () => {}),
    acquireCollector: jest.fn(async (ownerId) => ({ ownerId, epoch: 7 })),
    advanceRetention: jest.fn(() => pending.promise),
  };
  const schedule = jest.fn((fn) => {
    callbacks.push(fn);
    return 1;
  });
  const cancel = jest.fn();
  const runtime = createUsageRuntime({
    mongoose: {},
    policy,
    collectorId: '52345678-1234-4234-8234-123456789012',
    createStore: () => store,
    createCurrent: () => ({}),
    schedule,
    cancel,
  });
  await runtime.initialize();
  await Promise.resolve();
  expect(store.advanceRetention).toHaveBeenCalledWith({
    ownerId: '52345678-1234-4234-8234-123456789012',
    epoch: 7,
  });
  expect(schedule).not.toHaveBeenCalled();
  let closed = false;
  const close = runtime.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  pending.resolve();
  await close;
  expect(schedule).not.toHaveBeenCalled();
  expect(store.acquireCollector).toHaveBeenCalledTimes(1);
});

test('retention collector renews after settlement and never uses another owner or lost epoch', async () => {
  const callbacks = [];
  const store = {
    initialize: async () => {},
    acquireCollector: jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ownerId: 'instance-a', epoch: 8 }),
    advanceRetention: jest.fn().mockRejectedValueOnce(Error('STATUS_USAGE_FENCE')),
  };
  const schedule = jest.fn((fn) => {
    callbacks.push(fn);
    return 1;
  });
  const cancel = jest.fn();
  const runtime = createUsageRuntime({
    mongoose: {},
    policy,
    collectorId: 'instance-a',
    createStore: () => store,
    createCurrent: () => ({}),
    schedule,
    cancel,
  });
  await runtime.initialize();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  expect(store.advanceRetention).not.toHaveBeenCalled();
  expect(schedule).toHaveBeenLastCalledWith(expect.any(Function), 30000);
  callbacks.shift()();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(store.advanceRetention).toHaveBeenCalledTimes(1);
  expect(schedule).toHaveBeenCalledTimes(2);
  await runtime.close();
  expect(cancel).toHaveBeenCalledWith(1);
});
