import { dispatchNasWrite } from './write';
it('denies missing or unavailable authority before effects and records genuine nondispatch', async () => {
  for (const gate of [
    undefined,
    () => {
      throw new Error('stale');
    },
  ]) {
    const observer = { notDispatched: jest.fn(async () => undefined) };
    const dispatch = jest.fn(async () => 'sent');
    expect(await dispatchNasWrite(gate, observer, dispatch)).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
    expect(observer.notDispatched).toHaveBeenCalledTimes(1);
  }
});
it('calls the same gate synchronously before the original and never rewrites a failed send as nondispatch', async () => {
  const events: string[] = [];
  const observer = { notDispatched: jest.fn(async () => undefined) };
  const original = Promise.reject(new Error('actual original failed'));
  await expect(
    dispatchNasWrite(
      () => {
        events.push('guard');
      },
      observer,
      () => {
        events.push('network');
        return original;
      },
    ),
  ).rejects.toThrow('actual original failed');
  expect(events).toEqual(['guard', 'network']);
  expect(observer.notDispatched).not.toHaveBeenCalled();
});
