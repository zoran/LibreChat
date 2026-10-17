import { Server } from 'node:http';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GenerationMaintenanceCensus } from './maintenance';
import {
  createAppMaintenance,
  probeMaintenanceRedis,
  initializeMaintenanceGeneration,
} from './maintenance';

function fixture(
  workOwners: Record<string, import('./maintenance').ApplicationWorkPort> = {},
  unqualifiedOwners: string[] = [],
) {
  let census: GenerationMaintenanceCensus = {
    admissionClosed: false,
    initializing: 0,
    providerExecutions: 0,
    queuedContinuations: 0,
    pendingWrites: 0,
    activeStreams: 0,
    unresolved: 0,
    complete: true,
  };
  const owner = {
    closeGenerationAdmission: jest.fn(() => {
      census.admissionClosed = true;
      return true;
    }),
    reopenGenerationAdmission: jest.fn(() => {
      census.admissionClosed = false;
      return true;
    }),
    getGenerationAdmissionCensus: jest.fn(async () => ({ ...census })),
    getGenerationRuntimeHealth: jest.fn(async () => true),
  };
  const deps = {
    env: {
      LIBRECHAT_MAINTENANCE_TOKEN: 'a'.repeat(32),
      POD_UID: '12345678-1234-1234-1234-123456789012',
      BUILD_COMMIT: 'a'.repeat(40),
    },
    requiredSharedState: true,
    generation: owner,
    workOwners,
    unqualifiedOwners,
    startupReady: () => true,
    probeDatabase: jest.fn(async () => true),
    probeSharedState: jest.fn(async () => true),
  };
  const app = createAppMaintenance(deps);
  const request = (requestId = 'op', expectedRevision = 0) => ({
    requestId,
    expectedRevision,
    identity: app.identity,
  });
  return {
    app,
    owner,
    deps,
    request,
    set: (changes: Partial<GenerationMaintenanceCensus>) => {
      census = { ...census, ...changes };
    },
  };
}
async function http(
  f: ReturnType<typeof fixture>,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
  address = '127.0.0.1',
) {
  const req = Object.assign(
    Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
    {
      method,
      url,
      headers: {
        authorization: `Bearer ${'a'.repeat(32)}`,
        'content-type': 'application/json',
        ...headers,
      },
      socket: { remoteAddress: address },
    },
  );
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve) => {
    let status = 0;
    const res = {
      headersSent: false,
      writeHead: (code: number) => {
        status = code;
      },
      end: (value: string) => resolve({ status, body: JSON.parse(value) }),
    };
    f.app.handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  });
}
describe('private maintenance composition', () => {
  it('closes admission synchronously before any census and reports complete drain only', async () => {
    const f = fixture();
    f.set({ providerExecutions: 1 });
    expect(f.app.operation('begin', f.request())).toBe(200);
    expect(f.owner.closeGenerationAdmission).toHaveBeenCalledWith('op');
    expect(f.owner.getGenerationAdmissionCensus).not.toHaveBeenCalled();
    expect(await f.app.ready()).toBe(false);
    expect((await f.app.status()).phase).toBe('quiescing');
    f.set({ providerExecutions: 0 });
    expect((await f.app.status()).phase).toBe('drained');
  });
  it.each([
    'initializing',
    'providerExecutions',
    'queuedContinuations',
    'pendingWrites',
    'activeStreams',
    'unresolved',
  ] as const)('blocks drain for %s', async (key) => {
    const f = fixture();
    f.app.operation('begin', f.request());
    f.set({ [key]: 1 });
    expect((await f.app.status()).phase).toBe('quiescing');
  });
  it('rejects incomplete, failed and late observations after cancellation', async () => {
    const f = fixture();
    f.app.operation('begin', f.request());
    f.set({ complete: false });
    expect((await f.app.status()).known).toBe(false);
    let finish!: (v: GenerationMaintenanceCensus) => void;
    f.owner.getGenerationAdmissionCensus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.app.status();
    await Promise.resolve();
    expect(f.app.operation('cancel', f.request('op', 1))).toBe(200);
    finish({
      admissionClosed: true,
      complete: true,
      initializing: 0,
      providerExecutions: 0,
      queuedContinuations: 0,
      pendingWrites: 0,
      activeStreams: 0,
      unresolved: 0,
    });
    expect(await pending).toMatchObject({ known: false, phase: 'running' });
    f.owner.getGenerationAdmissionCensus.mockRejectedValueOnce(new Error('private backend detail'));
    expect((await f.app.status()).known).toBe(false);
  });
  it('retains unknown admission failure and rejects stale/foreign ownership', () => {
    const f = fixture();
    expect(f.app.operation('begin', { ...f.request(), unexpected: true })).toBe(400);
    expect(f.app.operation('begin', f.request('op', 9))).toBe(409);
    f.owner.closeGenerationAdmission.mockReturnValueOnce(false);
    expect(f.app.operation('begin', f.request())).toBe(503);
    expect(f.app.operation('cancel', f.request('op', 1))).toBe(409);
    expect(f.app.operation('begin', f.request('foreign', 1))).toBe(409);
  });
  it('allows exact cancel repeats but prevents replay of an old begin', () => {
    const f = fixture();
    f.app.operation('begin', f.request());
    expect(f.app.operation('cancel', f.request('op', 1))).toBe(200);
    expect(f.app.operation('cancel', f.request('op', 1))).toBe(200);
    expect(f.app.operation('begin', f.request())).toBe(409);
  });
  it('requires loopback AND token, rejects browser metadata, and ignores forwarding headers', async () => {
    const f = fixture();
    expect((await http(f, 'GET', '/status', undefined, {}, '10.0.0.1')).status).toBe(403);
    expect(
      (
        await http(f, 'GET', '/status', undefined, {
          authorization: 'Bearer wrong',
          'x-forwarded-for': '127.0.0.1',
        })
      ).status,
    ).toBe(403);
    expect(
      (await http(f, 'POST', '/begin', f.request(), { origin: 'https://chat.example.invalid' }))
        .status,
    ).toBe(403);
    expect(f.owner.closeGenerationAdmission).not.toHaveBeenCalled();
    const status = await http(f, 'GET', '/status');
    expect(status.status).toBe(200);
    expect(status.body.identity).toEqual(f.app.identity);
    expect((await http(f, 'POST', '/begin', f.request())).body.phase).toBe('drained');
  });
  it('uses actual dependency probes and never turns a timeout into ready', async () => {
    const f = fixture();
    expect(await f.app.ready()).toBe(true);
    f.deps.probeSharedState.mockResolvedValueOnce(false);
    expect(await f.app.ready()).toBe(false);
    f.owner.getGenerationRuntimeHealth.mockRejectedValueOnce(new Error('offline'));
    expect(await f.app.ready()).toBe(false);
    jest.useFakeTimers();
    try {
      f.deps.probeDatabase.mockImplementationOnce(() => new Promise(() => {}));
      const ready = f.app.ready();
      await jest.advanceTimersByTimeAsync(2100);
      expect(await ready).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
  it('keeps local opt-out and rejects missing shared runtime identity', async () => {
    const f = fixture();
    expect(() => createAppMaintenance({ ...f.deps, env: {} })).toThrow(
      'Invalid application runtime identity',
    );
    const legacy = createAppMaintenance({ ...f.deps, env: {}, requiredSharedState: false });
    expect(await legacy.ready()).toBe(true);
    expect(f.deps.probeDatabase).not.toHaveBeenCalled();
  });
  it('starts shared state without private control while preserving dependency health', async () => {
    const f = fixture();
    const shared = createAppMaintenance({
      ...f.deps,
      env: { POD_UID: f.deps.env.POD_UID, BUILD_COMMIT: f.deps.env.BUILD_COMMIT },
    });
    const listen = jest.spyOn(Server.prototype, 'listen').mockImplementation(() => {
      throw new Error('Unexpected private listener');
    });
    try {
      await shared.listen();
      expect(listen).not.toHaveBeenCalled();
      expect((await http({ ...f, app: shared }, 'GET', '/status')).status).toBe(403);
      expect(shared.identity.podUid).toBe(f.deps.env.POD_UID);
      expect(await shared.ready()).toBe(true);
      f.deps.probeDatabase.mockResolvedValueOnce(false);
      expect(await shared.ready()).toBe(false);
      f.deps.probeSharedState.mockResolvedValueOnce(false);
      expect(await shared.ready()).toBe(false);
      f.owner.getGenerationRuntimeHealth.mockResolvedValueOnce(false);
      expect(await shared.ready()).toBe(false);
    } finally {
      listen.mockRestore();
      await shared.close();
    }
  });
  it('still rejects an explicitly invalid private control credential', () => {
    const f = fixture();
    expect(() =>
      createAppMaintenance({
        ...f.deps,
        env: { ...f.deps.env, LIBRECHAT_MAINTENANCE_TOKEN: '' },
      }),
    ).toThrow('Invalid private maintenance configuration');
  });
  it('preserves existing stream/history and abort middleware paths', () => {
    const f = fixture();
    f.app.operation('begin', f.request());
    const next = jest.fn();
    for (const req of [
      { method: 'GET', path: '/stream' },
      { method: 'POST', path: '/abort' },
    ]) {
      f.app.admissionMiddleware(req as never, {} as never, next);
    }
    expect(next).toHaveBeenCalledTimes(2);
  });
  it('checks command readiness and actual PONGs without claiming subscriber health', async () => {
    const deps = {
      required: true,
      cache: { isReady: true, ping: jest.fn(async () => 'PONG') },
      commands: { status: 'ready', ping: jest.fn(async () => 'PONG') },
    };
    expect(await probeMaintenanceRedis(deps)).toBe(true);
    deps.cache.isReady = false;
    expect(await probeMaintenanceRedis(deps)).toBe(false);
  });
});

it('blocks new mutating API admission while preserving exact abort and reads', () => {
  const f = fixture();
  f.app.operation('begin', f.request());
  const next = jest.fn();
  const res = {
    set: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
  for (const path of ['/schedules', '/admin', '/agents/chat/abort/extra']) {
    f.app.mutationMiddleware({ method: 'POST', path } as never, res as never, next);
  }
  expect(res.status).toHaveBeenCalledTimes(3);
  expect(next).not.toHaveBeenCalled();
  for (const req of [
    { method: 'GET', path: '/history' },
    { method: 'POST', path: '/agents/chat/abort' },
  ]) {
    f.app.mutationMiddleware(req as never, res as never, next);
  }
  expect(next).toHaveBeenCalledTimes(2);
});
function generationAdmissionMethods() {
  return {
    ensureGenerationAdmissionIndexes: jest.fn(async () => {}),
    acquireGenerationAdmission: jest.fn(),
    getGenerationAdmission: jest.fn(),
    dispatchGenerationAdmission: jest.fn(),
    settleGenerationAdmission: jest.fn(),
    acquireGenerationAdmissionSuccessor: jest.fn(),
    cancelUndispatchedGenerationAdmission: jest.fn(),
    findGenerationAdmissionByEpoch: jest.fn(),
    countUnsettledGenerationAdmissions: jest.fn(),
    recoverGenerationAdmission: jest.fn(),
    writeGenerationCheckpoint: jest.fn(),
  };
}

it('awaits exact durable indexes before configuring required generation admission', async () => {
  let finish!: () => void;
  const configure = jest.fn();
  const methods = {
    ...generationAdmissionMethods(),
    ensureGenerationAdmissionIndexes: jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    ),
  };
  const identity = fixture().app.identity;
  const initializing = initializeMaintenanceGeneration({
    required: true,
    methods,
    identity,
    configure,
  });
  expect(configure).not.toHaveBeenCalled();
  finish();
  await initializing;
  expect(configure).toHaveBeenCalledWith({
    required: true,
    methods,
    ownerInstanceId: identity.podUid,
    processBootId: identity.incarnation,
    externalCensus: undefined,
  });
});

it.each(['recoverGenerationAdmission', 'writeGenerationCheckpoint'])(
  'rejects a missing checkpoint port %s before configuring required admission',
  async (port) => {
    const methods = generationAdmissionMethods();
    Object.assign(methods, { [port]: undefined });
    const configure = jest.fn();
    await expect(
      initializeMaintenanceGeneration({
        required: true,
        methods,
        identity: fixture().app.identity,
        configure,
      }),
    ).rejects.toThrow('Generation admission methods unavailable');
    expect(methods.ensureGenerationAdmissionIndexes).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
  },
);

it('preserves optional generation admission without methods or indexes', async () => {
  const configure = jest.fn();
  const identity = fixture().app.identity;
  await initializeMaintenanceGeneration({
    required: false,
    methods: {} as never,
    identity,
    configure,
  });
  expect(configure).toHaveBeenCalledWith({
    required: false,
    methods: undefined,
    ownerInstanceId: identity.podUid,
    processBootId: identity.incarnation,
    externalCensus: undefined,
  });
});

it('emits APP_QUIESCING only before downstream admission, not for ordinary dependency failure', async () => {
  const f = fixture();
  const next = jest.fn();
  const codes: unknown[] = [];
  let done!: () => void;
  const res = {
    set: jest.fn(),
    status: jest.fn(),
    json: jest.fn((value: unknown) => {
      codes.push(value);
      done();
    }),
  };
  res.set.mockReturnValue(res);
  res.status.mockReturnValue(res);
  const invoke = async () => {
    const result = new Promise<void>((resolve) => {
      done = resolve;
    });
    f.app.admissionMiddleware({ method: 'POST', path: '/' } as never, res as never, next);
    await result;
  };
  f.deps.probeDatabase.mockResolvedValue(false);
  await invoke();
  expect(codes.pop()).toMatchObject({ code: 'SERVER_NOT_READY' });
  f.app.operation('begin', f.request());
  await invoke();
  expect(codes.pop()).toMatchObject({ code: 'APP_QUIESCING' });
  expect(next).not.toHaveBeenCalled();
  f.app.mutationMiddleware({ method: 'POST', path: '/chat' } as never, res as never, next);
  expect(codes.pop()).toMatchObject({ code: 'APP_QUIESCING' });
});

function workPort() {
  let closed = false;
  return {
    pauseAdmissions: jest.fn(() => {
      closed = true;
      return true;
    }),
    resumeAdmissions: jest.fn(() => {
      closed = false;
      return true;
    }),
    getMaintenanceCensus: jest.fn(async () => ({
      admissionClosed: closed,
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    })),
  };
}
describe('application work census', () => {
  it('attempts every owner and generation after a throwing pause, retaining uncertainty', async () => {
    const a = workPort();
    const b = workPort();
    a.pauseAdmissions.mockImplementation(() => {
      throw new Error('private');
    });
    const f = fixture({ a, b });
    expect(f.app.operation('begin', f.request())).toBe(503);
    expect(b.pauseAdmissions).toHaveBeenCalledWith('op');
    expect(f.owner.closeGenerationAdmission).toHaveBeenCalledWith('op');
    expect(f.app.operation('cancel', f.request('op', 1))).toBe(409);
    expect(await f.app.status()).toMatchObject({ known: false, phase: 'quiescing' });
  });
  it('retains the outer gate after partial resume without erasing uncertainty', async () => {
    const a = workPort();
    const b = workPort();
    const f = fixture({ a, b });
    f.app.operation('begin', f.request());
    a.resumeAdmissions.mockReturnValue(false);
    expect(f.app.operation('cancel', f.request('op', 1))).toBe(503);
    expect(b.resumeAdmissions).toHaveBeenCalledWith('op');
    expect(f.owner.reopenGenerationAdmission).toHaveBeenCalledWith('op');
    expect(await f.app.ready()).toBe(false);
    expect(await f.app.status()).toMatchObject({
      requestId: 'op',
      known: false,
      phase: 'quiescing',
    });
  });
  it('keeps explicit unqualified coverage separate from useful runtime readiness', async () => {
    const f = fixture({ browser: workPort() }, ['legacy auth', 'history']);
    expect(await f.app.ready()).toBe(true);
    expect(await f.app.externalCensus()).toMatchObject({ complete: false });
    f.app.operation('begin', f.request());
    expect(await f.app.status()).toMatchObject({
      known: false,
      blockingReasons: expect.arrayContaining(['history']),
    });
  });
  it.each([
    { admissionClosed: false },
    { pendingWrites: -1 },
    { queuedContinuations: 0.5 },
    { complete: false },
  ])('rejects invalid or incomplete owner snapshots: %j', async (change) => {
    const port = workPort();
    const f = fixture({ port });
    f.app.operation('begin', f.request());
    port.getMaintenanceCensus.mockResolvedValue({
      admissionClosed: true,
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
      ...change,
    });
    expect((await f.app.externalCensus()).complete).toBe(false);
    expect((await f.app.status()).known).toBe(false);
  });
  it('binds observations to the exact request and revision across awaits', async () => {
    const port = workPort();
    const f = fixture({ port });
    f.app.operation('begin', f.request());
    let finish!: (value: Awaited<ReturnType<typeof port.getMaintenanceCensus>>) => void;
    port.getMaintenanceCensus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.app.externalCensus();
    await Promise.resolve();
    expect(port.getMaintenanceCensus).toHaveBeenCalledWith('op');
    expect(f.app.operation('cancel', f.request('op', 1))).toBe(200);
    finish({ admissionClosed: true, queuedContinuations: 0, pendingWrites: 0, complete: true });
    expect((await pending).complete).toBe(false);
  });
  it('counts real pending work and rejects aggregate overflow', async () => {
    const a = workPort();
    const b = workPort();
    const f = fixture({ a, b });
    f.app.operation('begin', f.request());
    a.getMaintenanceCensus.mockResolvedValue({
      admissionClosed: true,
      queuedContinuations: 2,
      pendingWrites: 3,
      complete: true,
    });
    expect(await f.app.externalCensus()).toEqual({
      queuedContinuations: 2,
      pendingWrites: 3,
      complete: true,
    });
    expect((await f.app.status()).phase).toBe('quiescing');
    a.getMaintenanceCensus.mockResolvedValue({
      admissionClosed: true,
      queuedContinuations: 0,
      pendingWrites: Number.MAX_SAFE_INTEGER,
      complete: true,
    });
    b.getMaintenanceCensus.mockResolvedValue({
      admissionClosed: true,
      queuedContinuations: 0,
      pendingWrites: 1,
      complete: true,
    });
    expect((await f.app.externalCensus()).complete).toBe(false);
  });
});

it('keeps missing or failed application observations incomplete without poisoning normal readiness', async () => {
  const port = workPort();
  const f = fixture({ port });
  port.getMaintenanceCensus.mockRejectedValue(new Error('private backend detail'));
  expect(await f.app.externalCensus()).toEqual({
    queuedContinuations: 0,
    pendingWrites: 0,
    complete: false,
  });
  expect(await f.app.ready()).toBe(true);
  const { workOwners: _owners, unqualifiedOwners: _coverage, ...deps } = f.deps;
  const unconfigured = createAppMaintenance(deps);
  expect((await unconfigured.externalCensus()).complete).toBe(false);
  expect(await unconfigured.ready()).toBe(true);
});
