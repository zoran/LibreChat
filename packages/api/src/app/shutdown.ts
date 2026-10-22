import { Server } from 'http';
import { logger } from '@librechat/data-schemas';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 60_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 120_000;
const SIGNALS: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGQUIT', 'SIGHUP'];

export type ShutdownPhase = 'pre-drain' | 'post-drain';

export type GracefulShutdownOptions = {
  /** Selected once before shutdown; a positive integer bounded to two minutes. */
  timeoutMs?: number;
  /** Observation-only listeners stay open until original pre-drain custody settles. */
  deferHttpCloseUntilPreDrain?: boolean;
};

export type ShutdownTaskOptions = {
  priority?: number;
  phase?: ShutdownPhase;
};

type ShutdownTask = {
  name: string;
  fn: () => void | Promise<void>;
  phase: ShutdownPhase;
  priority: number;
  registrationOrder: number;
};

const tasks: ShutdownTask[] = [];
let nextRegistrationOrder = 0;
let isShuttingDown = false;
let shutdownController = new AbortController();

/** Cancels fail-closed dependency waits when process shutdown begins. */
export function getShutdownSignal(): AbortSignal {
  return shutdownController.signal;
}
let configured = false;
let httpServer: Server | null = null;
type ShutdownRun = {
  promise: Promise<void>;
  failure: boolean;
  forceExit: NodeJS.Timeout | null;
};
let shutdownRun: ShutdownRun | null = null;
let forceExitTimer: NodeJS.Timeout | null = null;
let shutdownStartedAt: number | null = null;
let shutdownDeadlineAt: number | null = null;
let shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS;
let deferHttpCloseUntilPreDrain = false;
const signalHandlers = new Map<NodeJS.Signals, () => void>();

/**
 * Register a cleanup task for graceful shutdown. Post-drain is the default phase.
 * Higher-priority tasks run first; tasks at the same priority retain registration order.
 * If one throws, subsequent tasks and the final exit are not blocked. Use this instead of
 * attaching `process.on('SIGTERM', ...)` handlers directly — multiple competing signal
 * handlers race with the HTTP drain because Node dispatches listeners in registration order
 * and any one of them can call `process.exit` before the HTTP server has finished closing.
 */
export function registerShutdownTask(
  name: string,
  fn: () => void | Promise<void>,
  options: ShutdownTaskOptions = {},
): void {
  if (isShuttingDown) throw new Error('Cannot register shutdown work after shutdown begins');
  const phase: ShutdownPhase = options.phase === 'pre-drain' ? 'pre-drain' : 'post-drain';
  const priority = Number.isFinite(options.priority) ? (options.priority ?? 0) : 0;
  tasks.push({ name, fn, phase, priority, registrationOrder: nextRegistrationOrder++ });
}

/** Whether graceful shutdown has started, for admission paths that must fail closed. */
/**
 * Milliseconds left before graceful shutdown force-exits, or `null` when not shutting down.
 * Lets a shutdown task spend the budget it actually has instead of guessing at a fixed cutoff.
 */
/**
 * Milliseconds since graceful shutdown began, or `null` when not shutting down. For a task whose
 * real deadline is imposed from outside this process — a cluster primary that force-exits the
 * whole group on its own timer — this is what lets it measure against that deadline instead.
 */
export function getShutdownElapsedMs(): number | null {
  if (shutdownStartedAt == null) {
    return null;
  }
  return Math.max(0, Date.now() - shutdownStartedAt);
}

export function getRemainingShutdownMs(): number | null {
  if (shutdownDeadlineAt == null) {
    return null;
  }
  return Math.max(0, shutdownDeadlineAt - Date.now());
}

export function getClusterShutdownBudgetMs({
  deadlineAt,
  forceExitMs,
  remainingMs = getRemainingShutdownMs(),
  elapsedMs = getShutdownElapsedMs(),
  now = Date.now(),
}: {
  deadlineAt: number | null;
  forceExitMs: number;
  remainingMs?: number | null;
  elapsedMs?: number | null;
  now?: number;
}): number | null {
  if (remainingMs == null || elapsedMs == null) {
    return null;
  }
  return Math.min(remainingMs, deadlineAt == null ? forceExitMs - elapsedMs : deadlineAt - now);
}

export function isShutdownInProgress(): boolean {
  return isShuttingDown;
}

/**
 * Wires SIGTERM, SIGINT, SIGQUIT, and SIGHUP to a graceful shutdown
 * sequence: by default initiate HTTP server close to stop accepting new connections,
 * run pre-drain tasks while in-flight requests settle, await the HTTP drain,
 * run post-drain tasks, then `process.exit(0)`. After
 * the selected timeout (60 seconds by default) the process is force-exited with code 1 — a
 * safety net for long-lived connections such as SSE streams that may
 * not finish in time. Observation-only listeners may defer HTTP close until successful
 * pre-drain settlement; failure retains the listener and original force-exit deadline.
 * Explicit null initializes acquisition custody; one later real listener may attach before shutdown.
 */
export function setupGracefulShutdown(
  server: Server | null,
  options: GracefulShutdownOptions = {},
): void {
  if (server !== null && !(server instanceof Server))
    throw new Error('Graceful shutdown requires a real server or explicit null');
  const timeoutMs =
    options.timeoutMs === undefined ? DEFAULT_SHUTDOWN_TIMEOUT_MS : options.timeoutMs;
  const deferred =
    options.deferHttpCloseUntilPreDrain === undefined ? false : options.deferHttpCloseUntilPreDrain;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_SHUTDOWN_TIMEOUT_MS) {
    throw new Error('Invalid graceful shutdown timeout');
  }
  if (typeof deferred !== 'boolean') throw new Error('Invalid graceful shutdown HTTP ordering');
  if (configured) {
    if (shutdownTimeoutMs !== timeoutMs || deferHttpCloseUntilPreDrain !== deferred)
      throw new Error('Graceful shutdown is already configured');
    if (server === null || server === httpServer) return;
    if (isShuttingDown) throw new Error('Cannot attach a listener after shutdown begins');
    if (httpServer !== null) throw new Error('Graceful shutdown already has a listener');
    httpServer = server;
    return;
  }
  configured = true;
  httpServer = server;
  shutdownTimeoutMs = timeoutMs;
  deferHttpCloseUntilPreDrain = deferred;
  for (const signal of SIGNALS) {
    const listener = () => {
      void beginShutdown(signal);
    };
    signalHandlers.set(signal, listener);
    process.on(signal, listener);
  }
}

/**
 * @internal Reset module state for tests. Not part of the public API.
 */
export function __resetShutdownStateForTests(): void {
  tasks.length = 0;
  nextRegistrationOrder = 0;
  isShuttingDown = false;
  shutdownController = new AbortController();
  shutdownStartedAt = null;
  shutdownDeadlineAt = null;
  shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS;
  deferHttpCloseUntilPreDrain = false;
  configured = false;
  httpServer = null;
  shutdownRun = null;
  for (const [signal, listener] of signalHandlers) process.off(signal, listener);
  signalHandlers.clear();
  // Unsettled startup custody may keep this timer referenced without another live handle.
  // Reset only this owner's timer; late settlement cannot disarm a later shutdown.
  clearForceExitTimer();
}

async function runShutdownTasks(phase: ShutdownPhase): Promise<boolean> {
  const orderedTasks = tasks
    .filter((task) => task.phase === phase)
    .sort(
      (left, right) =>
        right.priority - left.priority || left.registrationOrder - right.registrationOrder,
    );

  let failed = false;
  for (const task of orderedTasks) {
    try {
      logger.info(`Running ${phase} shutdown task: ${task.name}`);
      await task.fn();
    } catch (err) {
      failed = true;
      logger.error(`Shutdown task "${task.name}" failed:`, err);
    }
  }
  return failed;
}

function clearForceExitTimer(): void {
  if (forceExitTimer) {
    clearTimeout(forceExitTimer);
    forceExitTimer = null;
  }
}

/** Startup failure joins the original sequence and only promotes its exit to failure.
 * The same promise remains pending while unresolved custody waits for the force-exit deadline. */
export function requestGracefulShutdown(reason: 'startup_failure'): Promise<void> {
  if (reason !== 'startup_failure') throw new Error('Invalid graceful shutdown request');
  return beginShutdown(reason);
}

function beginShutdown(reason: NodeJS.Signals | 'startup_failure'): Promise<void> {
  if (!configured) throw new Error('Graceful shutdown is not configured');
  if (shutdownRun) {
    if (reason === 'startup_failure') {
      shutdownRun.failure = true;
      shutdownRun.forceExit?.ref();
    }
    return shutdownRun.promise;
  }
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const run: ShutdownRun = {
    promise: new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    }),
    failure: reason === 'startup_failure',
    forceExit: null,
  };
  // Publish before synchronous abort callbacks can reenter this owner.
  shutdownRun = run;
  isShuttingDown = true;
  void shutdown(reason, run).then(resolve, reject);
  return run.promise;
}

async function shutdown(
  reason: NodeJS.Signals | 'startup_failure',
  run: ShutdownRun,
): Promise<void> {
  shutdownStartedAt = Date.now();
  const timeoutMs = shutdownTimeoutMs;
  const selectedServer = httpServer;
  const deferred = deferHttpCloseUntilPreDrain;
  const deadlineAt = shutdownStartedAt + timeoutMs;
  shutdownDeadlineAt = deadlineAt;
  shutdownController.abort();
  logger.info(`Received ${reason}, draining HTTP server...`);

  /** Owned locally so a late `finally` from a superseded drain cannot clear the
   *  safety net belonging to a shutdown that started after it. */
  const forceExit = setTimeout(
    () => {
      logger.warn(`Graceful shutdown exceeded ${timeoutMs}ms, forcing exit`);
      process.exit(1);
    },
    Math.max(0, deadlineAt - Date.now()),
  );
  // A pending acquisition promise may have no socket to keep the process alive.
  if (selectedServer !== null && !deferred && !run.failure) forceExit.unref();
  run.forceExit = forceExit;
  forceExitTimer = forceExit;

  let exitCode = 0;
  let retainDeadline = false;

  try {
    if (deferred && (await runShutdownTasks('pre-drain'))) {
      // Failure is still observable uncertainty. Keep this original force-exit deadline,
      // the observation listener and resources; no destructive post-drain task may run.
      retainDeadline = true;
      // Partial startup may have no live socket; retain this same timer rather than exit cleanly.
      forceExit.ref();
      logger.error('Pre-drain custody unresolved; retaining observation until shutdown deadline');
      return await new Promise<void>(() => {});
    }
    const serverClosePromise = closeHttpServer(selectedServer).catch((err) => {
      logger.error('Error closing HTTP server during graceful shutdown:', err);
      exitCode = 1;
    });

    if (!deferred && (await runShutdownTasks('pre-drain'))) exitCode = 1;
    await serverClosePromise;
    if (await runShutdownTasks('post-drain')) exitCode = 1;
  } finally {
    if (!retainDeadline) clearTimeout(forceExit);
    if (!retainDeadline && forceExitTimer === forceExit) {
      forceExitTimer = null;
    }
  }

  logger.info('Graceful shutdown complete, exiting');
  process.exit(run.failure ? 1 : exitCode);
}

function closeHttpServer(server: Server | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server || !server.listening) {
      // SIGTERM can arrive during startup before the listen socket is open,
      // in which case there is nothing to drain. Node also surfaces this as
      // an ERR_SERVER_NOT_RUNNING error in the close callback — treated
      // below as a successful close so a routine shutdown doesn't trip
      // orchestrator restart/backoff with exit code 1.
      resolve();
      return;
    }
    server.close((err) => {
      if (!err || (err as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') {
        resolve();
        return;
      }
      reject(err);
    });
  });
}
