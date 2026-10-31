/** Inert process/kernel/ClamD ports exercise the shipped AV runtime; never real engine or kernel qualification. */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { readFileSync, readlinkSync, readdirSync, lstatSync } from 'node:fs';
import type { AntivirusRuntimeConfiguration } from './antivirus-runtime';
import { createAntivirusProcessOwner, readAntivirusImmutableAsset } from './antivirus-process';
import { createAntivirusRuntime, readAntivirusConfiguration } from './antivirus-runtime';

jest.mock('./antivirus-process', () => ({
  createAntivirusProcessOwner: jest.fn(),
  readAntivirusImmutableAsset: jest.fn(),
}));
jest.mock('node:net', () => ({ createConnection: jest.fn() }));
jest.mock('node:fs', () => ({
  ...jest.requireActual('node:fs'),
  readFileSync: jest.fn(),
  readlinkSync: jest.fn(),
  readdirSync: jest.fn(),
  lstatSync: jest.fn(),
}));

const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const asset = (path: string) => ({ path, sha256: 'a'.repeat(64) });
const boot = '11111111-1111-4111-8111-111111111111';
const originalId = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;
const body = Buffer.from('Harmloser eigener Inhalt');
const subject = () => ({
  tenantId: 'tenant',
  userId: 'user',
  operationId: 'upload',
  transferGeneration: 1,
  mediaType: 'text/plain',
  bytes: body.length,
  sha256: hash(body),
});
function configuration(): AntivirusRuntimeConfiguration {
  return {
    profileSha256: 'b'.repeat(64),
    signatureMaxAgeMs: 86_400_000,
    identity: { slot: 'scanner-0', podUid: originalId(99), sourceRevision: 'c'.repeat(40) },
    generation: {
      version: 1,
      engineVersion: '1.4.6',
      signatureManifestSha256: 'd'.repeat(64),
      signatureVerificationSha256: 'e'.repeat(64),
      dailyDatabaseVersion: 123,
      dailyPublishedAt: new Date(Date.now() - 1000).toISOString(),
    },
    process: {
      schema: 1,
      purpose: 'clamd-local-v1',
      image: `registry.invalid/scanner@sha256:${'f'.repeat(64)}`,
      packageSha256: 'a'.repeat(64),
      program: asset('/usr/local/sbin/clamd'),
      loader: asset('/lib/ld.so'),
      setpriv: asset('/usr/bin/setpriv'),
      scopeHelper: asset('/app/helper'),
      filter: asset('/etc/policy.bpf'),
      libraries: [],
      signatureDirectory: '/signatures',
      signatures: [],
      signatureManifestSha256: 'd'.repeat(64),
      transientRoot: '/run/cortex-document-security/av',
      memoryMaxBytes: 4294967296,
    },
  };
}
type Original = {
  custody: {
    id: string;
    pid: number;
    start: string;
    boot: string;
    configurationSha256: string;
    signatureManifestSha256: string;
  };
  activate: jest.Mock;
  failure: jest.Mock;
  socket: jest.Mock;
  retire: jest.Mock;
};
let originals: Original[],
  active: boolean[],
  retireKnown: boolean,
  badIdentity: boolean,
  badVersion: boolean,
  malicious: boolean;
let activation: (() => Promise<boolean>) | undefined;
let processFailure: Error | null;
let duringVersion: (() => void) | undefined;
let afterVersion: (() => void) | undefined;
let duringRetirement: (() => void) | undefined;
beforeEach(() => {
  originals = [];
  active = [];
  retireKnown = true;
  badIdentity = false;
  badVersion = false;
  malicious = false;
  activation = undefined;
  processFailure = null;
  duringVersion = undefined;
  afterVersion = undefined;
  duringRetirement = undefined;
  jest.clearAllMocks();
  (createAntivirusProcessOwner as jest.Mock).mockReturnValue({
    async start() {
      const index = originals.length;
      const value: Original = {
        custody: {
          id: originalId(index + 1),
          pid: 1000 + index,
          start: '3456',
          boot,
          configurationSha256: '1'.repeat(64),
          signatureManifestSha256: 'd'.repeat(64),
        },
        activate: jest.fn(async () => {
          if (active[index]) return false;
          if (activation && !(await activation())) return false;
          active[index] = true;
          return true;
        }),
        failure: jest.fn(() => processFailure),
        socket: jest.fn(() =>
          active[index]
            ? { path: `/av/${index}/clamd.sock`, device: 7, inode: 8 + index, uid: 1000 }
            : null,
        ),
        retire: jest.fn(async () => {
          duringRetirement?.();
          if (retireKnown) active[index] = false;
          return { originalProcessJoined: retireKnown, ownedTransientDataRemoved: retireKnown };
        }),
      };
      originals.push(value);
      active.push(false);
      return value;
    },
    async drain() {
      return { originalProcessJoined: retireKnown, ownedTransientDataRemoved: retireKnown };
    },
  });
  (readFileSync as jest.Mock).mockImplementation((path: string) => {
    if (path === '/proc/sys/kernel/random/boot_id') return `${boot}\n`;
    if (path === '/proc/net/unix')
      return (
        'Num RefCount Protocol Flags Type St Inode Path\n' +
        originals
          .map(
            (_, index) =>
              `0000: 00000002 00000000 00010000 0001 01 ${9000 + index} /av/${index}/clamd.sock`,
          )
          .join('\n')
      );
    if (/^\/proc\/[0-9]+\/stat$/.test(path))
      return `1000 (clamd) S ${Array(18).fill('0').join(' ')} ${badIdentity ? 'wrong' : '3456'} 0`;
    throw new Error('Unexpected fixed metadata path');
  });
  (readlinkSync as jest.Mock).mockImplementation((path: string) => {
    if (path.endsWith('/exe')) return badIdentity ? '/foreign/program' : '/usr/local/sbin/clamd';
    const pid = Number(path.split('/')[2]);
    return `socket:[${9000 + pid - 1000}]`;
  });
  (readdirSync as jest.Mock).mockReturnValue(['3']);
  (lstatSync as jest.Mock).mockImplementation((path: string) => ({
    isSocket: () => true,
    isSymbolicLink: () => false,
    dev: 7,
    ino: 8 + Number(path.split('/')[2]),
    uid: 1000,
    mode: 0o600,
  }));
  (createConnection as jest.Mock).mockImplementation(() => {
    const socket = new EventEmitter() as EventEmitter & {
      writableFinished: boolean;
      end: (data: Buffer | string) => void;
      destroy: () => void;
    };
    socket.writableFinished = false;
    socket.destroy = () => queueMicrotask(() => socket.emit('close'));
    socket.end = (data) => {
      const bytes = Buffer.from(data);
      let response = 'stream: OK\0';
      if (bytes.equals(Buffer.from('zVERSION\0'))) {
        duringVersion?.();
        response = badVersion ? 'ClamAV 9.9.9/123/date\0' : 'ClamAV 1.4.6/123/date\0';
      } else if (bytes.includes(Buffer.from('EICAR-STANDARD')) || malicious) {
        response = 'stream: Test.Signature FOUND\0';
      }
      socket.writableFinished = true;
      queueMicrotask(() => {
        socket.emit('data', Buffer.from(response));
        socket.emit('end');
        socket.emit('close');
        if (bytes.equals(Buffer.from('zVERSION\0'))) afterVersion?.();
      });
    };
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  });
});

describe('actual AV runtime with inert external ports', () => {
  it.each(['during-version', 'after-version'])(
    'retains original death %s before retirement changes its observed state',
    async (phase) => {
      const originalCause = new Error('Fixed inert original exited 78');
      const laterRetirement = new Error('Fixed inert owner retirement SIGTERM');
      const die = () => {
        processFailure = originalCause;
        active[0] = false;
      };
      if (phase === 'during-version') duringVersion = die;
      else afterVersion = die;
      duringRetirement = () => {
        processFailure = laterRetirement;
      };
      const runtime = createAntivirusRuntime(configuration());
      await expect(runtime.initialise(AbortSignal.timeout(2000))).rejects.toBe(originalCause);
      expect(runtime.available()).toBe(false);
      expect(originals).toHaveLength(1);
      expect(originals[0].retire).toHaveBeenCalledTimes(1);
      expect(active[0]).toBe(false);
    },
  );
  it('keeps a generic VERSION refusal when only later owned retirement observes a signal', async () => {
    badVersion = true;
    const laterRetirement = new Error('Fixed inert owner retirement SIGTERM');
    duringRetirement = () => {
      processFailure = laterRetirement;
    };
    const runtime = createAntivirusRuntime(configuration());
    const result = runtime.initialise(AbortSignal.timeout(2000));
    await expect(result).rejects.toThrow('Antivirus unavailable');
    await expect(result).rejects.not.toBe(laterRetirement);
    expect(runtime.available()).toBe(false);
    expect(originals).toHaveLength(1);
    expect(originals[0].retire).toHaveBeenCalledTimes(1);
  });
  it('awaits actual permit dispatch before VERSION or startup scans', async () => {
    let dispatch: ((value: boolean) => void) | undefined;
    activation = () =>
      new Promise<boolean>((resolve) => {
        dispatch = resolve;
      });
    const runtime = createAntivirusRuntime(configuration());
    const initialising = runtime.initialise(AbortSignal.timeout(2000));
    await new Promise((resolve) => setImmediate(resolve));
    expect(runtime.available()).toBe(false);
    expect(createConnection).not.toHaveBeenCalled();
    expect(originals[0].retire).not.toHaveBeenCalled();
    if (!dispatch) throw new Error('Permit dispatch not pending');
    dispatch(true);
    await initialising;
    expect(runtime.available()).toBe(true);
    expect(originals[0].activate).toHaveBeenCalledTimes(1);
    expect(originals[0].retire).toHaveBeenCalledTimes(1);
  });
  it.each(['refused', 'rejected', 'cancelled'])(
    'keeps startup unavailable and joins the original when permit is %s',
    async (fault) => {
      const cause = new Error('Fixed inert permit failure');
      const controller = new AbortController();
      activation = async () => {
        if (fault === 'rejected') throw cause;
        if (fault === 'cancelled') {
          controller.abort();
          return true;
        }
        processFailure = cause;
        return false;
      };
      const runtime = createAntivirusRuntime(configuration());
      const result = runtime.initialise(controller.signal);
      if (fault === 'cancelled') await expect(result).rejects.toThrow();
      else await expect(result).rejects.toBe(cause);
      expect(runtime.available()).toBe(false);
      expect(createConnection).not.toHaveBeenCalled();
      expect(originals).toHaveLength(1);
      expect(originals[0].activate).toHaveBeenCalledTimes(1);
      expect(originals[0].retire).toHaveBeenCalledTimes(1);
    },
  );
  it('retires startup verification, binds a fresh original and refuses user bytes before its activation', async () => {
    const runtime = createAntivirusRuntime(configuration());
    await runtime.initialise(AbortSignal.timeout(2000));
    expect(runtime.available()).toBe(true);
    expect(originals[0].retire).toHaveBeenCalledTimes(1);
    expect(active[0]).toBe(false);
    const session = await runtime.prepare(subject(), new Date(Date.now() + 50_000).toISOString());
    expect(session.custody.original.id).not.toBe(originals[0].custody.id);
    await expect(session.inspect(body, AbortSignal.timeout(2000))).rejects.toThrow();
    expect(originals[1].activate).not.toHaveBeenCalled();
    await session.activate(AbortSignal.timeout(2000));
    const result = await session.inspect(body, AbortSignal.timeout(2000));
    expect(result.verdict).toBe('clean');
    if (result.verdict === 'clean') expect(result.approval.custody).toEqual(session.custody);
    expect(await session.retire()).toMatchObject({
      custody: session.custody,
      state: 'retired',
      originalProcessJoined: true,
      ownedTransientDataRemoved: true,
    });
    expect(runtime.pending()).toBe(0);
    expect(await runtime.drain()).toEqual({ complete: true });
    await expect(runtime.initialise(AbortSignal.timeout(2000))).rejects.toThrow();
    expect(originals).toHaveLength(2);
  });
  it.each(['foreign-birth', 'wrong-version'])(
    'keeps startup unavailable on %s and joins its same original',
    async (fault) => {
      badIdentity = fault === 'foreign-birth';
      badVersion = fault === 'wrong-version';
      const runtime = createAntivirusRuntime(configuration());
      await expect(runtime.initialise(AbortSignal.timeout(2000))).rejects.toThrow();
      expect(runtime.available()).toBe(false);
      expect(originals).toHaveLength(1);
      expect(originals[0].retire).toHaveBeenCalledTimes(1);
    },
  );
  it('returns malware observation without an approval and retires only the user original', async () => {
    const runtime = createAntivirusRuntime(configuration());
    await runtime.initialise(AbortSignal.timeout(2000));
    const session = await runtime.prepare(subject(), new Date(Date.now() + 50_000).toISOString());
    await session.activate(AbortSignal.timeout(2000));
    malicious = true;
    expect(await session.inspect(body, AbortSignal.timeout(2000))).toMatchObject({
      verdict: 'malicious',
      reason: 'malware',
    });
    await session.retire();
    expect(originals[1].retire).toHaveBeenCalledTimes(1);
  });
  it('keeps unknown retirement pending and never replaces it with a new scan', async () => {
    const runtime = createAntivirusRuntime(configuration());
    await runtime.initialise(AbortSignal.timeout(2000));
    const session = await runtime.prepare(subject(), new Date(Date.now() + 50_000).toISOString());
    retireKnown = false;
    expect(await session.retire()).toMatchObject({
      state: 'unknown',
      originalProcessJoined: false,
      ownedTransientDataRemoved: false,
    });
    await expect(
      runtime.prepare(subject(), new Date(Date.now() + 50_000).toISOString()),
    ).rejects.toThrow();
    expect(originals).toHaveLength(2);
    expect(await runtime.drain()).toEqual({ complete: false });
    retireKnown = true;
    await session.retire();
    expect(await runtime.drain()).toEqual({ complete: true });
  });
  it('retains an unconfirmed startup-original retirement as an owned pending obligation', async () => {
    retireKnown = false;
    const runtime = createAntivirusRuntime(configuration());
    await expect(runtime.initialise(AbortSignal.timeout(2000))).rejects.toThrow();
    expect(runtime.available()).toBe(false);
    expect(runtime.pending()).toBeGreaterThan(0);
    expect(await runtime.drain()).toEqual({ complete: false });
    retireKnown = true;
    expect(await runtime.drain()).toEqual({ complete: true });
  });
  it('caps the original deadline at configured signature freshness and rejects stale/future metadata', () => {
    const config = configuration();
    const runtime = createAntivirusRuntime({ ...config, signatureMaxAgeMs: 30_000 });
    expect(Date.parse(runtime.deadline(new Date(Date.now() + 60_000).toISOString()))).toBe(
      Date.parse(config.generation.dailyPublishedAt) + 30_000,
    );
    for (const published of [
      new Date(Date.now() + 1000).toISOString(),
      new Date(Date.now() - 86_400_001).toISOString(),
    ])
      expect(() =>
        createAntivirusRuntime({
          ...config,
          generation: { ...config.generation, dailyPublishedAt: published },
        }),
      ).toThrow();
  });
  it('loads only fixed Root-published metadata paths and rejects extra generation fields', () => {
    const config = configuration();
    (readAntivirusImmutableAsset as jest.Mock).mockImplementation((asset: { path: string }) =>
      Buffer.from(
        JSON.stringify(asset.path.endsWith('profile.json') ? config.process : config.generation),
      ),
    );
    const input = {
      profileSha256: 'a'.repeat(64),
      generationSha256: 'b'.repeat(64),
      signatureMaxAgeMs: 86_400_000,
      ...config.identity,
    };
    expect(readAntivirusConfiguration(input).generation).toEqual(config.generation);
    expect(
      (readAntivirusImmutableAsset as jest.Mock).mock.calls.map((call) => call[0].path),
    ).toEqual([
      '/etc/cortex-document-antivirus/profile.json',
      '/etc/cortex-document-antivirus/generation.json',
    ]);
    (readAntivirusImmutableAsset as jest.Mock).mockReturnValue(
      Buffer.from(JSON.stringify({ ...config.generation, loaded: true })),
    );
    expect(() => readAntivirusConfiguration(input)).toThrow();
  });
});
