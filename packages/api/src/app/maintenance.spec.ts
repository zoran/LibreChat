import { Server } from 'node:http';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GenerationMaintenanceCensus } from './maintenance';
import {
  createAppMaintenance,
  probeMaintenanceRedis,
  initializeMaintenanceGeneration,
} from './maintenance';
import { createCodeEnvironmentLifecycleMaintenance } from '../code/lifecycle';
import { createFileDeletionWorkOwner } from '../files/deletion';
import { createAuthMaintenance } from '../auth/maintenance';
import { isLeader } from '../cluster';

jest.mock('../cluster', () => ({ isLeader: jest.fn() }));

function fixture(
  workOwners: Record<string, import('./maintenance').ApplicationWorkPort> = {},
  unqualifiedOwners: string[] = [],
  fileDomainOwners: string[] = [],
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
    fileDomainOwners,
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
    expect(await f.app.status()).toMatchObject({
      phase: 'drained',
      known: true,
      fileDomain: { known: false, census: null },
    });
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
    const f = fixture({ port: workPort() }, [], ['port']);
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
    expect(await pending).toMatchObject({
      known: false,
      phase: 'running',
      fileDomain: { known: false, census: null },
    });
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

describe('application startup admission', () => {
  function startup(unqualified: string[] = []) {
    const work = workPort();
    const f = fixture({ original: work }, unqualified, ['original']);
    const app = createAppMaintenance({ ...f.deps, startupAdmission: 'closed' });
    const request = {
      requestId: `startup_${app.identity.incarnation}`,
      identity: app.identity,
      expectedRevision: 1,
    };
    return { app, work, f, request };
  }

  it('closes actual owners before returning and exposes revision one without readiness', async () => {
    const { app, work, f, request } = startup();
    expect(work.pauseAdmissions).toHaveBeenCalledWith(request.requestId);
    expect(f.owner.closeGenerationAdmission).toHaveBeenCalledWith(request.requestId);
    expect(await app.status()).toMatchObject({
      revision: 1,
      requestId: request.requestId,
      phase: 'drained',
      known: true,
      fileDomain: { known: true, census: { admissionClosed: true, pendingWrites: 0 } },
    });
    expect(await app.ready()).toBe(false);
  });

  it('retains startup until only the exact identity and revision are cancelled', async () => {
    const { app, work, request } = startup();
    const abort = new AbortController();
    let dispatched = false;
    const original = app.waitForStartupRelease(abort.signal).then(() => {
      dispatched = true;
    });
    await Promise.resolve();
    expect(dispatched).toBe(false);
    expect(app.operation('cancel', { ...request, expectedRevision: 0 })).toBe(409);
    expect(
      app.operation('cancel', {
        ...request,
        identity: { ...request.identity, source: 'b'.repeat(40) },
      }),
    ).toBe(400);
    expect(dispatched).toBe(false);
    expect(app.operation('cancel', request)).toBe(200);
    await original;
    expect(dispatched).toBe(true);
    expect(work.resumeAdmissions).toHaveBeenCalledTimes(1);
    expect(await app.status()).toMatchObject({ revision: 2, requestId: null, phase: 'running' });
  });

  it('preserves unknown owners while startup is closed', async () => {
    const { app } = startup(['original database history unavailable']);
    const value = await app.status();
    expect(value.known).toBe(false);
    expect(value.fileDomain).toMatchObject({ known: true, census: { admissionClosed: true } });
    expect(value.blockingReasons).toContain('original database history unavailable');
    expect(await app.ready()).toBe(false);
  });

  it('serves private liveness while held and preserves loopback and readiness fences', async () => {
    const { app, f } = startup();
    const held = { ...f, app };
    expect(await http(held, 'GET', '/livez', undefined, { authorization: '' })).toEqual({
      status: 200,
      body: { live: true },
    });
    expect((await http(held, 'GET', '/readyz', undefined, { authorization: '' })).status).toBe(503);
    expect((await http(held, 'GET', '/livez', undefined, {}, '10.0.0.1')).status).toBe(403);
  });

  it('aborts the unadmitted startup continuation without reopening owners', async () => {
    const { app, work, request } = startup();
    const abort = new AbortController();
    const failure = new Error('original shutdown');
    const original = app.waitForStartupRelease(abort.signal);
    const settled = (async () => {
      await expect(original).rejects.toBe(failure);
    })();
    abort.abort(failure);
    await settled;
    expect(work.resumeAdmissions).not.toHaveBeenCalled();
    expect(await app.status()).toMatchObject({ revision: 1, requestId: request.requestId });
  });

  it('does not release startup after an uncertain owner resume', async () => {
    const { app, work, request } = startup();
    work.resumeAdmissions.mockReturnValue(false);
    const abort = new AbortController();
    const original = app.waitForStartupRelease(abort.signal);
    const settled = (async () => {
      await expect(original).rejects.toThrow('cancel wait');
    })();
    expect(app.operation('cancel', request)).toBe(503);
    expect(await app.status()).toMatchObject({
      revision: 1,
      requestId: request.requestId,
      known: false,
      fileDomain: { known: false, census: null },
    });
    abort.abort(new Error('cancel wait'));
    await settled;
  });

  it('starts a replacement closed and refuses its predecessor release', async () => {
    const before = startup();
    expect(before.app.operation('cancel', before.request)).toBe(200);
    const after = startup();
    expect(after.app.identity.incarnation).not.toBe(before.app.identity.incarnation);
    expect(after.app.operation('cancel', before.request)).toBe(400);
    expect(await after.app.status()).toMatchObject({
      revision: 1,
      requestId: after.request.requestId,
      phase: 'drained',
    });
  });
});
describe('application work census', () => {
  it('attempts every owner and generation after a throwing pause, retaining uncertainty', async () => {
    const a = workPort();
    const b = workPort();
    a.pauseAdmissions.mockImplementation(() => {
      throw new Error('private');
    });
    const f = fixture({ a, b }, [], ['b']);
    expect(f.app.operation('begin', f.request())).toBe(503);
    expect(b.pauseAdmissions).toHaveBeenCalledWith('op');
    expect(f.owner.closeGenerationAdmission).toHaveBeenCalledWith('op');
    expect(f.app.operation('cancel', f.request('op', 1))).toBe(409);
    expect(await f.app.status()).toMatchObject({
      known: false,
      phase: 'quiescing',
      fileDomain: { known: false, census: null },
    });
  });
  it('retains the outer gate after partial resume without erasing uncertainty', async () => {
    const a = workPort();
    const b = workPort();
    const f = fixture({ a, b }, [], ['b']);
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
      fileDomain: { known: false, census: null },
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
    const f = fixture({ port }, [], ['port']);
    f.app.operation('begin', f.request());
    port.getMaintenanceCensus.mockResolvedValue({
      admissionClosed: true,
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
      ...change,
    });
    expect((await f.app.externalCensus()).complete).toBe(false);
    expect(await f.app.status()).toMatchObject({
      known: false,
      fileDomain: { known: false, census: null },
    });
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

describe('File-domain maintenance composition', () => {
  it.each([
    { fileDomainOwners: undefined },
    { fileDomainOwners: ['missing'] },
    { fileDomainOwners: ['files', 'files'] },
  ])('rejects an absent or inconsistent File owner selection: %j', ({ fileDomainOwners }) => {
    const files = createFileDeletionWorkOwner();
    const f = fixture({ files: files.maintenance });
    expect(() => createAppMaintenance({ ...f.deps, fileDomainOwners } as never)).toThrow(
      'Invalid File-domain maintenance configuration',
    );
  });

  it('retains actual File originals while preserving global unknowns and sampling each owner once', async () => {
    const files = createFileDeletionWorkOwner();
    const readFile = jest.spyOn(files.maintenance, 'getMaintenanceCensus');
    const unrelated = workPort();
    unrelated.getMaintenanceCensus.mockRejectedValue(
      new Error('unrelated observation unavailable'),
    );
    const selected = ['files'];
    const remaining = ['global writer coverage remains unqualified'];
    const f = fixture({ files: files.maintenance, unrelated }, remaining, selected);
    selected.length = 0; // Composition captures its explicit selection before external mutation.
    let finish!: () => void;
    let dispatch!: () => void;
    const original = files.run((scope) =>
      scope.queued((dispatched) => {
        dispatch = dispatched;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      }),
    );
    f.set({ providerExecutions: 1, pendingWrites: 2, activeStreams: 1 });
    expect(f.app.operation('begin', f.request())).toBe(200);
    try {
      const status = await f.app.status();
      expect(status).toMatchObject({
        identity: f.app.identity,
        requestId: 'op',
        revision: 1,
        phase: 'quiescing',
        known: false,
        census: null,
        blockingReasons: expect.arrayContaining(remaining),
        fileDomain: {
          known: true,
          census: {
            admissionClosed: true,
            providerExecutions: 1,
            activeStreams: 1,
            queuedContinuations: 1,
            pendingWrites: 3,
            complete: true,
          },
        },
      });
      expect(readFile).toHaveBeenCalledTimes(1);
      expect(readFile).toHaveBeenCalledWith('op');
      expect(unrelated.getMaintenanceCensus).toHaveBeenCalledTimes(1);
      expect(f.owner.getGenerationAdmissionCensus).toHaveBeenCalledTimes(1);
      await expect(files.run(async () => undefined)).rejects.toThrow('FILE_DELETION_QUIESCING');
    } finally {
      dispatch();
      finish();
      await original;
    }
    f.set({ providerExecutions: 0, pendingWrites: 0, activeStreams: 0 });
    expect(await f.app.status()).toMatchObject({
      phase: 'quiescing',
      known: false,
      census: null,
      blockingReasons: expect.arrayContaining(remaining),
      fileDomain: {
        known: true,
        census: { admissionClosed: true, queuedContinuations: 0, pendingWrites: 0 },
      },
    });
  });

  it('retains unknown actual File effects and rejects overflow with Generation originals', async () => {
    const files = createFileDeletionWorkOwner();
    const f = fixture({ files: files.maintenance }, [], ['files']);
    let finish!: () => void;
    const original = files.run((scope) =>
      scope.effect(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    f.set({ pendingWrites: Number.MAX_SAFE_INTEGER });
    try {
      expect(await f.app.status()).toMatchObject({
        known: false,
        census: null,
        fileDomain: { known: false, census: null },
      });
    } finally {
      finish();
      await original;
    }
    f.set({ pendingWrites: 0 });
    const failure = new Error('File effect outcome unconfirmed');
    await expect(
      files.run((scope) =>
        scope.effect(async () => {
          throw failure;
        }),
      ),
    ).rejects.toBe(failure);
    expect(f.app.operation('begin', f.request())).toBe(200);
    expect(await f.app.status()).toMatchObject({
      known: false,
      fileDomain: { known: false, census: null },
    });
    expect(f.app.operation('cancel', f.request('op', 1))).toBe(503);
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
  const unconfigured = createAppMaintenance({ ...deps, fileDomainOwners: [] });
  expect((await unconfigured.externalCensus()).complete).toBe(false);
  expect(await unconfigured.ready()).toBe(true);
});

describe('actual history owner composition', () => {
  const { createHistoryMaintenance } = jest.requireActual(
    '../../../../api/server/services/HistoryMaintenance',
  );
  it('keeps a disconnected original in the actual census and preserves all remaining blockers', async () => {
    const history = createHistoryMaintenance();
    const remaining = [
      'raw database commands, sessions and independent writers outside qualified owners',
      'standalone tag/share and other HTTP mutations',
      'MCP/OAuth reconnect, search indexing, code lifecycle and remaining background owners',
    ];
    const f = fixture({ history }, remaining);
    const req = new EventEmitter();
    const res = new EventEmitter();
    history.admissionMiddleware(req, res, () => undefined);
    let complete!: () => void;
    const original = history.run(
      req,
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    res.emit('close');
    expect(f.app.operation('begin', f.request())).toBe(200);
    try {
      expect(await f.app.externalCensus()).toMatchObject({ complete: false, pendingWrites: 1 });
      expect(await f.app.status()).toMatchObject({
        known: false,
        blockingReasons: expect.arrayContaining(remaining),
      });
    } finally {
      complete();
      await original;
    }
    expect(await f.app.externalCensus()).toMatchObject({ complete: false, pendingWrites: 0 });
    expect(await f.app.status()).toMatchObject({
      known: false,
      blockingReasons: expect.arrayContaining(remaining),
    });
  });

  it('holds the actual history owner until exact startup release without dispatching new work', async () => {
    const history = createHistoryMaintenance();
    const f = fixture({ history });
    const app = createAppMaintenance({ ...f.deps, startupAdmission: 'closed' });
    const state = await app.status();
    const start = jest.fn();
    await expect(history.run({}, start)).rejects.toThrow('APP_QUIESCING');
    expect(start).not.toHaveBeenCalled();
    expect(
      app.operation('cancel', {
        identity: app.identity,
        requestId: state.requestId,
        expectedRevision: state.revision,
      }),
    ).toBe(200);
    await history.run({}, start);
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe('actual auth owner composition', () => {
  const { createHistoryMaintenance } = jest.requireActual(
    '../../../../api/server/services/HistoryMaintenance',
  );
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const remaining = [
    'raw database commands, sessions and independent writers outside qualified owners',
    'standalone tag/share and other HTTP mutations',
    'MCP/OAuth reconnect, search indexing, code lifecycle and remaining background owners',
  ];
  it('aggregates actual auth callbacks, returned originals and history without erasing remaining blockers', async () => {
    const auth = createAuthMaintenance();
    const history = createHistoryMaintenance();
    const f = fixture({ auth, history }, remaining);
    const req = {};
    const res = Object.assign(new EventEmitter(), { end: jest.fn() });
    let complete!: () => unknown;
    let returnOriginal!: () => void;
    let finishChild!: () => void;
    let finishHistory!: () => void;
    let childWork: Promise<void> | undefined;
    const returned = new Promise<void>((resolve) => {
      returnOriginal = resolve;
    });
    const child = new Promise<void>((resolve) => {
      finishChild = resolve;
    });
    auth.admissionMiddleware(req as never, res as never, () => undefined);
    const original = auth.run(req, (operation) =>
      operation.callback<void>(
        (done) => {
          complete = done;
          return returned;
        },
        {
          complete: () => {
            childWork = auth.current()!.write(() => child);
          },
        },
      ),
    );
    const historyWork = history.run(
      {},
      () =>
        new Promise<void>((resolve) => {
          finishHistory = resolve;
        }),
    );
    res.emit('close');
    expect(f.app.operation('begin', f.request())).toBe(200);
    try {
      expect(await f.app.externalCensus()).toMatchObject({
        queuedContinuations: 1,
        pendingWrites: 2,
        complete: false,
      });
      finishHistory();
      await historyWork;
      returnOriginal();
      await tick();
      expect(await f.app.externalCensus()).toMatchObject({
        queuedContinuations: 1,
        pendingWrites: 1,
        complete: false,
      });
      complete();
      await original;
      expect(await f.app.externalCensus()).toMatchObject({
        queuedContinuations: 1,
        pendingWrites: 1,
        complete: false,
      });
      finishChild();
      await childWork;
      expect(await f.app.externalCensus()).toMatchObject({
        queuedContinuations: 0,
        pendingWrites: 0,
        complete: false,
      });
      expect(await f.app.status()).toMatchObject({
        known: false,
        blockingReasons: expect.arrayContaining(remaining),
      });
    } finally {
      finishHistory();
      returnOriginal();
      complete();
      finishChild();
      await Promise.all([original, historyWork, childWork]);
    }
  });

  it('holds actual auth and history admission until the exact startup release', async () => {
    const auth = createAuthMaintenance();
    const history = createHistoryMaintenance();
    const f = fixture({ auth, history }, remaining);
    const app = createAppMaintenance({ ...f.deps, startupAdmission: 'closed' });
    const state = await app.status();
    const start = jest.fn();
    await expect(auth.run(undefined, start)).rejects.toThrow('APP_QUIESCING');
    await expect(history.run({}, start)).rejects.toThrow('APP_QUIESCING');
    expect(start).not.toHaveBeenCalled();
    expect(
      app.operation('cancel', {
        identity: app.identity,
        requestId: state.requestId,
        expectedRevision: state.revision + 1,
      }),
    ).toBe(409);
    await expect(auth.run(undefined, start)).rejects.toThrow('APP_QUIESCING');
    expect(
      app.operation('cancel', {
        identity: app.identity,
        requestId: state.requestId,
        expectedRevision: state.revision,
      }),
    ).toBe(200);
    await auth.run(undefined, start);
    await history.run({}, start);
    expect(start).toHaveBeenCalledTimes(2);
    expect(await app.status()).toMatchObject({
      known: false,
      blockingReasons: expect.arrayContaining(remaining),
    });
  });
});

describe('actual code lifecycle owner composition', () => {
  const { createHistoryMaintenance } = jest.requireActual(
    '../../../../api/server/services/HistoryMaintenance',
  );
  const remaining = [
    'raw database commands, sessions and independent writers outside qualified owners',
    'standalone tag/share and other HTTP mutations',
    'MCP/OAuth reconnect, search indexing, code lifecycle and remaining background owners',
  ];
  it('retains the actual lifecycle original alongside Auth/history and all unresolved groups', async () => {
    const codeLifecycle = createCodeEnvironmentLifecycleMaintenance();
    const auth = createAuthMaintenance();
    const history = createHistoryMaintenance();
    let finish!: (leader: boolean) => void;
    jest.mocked(isLeader).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const original = codeLifecycle.start({ mongoose: { models: {} } as never });
    const f = fixture({ codeLifecycle, auth, history }, remaining);
    try {
      expect(f.app.operation('begin', f.request())).toBe(200);
      expect(await f.app.externalCensus()).toMatchObject({
        queuedContinuations: 1,
        pendingWrites: 1,
        complete: false,
      });
      expect(await f.app.status()).toMatchObject({
        known: false,
        phase: 'quiescing',
        blockingReasons: expect.arrayContaining(remaining),
      });
      await expect(codeLifecycle.reconcile({ mongoose: {} as never })).rejects.toThrow(
        'CODE_LIFECYCLE_ADMISSION_CLOSED',
      );
    } finally {
      finish(false);
      await original;
      await codeLifecycle.drain();
    }
    expect(await f.app.externalCensus()).toMatchObject({
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: false,
    });
    expect(await f.app.status()).toMatchObject({
      known: false,
      blockingReasons: expect.arrayContaining(remaining),
    });
  });

  it('keeps lifecycle/Auth/history born closed until exact release and refuses stopped release', async () => {
    const codeLifecycle = createCodeEnvironmentLifecycleMaintenance();
    const auth = createAuthMaintenance();
    const history = createHistoryMaintenance();
    const f = fixture({ codeLifecycle, auth, history }, remaining);
    const app = createAppMaintenance({ ...f.deps, startupAdmission: 'closed' });
    const state = await app.status();
    const request = {
      identity: app.identity,
      requestId: state.requestId,
      expectedRevision: state.revision,
    };
    await expect(codeLifecycle.start({ mongoose: {} as never })).rejects.toThrow(
      'CODE_LIFECYCLE_ADMISSION_CLOSED',
    );
    expect(app.operation('cancel', { ...request, expectedRevision: state.revision + 1 })).toBe(409);
    await expect(auth.run(undefined, () => undefined)).rejects.toThrow('APP_QUIESCING');
    await expect(history.run({}, () => undefined)).rejects.toThrow('APP_QUIESCING');
    expect(app.operation('cancel', request)).toBe(200);
    jest.mocked(isLeader).mockResolvedValueOnce(false);
    await codeLifecycle.start({ mongoose: {} as never });
    await auth.run(undefined, () => undefined);
    await history.run({}, () => undefined);
    await codeLifecycle.drain();
    const running = await app.status();
    const held = {
      identity: app.identity,
      requestId: 'after-stop',
      expectedRevision: running.revision,
    };
    expect(app.operation('begin', held)).toBe(200);
    expect(app.operation('cancel', { ...held, expectedRevision: running.revision + 1 })).toBe(503);
    expect(await app.status()).toMatchObject({
      known: false,
      requestId: 'after-stop',
      blockingReasons: expect.arrayContaining(remaining),
    });
  });

  it('rejects actual lifecycle census when the App request changes across its await', async () => {
    const codeLifecycle = createCodeEnvironmentLifecycleMaintenance();
    const f = fixture({ codeLifecycle });
    expect(f.app.operation('begin', f.request())).toBe(200);
    const census = f.app.externalCensus();
    expect(codeLifecycle.resumeAdmissions('wrong')).toBe(false);
    expect(f.app.operation('cancel', f.request('op', 1))).toBe(200);
    expect((await census).complete).toBe(false);
    await codeLifecycle.drain();
  });
});

describe('actual Permission/cache/retry App composition', () => {
  const remaining = [
    'raw database commands, sessions and independent writers outside qualified owners',
    'standalone tag/share and other HTTP mutations',
    'MCP/OAuth reconnect, search indexing, code lifecycle and remaining background owners',
  ];
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  function owners() {
    // Only the external Mongo/retry storage and timer registration are inert.
    const collection = {
      findOne: jest.fn(async () => null),
      updateOne: jest.fn(async () => ({ acknowledged: true })),
    };
    const connection = { readyState: 1, db: { collection: () => collection } };
    let cache!: typeof import('../cache/keyvMongo');
    let auth!: ReturnType<typeof createAuthMaintenance>;
    jest.isolateModules(() => {
      jest.doMock('mongoose', () => ({ __esModule: true, default: { connection } }));
      jest.doMock('@librechat/data-schemas', () => ({
        logger: { error: jest.fn(), warn: jest.fn() },
      }));
      cache = jest.requireActual('../cache/keyvMongo');
      auth = jest.requireActual('../auth/maintenance').createAuthMaintenance();
    });
    jest.dontMock('mongoose');
    jest.dontMock('@librechat/data-schemas');
    cache.mongoCacheMaintenance.bindAuth(auth);
    const { Keyv } = jest.requireActual('keyv');
    const bans = cache.ownMongoCache(new Keyv({ store: cache.default }), 'auth');
    const permission = jest
      .requireActual('../../../../api/server/services/PermissionMaintenance')
      .createPermissionMaintenance();
    const storage = {
      upsert: jest.fn(async () => {}),
      deleteVersion: jest.fn(async () => {}),
      deferVersion: jest.fn(async () => {}),
      list: jest.fn(async () => []),
    };
    const registerShutdown = jest.fn();
    const retry = jest
      .requireActual('../mcp/authorizationRetry')
      .createMCPAuthorizationFenceRetryService({
        storage,
        getTenantId: () => 'tenant-a',
        runInRetryScope: (_record: unknown, action: () => Promise<void>) => action(),
        registerShutdown,
      });
    const f = fixture(
      {
        auth,
        permissions: permission,
        mcpAuthorizationRetry: retry.maintenance,
        mongoCache: cache.mongoCacheMaintenance.maintenance,
      },
      remaining,
    );
    return { ...f, auth, permission, cache, bans, retry, storage, collection, registerShutdown };
  }

  it('retains all selected originals through begin and never erases the unresolved writer groups', async () => {
    const f = owners();
    const permissionGate = deferred();
    const cacheGate = deferred();
    const retryGate = deferred();
    f.collection.updateOne.mockImplementation(async () => {
      await cacheGate.promise;
      return { acknowledged: true };
    });
    f.storage.upsert.mockImplementation(() => retryGate.promise);
    const originals = [
      f.permission.run((operation: { write(action: () => Promise<void>): Promise<void> }) =>
        operation.write(() => permissionGate.promise),
      ),
      f.auth.run(undefined, () => f.bans.set('original', 1)),
      f.retry.persist({ userId: 'user-a', serverName: 'server-a' }),
    ];
    try {
      for (let i = 0; i < 40 && !f.collection.updateOne.mock.calls.length; i++)
        await Promise.resolve();
      expect(f.collection.updateOne).toHaveBeenCalledTimes(1);
      expect(f.app.operation('begin', f.request())).toBe(200);
      expect(() => f.permission.run(jest.fn())).toThrow('APP_QUIESCING');
      await expect(f.auth.run(undefined, jest.fn())).rejects.toThrow('APP_QUIESCING');
      for (const owner of [
        f.permission,
        f.cache.mongoCacheMaintenance.maintenance,
        f.retry.maintenance,
      ]) {
        const census = await owner.getMaintenanceCensus('op');
        expect(census.queuedContinuations).toBeGreaterThan(0);
        expect(census.pendingWrites).toBeGreaterThan(0);
      }
      expect((await f.app.externalCensus()).pendingWrites).toBeGreaterThan(0);
      expect(await f.app.status()).toMatchObject({
        known: false,
        blockingReasons: expect.arrayContaining(remaining),
      });
    } finally {
      permissionGate.resolve();
      cacheGate.resolve();
      retryGate.resolve();
      await Promise.all(originals);
      await f.retry.stop();
    }
    for (const owner of [
      f.permission,
      f.cache.mongoCacheMaintenance.maintenance,
      f.retry.maintenance,
    ]) {
      expect(await owner.getMaintenanceCensus('op')).toMatchObject({
        queuedContinuations: 0,
        pendingWrites: 0,
      });
    }
    expect(await f.app.externalCensus()).toMatchObject({ complete: false, pendingWrites: 0 });
    expect(await f.app.status()).toMatchObject({
      known: false,
      blockingReasons: expect.arrayContaining(remaining),
    });
    await f.permission.drain();
    await f.cache.mongoCacheMaintenance.drain();
  });

  it('preserves the original cache hold when actual App cancellation reopens Auth first', async () => {
    const f = owners();
    const gate = deferred();
    const original = f.auth.run(undefined, async () => {
      await gate.promise;
      return f.bans.set('original', 1);
    });
    const { Keyv } = jest.requireActual('keyv');
    const domains = f.cache.ownMongoCache(
      new Keyv({ store: f.cache.default, namespace: 'domains' }),
      'domains',
    );
    f.collection.findOne.mockRejectedValueOnce(new Error('domain read unknown'));
    try {
      await f.cache.runMongoDomainParser(() => domains.get('unknown'));
      expect(
        await f.cache.mongoCacheMaintenance.maintenance.getMaintenanceCensus(null),
      ).toMatchObject({
        complete: false,
      });
      expect(await f.auth.getMaintenanceCensus(null)).toMatchObject({ complete: true });
      expect(f.app.operation('begin', f.request())).toBe(200);
      expect(f.app.operation('cancel', f.request('op', 1))).toBe(503);
      expect(await f.auth.getMaintenanceCensus('op')).toMatchObject({ admissionClosed: false });
      await expect(f.auth.run(undefined, () => f.bans.set('gap', 1))).rejects.toThrow(
        'APP_QUIESCING',
      );
      expect(f.collection.updateOne).not.toHaveBeenCalled();
      gate.resolve();
      await original;
      expect(f.collection.updateOne).toHaveBeenCalledTimes(1);
      expect(await f.app.status()).toMatchObject({
        known: false,
        requestId: 'op',
        blockingReasons: expect.arrayContaining(remaining),
      });
    } finally {
      gate.resolve();
      await original;
      await f.retry.stop();
      await f.permission.drain();
      await expect(f.cache.mongoCacheMaintenance.drain()).rejects.toThrow(
        'MONGO_CACHE_SETTLEMENT_UNCONFIRMED',
      );
    }
  });

  it('holds actual Permission/cache/retry admission until the same startup release and arms one retry timer', async () => {
    jest.useFakeTimers();
    const f = owners();
    const app = createAppMaintenance({ ...f.deps, startupAdmission: 'closed' });
    try {
      const state = await app.status();
      const action = jest.fn();
      expect(() => f.permission.run(action)).toThrow('APP_QUIESCING');
      await expect(f.auth.run(undefined, () => f.bans.get('closed'))).rejects.toThrow(
        'APP_QUIESCING',
      );
      await expect(f.retry.persist({ userId: 'user-a', serverName: 'server-a' })).rejects.toThrow();
      f.retry.start(async () => {});
      expect(f.storage.list).not.toHaveBeenCalled();
      expect(f.collection.findOne).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
      expect(
        app.operation('cancel', {
          identity: app.identity,
          requestId: state.requestId,
          expectedRevision: state.revision,
        }),
      ).toBe(200);
      await app.waitForStartupRelease(new AbortController().signal);
      await f.permission.run(action);
      await f.auth.run(undefined, () => f.bans.get('released'));
      expect(action).toHaveBeenCalledTimes(1);
      expect(f.collection.findOne).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(1);
      expect(f.registerShutdown.mock.calls.map((call: unknown[]) => call[0])).toEqual([
        'MCP authorization fence retry admissions',
        'MCP authorization fence retry worker',
      ]);
      expect(await app.status()).toMatchObject({
        known: false,
        blockingReasons: expect.arrayContaining(remaining),
      });
    } finally {
      await f.retry.stop();
      await f.permission.drain();
      await f.cache.mongoCacheMaintenance.drain();
      jest.useRealTimers();
    }
  });
});
