/** Each query belongs to one authenticated user, tenant, filter and bounded cursor. */
import { useQuery } from '@tanstack/react-query';
import type { FileLibraryQuery } from 'librechat-data-provider';
import { getFileLibrary } from './api';

export const fileLibraryKey = (ownerId: string, tenantId: string | null) =>
  ['fileLibrary', ownerId, tenantId] as const;

export function useFileLibrary(
  ownerId: string,
  tenantId: string | null,
  query: FileLibraryQuery,
  isCurrent: () => boolean,
) {
  return useQuery({
    queryKey: [...fileLibraryKey(ownerId, tenantId), query],
    queryFn: async ({ signal }) => {
      if (!isCurrent()) throw new DOMException('Session ended', 'AbortError');
      const page = await getFileLibrary(query, signal ?? new AbortController().signal);
      if (!isCurrent()) throw new DOMException('Session ended', 'AbortError');
      return page;
    },
    enabled: isCurrent(),
    retry: false,
    cacheTime: 0,
    staleTime: 0,
    refetchOnMount: 'always',
    keepPreviousData: false,
  });
}
