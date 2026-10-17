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
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getFilePreview: (...args: unknown[]) => mockPreview(...args),
      getSharedFilePreview: (...args: unknown[]) => mockSharedPreview(...args),
      getFileDownload: (...args: unknown[]) => mockDownload(...args),
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
