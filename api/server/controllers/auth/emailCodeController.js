const {
  createEmailCodeAuth,
  getEmailCodeSettings,
  clearCloudFrontCookies,
} = require('@librechat/api');
const methods = require('~/models');
const { authWrite } = require('~/server/services/LegacyAuthMaintenance');
const { getAppConfig } = require('~/server/services/Config');
const { createEmailCodeSender } = require('~/server/services/EmailCodeSender');

/** Auth owns HTTP/session composition; the deployment's approved mail adapter owns transport. */
module.exports = createEmailCodeAuth({
  repository: methods,
  sender: createEmailCodeSender(),
  write: authWrite,
  clearAuxiliaryCookies: clearCloudFrontCookies,
  getBalance: async () =>
    (await getAppConfig({ tenantId: getEmailCodeSettings().tenantId })).balance,
});
