/** Housekeeping-only wiring; configuration and construction behavior belongs to the typed mail owner. */
const { composeRetentionMailSender } = require('@librechat/api/mail');
const { readLogo, createOutboundMailDependencies } = require('./OutboundMail');

module.exports = {
  createRetentionMailSender: (allowedDomains) =>
    composeRetentionMailSender(process.env, allowedDomains, {
      readLogo,
      createMailDependencies: createOutboundMailDependencies,
    }),
};
