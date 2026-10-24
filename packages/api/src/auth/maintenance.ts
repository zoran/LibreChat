/** Request/continuation lifetime for legacy authentication. Identity and persistence stay external. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthContinuationObserver } from '@librechat/data-schemas';
import type { RequestHandler, Response } from 'express';
import type { ApplicationWorkPort } from '~/app';

interface AuthCallbackOptions<T> {
  write?: boolean;
  complete?: (this: unknown, error?: unknown, value?: T, ...rest: unknown[]) => unknown;
}

export interface AuthOperation extends AuthContinuationObserver {
  /** Register before invocation, including work whose rejection its consumer will sanitize. */
  track<T>(action: () => Promise<T> | T): Promise<T>;
  /** Callback APIs must complete through their actual callback; abort/timeout is not settlement. */
  callback<T>(
    start: (done: (error?: unknown, value?: T, ...rest: unknown[]) => unknown) => unknown,
    options?: AuthCallbackOptions<T>,
  ): Promise<T>;
}
export interface AuthMaintenance extends ApplicationWorkPort {
  admissionMiddleware: RequestHandler;
  current(): AuthOperation | undefined;
  /** Capture live original admissions once; membership cannot expand or outlive settlement. */
  snapshotAdmissions(): (operation: AuthOperation) => boolean;
  forRequest(req: object): AuthOperation | undefined;
  run<T>(req: object | undefined, action: (operation: AuthOperation) => Promise<T> | T): Promise<T>;
  own(handler: RequestHandler): RequestHandler;
  markUncertain(): void;
  stopAdmissions(): void;
  drain(): Promise<void>;
}

export function createAuthMaintenance(): AuthMaintenance {
  const context = new AsyncLocalStorage<AuthOperation>();
  const requests = new WeakMap<object, AuthOperation>();
  const live = new Set<AuthOperation>();
  const drained = new Set<() => void>();
  let pause: string | null = null;
  let stopped = false;
  let revision = 0;
  let writes = 0;
  let uncertain = false;

  function create() {
    if (stopped || pause !== null) throw Object.assign(new Error('APP_QUIESCING'), { status: 503 });
    let pending = 0;
    let rootComplete = false;
    const finish = () => {
      if (!rootComplete || pending !== 0) return;
      live.delete(operation);
      if (live.size === 0) {
        drained.forEach((resolve) => resolve());
        drained.clear();
      }
    };
    const operation: AuthOperation = {
      markUncertain() {
        uncertain = true;
      },
      async track(action) {
        if (!live.has(operation)) {
          uncertain = true;
          throw new Error('Authentication continuation used after settlement');
        }
        pending++;
        try {
          return await context.run(operation, action);
        } finally {
          pending--;
          finish();
        }
      },
      write(action) {
        return operation.track(async () => {
          writes++;
          try {
            return await action();
          } catch (error) {
            uncertain = true;
            throw error;
          } finally {
            writes--;
          }
        });
      },
      callback<T>(
        start: (done: (error?: unknown, value?: T, ...rest: unknown[]) => unknown) => unknown,
        options: AuthCallbackOptions<T> = {},
      ): Promise<T> {
        const retain = options.write === false ? operation.track : operation.write;
        return retain(
          () =>
            new Promise<T>((resolve, reject) => {
              const restore = AsyncLocalStorage.snapshot();
              let called = false;
              let returned = false;
              let originalDone = false;
              let deliveryDone = false;
              let value: T | undefined;
              let failed = false;
              let failure: unknown;
              const fail = (error: unknown) => {
                if (options.write !== false) uncertain = true;
                if (!failed) {
                  failed = true;
                  failure = error;
                }
              };
              const settle = () => {
                if (!returned || !originalDone || !deliveryDone) return;
                if (failed) reject(failure);
                else resolve(value as T);
              };
              const done = function (this: unknown, ...args: [unknown?, T?, ...unknown[]]) {
                if (called) return;
                called = true;
                if (args[0]) fail(args[0]);
                value = args[1];
                let delivered;
                try {
                  delivered = restore(() =>
                    context.run(operation, () => options.complete?.apply(this, args)),
                  );
                } catch (error) {
                  uncertain = true;
                  fail(error);
                  deliveryDone = true;
                  settle();
                  return;
                }
                void Promise.resolve(delivered).then(
                  () => {
                    deliveryDone = true;
                    settle();
                  },
                  (error) => {
                    uncertain = true;
                    fail(error);
                    deliveryDone = true;
                    settle();
                  },
                );
                return delivered;
              };
              Object.defineProperty(done, 'length', { value: options.complete?.length ?? 2 });
              let original;
              try {
                original = start(done);
              } catch (error) {
                fail(error);
                done(error);
              }
              returned = true;
              void Promise.resolve(original).then(
                () => {
                  originalDone = true;
                  settle();
                },
                (error) => {
                  fail(error);
                  // A rejected return cannot retire an original callback that has not arrived.
                  originalDone = true;
                  settle();
                },
              );
            }),
        );
      },
    };
    live.add(operation);
    return {
      operation,
      complete: () => {
        rootComplete = true;
        finish();
      },
    };
  }

  const admissionMiddleware: RequestHandler = (req, res, next) => {
    const existing = requests.get(req);
    if (existing) {
      if (live.has(existing)) return context.run(existing, next);
      uncertain = true;
      return next(new Error('Authentication continuation used after settlement'));
    }
    if (stopped || pause !== null) {
      res.setHeader('Retry-After', '1');
      res.status(503).json({ code: 'APP_QUIESCING' });
      return;
    }
    const root = create();
    requests.set(req, root.operation);
    // Install BEFORE express-session. Its final set/touch/destroy must finish before this call.
    // This is only the root's terminal signal: actual accepted promises/callbacks still hold it.
    // A closed HTTP peer ends this root, never an accepted callback or continuation.
    res.once('close', root.complete);
    const end = res.end;
    res.end = function (this: Response, ...args: Parameters<Response['end']>) {
      try {
        return end.apply(this, args);
      } finally {
        root.complete();
      }
    } as Response['end'];
    context.run(root.operation, next);
  };

  const owner: AuthMaintenance = {
    admissionMiddleware,
    current: () => context.getStore(),
    snapshotAdmissions() {
      const admitted = new WeakSet(live);
      return (operation) => live.has(operation) && admitted.has(operation);
    },
    forRequest: (req) => requests.get(req),
    async run(req, action) {
      const existing = (req && requests.get(req)) ?? context.getStore();
      if (existing) return existing.track(() => action(existing));
      const root = create();
      try {
        return await root.operation.track(() => action(root.operation));
      } finally {
        root.complete();
      }
    },
    own: (handler) => (req, res, next) => {
      admissionMiddleware(req, res, () => {
        // The rejection consumer is attached at creation, including handlers Express won't await.
        void owner.run(req, () => handler(req, res, next)).catch(next);
      });
    },
    markUncertain: () => {
      uncertain = true;
    },
    pauseAdmissions(id) {
      if (
        typeof id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
        (pause !== null && pause !== id)
      )
        return false;
      if (pause !== id) {
        pause = id;
        revision++;
      }
      return true;
    },
    resumeAdmissions(id) {
      if (stopped || pause !== id || uncertain) return false;
      pause = null;
      revision++;
      return true;
    },
    async getMaintenanceCensus(id) {
      const sampled = revision;
      const matches = id === pause;
      await Promise.resolve();
      return {
        admissionClosed: stopped || pause !== null,
        queuedContinuations: live.size,
        pendingWrites: writes,
        complete: matches && id === pause && sampled === revision && !uncertain,
      };
    },
    stopAdmissions() {
      if (!stopped) {
        stopped = true;
        revision++;
      }
    },
    async drain() {
      owner.stopAdmissions();
      if (live.size !== 0) await new Promise<void>((resolve) => drained.add(resolve));
      if (uncertain) throw new Error('AUTH_SETTLEMENT_UNCONFIRMED');
    },
  };
  return owner;
}

interface CacheErrorSource {
  on?: (event: 'error', listener: () => void) => unknown;
  off?: (event: 'error', listener: () => void) => unknown;
}
const cacheWrites = new WeakMap<
  CacheErrorSource,
  {
    owners: Map<AuthMaintenance, number>;
    failed: () => void;
  }
>();

/** Keyv can emit an error and resolve false; DELETE false alone can also mean an absent key. */
export function observeAuthCacheWrite<T>(
  owner: AuthMaintenance,
  cache: CacheErrorSource,
  method: 'set' | 'delete',
  action: () => Promise<T>,
): Promise<T> {
  return owner.run(undefined, (operation) =>
    operation.write(async () => {
      let active = cacheWrites.get(cache);
      if (cache.on && cache.off) {
        if (!active) {
          const owners = new Map<AuthMaintenance, number>();
          active = {
            owners,
            failed: () => owners.forEach((_count, current) => current.markUncertain()),
          };
          cacheWrites.set(cache, active);
          cache.on('error', active.failed);
        }
        active.owners.set(owner, (active.owners.get(owner) ?? 0) + 1);
      }
      try {
        const result = await action();
        if (method === 'set' && result === false) operation.markUncertain();
        return result;
      } finally {
        if (active) {
          const remaining = (active.owners.get(owner) ?? 1) - 1;
          if (remaining > 0) active.owners.set(owner, remaining);
          else active.owners.delete(owner);
          if (active.owners.size === 0) {
            cache.off?.('error', active.failed);
            cacheWrites.delete(cache);
          }
        }
      }
    }),
  );
}
