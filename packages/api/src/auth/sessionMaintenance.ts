/** Supported express-session Store adapter. Store state remains owned by the supplied adapter. */
import session from 'express-session';
import type { AuthMaintenance } from './maintenance';

export function createAuthSessionStore(
  store: session.Store,
  owner: AuthMaintenance,
): session.Store {
  class ObservedStore extends session.Store {
    constructor() {
      super();
      // Preserve optional methods: advertising touch for a store without it changes session policy.
      for (const name of ['clear', 'touch'] as const) {
        if (typeof store[name] === 'function') {
          Object.defineProperty(this, name, { value: (...args: unknown[]) => invoke(name, args) });
        }
      }
      for (const name of ['all', 'length'] as const) {
        if (typeof store[name] === 'function')
          Object.defineProperty(this, name, { value: store[name].bind(store) });
      }
      store.on('connect', () => this.emit('connect'));
      store.on('disconnect', () => this.emit('disconnect'));
    }

    get(sid: string, callback: (err: unknown, data?: session.SessionData | null) => void) {
      store.get(sid, callback);
    }

    set(sid: string, data: session.SessionData, callback?: (err?: unknown) => void) {
      invoke('set', [sid, data, callback]);
    }

    destroy(sid: string, callback?: (err?: unknown) => void) {
      invoke('destroy', [sid, callback]);
    }
  }
  function invoke(name: string, args: unknown[]) {
    const operation = owner.current();
    const callback =
      typeof args[args.length - 1] === 'function'
        ? (args.pop() as (error?: unknown) => unknown)
        : undefined;
    if (args[args.length - 1] === undefined) args.pop();
    if (!operation) owner.markUncertain();
    let started = false;
    const start = (done: (error?: unknown) => void) => {
      started = true;
      const method = (store as unknown as Record<string, (...values: unknown[]) => unknown>)[name];
      let called = false;
      const complete = (error?: unknown) => {
        if (called) return;
        called = true;
        try {
          // The caller may synchronously start another accepted session continuation.
          // Keep its callback inside the lifetime, including express-session's final end().
          const deliver = () => callback?.(error);
          const delivered = operation ? operation.track(deliver) : Promise.resolve(deliver());
          void delivered.then(
            () => done(error),
            (callbackError) => {
              owner.markUncertain();
              done(error || callbackError);
            },
          );
        } catch (callbackError) {
          owner.markUncertain();
          done(error || callbackError);
          return;
        }
      };
      try {
        method.apply(store, [...args, complete]);
      } catch (error) {
        complete(error);
      }
    };
    const work = operation
      ? operation.callback(start)
      : new Promise<void>((resolve, reject) =>
          start((error) => (error ? reject(error) : resolve())),
        );
    void work
      .catch((error) => {
        owner.markUncertain();
        if (!started) callback?.(error);
      })
      .catch(() => owner.markUncertain());
  }
  return new ObservedStore();
}
