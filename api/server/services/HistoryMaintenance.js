const { AsyncLocalStorage } = require('node:async_hooks');

/** History route/import custody. A closed response never settles an original operation. */
function createHistoryMaintenance() {
  const requests = new WeakMap();
  const context = new AsyncLocalStorage();
  const active = new Set();
  const drained = new Set();
  let pausedBy = null;
  let stopped = false;
  let uncertain = false;

  function finish(operation) {
    if (operation.root || operation.pending !== 0) return;
    active.delete(operation);
    if (active.size === 0) {
      for (const resolve of drained) resolve();
      drained.clear();
    }
  }

  function acquire(req, root = false) {
    const existing = requests.get(req);
    if (existing) {
      if (active.has(existing)) return existing;
      // A continuation with no retained parent cannot silently reopen a settled request.
      uncertain = true;
      throw new Error('HISTORY_SETTLEMENT_UNCONFIRMED');
    }
    if (stopped || pausedBy !== null) throw new Error('APP_QUIESCING');
    const operation = { root, pending: 0 };
    requests.set(req, operation);
    active.add(operation);
    return operation;
  }

  function run(req, start) {
    let operation;
    try {
      operation = acquire(req);
    } catch (error) {
      return Promise.reject(error);
    }
    return retain(operation, start);
  }

  function retain(operation, start) {
    operation.pending++;
    let original;
    try {
      original = context.run(operation, start);
    } catch (error) {
      original = Promise.reject(error);
    }
    return Promise.resolve(original).finally(() => {
      operation.pending--;
      finish(operation);
    });
  }

  function callback(req, start, done) {
    return run(
      req,
      () =>
        new Promise((resolve, reject) => {
          const operation = context.getStore();
          let called = false;
          const complete = (...args) => {
            if (called) return;
            called = true;
            try {
              // Register nested cleanup/route work before relinquishing this original.
              context.run(operation, () => done(...args));
              resolve();
            } catch (error) {
              uncertain = true;
              reject(error);
            }
          };
          try {
            start(complete);
          } catch (error) {
            complete(error);
          }
        }),
    );
  }

  function own(handler) {
    if (Array.isArray(handler)) return handler.map(own);
    return function historyHandler(req, res, next) {
      return run(
        req,
        () =>
          new Promise((resolve, reject) => {
            let returned = false;
            let originalDone = false;
            let continuationDone = false;
            const settle = () => {
              if (!returned || !originalDone || !continuationDone) return;
              res.removeListener('finish', responseFinished);
              resolve();
            };
            const responseFinished = () => {
              continuationDone = true;
              settle();
            };
            res.once('finish', responseFinished);
            const forward = (...args) => {
              continuationDone = true;
              try {
                next(...args);
              } finally {
                settle();
              }
            };
            try {
              const original = handler(req, res, forward);
              returned = true;
              continuationDone ||= handler.length < 3 || res.writableEnded || res.finished;
              Promise.resolve(original).then(
                () => {
                  originalDone = true;
                  continuationDone ||= res.writableEnded || res.finished;
                  settle();
                },
                (error) => {
                  res.removeListener('finish', responseFinished);
                  reject(error);
                },
              );
            } catch (error) {
              res.removeListener('finish', responseFinished);
              reject(error);
            }
          }),
      ).catch(next);
    };
  }

  return {
    run,
    // Only these history consumers receive the adapter; the global model owner is unchanged.
    methods(target) {
      const methods = new Map();
      return new Proxy(target, {
        get(object, key) {
          const original = Reflect.get(object, key);
          if (typeof original !== 'function') return original;
          const cached = methods.get(key);
          if (cached?.original === original) return cached.wrapped;
          const wrapped = (...args) => {
            const operation = context.getStore();
            if (!operation || !active.has(operation)) {
              uncertain = true;
              return Promise.reject(new Error('HISTORY_SETTLEMENT_UNCONFIRMED'));
            }
            return retain(operation, () => Reflect.apply(original, object, args));
          };
          methods.set(key, { original, wrapped });
          return wrapped;
        },
      });
    },
    callback,
    own,
    admissionMiddleware(req, res, next) {
      let operation;
      try {
        operation = acquire(req, true);
      } catch (error) {
        if (error.message !== 'APP_QUIESCING') return next(error);
        res.set('Retry-After', '1');
        return res.status(503).json({ error: 'APP_QUIESCING' });
      }
      const responseClosed = () => {
        operation.root = false;
        res.removeListener('finish', responseClosed);
        res.removeListener('close', responseClosed);
        req.removeListener('aborted', responseClosed);
        finish(operation);
      };
      res.once('finish', responseClosed);
      res.once('close', responseClosed);
      req.once('aborted', responseClosed);
      next();
    },
    markUncertain() {
      uncertain = true;
    },
    pauseAdmissions(requestId) {
      if (
        typeof requestId !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(requestId) ||
        (pausedBy !== null && pausedBy !== requestId)
      )
        return false;
      pausedBy = requestId;
      return true;
    },
    resumeAdmissions(requestId) {
      if (stopped || uncertain || pausedBy !== requestId) return false;
      pausedBy = null;
      return true;
    },
    async getMaintenanceCensus(requestId) {
      return {
        admissionClosed: stopped || pausedBy !== null,
        queuedContinuations: [...active].filter((operation) => operation.root).length,
        pendingWrites: [...active].reduce((total, operation) => total + operation.pending, 0),
        complete: !uncertain && pausedBy === requestId,
      };
    },
    stopAdmissions() {
      stopped = true;
    },
    async drain() {
      stopped = true;
      if (active.size !== 0) await new Promise((resolve) => drained.add(resolve));
      if (uncertain) throw new Error('HISTORY_SETTLEMENT_UNCONFIRMED');
    },
  };
}

const historyMaintenance = createHistoryMaintenance();
module.exports = { createHistoryMaintenance, historyMaintenance };
