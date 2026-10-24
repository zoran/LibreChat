jest.mock('@librechat/api/mail', () => ({ composeRetentionMailSender: jest.fn() }));
jest.mock('./OutboundMail', () => ({
  readLogo: jest.fn(),
  createOutboundMailDependencies: jest.fn(),
}));
const { composeRetentionMailSender } = require('@librechat/api/mail');
const outbound = require('./OutboundMail');
const { createRetentionMailSender } = require('./RetentionMailSender');

test('wires the existing environment and single transport ports into the typed composition', () => {
  const sender = { sendReminder: jest.fn() };
  composeRetentionMailSender.mockReturnValue(sender);
  expect(createRetentionMailSender(['example.test'])).toBe(sender);
  expect(composeRetentionMailSender).toHaveBeenCalledWith(process.env, ['example.test'], {
    readLogo: outbound.readLogo,
    createMailDependencies: outbound.createOutboundMailDependencies,
  });
});
