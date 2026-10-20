import { EventEmitter } from 'node:events';
import { rootCertificates } from 'node:tls';
import type { Socket } from 'node:net';
import type {
  EmailCodeMailConfig,
  EmailCodeMailMessage,
  EmailCodeMailDependencies,
  EmailCodeSMTPOptions,
} from './mailSender';
import { createBoundedEmailCodeSender, getEmailCodeMailConfig } from './mailSender';

const config: EmailCodeMailConfig = {
  hosts: ['192.0.2.10', 'smtp-backup.example.test'],
  username: 'login@example.test',
  password: 'test-only',
  ca: rootCertificates[0],
  servername: 'mail.example.test',
  from: 'no-reply@example.test',
  appTitle: 'Example Portal',
  allowedDomains: ['example.test', 'team.example.test'],
};
const input = {
  email: 'person@example.test',
  code: '01234567',
  expiresInMinutes: 10,
  locale: 'de' as const,
};

function environment(
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    EMAIL_CODE_ENABLED: 'true',
    EMAIL_CODE_SMTP_HOSTS: JSON.stringify(config.hosts),
    EMAIL_CODE_SMTP_USERNAME: config.username,
    EMAIL_CODE_SMTP_FROM: config.from,
    EMAIL_CODE_SMTP_TLS_SERVERNAME: config.servername,
    EMAIL_CODE_SMTP_PASSWORD: config.password,
    EMAIL_CODE_SMTP_CA: config.ca,
    APP_TITLE: config.appTitle,
    ...extra,
  };
}

class TestSocket extends EventEmitter {
  destroyed = false;
  connect = jest.fn(() => this);
  destroy = jest.fn(() => {
    this.destroyed = true;
    return this;
  });
}

function fixture(settings: EmailCodeMailConfig = config) {
  const sockets: TestSocket[] = [];
  const options: EmailCodeSMTPOptions[] = [];
  const callbacks: Array<
    Parameters<ReturnType<EmailCodeMailDependencies['createTransport']>['sendMail']>[1]
  > = [];
  const messages: unknown[] = [];
  const sender = createBoundedEmailCodeSender(settings, {
    createSocket: () => {
      const socket = new TestSocket();
      sockets.push(socket);
      return socket as unknown as Socket;
    },
    createTransport: (settings) => {
      options.push(settings);
      return {
        close: jest.fn(),
        sendMail: (message, callback) => {
          callbacks.push(callback);
          messages.push(message);
          settings.getSocket(settings, (error) => {
            if (error) callback(error);
          });
        },
      };
    },
  });
  return { sender, sockets, options, callbacks, messages };
}

describe('bounded approved SMTP submission', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('shares the exact-mailbox policy and rejects new sends after its absolute expiry', async () => {
    const until = Math.floor(Date.now() / 1000) + 120;
    const email = 'qualification@outside.example.test';
    const settings = getEmailCodeMailConfig(
      environment({
        EMAIL_CODE_QUALIFICATION_MAILBOX: email,
        EMAIL_CODE_QUALIFICATION_NOT_AFTER: String(until),
      }),
      config.allowedDomains,
    )!;
    const f = fixture(settings);
    await expect(
      f.sender.sendCode({ ...input, email: 'neighbor@outside.example.test' }),
    ).rejects.toThrow();
    const pending = f.sender.sendCode({ ...input, email });
    f.sockets[0].emit('connect');
    f.callbacks[0](null, { accepted: [email], response: '250 queued' });
    await pending;
    jest.setSystemTime(until * 1000);
    await expect(f.sender.sendCode({ ...input, email })).rejects.toThrow();
    expect(f.options).toHaveLength(1);
  });

  it('destroys a pending qualification socket at expiry without replaying late acceptance', async () => {
    const until = Math.floor(Date.now() / 1000) * 1000 + 2000;
    const email = 'qualification@outside.example.test';
    const f = fixture({ ...config, qualification: { email, notAfter: until } });
    const pending = f.sender.sendCode({ ...input, email });
    const failure = pending.catch((error) => error);
    jest.advanceTimersByTime(2000);
    expect(await failure).toMatchObject({ code: 'EMAIL_CODE_UNAVAILABLE' });
    expect(f.sockets.every((socket) => socket.destroyed)).toBe(true);
    f.callbacks[0](null, { accepted: [email], response: '250 queued' });
    expect(f.options).toHaveLength(1);
  });

  it('copies a bounded PNG into an inline CID attachment with all external access disabled', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOBsAAAAASUVORK5CYII=',
      'base64',
    );
    const original = Buffer.from(png);
    const f = fixture({ ...config, clientUrl: 'https://portal.example.test', logoPng: png });
    png.fill(0);
    const pending = f.sender.sendCode({ ...input, attemptId: 'a'.repeat(43) });
    f.sockets[0].emit('connect');
    f.callbacks[0](null, { accepted: [input.email], response: '250 queued' });
    await pending;
    const message = f.messages[0] as EmailCodeMailMessage;
    expect(message.attachments).toEqual([
      {
        filename: 'application-logo.png',
        content: original,
        contentType: 'image/png',
        contentDisposition: 'inline',
        cid: 'application-logo@local',
      },
    ]);
    expect(message.html).toContain('src="cid:application-logo@local"');
    expect(message).toMatchObject({ disableFileAccess: true, disableUrlAccess: true });
    expect(f.options[0]).toMatchObject({ disableFileAccess: true, disableUrlAccess: true });
    for (const invalid of [
      Buffer.alloc(65537),
      Buffer.from('<svg/>'),
      'https://example.test/logo.png',
    ]) {
      expect(() => fixture({ ...config, logoPng: invalid as Buffer })).toThrow();
    }
  });

  it('keeps plain code separate from the full trusted HTTPS link with escaped HTML', async () => {
    const f = fixture({
      ...config,
      clientUrl: 'https://portal.example.test/chat/',
      appTitle: '<Portal & friends>',
    });
    const pending = f.sender.sendCode({ ...input, attemptId: 'a'.repeat(43) });
    f.sockets[0].emit('connect');
    f.callbacks[0](null, { accepted: [input.email], response: '250 queued' });
    await pending;
    const message = f.messages[0] as { html: string; text: string };
    const escapedLink = `https://portal.example.test/chat/login/email-code#attemptId=${'a'.repeat(43)}&amp;code=01234567`;
    expect(message.html).toContain('https://portal.example.test/chat/login/email-code#attemptId=');
    expect(message.html).toMatch(/<p\b[^>]*>01234567<\/p>/);
    expect(message.html).not.toContain('>01234567</a>');
    expect(message.html).toContain(`href="${escapedLink}">${escapedLink}</a>`);
    expect(message.html).toContain('&lt;Portal &amp; friends&gt;');
    expect(message.text).toContain('01234567');
    expect(message.text).toContain('https://portal.example.test/chat/login/email-code#attemptId=');
    expect(message.text).toContain('zehn Minuten');
    expect(message.html).toContain('lang="de"');
    expect(() => fixture({ ...config, clientUrl: 'http://untrusted.test' })).toThrow();
    expect(() => fixture({ ...config, clientUrl: 'https://portal.test/?redirect=evil' })).toThrow();
  });

  it('uses the second relay after definite first-socket refusal and accepts only once', async () => {
    const f = fixture();
    const pending = f.sender.sendCode(input);
    f.sockets[0].emit('error', new Error('connection refused'));
    expect(f.options).toHaveLength(2);
    f.sockets[1].emit('connect');
    f.callbacks[1](null, { accepted: [input.email], response: '250 queued' });
    await pending;
    expect(f.sockets.every((socket) => socket.destroyed)).toBe(true);
    expect(f.options.map((option) => option.host)).toEqual(config.hosts);
  });

  it('owns the socket and resolves only after positive DATA acknowledgement for the expected recipient', async () => {
    const f = fixture();
    const pending = f.sender.sendCode(input);
    f.sockets[0].emit('connect');
    expect(f.options[0]).toMatchObject({
      host: '192.0.2.10',
      port: 587,
      secure: false,
      requireTLS: true,
      forceAuth: true,
      pool: false,
      logger: false,
      debug: false,
      auth: { user: 'login@example.test', pass: 'test-only' },
      tls: { servername: 'mail.example.test', rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    });
    f.callbacks[0](null, { accepted: [input.email], rejected: [], response: '250 2.0.0 queued' });
    await expect(pending).resolves.toBeUndefined();
    expect(f.sockets[0].destroy).toHaveBeenCalled();
    expect(f.messages[0]).toMatchObject({
      from: { name: 'Example Portal', address: 'no-reply@example.test' },
      envelope: { from: 'no-reply@example.test', to: [input.email] },
      subject: 'Dein Anmeldecode für Example Portal',
      text: expect.stringContaining('01234567'),
    });
  });

  it('tries the second relay after TCP non-acceptance, without extending the overall deadline', async () => {
    const f = fixture();
    const pending = f.sender.sendCode(input);
    const rejected = pending.catch((error: unknown) => error);
    jest.advanceTimersByTime(5_000);
    expect(f.options.map((o) => o.host)).toEqual(['192.0.2.10', 'smtp-backup.example.test']);
    f.sockets[1].emit('connect');
    jest.advanceTimersByTime(15_000);
    expect(await rejected).toMatchObject({ code: 'EMAIL_CODE_UNAVAILABLE' });
    expect(f.sockets.every((s) => s.destroyed)).toBe(true);
    // A callback after cancellation cannot convert an unknown submission into a login code.
    f.callbacks[1](null, { accepted: [input.email], response: '250 accepted too late' });
    expect(f.options).toHaveLength(2);
  });

  it('does not replay a connection loss after socket handoff, even when its command is CONN', async () => {
    const f = fixture();
    const pending = f.sender.sendCode(input);
    f.sockets[0].emit('connect');
    f.callbacks[0](
      Object.assign(new Error('private SMTP transcript'), { code: 'ECONNECTION', command: 'CONN' }),
    );
    await expect(pending).rejects.toThrow('Email-code submission unavailable');
    expect(f.options).toHaveLength(1);
  });

  it('may fail over after an explicit DATA rejection and refuses recipient-only acceptance', async () => {
    const f = fixture();
    const pending = f.sender.sendCode(input);
    f.sockets[0].emit('connect');
    f.callbacks[0](Object.assign(new Error('rejected'), { responseCode: 451, command: 'DATA' }));
    f.sockets[1].emit('connect');
    f.callbacks[1](null, { accepted: [input.email], rejected: [] });
    await expect(pending).rejects.toMatchObject({ code: 'EMAIL_CODE_UNAVAILABLE' });
    expect(f.options).toHaveLength(2);
  });

  it('does not create transport for a forbidden recipient or invalid code', async () => {
    const f = fixture();
    await expect(f.sender.sendCode({ ...input, email: 'person@attacker.test' })).rejects.toThrow();
    await expect(f.sender.sendCode({ ...input, code: '1234' })).rejects.toThrow();
    expect(f.options).toHaveLength(0);
  });

  it('distinguishes disabled/absent settings from malformed explicitly enabled settings', () => {
    expect(getEmailCodeMailConfig({}, ['example.test'])).toBeUndefined();
    expect(
      getEmailCodeMailConfig({ EMAIL_CODE_ENABLED: 'true' }, ['example.test']),
    ).toBeUndefined();
    expect(() =>
      getEmailCodeMailConfig({ EMAIL_CODE_ENABLED: 'true', EMAIL_CODE_SMTP_PASSWORD: 'test' }, [
        'example.test',
      ]),
    ).toThrow('Invalid email-code SMTP configuration');
    expect(() =>
      getEmailCodeMailConfig(
        {
          EMAIL_CODE_ENABLED: 'true',
          EMAIL_CODE_SMTP_PASSWORD: 'test',
          EMAIL_CODE_SMTP_CA: '-----BEGIN CERTIFICATE-----\nmalformed\n-----END CERTIFICATE-----',
        },
        ['example.test'],
      ),
    ).toThrow('Invalid email-code SMTP configuration');
  });

  it('accepts explicit synthetic deployment identities and one or two configured relays', () => {
    const domains = ['example.test'];
    const parsed = getEmailCodeMailConfig(environment(), domains);
    expect(parsed).toEqual({ ...config, allowedDomains: domains });
    expect(
      getEmailCodeMailConfig(
        environment({ EMAIL_CODE_SMTP_HOSTS: '["smtp.example.test"]', APP_TITLE: undefined }),
        domains,
      ),
    ).toMatchObject({ hosts: ['smtp.example.test'], appTitle: 'LibreChat' });
    expect(
      getEmailCodeMailConfig(environment({ EMAIL_CODE_SMTP_HOSTS: '["2001:db8::1"]' }), domains),
    ).toMatchObject({ hosts: ['2001:db8::1'] });
  });

  it('normalizes optional public help without inventing a default contact', () => {
    const supportText = 'Bei Fragen hilft dir das Portal-Team weiter.';
    expect(
      getEmailCodeMailConfig(
        environment({ EMAIL_CODE_SUPPORT_TEXT: `  ${supportText}  ` }),
        config.allowedDomains,
      ),
    ).toMatchObject({ supportText });
    for (const value of [undefined, '', '   ']) {
      expect(
        getEmailCodeMailConfig(
          environment({ EMAIL_CODE_SUPPORT_TEXT: value }),
          config.allowedDomains,
        ),
      ).not.toHaveProperty('supportText');
    }
    expect(
      getEmailCodeMailConfig(
        environment({ EMAIL_CODE_SUPPORT_TEXT: 'x'.repeat(240) }),
        config.allowedDomains,
      ),
    ).toMatchObject({ supportText: 'x'.repeat(240) });
  });

  it.each([
    'x'.repeat(241),
    'Help\nMore',
    'Help\rMore',
    'Help\tMore',
    'Help\u0000',
    'Help\u007f',
    'Help\u0085More',
    'Help\u2028More',
    'Help\u2029More',
  ])('rejects oversized or non-paragraph help before opening transport: %p', (supportText) => {
    expect(() =>
      getEmailCodeMailConfig(
        environment({ EMAIL_CODE_SUPPORT_TEXT: supportText }),
        config.allowedDomains,
      ),
    ).toThrow('Invalid email-code SMTP configuration');
    const createTransport = jest.fn();
    expect(() =>
      createBoundedEmailCodeSender({ ...config, supportText }, { createTransport }),
    ).toThrow('Invalid email-code SMTP configuration');
    expect(createTransport).not.toHaveBeenCalled();
  });

  it.each([null, 123, ['Help'], { text: 'Help' }])(
    'rejects non-text public help: %p',
    (supportText) => {
      expect(() => fixture({ ...config, supportText } as unknown as EmailCodeMailConfig)).toThrow(
        'Invalid email-code SMTP configuration',
      );
    },
  );

  it('passes the snapshotted deployment help through to both mail alternatives', async () => {
    const supportText = 'Bei Fragen hilft dir das Portal-Team weiter.';
    const settings = getEmailCodeMailConfig(
      environment({
        EMAIL_CODE_SUPPORT_TEXT: ` ${supportText} `,
        DOMAIN_CLIENT: 'https://portal.example.test',
      }),
      config.allowedDomains,
    )!;
    const mutable = { ...settings };
    const f = fixture(mutable);
    mutable.supportText = 'Changed after construction';
    const pending = f.sender.sendCode({ ...input, attemptId: 'a'.repeat(43) });
    f.sockets[0].emit('connect');
    f.callbacks[0](null, { accepted: [input.email], response: '250 queued' });
    await pending;
    const message = f.messages[0] as EmailCodeMailMessage;
    expect(message.text.split(supportText)).toHaveLength(2);
    expect(message.html!.split(supportText)).toHaveLength(2);
    expect(message.text).not.toContain(mutable.supportText);
    expect(message.html).not.toContain(mutable.supportText);
  });

  it('rejects malformed endpoints and partial explicit SMTP configuration', () => {
    for (const hosts of [
      'smtp.example.test',
      [],
      ['a.example.test', 'b.example.test', 'c.example.test'],
      ['same.example.test', 'SAME.example.test'],
      [' smtp.example.test'],
      ['smtp.example.test\n'],
      ['smtp://mail.example.test'],
      ['person@mail.example.test'],
      ['mail.example.test:587'],
      ['mail.example.test/path'],
      ['bad..example.test'],
      ['999.999.999.999'],
      [null],
    ]) {
      expect(() =>
        getEmailCodeMailConfig(
          environment({ EMAIL_CODE_SMTP_HOSTS: JSON.stringify(hosts) }),
          config.allowedDomains,
        ),
      ).toThrow('Invalid email-code SMTP configuration');
    }
    for (const field of [
      'EMAIL_CODE_SMTP_HOSTS',
      'EMAIL_CODE_SMTP_USERNAME',
      'EMAIL_CODE_SMTP_FROM',
      'EMAIL_CODE_SMTP_TLS_SERVERNAME',
      'EMAIL_CODE_SMTP_PASSWORD',
      'EMAIL_CODE_SMTP_CA',
    ]) {
      expect(() =>
        getEmailCodeMailConfig(environment({ [field]: undefined }), config.allowedDomains),
      ).toThrow('Invalid email-code SMTP configuration');
    }
    for (const extra of [
      { EMAIL_CODE_SMTP_USERNAME: 'login\r\nother' },
      { EMAIL_CODE_SMTP_FROM: 'Display <no-reply@example.test>' },
      { EMAIL_CODE_SMTP_TLS_SERVERNAME: 'mail.example.test:587' },
      { APP_TITLE: 'Portal\nInjected' },
      { APP_TITLE: 'x'.repeat(121) },
      { EMAIL_CODE_SMTP_CA: '-----BEGIN CERTIFICATE-----\nbad\n-----END CERTIFICATE-----' },
    ]) {
      expect(() => getEmailCodeMailConfig(environment(extra), config.allowedDomains)).toThrow(
        'Invalid email-code SMTP configuration',
      );
    }
    expect(
      getEmailCodeMailConfig(
        environment({ EMAIL_CODE_ENABLED: 'false', EMAIL_CODE_SMTP_HOSTS: 'bad' }),
        config.allowedDomains,
      ),
    ).toBeUndefined();
    expect(
      getEmailCodeMailConfig(
        { EMAIL_CODE_ENABLED: 'true', APP_TITLE: 'Any Portal' },
        config.allowedDomains,
      ),
    ).toBeUndefined();
  });

  it('snapshots the configured identities, hosts and recipient domains before opening sockets', async () => {
    const mutable = {
      ...config,
      hosts: [...config.hosts],
      allowedDomains: [...config.allowedDomains],
    };
    const f = fixture(mutable);
    mutable.hosts[0] = 'changed.example.test';
    mutable.allowedDomains[0] = 'attacker.test';
    mutable.from = 'changed@example.test';
    mutable.username = 'changed@example.test';
    mutable.servername = 'changed.example.test';
    mutable.appTitle = 'Changed';
    const pending = f.sender.sendCode(input).then(
      () => ({ accepted: true }),
      () => ({ accepted: false }),
    );
    f.sockets[0]?.emit('connect');
    f.callbacks[0]?.(null, { accepted: [input.email], rejected: [], response: '250 queued' });
    await expect(pending).resolves.toEqual({ accepted: true });
    expect(f.sockets[0].connect).toHaveBeenCalledWith(587, '192.0.2.10');
    expect(f.options[0]).toMatchObject({
      host: '192.0.2.10',
      auth: { user: 'login@example.test' },
      tls: { servername: 'mail.example.test', rejectUnauthorized: true },
    });
    expect(f.messages[0]).toMatchObject({
      from: { name: 'Example Portal', address: 'no-reply@example.test' },
    });
  });

  it('uses the configured title in English and does not invent a second relay', async () => {
    const f = fixture({ ...config, hosts: ['smtp.example.test'], appTitle: 'Another Portal' });
    const pending = f.sender.sendCode({ ...input, locale: 'en' });
    const rejected = pending.catch((error: unknown) => error);
    jest.advanceTimersByTime(20_000);
    expect(await rejected).toMatchObject({ code: 'EMAIL_CODE_UNAVAILABLE' });
    expect(f.options).toHaveLength(1);
    expect(f.options[0].host).toBe('smtp.example.test');
    expect(f.messages[0]).toMatchObject({
      from: { name: 'Another Portal', address: config.from },
      subject: 'Your Another Portal sign-in code',
    });
    expect(f.sockets.every((socket) => socket.destroyed)).toBe(true);
  });

  it('validates an explicitly composed config before creating any transport', () => {
    const createTransport = jest.fn();
    expect(() =>
      createBoundedEmailCodeSender(
        { ...config, hosts: ['smtp://mail.example.test'] },
        { createTransport },
      ),
    ).toThrow('Invalid email-code SMTP configuration');
    expect(createTransport).not.toHaveBeenCalled();
  });
});
