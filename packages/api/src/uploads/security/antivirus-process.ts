/** antivirus-process.ts owns one pinned original ClamD child and its private transient retirement; never an AV approval. */
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  readFileSync,
  lstatSync,
  realpathSync,
  mkdirSync,
  statfsSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  rmdirSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { createAntivirusProcessEvents } from './antivirus-process-events';
import { createAntivirusProcessPolicy } from './antivirus-policy';
/** One immutable image asset; caller JSON never chooses a process or read scope. */
export type AntivirusAsset = Readonly<{ path: string; sha256: string }>;
/** Existing deployment owner binds this closed profile to its actual image and signature-generation receipt. */
export type AntivirusProcessProfile = Readonly<{
  schema: 1;
  purpose: 'clamd-local-v1';
  image: string;
  packageSha256: string;
  program: AntivirusAsset;
  loader: AntivirusAsset;
  setpriv: AntivirusAsset;
  scopeHelper: AntivirusAsset;
  filter: AntivirusAsset;
  libraries: readonly AntivirusAsset[];
  signatureDirectory: string;
  signatures: readonly AntivirusAsset[];
  signatureManifestSha256: string;
  transientRoot: '/run/cortex-document-security/av';
  memoryMaxBytes: 4294967296;
}>;
const PROGRAM = '03a1bea28cba1cf7dd5aec447e2317c61bac188e3057e342d09119a34d277839';
const PACKAGE = 'd3ee9e401974855a1edc1761b1425417d126de618d5f0c91cd51209f69f6fcc2';
const invalidPathCharacter = (value: string): boolean =>
  Array.from(value).some(
    (character) => character.charCodeAt(0) <= 32 || character === ',' || character === ':',
  );
const sha = (v: string) => /^[a-f0-9]{64}$/.test(v);
const digest = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
function bytesAt(fd: number): Buffer {
  const size = fstatSync(fd).size;
  if (size > 256 * 1024 * 1024) throw new Error('AV asset bound');
  const b = Buffer.alloc(size);
  let n = 0;
  while (n < size) {
    const k = readSync(fd, b, n, size - n, n);
    if (!k) throw new Error('AV asset truncated');
    n += k;
  }
  return b;
}
/** Pure comparisons; production inputs are fixed-path kernel observations, never caller readiness. */
export function antivirusGroupsAllowed(primary: number, groups: readonly number[]): boolean {
  return (
    Number.isInteger(primary) &&
    primary > 0 &&
    Array.isArray(groups) &&
    groups.length <= 64 &&
    groups.every((g) => Number.isInteger(g) && g === primary)
  );
}
export function antivirusReadonlyMount(path: string, mountinfo: string): boolean {
  let best = -1,
    ro = false;
  for (const line of mountinfo.split('\n')) {
    const f = line.split(' ');
    if (f.length < 10 || !line.includes(' - ')) continue;
    const mount = f[4].replace(/\\([0-7]{3})/g, (_, v: string) =>
      String.fromCharCode(parseInt(v, 8)),
    );
    if (
      (path === mount || path.startsWith(mount === '/' ? '/' : mount + '/')) &&
      mount.length > best
    ) {
      best = mount.length;
      ro = f[5].split(',').includes('ro');
    }
  }
  return best >= 0 && ro;
}
type AssetIdentity = Pick<
  Stats,
  'dev' | 'ino' | 'uid' | 'gid' | 'mode' | 'size' | 'mtimeMs' | 'ctimeMs'
>;
export function assertAntivirusAssetIdentity(a: AssetIdentity, b: AssetIdentity): void {
  for (const k of ['dev', 'ino', 'uid', 'gid', 'mode', 'size', 'mtimeMs', 'ctimeMs'] as const)
    if (a[k] !== b[k]) throw new Error('AV asset changed');
}
function immutablePath(path: string): void {
  if (
    realpathSync(path) !== path ||
    !antivirusReadonlyMount(path, readFileSync('/proc/self/mountinfo', 'utf8'))
  )
    throw new Error('AV immutable mount refused');
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const s = lstatSync(parent);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 || s.mode & 0o022)
      throw new Error('AV asset ancestor refused');
    if (parent === '/') break;
  }
}
function file(asset: AntivirusAsset): number {
  if (!asset.path.startsWith('/') || invalidPathCharacter(asset.path) || !sha(asset.sha256))
    throw new Error('AV asset refused');
  immutablePath(asset.path);
  const fd = openSync(asset.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (
      !s.isFile() ||
      s.uid !== 0 ||
      s.mode & 0o022 ||
      s.nlink !== 1 ||
      digest(bytesAt(fd)) !== asset.sha256
    )
      throw new Error('AV asset refused');
    assertAntivirusAssetIdentity(s, fstatSync(fd));
    assertAntivirusAssetIdentity(s, lstatSync(asset.path));
    return fd;
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}
/** Trusted startup reads only actual root-owned readonly pinned metadata through the same file guard. */
export function readAntivirusImmutableAsset(asset: AntivirusAsset): Buffer {
  const fd = file(asset);
  try {
    return bytesAt(fd);
  } finally {
    closeSync(fd);
  }
}
/** Stop once, reobserve the same original, retry bounded cleanup, cache only terminal success. */
export function createAntivirusRetirement(
  h: Readonly<{
    stop: () => Promise<void>;
    state: () => Readonly<{ exited: boolean; closed: boolean }>;
    cleanup: () => boolean;
  }>,
): () => Promise<Readonly<{ originalProcessJoined: boolean; ownedTransientDataRemoved: boolean }>> {
  let stop: Promise<void> | undefined,
    flight:
      | Promise<Readonly<{ originalProcessJoined: boolean; ownedTransientDataRemoved: boolean }>>
      | undefined,
    terminal:
      | Readonly<{ originalProcessJoined: boolean; ownedTransientDataRemoved: boolean }>
      | undefined;
  return () => {
    if (terminal) return Promise.resolve(terminal);
    if (flight) return flight;
    flight = (async () => {
      stop ??= Promise.resolve().then(h.stop);
      await stop;
      const s = h.state();
      let removed = false;
      if (s.exited && s.closed) {
        try {
          removed = h.cleanup();
        } catch {
          // Cleanup uncertainty stays false and prevents a retired receipt.
        }
      }
      const result = Object.freeze({
        originalProcessJoined: s.exited && s.closed,
        ownedTransientDataRemoved: removed,
      });
      if (result.originalProcessJoined && removed) terminal = result;
      return result;
    })().finally(() => {
      flight = undefined;
    });
    return flight;
  };
}
/** Actual kernel facts only; this is not an injected readiness or resource-allocation assertion. */
export function antivirusProcessGate(): boolean {
  try {
    const s = readFileSync('/proc/self/status', 'utf8'),
      limits = readFileSync('/proc/self/limits', 'utf8');
    if (
      !process.getuid?.() ||
      !process.getgid?.() ||
      !process.getgroups ||
      !antivirusGroupsAllowed(process.getgid(), process.getgroups())
    )
      return false;
    for (const key of ['Uid', 'Gid']) {
      const m = s.match(
        new RegExp('^' + key + ':[ \\t]+([1-9][0-9]*)[ \\t]+\\1[ \\t]+\\1[ \\t]+\\1[ \\t]*$', 'm'),
      );
      if (!m) return false;
    }
    for (const key of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'])
      if (!new RegExp('^' + key + ':[ \\t]+0{16}$', 'm').test(s)) return false;
    if (!/^Max core file size[ \t]+0[ \t]+0[ \t]+bytes[ \t]*$/m.test(limits)) return false;
    const pattern = readFileSync('/proc/sys/kernel/core_pattern', 'utf8').trim();
    if (pattern !== '' && pattern !== 'core') return false;
    const cg = readFileSync('/proc/self/cgroup', 'utf8').trim();
    if (!/^0::\/[A-Za-z0-9_./-]*$/.test(cg) || cg.includes('..')) return false;
    const root = '/sys/fs/cgroup' + cg.slice(3);
    const pids = Number(readFileSync(join(root, 'pids.max'), 'utf8').trim());
    return (
      readFileSync(join(root, 'memory.max'), 'utf8').trim() === '4294967296' &&
      Number.isInteger(pids) &&
      pids > 0 &&
      pids <= 64 &&
      readFileSync(join(root, 'cpu.max'), 'utf8').trim() === '200000 100000'
    );
  } catch {
    return false;
  }
}
/** Original native custody is returned without any loaded-database or malware-clean claim. */
export type AntivirusOriginal = Readonly<{
  custody: Readonly<{
    id: string;
    pid: number;
    start: string;
    boot: string;
    configurationSha256: string;
    signatureManifestSha256: string;
  }>;
  socket(): Readonly<{ path: string; device: number; inode: number; uid: number }> | null;
  /** Existing repository owner calls this ONCE only after durable original-custody binding. */
  activate(): Promise<boolean>;
  /** Closed same-original terminal facts only; no caller or child output enters this error. */
  failure(): Error | null;
  retire(): Promise<
    Readonly<{ originalProcessJoined: boolean; ownedTransientDataRemoved: boolean }>
  >;
}>;
function removeOwned(path: string, uid: number, state = { visited: 0 }, depth = 0): void {
  if (++state.visited > 1024 || depth > 16) throw new Error('AV cleanup bound');
  const s = lstatSync(path);
  if (s.isSymbolicLink() || s.uid !== uid) throw new Error('AV cleanup uncertain');
  if (s.isDirectory()) {
    for (const n of readdirSync(path)) removeOwned(join(path, n), uid, state, depth + 1);
    rmdirSync(path);
  } else {
    if (!s.isFile() && !s.isSocket()) throw new Error('AV cleanup uncertain');
    if (s.isFile() && s.nlink !== 1) throw new Error('AV cleanup uncertain');
    unlinkSync(path);
  }
}
/** Build fixed ClamD config from server-owned paths; no Include/VirusEvent/TCP/direct filename scan port. */
export function antivirusConfiguration(directory: string, socket: string, tmp: string): string {
  if (
    [directory, socket, tmp].some(
      (p) => !p.startsWith('/') || invalidPathCharacter(p) || p.includes('..'),
    )
  )
    throw new Error('AV paths refused');
  return `Foreground yes\nLocalSocket ${socket}\nLocalSocketMode 600\nFixStaleSocket no\nDatabaseDirectory ${directory}\nTemporaryDirectory ${tmp}\nOfficialDatabaseOnly yes\nMaxThreads 1\nMaxQueue 2\nStreamMaxLength 30M\nMaxScanTime 20000\nMaxScanSize 64M\nMaxFileSize 30M\nMaxRecursion 8\nMaxFiles 128\nAlertExceedsMax yes\nAlertEncrypted yes\nConcurrentDatabaseReload no\nLeaveTemporaryFiles no\nGenerateMetadataJson no\nForceToDisk no\nDisableCache yes\nLogClean no\nExtendedDetectionInfo no\n`;
}
/** Start is closed until actual rootless4Gi kernel admission; exact profile/source adoption stays with deployment. */
export interface AntivirusProcessOwner {
  drain(): Promise<
    Readonly<{ originalProcessJoined: boolean; ownedTransientDataRemoved: boolean }>
  >;
  start(originalDeadlineAtMs: number): Promise<AntivirusOriginal | null>;
}
export function createAntivirusProcessOwner(
  profile: AntivirusProcessProfile,
): AntivirusProcessOwner {
  if (
    process.platform !== 'linux' ||
    process.arch !== 'x64' ||
    profile.schema !== 1 ||
    profile.purpose !== 'clamd-local-v1' ||
    profile.packageSha256 !== PACKAGE ||
    profile.program.path !== '/usr/local/sbin/clamd' ||
    profile.program.sha256 !== PROGRAM ||
    profile.setpriv.path !== '/usr/bin/setpriv' ||
    profile.scopeHelper.path !== '/app/packages/api/dist/uploads/security/native/antivirus-scope' ||
    profile.filter.path !== '/etc/cortex-document-security/antivirus-profile.bpf' ||
    profile.transientRoot !== '/run/cortex-document-security/av' ||
    profile.memoryMaxBytes !== 4294967296 ||
    !/^[A-Za-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(profile.image) ||
    !sha(profile.signatureManifestSha256) ||
    profile.signatureDirectory !==
      '/var/lib/cortex-av-signatures/generations/' + profile.signatureManifestSha256 ||
    !['/usr/lib/', '/lib/', '/lib64/'].some((x) => profile.loader.path.startsWith(x)) ||
    profile.libraries.length > 256 ||
    profile.signatures.length !== 3
  )
    throw new Error('AV profile refused');
  const expectedKeys = [
    'schema',
    'purpose',
    'image',
    'packageSha256',
    'program',
    'loader',
    'setpriv',
    'scopeHelper',
    'filter',
    'libraries',
    'signatureDirectory',
    'signatures',
    'signatureManifestSha256',
    'transientRoot',
    'memoryMaxBytes',
  ];
  if (Object.keys(profile).sort().join() !== expectedKeys.sort().join())
    throw new Error('AV closed profile refused');
  const names = profile.signatures.map((a) => a.path.split('/').pop()!);
  if (
    !['main', 'daily', 'bytecode'].every(
      (n) => names.filter((x) => x === n + '.cvd' || x === n + '.cld').length === 1,
    )
  )
    throw new Error('AV complete database generation refused');
  const generation = profile.signatures
    .map((a) => ({ name: a.path.split('/').pop(), sha256: a.sha256 }))
    .sort((a, b) => a.name!.localeCompare(b.name!));
  if (digest(JSON.stringify(generation)) !== profile.signatureManifestSha256)
    throw new Error('AV signature manifest refused');
  const p = structuredClone(profile);
  let busy = false;
  let currentBirth: ReturnType<typeof spawn> | undefined;
  let currentJoined: Promise<void> | undefined;
  let currentClosed = true;
  let retireCurrent: AntivirusOriginal['retire'] | undefined;
  return Object.freeze({
    async drain() {
      if (retireCurrent) return retireCurrent();
      if (currentBirth && !currentClosed) {
        currentBirth.stdio[3]?.destroy();
        if (currentJoined)
          await Promise.race([currentJoined, new Promise((r) => setTimeout(r, 10000))]);
      }
      return Object.freeze({
        originalProcessJoined: currentClosed,
        ownedTransientDataRemoved: !busy,
      });
    },
    async start(originalDeadlineAtMs: number): Promise<AntivirusOriginal | null> {
      if (
        busy ||
        !Number.isSafeInteger(originalDeadlineAtMs) ||
        originalDeadlineAtMs - Date.now() <= 10000 ||
        originalDeadlineAtMs - Date.now() > 60000 ||
        !antivirusProcessGate()
      )
        return null;
      const monoEnd = performance.now() + originalDeadlineAtMs - Date.now();
      retireCurrent = undefined;
      currentBirth = undefined;
      currentJoined = undefined;
      currentClosed = true;
      busy = true;
      const fds: number[] = [];
      let directory: string | undefined;
      let birth: ReturnType<typeof spawn> | undefined;
      let birthClosed = false;
      let birthJoined: Promise<void> | undefined;
      let lifecycle: ReturnType<typeof createAntivirusProcessEvents> | undefined;
      try {
        for (const a of [
          p.program,
          p.setpriv,
          p.scopeHelper,
          p.filter,
          p.loader,
          ...p.libraries,
          ...p.signatures,
        ]) {
          if (p.signatures.includes(a) && !a.path.startsWith(p.signatureDirectory + '/'))
            throw new Error('AV signature scope refused');
          if (
            p.libraries.includes(a) &&
            !['/usr/lib/', '/usr/local/lib/', '/lib/'].some((x) => a.path.startsWith(x)) &&
            a.path !== '/etc/ld.so.cache'
          )
            throw new Error('AV library scope refused');
          fds.push(file(a));
        }
        const signatureNames = p.signatures
          .map((a) => a.path.slice(p.signatureDirectory.length + 1))
          .sort();
        const generationDir = lstatSync(p.signatureDirectory);
        immutablePath(p.signatureDirectory);
        if (
          !generationDir.isDirectory() ||
          generationDir.isSymbolicLink() ||
          generationDir.uid !== 0 ||
          generationDir.mode & 0o022 ||
          JSON.stringify(readdirSync(p.signatureDirectory).sort()) !==
            JSON.stringify(signatureNames)
        )
          throw new Error('AV generation changed');
        const filterFd = fds[3];
        if (!bytesAt(filterFd).equals(createAntivirusProcessPolicy()))
          throw new Error('AV policy bytes refused');
        const root = lstatSync(p.transientRoot);
        if (statfsSync(p.transientRoot).type !== 0x01021994)
          throw new Error('AV requires owned tmpfs');
        if (
          !root.isDirectory() ||
          root.isSymbolicLink() ||
          root.uid !== process.getuid?.() ||
          root.mode & 0o077
        )
          throw new Error('AV transient root refused');
        const id = randomUUID();
        directory = join(p.transientRoot, id);
        mkdirSync(directory, { mode: 0o700 });
        const tmp = join(directory, 'tmp');
        mkdirSync(tmp, { mode: 0o700 });
        const socket = join(directory, 'clamd.sock'),
          config = join(directory, 'clamd.conf');
        const configuration = antivirusConfiguration(p.signatureDirectory, socket, tmp);
        writeFileSync(config, configuration, { mode: 0o400, flag: 'wx' });
        const anchor = lstatSync(directory);
        const args = [
          '--permit-fd=3',
          '/usr/bin/setpriv',
          '--no-new-privs',
          '--inh-caps=-all',
          '--ambient-caps=-all',
          '--pdeathsig',
          'keep',
          '--seccomp-filter',
          '/proc/self/fd/4',
          '--landlock-access',
          'fs',
        ];
        const rule = (access: string, path: string) =>
          args.push('--landlock-rule', `path-beneath:${access}:${path}`);
        rule('read-file,execute', p.program.path);
        rule('read-file,execute', p.loader.path);
        for (const a of p.libraries) rule('read-file', a.path);
        for (const a of p.signatures) rule('read-file', a.path);
        rule('read-dir', p.signatureDirectory);
        rule('read-file', config);
        rule(
          'read-file,write-file,read-dir,remove-dir,remove-file,make-dir,make-reg,make-sock,truncate',
          directory,
        );
        args.push('--', p.program.path, '--foreground', '--config-file', config);
        [
          p.program,
          p.setpriv,
          p.scopeHelper,
          p.filter,
          p.loader,
          ...p.libraries,
          ...p.signatures,
        ].forEach((a, i) => {
          immutablePath(a.path);
          assertAntivirusAssetIdentity(fstatSync(fds[i]), lstatSync(a.path));
        });
        const child = spawn(p.scopeHelper.path, args, {
          cwd: directory,
          env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
          shell: false,
          detached: false,
          stdio: ['ignore', 'pipe', 'pipe', 'pipe', filterFd],
        });
        const events = createAntivirusProcessEvents(child, originalDeadlineAtMs, monoEnd);
        lifecycle = events;
        birth = child;
        currentBirth = child;
        currentClosed = false;
        const joined = events.joined.then(() => {
          birthClosed = true;
          currentClosed = true;
        });
        birthJoined = joined;
        currentJoined = joined;
        for (const stream of [child.stdout, child.stderr])
          stream?.on('data', (b: Buffer) => b.fill(0));
        const pending: {
          custody?: AntivirusOriginal['custody'];
          timer?: ReturnType<typeof setTimeout>;
        } = {};
        let stopping = false;
        const same = () => {
          const custody = pending.custody;
          try {
            return (
              !!custody &&
              readFileSync(`/proc/${custody.pid}/stat`, 'utf8')
                .split(') ')
                .pop()!
                .split(' ')[19] === custody.start
            );
          } catch {
            return false;
          }
        };
        const retire = createAntivirusRetirement({
          async stop() {
            stopping = true;
            if (pending.timer) clearTimeout(pending.timer);
            child.stdio[3]?.destroy();
            if (!events.state().exited && same()) child.kill('SIGTERM');
            await Promise.race([
              joined,
              new Promise((r) =>
                setTimeout(
                  r,
                  Math.max(
                    0,
                    Math.min(500, monoEnd - performance.now(), originalDeadlineAtMs - Date.now()),
                  ),
                ),
              ),
            ]);
            if (!events.state().closed && !events.state().exited && same()) child.kill('SIGKILL');
            await Promise.race([
              joined,
              new Promise((r) =>
                setTimeout(
                  r,
                  Math.max(
                    0,
                    Math.min(9500, monoEnd - performance.now(), originalDeadlineAtMs - Date.now()),
                  ),
                ),
              ),
            ]);
          },
          state() {
            const { exited, closed } = events.state();
            return { exited: exited || (!child.pid && closed), closed };
          },
          cleanup() {
            const a = lstatSync(directory!);
            if (a.dev !== anchor.dev || a.ino !== anchor.ino || a.isSymbolicLink()) return false;
            removeOwned(directory!, process.getuid!());
            return true;
          },
        });
        const reconcile = async () => {
          stopping = true;
          const result = await retire();
          if (retireCurrent === reconcile)
            busy = !(result.originalProcessJoined && result.ownedTransientDataRemoved);
          return result;
        };
        retireCurrent = reconcile;
        if (!child.pid) throw new Error('AV native launch uncertain');
        const stat = readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ').pop()!.split(' ');
        if (Number(stat[1]) !== process.pid) throw new Error('AV parent custody refused');
        const custody = Object.freeze({
          id,
          pid: child.pid,
          start: stat[19],
          boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
          configurationSha256: digest(configuration),
          signatureManifestSha256: p.signatureManifestSha256,
        });
        pending.custody = custody;
        pending.timer = setTimeout(
          () => {
            void reconcile().catch(() => {});
          },
          Math.max(
            1,
            Math.min(
              monoEnd - performance.now() - 10000,
              originalDeadlineAtMs - Date.now() - 10000,
            ),
          ),
        );
        return Object.freeze({
          custody,
          retire: reconcile,
          failure: events.failure,
          activate() {
            if (
              stopping ||
              performance.now() >= monoEnd - 10000 ||
              Date.now() >= originalDeadlineAtMs - 10000
            )
              return Promise.resolve(false);
            return events.activate();
          },
          socket() {
            if (
              stopping ||
              events.failure() ||
              events.state().closed ||
              events.state().exited ||
              performance.now() >= monoEnd - 10000 ||
              Date.now() >= originalDeadlineAtMs - 10000
            )
              return null;
            try {
              const s = lstatSync(socket);
              return s.isSocket() && s.uid === process.getuid?.() && (s.mode & 0o077) === 0
                ? Object.freeze({ path: socket, device: s.dev, inode: s.ino, uid: s.uid })
                : null;
            } catch {
              return null;
            }
          },
        });
      } catch {
        if (birth && retireCurrent) {
          try {
            await retireCurrent();
          } catch {
            busy = true;
          }
          const failure = lifecycle?.failure();
          if (failure) throw failure;
          return null;
        }
        if (birth) {
          birth.stdio[3]?.destroy();
          if (birthJoined)
            await Promise.race([birthJoined, new Promise((r) => setTimeout(r, 1000))]);
        }
        if (directory && (!birth || birthClosed)) {
          try {
            removeOwned(directory, process.getuid!());
          } catch {
            busy = true;
            return null;
          }
        }
        busy = !!birth && !birthClosed;
        return null;
      } finally {
        for (const fd of fds) closeSync(fd);
      }
    },
  });
}
