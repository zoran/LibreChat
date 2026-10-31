/** Original NAS dispatch is admitted at the last synchronous boundary before network I/O. */
export async function dispatchNasWrite<T>(
  assertSafe: (() => void) | undefined,
  observer: { notDispatched(): Promise<void> },
  dispatch: () => Promise<T>,
): Promise<T | undefined> {
  try {
    if (!assertSafe) throw new Error('NAS storage availability unavailable');
    assertSafe();
  } catch {
    await observer.notDispatched();
    return undefined;
  }
  return dispatch();
}
