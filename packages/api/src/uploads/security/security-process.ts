/** Private scanner process composition owns real identity, maintenance, signals and joined retirement. */
import type { AppMaintenance } from '../../app/maintenance';
import { NOT_OWNED_STORAGE_PROVIDERS } from '../../storage/providerObservation';
import { createWorkloadMaintenance } from '../../app/maintenance';
import { createMaintenanceIdentity } from '../../app/identity';
import { startSecurityService } from './service';

/** Trusted composition only; production entry supplies the mandatory Root-qualified runtime. */
export async function startSecurityProcess({
  env,
  serviceOptions,
}: {
  env: Record<string, string | undefined>;
  serviceOptions: Omit<Parameters<typeof startSecurityService>[0], 'instanceId'>;
}): Promise<void> {
  const identity = createMaintenanceIdentity(env, true);
  const service = await startSecurityService({
    ...serviceOptions,
    instanceId: identity.incarnation,
  });
  let closing = false;
  let maintenance: AppMaintenance | undefined;
  try {
    maintenance = createWorkloadMaintenance({
      env,
      identity,
      workOwners: { scanner: service.maintenance },
      fileDomainOwners: ['scanner'],
      readStorageProviders: () => NOT_OWNED_STORAGE_PROVIDERS,
      // Availability proves startup selftests+retirement, not a currently loaded/live AV original.
      startupReady: () => !closing && service.available(),
    });
    await maintenance.listen();
  } catch (error) {
    await service.close(AbortSignal.timeout(30_000));
    await maintenance?.close();
    throw error;
  }
  const close = () => {
    if (closing) return;
    closing = true;
    void service
      .close(AbortSignal.timeout(30_000))
      .finally(() => maintenance!.close())
      .then(
        (result) => {
          process.exitCode = result.complete ? 0 : 1;
        },
        () => {
          process.exitCode = 1;
        },
      );
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}
