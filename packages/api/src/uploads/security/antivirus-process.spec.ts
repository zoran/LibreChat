/** Real inert Node children exercise one permit, terminal evidence and joined retirement; never AV qualification. */
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import childProcess from 'node:child_process';
import type { AntivirusProcessProfile } from './antivirus-process';
import { antivirusStartupFailure, createAntivirusProcessEvents } from './antivirus-process-events';
import { createAntivirusProcessOwner, createAntivirusRetirement } from './antivirus-process';
import { createAntivirusProcessPolicy } from './antivirus-policy';

type InertOriginal = {
  child: ReturnType<typeof spawn>;
  events: ReturnType<typeof createAntivirusProcessEvents>;
  report: Promise<string>;
};
const children: InertOriginal[] = [];
function launch(script: string, duration = 12_000): InertOriginal {
  const child = spawn(process.execPath, ['-e', script], {
    shell: false,
    detached: false,
    env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  const events = createAntivirusProcessEvents(
    child,
    Date.now() + duration,
    performance.now() + duration,
  );
  const report = new Promise<string>((resolve) => {
    child.stdout?.once('data', (bytes: Buffer) => resolve(bytes.toString('ascii')));
  });
  child.stdout?.resume();
  child.stderr?.on('data', (bytes: Buffer) => bytes.fill(0));
  const result = { child, events, report };
  children.push(result);
  return result;
}
afterEach(async () => {
  for (const { child, events } of children.splice(0)) {
    if (!events.state().closed) child.kill('SIGTERM');
    await events.joined;
  }
});

it('binds the real producer argv to its actual parent PID before permitting the same inert child', async () => {
  // Model only immutable image/kernel observations; the producer, PID and child custody stay real.
  const actual = { ...fs },
    actualSpawn = childProcess.spawn,
    hash = (body: string | Buffer) => crypto.createHash('sha256').update(body).digest('hex');
  const root = actual.mkdtempSync(join(tmpdir(), 'av-parent-contract-'));
  const transient = '/run/cortex-document-security/av';
  actual.mkdirSync(join(root, 'owned'), { mode: 0o700 });
  actual.mkdirSync(join(root, 'generation'));
  const paths = new Map<string, string>();
  const asset = (
    path: string,
    body: string | Buffer,
    physical = join(root, 'asset-' + paths.size),
  ) => {
    actual.writeFileSync(physical, body, { mode: 0o400 });
    paths.set(path, physical);
    return { path, sha256: hash(body) };
  };
  const generation = ['bytecode.cvd', 'daily.cvd', 'main.cvd'].map((name) => ({
    name,
    sha256: hash(name),
  }));
  const signatureManifestSha256 = hash(JSON.stringify(generation));
  const signatureDirectory = '/var/lib/cortex-av-signatures/generations/' + signatureManifestSha256;
  const program = asset('/usr/local/sbin/clamd', 'inert ClamD image stand-in');
  program.sha256 = '03a1bea28cba1cf7dd5aec447e2317c61bac188e3057e342d09119a34d277839';
  const profile: AntivirusProcessProfile = {
    schema: 1,
    purpose: 'clamd-local-v1',
    image: 'registry.invalid/av@sha256:' + 'a'.repeat(64),
    packageSha256: 'd3ee9e401974855a1edc1761b1425417d126de618d5f0c91cd51209f69f6fcc2',
    program,
    loader: asset('/lib/av-contract-loader', 'loader'),
    setpriv: asset('/usr/bin/setpriv', 'setpriv'),
    scopeHelper: asset('/app/packages/api/dist/uploads/security/native/antivirus-scope', 'scope'),
    filter: asset(
      '/etc/cortex-document-security/antivirus-profile.bpf',
      createAntivirusProcessPolicy(),
    ),
    libraries: [],
    signatureDirectory,
    signatures: generation.map(({ name }) =>
      asset(signatureDirectory + '/' + name, name, join(root, 'generation', name)),
    ),
    signatureManifestSha256,
    transientRoot: transient,
    memoryMaxBytes: 4294967296,
  };
  const owner = createAntivirusProcessOwner(profile);
  const mapped = (path: fs.PathLike) => {
    const logical = String(path);
    if (logical === signatureDirectory) return join(root, 'generation');
    if (logical === transient || logical.startsWith(transient + '/'))
      return join(root, 'owned', logical.slice(transient.length));
    return paths.get(logical) ?? logical;
  };
  const assetFds = new Set<number>();
  let child: ReturnType<typeof spawn> | undefined,
    joined: Promise<void> | undefined,
    report: Promise<string> | undefined;
  try {
    const gid = process.getgid!(),
      uid = process.getuid!();
    const observations = new Map([
      [
        '/proc/self/status',
        [
          `Uid: ${uid} ${uid} ${uid} ${uid}`,
          `Gid: ${gid} ${gid} ${gid} ${gid}`,
          ...['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].map(
            (k) => k + ': 0000000000000000',
          ),
        ].join('\n'),
      ],
      ['/proc/self/limits', 'Max core file size 0 0 bytes'],
      ['/proc/sys/kernel/core_pattern', 'core'],
      ['/proc/self/cgroup', '0::/av-parent-contract'],
      ['/sys/fs/cgroup/av-parent-contract/pids.max', '64'],
      ['/sys/fs/cgroup/av-parent-contract/memory.max', '4294967296'],
      ['/sys/fs/cgroup/av-parent-contract/cpu.max', '200000 100000'],
      ['/proc/self/mountinfo', '1 0 0:1 / / ro - overlay overlay ro'],
    ]);
    jest.spyOn(process, 'getgroups').mockReturnValue([gid]);
    jest
      .spyOn(fs, 'readFileSync')
      .mockImplementation(
        (path, options) => observations.get(String(path)) ?? actual.readFileSync(path, options),
      );
    jest.spyOn(fs, 'realpathSync').mockImplementation((path) => String(path));
    jest.spyOn(fs, 'lstatSync').mockImplementation((path) => {
      const logical = String(path);
      if (logical === transient || logical.startsWith(transient + '/'))
        return actual.lstatSync(mapped(path));
      return Object.assign(actual.lstatSync(paths.get(logical) ?? root), {
        uid: 0,
        gid: 0,
        mode: paths.has(logical) ? 0o100400 : 0o40755,
      });
    });
    jest.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
      const fd = actual.openSync(mapped(path), flags, mode);
      assetFds.add(fd);
      return fd;
    });
    jest
      .spyOn(fs, 'fstatSync')
      .mockImplementation((fd) =>
        Object.assign(actual.fstatSync(fd), assetFds.has(fd) ? { uid: 0, gid: 0 } : {}),
      );
    jest
      .spyOn(fs, 'statfsSync')
      .mockImplementation(() => Object.assign(actual.statfsSync(root), { type: 0x01021994 }));
    jest
      .spyOn(fs, 'mkdirSync')
      .mockImplementation((path, options) => actual.mkdirSync(mapped(path), options));
    jest
      .spyOn(fs, 'writeFileSync')
      .mockImplementation((path, data, options) =>
        actual.writeFileSync(typeof path === 'number' ? path : mapped(path), data, options),
      );
    jest
      .spyOn(fs, 'readdirSync')
      .mockImplementation((path, options) => actual.readdirSync(mapped(path), options));
    jest.spyOn(fs, 'unlinkSync').mockImplementation((path) => actual.unlinkSync(mapped(path)));
    jest.spyOn(fs, 'rmdirSync').mockImplementation((path) => actual.rmdirSync(mapped(path)));
    // Only the external pinned ClamD bytes are substituted; all remaining hashes use SHA-256.
    jest
      .spyOn(crypto, 'createHash')
      .mockReturnValueOnce(
        Object.assign(crypto.createHash('sha256'), { digest: () => program.sha256 }),
      );
    const nativeSpawn = jest
      .spyOn(childProcess, 'spawn')
      .mockImplementation((_command, args, options) => {
        child = actualSpawn(
          process.execPath,
          [
            '-e',
            `
        const fs = require('node:fs'), byte = Buffer.alloc(1);
        const [permit, parent, command] = process.argv.slice(1, 4);
        if (permit !== '--permit-fd=3' || parent !== '--parent-pid=' + process.ppid || command !== '/usr/bin/setpriv') process.exit(77);
        const count = fs.readSync(3, byte, 0, 1, null);
        fs.closeSync(3);
        fs.writeSync(1, JSON.stringify({ parent: process.ppid, count, permit: byte.toString('ascii') }));
            setInterval(() => {}, 1000);
      `,
            '--',
            ...args,
          ],
          { ...options, cwd: mapped(options.cwd ?? root) },
        );
        joined = new Promise<void>((resolve) => child!.once('close', () => resolve()));
        report = new Promise<string>((resolve) =>
          child!.stdout!.once('data', (b: Buffer) => resolve(b.toString('ascii'))),
        );
        return child;
      });
    const original = await owner.start(Date.now() + 30_000);
    expect(nativeSpawn).toHaveBeenCalledTimes(1);
    expect(nativeSpawn.mock.calls[0][0]).toBe(profile.scopeHelper.path);
    expect(nativeSpawn.mock.calls[0][1].slice(0, 3)).toEqual([
      '--permit-fd=3',
      `--parent-pid=${process.pid}`,
      '/usr/bin/setpriv',
    ]);
    expect(original?.custody.pid).toBe(child?.pid);
    if (!original) throw new Error('Actual producer did not retain its inert original');
    expect(await original.activate()).toBe(true);
    expect(JSON.parse(await report!)).toEqual({ parent: process.pid, count: 1, permit: 'G' });
    expect(await original.retire()).toEqual({
      originalProcessJoined: true,
      ownedTransientDataRemoved: true,
    });
    await joined;
    expect(actual.readdirSync(join(root, 'owned'))).toEqual([]);
    expect(nativeSpawn).toHaveBeenCalledTimes(1);
  } finally {
    await owner.drain();
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await joined;
    jest.restoreAllMocks();
    actual.rmSync(root, { recursive: true, force: true });
  }
});

it('retains the actual pre-permit exit and refuses a later dispatch without a replacement child', async () => {
  const { child, events } = launch('process.exit(77)');
  const pid = child.pid;
  await events.joined;
  expect(await events.activate()).toBe(false);
  expect(child.pid).toBe(pid);
  const facts = JSON.parse(antivirusStartupFailure(events.failure())!);
  expect(['permit-closed', 'child-exit']).toContain(facts.stage);
  expect(facts).toMatchObject({
    exitCode: 77,
    signal: null,
    exited: true,
    closed: true,
  });
});

it('handles the real EPIPE between queued permit and early peer close without an unhandled error', async () => {
  const { child, events, report } = launch(`
    const fs = require('node:fs');
    fs.closeSync(3);
    fs.writeSync(1, 'closed');
    setTimeout(() => process.exit(77), 250);
  `);
  const pipe = child.stdio[3];
  if (!pipe || !('cork' in pipe)) throw new Error('Missing actual control channel');
  pipe.cork();
  const activated = events.activate();
  expect(await report).toBe('closed');
  pipe.uncork();
  expect(await activated).toBe(false);
  await events.joined;
  expect(JSON.parse(antivirusStartupFailure(events.failure())!)).toMatchObject({
    permitCode: 'EPIPE',
    exitCode: 77,
    exited: true,
    closed: true,
  });
  expect(await events.activate()).toBe(false);
});

it('dispatches one G when the child reads it, immediately closes FD3 and stays alive for post-gate work', async () => {
  const { events, report } = launch(`
    const fs = require('node:fs'), byte = Buffer.alloc(1);
    const count = fs.readSync(3, byte, 0, 1, null);
    fs.closeSync(3);
    fs.writeSync(1, count + ':' + byte.toString('ascii'));
    setTimeout(() => process.exit(0), 300);
  `);
  expect(await events.activate()).toBe(true);
  expect(await report).toBe('1:G');
  expect(events.state()).toEqual({ exited: false, closed: false });
  expect(events.failure()).toBeNull();
  expect(await events.activate()).toBe(false);
  await events.joined;
  // Dispatch is not a claim that a long-lived engine became ready.
  expect(JSON.parse(antivirusStartupFailure(events.failure())!)).toMatchObject({
    stage: 'child-exit',
    exitCode: 0,
    closed: true,
  });
});

it('retains post-G failure and uses actual single-flight same-child retirement', async () => {
  const { child, events, report } = launch(`
    const fs = require('node:fs'), byte = Buffer.alloc(1);
    fs.readSync(3, byte, 0, 1, null);
    fs.closeSync(3);
    fs.writeSync(1, byte.toString('ascii'));
    setTimeout(() => process.exit(78), 150);
  `);
  const pid = child.pid;
  expect(await events.activate()).toBe(true);
  expect(await report).toBe('G');
  await events.joined;
  let stops = 0,
    cleanups = 0;
  const retire = createAntivirusRetirement({
    async stop() {
      stops++;
      await events.joined;
    },
    state: events.state,
    cleanup() {
      cleanups++;
      return true;
    },
  });
  const a = retire(),
    b = retire();
  expect(a).toBe(b);
  expect(await a).toEqual({ originalProcessJoined: true, ownedTransientDataRemoved: true });
  expect(await retire()).toEqual(await a);
  expect(child.pid).toBe(pid);
  expect(stops).toBe(1);
  expect(cleanups).toBe(1);
  expect(JSON.parse(antivirusStartupFailure(events.failure())!)).toMatchObject({
    stage: 'child-exit',
    exitCode: 78,
    signal: null,
    exited: true,
    closed: true,
  });
});

it('records actual spawn failure and closes its streams without claiming an exited process', async () => {
  const child = spawn('/nonexistent-cortex-av-inert-child', [], {
    env: {},
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  const events = createAntivirusProcessEvents(
    child,
    Date.now() + 12_000,
    performance.now() + 12_000,
  );
  const report = Promise.resolve('');
  children.push({ child, events, report });
  expect(await events.activate()).toBe(false);
  await events.joined;
  expect(JSON.parse(antivirusStartupFailure(events.failure())!)).toMatchObject({
    stage: 'spawn-error',
    spawnCode: 'ENOENT',
    exited: false,
    closed: true,
  });
});

it('keeps the original deadline and preserves terminal signal through joined cleanup', async () => {
  const { child, events } = launch('setInterval(() => {}, 100)', 10_000);
  expect(await events.activate()).toBe(false);
  child.kill('SIGTERM');
  await events.joined;
  expect(JSON.parse(antivirusStartupFailure(events.failure())!)).toMatchObject({
    stage: 'permit-timeout',
    signal: 'SIGTERM',
    closed: true,
  });
  expect(antivirusStartupFailure(new Error('untrusted stderr/argv/config'))).toBeNull();
});
