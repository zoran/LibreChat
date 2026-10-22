let mockAuthMode = 'default';
jest.mock('~/data-provider/Endpoints', () => ({
  useGetStartupConfig: () => ({ data: { authMode: mockAuthMode } }),
}));
import React from 'react';
import { RecoilRoot, useSetRecoilState } from 'recoil';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from '@tanstack/react-query';
import type { TUser } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { useFilePreview, useFilePreviewBlob } from '../queries';
import store from '~/store';

const mockPreview = jest.fn();
const mockSharedPreview = jest.fn();
const mockDownload = jest.fn();
const mockTicket = jest.fn();
const mockInspection = jest.fn();
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getFilePreview: (...args: unknown[]) => mockPreview(...args),
      getSharedFilePreview: (...args: unknown[]) => mockSharedPreview(...args),
      getFileDownload: (...args: unknown[]) => mockDownload(...args),
      getManagedFileReadTicket: (...args: unknown[]) => mockTicket(...args),
      inspectManagedFileRead: (...args: unknown[]) => mockInspection(...args),
    },
  };
});

const user = (id: string, tenantId = 'tenant-a') => ({ id, tenantId }) as TUser;
const ready = (text: string) => ({ file_id: 'file-a', status: 'ready' as const, text });
const clients: QueryClient[] = [];
const setup = (identity: TUser | null = user('alice')) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    logger: { log: console.log, warn: console.warn, error: () => undefined },
  });
  clients.push(client);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RecoilRoot
      initializeState={({ set }) => {
        set(store.user, identity ?? undefined);
        set(store.queriesEnabled, true);
      }}
    >
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </RecoilRoot>
  );
  return { client, wrapper };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthMode = 'default';
  mockTicket.mockImplementation(async (_owner, fileId, representation) => {
    const now = Date.now();
    return {
      version: 1,
      readId: 'A'.repeat(43),
      fileId,
      representation,
      admittedAt: new Date(now).toISOString(),
      notAfter: new Date(now + 120000).toISOString(),
    };
  });
  mockInspection.mockResolvedValue('completed');
  mockPreview.mockResolvedValue(ready('private'));
  mockSharedPreview.mockResolvedValue(ready('shared'));
  focusManager.setFocused(true);
  onlineManager.setOnline(true);
});
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  focusManager.setFocused(undefined);
});

/** Real observers exercise identity changes without relying on logout's global cache clear. */
describe('native preview identity and freshness', () => {
  it('never carries private content into another user or tenant', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(
      () => ({
        preview: useFilePreview('file-a'),
        changeUser: useSetRecoilState(store.user),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.preview.data?.text).toBe('private'));
    mockPreview.mockImplementation(() => new Promise(() => undefined));
    act(() => result.current.changeUser(user('bob')));
    expect(result.current.preview.data).toBeUndefined();
    expect(result.current.preview.isFetching).toBe(true);
    act(() => result.current.changeUser(user('bob', 'tenant-b')));
    expect(result.current.preview.data).toBeUndefined();
    await waitFor(() => expect(mockPreview).toHaveBeenCalledTimes(3));
  });

  it('cannot fetch private metadata or bytes without the actual current identity', async () => {
    const { wrapper } = setup(null);
    const { result } = renderHook(
      () => ({
        preview: useFilePreview('file-a', { enabled: true }),
        blob: useFilePreviewBlob('claimed-user', 'file-a'),
      }),
      { wrapper },
    );
    expect(result.current.preview.isFetching).toBe(false);
    await act(async () => {
      await result.current.preview.refetch();
      await result.current.blob.refetch();
    });
    expect(mockPreview).not.toHaveBeenCalled();
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('detaches cached content as soon as the native session closes its query gate', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(
      () => ({
        preview: useFilePreview('file-a'),
        closeSession: useSetRecoilState(store.queriesEnabled),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.preview.data?.text).toBe('private'));
    act(() => result.current.closeSession(false));
    expect(result.current.preview.data).toBeUndefined();
    expect(result.current.preview.isFetching).toBe(false);
    await act(async () => {
      await result.current.preview.refetch();
    });
    expect(mockPreview).toHaveBeenCalledTimes(1);
  });

  it('does not treat caller-supplied initial data or an old userId as authority', async () => {
    const { wrapper } = setup();
    mockPreview.mockImplementation(() => new Promise(() => undefined));
    const { result } = renderHook(
      () => ({
        preview: useFilePreview('file-a', {
          initialData: ready('optimistic'),
          placeholderData: ready('placeholder'),
          keepPreviousData: true,
          staleTime: Infinity,
        }),
        blob: useFilePreviewBlob('another-user', 'file-a'),
      }),
      { wrapper },
    );
    expect(result.current.preview.data).toBeUndefined();
    await act(async () => {
      await result.current.blob.refetch();
    });
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('separates anonymous shared authorization from the private cache', async () => {
    const { wrapper } = setup(null);
    const { result } = renderHook(
      () => ({
        shared: useFilePreview('file-a', undefined, 'share-a'),
        private: useFilePreview('file-a'),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.shared.data?.text).toBe('shared'));
    expect(result.current.private.data).toBeUndefined();
    expect(mockPreview).not.toHaveBeenCalled();
    expect(mockSharedPreview).toHaveBeenCalledWith('share-a', 'file-a');
  });

  it('rechecks a shared link when its current viewer changes', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(
      () => ({
        preview: useFilePreview('file-a', undefined, 'share-a'),
        changeUser: useSetRecoilState(store.user),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.preview.data?.text).toBe('shared'));
    mockSharedPreview.mockImplementation(() => new Promise(() => undefined));
    act(() => result.current.changeUser(user('bob')));
    expect(result.current.preview.data).toBeUndefined();
    expect(result.current.preview.isFetching).toBe(true);
  });

  it('reports fetching synchronously on reopen and preserves errors instead of stale success', async () => {
    const { wrapper } = setup();
    const { result, rerender } = renderHook(
      ({ open }) =>
        useFilePreview('file-a', {
          enabled: open,
        }),
      { wrapper, initialProps: { open: true } },
    );
    await waitFor(() => expect(result.current.data?.text).toBe('private'));
    rerender({ open: false });
    let reject!: (error: Error) => void;
    mockPreview.mockImplementation(
      () =>
        new Promise((_resolve, rejectFetch) => {
          reject = rejectFetch;
        }),
    );
    rerender({ open: true });
    expect(result.current.isFetching).toBe(true);
    await act(async () => reject(new Error('Access revoked')));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.isSuccess).toBe(false);
  });

  it('discards private content when its final observer unmounts', async () => {
    const { wrapper, client } = setup();
    const { result, unmount } = renderHook(() => useFilePreview('file-a'), { wrapper });
    await waitFor(() => expect(result.current.data?.text).toBe('private'));
    unmount();
    await waitFor(() => expect(client.getQueryCache().getAll()).toHaveLength(0));
  });

  it('revalidates on focus and reconnect while ready content has no polling interval', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useFilePreview('file-a'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    act(() => focusManager.setFocused(false));
    act(() => focusManager.setFocused(true));
    await waitFor(() => expect(mockPreview).toHaveBeenCalledTimes(2));
    act(() => onlineManager.setOnline(false));
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(mockPreview).toHaveBeenCalledTimes(3));
  });
});

/** A metadata observer must never inherit the content observer's side-effecting query function. */
describe('managed preview logical read ownership', () => {
  it('separates metadata and content observers and reuses the ticket on focus', async () => {
    mockAuthMode = 'transition';
    mockPreview.mockImplementation(async (fileId, read) =>
      read
        ? { file_id: fileId, status: 'ready', text: 'private-content', textFormat: 'text' }
        : { file_id: fileId, status: 'ready' },
    );
    const { client, wrapper } = setup();
    const { result } = renderHook(
      () => ({
        metadata: useFilePreview('file-a', { enabled: true }, undefined, 'metadata'),
        content: useFilePreview('file-a', { enabled: true }, undefined, 'content'),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.content.data?.text).toBe('private-content'));
    expect(result.current.metadata.data).toEqual({ file_id: 'file-a', status: 'ready' });
    expect(mockTicket).toHaveBeenCalledTimes(1);
    const keys = client
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(keys.filter((key) => key[0] === 'filePreview')).toHaveLength(2);
    expect(JSON.stringify(keys)).not.toContain('A'.repeat(43));
    const calls = mockPreview.mock.calls.length;
    act(() => focusManager.setFocused(false));
    act(() => focusManager.setFocused(true));
    await waitFor(() => expect(mockPreview.mock.calls.length).toBeGreaterThan(calls));
    expect(mockTicket).toHaveBeenCalledTimes(1);
    expect(
      mockPreview.mock.calls
        .filter(([, read]) => read)
        .every(([, read]) => read.ticket.readId === 'A'.repeat(43)),
    ).toBe(true);
  });
  it('does not admit again when a sibling content observer becomes the query owner', async () => {
    mockAuthMode = 'transition';
    const { wrapper } = setup();
    const first = renderHook(
      () => useFilePreview('file-a', { enabled: true }, undefined, 'content'),
      { wrapper },
    );
    await waitFor(() => expect(first.result.current.data?.text).toBe('private'));
    const second = renderHook(
      () => useFilePreview('file-a', { enabled: true }, undefined, 'content'),
      { wrapper },
    );
    await waitFor(() => expect(second.result.current.isFetching).toBe(false));
    expect(mockTicket).toHaveBeenCalledTimes(1);
    act(() => focusManager.setFocused(false));
    act(() => focusManager.setFocused(true));
    await waitFor(() => expect(second.result.current.isFetching).toBe(false));
    expect(mockTicket).toHaveBeenCalledTimes(1);
  });
  it('starts another logical read only when the content surface is explicitly reopened', async () => {
    mockAuthMode = 'transition';
    const { wrapper } = setup();
    const { result, rerender } = renderHook(
      ({ open }) => useFilePreview('file-a', { enabled: open }, undefined, 'content'),
      { wrapper, initialProps: { open: true } },
    );
    await waitFor(() => expect(result.current.data?.text).toBe('private'));
    expect(mockTicket).toHaveBeenCalledTimes(1);
    rerender({ open: false });
    rerender({ open: true });
    await waitFor(() => expect(mockTicket).toHaveBeenCalledTimes(2));
  });
});
