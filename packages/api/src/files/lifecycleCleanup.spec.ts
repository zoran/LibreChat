/** Adapter boundary checks only; no synthetic receipt is claimed as native completion. */
import type { JobClaim } from '@librechat/data-schemas';
import type { FileCleanupComposition } from './lifecycleCleanup';
import { createFileCleanupPort } from './lifecycleCleanup';
const signal = new AbortController().signal;
function fixture() {
  const external = jest.fn(() => {
    throw new Error('unexpected external handoff');
  });
  const ports = {
    entry: { enter: jest.fn().mockResolvedValue({ state: 'lost' }) },
    targets: { beginCapture: external },
    lifecycle: { begin: external },
    generations: { capture: external, reconcile: external, close: external },
    storage: {
      describeDeletion: external,
      beginDeletion: external,
      observeDeletion: external,
      acknowledgeDeletionConsumed: external,
    },
    storageBudgetMs: 5000,
  } as unknown as FileCleanupComposition;
  return { ports, external, port: createFileCleanupPort(ports) };
}
it('stops on committed revocation lost/reobserve before any lifecycle or effect call', async () => {
  const f = fixture();
  expect(await f.port.step({} as JobClaim, signal)).toEqual({ state: 'lost' });
  expect(f.external).not.toHaveBeenCalled();
});
it('drain prevents admission of another owner operation', async () => {
  const f = fixture();
  const c = new AbortController();
  c.abort();
  expect(await f.port.step({} as JobClaim, c.signal)).toEqual({
    state: 'pending',
    code: 'owner_pending',
  });
  expect(f.ports.entry.enter).not.toHaveBeenCalled();
  expect(f.external).not.toHaveBeenCalled();
});
it('preserves unknown entry outcomes without inferring a revocation or successful handoff', async () => {
  const f = fixture();
  jest.mocked(f.ports.entry.enter).mockRejectedValueOnce(new Error('commit reply lost'));
  expect(await f.port.step({} as JobClaim, signal)).toEqual({ state: 'unknown' });
  expect(f.external).not.toHaveBeenCalled();
});
it.each([0, -1, 10001, Infinity])('requires an actual finite transport budget %s', (budget) => {
  const f = fixture();
  expect(() => createFileCleanupPort({ ...f.ports, storageBudgetMs: budget })).toThrow();
});
