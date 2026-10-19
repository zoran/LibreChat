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
  // Only deployment-mounted configuration can provide the private OCR origin/assets. Absence
  // keeps PDF preparation closed; no upload, browser or ordinary model configuration can opt in.
  let pdf: Parameters<typeof startSecurityService>[0]['pdf'];
  if (process.env.UPLOAD_SECURITY_PDF_PROFILE_FILE) {
    const [profileBytes, providerCa, providerCert, providerKey, apiKeyBytes] = await Promise.all([
      material('UPLOAD_SECURITY_PDF_PROFILE_FILE'),
      material('UPLOAD_SECURITY_OCR_CA_FILE'),
      material('UPLOAD_SECURITY_OCR_CERT_FILE'),
      material('UPLOAD_SECURITY_OCR_KEY_FILE'),
      material('UPLOAD_SECURITY_OCR_API_KEY_FILE'),
    ]);
    try {
      const profile = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(profileBytes));
      if (
        !profile ||
        Object.keys(profile).sort().join(',') !== 'process,provider' ||
        !profile.provider ||
        Object.keys(profile.provider).sort().join(',') !==
          'allowedHosts,binding,certificateSha256,endpoint'
      )
        throw new Error('Security configuration unavailable');
      pdf = {
        process: profile.process,
        provider: {
          ...profile.provider,
          tls: { ca: providerCa, cert: providerCert, key: providerKey },
          apiKey: new TextDecoder('utf-8', { fatal: true }).decode(apiKeyBytes).trimEnd(),
        },
      };
    } finally {
      profileBytes.fill(0);
      apiKeyBytes.fill(0);
    }
  }
  const service = await startSecurityService({
    instanceId: identity.incarnation,
    port,
    policySha256: process.env.UPLOAD_SECURITY_POLICY_SHA256 ?? '',
    policyBytes,
    peers: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(peerBytes)),
    tls: { ca, cert, key },
    threadPath: path.join(__dirname, 'worker-thread.cjs'),
    pdf,
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
