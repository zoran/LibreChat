/** Policy boundary fixtures are public wire data; no real AV/process/mount qualification is claimed. */
import { readUploadSecurityApproval, readUploadSecurityExecution } from 'librechat-data-provider';
import { parseNasAntivirusClientPolicy } from './antivirusAdmissionPolicy';
import { createNasAntivirusAdmissionGuard } from './antivirusAdmission';
import fixture from './security/fixtures/response-budget.json';
const wire = {
  ...fixture,
  execution: {
    ...fixture.execution,
    antivirus: { ...fixture.execution.antivirus, slot: 'scanner-1' },
  },
  inspection: {
    ...fixture.inspection,
    decision: {
      ...fixture.inspection.decision,
      antivirus: {
        ...fixture.inspection.decision.antivirus,
        custody: { ...fixture.inspection.decision.antivirus.custody, slot: 'scanner-1' },
      },
    },
  },
};
const approval = readUploadSecurityApproval(wire.inspection.decision);
const execution = readUploadSecurityExecution(wire.execution);
if (!approval || !execution || execution.version !== 3) throw new Error('Invalid current fixture');
const custody = execution.antivirus;
const checkedAt = approval.checkedAt;
const policySha256 = approval.policySha256;
const policy = {
  schema: 1,
  image: custody.runtimeImage,
  sourceRevision: custody.sourceRevision,
  engineVersion: approval.antivirus.engineVersion,
  engineArtifactSha256: custody.engineArtifactSha256,
  profileSha256: custody.profileSha256,
  signatureManifestSha256: custody.signatureManifestSha256,
  signatureVerificationSha256: custody.signatureVerificationSha256,
  signatureMaxAgeMs: 86400000,
  slots: [custody.slot, 'other-scanner'],
};
const input = {
  ...approval.subject,
  generation: approval.subject.transferGeneration,
  approval,
  execution,
};
function admit(value: unknown = policy, at = Date.parse(checkedAt)) {
  return createNasAntivirusAdmissionGuard({
    policy: value,
    securityPolicySha256: policySha256,
    now: () => at,
  });
}
it('matches real closed current readers against the exact trusted generation policy', () => {
  expect(admit()(input)).toBe(true);
});
it.each([
  'image',
  'sourceRevision',
  'engineVersion',
  'engineArtifactSha256',
  'profileSha256',
  'signatureManifestSha256',
  'signatureVerificationSha256',
])('rejects a changed trusted expected %s', (key) => {
  let changed = 'f'.repeat(64);
  if (key === 'image') changed = 'synthetic@sha256:' + 'f'.repeat(64);
  else if (key === 'sourceRevision') changed = 'f'.repeat(40);
  else if (key === 'engineVersion') changed = 'other';
  const value = { ...policy, [key]: changed };
  expect(admit(value)(input)).toBe(false);
});
it('rejects other slots, expired signatures, subject substitution and historical execution', () => {
  expect(admit({ ...policy, slots: ['elsewhere1', 'elsewhere2'] })(input)).toBe(false);
  expect(admit(policy, Date.parse(custody.dailyPublishedAt) + 86400001)(input)).toBe(false);
  expect(admit()({ ...input, operationId: 'foreign-operation' })).toBe(false);
  const historical = { ...input, execution: { ...execution, version: 2 as const } };
  expect(admit()(historical)).toBe(false);
});
it('rejects unknown policy fields and unsafe signature-age configuration', () => {
  for (const value of [
    { ...policy, ready: true },
    { ...policy, signatureMaxAgeMs: 86400001 },
    { ...policy, slots: [custody.slot, custody.slot] },
  ])
    expect(() => parseNasAntivirusClientPolicy(value)).toThrow('NAS antivirus policy unavailable');
});
