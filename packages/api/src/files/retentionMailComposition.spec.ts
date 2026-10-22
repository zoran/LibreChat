import { rootCertificates } from 'node:tls';
import { composeRetentionMailSender } from './retentionMailComposition';
const environment = {
  RETENTION_MAIL_ENABLED: 'true',
  RETENTION_SMTP_HOSTS: '["mail.example.test"]',
  RETENTION_SMTP_USERNAME: 'retention@example.test',
  RETENTION_SMTP_PASSWORD: 'synthetic-only',
  RETENTION_SMTP_CA: rootCertificates[0],
  RETENTION_SMTP_TLS_SERVERNAME: 'mail.example.test',
  RETENTION_SMTP_FROM: 'no-reply@example.test',
  APP_TITLE: 'Portal',
};
function ports() {
  return {
    readLogo: jest.fn(() => undefined),
    createMailDependencies: jest.fn(() => ({
      createMimeStream: jest.fn(() => {
        throw new Error('not sending');
      }),
      createTransport: jest.fn(() => {
        throw new Error('not sending');
      }),
    })),
  };
}
test('disabled composition touches no runtime port and never borrows login credentials', () => {
  const runtime = ports();
  expect(
    composeRetentionMailSender(
      { EMAIL_CODE_SMTP_PASSWORD: 'login-only' },
      ['example.test'],
      runtime,
    ),
  ).toBeUndefined();
  expect(runtime.readLogo).not.toHaveBeenCalled();
  expect(runtime.createMailDependencies).not.toHaveBeenCalled();
});
test('explicitly enabled partial retention configuration fails before runtime construction', () => {
  const runtime = ports();
  expect(() =>
    composeRetentionMailSender(
      { RETENTION_MAIL_ENABLED: 'true', EMAIL_CODE_SMTP_PASSWORD: 'login-only' },
      ['example.test'],
      runtime,
    ),
  ).toThrow('Invalid retention SMTP configuration');
  expect(runtime.readLogo).not.toHaveBeenCalled();
});
test('complete dedicated configuration constructs an inert typed sender through injected ports', () => {
  const runtime = ports();
  expect(
    composeRetentionMailSender(environment, ['example.test'], runtime)?.sendReminder,
  ).toBeInstanceOf(Function);
  expect(runtime.readLogo).toHaveBeenCalledWith(undefined);
  expect(runtime.createMailDependencies).toHaveBeenCalledTimes(1);
  expect(
    runtime.createMailDependencies.mock.results[0].value.createTransport,
  ).not.toHaveBeenCalled();
});
