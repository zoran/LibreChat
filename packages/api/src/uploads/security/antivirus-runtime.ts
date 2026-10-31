/** antivirus-runtime.ts binds one immutable signed generation to original ClamD custody and joined retirement. */
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { performance } from 'node:perf_hooks';
import { readFileSync, readlinkSync, readdirSync } from 'node:fs';
import { readUploadSecuritySubject, readUploadAntivirusCustody } from 'librechat-data-provider';
import type {
  UploadAntivirusCustody,
  UploadAntivirusApproval,
  UploadAntivirusReceipt,
  UploadSecuritySubject,
} from 'librechat-data-provider';
import type { AntivirusProcessProfile, AntivirusOriginal } from './antivirus-process';
import { createAntivirusProcessOwner, readAntivirusImmutableAsset } from './antivirus-process';
import { createClamdAdapter } from './antivirus';

/** Published verification metadata is immutable root-owned input, never an upload assertion. */
export type AntivirusGeneration = Readonly<{
  version: 1;
  signatureManifestSha256: string;
  signatureVerificationSha256: string;
  dailyDatabaseVersion: number;
  dailyPublishedAt: string;
  engineVersion: string;
}>;
/** Deployment supplies exact image/source/pod identity through its normal trusted composition. */
export type AntivirusRuntimeConfiguration = Readonly<{
  process: AntivirusProcessProfile;
  profileSha256: string;
  signatureMaxAgeMs: number;
  generation: AntivirusGeneration;
  identity: Readonly<{ slot: string; podUid: string; sourceRevision: string }>;
}>;
/** This port never substitutes a fresh process for a prepared original. */
export type AntivirusSession = Readonly<{
  custody: UploadAntivirusCustody;
  activate(signal: AbortSignal): Promise<void>;
  inspect(
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<
    | { verdict: 'clean'; approval: UploadAntivirusApproval }
    | { verdict: 'malicious' | 'uninspectable' | 'unavailable'; reason: string }
  >;
  retire(): Promise<UploadAntivirusReceipt>;
}>;
/** Current readiness and pending originals belong to this scanner incarnation only. */
export type AntivirusRuntime = Readonly<{
  initialise(signal: AbortSignal): Promise<void>;
  available(): boolean;
  deadline(originalExpiresAt: string): string;
  pending(): number;
  prepare(subject: UploadSecuritySubject, expiresAt: string): Promise<AntivirusSession>;
  drain(): Promise<{ complete: boolean }>;
}>;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const failure = () => new Error('Antivirus unavailable');
const iso = (v: unknown): v is string =>
  typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const digest = (v: Uint8Array) => createHash('sha256').update(v).digest('hex');
function fresh(generation: AntivirusGeneration, maxAgeMs: number, now = Date.now()): boolean {
  return (
    generation.version === 1 &&
    /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(generation.engineVersion) &&
    hash(generation.signatureManifestSha256) &&
    hash(generation.signatureVerificationSha256) &&
    Number.isSafeInteger(generation.dailyDatabaseVersion) &&
    generation.dailyDatabaseVersion > 0 &&
    iso(generation.dailyPublishedAt) &&
    Date.parse(generation.dailyPublishedAt) <= now &&
    now - Date.parse(generation.dailyPublishedAt) < maxAgeMs
  );
}

/** Actual readonly/root-owned file and digest guards are shared with the process owner. */
export function readAntivirusConfiguration(input: {
  profileSha256: string;
  generationSha256: string;
  signatureMaxAgeMs: number;
  slot: string;
  podUid: string;
  sourceRevision: string;
}): AntivirusRuntimeConfiguration {
  const profileBytes = readAntivirusImmutableAsset({
    path: '/etc/cortex-document-antivirus/profile.json',
    sha256: input.profileSha256,
  });
  const generationBytes = readAntivirusImmutableAsset({
    path: '/etc/cortex-document-antivirus/generation.json',
    sha256: input.generationSha256,
  });
  if (profileBytes.byteLength > 65536 || generationBytes.byteLength > 4096) throw failure();
  const process = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(profileBytes));
  const generation = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(generationBytes));
  if (
    !generation ||
    Object.keys(generation).sort().join(',') !==
      'dailyDatabaseVersion,dailyPublishedAt,engineVersion,signatureManifestSha256,signatureVerificationSha256,version'
  )
    throw failure();
  return {
    process,
    generation,
    profileSha256: input.profileSha256,
    signatureMaxAgeMs: input.signatureMaxAgeMs,
    identity: { slot: input.slot, podUid: input.podUid, sourceRevision: input.sourceRevision },
  };
}

/** Exact proc birth/executable and server-socket ownership supplement filesystem inode identity. */
function sameOriginal(
  original: AntivirusOriginal,
  profile: AntivirusProcessProfile,
  socket: { path: string },
): boolean {
  try {
    const { pid, start, boot } = original.custody;
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop()!.split(' ');
    if (
      stat[19] !== start ||
      readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() !== boot ||
      readlinkSync(`/proc/${pid}/exe`) !== profile.program.path
    )
      return false;
    const table = readFileSync('/proc/net/unix', 'utf8');
    if (table.length > 1024 * 1024) return false;
    const matches = table
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields[7] === socket.path);
    if (matches.length !== 1 || !/^[0-9]+$/.test(matches[0][6])) return false;
    const wanted = `socket:[${matches[0][6]}]`;
    const fds = readdirSync(`/proc/${pid}/fd`);
    return (
      fds.length <= 1024 &&
      fds.some((fd) => {
        try {
          return readlinkSync(`/proc/${pid}/fd/${fd}`) === wanted;
        } catch {
          return false;
        }
      })
    );
  } catch {
    return false;
  }
}
/** One fixed bounded local command; no supplied endpoint, credential, filename scan or retry. */
async function version(
  original: AntivirusOriginal,
  profile: AntivirusProcessProfile,
  deadline: number,
  signal: AbortSignal,
): Promise<{ version: string; daily: number } | null> {
  const socketIdentity = original.socket();
  if (
    !socketIdentity ||
    !sameOriginal(original, profile, socketIdentity) ||
    signal.aborted ||
    deadline <= Date.now()
  )
    return null;
  return new Promise((resolve) => {
    const socket = createConnection({ path: socketIdentity.path });
    const chunks: Buffer[] = [];
    let bytes = 0,
      failed = false,
      ended = false;
    const abort = () => {
      failed = true;
      socket.destroy();
    };
    const timer = setTimeout(abort, Math.max(1, Math.min(3000, deadline - Date.now())));
    socket.once('connect', () => {
      const current = original.socket();
      if (
        !current ||
        current.device !== socketIdentity.device ||
        current.inode !== socketIdentity.inode ||
        !sameOriginal(original, profile, current) ||
        signal.aborted
      )
        return abort();
      socket.end('zVERSION\0');
    });
    socket.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4096) abort();
      else chunks.push(Buffer.from(chunk));
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
      const current = original.socket();
      const raw = Buffer.concat(chunks);
      for (const chunk of chunks) chunk.fill(0);
      const candidate =
        !failed &&
        ended &&
        socket.writableFinished &&
        current &&
        current.device === socketIdentity.device &&
        current.inode === socketIdentity.inode &&
        sameOriginal(original, profile, current) &&
        raw
          .toString('ascii')
          .match(
            /^ClamAV ([A-Za-z0-9][A-Za-z0-9._+-]{0,63})\/([1-9][0-9]{0,9})\/([^\r\n]{2,129})$/,
          );
      const match =
        candidate && candidate[3].endsWith('\0') && !candidate[3].slice(0, -1).includes('\0')
          ? candidate
          : null;
      raw.fill(0);
      resolve(match ? { version: match[1], daily: Number(match[2]) } : null);
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Trusted startup warms/tests/joins its own process; every user scan gets another bound original. */
export function createAntivirusRuntime(
  configuration: AntivirusRuntimeConfiguration,
): AntivirusRuntime {
  const config = structuredClone(configuration);
  const { generation, process: profile, identity, signatureMaxAgeMs } = config;
  if (
    !Number.isSafeInteger(signatureMaxAgeMs) ||
    signatureMaxAgeMs < 1000 ||
    signatureMaxAgeMs > 86_400_000 ||
    !hash(config.profileSha256) ||
    !fresh(generation, signatureMaxAgeMs) ||
    generation.signatureManifestSha256 !== profile.signatureManifestSha256 ||
    !/^[a-zA-Z0-9_.-]{1,128}$/.test(identity.slot) ||
    !/^[a-zA-Z0-9_.-]{1,128}$/.test(identity.podUid) ||
    !/^[a-f0-9]{40}$/.test(identity.sourceRevision)
  )
    throw failure();
  const owner = createAntivirusProcessOwner(profile);
  const sessions = new Set<AntivirusSession>();
  let qualified = false,
    closed = false,
    unknownBirth = false,
    starting = false,
    initialising: Promise<void> | undefined;
  async function loaded(original: AntivirusOriginal, deadline: number, signal: AbortSignal) {
    if (signal.aborted || !(await original.activate())) throw original.failure() ?? failure();
    const mono = performance.now() + Math.max(0, deadline - Date.now() - 10_000);
    while (
      !closed &&
      !signal.aborted &&
      Date.now() < deadline - 10_000 &&
      performance.now() < mono &&
      fresh(generation, signatureMaxAgeMs)
    ) {
      const processFailure = original.failure();
      if (processFailure) throw processFailure;
      if (original.socket()) {
        const observed = await version(original, profile, deadline - 10_000, signal);
        if (
          !observed ||
          observed.version !== generation.engineVersion ||
          observed.daily !== generation.dailyDatabaseVersion
        )
          throw original.failure() ?? failure();
        const socket = original.socket();
        if (!socket || !sameOriginal(original, profile, socket))
          throw original.failure() ?? failure();
        return {
          socket,
          observedAt: new Date().toISOString(),
          engine: {
            engineVersion: observed.version,
            engineSha256: profile.program.sha256,
            configurationSha256: original.custody.configurationSha256,
            databaseSha256: generation.signatureManifestSha256,
            databaseVersion: generation.dailyDatabaseVersion,
            dailyPublishedAtMs: Date.parse(generation.dailyPublishedAt),
            observedReadyAtMs: Date.now(),
            daemonInstanceId: original.custody.id,
          },
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw failure();
  }
  async function start(deadline: number) {
    if (starting) throw failure();
    starting = true;
    let original: AntivirusOriginal | null;
    try {
      original = await owner.start(deadline);
    } catch (error) {
      unknownBirth = true;
      throw error;
    } finally {
      starting = false;
    }
    if (!original) {
      unknownBirth = true;
      throw failure();
    }
    return original;
  }
  const runtime: AntivirusRuntime = {
    available: () => qualified && !closed && !unknownBirth && fresh(generation, signatureMaxAgeMs),
    deadline(originalExpiresAt) {
      if (!iso(originalExpiresAt)) throw failure();
      return new Date(
        Math.min(
          Date.parse(originalExpiresAt),
          Date.parse(generation.dailyPublishedAt) + signatureMaxAgeMs,
          Date.now() + 60_000,
        ),
      ).toISOString();
    },
    pending: () => sessions.size + Number(unknownBirth) + Number(starting) + Number(!!initialising),
    initialise(signal) {
      if (closed) return Promise.reject(failure());
      if (qualified || initialising) return initialising ?? Promise.resolve();
      initialising = (async () => {
        const deadline = Date.now() + 60_000;
        const original = await start(deadline);
        let startupFailure: unknown;
        try {
          const observation = await loaded(original, deadline, signal);
          const adapter = createClamdAdapter({
            socket: observation.socket,
            loaded: observation.engine,
            expectedEngineVersion: generation.engineVersion,
          });
          const fixtures = [
            { bytes: Buffer.from('Cortex antivirus startup probe\n'), verdict: 'clean' },
            {
              bytes: Buffer.from(
                'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
              ),
              verdict: 'malicious',
            },
          ];
          for (const fixture of fixtures) {
            try {
              const result = await adapter.inspect(
                { bytes: fixture.bytes.length, sha256: digest(fixture.bytes) },
                fixture.bytes,
                deadline,
                signal,
              );
              if (result.verdict !== fixture.verdict) throw failure();
            } finally {
              fixture.bytes.fill(0);
            }
          }
        } catch (error) {
          startupFailure = error;
        } finally {
          try {
            const stopped = await original.retire();
            if (!stopped.originalProcessJoined || !stopped.ownedTransientDataRemoved) {
              unknownBirth = true;
              startupFailure ??= failure();
            }
          } catch {
            unknownBirth = true;
            startupFailure ??= failure();
          }
        }
        if (startupFailure) throw startupFailure;
        qualified = true;
      })().finally(() => {
        initialising = undefined;
      });
      return initialising;
    },
    async prepare(subject, expiresAt) {
      if (
        starting ||
        sessions.size ||
        !runtime.available() ||
        !iso(expiresAt) ||
        runtime.deadline(expiresAt) !== expiresAt
      )
        throw failure();
      const boundSubject = readUploadSecuritySubject(subject);
      if (!boundSubject) throw failure();
      const original = await start(Date.parse(expiresAt));
      const custody: UploadAntivirusCustody = {
        version: 1,
        slot: identity.slot,
        podUid: identity.podUid,
        runtimeImage: profile.image,
        sourceRevision: identity.sourceRevision,
        engineArtifactSha256: profile.program.sha256,
        profileSha256: config.profileSha256,
        signatureManifestSha256: generation.signatureManifestSha256,
        signatureVerificationSha256: generation.signatureVerificationSha256,
        dailyDatabaseVersion: generation.dailyDatabaseVersion,
        dailyPublishedAt: generation.dailyPublishedAt,
        original: {
          id: original.custody.id,
          pid: original.custody.pid,
          startTicks: original.custody.start,
          bootId: original.custody.boot,
          configurationSha256: original.custody.configurationSha256,
        },
        subject: boundSubject,
        expiresAt,
      };
      const snapshot = () => {
        const value = readUploadAntivirusCustody(custody);
        if (!value) throw failure();
        return value;
      };
      let initialCustody: UploadAntivirusCustody;
      try {
        initialCustody = snapshot();
      } catch (error) {
        unknownBirth = true;
        try {
          const stopped = await original.retire();
          unknownBirth = !(stopped.originalProcessJoined && stopped.ownedTransientDataRemoved);
        } catch {
          /* Same original remains drain-visible. */
        }
        throw error;
      }
      let used = false,
        activation: Promise<void> | undefined;
      let observation: Awaited<ReturnType<typeof loaded>> | undefined;
      const session: AntivirusSession = {
        custody: initialCustody,
        activate(signal) {
          activation ??= loaded(original, Date.parse(expiresAt), signal).then((value) => {
            observation = value;
          });
          return activation;
        },
        async inspect(bytes, signal) {
          if (used || closed || !observation) throw failure();
          used = true;
          const adapter = createClamdAdapter({
            socket: observation.socket,
            loaded: observation.engine,
            expectedEngineVersion: generation.engineVersion,
          });
          const result = await adapter.inspect(subject, bytes, Date.parse(expiresAt), signal);
          if (result.verdict !== 'clean') return { verdict: result.verdict, reason: result.reason };
          if (
            !fresh(generation, signatureMaxAgeMs) ||
            !sameOriginal(original, profile, observation.socket)
          )
            throw failure();
          return {
            verdict: 'clean',
            approval: {
              custody: snapshot(),
              engineVersion: generation.engineVersion,
              readyObservedAt: observation.observedAt,
              cleanAt: new Date().toISOString(),
            },
          };
        },
        async retire() {
          const result = await original.retire();
          const complete = result.originalProcessJoined && result.ownedTransientDataRemoved;
          if (complete) sessions.delete(session);
          return {
            custody: snapshot(),
            state: complete ? 'retired' : 'unknown',
            originalProcessJoined: result.originalProcessJoined,
            ownedTransientDataRemoved: result.ownedTransientDataRemoved,
          };
        },
      };
      sessions.add(session);
      return session;
    },
    async drain() {
      closed = true;
      qualified = false;
      await Promise.allSettled([...sessions].map((session) => session.retire()));
      const result = await owner.drain();
      if (initialising) await Promise.allSettled([initialising]);
      if (result.originalProcessJoined && result.ownedTransientDataRemoved) unknownBirth = false;
      return {
        complete:
          sessions.size === 0 &&
          !unknownBirth &&
          !initialising &&
          result.originalProcessJoined &&
          result.ownedTransientDataRemoved,
      };
    },
  };
  return Object.freeze(runtime);
}
