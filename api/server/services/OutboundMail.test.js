const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const paths = require('~/config/paths');
const { readLogo, createOutboundMailDependencies } = require('./OutboundMail');

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
    expect(readLogo(process.env.EMAIL_CODE_LOGO_FILE)).toEqual(content);
  });
  it('refuses traversal, URLs, oversized files and symbolic links', () => {
    for (const name of ['../secret.png', '/tmp/logo.png', 'https://x.test/logo.png']) {
      process.env.EMAIL_CODE_LOGO_FILE = name;
      expect(() => readLogo(process.env.EMAIL_CODE_LOGO_FILE)).toThrow();
    }
    fs.writeFileSync(path.join(directory, 'assets/large.png'), Buffer.alloc(65537));
    fs.symlinkSync('large.png', path.join(directory, 'assets/link.png'));
    for (const name of ['large.png', 'link.png']) {
      process.env.EMAIL_CODE_LOGO_FILE = name;
      expect(() => readLogo(process.env.EMAIL_CODE_LOGO_FILE)).toThrow();
    }
  });
  it('preserves the upstream configuration when no logo is selected', () => {
    delete process.env.EMAIL_CODE_LOGO_FILE;
    expect(readLogo(process.env.EMAIL_CODE_LOGO_FILE)).toBeUndefined();
  });
});

// The pinned Nodemailer public composer is exercised without any network transport.
describe('local exact MIME composition', () => {
  const rich = {
    from: { name: 'Portal', address: 'no-reply@example.test' },
    to: { address: 'person@example.test' },
    envelope: { from: 'no-reply@example.test', to: ['person@example.test'] },
    subject: 'Sicherheitsgründe äöü',
    text: 'Datei <&>\nText',
    html: '<p>Datei &lt;&amp;&gt;</p>',
    messageId: '<fixed@submission.local>',
    date: new Date('2026-10-21T12:00:00.000Z'),
    attachments: [
      {
        filename: 'application-logo.png',
        content: Buffer.from('test-logo'),
        contentType: 'image/png',
        contentDisposition: 'inline',
        cid: 'application-logo@local',
      },
    ],
    disableFileAccess: true,
    disableUrlAccess: true,
  };
  async function collect(stream) {
    const parts = [];
    for await (const part of stream) parts.push(part);
    return Buffer.concat(parts);
  }
  it('encodes headers, alternatives and CID bytes using CRLF and preserves exact bytes in raw mode', async () => {
    const deps = createOutboundMailDependencies();
    const bytes = await collect(deps.createMimeStream(rich));
    const mime = bytes.toString('utf8');
    expect(mime).toContain('multipart/related');
    expect(mime).toContain('multipart/alternative');
    expect(mime).toContain('Content-ID: <application-logo@local>');
    expect(mime).toContain('dGVzdC1sb2dv');
    expect(mime).toContain('=?UTF-8?');
    expect(mime).not.toMatch(/(?<!\r)\n/);
    expect(mime.endsWith('\r\n')).toBe(true);
    const MailComposer = require('nodemailer/lib/mail-composer');
    const raw = await collect(new MailComposer({ raw: bytes }).compile().createReadStream());
    expect(raw.equals(bytes)).toBe(true);
  });
  it('counts MIME overhead and encoded Unicode rather than JavaScript string length', async () => {
    const plain = { ...rich, attachments: undefined, html: undefined, text: 'ä'.repeat(50000) };
    const bytes = await collect(createOutboundMailDependencies().createMimeStream(plain));
    expect(bytes.length).toBeGreaterThan(plain.text.length);
    expect(bytes.length).toBeGreaterThan(Buffer.byteLength(plain.text));
  });
  it('cancels actual upstream MIME streams when the bounded consumer destroys its output', async () => {
    const { Readable } = require('node:stream');
    const originalPipe = Readable.prototype.pipe;
    const streams = new Set();
    const spy = jest.spyOn(Readable.prototype, 'pipe').mockImplementation(function (
      destination,
      ...args
    ) {
      streams.add(this);
      streams.add(destination);
      return originalPipe.call(this, destination, ...args);
    });
    try {
      const output = createOutboundMailDependencies().createMimeStream({
        ...rich,
        attachments: undefined,
        html: undefined,
        text: 'large local body '.repeat(100000),
      });
      await new Promise((resolve, reject) => {
        output.once('error', reject);
        output.once('close', resolve);
        output.once('data', () => output.destroy());
        output.resume();
      });
      await new Promise(setImmediate);
      await new Promise(setImmediate);
      expect(streams.size).toBeGreaterThan(2);
      expect([...streams].every((stream) => stream.destroyed)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
