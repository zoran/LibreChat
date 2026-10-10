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
