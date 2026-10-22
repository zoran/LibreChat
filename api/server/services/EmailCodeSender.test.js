jest.mock('@librechat/api', () => ({
  getAuthMode: jest.fn(),
  getEmailCodeSettings: jest.fn(),
  getEmailCodeMailConfig: jest.fn(),
  createBoundedEmailCodeSender: jest.fn(),
}));
jest.mock('./OutboundMail', () => ({
  readLogo: jest.fn(),
  createOutboundMailDependencies: jest.fn(),
}));
const api = require('@librechat/api');
const outbound = require('./OutboundMail');
const { createEmailCodeSender } = require('./EmailCodeSender');

describe('existing login composition through shared transport', () => {
  const original = process.env.EMAIL_CODE_LOGO_FILE;
  beforeEach(() => {
    api.getAuthMode.mockReturnValue('email_code');
    api.getEmailCodeSettings.mockReturnValue({ domains: ['example.test'] });
  });
  afterEach(() => {
    if (original === undefined) delete process.env.EMAIL_CODE_LOGO_FILE;
    else process.env.EMAIL_CODE_LOGO_FILE = original;
  });
  it('preserves default-auth and absent-SMTP gating', () => {
    api.getAuthMode.mockReturnValue('default');
    expect(createEmailCodeSender()).toBeUndefined();
    expect(api.getEmailCodeMailConfig).not.toHaveBeenCalled();
    api.getAuthMode.mockReturnValue('email_code');
    api.getEmailCodeMailConfig.mockReturnValue(undefined);
    expect(createEmailCodeSender()).toBeUndefined();
    expect(outbound.readLogo).not.toHaveBeenCalled();
  });
  it('preserves login settings while using the sole shared MIME and SMTP composition', () => {
    const config = { username: 'login@example.test' };
    const logo = Buffer.from('test-only');
    const deps = { createTransport: jest.fn(), createMimeStream: jest.fn() };
    api.getEmailCodeMailConfig.mockReturnValue(config);
    outbound.readLogo.mockReturnValue(logo);
    outbound.createOutboundMailDependencies.mockReturnValue(deps);
    process.env.EMAIL_CODE_LOGO_FILE = 'logo.png';
    createEmailCodeSender();
    expect(api.getEmailCodeMailConfig).toHaveBeenCalledWith(process.env, ['example.test']);
    expect(outbound.readLogo).toHaveBeenCalledWith('logo.png');
    expect(api.createBoundedEmailCodeSender).toHaveBeenCalledWith(
      { ...config, logoPng: logo },
      deps,
    );
  });
});
