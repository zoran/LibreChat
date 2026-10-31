/** antivirus.ts owns the bounded ClamD INSTREAM boundary. Transport verdicts never issue Upload approval or daemon settlement. */
import { lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import type { UploadSecuritySubject } from 'librechat-data-provider';

export type LoadedAntivirus = Readonly<{
  engineVersion: string;
  engineSha256: string;
  configurationSha256: string;
  databaseSha256: string;
  databaseVersion: number;
  dailyPublishedAtMs: number;
  observedReadyAtMs: number;
  daemonInstanceId: string;
}>;
export type AntivirusObservation = Readonly<{
  verdict: 'clean' | 'malicious' | 'uninspectable' | 'unavailable';
  reason:
    | 'none'
    | 'malware'
    | 'encrypted'
    | 'resource_limit'
    | 'invalid_content'
    | 'scanner_unavailable';
  bytes: number;
  sha256: string;
  engine: LoadedAntivirus;
  transportJoined: true;
  /** Closing this socket cannot prove cancellation or removal of daemon copies. */
  requiresOriginalDaemonRetirement: true;
}>;
type SocketIdentity = Readonly<{ path: string; device: number; inode: number; uid: number }>;
type Options = Readonly<{
  /** Trusted server composition captures this private inode; never accept it from request JSON. */
  socket: SocketIdentity;
  loaded: LoadedAntivirus;
  expectedEngineVersion: string;
  now?: () => number;
  scanTimeoutMs?: number;
  cleanupReserveMs?: number;
}>;
const hash = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
function available(engine: LoadedAntivirus, expected: string, now: number): boolean {
  return (
    engine.engineVersion === expected &&
    hash(engine.engineSha256) &&
    hash(engine.configurationSha256) &&
    hash(engine.databaseSha256) &&
    Number.isSafeInteger(engine.databaseVersion) &&
    engine.databaseVersion > 0 &&
    /^[a-zA-Z0-9_.-]{1,128}$/.test(engine.daemonInstanceId) &&
    [engine.dailyPublishedAtMs, engine.observedReadyAtMs, now].every(Number.isSafeInteger) &&
    engine.dailyPublishedAtMs > 0 &&
    engine.dailyPublishedAtMs <= engine.observedReadyAtMs &&
    engine.observedReadyAtMs <= now &&
    now - engine.dailyPublishedAtMs < 86_400_000
  );
}
function sameSocket(expected: SocketIdentity): boolean {
  try {
    const s = lstatSync(expected.path);
    return (
      s.isSocket() &&
      !s.isSymbolicLink() &&
      s.dev === expected.device &&
      s.ino === expected.inode &&
      s.uid === expected.uid &&
      (s.mode & 0o077) === 0
    );
  } catch {
    return false;
  }
}
function verdict(raw: Buffer): Pick<AntivirusObservation, 'verdict' | 'reason'> {
  if (raw.equals(Buffer.from('stream: OK\0'))) return { verdict: 'clean', reason: 'none' };
  const text = raw.toString('ascii');
  const malicious = text.match(/^stream: [A-Za-z0-9_.:+-]{1,256} FOUND(.)$/);
  if (!raw.equals(Buffer.from(text, 'ascii')) || malicious?.[1] !== '\0')
    return { verdict: 'unavailable', reason: 'scanner_unavailable' };
  if (text.startsWith('stream: Heuristics.Limits.Exceeded.'))
    return { verdict: 'uninspectable', reason: 'resource_limit' };
  if (text.startsWith('stream: Heuristics.Encrypted.'))
    return { verdict: 'uninspectable', reason: 'encrypted' };
  return { verdict: 'malicious', reason: 'malware' };
}
/** One active scan, no queue. Caller owns the original execution and retires its daemon before approval. */
export function createClamdAdapter(options: Options) {
  const loaded = Object.freeze({ ...options.loaded });
  const socketIdentity = Object.freeze({ ...options.socket });
  const now = options.now ?? Date.now;
  const expectedVersion = options.expectedEngineVersion;
  const timeoutMs = options.scanTimeoutMs ?? 20_000;
  const cleanupReserveMs = options.cleanupReserveMs ?? 10_000;
  if (
    !socketIdentity.path.startsWith('/') ||
    socketIdentity.path.includes('\0') ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 20_000 ||
    !Number.isInteger(cleanupReserveMs) ||
    cleanupReserveMs < 1 ||
    cleanupReserveMs > 10_000
  )
    throw new Error('Invalid private antivirus composition');
  let active = false;
  return Object.freeze({
    async inspect(
      subject: Pick<UploadSecuritySubject, 'bytes' | 'sha256'>,
      bytes: Uint8Array,
      originalDeadlineAtMs: number,
      signal: AbortSignal,
    ): Promise<AntivirusObservation> {
      const expected = Object.freeze({ bytes: subject.bytes, sha256: subject.sha256 });
      const result = (v: Pick<AntivirusObservation, 'verdict' | 'reason'>): AntivirusObservation =>
        Object.freeze({
          ...v,
          bytes: expected.bytes,
          sha256: expected.sha256,
          engine: loaded,
          transportJoined: true,
          requiresOriginalDaemonRetirement: true,
        });
      const unavailable = () => result({ verdict: 'unavailable', reason: 'scanner_unavailable' });
      if (active) return unavailable();
      if (
        !Number.isSafeInteger(expected.bytes) ||
        expected.bytes < 1 ||
        expected.bytes > 30 * 1024 * 1024 ||
        !hash(expected.sha256) ||
        !(bytes instanceof Uint8Array) ||
        bytes.buffer instanceof SharedArrayBuffer ||
        bytes.byteLength !== expected.bytes
      )
        return result({ verdict: 'uninspectable', reason: 'invalid_content' });
      const remaining = originalDeadlineAtMs - now() - cleanupReserveMs;
      if (
        !Number.isSafeInteger(originalDeadlineAtMs) ||
        remaining <= 0 ||
        signal.aborted ||
        !available(loaded, expectedVersion, now()) ||
        !sameSocket(socketIdentity)
      )
        return unavailable();
      active = true;
      const chunks = Math.ceil(bytes.byteLength / 65_536);
      const frame = Buffer.alloc(10 + chunks * 4 + bytes.byteLength + 4);
      frame.write('zINSTREAM\0');
      const digest = createHash('sha256');
      let at = 10;
      for (let offset = 0; offset < bytes.byteLength; offset += 65_536) {
        const part = bytes.subarray(offset, offset + 65_536);
        frame.writeUInt32BE(part.byteLength, at);
        at += 4;
        frame.set(part, at);
        digest.update(frame.subarray(at, at + part.byteLength));
        at += part.byteLength;
      }
      frame.writeUInt32BE(0, at);
      try {
        if (digest.digest('hex') !== expected.sha256)
          return result({ verdict: 'uninspectable', reason: 'invalid_content' });
        const response = await new Promise<Buffer | null>((resolve) => {
          const socket = createConnection({ path: socketIdentity.path });
          const replies: Buffer[] = [];
          let count = 0,
            ended = false,
            failed = false;
          const abort = () => {
            failed = true;
            socket.destroy();
          };
          const timer = setTimeout(abort, Math.min(timeoutMs, remaining));
          socket.once('connect', () => {
            if (signal.aborted || !sameSocket(socketIdentity)) return abort();
            socket.end(frame);
          });
          socket.on('data', (chunk: Buffer) => {
            count += chunk.byteLength;
            if (count > 4096) return abort();
            replies.push(Buffer.from(chunk));
          });
          socket.once('error', () => {
            failed = true;
          });
          socket.once('end', () => {
            ended = true;
          });
          socket.once('close', () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            const raw =
              !failed && ended && socket.writableFinished && sameSocket(socketIdentity)
                ? Buffer.concat(replies)
                : null;
            for (const part of replies) part.fill(0);
            resolve(raw);
          });
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
        if (!response) return unavailable();
        try {
          if (
            !available(loaded, expectedVersion, now()) ||
            now() >= originalDeadlineAtMs - cleanupReserveMs
          )
            return unavailable();
          return result(verdict(response));
        } finally {
          response.fill(0);
        }
      } finally {
        frame.fill(0);
        active = false;
      }
    },
  });
}
