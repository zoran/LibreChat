/** Optional lifecycle observation at authentication persistence owners; no transport or policy. */
export interface AuthPersistenceObserver {
  write<T>(action: () => Promise<T>): Promise<T>;
}

/** Captured by the caller before data owners defer work beyond a returned mutation. */
export interface AuthContinuationObserver extends AuthPersistenceObserver {
  track<T>(action: () => Promise<T> | T): Promise<T>;
  markUncertain(): void;
}

export function observeAuthPersistence<T>(
  observer: AuthPersistenceObserver | undefined,
  action: () => Promise<T>,
): Promise<T> {
  return observer ? observer.write(action) : action();
}

/** Preserve every launched child even when the first failure is deliberately hidden by a caller. */
export async function settleAuthPersistence<T>(actions: Promise<T>[]): Promise<T[]> {
  const outcomes = await Promise.allSettled(actions);
  const failed = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return outcomes.map((outcome) => (outcome as PromiseFulfilledResult<T>).value);
}
