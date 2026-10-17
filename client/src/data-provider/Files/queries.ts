import { useRecoilValue } from 'recoil';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileSources, QueryKeys, DynamicQueryKeys, dataService } from 'librechat-data-provider';
import type { QueryObserverResult, UseQueryOptions } from '@tanstack/react-query';
import type t from 'librechat-data-provider';
import {
  addFileToCache,
  getDownloadFilename,
  registerDownloadFilename,
  unregisterDownloadFilename,
} from '~/utils';
import { isEphemeralAgent } from '~/common';
import store from '~/store';

export const useGetFiles = <TData = t.TFile[] | boolean>(
  config?: UseQueryOptions<t.TFile[], unknown, TData>,
): QueryObserverResult<TData, unknown> => {
  const queriesEnabled = useRecoilValue<boolean>(store.queriesEnabled);
  return useQuery<t.TFile[], unknown, TData>([QueryKeys.files], () => dataService.getFiles(), {
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    ...config,
    enabled: (config?.enabled ?? true) === true && queriesEnabled,
  });
};

/**
 * A short, server-sorted page of the user's files for surfaces that only show
 * a handful of recent uploads (composer palette). Kept on a separate query key
 * so it never replaces the full `QueryKeys.files` list used by the files panel.
 */
export const useGetRecentFiles = <TData = t.TFile[]>(
  limit: number,
  config?: UseQueryOptions<t.TFile[], unknown, TData>,
): QueryObserverResult<TData, unknown> => {
  const queriesEnabled = useRecoilValue<boolean>(store.queriesEnabled);
  return useQuery<t.TFile[], unknown, TData>(
    [QueryKeys.files, 'recent', limit],
    () => dataService.getFiles({ limit }),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
      enabled: (config?.enabled ?? true) === true && queriesEnabled && limit > 0,
    },
  );
};

export const useGetAgentFiles = <TData = t.TFile[]>(
  agentId: string | undefined,
  config?: UseQueryOptions<t.TFile[], unknown, TData>,
): QueryObserverResult<TData, unknown> => {
  const queriesEnabled = useRecoilValue<boolean>(store.queriesEnabled);
  return useQuery<t.TFile[], unknown, TData>(
    DynamicQueryKeys.agentFiles(agentId ?? ''),
    () => (agentId ? dataService.getAgentFiles(agentId) : Promise.resolve([])),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
      enabled: (config?.enabled ?? true) === true && queriesEnabled && !isEphemeralAgent(agentId),
    },
  );
};

export const useGetFileConfig = <TData = t.TFileConfig>(
  config?: UseQueryOptions<t.TFileConfig, unknown, TData>,
): QueryObserverResult<TData, unknown> => {
  return useQuery<t.TFileConfig, unknown, TData>(
    [QueryKeys.fileConfig],
    () => dataService.getFileConfig(),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      ...config,
    },
  );
};

type FileDownloadOptions = {
  source?: string | null;
  direct?: boolean;
  purpose?: 'download' | 'preview';
};

export const isDirectDownloadSource = (source?: string | null): boolean =>
  source === FileSources.s3 || source === FileSources.cloudfront;

export const revokeDownloadURL = (url?: string | null): void => {
  if (!url?.startsWith('blob:')) {
    return;
  }
  unregisterDownloadFilename(url);
  window.URL.revokeObjectURL(url);
};

export const useFileDownload = (
  userId?: string,
  file_id?: string,
  options: FileDownloadOptions = {},
): QueryObserverResult<string> => {
  const queryClient = useQueryClient();
  return useQuery(
    [
      QueryKeys.fileDownload,
      file_id,
      options.source ?? '',
      options.direct ?? true,
      options.purpose ?? 'download',
    ],
    async () => {
      if (!userId || !file_id) {
        console.warn('No user ID provided for file download');
        return;
      }
      if ((options.direct ?? true) && isDirectDownloadSource(options.source)) {
        try {
          const directDownload = await dataService.getFileDownloadURL(userId, file_id);
          if (directDownload.url) {
            return directDownload.url;
          }
        } catch {
          // Fall back to the legacy proxied download for direct URL failures.
        }
      }

      const response = await dataService.getFileDownload(userId, file_id);
      const blob = response.data;
      const downloadURL = window.URL.createObjectURL(blob);
      try {
        const metadata: t.TFile | undefined = JSON.parse(
          decodeURIComponent(response.headers['x-file-metadata']),
        );
        if (!metadata) {
          console.warn('No metadata found for file download', response.headers);
          return downloadURL;
        }

        registerDownloadFilename(
          downloadURL,
          getDownloadFilename(metadata.filename, metadata.file_id, metadata.source),
        );
        addFileToCache(queryClient, metadata);
      } catch (e) {
        console.error('Error parsing file metadata, skipped updating file query cache', e);
      }

      return downloadURL;
    },
    {
      enabled: false,
      retry: false,
    },
  );
};

/**
 * Blob download for a snapshotted file served through a shared link. Authorized
 * by shared-link view permission (public/ACL) rather than the owner's file ACL.
 * Idle by default; call `refetch` to download.
 */
export const useSharedFileDownload = (
  shareId?: string,
  file_id?: string,
  purpose: 'download' | 'preview' = 'download',
): QueryObserverResult<string> => {
  return useQuery(
    [QueryKeys.fileDownload, 'share', shareId ?? '', file_id ?? '', purpose],
    async () => {
      if (!shareId || !file_id) {
        return;
      }
      const response = await dataService.getSharedFileDownload(shareId, file_id);
      return window.URL.createObjectURL(response.data);
    },
    {
      enabled: false,
      retry: false,
    },
  );
};

/** Preview consumers share immutable bytes, never a revocable download URL. */
export const useFilePreviewBlob = (
  userId?: string,
  fileId?: string,
  shareId?: string,
): QueryObserverResult<Blob> => {
  const user = useRecoilValue(store.user);
  const queriesEnabled = useRecoilValue(store.queriesEnabled);
  const previewUser = queriesEnabled && userId === user?.id ? user : undefined;
  return useQuery(
    shareId
      ? [
          QueryKeys.fileDownload,
          'previewBlob',
          'share',
          shareId,
          fileId,
          user?.tenantId ?? '',
          user?.id,
        ]
      : [
          QueryKeys.fileDownload,
          'previewBlob',
          'owner',
          previewUser?.tenantId ?? '',
          previewUser?.id,
          fileId,
        ],
    async () => {
      if (!fileId || (!shareId && (!queriesEnabled || !user?.id || userId !== user.id))) {
        throw new Error('Preview identity unavailable');
      }
      const response = shareId
        ? await dataService.getSharedFileDownload(shareId, fileId)
        : await dataService.getFileDownload(userId!, fileId);
      return response.data;
    },
    { enabled: false, retry: false, cacheTime: 0 },
  );
};

export const useCodeOutputDownload = (url = ''): QueryObserverResult<string> => {
  return useQuery(
    [QueryKeys.fileDownload, url],
    async () => {
      if (!url) {
        console.warn('No user ID provided for file download');
        return;
      }
      const response = await dataService.getCodeOutputDownload(url);
      const blob = response.data;
      const downloadURL = window.URL.createObjectURL(blob);
      return downloadURL;
    },
    {
      enabled: false,
      retry: false,
    },
  );
};

/* Stop on terminal success or after 5 consecutive errors. The cap is
 * tracked in a module-level Map keyed by the scoped query key because React Query
 * v4 resets `state.fetchFailureCount` to 0 on every fetch dispatch
 * (the `'fetch'` action in the reducer), so it can't be used to count
 * errors *across* polls. */
export const PREVIEW_MAX_CONSECUTIVE_ERRORS = 5;
const consecutivePreviewErrors = new Map<string, number>();
const previewErrorKey = (queryKey: readonly unknown[]): string => JSON.stringify(queryKey);

export const fetchFilePreview = async (
  fileId: string,
  queryKey: readonly unknown[] = [QueryKeys.filePreview, fileId],
): Promise<t.TFilePreview> => {
  const key = previewErrorKey(queryKey);
  try {
    const data = await dataService.getFilePreview(fileId);
    consecutivePreviewErrors.delete(key);
    return data;
  } catch (err) {
    consecutivePreviewErrors.set(key, (consecutivePreviewErrors.get(key) ?? 0) + 1);
    throw err;
  }
};

/** Preview fetch for a snapshotted file served through a shared link. */
export const fetchSharedFilePreview = async (
  shareId: string,
  fileId: string,
  queryKey: readonly unknown[] = [QueryKeys.filePreview, fileId, 'share', shareId],
): Promise<t.TFilePreview> => {
  const key = previewErrorKey(queryKey);
  try {
    const data = await dataService.getSharedFilePreview(shareId, fileId);
    consecutivePreviewErrors.delete(key);
    return data;
  } catch (err) {
    consecutivePreviewErrors.set(key, (consecutivePreviewErrors.get(key) ?? 0) + 1);
    throw err;
  }
};

export const previewRefetchInterval = (
  data: t.TFilePreview | undefined,
  query: { queryKey: readonly unknown[] },
): number | false => {
  const key = previewErrorKey(query.queryKey);
  if (data?.status === 'ready' || data?.status === 'failed') {
    consecutivePreviewErrors.delete(key);
    return false;
  }
  if ((consecutivePreviewErrors.get(key) ?? 0) >= PREVIEW_MAX_CONSECUTIVE_ERRORS) {
    consecutivePreviewErrors.delete(key);
    return false;
  }
  return 2500;
};

/** Test-only: clear the consecutive-error counter. */
export const _resetPreviewErrorCounter = (fileId?: string): void => {
  if (!fileId) {
    consecutivePreviewErrors.clear();
    return;
  }
  for (const key of consecutivePreviewErrors.keys()) {
    if (JSON.parse(key)[1] === fileId) consecutivePreviewErrors.delete(key);
  }
};

/**
 * Poll the lifecycle of an inline file preview while background HTML
 * extraction runs.
 *
 * Caller wires `enabled` to `attachment.status === 'pending'` so the
 * query is dormant for terminal-status records. Once enabled, React
 * Query's `refetchInterval` runs at 2.5s; see `previewRefetchInterval`
 * for the auto-stop rules. Dialogs instead enable the query while open.
 *
 * The native `[QueryKeys.filePreview, file_id]` prefix remains invalidatable.
 * Its suffix separates actual private identities from shared-link authorization.
 * Sibling observers within that scope share a poller. Private content is discarded
 * after the last observer leaves; reopening an enabled observer revalidates first.
 */
export const useFilePreview = (
  file_id: string | undefined,
  config?: UseQueryOptions<t.TFilePreview, unknown, t.TFilePreview>,
  shareId?: string,
): QueryObserverResult<t.TFilePreview, unknown> => {
  const user = useRecoilValue(store.user);
  const queriesEnabled = useRecoilValue(store.queriesEnabled);
  const previewUser = queriesEnabled ? user : undefined;
  const queryKey = shareId
    ? [QueryKeys.filePreview, file_id, 'share', shareId, user?.tenantId ?? '', user?.id]
    : [QueryKeys.filePreview, file_id, 'owner', previewUser?.tenantId ?? '', previewUser?.id];
  return useQuery<t.TFilePreview, unknown, t.TFilePreview>(
    queryKey,
    () => {
      // `refetch()` bypasses enabled, so identity must also guard the actual fetch.
      if (!file_id || (!shareId && (!queriesEnabled || !user?.id))) {
        throw new Error('Preview identity unavailable');
      }
      return shareId
        ? fetchSharedFilePreview(shareId, file_id, queryKey)
        : fetchFilePreview(file_id, queryKey);
    },
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      // Shared snapshots keep native defaults. Private previews must revalidate
      // on opening and focus even when another observer retains ready content.
      retry: false,
      refetchInterval: previewRefetchInterval,
      ...config,
      ...(!shareId && {
        cacheTime: 0,
        staleTime: 0,
        keepPreviousData: false,
        initialData: undefined,
        placeholderData: undefined,
        refetchOnMount: 'always' as const,
        refetchOnWindowFocus: 'always' as const,
        refetchOnReconnect: 'always' as const,
      }),
      enabled:
        !!file_id && (!!shareId || (queriesEnabled && !!user?.id)) && (config?.enabled ?? true),
    },
  );
};
