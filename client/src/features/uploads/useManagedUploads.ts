/** useManagedUploads owns identity-scoped upload status and current admission observations. */
import { useCallback, useEffect, useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { readManagedUploadFeatureCapability } from 'librechat-data-provider';
import type { ManagedUploadSnapshot, ManagedUploadView } from 'librechat-data-provider';
import {
  acquireUploadLive,
  getUploadAdmission,
  readManagedUploadSnapshot,
  getUploadStorageAvailability,
  getUploadManualPause,
} from './live';
import { useGetStartupConfig } from '~/data-provider';
import { uploadAdmissionError } from './admission';
import store from '~/store';

export function useManagedUploads() {
  const client = useQueryClient();
  const user = useRecoilValue(store.user);
  const { data: config } = useGetStartupConfig();
  const capability = readManagedUploadFeatureCapability(config?.managedUploads);
  const key = useMemo(
    () => ['managed-uploads', user?.tenantId ?? '', user?.id ?? ''],
    [user?.tenantId, user?.id],
  );
  // A vanished/reset startup payload cannot silently switch an observed NAS identity to legacy.
  const storageWasRequired = getUploadStorageAvailability(client, key) !== undefined;
  const enabled =
    capability?.enabled === true || config?.managedUploads?.enabled === true || storageWasRequired;
  const eligible = enabled && capability?.enabled === true && capability.eligible && !!user;
  const storageRequired =
    storageWasRequired || (capability?.storageAvailabilityRequired ?? enabled);
  const query = useQuery<ManagedUploadSnapshot>(
    key,
    ({ signal }) => readManagedUploadSnapshot(client, key, signal, storageRequired),
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
  const getAdmissionsPaused = useCallback(() => {
    if (!eligible) return null;
    getUploadStorageAvailability(client, key, storageRequired);
    return getUploadAdmission(client, key);
  }, [client, key, eligible, storageRequired]);
  const getNewUploadError = useCallback(() => {
    if (!enabled) return null;
    return uploadAdmissionError({
      eligible,
      admissionsPaused: getUploadAdmission(client, key),
      storageAvailability: getUploadStorageAvailability(client, key, storageRequired),
      availableBytes: client.getQueryData<ManagedUploadSnapshot>(key)?.usage?.availableBytes,
    });
  }, [client, key, enabled, eligible, storageRequired]);
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
    storageAvailabilityRequired: storageRequired,
    // Presentation only: the server eligibility bit remains the admission authority.
    isGuestAccount: eligible && user?.provider === 'browser',
    sessionKey: JSON.stringify(key),
    ...query,
    admissionsPaused: eligible ? getUploadManualPause(client, key) : null,
    storageAvailability: eligible
      ? getUploadStorageAvailability(client, key, storageRequired)
      : undefined,
    newUploadError: getNewUploadError(),
    getNewUploadError,
    getAdmissionsPaused,
    refresh,
    waitForReady,
  };
}
