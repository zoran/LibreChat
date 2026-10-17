import { randomUUID } from 'node:crypto';

export interface MaintenanceIdentity {
  podUid: string;
  source: string;
  incarnation: string;
}

/** A Pod survives container restarts; the process incarnation must not. */
export function createMaintenanceIdentity(
  env: Record<string, string | undefined>,
  required: boolean,
): MaintenanceIdentity {
  const source = env.BUILD_COMMIT ?? '';
  const podUid = env.POD_UID ?? '';
  if (
    required &&
    (!/^[a-f0-9]{40}$/.test(source) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(podUid))
  ) {
    throw new Error('Invalid application runtime identity');
  }
  return Object.freeze({ podUid, source, incarnation: randomUUID() });
}
