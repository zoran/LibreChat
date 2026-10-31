/** Synthetic AV contract evidence for owner tests; never engine/profile/runtime acceptance. */
import type {
  UploadAntivirusCustody,
  UploadAntivirusApproval,
  UploadAntivirusReceipt,
  UploadAntivirusPolicy,
} from '../upload-antivirus';
import type { UploadSecuritySubject } from '../upload-security';
export function antivirusFixture(
  subject: UploadSecuritySubject,
  now: number,
  expiresAt = new Date(now + 60000).toISOString(),
): {
  custody: UploadAntivirusCustody;
  approval: UploadAntivirusApproval;
  receipt: UploadAntivirusReceipt;
  policy: UploadAntivirusPolicy;
} {
  const custody: UploadAntivirusCustody = {
    version: 1,
    slot: 'slot-1',
    podUid: 'pod-1',
    runtimeImage: `registry.invalid/clamav@sha256:${'1'.repeat(64)}`,
    sourceRevision: 'a'.repeat(40),
    engineArtifactSha256: '1'.repeat(64),
    profileSha256: '2'.repeat(64),
    signatureManifestSha256: '3'.repeat(64),
    signatureVerificationSha256: '4'.repeat(64),
    dailyDatabaseVersion: 28169,
    dailyPublishedAt: new Date(now - 60000).toISOString(),
    original: {
      id: '33333333-3333-4333-8333-333333333333',
      pid: 12345,
      startTicks: '100',
      bootId: '44444444-4444-4444-8444-444444444444',
      configurationSha256: '5'.repeat(64),
    },
    subject: { ...subject },
    expiresAt,
  };
  const approval: UploadAntivirusApproval = {
    custody,
    engineVersion: '1.4.6',
    readyObservedAt: new Date(now - 1).toISOString(),
    cleanAt: new Date(now).toISOString(),
  };
  const receipt: UploadAntivirusReceipt = {
    custody,
    state: 'retired',
    originalProcessJoined: true,
    ownedTransientDataRemoved: true,
  };
  const policy: UploadAntivirusPolicy = {
    engineVersion: '1.4.6',
    engineArtifactSha256: custody.engineArtifactSha256,
    profileSha256: custody.profileSha256,
    signatureManifestSha256: custody.signatureManifestSha256,
    signatureVerificationSha256: custody.signatureVerificationSha256,
    signatureMaxAgeMs: 86400000,
  };
  return { custody, approval, receipt, policy };
}
