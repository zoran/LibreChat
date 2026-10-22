/// <reference types="jest" />
import http from 'http';
import {
  setupGracefulShutdown,
  requestGracefulShutdown,
  isShutdownInProgress,
  registerShutdownTask,
  getClusterShutdownBudgetMs,
  getRemainingShutdownMs,
  getShutdownElapsedMs,
  getShutdownSignal,
  __resetShutdownStateForTests,
} from './shutdown';

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const triggerSignal = (signal: NodeJS.Signals): void => {
  const listeners = process.listeners(signal) as NodeJS.SignalsListener[];
  listeners.forEach((listener) => listener(signal));
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('getClusterShutdownBudgetMs', () => {
  it('prefers the primary force-exit deadline over the worker timer', () => {
    expect(
      getClusterShutdownBudgetMs({
        deadlineAt: 14_000,
        forceExitMs: 30_000,
        remainingMs: 60_000,
        elapsedMs: 1_000,
        now: 10_000,
      }),
    ).toBe(4_000);
  });

  it('uses the elapsed estimate when the primary deadline was not received', () => {
    expect(
      getClusterShutdownBudgetMs({
        deadlineAt: null,
        forceExitMs: 30_000,
        remainingMs: 60_000,
        elapsedMs: 2_000,
      }),
    ).toBe(28_000);
  });

  it('honors the tighter local limit and requires an active shutdown', () => {
    expect(
      getClusterShutdownBudgetMs({
        deadlineAt: 15_000,
        forceExitMs: 30_000,
        remainingMs: 1_000,
        elapsedMs: 5_000,
        now: 10_000,
      }),
    ).toBe(1_000);
    expect(
      getClusterShutdownBudgetMs({
        deadlineAt: 15_000,
        forceExitMs: 30_000,
        remainingMs: null,
        elapsedMs: 5_000,
        now: 10_000,
      }),
    ).toBeNull();
  });
});

describe('setupGracefulShutdown', () => {
  let server: http.Server;
  let exitSpy: jest.SpyInstance;
  let originalSigterm: NodeJS.SignalsListener[];
  let originalSigint: NodeJS.SignalsListener[];
  let originalSigquit: NodeJS.SignalsListener[];
  let originalSighup: NodeJS.SignalsListener[];

  beforeEach(() => {
    server = http.createServer();
    // Most tests exercise the close path, so we fake `listening` to true.
    // Tests that want to exercise the not-listening short-circuit override
    // this back to false.
    Object.defineProperty(server, 'listening', { value: true, configurable: true });
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    originalSigterm = process.listeners('SIGTERM').slice() as NodeJS.SignalsListener[];
    originalSigint = process.listeners('SIGINT').slice() as NodeJS.SignalsListener[];
    originalSigquit = process.listeners('SIGQUIT').slice() as NodeJS.SignalsListener[];
    originalSighup = process.listeners('SIGHUP').slice() as NodeJS.SignalsListener[];
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGQUIT');
    process.removeAllListeners('SIGHUP');
    __resetShutdownStateForTests();
  });

  afterEach(() => {
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGQUIT');
    process.removeAllListeners('SIGHUP');
    originalSigterm.forEach((listener) => process.on('SIGTERM', listener));
    originalSigint.forEach((listener) => process.on('SIGINT', listener));
    originalSigquit.forEach((listener) => process.on('SIGQUIT', listener));
    originalSighup.forEach((listener) => process.on('SIGHUP', listener));
    exitSpy.mockRestore();
    if (server.listening) {
      server.close();
    }
    __resetShutdownStateForTests();
    jest.useRealTimers();
  });

  it('initializes without a listener and attaches exactly one actual server', () => {
    const options = { timeoutMs: 120_000, deferHttpCloseUntilPreDrain: true };
    setupGracefulShutdown(null, options);
    setupGracefulShutdown(null, options);
    expect(process.listenerCount('SIGTERM')).toBe(1);
    setupGracefulShutdown(server, options);
    setupGracefulShutdown(server, options);
    setupGracefulShutdown(null, options);
    expect(process.listenerCount('SIGTERM')).toBe(1);
    expect(() => setupGracefulShutdown(http.createServer(), options)).toThrow();
    expect(() => setupGracefulShutdown(null, { timeoutMs: 60_000 })).toThrow();
    expect(getRemainingShutdownMs()).toBeNull();
  });

  it.each([undefined, {}, { close: () => undefined }])(
    'rejects an implicit or fabricated listener %s before registering an owner',
    (value) => {
      expect(() => setupGracefulShutdown(value as never)).toThrow();
      expect(process.listenerCount('SIGTERM')).toBe(0);
      expect(getShutdownSignal().aborted).toBe(false);
    },
  );

  it('rejects unconfigured or invalid startup failure requests', () => {
    expect(() => requestGracefulShutdown('startup_failure')).toThrow();
    setupGracefulShutdown(null);
    expect(() => requestGracefulShutdown('SIGTERM' as never)).toThrow();
    expect(getShutdownSignal().aborted).toBe(false);
  });

  it('retains the exact startup failure promise through reentrant abort and original acquisition', async () => {
    let release!: () => void;
    const original = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = jest.fn();
    registerShutdownTask(
      'acquisition',
      async () => {
        await original;
        close();
      },
      { phase: 'pre-drain' },
    );
    setupGracefulShutdown(null, { timeoutMs: 120_000, deferHttpCloseUntilPreDrain: true });
    let reentrant: Promise<void> | undefined;
    getShutdownSignal().addEventListener('abort', () => {
      reentrant = requestGracefulShutdown('startup_failure');
    });
    const pending = requestGracefulShutdown('startup_failure');
    expect(reentrant).toBe(pending);
    expect(requestGracefulShutdown('startup_failure')).toBe(pending);
    expect(close).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(() =>
      setupGracefulShutdown(server, { timeoutMs: 120_000, deferHttpCloseUntilPreDrain: true }),
    ).toThrow();
    expect(() => registerShutdownTask('late acquisition', close)).toThrow();
    release();
    await pending;
    expect(close).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('promotes a signal-driven shutdown to failure without replacing its promise or deadline', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    let release!: () => void;
    const original = new Promise<void>((resolve) => {
      release = resolve;
    });
    registerShutdownTask('acquisition', () => original, { phase: 'pre-drain' });
    setupGracefulShutdown(null, { timeoutMs: 120_000, deferHttpCloseUntilPreDrain: true });
    triggerSignal('SIGTERM');
    jest.advanceTimersByTime(30_000);
    const pending = requestGracefulShutdown('startup_failure');
    triggerSignal('SIGINT');
    expect(requestGracefulShutdown('startup_failure')).toBe(pending);
    expect(getRemainingShutdownMs()).toBe(90_000);
    expect(jest.getTimerCount()).toBe(1);
    release();
    await pending;
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps unresolved startup failure pending until the original force deadline', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    registerShutdownTask(
      'failed original',
      async () => {
        throw new Error('Unknown custody');
      },
      { phase: 'pre-drain' },
    );
    const destructive = jest.fn();
    registerShutdownTask('destructive close', destructive);
    setupGracefulShutdown(null, { timeoutMs: 120_000, deferHttpCloseUntilPreDrain: true });
    let resolved = false;
    const pending = requestGracefulShutdown('startup_failure');
    void pending.then(() => {
      resolved = true;
    });
    await flush();
    jest.advanceTimersByTime(119_999);
    triggerSignal('SIGTERM');
    expect(requestGracefulShutdown('startup_failure')).toBe(pending);
    expect(getRemainingShutdownMs()).toBe(1);
    expect(resolved).toBe(false);
    expect(destructive).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(resolved).toBe(false);
  });

  it('registers handlers for SIGTERM, SIGINT, SIGQUIT, and SIGHUP', () => {
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGQUIT', 'SIGHUP'] as NodeJS.Signals[]) {
      expect(process.listenerCount(signal)).toBe(0);
    }
    setupGracefulShutdown(server);
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGQUIT', 'SIGHUP'] as NodeJS.Signals[]) {
      expect(process.listenerCount(signal)).toBe(1);
    }
  });

  it('closes the server and exits 0 on SIGTERM', async () => {
    const closeSpy = jest
      .spyOn(server, 'close')
      .mockImplementation((cb?: (err?: Error) => void) => {
        if (cb) {
          setImmediate(() => cb());
        }
        return server;
      });
    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    await flush();
    await flush();
    expect(closeSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('closes the server and exits 0 on SIGINT', async () => {
    const closeSpy = jest
      .spyOn(server, 'close')
      .mockImplementation((cb?: (err?: Error) => void) => {
        if (cb) {
          setImmediate(() => cb());
        }
        return server;
      });
    setupGracefulShutdown(server);
    triggerSignal('SIGINT');
    await flush();
    await flush();
    expect(closeSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('exits 1 if server.close yields an error', async () => {
    const closeErr = new Error('close failed');
    jest.spyOn(server, 'close').mockImplementation((cb?: (err?: Error) => void) => {
      if (cb) {
        setImmediate(() => cb(closeErr));
      }
      return server;
    });
    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    await flush();
    await flush();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('treats ERR_SERVER_NOT_RUNNING from close() as a successful shutdown', async () => {
    const notRunning: NodeJS.ErrnoException = Object.assign(new Error('Server is not running.'), {
      code: 'ERR_SERVER_NOT_RUNNING',
    });
    // Force listening=true so the pre-check doesn't short-circuit;
    // we want to exercise the post-check that ignores ERR_SERVER_NOT_RUNNING.
    Object.defineProperty(server, 'listening', { value: true, configurable: true });
    jest.spyOn(server, 'close').mockImplementation((cb?: (err?: Error) => void) => {
      if (cb) {
        setImmediate(() => cb(notRunning));
      }
      return server;
    });
    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    await flush();
    await flush();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('skips close() entirely when the server is not listening yet', async () => {
    // SIGTERM during the startup window (before app.listen finishes binding
    // the socket) must not be treated as a failed shutdown.
    Object.defineProperty(server, 'listening', { value: false, configurable: true });
    const closeSpy = jest.spyOn(server, 'close');
    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    await flush();
    expect(closeSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('is idempotent — a second signal does not trigger another shutdown', async () => {
    const closeSpy = jest.spyOn(server, 'close');
    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    triggerSignal('SIGTERM');
    await flush();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('exposes shutdown state before pre-drain work begins', async () => {
    let observedDuringPreDrain = false;
    jest.spyOn(server, 'close').mockImplementation(() => server);
    registerShutdownTask(
      'observe-shutdown',
      () => {
        observedDuringPreDrain = isShutdownInProgress();
      },
      { phase: 'pre-drain' },
    );
    setupGracefulShutdown(server);

    expect(isShutdownInProgress()).toBe(false);
    triggerSignal('SIGTERM');
    await flush();

    expect(observedDuringPreDrain).toBe(true);
    expect(isShutdownInProgress()).toBe(true);
  });

  it('force-exits with code 1 if shutdown exceeds the timeout', () => {
    jest.useFakeTimers();
    jest.spyOn(server, 'close').mockImplementation(() => server);
    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    jest.advanceTimersByTime(60_000);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('keeps the explicit 120-second deadline after options mutation and repeated setup', () => {
    jest.useFakeTimers();
    jest.spyOn(server, 'close').mockImplementation(() => server);
    const options = { timeoutMs: 120_000 };
    setupGracefulShutdown(server, options);
    options.timeoutMs = 1;
    expect(getRemainingShutdownMs()).toBeNull();
    triggerSignal('SIGTERM');
    expect(getRemainingShutdownMs()).toBe(120_000);
    jest.advanceTimersByTime(60_000);
    expect(getRemainingShutdownMs()).toBe(60_000);
    expect(exitSpy).not.toHaveBeenCalled();
    setupGracefulShutdown(server, { timeoutMs: 120_000 });
    triggerSignal('SIGINT');
    expect(getShutdownElapsedMs()).toBe(60_000);
    jest.advanceTimersByTime(59_999);
    expect(getRemainingShutdownMs()).toBe(1);
    expect(exitSpy).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(getRemainingShutdownMs()).toBe(0);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity, 120_001, '120000', null])(
    'rejects an invalid shutdown timeout %s before registering any owner',
    (timeoutMs) => {
      expect(() => setupGracefulShutdown(server, { timeoutMs: timeoutMs as number })).toThrow();
      for (const signal of ['SIGTERM', 'SIGINT', 'SIGQUIT', 'SIGHUP'] as NodeJS.Signals[])
        expect(process.listenerCount(signal)).toBe(0);
      expect(getRemainingShutdownMs()).toBeNull();
      expect(isShutdownInProgress()).toBe(false);
      expect(() => setupGracefulShutdown(server)).not.toThrow();
    },
  );

  it('selects the server and budget once and never extends an active default deadline', () => {
    jest.useFakeTimers();
    const close = jest.spyOn(server, 'close').mockImplementation(() => server);
    setupGracefulShutdown(server);
    setupGracefulShutdown(server);
    expect(process.listenerCount('SIGTERM')).toBe(1);
    expect(() => setupGracefulShutdown(server, { timeoutMs: 120_000 })).toThrow();
    expect(() => setupGracefulShutdown(server, { deferHttpCloseUntilPreDrain: true })).toThrow();
    const replacement = http.createServer();
    expect(() => setupGracefulShutdown(replacement)).toThrow();
    triggerSignal('SIGTERM');
    expect(getRemainingShutdownMs()).toBe(60_000);
    jest.advanceTimersByTime(30_000);
    expect(() => setupGracefulShutdown(server, { timeoutMs: 120_000 })).toThrow();
    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    expect(getRemainingShutdownMs()).toBe(30_000);
    expect(close).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(30_000);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('keeps a real observation listener open until original deferred pre-drain work settles', async () => {
    Reflect.deleteProperty(server, 'listening');
    server.on('request', (_req, res) => res.end('observed'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    let settle!: () => void;
    const original = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const postDrain = jest.fn();
    registerShutdownTask('original custody', () => original, { phase: 'pre-drain' });
    registerShutdownTask('destructive close', postDrain);
    setupGracefulShutdown(server, { timeoutMs: 120_000, deferHttpCloseUntilPreDrain: true });
    triggerSignal('SIGTERM');
    await flush();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: address.port, agent: false }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        })
        .on('error', reject);
    });
    expect(status).toBe(200);
    expect(postDrain).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    settle();
    await flush();
    await flush();
    expect(server.listening).toBe(false);
    expect(postDrain).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('retains failed deferred custody and the original deadline without destructive post-drain', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const close = jest.spyOn(server, 'close');
    const postDrain = jest.fn();
    registerShutdownTask(
      'unresolved custody',
      async () => {
        throw new Error('Unresolved');
      },
      { phase: 'pre-drain' },
    );
    registerShutdownTask('destructive close', postDrain);
    const options = { timeoutMs: 120_000, deferHttpCloseUntilPreDrain: true };
    setupGracefulShutdown(server, options);
    options.deferHttpCloseUntilPreDrain = false;
    triggerSignal('SIGTERM');
    await flush();
    expect(close).not.toHaveBeenCalled();
    expect(postDrain).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
    jest.advanceTimersByTime(105_000);
    setupGracefulShutdown(server, { timeoutMs: 120_000, deferHttpCloseUntilPreDrain: true });
    triggerSignal('SIGINT');
    expect(getRemainingShutdownMs()).toBe(15_000);
    jest.advanceTimersByTime(14_999);
    expect(exitSpy).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(close).not.toHaveBeenCalled();
    expect(postDrain).not.toHaveBeenCalled();
  });

  it.each(['true', null])(
    'rejects a nonboolean HTTP ordering option %s before registering an owner',
    (deferred) => {
      expect(() =>
        setupGracefulShutdown(server, { deferHttpCloseUntilPreDrain: deferred as never }),
      ).toThrow();
      expect(process.listenerCount('SIGTERM')).toBe(0);
    },
  );

  it('keeps the original deferred failure deadline referenced without a listening socket', async () => {
    Object.defineProperty(server, 'listening', { value: false, configurable: true });
    const timer = jest.spyOn(global, 'setTimeout');
    registerShutdownTask(
      'failed startup custody',
      async () => {
        throw new Error('Unresolved');
      },
      { phase: 'pre-drain' },
    );
    setupGracefulShutdown(server, { timeoutMs: 120_000, deferHttpCloseUntilPreDrain: true });
    triggerSignal('SIGTERM');
    await flush();
    expect(timer).toHaveBeenCalledTimes(1);
    expect((timer.mock.results[0].value as NodeJS.Timeout).hasRef()).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
    timer.mockRestore();
  });

  it('awaits the original task through the custom budget and leaves the close reserve intact', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    jest.spyOn(server, 'close').mockImplementation((cb?: (err?: Error) => void) => {
      cb?.();
      return server;
    });
    let settle: (() => void) | undefined;
    const original = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const postDrain = jest.fn();
    registerShutdownTask('original effect', () => original, { phase: 'pre-drain' });
    registerShutdownTask('close resources', postDrain);
    setupGracefulShutdown(server, { timeoutMs: 120_000 });
    triggerSignal('SIGTERM');
    jest.advanceTimersByTime(105_000);
    await flush();
    expect(getShutdownSignal().aborted).toBe(true);
    expect(getRemainingShutdownMs()).toBe(15_000);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(postDrain).not.toHaveBeenCalled();
    settle?.();
    await flush();
    await flush();
    expect(postDrain).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
    jest.advanceTimersByTime(15_000);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
  });

  it('charges synchronous cancellation work to the original shutdown deadline', () => {
    jest.useFakeTimers();
    jest.spyOn(server, 'close').mockImplementation(() => server);
    getShutdownSignal().addEventListener('abort', () => jest.advanceTimersByTime(1_000));
    setupGracefulShutdown(server, { timeoutMs: 120_000 });
    triggerSignal('SIGTERM');
    expect(getShutdownElapsedMs()).toBe(1_000);
    expect(getRemainingShutdownMs()).toBe(119_000);
    jest.advanceTimersByTime(118_999);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(getRemainingShutdownMs()).toBe(1);
    jest.advanceTimersByTime(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('resets the custom budget, deadline and only its own signal handlers', () => {
    jest.useFakeTimers();
    jest.spyOn(server, 'close').mockImplementation(() => server);
    const foreign = jest.fn();
    process.on('SIGTERM', foreign);
    setupGracefulShutdown(server, { timeoutMs: 120_000 });
    const oldSignal = getShutdownSignal();
    triggerSignal('SIGTERM');
    jest.advanceTimersByTime(1_000);
    __resetShutdownStateForTests();
    expect(process.listeners('SIGTERM')).toEqual([foreign]);
    expect(getRemainingShutdownMs()).toBeNull();
    expect(getShutdownElapsedMs()).toBeNull();
    expect(getShutdownSignal()).not.toBe(oldSignal);
    expect(getShutdownSignal().aborted).toBe(false);
    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    expect(getRemainingShutdownMs()).toBe(60_000);
    jest.advanceTimersByTime(60_000);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    __resetShutdownStateForTests();
    jest.advanceTimersByTime(120_000);
    expect(exitSpy).toHaveBeenCalledTimes(1);
    process.off('SIGTERM', foreign);
  });

  it('runs registered tasks after server.close and before exit', async () => {
    const calls: string[] = [];
    jest.spyOn(server, 'close').mockImplementation((cb?: (err?: Error) => void) => {
      calls.push('server.close');
      if (cb) {
        setImmediate(() => cb());
      }
      return server;
    });
    registerShutdownTask('task-a', () => {
      calls.push('task-a');
    });
    registerShutdownTask('task-b', () => {
      calls.push('task-b');
    });
    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    await flush();
    await flush();
    expect(calls).toEqual(['server.close', 'task-a', 'task-b']);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('runs pre-drain tasks while server.close is pending, then post-drain tasks', async () => {
    const calls: string[] = [];
    let finishClose: (() => void) | undefined;
    jest.spyOn(server, 'close').mockImplementation((cb?: (err?: Error) => void) => {
      calls.push('server.close');
      finishClose = () => cb?.();
      return server;
    });
    registerShutdownTask(
      'release-held-close',
      () => {
        calls.push('pre-drain');
        finishClose?.();
      },
      { phase: 'pre-drain' },
    );
    registerShutdownTask('post-drain', () => {
      calls.push('post-drain');
    });

    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    await flush();
    await flush();

    expect(calls).toEqual(['server.close', 'pre-drain', 'post-drain']);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('runs tasks in registration order', async () => {
    const order: string[] = [];
    jest.spyOn(server, 'close').mockImplementation((cb?: (err?: Error) => void) => {
      if (cb) {
        setImmediate(() => cb());
      }
      return server;
    });
    ['first', 'second', 'third'].forEach((name) => {
      registerShutdownTask(name, () => {
        order.push(name);
      });
    });
    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    await flush();
    await flush();
    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('runs higher-priority cleanup before telemetry while preserving ties', async () => {
    const order: string[] = [];
    jest.spyOn(server, 'close').mockImplementation((cb?: (err?: Error) => void) => {
      if (cb) {
        setImmediate(() => cb());
      }
      return server;
    });
    registerShutdownTask('default-first', () => {
      order.push('default-first');
    });
    registerShutdownTask(
      'telemetry',
      () => {
        order.push('telemetry');
      },
      { priority: -100 },
    );
    registerShutdownTask(
      'generation streams',
      () => {
        order.push('generation streams');
      },
      {
        priority: 100,
      },
    );
    registerShutdownTask('default-second', () => {
      order.push('default-second');
    });

    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    await flush();
    await flush();

    expect(order).toEqual(['generation streams', 'default-first', 'default-second', 'telemetry']);
  });

  it('continues subsequent tasks and exits nonzero if one task throws', async () => {
    const calls: string[] = [];
    jest.spyOn(server, 'close').mockImplementation((cb?: (err?: Error) => void) => {
      if (cb) {
        setImmediate(() => cb());
      }
      return server;
    });
    registerShutdownTask('ok-before', () => {
      calls.push('ok-before');
    });
    registerShutdownTask('throws', () => {
      calls.push('throws');
      throw new Error('boom');
    });
    registerShutdownTask('ok-after', () => {
      calls.push('ok-after');
    });
    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    await flush();
    await flush();
    expect(calls).toEqual(['ok-before', 'throws', 'ok-after']);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('awaits async tasks before exiting', async () => {
    const calls: string[] = [];
    jest.spyOn(server, 'close').mockImplementation((cb?: (err?: Error) => void) => {
      if (cb) {
        setImmediate(() => cb());
      }
      return server;
    });
    registerShutdownTask('async-task', async () => {
      await new Promise((resolve) => setImmediate(resolve));
      calls.push('async-done');
    });
    setupGracefulShutdown(server);
    triggerSignal('SIGTERM');
    await flush();
    await flush();
    await flush();
    expect(calls).toEqual(['async-done']);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
  it('disarms the force-exit timer when shutdown state is reset', async () => {
    jest.useFakeTimers();
    try {
      // A drain that never settles: the server close callback is never invoked,
      // so `shutdown` stays awaiting and never reaches its own `clearTimeout`.
      jest.spyOn(server, 'close').mockImplementation(() => server);
      setupGracefulShutdown(server);
      triggerSignal('SIGTERM');
      await Promise.resolve();

      // The safety net is armed and would exit the process on its own.
      __resetShutdownStateForTests();
      jest.advanceTimersByTime(120_000);

      // Without the reset clearing it, this timer fires long after the suite
      // that armed it has finished, killing the run with code 1.
      expect(exitSpy).not.toHaveBeenCalledWith(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps a later shutdown's safety net when an earlier drain settles late", async () => {
    // `setImmediate` stays real so the first shutdown's continuation can actually
    // reach its `finally`; only the force-exit timer is faked.
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      let releaseFirstClose: (() => void) | undefined;
      jest.spyOn(server, 'close').mockImplementation((cb?: (err?: Error) => void) => {
        if (cb) {
          releaseFirstClose = () => cb();
        }
        return server;
      });
      setupGracefulShutdown(server);
      triggerSignal('SIGTERM');
      await flush();

      // A second shutdown arms its own net after the first is reset away.
      __resetShutdownStateForTests();
      const secondServer = http.createServer();
      Object.defineProperty(secondServer, 'listening', { value: true, configurable: true });
      jest.spyOn(secondServer, 'close').mockImplementation(() => secondServer);
      setupGracefulShutdown(secondServer);
      triggerSignal('SIGTERM');
      await flush();

      // The first drain settles only now; its `finally` must not disarm the second.
      releaseFirstClose?.();
      await flush();
      await flush();
      await flush();

      jest.advanceTimersByTime(120_000);
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
