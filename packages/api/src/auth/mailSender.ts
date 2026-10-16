import { URL } from 'node:url';
import { Socket, isIP } from 'node:net';
import { X509Certificate } from 'node:crypto';
import { emailCodeLink, mailClientUrl } from './emailCodeLink';
import { emailCodeMessage } from './emailCodeMessage';
import type { EmailCodeSender } from './emailCode.types';

const DEADLINE_MS = 20_000;
const CONNECT_MS = 5_000;

export interface EmailCodeMailConfig {
  hosts: readonly string[];
  username: string;
  password: string;
  ca: string;
  servername: string;
  from: string;
  appTitle: string;
  allowedDomains: readonly string[];
  clientUrl?: string;
  /** Trusted deployment artwork, copied once; never a URL or a mail-client file path. */
  logoPng?: Buffer;
}

type SocketCallback = (error: Error | null, value?: { connection: Socket }) => void;
export interface EmailCodeSMTPOptions {
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
  getSocket: (options: unknown, callback: SocketCallback) => void;
}
interface SubmissionInfo {
  accepted?: unknown[];
  rejected?: unknown[];
  response?: string;
}
export interface EmailCodeMailMessage {
  from: { name: string; address: string };
  to: { address: string };
  envelope: { from: string; to: string[] };
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
export interface EmailCodeMailTransport {
  sendMail(
    message: EmailCodeMailMessage,
    callback: (error: Error | null, info?: SubmissionInfo) => void,
  ): void;
  close(): void;
}
export interface EmailCodeMailDependencies {
  createTransport(options: EmailCodeSMTPOptions): EmailCodeMailTransport;
  /** Socket ownership is required: nodemailer's transport.close() does not abort an active send. */
  createSocket?: () => Socket;
}

/** No transport diagnostics, mailboxes, credentials or codes cross this error boundary. */
class SubmissionUnavailable extends Error {
  readonly code = 'EMAIL_CODE_UNAVAILABLE';
  constructor() {
    super('Email-code submission unavailable');
  }
}

/** An explicit SMTP rejection proves non-acceptance; a generic CONN error does not. */
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

function invalidMailConfig(): never {
  throw new Error('Invalid email-code SMTP configuration');
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
function snapshotMailConfig(value: unknown): EmailCodeMailConfig {
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
    ...(logo === undefined ? {} : { logoPng: Buffer.from(logo as Buffer) }),
    ...(input.clientUrl === undefined ? {} : { clientUrl: mailClientUrl(input.clientUrl) }),
  });
}

/** Public configuration only; callers obtain password/CA from the deployment's existing secret owner. */
export function getEmailCodeMailConfig(
  env: Record<string, string | undefined>,
  allowedDomains: readonly string[],
): EmailCodeMailConfig | undefined {
  if (env.EMAIL_CODE_ENABLED !== 'true') return undefined;
  const password = env.EMAIL_CODE_SMTP_PASSWORD;
  const ca = env.EMAIL_CODE_SMTP_CA;
  const hostsJSON = env.EMAIL_CODE_SMTP_HOSTS;
  const explicit = [
    password,
    ca,
    hostsJSON,
    env.EMAIL_CODE_SMTP_USERNAME,
    env.EMAIL_CODE_SMTP_FROM,
    env.EMAIL_CODE_SMTP_TLS_SERVERNAME,
  ];
  if (explicit.every((value) => value == null || value === '')) return undefined;
  if (typeof hostsJSON !== 'string' || hostsJSON.length > 1024) return invalidMailConfig();
  let hosts: unknown;
  try {
    hosts = JSON.parse(hostsJSON) as unknown;
  } catch {
    return invalidMailConfig();
  }
  return snapshotMailConfig({
    hosts,
    username: env.EMAIL_CODE_SMTP_USERNAME,
    password,
    ca,
    servername: env.EMAIL_CODE_SMTP_TLS_SERVERNAME,
    from: env.EMAIL_CODE_SMTP_FROM,
    appTitle: env.APP_TITLE == null || env.APP_TITLE === '' ? 'LibreChat' : env.APP_TITLE,
    allowedDomains,
    ...(env.DOMAIN_CLIENT ? { clientUrl: env.DOMAIN_CLIENT } : {}),
  });
}

/** One bounded submission operation, with failover only where a previous acceptance is disproved. */
export function createBoundedEmailCodeSender(
  inputConfig: EmailCodeMailConfig,
  deps: EmailCodeMailDependencies,
): EmailCodeSender {
  const config = snapshotMailConfig(inputConfig);
  return {
    async sendCode(input) {
      const domain = input.email.slice(input.email.lastIndexOf('@') + 1);
      if (
        !/^[^\s@<>]+@[^\s@<>]+$/.test(input.email) ||
        input.email.length > 254 ||
        !config.allowedDomains.includes(domain) ||
        !/^\d{8}$/.test(input.code) ||
        input.expiresInMinutes !== 10
      ) {
        throw new SubmissionUnavailable();
      }
      const link = config.clientUrl
        ? emailCodeLink(config.clientUrl, input.attemptId, input.code)
        : undefined;
      const message: EmailCodeMailMessage = {
        from: { name: config.appTitle, address: config.from },
        to: { address: input.email },
        envelope: { from: config.from, to: [input.email] },
        ...emailCodeMessage({
          appTitle: config.appTitle,
          code: input.code,
          locale: input.locale,
          link,
          embeddedLogo: Boolean(config.logoPng && link),
        }),
        ...(config.logoPng && link
          ? {
              attachments: [
                {
                  filename: 'application-logo.png' as const,
                  content: Buffer.from(config.logoPng),
                  contentType: 'image/png' as const,
                  contentDisposition: 'inline' as const,
                  cid: 'application-logo@local' as const,
                },
              ],
            }
          : {}),
        disableFileAccess: true,
        disableUrlAccess: true,
      };
      await new Promise<void>((resolve, reject) => {
        const sockets = new Set<Socket>();
        const transports = new Set<EmailCodeMailTransport>();
        const connectTimers = new Set<ReturnType<typeof setTimeout>>();
        let finished = false;
        const cleanup = () => {
          clearTimeout(deadline);
          for (const timer of connectTimers) clearTimeout(timer);
          // Destroy the underlying TCP socket, including when nodemailer wrapped it for STARTTLS.
          for (const socket of sockets) socket.destroy();
          for (const transport of transports) {
            try {
              transport.close();
            } catch {
              /* Socket is already destroyed. */
            }
          }
        };
        const finish = (accepted: boolean) => {
          if (finished) return;
          finished = true;
          cleanup();
          if (accepted) resolve();
          else reject(new SubmissionUnavailable());
        };
        const deadline = setTimeout(() => finish(false), DEADLINE_MS);
        deadline.unref?.();
        const attempt = (index: number) => {
          if (finished) return;
          let attemptDone = false;
          let handedOff = false;
          let socket: Socket | undefined;
          let transport: EmailCodeMailTransport;
          const completed = (error: Error | null, info?: SubmissionInfo) => {
            if (finished || attemptDone) return;
            attemptDone = true;
            socket?.destroy();
            if (
              !error &&
              info?.accepted?.length === 1 &&
              info.accepted[0] === input.email &&
              (info.rejected?.length ?? 0) === 0 &&
              /^2\d\d(?:[ -]|$)/.test(info.response ?? '')
            ) {
              finish(true);
            } else if (
              error &&
              (!handedOff || explicitRejection(error)) &&
              index + 1 < config.hosts.length
            ) {
              attempt(index + 1);
            } else {
              finish(false);
            }
          };
          try {
            transport = deps.createTransport({
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
              connectionTimeout: CONNECT_MS,
              greetingTimeout: CONNECT_MS,
              socketTimeout: DEADLINE_MS,
              disableFileAccess: true,
              disableUrlAccess: true,
              getSocket: (_options, callback) => {
                if (finished || attemptDone) return callback(new SubmissionUnavailable());
                socket = deps.createSocket?.() ?? new Socket();
                sockets.add(socket);
                let connected = false;
                const ready = (error?: Error) => {
                  if (connected) return;
                  connected = true;
                  clearTimeout(timer);
                  connectTimers.delete(timer);
                  socket!.removeListener('error', onError);
                  socket!.removeListener('connect', onConnect);
                  if (finished || attemptDone || error) {
                    socket!.destroy();
                    callback(error ?? new SubmissionUnavailable());
                  } else {
                    handedOff = true;
                    callback(null, { connection: socket! });
                  }
                };
                const onError = (error: Error) => ready(error);
                const onConnect = () => ready();
                const timer = setTimeout(() => ready(new SubmissionUnavailable()), CONNECT_MS);
                timer.unref?.();
                connectTimers.add(timer);
                socket.once('connect', onConnect);
                socket.once('error', onError);
                socket.connect(587, config.hosts[index]);
              },
            });
            transports.add(transport);
            transport.sendMail(message, completed);
          } catch {
            // Configuration/composition failures are not a reason to replay a submission.
            finish(false);
          }
        };
        attempt(0);
      });
    },
  };
}
