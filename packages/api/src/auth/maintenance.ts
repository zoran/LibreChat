/** Request/continuation lifetime for legacy authentication. Identity and persistence stay external. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthContinuationObserver } from '@librechat/data-schemas';
import type { RequestHandler, Response } from 'express';
import type { ApplicationWorkPort } from '~/app';

export interface AuthOperation extends AuthContinuationObserver {
  /** Register before invocation, including work whose rejection its consumer will sanitize. */
  track<T>(action: () => Promise<T> | T): Promise<T>;
  /** Callback APIs must complete through their actual callback; abort/timeout is not settlement. */
  callback<T>(start: (done: (error?: unknown, value?: T) => void) => void): Promise<T>;
}
export interface AuthMaintenance extends ApplicationWorkPort {
  admissionMiddleware: RequestHandler;
  current(): AuthOperation | undefined;
  forRequest(req: object): AuthOperation | undefined;
  run<T>(req: object | undefined, action: (operation: AuthOperation) => Promise<T> | T): Promise<T>;
  own(handler: RequestHandler): RequestHandler;
  markUncertain(): void;
}

export function createAuthMaintenance(): AuthMaintenance {
  const context = new AsyncLocalStorage<AuthOperation>();
  const requests = new WeakMap<object, AuthOperation>();
  const live = new Set<AuthOperation>();
  let pause: string | null = null;
  let revision = 0;
  let writes = 0;
  let uncertain = false;

  function create() {
    if (pause !== null) throw Object.assign(new Error('APP_QUIESCING'), { status: 503 });
    let pending = 0;
    let rootComplete = false;
    const finish = () => {
      if (rootComplete && pending === 0) live.delete(operation);
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
      callback<T>(start: (done: (error?: unknown, value?: T) => void) => void): Promise<T> {
        return operation.write(
          () =>
            new Promise<T>((resolve, reject) => {
              let called = false;
              const done = (error?: unknown, value?: unknown) => {
                if (called) return;
                called = true;
                if (error) reject(error);
                else resolve(value as T);
              };
              try {
                start(done);
              } catch (error) {
                done(error);
              }
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
    if (existing) return context.run(existing, next);
    if (pause !== null) {
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
      if (pause !== id || uncertain) return false;
      pause = null;
      revision++;
      return true;
    },
    async getMaintenanceCensus(id) {
      const sampled = revision;
      const matches = id === pause;
      await Promise.resolve();
      return {
        admissionClosed: pause !== null,
        queuedContinuations: live.size,
        pendingWrites: writes,
        complete: matches && id === pause && sampled === revision && !uncertain,
      };
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
