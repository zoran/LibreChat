/** Standalone intake process: no application bootstrap, database or ordinary storage credentials. */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { AppMaintenance } from '../../app/maintenance';
import { createWorkloadMaintenance } from '../../app/maintenance';
import { createMaintenanceIdentity } from '../../app/identity';
import { startSecurityService } from './service';

async function main() {
  const identity = createMaintenanceIdentity(process.env, true);
  const port = Number(process.env.UPLOAD_SECURITY_PORT ?? '8443');
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Security configuration unavailable');
  const material = async (name: string) => {
    const file = process.env[name];
    if (!file || !path.isAbsolute(file)) throw new Error('Security configuration unavailable');
    const bytes = await readFile(file);
    if (!bytes.length || bytes.length > 65536)
      throw new Error('Security configuration unavailable');
    return bytes;
  };
  const [ca, cert, key, policyBytes, peerBytes] = await Promise.all([
    material('UPLOAD_SECURITY_TLS_CA_FILE'),
    material('UPLOAD_SECURITY_TLS_CERT_FILE'),
    material('UPLOAD_SECURITY_TLS_KEY_FILE'),
    material('UPLOAD_SECURITY_POLICY_FILE'),
    material('UPLOAD_SECURITY_PEERS_FILE'),
  ]);
  const service = await startSecurityService({
    instanceId: identity.incarnation,
    port,
    policySha256: process.env.UPLOAD_SECURITY_POLICY_SHA256 ?? '',
    policyBytes,
    peers: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(peerBytes)),
    tls: { ca, cert, key },
    threadPath: path.join(__dirname, 'worker-thread.cjs'),
  });
  let closing = false;
  let maintenance: AppMaintenance | undefined;
  try {
    maintenance = createWorkloadMaintenance({
      env: process.env,
      identity,
      workOwners: { scanner: service.maintenance },
      startupReady: () => !closing,
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

void main().catch(() => {
  console.error('upload_security_start_failed');
  process.exitCode = 1;
});
