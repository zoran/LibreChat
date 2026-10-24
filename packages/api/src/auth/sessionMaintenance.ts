/** Supported express-session Store adapter. Store state remains owned by the supplied adapter. */
import session from 'express-session';
import type { AuthMaintenance } from './maintenance';

export function createAuthSessionStore(
  store: session.Store,
  owner: AuthMaintenance,
): session.Store {
  const reads = new Set(['get', 'all', 'length']);
  const callbacks = { get: 1, set: 2, destroy: 1, clear: 0, touch: 2, all: 0, length: 0 };
  const methods = store as unknown as Record<string, (...values: unknown[]) => unknown>;
  class ObservedStore extends session.Store {
    declare get: session.Store['get'];
    declare set: session.Store['set'];
    declare destroy: session.Store['destroy'];

    constructor() {
      super();
      // Preserve optional methods and each original signature; absence affects session policy.
      for (const [name, callbackIndex] of Object.entries(callbacks)) {
        if (typeof methods[name] !== 'function') continue;
        const observed = (...args: unknown[]) => invoke(name, callbackIndex, args);
        Object.defineProperty(observed, 'length', { value: methods[name].length });
        Object.defineProperty(this, name, { value: observed });
      }
      store.on('connect', () => this.emit('connect'));
      store.on('disconnect', () => this.emit('disconnect'));
    }
  }
  function invoke(name: string, callbackIndex: number, supplied: unknown[]) {
    const args = [...supplied];
    const callback =
      typeof args[callbackIndex] === 'function'
        ? (args[callbackIndex] as (...values: unknown[]) => unknown)
        : undefined;
    const operation = owner.current();
    if (!operation) {
      owner.markUncertain();
      try {
        callback?.(new Error('AUTH_SESSION_OWNERSHIP_REQUIRED'));
      } catch {
        owner.markUncertain();
      }
      return;
    }
    let started = false;
    let original;
    const work = operation.callback(
      (done) => {
        started = true;
        args[callbackIndex] = done;
        original = Reflect.apply(methods[name], store, args);
        return original;
      },
      { write: !reads.has(name), complete: callback },
    );
    void work
      .catch((error) => {
        // A retired owner refuses dispatch before start; still report the ordinary callback error.
        if (!started) callback?.(error);
      })
      .catch(() => owner.markUncertain());
    return original;
  }
  return new ObservedStore();
}
