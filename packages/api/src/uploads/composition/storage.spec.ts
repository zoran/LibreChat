/** Normal typed composition keeps policy selection private and all new original writes closed. */
import type { ManagedUploadsConfig } from 'librechat-data-provider';
import type { UploadSecurityPort } from '../contract';
import { createNasAntivirusAdmission, selectManagedUploadConfiguration } from './storage';
import { loadNasAntivirusClientPolicy } from '../antivirusAdmissionPolicy';

jest.mock('../antivirusAdmissionPolicy', () => ({
  loadNasAntivirusClientPolicy: jest.fn(() => {
    throw new Error('fixture stops at immutable policy acquisition');
  }),
}));

it('reads only the injected base application configuration', async () => {
  const selection = {} as ManagedUploadsConfig;
  const getAppConfig = jest.fn(async () => ({ managedUploads: selection }));
  expect(await selectManagedUploadConfiguration(getAppConfig)).toBe(selection);
  expect(getAppConfig).toHaveBeenCalledTimes(1);
});

it('uses the typed24h baseline when the optional antivirus object is absent', () => {
  const configuration = { storage: { kind: 'nas-s3' } } as ManagedUploadsConfig;
  const security: Pick<UploadSecurityPort, 'policySha256'> = { policySha256: 'a'.repeat(64) };
  expect(() =>
    createNasAntivirusAdmission({
      configuration,
      security,
      env: { DOCUMENT_SECURITY_AV_CLIENT_POLICY_SHA256: 'b'.repeat(64) },
    }),
  ).toThrow('fixture stops at immutable policy acquisition');
  expect(loadNasAntivirusClientPolicy).toHaveBeenLastCalledWith({
    sha256: 'b'.repeat(64),
    signatureMaxAgeMs: 86400000,
  });
});
