/** Explicit history HTTP composition; response/socket closure is never settlement. */
import type { Request, RequestHandler, Response, NextFunction } from 'express';
import type { HistoryMutation, HistoryMutationOwner, HistoryMutationScope } from './history';

const scopeKey = Symbol('historyMutationScope');
type ScopedRequest = Request & { [scopeKey]?: HistoryMutationScope };
type Step = (req: Request, res: Response, next: NextFunction) => unknown;

export function getHistoryMutationScope(req: object): HistoryMutationScope | undefined {
  return (req as ScopedRequest)[scopeKey];
}
export function trackHistoryWrite<T>(
  req: object,
  action: () => PromiseLike<T> | T,
  confirm?: (value: T) => boolean,
): Promise<T> {
  const scope = getHistoryMutationScope(req);
  return scope ? scope.write(action, confirm) : Promise.resolve().then(action);
}

/** Only the declared history pipelines use this adapter; callback steps must bridge their work. */
export function createHistoryMutationHandler(
  operation: HistoryMutation,
  ...handlers: (Step | Step[])[]
): RequestHandler {
  const steps = handlers.flat();
  return async (req, res, next) => {
    const owner = req.app?.locals.historyMaintenance as HistoryMutationOwner | undefined;
    const scope = owner?.admit(operation);
    if (!scope) {
      res.set('Retry-After', '1').status(503).json({
        code: 'APP_QUIESCING',
        error: 'Application admission is closed for maintenance.',
      });
      return;
    }
    (req as ScopedRequest)[scopeKey] = scope;
    async function run(index: number): Promise<void> {
      if (index >= steps.length) return;
      const release = scope!.hold('continuation');
      let called = false;
      let settled = false;
      let downstream: Promise<void> | undefined;
      let continueCallback: (() => void) | undefined;
      const callback = new Promise<void>((resolve) => {
        continueCallback = resolve;
      });
      const advance: NextFunction = (error?: unknown) => {
        if (called) {
          scope!.uncertain();
          return;
        }
        called = true;
        if (settled) scope!.uncertain();
        if (error != null) {
          scope!.uncertain();
          next(error);
        } else {
          downstream = run(index + 1);
          // Attach immediately: an upstream middleware can still be pending.
          void downstream.catch(() => {});
        }
        continueCallback!();
      };
      try {
        const returned = steps[index](req, res, advance);
        const promise =
          returned != null && typeof (returned as PromiseLike<unknown>).then === 'function';
        if (promise) await returned;
        else if (!called && returned === undefined) await callback;
        if (downstream) await downstream;
      } finally {
        settled = true;
        release();
      }
    }
    try {
      await run(0);
    } catch (error) {
      scope.uncertain();
      next(error);
    } finally {
      scope.finish();
    }
  };
}
