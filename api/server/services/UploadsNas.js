/** Thin server wiring; normal NAS/security/backend behavior belongs to the typed upload owner. */
const {
  createManagedUploadSecurityClient,
  createLegacyUploadStorage: legacyStorage,
  selectManagedUploadConfiguration,
  createNasAntivirusAdmission,
  createNormalUploadStorage,
} = require('@librechat/api');
module.exports = {
  managedSecurityClient: (signal) =>
    createManagedUploadSecurityClient({ env: process.env, signal }),
  createLegacyUploadStorage: (client, platform) =>
    legacyStorage({
      client,
      platform,
      bucket: process.env.AWS_BUCKET_NAME,
    }),
  selectedManagedUploads: () =>
    selectManagedUploadConfiguration(() => {
      const { getAppConfig } = require('./Config/app');
      return getAppConfig();
    }),
  nasAntivirusAdmission: (configuration, security) =>
    createNasAntivirusAdmission({
      configuration,
      security,
      env: process.env,
    }),
  createNormalNasStorage: createNormalUploadStorage,
};
