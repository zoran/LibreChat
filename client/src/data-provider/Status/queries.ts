/** Status consumes the existing authenticated Data-Provider and QueryClient. */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { dataService, QueryKeys } from 'librechat-data-provider';
const REFRESH_MS = 30_000;
export const statusCode = (error: unknown): number | undefined =>
  (error as { response?: { status?: number }; status?: number } | null)?.response?.status ??
  (error as { status?: number } | null)?.status;
export function useStatusAccessQuery(userId: string | undefined, authenticated: boolean) {
  return useQuery(
    [QueryKeys.statusAccess, userId],
    ({ signal }) => dataService.getStatusAccess({ signal }),
    {
      enabled: authenticated && !!userId,
      retry: false,
      staleTime: 30_000,
      cacheTime: 0,
      refetchOnWindowFocus: true,
    },
  );
}
export function useStatusSnapshotQuery(userId: string | undefined, allowed: boolean) {
  const client = useQueryClient();
  const [visible, setVisible] = useState(() => typeof document !== 'undefined' && !document.hidden);
  const [ending, setEnding] = useState(false);
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    setEnding(false);
    setDenied(false);
  }, [userId]);
  const key = [QueryKeys.statusSnapshot, userId];
  const query = useQuery(key, ({ signal }) => dataService.getStatusSnapshot({ signal }), {
    enabled: allowed && !!userId && visible && !ending && !denied,
    cacheTime: 0,
    staleTime: REFRESH_MS,
    retry: false,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: false,
    refetchInterval: (_data, q) =>
      allowed &&
      visible &&
      !ending &&
      !denied &&
      statusCode(q.state.error) !== 403 &&
      statusCode(q.state.error) !== 401
        ? REFRESH_MS
        : false,
  });
  useEffect(() => {
    const stop = () => {
      void client.cancelQueries([QueryKeys.statusSnapshot, userId]);
    };
    const visibility = () => {
      setVisible(!document.hidden);
      if (document.hidden) stop();
    };
    const continued = () => setEnding(false);
    const ended = () => {
      setEnding(true);
      stop();
      client.removeQueries([QueryKeys.statusSnapshot, userId]);
      client.removeQueries([QueryKeys.statusAccess, userId]);
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('librechat:auth-session-ending', ended);
    window.addEventListener('librechat:auth-session-continued', continued);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('librechat:auth-session-ending', ended);
      window.removeEventListener('librechat:auth-session-continued', continued);
    };
  }, [client, userId]);
  useEffect(() => {
    if (!allowed || statusCode(query.error) === 403 || statusCode(query.error) === 401) {
      if (statusCode(query.error) === 403 || statusCode(query.error) === 401) setDenied(true);
      void client.cancelQueries([QueryKeys.statusSnapshot, userId]);
      client.removeQueries([QueryKeys.statusSnapshot, userId]);
    }
  }, [allowed, query.error, client, userId]);
  return {
    ...query,
    visible,
    denied,
    data:
      !allowed ||
      ending ||
      denied ||
      statusCode(query.error) === 403 ||
      statusCode(query.error) === 401
        ? undefined
        : query.data,
  };
}
