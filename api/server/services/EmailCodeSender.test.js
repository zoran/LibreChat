const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
jest.mock('@librechat/api', () => ({
  getAuthMode: () => 'email_code',
  getEmailCodeSettings: () => ({ domains: ['example.test'] }),
  getEmailCodeMailConfig: () => ({ hosts: ['fixture.invalid'] }),
  createBoundedEmailCodeSender: jest.fn((config) => config),
}));
jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));
const paths = require('~/config/paths');
const { createEmailCodeSender } = require('./EmailCodeSender');

describe('deployment email logo boundary', () => {
  const originalDist = paths.dist;
  const originalSetting = process.env.EMAIL_CODE_LOGO_FILE;
  let directory;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'email-logo-'));
    fs.mkdirSync(path.join(directory, 'assets'));
    paths.dist = directory;
  });
  afterEach(() => {
    paths.dist = originalDist;
    if (originalSetting === undefined) delete process.env.EMAIL_CODE_LOGO_FILE;
    else process.env.EMAIL_CODE_LOGO_FILE = originalSetting;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  it('reads the configured local basename once as bytes', () => {
    const content = Buffer.alloc(40, 1);
    fs.writeFileSync(path.join(directory, 'assets/logo.png'), content);
    process.env.EMAIL_CODE_LOGO_FILE = 'logo.png';
    expect(createEmailCodeSender().logoPng).toEqual(content);
  });
  it('refuses traversal, URLs, oversized files and symbolic links', () => {
    for (const name of ['../secret.png', '/tmp/logo.png', 'https://x.test/logo.png']) {
      process.env.EMAIL_CODE_LOGO_FILE = name;
      expect(() => createEmailCodeSender()).toThrow();
    }
    fs.writeFileSync(path.join(directory, 'assets/large.png'), Buffer.alloc(65537));
    fs.symlinkSync('large.png', path.join(directory, 'assets/link.png'));
    for (const name of ['large.png', 'link.png']) {
      process.env.EMAIL_CODE_LOGO_FILE = name;
      expect(() => createEmailCodeSender()).toThrow();
    }
  });
  it('preserves the upstream configuration when no logo is selected', () => {
    delete process.env.EMAIL_CODE_LOGO_FILE;
    expect(createEmailCodeSender().logoPng).toBeUndefined();
  });
});
