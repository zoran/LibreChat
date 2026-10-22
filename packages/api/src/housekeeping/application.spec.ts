/** Actual listener/runtime/maintenance composition; controlled owner probes assert lifecycle only. */
import http from 'node:http';
import type { DiscoveryPage, HousekeepingRepository } from '@librechat/data-schemas';
import type { HousekeepingApplication, HousekeepingApplicationDependencies } from './application';
import { createHousekeepingApplication } from './application';
import * as shutdownOwner from '../app/shutdown';
import * as metricsOwner from '../app/metrics';

const env = {
  POD_UID: '11111111-1111-4111-8111-111111111111',
  BUILD_COMMIT: 'a'.repeat(40),
  POD_NODE_NAME: 'lx-s-bwi-cpu-2',
  LIBRECHAT_MAINTENANCE_TOKEN: 'm'.repeat(32),
  LIBRECHAT_MAINTENANCE_PORT: '3091',
  METRICS_SECRET: 's'.repeat(32),
};
const later = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const unexpected = async (): Promise<never> => {
  throw new Error('Unexpected domain owner call');
};
function options(): HousekeepingApplicationDependencies & {
  repository: jest.Mocked<HousekeepingRepository>;
  close: jest.Mock<Promise<void>, [AbortSignal]>;
} {
  return {
    env: { ...env },
    repository: {
      discover: jest.fn<
        ReturnType<HousekeepingRepository['discover']>,
        Parameters<HousekeepingRepository['discover']>
      >(unexpected),
      claimNext: jest.fn<
        ReturnType<HousekeepingRepository['claimNext']>,
        Parameters<HousekeepingRepository['claimNext']>
      >(unexpected),
      renew: jest.fn<
        ReturnType<HousekeepingRepository['renew']>,
        Parameters<HousekeepingRepository['renew']>
      >(unexpected),
      inspect: jest.fn<
        ReturnType<HousekeepingRepository['inspect']>,
        Parameters<HousekeepingRepository['inspect']>
      >(unexpected),
      defer: jest.fn<
        ReturnType<HousekeepingRepository['defer']>,
        Parameters<HousekeepingRepository['defer']>
      >(unexpected),
      releaseUnstarted: jest.fn<
        ReturnType<HousekeepingRepository['releaseUnstarted']>,
        Parameters<HousekeepingRepository['releaseUnstarted']>
      >(unexpected),
      readStatus: jest.fn<
        ReturnType<HousekeepingRepository['readStatus']>,
        Parameters<HousekeepingRepository['readStatus']>
      >(unexpected),
    },
    fileNotice: { prepare: unexpected, authorizeHandoff: unexpected, recordOutcome: unexpected },
    fileCleanup: { step: unexpected },
    uploadCleanup: { step: unexpected },
    close: jest.fn<Promise<void>, [AbortSignal]>(async () => undefined),
  };
}
function request(port: number, path: string, token?: string, body?: unknown) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        agent: false,
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const applications: HousekeepingApplication[] = [];
const make = (deps = options()) => {
  const app = createHousekeepingApplication(deps);
  applications.push(app);
  return app;
};
beforeEach(() => {
  process.env.METRICS_SECRET = env.METRICS_SECRET;
  shutdownOwner.__resetShutdownStateForTests();
});
afterEach(async () => {
  for (const app of applications.splice(0)) await app.drain();
  shutdownOwner.__resetShutdownStateForTests();
  delete process.env.METRICS_SECRET;
  jest.restoreAllMocks();
});

it('holds before runtime admission and serves one authenticated unfiltered local observation', async () => {
  const actual = metricsOwner.createMetrics;
  const collect = jest.fn();
  jest.spyOn(metricsOwner, 'createMetrics').mockImplementation((input) =>
    actual({
      ...input,
      collectHousekeepingObservation: () => {
        collect();
        return input!.collectHousekeepingObservation!();
      },
    }),
  );
  const deps = options();
  const app = make(deps);
  expect(deps.repository.discover).not.toHaveBeenCalled();
  const start = app.start();
  expect(app.start()).toBe(start);
  expect(app.runtime.observe().admitting).toBe(false);
  await start;
  expect(await app.maintenance.status()).toMatchObject({
    requestId: app.startupHold.requestId,
    revision: 1,
    phase: 'drained',
  });
  for (const token of [undefined, 'wrong'])
    expect((await request(3080, '/metrics', token)).status).toBe(401);
  expect(collect).not.toHaveBeenCalled();
  const response = await request(3080, '/metrics', env.METRICS_SECRET);
  expect(response.status).toBe(200);
  expect(collect).toHaveBeenCalledTimes(1);
  expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(128 * 1024);
  expect(response.body).toContain('process_cpu_user_seconds_total');
  expect(response.body).toContain(`worker_pod_uid="${env.POD_UID}"`);
  expect(response.body).toContain(`worker_node="${env.POD_NODE_NAME}"`);
  expect(response.body).toContain(`source_revision="${env.BUILD_COMMIT}"`);
  expect(response.body).toContain(`incarnation="${app.identity.incarnation}"`);
  expect(new Set(response.body.match(/^cortex_housekeeping_[a-z_]+(?=\{)/gm))).toEqual(
    new Set([
      'cortex_housekeeping_instance_info',
      'cortex_housekeeping_admitting',
      'cortex_housekeeping_active_work_count',
      'cortex_housekeeping_observed_at_seconds',
    ]),
  );
  console.info(JSON.stringify({ housekeepingRawMetricsBytes: Buffer.byteLength(response.body) }));
  expect((await request(3080, '/health')).status).toBe(503);
  expect((await request(3080, '/metrics?extra=1', env.METRICS_SECRET)).status).toBe(404);
  expect((await request(3080, '/status', env.LIBRECHAT_MAINTENANCE_TOKEN)).status).toBe(404);
  const control = await request(3091, '/status', env.LIBRECHAT_MAINTENANCE_TOKEN);
  expect(control.status).toBe(200);
  expect(JSON.parse(control.body).identity).toEqual(app.startupHold.identity);
  expect(
    (
      await request(3091, '/cancel', env.LIBRECHAT_MAINTENANCE_TOKEN, {
        ...app.startupHold,
        expectedRevision: 0,
      })
    ).status,
  ).toBe(409);
  expect(collect).toHaveBeenCalledTimes(1);
  expect(Object.values(deps.repository).every((method) => method.mock.calls.length === 0)).toBe(
    true,
  );
});

it('retains the original discovery promise and observation listener throughout drain', async () => {
  const deps = options();
  const discovery = later<DiscoveryPage>();
  const entered = later<void>();
  deps.repository.discover.mockImplementation(() => {
    entered.resolve();
    return discovery.promise;
  });
  const app = make(deps);
  await app.start();
  expect(
    (
      await request(3091, '/cancel', env.LIBRECHAT_MAINTENANCE_TOKEN, {
        ...app.startupHold,
        expectedRevision: 1,
      })
    ).status,
  ).toBe(200);
  await entered.promise;
  expect((await request(3080, '/health')).status).toBe(200);
  const drain = app.drain();
  expect(app.drain()).toBe(drain);
  await flush();
  expect(deps.close).not.toHaveBeenCalled();
  expect((await request(3080, '/metrics', env.METRICS_SECRET)).body).toContain(
    'lifecycle="draining"',
  );
  expect((await request(3080, '/health')).status).toBe(503);
  expect(app.runtime.observe().activeWorkCount).toBe(1);
  discovery.resolve({ cursor: 'retained-cursor', scanned: 1, complete: false });
  expect(await drain).toMatchObject({ state: 'closed', pendingPromises: 0 });
  expect(deps.close).toHaveBeenCalledTimes(1);
  expect(deps.repository.claimNext).not.toHaveBeenCalled();
  await expect(request(3080, '/metrics', env.METRICS_SECRET)).rejects.toMatchObject({
    code: 'ECONNREFUSED',
  });
});

it.each(['startup failure', 'SIGTERM'] as const)(
  'notifies the original shutdown before held startup close when %s starts shutdown',
  async (first) => {
    const occupied = http.createServer((_req, res) => res.end('retained listener'));
    await new Promise<void>((resolve) => occupied.listen(3080, '127.0.0.1', resolve));
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const notify = jest.spyOn(shutdownOwner, 'requestGracefulShutdown');
    let now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const gate = later<void>();
    const entered = later<void>();
    const deps = options();
    deps.close.mockImplementation(() => {
      entered.resolve();
      return gate.promise;
    });
    const app = make(deps);
    const previousSignals = new Set(process.listeners('SIGTERM'));
    try {
      let settled = false;
      const startup = app.start();
      void startup.catch(() => {
        settled = true;
      });
      const ownedSignals = process.listeners('SIGTERM').filter((fn) => !previousSignals.has(fn));
      expect(ownedSignals).toHaveLength(1);
      if (first === 'SIGTERM') {
        ownedSignals[0]('SIGTERM');
        now += 1000;
      }
      await entered.promise;
      expect(settled).toBe(false);
      expect(shutdownOwner.isShutdownInProgress()).toBe(true);
      expect(shutdownOwner.getShutdownSignal().aborted).toBe(true);
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith('startup_failure');
      const originalShutdown = notify.mock.results[0].value as Promise<void>;
      const originalDrain = app.drain();
      expect(app.drain()).toBe(originalDrain);
      expect(app.start()).toBe(startup);
      const remaining = first === 'SIGTERM' ? 119000 : 120000;
      expect(shutdownOwner.getRemainingShutdownMs()).toBe(remaining);
      now += 1000;
      ownedSignals[0]('SIGTERM');
      ownedSignals[0]('SIGTERM');
      expect(shutdownOwner.requestGracefulShutdown('startup_failure')).toBe(originalShutdown);
      expect(shutdownOwner.getRemainingShutdownMs()).toBe(remaining - 1000);
      expect(deps.close).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();
      expect((await request(3080, '/')).body).toBe('retained listener');
      gate.resolve();
      await expect(startup).rejects.toMatchObject(
        first === 'SIGTERM'
          ? { message: 'Housekeeping stopped during startup' }
          : { code: 'EADDRINUSE' },
      );
      expect(await originalDrain).toMatchObject({ state: 'closed', pendingPromises: 0 });
      await originalShutdown;
      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
      expect(deps.close).toHaveBeenCalledTimes(1);
      await expect(request(3091, '/status')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    } finally {
      gate.resolve();
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  },
);

it('uses one immutable identity per instance and a new incarnation for the same Pod restart', () => {
  const a = make();
  const b = make();
  expect(a.identity.podUid).toBe(b.identity.podUid);
  expect(a.identity.incarnation).not.toBe(b.identity.incarnation);
  expect(a.maintenance.identity).toEqual(a.startupHold.identity);
  expect(Object.isFrozen(a.identity)).toBe(true);
});

it('settles owned resources after a refused startup hold without starting runtime admission', async () => {
  const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const deps = options();
  const app = make(deps);
  app.runtime.pauseAdmissions('different-owner');
  const startup = app.start();
  await expect(startup).rejects.toThrow('Housekeeping startup hold unconfirmed');
  expect(app.start()).toBe(startup);
  expect(deps.close).toHaveBeenCalledTimes(1);
  expect(deps.repository.discover).not.toHaveBeenCalled();
  expect((await app.drain()).state).toBe('closed');
  await shutdownOwner.requestGracefulShutdown('startup_failure');
  expect(exit).toHaveBeenCalledTimes(1);
  expect(exit).toHaveBeenCalledWith(1);
});

it('keeps the original startup cause when resource custody remains unresolved', async () => {
  const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const actual = metricsOwner.createMetrics;
  let metrics: ReturnType<typeof actual> | undefined;
  jest.spyOn(metricsOwner, 'createMetrics').mockImplementation((input) => {
    metrics = actual(input);
    return metrics;
  });
  const deps = options();
  deps.close.mockRejectedValue(new Error('Owned resource close unconfirmed'));
  const app = make(deps);
  app.runtime.pauseAdmissions('different-owner');
  try {
    const startup = app.start();
    await expect(startup).rejects.toMatchObject({
      message: 'Housekeeping startup failed with unresolved custody',
      cause: { message: 'Housekeeping startup hold unconfirmed' },
    });
    expect(app.start()).toBe(startup);
    expect(shutdownOwner.isShutdownInProgress()).toBe(true);
    expect(shutdownOwner.getRemainingShutdownMs()).toBeGreaterThan(0);
    expect((await app.drain()).state).toBe('unresolved');
    expect(deps.close).toHaveBeenCalledTimes(1);
    expect(deps.repository.discover).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  } finally {
    metrics?.detachHousekeepingMetrics();
  }
});

it('observes a rejected shutdown original without replacing the startup failure', async () => {
  const exitFailure = new Error('Controlled process exit failure');
  jest.spyOn(process, 'exit').mockImplementation(() => {
    throw exitFailure;
  });
  const notify = jest.spyOn(shutdownOwner, 'requestGracefulShutdown');
  const app = make();
  app.runtime.pauseAdmissions('different-owner');
  await expect(app.start()).rejects.toThrow('Housekeeping startup hold unconfirmed');
  // The application must already observe shutdown rejection; attaching below is deliberately late.
  await flush();
  expect(notify).toHaveBeenCalledTimes(1);
  await expect(notify.mock.results[0].value as Promise<void>).rejects.toBe(exitFailure);
  expect((await app.drain()).state).toBe('closed');
});

it('keeps actual HTTP observation after SIGTERM reports unresolved resource custody', async () => {
  const createServer = jest.spyOn(http, 'createServer');
  const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const deps = options();
  deps.close.mockRejectedValue(new Error('Owned resource close unconfirmed'));
  const app = make(deps);
  const listener = createServer.mock.results[0].value as http.Server;
  try {
    await app.start();
    for (const handler of process.listeners('SIGTERM')) handler('SIGTERM');
    await flush();
    await flush();
    expect((await app.drain()).state).toBe('unresolved');
    expect(deps.close).toHaveBeenCalledTimes(1);
    expect((await request(3080, '/metrics', env.METRICS_SECRET)).status).toBe(200);
    expect((await request(3080, '/health')).status).toBe(503);
    expect(exit).not.toHaveBeenCalled();
  } finally {
    // Test-owned sockets only: this controlled failed resource probe is not domain settlement.
    await app.maintenance.close();
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    shutdownOwner.__resetShutdownStateForTests();
  }
});

it.each(['repository', 'fileNotice', 'fileCleanup', 'uploadCleanup', 'close'] as const)(
  'rejects missing required %s without constructing a fallback owner',
  (name) => {
    expect(() =>
      createHousekeepingApplication({ ...options(), [name]: undefined } as never),
    ).toThrow('Incomplete Housekeeping owner ports');
  },
);
it.each([
  { POD_UID: 'invalid' },
  { BUILD_COMMIT: 'bad' },
  { POD_NODE_NAME: '' },
  { METRICS_SECRET: undefined },
  { METRICS_SECRET: env.LIBRECHAT_MAINTENANCE_TOKEN },
  { LIBRECHAT_MAINTENANCE_TOKEN: undefined },
  { LIBRECHAT_MAINTENANCE_PORT: '3080' },
])('refuses invalid identity or independent listener configuration %j', (change) => {
  expect(() =>
    createHousekeepingApplication({ ...options(), env: { ...env, ...change } }),
  ).toThrow();
});
