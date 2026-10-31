/** Actual current AV readers enforce identity, chronology and retirement; fixtures are not AV scans. */
import {
  readUploadSecurityExecution,
  readUploadSecurityInspection,
  readUploadSecuritySettlement,
  readUploadSecurityApproval,
  readHistoricalUploadSecurityApproval,
  isCompleteUploadSecuritySettlement,
  matchesHistoricalUploadSecurityApproval,
  isUploadSecurityDecision,
} from './upload-security';
import {
  readUploadAntivirusCustody,
  readUploadAntivirusReceipt,
  matchesCurrentUploadAntivirus,
} from './upload-antivirus';
import { antivirusFixture } from './__fixtures__/upload-antivirus';
const now = Date.UTC(2026, 9, 30, 22);
const subject = {
  tenantId: 'tenant',
  userId: 'user',
  operationId: 'operation',
  transferGeneration: 1,
  mediaType: 'text/plain',
  bytes: 5,
  sha256: 'a'.repeat(64),
};
const av = () => antivirusFixture(subject, now);
const execution = () => ({
  version: 3,
  attemptId: 'operation.1',
  instanceId: '11111111-1111-4111-8111-111111111111',
  executionId: '22222222-2222-4222-8222-222222222222',
  expiresAt: av().custody.expiresAt,
  custody: { kind: 'none' },
  antivirus: av().custody,
});
const approval = () => ({
  version: 2,
  decision: 'approved',
  policySha256: 'b'.repeat(64),
  subject,
  scannerVersion: 'fixture',
  checkedAt: new Date(now).toISOString(),
  coverage: { complete: true, pages: 1, parts: 1 },
  antivirus: av().approval,
});
const settlement = () => ({
  execution: execution(),
  writerStopped: true,
  transientDataRemoved: true,
  antivirusReceipt: av().receipt,
});
it('accepts the full current original while rejecting classifier-only current contracts', () => {
  expect(readUploadSecurityExecution(execution())).not.toBeNull();
  expect(readUploadSecurityApproval(approval())).not.toBeNull();
  expect(
    readUploadSecurityInspection({ decision: approval(), settlement: settlement() }),
  ).not.toBeNull();
  const { antivirus: _unused, ...old } = approval();
  expect(readUploadSecurityApproval({ ...old, version: 1 })).toBeNull();
  expect(readHistoricalUploadSecurityApproval({ ...old, version: 1 })).not.toBeNull();
  const { antivirus: _scope, ...legacy } = execution();
  expect(readUploadSecurityExecution({ ...legacy, version: 2 })).toBeNull();
});
it.each([
  'slot',
  'podUid',
  'runtimeImage',
  'engineArtifactSha256',
  'profileSha256',
  'signatureManifestSha256',
  'signatureVerificationSha256',
])('refuses a receipt for a different original %s', (key) => {
  const r = av().receipt;
  expect(
    readUploadAntivirusReceipt({ ...r, custody: { ...r.custody, [key]: 'foreign' } }, av().custody),
  ).toBeNull();
});
it('requires retirement of the exact original process and its owned transient scope', () => {
  const s = settlement();
  expect(isCompleteUploadSecuritySettlement(s, s.execution)).toBe(true);
  for (const receipt of [
    null,
    { ...s.antivirusReceipt, state: 'unknown' },
    { ...s.antivirusReceipt, originalProcessJoined: false },
    { ...s.antivirusReceipt, ownedTransientDataRemoved: false },
  ])
    expect(
      isCompleteUploadSecuritySettlement({ ...s, antivirusReceipt: receipt }, s.execution),
    ).toBe(false);
  const { antivirusReceipt: _missing, ...without } = s;
  expect(readUploadSecuritySettlement(without)).toBeNull();
});
it('binds all birth/configuration identity and rejects accessors before reading them', () => {
  const r = av().receipt;
  expect(
    readUploadAntivirusReceipt(
      { ...r, custody: { ...r.custody, original: { ...r.custody.original, pid: 100 } } },
      r.custody,
    ),
  ).toBeNull();
  const get = jest.fn(() => r.custody.original);
  const bad = { ...r.custody };
  Object.defineProperty(bad, 'original', { get, enumerable: true });
  expect(readUploadAntivirusCustody(bad)).toBeNull();
  expect(get).not.toHaveBeenCalled();
});
it('enforces selected current generation/TTL without aging out historical accepted evidence', () => {
  const f = av();
  expect(matchesCurrentUploadAntivirus(f.approval, f.custody, now, f.policy)).toBe(true);
  expect(matchesCurrentUploadAntivirus(f.approval, f.custody, now + 86400001, f.policy)).toBe(
    false,
  );
  expect(
    matchesCurrentUploadAntivirus(f.approval, f.custody, now, {
      ...f.policy,
      engineVersion: 'replacement',
    }),
  ).toBe(false);
  expect(
    matchesHistoricalUploadSecurityApproval(
      approval(),
      subject,
      'b'.repeat(64),
      now + 7 * 86400000,
    ),
  ).toBe(true);
});
it('cannot substitute startup/another execution or classify malware as an approval/uninspectable result', () => {
  const current = approval();
  expect(
    readUploadSecurityInspection({
      decision: {
        ...current,
        antivirus: {
          ...current.antivirus,
          custody: { ...current.antivirus.custody, slot: 'startup' },
        },
      },
      settlement: settlement(),
    }),
  ).toBeNull();
  expect(isUploadSecurityDecision({ version: 1, decision: 'rejected', reason: 'malware' })).toBe(
    true,
  );
  expect(
    isUploadSecurityDecision({ version: 1, decision: 'uninspectable', reason: 'malware' }),
  ).toBe(false);
});
