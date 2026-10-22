/** Shared bounded SMTP submission; purpose policy and lifecycle state belong to adapters. */
import { URL } from 'node:url';
import { Socket, isIP } from 'node:net';
import { X509Certificate, createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

const DEADLINE_MS = 20_000;
const CONNECT_MS = 5_000;
export const MAX_MIME_BYTES = 262_144;

/** Safe relay evidence, never delivery-to-inbox or an exactly-once promise. */
export type SubmissionOutcome =
  | { state: 'accepted'; relayIndex: number }
  | { state: 'notAccepted'; reason: 'invalid' | 'tooLarge' | 'notAuthorized' | 'unavailable' }
  | { state: 'unknown'; reason: 'acknowledgementUnknown' };

export interface MailConfig {
  hosts: readonly string[];
  username: string;
  password: string;
  ca: string;
  servername: string;
  from: string;
  appTitle: string;
  allowedDomains: readonly string[];
  supportText?: string;
  logoPng?: Buffer;
}
export interface SMTPOptions {
  host: string;
  port: 587;
  secure: false;
  requireTLS: true;
  forceAuth: true;
  pool: false;
  logger: false;
  debug: false;
  auth: { user: string; pass: string };
  tls: { ca: string; servername: string; rejectUnauthorized: true; minVersion: 'TLSv1.2' };
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
  disableFileAccess: true;
  disableUrlAccess: true;
  getSocket(
    options: unknown,
    callback: (error: Error | null, value?: { connection: Socket }) => void,
  ): void;
}
export interface SubmissionInfo {
  accepted?: unknown[];
  rejected?: unknown[];
  response?: string;
}
export interface MailMessage {
  from: { name: string; address: string };
  to: { address: string };
  envelope: { from: string; to: string[] };
  messageId: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: Array<{
    filename: 'application-logo.png';
    content: Buffer;
    contentType: 'image/png';
    contentDisposition: 'inline';
    cid: 'application-logo@local';
  }>;
  disableFileAccess: true;
  disableUrlAccess: true;
}
export interface RawMailMessage {
  raw: Buffer;
  envelope: { from: string; to: string[] };
  disableFileAccess: true;
  disableUrlAccess: true;
}
export interface MailTransport {
  sendMail(
    message: RawMailMessage,
    callback: (error: Error | null, info?: SubmissionInfo) => void,
  ): void;
  close(): void;
}
export interface MailDependencies {
  /** Encode once using the same installed Nodemailer; stream destruction must cancel local work. */
  createMimeStream(message: MailMessage): Readable;
  createTransport(options: SMTPOptions): MailTransport;
  /** The actual socket is owned because transport.close() does not abort an active send. */
  createSocket?: () => Socket;
}
export interface MailSubmissionInput {
  recipient: string;
  submissionId: string;
  content: { subject: string; text: string; html?: string };
  embeddedLogo?: boolean;
  authorizeHandoff: (signal: AbortSignal) => boolean | Promise<boolean>;
  signal?: AbortSignal;
  /** Optional earlier authority cutoff; never extends the fixed submission budget. */
  authorizationExpiresAt?: number;
}
function invalidMailConfig(): never {
  throw new Error('Invalid SMTP configuration');
}

/** Single ASCII mailbox only; no lists, display names, quoted addresses or injected headers. */
export function singleMailbox(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 254 &&
    /^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(
      value,
    ) &&
    value.slice(0, value.indexOf('@')).length <= 64 &&
    value
      .slice(value.indexOf('@') + 1)
      .split('.')
      .every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))
  );
}

/** Configuration endpoints are host names only; transport policy fixes the port and TLS mode. */
function dnsName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 253 ||
    // eslint-disable-next-line no-control-regex -- SMTP host validation intentionally rejects control characters.
    /[\s\x00-\x1f\x7f]/.test(value)
  )
    return invalidMailConfig();
  const name = value.toLowerCase().replace(/\.$/, '');
  if (
    /^[0-9.]+$/.test(name) ||
    !name.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return invalidMailConfig();
  return name;
}

function endpoint(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 253 ||
    // eslint-disable-next-line no-control-regex -- SMTP endpoint validation intentionally rejects control characters.
    /[\s\x00-\x1f\x7f%]/.test(value)
  )
    return invalidMailConfig();
  const version = isIP(value);
  if (version === 4) return value;
  if (version === 6) return new URL(`http://[${value}]/`).hostname.slice(1, -1);
  return dnsName(value);
}

/** Validate and copy once; mutation of a caller's config can never redirect a later attempt. */
export function snapshotMailConfig(value: unknown): MailConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidMailConfig();
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.hosts) || input.hosts.length < 1 || input.hosts.length > 2)
    return invalidMailConfig();
  const hosts = input.hosts.map(endpoint);
  if (new Set(hosts).size !== hosts.length) return invalidMailConfig();
  const username = input.username;
  const password = input.password;
  const ca = input.ca;
  const from = input.from;
  const title = input.appTitle;
  if (
    typeof username !== 'string' ||
    username.length < 1 ||
    username.length > 254 ||
    // eslint-disable-next-line no-control-regex -- SMTP identities must not contain control characters.
    /[\s\x00-\x1f\x7f-\x9f]/.test(username) ||
    typeof password !== 'string' ||
    !password ||
    password.length > 4096 ||
    typeof ca !== 'string' ||
    !ca ||
    ca.length > 65_536 ||
    !ca.includes('-----BEGIN CERTIFICATE-----') ||
    !ca.includes('-----END CERTIFICATE-----') ||
    typeof from !== 'string' ||
    from.length > 254 ||
    typeof title !== 'string' ||
    title.length > 120 ||
    !title.trim() ||
    // eslint-disable-next-line no-control-regex -- Reject control characters and line separators in the mail subject title.
    /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(title)
  )
    return invalidMailConfig();
  const mailbox = from.split('@');
  if (
    mailbox.length !== 2 ||
    mailbox[0].length > 64 ||
    !mailbox[0].split('.').every((part) => /^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+$/.test(part)) ||
    mailbox[1].endsWith('.')
  )
    return invalidMailConfig();
  dnsName(mailbox[1]);
  const servername = dnsName(input.servername);
  if (!Array.isArray(input.allowedDomains) || input.allowedDomains.length === 0)
    return invalidMailConfig();
  const allowedDomains = input.allowedDomains.map(dnsName);
  let supportText: string | undefined;
  if (input.supportText !== undefined) {
    if (
      typeof input.supportText !== 'string' ||
      // eslint-disable-next-line no-control-regex -- Public mail help must remain one paragraph without control characters.
      /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(input.supportText)
    )
      return invalidMailConfig();
    supportText = input.supportText.trim() || undefined;
    if (supportText && supportText.length > 240) return invalidMailConfig();
  }
  const logo = input.logoPng;
  if (
    logo !== undefined &&
    (!Buffer.isBuffer(logo) ||
      logo.length < 33 ||
      logo.length > 65536 ||
      !logo.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      logo.readUInt32BE(8) !== 13 ||
      logo.toString('ascii', 12, 16) !== 'IHDR' ||
      logo.readUInt32BE(16) < 1 ||
      logo.readUInt32BE(16) > 1200 ||
      logo.readUInt32BE(20) < 1 ||
      logo.readUInt32BE(20) > 600)
  )
    return invalidMailConfig();
  try {
    if (!new X509Certificate(ca).ca) return invalidMailConfig();
  } catch {
    return invalidMailConfig();
  }
  return Object.freeze({
    hosts: Object.freeze(hosts),
    username,
    password,
    ca,
    servername,
    from,
    appTitle: title.trim(),
    allowedDomains: Object.freeze(allowedDomains),
    ...(supportText === undefined ? {} : { supportText }),
    ...(logo === undefined ? {} : { logoPng: Buffer.from(logo as Buffer) }),
  });
}

/** An explicit SMTP rejection proves nonacceptance; generic CONN errors do not. */
function explicitRejection(error: unknown): boolean {
  const e = error as { responseCode?: unknown; command?: unknown } | null;
  return (
    typeof e?.responseCode === 'number' &&
    e.responseCode >= 400 &&
    e.responseCode < 600 &&
    typeof e.command === 'string' &&
    /^(EHLO|HELO|STARTTLS|AUTH(?: [A-Z0-9-]+)?|MAIL FROM|RCPT TO|DATA)$/.test(e.command)
  );
}

/** One total budget, one encoded message, and no replay after uncertain acceptance. */
export function createBoundedMailSubmission(inputConfig: MailConfig, deps: MailDependencies) {
  const config = snapshotMailConfig(inputConfig);
  return {
    submit(input: MailSubmissionInput): Promise<SubmissionOutcome> {
      const started = Date.now();
      const { recipient, submissionId, authorizeHandoff, signal, authorizationExpiresAt } = input;
      const { subject, text, html } = input.content ?? {};
      if (
        !singleMailbox(recipient) ||
        typeof submissionId !== 'string' ||
        !submissionId ||
        submissionId.length > 256 ||
        typeof subject !== 'string' ||
        !subject ||
        // eslint-disable-next-line no-control-regex -- Subject is a single header, never caller-supplied raw MIME.
        /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(subject) ||
        typeof text !== 'string' ||
        (html !== undefined && typeof html !== 'string') ||
        typeof authorizeHandoff !== 'function' ||
        (authorizationExpiresAt !== undefined && !Number.isFinite(authorizationExpiresAt))
      )
        return Promise.resolve({ state: 'notAccepted', reason: 'invalid' });
      const ends = Math.min(started + DEADLINE_MS, authorizationExpiresAt ?? Infinity);
      if (ends <= started)
        return Promise.resolve({ state: 'notAccepted', reason: 'notAuthorized' });
      if (signal?.aborted) return Promise.resolve({ state: 'notAccepted', reason: 'unavailable' });
      const message: MailMessage = {
        from: { name: config.appTitle, address: config.from },
        to: { address: recipient },
        envelope: { from: config.from, to: [recipient] },
        messageId: `<${createHash('sha256').update(submissionId).digest('hex')}@submission.local>`,
        subject,
        text,
        ...(html === undefined ? {} : { html }),
        ...(config.logoPng && input.embeddedLogo
          ? {
              attachments: [
                {
                  filename: 'application-logo.png',
                  content: Buffer.from(config.logoPng),
                  contentType: 'image/png',
                  contentDisposition: 'inline',
                  cid: 'application-logo@local',
                },
              ],
            }
          : {}),
        disableFileAccess: true,
        disableUrlAccess: true,
      };
      return new Promise<SubmissionOutcome>((resolve) => {
        const sockets = new Set<Socket>();
        const transports = new Set<MailTransport>();
        const connectTimers = new Set<ReturnType<typeof setTimeout>>();
        const authorization = new AbortController();
        let stream: Readable | undefined;
        let finished = false;
        let acceptancePossible = false;
        let raw: Buffer;
        const unresolved = (): SubmissionOutcome =>
          acceptancePossible
            ? { state: 'unknown', reason: 'acknowledgementUnknown' }
            : { state: 'notAccepted', reason: 'unavailable' };
        const finish = (outcome: SubmissionOutcome) => {
          if (finished) return;
          finished = true;
          clearTimeout(deadline);
          for (const timer of connectTimers) clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
          authorization.abort();
          stream?.destroy();
          for (const socket of sockets) socket.destroy();
          for (const transport of transports) {
            try {
              transport.close();
            } catch {
              /* Owned sockets are already destroyed. */
            }
          }
          resolve(outcome);
        };
        const cancel = () => finish(unresolved());
        const deadline = setTimeout(cancel, ends - started);
        deadline.unref?.();
        signal?.addEventListener('abort', cancel, { once: true });
        const authorize = (next: () => void, current: () => boolean = () => true) => {
          if (finished || !current()) return;
          if (Date.now() >= ends) return finish(unresolved());
          const checked = (allowed: boolean) => {
            if (finished || !current()) return;
            if (Date.now() >= ends) return finish(unresolved());
            if (allowed !== true) return finish({ state: 'notAccepted', reason: 'notAuthorized' });
            next();
          };
          try {
            const result = authorizeHandoff(authorization.signal);
            if (typeof result === 'boolean') checked(result);
            else
              Promise.resolve(result).then(checked, () => {
                if (current()) finish({ state: 'notAccepted', reason: 'notAuthorized' });
              });
          } catch {
            if (current())
              finish(
                acceptancePossible
                  ? unresolved()
                  : { state: 'notAccepted', reason: 'notAuthorized' },
              );
          }
        };
        const attempt = (index: number) =>
          authorize(() => {
            let attemptDone = false;
            let handedOff = false;
            let requestedSocket = false;
            let socket: Socket | undefined;
            const completed = (error: Error | null, info?: SubmissionInfo) => {
              if (finished || attemptDone) return;
              attemptDone = true;
              socket?.destroy();
              if (
                !error &&
                handedOff &&
                Array.isArray(info?.accepted) &&
                info.accepted.length === 1 &&
                info.accepted[0] === recipient &&
                (info.rejected === undefined ||
                  (Array.isArray(info.rejected) && info.rejected.length === 0)) &&
                typeof info.response === 'string' &&
                /^2\d\d(?:[ -]|$)/.test(info.response)
              ) {
                finish({ state: 'accepted', relayIndex: index });
              } else if (error && (!handedOff || explicitRejection(error))) {
                acceptancePossible = false;
                if (index + 1 < config.hosts.length) attempt(index + 1);
                else finish({ state: 'notAccepted', reason: 'unavailable' });
              } else finish(unresolved());
            };
            const remaining = ends - Date.now();
            const connectBudget = Math.min(CONNECT_MS, remaining);
            try {
              const transport = deps.createTransport({
                host: config.hosts[index],
                port: 587,
                secure: false,
                requireTLS: true,
                forceAuth: true,
                pool: false,
                logger: false,
                debug: false,
                auth: { user: config.username, pass: config.password },
                tls: {
                  ca: config.ca,
                  servername: config.servername,
                  rejectUnauthorized: true,
                  minVersion: 'TLSv1.2',
                },
                connectionTimeout: connectBudget,
                greetingTimeout: connectBudget,
                socketTimeout: remaining,
                disableFileAccess: true,
                disableUrlAccess: true,
                getSocket: (_options, callback) => {
                  if (finished || attemptDone || requestedSocket)
                    return callback(new Error('Submission unavailable'));
                  requestedSocket = true;
                  socket = deps.createSocket?.() ?? new Socket();
                  sockets.add(socket);
                  let connected = false;
                  const ready = (error?: Error) => {
                    if (connected) return;
                    connected = true;
                    clearTimeout(timer);
                    connectTimers.delete(timer);
                    socket!.removeListener('connect', onConnect);
                    if (finished || attemptDone || error) {
                      socket!.removeListener('error', onError);
                      socket!.destroy();
                      callback(error ?? new Error('Submission unavailable'));
                    } else
                      authorize(
                        () => {
                          socket!.removeListener('error', onError);
                          handedOff = true;
                          acceptancePossible = true;
                          try {
                            callback(null, { connection: socket! });
                          } catch {
                            finish(unresolved());
                          }
                        },
                        () => !attemptDone,
                      );
                  };
                  const onError = (error: Error) => {
                    if (!connected) ready(error);
                    else if (!handedOff) completed(error);
                  };
                  const onConnect = () => ready();
                  const timer = setTimeout(
                    () => ready(new Error('Submission unavailable')),
                    Math.min(CONNECT_MS, ends - Date.now()),
                  );
                  timer.unref?.();
                  connectTimers.add(timer);
                  socket.once('connect', onConnect);
                  socket.once('error', onError);
                  socket.connect(587, config.hosts[index]);
                },
              });
              transports.add(transport);
              transport.sendMail(
                {
                  raw,
                  envelope: { from: config.from, to: [recipient] },
                  disableFileAccess: true,
                  disableUrlAccess: true,
                },
                completed,
              );
            } catch {
              finish(unresolved());
            }
          });
        try {
          stream = deps.createMimeStream(message);
          const chunks: Buffer[] = [];
          let length = 0;
          let ended = false;
          stream.on('data', (chunk: Buffer | string) => {
            if (finished) return;
            try {
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              if (length + bytes.length > MAX_MIME_BYTES) {
                finish({ state: 'notAccepted', reason: 'tooLarge' });
                return;
              }
              chunks.push(Buffer.from(bytes));
              length += bytes.length;
            } catch {
              finish({ state: 'notAccepted', reason: 'unavailable' });
            }
          });
          stream.once('error', () => finish(unresolved()));
          stream.once('close', () => {
            if (!ended) finish({ state: 'notAccepted', reason: 'unavailable' });
          });
          stream.once('end', () => {
            ended = true;
            if (finished) return;
            if (length === 0) return finish({ state: 'notAccepted', reason: 'invalid' });
            raw = Buffer.concat(chunks, length);
            attempt(0);
          });
          stream.resume();
        } catch {
          finish({ state: 'notAccepted', reason: 'unavailable' });
        }
      });
    },
  };
}
