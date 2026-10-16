const nodemailer = require('nodemailer');
const fs = require('node:fs');
const path = require('node:path');
const paths = require('~/config/paths');
const {
  createBoundedEmailCodeSender,
  getEmailCodeMailConfig,
  getEmailCodeSettings,
  getAuthMode,
} = require('@librechat/api');

/** Only a bounded static PNG basename under the existing deployment assets mount. */
function readLogo(name) {
  if (name == null || name === '') return undefined;
  if (!/^[a-zA-Z0-9_-]+\.png$/.test(name)) throw new Error('Invalid email logo asset');
  const fd = fs.openSync(
    path.join(paths.dist, 'assets', name),
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 33 || stat.size > 65536)
      throw new Error('Invalid email logo asset');
    const content = Buffer.alloc(stat.size);
    if (fs.readSync(fd, content, 0, content.length, 0) !== content.length)
      throw new Error('Invalid email logo asset');
    return content;
  } finally {
    fs.closeSync(fd);
  }
}

/** The approved deployment configuration is separate from upstream's permissive EMAIL_* transport. */
function createEmailCodeSender() {
  if (getAuthMode() === 'default') return undefined;
  const config = getEmailCodeMailConfig(process.env, getEmailCodeSettings().domains);
  if (!config) return undefined;
  return createBoundedEmailCodeSender(
    { ...config, logoPng: readLogo(process.env.EMAIL_CODE_LOGO_FILE) },
    {
      createTransport: (options) => nodemailer.createTransport(options),
    },
  );
}

module.exports = { createEmailCodeSender };
