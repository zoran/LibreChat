const nodemailer = require('nodemailer');
const {
  createBoundedEmailCodeSender,
  getEmailCodeMailConfig,
  getEmailCodeSettings,
  getAuthMode,
} = require('@librechat/api');

/** The approved deployment configuration is separate from upstream's permissive EMAIL_* transport. */
function createEmailCodeSender() {
  if (getAuthMode() === 'default') return undefined;
  const config = getEmailCodeMailConfig(process.env, getEmailCodeSettings().domains);
  if (!config) return undefined;
  return createBoundedEmailCodeSender(config, {
    createTransport: (options) => nodemailer.createTransport(options),
  });
}

module.exports = { createEmailCodeSender };
