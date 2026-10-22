/** Application composition only; shared MIME and logo behavior belongs to @librechat/api. */
const { createOutboundMailAdapter } = require('@librechat/api/mail');
const nodemailer = require('nodemailer');
// Public package export of the pinned Nodemailer version.
const MailComposer = require('nodemailer/lib/mail-composer');
const paths = require('~/config/paths');

module.exports = createOutboundMailAdapter({
  getDist: () => paths.dist,
  compileMime: (message) => new MailComposer(message).compile(),
  createTransport: (options) => nodemailer.createTransport(options),
});
