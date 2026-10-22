/** Login runtime composition; SMTP implementation lives in OutboundMail. */
const { readLogo, createOutboundMailDependencies } = require('./OutboundMail');
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
  return createBoundedEmailCodeSender(
    { ...config, logoPng: readLogo(process.env.EMAIL_CODE_LOGO_FILE) },
    createOutboundMailDependencies(),
  );
}

module.exports = { createEmailCodeSender };
