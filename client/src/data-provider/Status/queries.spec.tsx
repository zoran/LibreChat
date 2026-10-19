import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dataService, readStatusSnapshot } from 'librechat-data-provider';
import { act, renderHook, waitFor, cleanup } from '@testing-library/react';
import fixture from '../../../../packages/data-provider/src/status-fixtures/representative.json';
import { useStatusSnapshotQuery } from './queries';
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  QueryKeys: { statusSnapshot: 'statusSnapshot', statusAccess: 'statusAccess' },
  dataService: { getStatusSnapshot: jest.fn(), getStatusAccess: jest.fn() },
}));
const request = dataService.getStatusSnapshot as jest.Mock;
const clients: QueryClient[] = [];
const snapshot = () => {
  const s = readStatusSnapshot(fixture);
  if (!s) throw new Error('invalid owner fixture');
  return s;
};
function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  clients.push(client);
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}
beforeEach(() => {
  request.mockReset();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((c) => c.clear());
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
});
it('does not request fleet data without platform access', async () => {
  renderHook(() => useStatusSnapshotQuery('u', false), { wrapper: harness() });
  await act(async () => {});
  expect(request).not.toHaveBeenCalled();
});
it('shares one request between consumers with the same principal', async () => {
  request.mockResolvedValue(snapshot());
  renderHook(() => [useStatusSnapshotQuery('u', true), useStatusSnapshotQuery('u', true)], {
    wrapper: harness(),
  });
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
});
it('aborts an outstanding request when the tab becomes hidden', async () => {
  let signal: AbortSignal | undefined;
  request.mockImplementation((options: { signal: AbortSignal }) => {
    signal = options.signal;
    return new Promise(() => {});
  });
  renderHook(() => useStatusSnapshotQuery('u', true), { wrapper: harness() });
  await waitFor(() => expect(signal).toBeDefined());
  act(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(signal!.aborted).toBe(true);
});
it('removes previous observations after a 403 and stops polling', async () => {
  request.mockResolvedValueOnce(snapshot());
  const { result } = renderHook(() => useStatusSnapshotQuery('u', true), { wrapper: harness() });
  await waitFor(() => expect(result.current.data).toBeDefined());
  request.mockRejectedValueOnce({ response: { status: 403 } });
  await act(async () => {
    await result.current.refetch();
  });
  await waitFor(() => expect(result.current.denied).toBe(true));
  expect(result.current.data).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(2);
});
it('fences a late response after original session end', async () => {
  let resolve: (value: ReturnType<typeof snapshot>) => void = () => {};
  let signal: AbortSignal | undefined;
  request.mockImplementation((options: { signal: AbortSignal }) => {
    signal = options.signal;
    return new Promise((r) => {
      resolve = r;
    });
  });
  const { result } = renderHook(() => useStatusSnapshotQuery('u', true), { wrapper: harness() });
  await waitFor(() => expect(signal).toBeDefined());
  act(() => window.dispatchEvent(new CustomEvent('librechat:auth-session-ending')));
  expect(signal!.aborted).toBe(true);
  await act(async () => resolve(snapshot()));
  expect(result.current.data).toBeUndefined();
});
