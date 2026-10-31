/** Standalone intake process: no application bootstrap, database or ordinary storage credentials. */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { startSecurityService } from './service';
import { createAntivirusRuntime, readAntivirusConfiguration } from './antivirus-runtime';
import { antivirusStartupFailure } from './antivirus-process-events';
import { startSecurityProcess } from './security-process';

async function main() {
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
  // Fixed readonly Root-published files; no request can opt into AV or supply a loaded tuple.
  const antivirus = createAntivirusRuntime(
    readAntivirusConfiguration({
      profileSha256: process.env.UPLOAD_SECURITY_AV_PROFILE_SHA256 ?? '',
      generationSha256: process.env.UPLOAD_SECURITY_AV_GENERATION_SHA256 ?? '',
      signatureMaxAgeMs: Number(process.env.UPLOAD_SECURITY_AV_SIGNATURE_MAX_AGE_MS ?? ''),
      slot: process.env.UPLOAD_SECURITY_AV_SLOT ?? '',
      podUid: process.env.POD_UID ?? '',
      sourceRevision: process.env.BUILD_COMMIT ?? '',
    }),
  );
  await startSecurityProcess({
    env: process.env,
    serviceOptions: {
      antivirus,
      port,
      policySha256: process.env.UPLOAD_SECURITY_POLICY_SHA256 ?? '',
      policyBytes,
      peers: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(peerBytes)),
      tls: { ca, cert, key },
      threadPath: path.join(__dirname, 'worker-thread.cjs'),
      pdf,
    },
  });
}

void main().catch((error) => {
  console.error('upload_security_start_failed');
  const original = antivirusStartupFailure(error);
  if (original) console.error('upload_security_av_original_failed ' + original);
  process.exitCode = 1;
});
