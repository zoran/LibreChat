jest.mock('~/data-provider/Endpoints', () => ({
  useGetStartupConfig: () => ({ data: { authMode: 'default' } }),
}));
import React from 'react';
import { RecoilRoot } from 'recoil';
import { dataService } from 'librechat-data-provider';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TUser } from 'librechat-data-provider';
import store from '~/store';
import { useFilePreviewBlob } from './queries';

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  dataService: { getFileDownload: jest.fn(), getSharedFileDownload: jest.fn() },
}));

describe('preview blob ownership', () => {
  afterEach(() => jest.clearAllMocks());

  it.each([undefined, 'share-1'])(
    'shares bytes across deduplicated requests (%s)',
    async (shareId) => {
      let resolve!: (value: { data: Blob }) => void;
      const pending = new Promise<{ data: Blob }>((done) => {
        resolve = done;
      });
      const owned = jest.mocked(dataService.getFileDownload).mockReturnValue(pending as never);
      const shared = jest
        .mocked(dataService.getSharedFileDownload)
        .mockReturnValue(pending as never);
      const client = new QueryClient();
      const wrapper = ({ children }: React.PropsWithChildren) => (
        <RecoilRoot
          initializeState={({ set }) => {
            set(store.user, { id: 'owner', tenantId: 'tenant-a' } as TUser);
            set(store.queriesEnabled, true);
          }}
        >
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        </RecoilRoot>
      );
      const first = renderHook(() => useFilePreviewBlob('owner', 'f1', shareId), { wrapper });
      const second = renderHook(() => useFilePreviewBlob('owner', 'f1', shareId), { wrapper });
      const blob = new Blob(['preview']);
      await act(async () => {
        const a = first.result.current.refetch();
        const b = second.result.current.refetch();
        resolve({ data: blob });
        expect((await a).data).toBe(blob);
        expect((await b).data).toBe(blob);
      });
      expect(shareId ? shared : owned).toHaveBeenCalledTimes(1);
      expect(shareId ? owned : shared).not.toHaveBeenCalled();
      first.unmount();
      second.unmount();
      client.clear();
    },
  );
});
