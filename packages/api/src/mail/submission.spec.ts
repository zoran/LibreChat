import { EventEmitter } from 'node:events';
import { rootCertificates } from 'node:tls';
import type { Readable } from 'node:stream';
import type { Socket } from 'node:net';
import type { MailConfig, MailDependencies, MailMessage, SMTPOptions } from './submission';
import { createBoundedMailSubmission, MAX_MIME_BYTES } from './submission';

const config: MailConfig = {
  hosts: ['192.0.2.10', 'backup.example.test'],
  username: 'fixture@example.test',
  password: 'test-only',
  ca: rootCertificates[0],
  servername: 'mail.example.test',
  from: 'no-reply@example.test',
  appTitle: 'Portal',
  allowedDomains: ['example.test'],
};
const input = {
  recipient: 'person@example.test',
  submissionId: 'job:fixed',
  content: { subject: 'Notice', text: 'Text', html: '<p>Text</p>' },
  authorizeHandoff: () => true,
};
class TestSocket extends EventEmitter {
  connect = jest.fn(() => this);
  destroy = jest.fn(() => this);
}
function fixture(bytes = Buffer.from('Subject: Notice\r\n\r\nText\r\n'), manual = false) {
  const sockets: TestSocket[] = [];
  const options: SMTPOptions[] = [];
  const callbacks: Parameters<ReturnType<MailDependencies['createTransport']>['sendMail']>[1][] =
    [];
  const sent: Parameters<ReturnType<MailDependencies['createTransport']>['sendMail']>[0][] = [];
  const composed: MailMessage[] = [];
  const closed: jest.Mock[] = [];
  const stream = Object.assign(new EventEmitter(), {
    destroy: jest.fn(),
    resume(this: EventEmitter) {
      if (!manual) {
        this.emit('data', bytes);
        this.emit('end');
      }
      return this;
    },
  });
  const deps: MailDependencies = {
    createMimeStream(message) {
      composed.push(message);
      return stream as unknown as Readable;
    },
    createSocket() {
      const s = new TestSocket();
      sockets.push(s);
      return s as unknown as Socket;
    },
    createTransport(o) {
      options.push(o);
      const close = jest.fn();
      closed.push(close);
      return {
        close,
        sendMail(message, cb) {
          sent.push(message);
          callbacks.push(cb);
          o.getSocket(o, (e) => {
            if (e) cb(e);
          });
        },
      };
    },
  };
  const sender = createBoundedMailSubmission(config, deps);
  return { sender, deps, stream, sockets, options, callbacks, sent, composed, closed };
}
describe('one bounded SMTP submission', () => {
  it.each([
    'Sender\r\nBcc: injected@example.test',
    'Sender\nInjected',
    'Sender\u2028Injected',
    'Sender\u0000Injected',
    '   ',
    'x'.repeat(121),
  ])('rejects unsafe visible sender names before MIME or transport: %j', (fromName) => {
    const f = fixture();
    expect(() => createBoundedMailSubmission({ ...config, fromName }, f.deps)).toThrow(
      'Invalid SMTP configuration',
    );
    expect(f.options).toHaveLength(0);
    expect(f.composed).toHaveLength(0);
  });

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  it('submits the exact admitted bytes with strict TLS and one recipient after authorization', async () => {
    const raw = Buffer.from('Subject: Notice\r\n\r\nText\r\n');
    const f = fixture(raw);
    const authorize = jest.fn(() => true);
    const pending = f.sender.submit({ ...input, authorizeHandoff: authorize });
    expect(authorize).toHaveBeenCalledTimes(1);
    f.sockets[0].emit('connect');
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(f.options[0]).toMatchObject({
      port: 587,
      secure: false,
      requireTLS: true,
      forceAuth: true,
      pool: false,
      logger: false,
      debug: false,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 20000,
      tls: {
        ca: config.ca,
        servername: config.servername,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
      },
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    expect(f.sent[0]).toEqual({
      raw,
      envelope: { from: config.from, to: [input.recipient] },
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    expect(f.composed[0].from).toEqual({ name: config.appTitle, address: config.from });
    expect(f.composed[0].messageId).toMatch(/^<[0-9a-f]{64}@submission\.local>$/);
    f.callbacks[0](null, {
      accepted: [input.recipient],
      rejected: [],
      response: '250 2.0.0 queued',
    });
    await expect(pending).resolves.toEqual({ state: 'accepted', relayIndex: 0 });
    expect(f.sockets[0].destroy).toHaveBeenCalled();
    expect(f.closed[0]).toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
  it.each([262144, 262145])('enforces exact encoded size %i before sockets', async (size) => {
    const f = fixture(Buffer.alloc(size));
    const pending = f.sender.submit(input);
    if (size === MAX_MIME_BYTES) {
      f.sockets[0].emit('connect');
      f.callbacks[0](null, { accepted: [input.recipient], response: '250 ok' });
      await expect(pending).resolves.toEqual({ state: 'accepted', relayIndex: 0 });
      expect(f.sent[0].raw.length).toBe(size);
    } else {
      await expect(pending).resolves.toEqual({ state: 'notAccepted', reason: 'tooLarge' });
      expect(f.sockets).toHaveLength(0);
      expect(f.stream.destroy).toHaveBeenCalled();
    }
  });
  it('counts chunks and stops at the first byte over the limit', async () => {
    const f = fixture(Buffer.alloc(0), true);
    const p = f.sender.submit(input);
    f.stream.emit('data', Buffer.alloc(MAX_MIME_BYTES));
    expect(f.sockets).toHaveLength(0);
    f.stream.emit('data', Buffer.alloc(1));
    f.stream.emit('end');
    await expect(p).resolves.toEqual({ state: 'notAccepted', reason: 'tooLarge' });
    expect(f.options).toHaveLength(0);
  });
  it('includes MIME preparation and both relay attempts in one absolute deadline', async () => {
    const f = fixture(Buffer.alloc(0), true);
    const p = f.sender.submit(input);
    jest.advanceTimersByTime(13000);
    f.stream.emit('data', Buffer.from('mime'));
    f.stream.emit('end');
    expect(f.options[0].socketTimeout).toBe(7000);
    jest.advanceTimersByTime(5000);
    expect(f.options[1].connectionTimeout).toBe(2000);
    f.sockets[1].emit('connect');
    jest.advanceTimersByTime(2000);
    await expect(p).resolves.toEqual({ state: 'unknown', reason: 'acknowledgementUnknown' });
    expect(f.sockets.every((s) => s.destroy.mock.calls.length > 0)).toBe(true);
    f.callbacks[1](null, { accepted: [input.recipient], response: '250 late' });
    expect(f.options).toHaveLength(2);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('cancels a stalled MIME stream without creating transport', async () => {
    const f = fixture(Buffer.alloc(0), true);
    const p = f.sender.submit(input);
    jest.advanceTimersByTime(20000);
    await expect(p).resolves.toEqual({ state: 'notAccepted', reason: 'unavailable' });
    expect(f.stream.destroy).toHaveBeenCalled();
    expect(f.options).toHaveLength(0);
  });
  it('bounds a stalled final authorization and propagates cancellation to that owner', async () => {
    const f = fixture();
    let signal: AbortSignal | undefined;
    const p = f.sender.submit({
      ...input,
      authorizeHandoff: (s) => {
        signal = s;
        return new Promise<boolean>(() => undefined);
      },
    });
    jest.advanceTimersByTime(20000);
    await expect(p).resolves.toEqual({ state: 'notAccepted', reason: 'unavailable' });
    expect(signal?.aborted).toBe(true);
    expect(f.options).toHaveLength(0);
  });
  it.each([false, 'throw'])(
    'does not open a socket for denied/failed authorization %p',
    async (mode) => {
      const f = fixture();
      await expect(
        f.sender.submit({
          ...input,
          authorizeHandoff: () => {
            if (mode === 'throw') throw new Error('private');
            return false;
          },
        }),
      ).resolves.toEqual({ state: 'notAccepted', reason: 'notAuthorized' });
      expect(f.options).toHaveLength(0);
    },
  );
  it('revalidates after TCP connect and on peer failover without handing off stale work', async () => {
    const f = fixture();
    let allowed = true;
    const p = f.sender.submit({ ...input, authorizeHandoff: () => allowed });
    allowed = false;
    f.sockets[0].emit('connect');
    await expect(p).resolves.toEqual({ state: 'notAccepted', reason: 'notAuthorized' });
    expect(f.options).toHaveLength(1);
    expect(f.sockets[0].destroy).toHaveBeenCalled();
  });
  it('fails over only after proven nonacceptance', async () => {
    const f = fixture();
    const p = f.sender.submit(input);
    f.sockets[0].emit('error', new Error('refused'));
    expect(f.options).toHaveLength(2);
    f.sockets[1].emit('connect');
    f.callbacks[1](null, { accepted: [input.recipient], response: '250 queued' });
    await expect(p).resolves.toEqual({ state: 'accepted', relayIndex: 1 });
  });
  it.each(['EHLO', 'STARTTLS', 'AUTH PLAIN', 'MAIL FROM', 'RCPT TO', 'DATA'])(
    'permits a peer after explicit %s rejection',
    async (command) => {
      const f = fixture();
      const p = f.sender.submit(input);
      f.sockets[0].emit('connect');
      f.callbacks[0](Object.assign(new Error('private'), { responseCode: 451, command }));
      expect(f.options).toHaveLength(2);
      f.sockets[1].emit('connect');
      f.callbacks[1](Object.assign(new Error('private'), { responseCode: 550, command: 'DATA' }));
      await expect(p).resolves.toEqual({ state: 'notAccepted', reason: 'unavailable' });
    },
  );
  it.each([
    { error: Object.assign(new Error('private'), { code: 'ECONNECTION', command: 'CONN' }) },
    { error: Object.assign(new Error('private'), { responseCode: 450, command: 'CONN' }) },
    { info: { accepted: [input.recipient] } },
    { info: { accepted: ['other@example.test'], response: '250 queued' } },
    { info: { accepted: [input.recipient], rejected: [input.recipient], response: '250 queued' } },
    { info: { accepted: [input.recipient], response: 'invalid 250' } },
  ])('preserves an unknown post-handoff outcome without replay: %#', async ({ error, info }) => {
    const f = fixture();
    const p = f.sender.submit(input);
    f.sockets[0].emit('connect');
    f.callbacks[0](error ?? null, info);
    await expect(p).resolves.toEqual({ state: 'unknown', reason: 'acknowledgementUnknown' });
    expect(f.options).toHaveLength(1);
  });
  it.each([false, true])(
    'classifies cancellation using actual socket handoff: %p',
    async (handedOff) => {
      const f = fixture();
      const abort = new AbortController();
      const p = f.sender.submit({ ...input, signal: abort.signal });
      if (handedOff) f.sockets[0].emit('connect');
      abort.abort();
      await expect(p).resolves.toEqual(
        handedOff
          ? { state: 'unknown', reason: 'acknowledgementUnknown' }
          : { state: 'notAccepted', reason: 'unavailable' },
      );
      expect(f.sockets[0].destroy).toHaveBeenCalled();
      expect(f.options).toHaveLength(1);
    },
  );
  it('treats composition failure as local nonacceptance and never retries it', async () => {
    const f = fixture();
    f.deps.createMimeStream = () => {
      throw new Error('private');
    };
    await expect(f.sender.submit(input)).resolves.toEqual({
      state: 'notAccepted',
      reason: 'unavailable',
    });
    expect(f.options).toHaveLength(0);
  });
  it('snapshots submission fields before asynchronous MIME preparation', async () => {
    const f = fixture(Buffer.alloc(0), true);
    const mutable = { ...input, content: { ...input.content } };
    const p = f.sender.submit(mutable);
    mutable.recipient = 'other@example.test';
    mutable.content.subject = 'changed';
    f.stream.emit('data', Buffer.from('mime'));
    f.stream.emit('end');
    f.sockets[0].emit('connect');
    f.callbacks[0](null, { accepted: [input.recipient], response: '250 queued' });
    await expect(p).resolves.toEqual({ state: 'accepted', relayIndex: 0 });
    expect(f.sent[0].envelope.to).toEqual([input.recipient]);
    expect(f.composed[0].subject).toBe('Notice');
  });
  it('owns socket errors while asynchronous final authorization is pending', async () => {
    const f = fixture();
    const abort = new AbortController();
    let calls = 0;
    let release: ((value: boolean) => void) | undefined;
    const p = f.sender.submit({
      ...input,
      signal: abort.signal,
      authorizeHandoff: () => {
        if (++calls === 2)
          return new Promise<boolean>((resolve) => {
            release = resolve;
          });
        return true;
      },
    });
    try {
      f.sockets[0].emit('connect');
      expect(() => f.sockets[0].emit('error', new Error('refused before handoff'))).not.toThrow();
      expect(f.options).toHaveLength(2);
      f.sockets[1].emit('connect');
      f.callbacks[1](null, { accepted: [input.recipient], response: '250 queued' });
      await expect(p).resolves.toEqual({ state: 'accepted', relayIndex: 1 });
      release!(false);
      await Promise.resolve();
      expect(f.options).toHaveLength(2);
    } finally {
      abort.abort();
    }
  });
  it('does not turn a late MIME error into proven nonacceptance after handoff', async () => {
    const f = fixture();
    const p = f.sender.submit(input);
    f.sockets[0].emit('connect');
    f.stream.emit('error', new Error('private'));
    await expect(p).resolves.toEqual({ state: 'unknown', reason: 'acknowledgementUnknown' });
  });
  it('requires well-formed final evidence after an actual socket handoff', async () => {
    const f = fixture();
    const p = f.sender.submit(input);
    f.callbacks[0](null, { accepted: [input.recipient], response: '250 queued' });
    await expect(p).resolves.toEqual({ state: 'notAccepted', reason: 'unavailable' });
    const g = fixture();
    const other = g.sender.submit(input);
    g.sockets[0].emit('connect');
    g.callbacks[0](null, {
      accepted: { 0: input.recipient, length: 1 } as unknown as unknown[],
      response: '250 queued',
    });
    await expect(other).resolves.toEqual({ state: 'unknown', reason: 'acknowledgementUnknown' });
  });
});
