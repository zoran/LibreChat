import { EventEmitter } from 'node:events';
import { rootCertificates } from 'node:tls';
import type { Readable } from 'node:stream';
import type { Socket } from 'node:net';
import type { RetentionMailConfig, RetentionMailInput } from './retentionMailSender';
import type { MailMessage, SMTPOptions, SubmissionInfo } from '../mail/submission';
import { createBoundedRetentionMailSender, getRetentionMailConfig } from './retentionMailSender';

const config: RetentionMailConfig = {
  purpose: 'retention',
  hosts: ['mail.example.test'],
  username: 'retention@example.test',
  password: 'test-retention-test-only',
  ca: rootCertificates[0],
  servername: 'mail.example.test',
  from: 'no-reply@example.test',
  appTitle: 'Portal',
  allowedDomains: ['example.test'],
  clientUrl: 'https://portal.example.test',
};
const input: RetentionMailInput = {
  recipient: 'person@example.test',
  submissionId: 'file-reminder:7:revision',
  authorizeHandoff: () => true,
  notice: {
    offsetDays: 7,
    asOf: '2026-10-21T12:00:00.000Z',
    timezone: 'Europe/Berlin',
    files: [
      {
        filename: 'Privater <Name>.pdf',
        acceptedAt: '2026-10-01T12:00:00.000Z',
        lastSuccessfulReadAt: null,
        lastReadKnown: true,
        readCount: { known: true, value: 0, coverage: 'complete' },
        processingCount: { known: true, value: 0, coverage: 'complete' },
        inactivity: {
          known: true,
          since: '2026-10-01T12:00:00.000Z',
          fullDays: 20,
          basis: 'upload',
        },
        deadlineAt: '2026-10-28T12:00:00.000Z',
      },
    ],
  },
};
function fixture(settings = config) {
  let options: SMTPOptions | undefined;
  let message: MailMessage | undefined;
  let callback: ((e: Error | null, i?: SubmissionInfo) => void) | undefined;
  const socket = Object.assign(new EventEmitter(), { connect: jest.fn(), destroy: jest.fn() });
  const sender = createBoundedRetentionMailSender(settings, {
    createMimeStream(value) {
      message = value;
      return Object.assign(new EventEmitter(), {
        destroy: jest.fn(),
        resume(this: EventEmitter) {
          this.emit('data', Buffer.from('mime'));
          this.emit('end');
          return this;
        },
      }) as unknown as Readable;
    },
    createSocket: () => socket as unknown as Socket,
    createTransport(value) {
      options = value;
      return {
        close: jest.fn(),
        sendMail(_raw, cb) {
          callback = cb;
          value.getSocket(value, (e) => {
            if (e) cb(e);
          });
        },
      };
    },
  });
  return {
    sender,
    socket,
    get options() {
      return options;
    },
    get message() {
      return message;
    },
    complete(e: Error | null, i?: SubmissionInfo) {
      callback!(e, i);
    },
  };
}
describe('dedicated retention purpose adapter', () => {
  it.each([7, 1] as const)(
    'renders the frozen German %i-day snapshot and fixed envelope',
    async (offsetDays) => {
      const f = fixture();
      const p = f.sender.sendReminder({ ...input, notice: { ...input.notice, offsetDays } });
      f.socket.emit('connect');
      f.complete(null, { accepted: [input.recipient], response: '250 queued' });
      await expect(p).resolves.toEqual({ state: 'accepted', relayIndex: 0 });
      expect(f.options?.auth).toEqual({ user: config.username, pass: config.password });
      expect(f.message?.envelope).toEqual({ from: config.from, to: [input.recipient] });
      expect(f.message?.text).toContain('Sicherheitsgründen');
      expect(f.message?.text).toContain(
        'Wenn du die Dateien nicht mehr benötigst, musst du nichts tun.',
      );
      expect(f.message?.text).toContain('20 Tagen');
      expect(f.message?.html).toContain('Privater &lt;Name&gt;.pdf');
      expect(f.message?.html).not.toContain('Privater <Name>');
      expect(f.message?.text).toContain('Lesezugriffe');
      expect(f.message?.text).toContain('Verarbeitungen');
      expect(f.message?.html).toContain('lang="de"');
    },
  );
  it('passes unknown SMTP outcomes through unchanged to the lifecycle owner', async () => {
    const f = fixture();
    const p = f.sender.sendReminder(input);
    f.socket.emit('connect');
    f.complete(new Error('private SMTP transcript'));
    await expect(p).resolves.toEqual({ state: 'unknown', reason: 'acknowledgementUnknown' });
  });
  it('requires current owner authorization in addition to the recipient domain', async () => {
    const f = fixture();
    await expect(
      f.sender.sendReminder({ ...input, authorizeHandoff: () => false }),
    ).resolves.toEqual({ state: 'notAccepted', reason: 'notAuthorized' });
    expect(f.options).toBeUndefined();
  });
  it.each([
    'other@outside.test',
    'a@example.test,b@example.test',
    'a@example.test\r\nBcc: b@example.test',
  ])('refuses an unapproved or nonsingle recipient %p before transport', async (recipient) => {
    const f = fixture();
    await expect(f.sender.sendReminder({ ...input, recipient })).resolves.toEqual({
      state: 'notAccepted',
      reason: 'invalid',
    });
    expect(f.options).toBeUndefined();
  });
  it('refuses malformed renderer snapshots without exposing private content', async () => {
    const f = fixture();
    await expect(
      f.sender.sendReminder({ ...input, notice: { ...input.notice, files: [] } }),
    ).resolves.toEqual({ state: 'notAccepted', reason: 'invalid' });
    expect(f.options).toBeUndefined();
  });
  it('takes branding and links only from trusted configuration', async () => {
    const f = fixture();
    const p = f.sender.sendReminder({
      ...input,
      notice: {
        ...input.notice,
        appTitle: 'Injected',
        clientUrl: 'https://attacker.test',
      } as RetentionMailInput['notice'],
    });
    f.socket.emit('connect');
    f.complete(null, { accepted: [input.recipient], response: '250 queued' });
    await p;
    expect(f.message?.text).not.toContain('Injected');
    expect(f.message?.html).not.toContain('attacker.test');
  });
  it('requires an explicit retention purpose and never falls back to login credentials', () => {
    expect(() =>
      fixture({ ...config, purpose: 'login' } as unknown as RetentionMailConfig),
    ).toThrow();
    const login = {
      EMAIL_CODE_ENABLED: 'true',
      EMAIL_CODE_SMTP_PASSWORD: 'login-private',
      RETENTION_MAIL_ENABLED: 'true',
    };
    expect(() => getRetentionMailConfig(login, ['example.test'])).toThrow(
      'Invalid retention SMTP configuration',
    );
    expect(
      getRetentionMailConfig({ ...login, RETENTION_MAIL_ENABLED: 'false' }, []),
    ).toBeUndefined();
  });
  it('snapshots dedicated environment settings and rejects partial activation', () => {
    const env = {
      RETENTION_MAIL_ENABLED: 'true',
      RETENTION_SMTP_HOSTS: JSON.stringify(config.hosts),
      RETENTION_SMTP_USERNAME: config.username,
      RETENTION_SMTP_PASSWORD: config.password,
      RETENTION_SMTP_CA: config.ca,
      RETENTION_SMTP_TLS_SERVERNAME: config.servername,
      RETENTION_SMTP_FROM: config.from,
      APP_TITLE: config.appTitle,
      DOMAIN_CLIENT: config.clientUrl,
    };
    expect(getRetentionMailConfig(env, config.allowedDomains)).toEqual({
      ...config,
      clientUrl: 'https://portal.example.test/',
    });
    expect(() =>
      getRetentionMailConfig({ ...env, RETENTION_SMTP_PASSWORD: undefined }, config.allowedDomains),
    ).toThrow();
  });
});
