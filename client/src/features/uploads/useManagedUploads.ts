import { useCallback, useEffect, useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ManagedUploadSnapshot, ManagedUploadView } from 'librechat-data-provider';
import { acquireUploadLive, getUploadAdmission, readManagedUploadSnapshot } from './live';
import { useGetStartupConfig } from '~/data-provider';
import store from '~/store';

export function useManagedUploads() {
  const client = useQueryClient();
  const user = useRecoilValue(store.user);
  const { data: config } = useGetStartupConfig();
  const enabled = config?.managedUploads?.enabled === true;
  const eligible = enabled && config?.managedUploads?.eligible === true && !!user;
  const key = useMemo(
    () => ['managed-uploads', user?.tenantId ?? '', user?.id ?? ''],
    [user?.tenantId, user?.id],
  );
  const query = useQuery<ManagedUploadSnapshot>(
    key,
    ({ signal }) => readManagedUploadSnapshot(client, key, signal),
    {
      enabled: eligible,
      staleTime: 15_000,
      cacheTime: 0,
      retry: 1,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
  );
  useEffect(() => (eligible ? acquireUploadLive(client, key) : undefined), [client, key, eligible]);
  const getAdmissionsPaused = useCallback(
    () => (eligible ? getUploadAdmission(client, key) : null),
    [client, key, eligible],
  );
  const refresh = useCallback(
    () => client.invalidateQueries({ queryKey: key, exact: true }),
    [client, key],
  );
  const waitForReady = useCallback(
    (id: string, signal: AbortSignal): Promise<ManagedUploadView> =>
      new Promise((resolve, reject) => {
        let finished = false;
        let unsubscribe = () => {};
        const timeout = setTimeout(() => finish(new Error('unavailable')), 60 * 60_000);
        const aborted = () => finish(new DOMException('Aborted', 'AbortError'));
        const finish = (error?: Error, view?: ManagedUploadView) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          unsubscribe();
          signal.removeEventListener('abort', aborted);
          if (error) reject(error);
          else resolve(view!);
        };
        const read = () => {
          const operation = client
            .getQueryData<ManagedUploadSnapshot>(key)
            ?.operations.find((row) => row.id === id);
          if (operation?.canUseInComposer && operation.attachment) finish(undefined, operation);
          else if (
            operation &&
            ['failed', 'cancelled', 'deleted', 'expired'].includes(operation.state)
          ) {
            finish(new Error(operation.error ?? operation.state));
          }
        };
        unsubscribe = client.getQueryCache().subscribe(read);
        if (signal.aborted) {
          aborted();
          return;
        }
        signal.addEventListener('abort', aborted, { once: true });
        read();
      }),
    [client, key],
  );
  return {
    enabled,
    eligible,
    sessionKey: JSON.stringify(key),
    ...query,
    admissionsPaused: getAdmissionsPaused(),
    getAdmissionsPaused,
    refresh,
    waitForReady,
  };
}
