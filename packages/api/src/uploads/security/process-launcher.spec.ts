/** Native cases are explicitly opt-in; ordinary CI does not claim installed kernel qualification. */
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import childProcess from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import type { SecurityProcessProfile } from './process-launcher';
import {
  createSecurityProcessLauncher,
  securityProcessPreconditionsSatisfied,
  readCurrentSecurityProcessPreconditions,
} from './process-launcher';
import { createSecurityProcessPolicy } from './process-policy';
import { encodeSecurityProcessRequest } from './process-wire';

const request = encodeSecurityProcessRequest({
  mediaType: 'application/pdf',
  policy: { version: 1, markings: ['GEHEIM'], labels: ['Einstufung'] },
  bytes: Buffer.from('%PDF-1.4\nsynthetic launcher input only'),
});
const negative = { decision: 'uninspectable', reason: 'incomplete_coverage' };
const unavailable = {
  result: null,
  pages: 0,
  localCopiesRemoved: false,
  diagnostics: false,
  directChildStopped: false,
  transportComplete: false,
};
let root: string;
let profile: SecurityProcessProfile;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'security-launcher-')));
  const file = (name: string, value: string | Buffer) => {
    const path = join(root, name);
    writeFileSync(path, value, { mode: 0o400 });
    return path;
  };
  profile = {
    setpriv: realpathSync(process.execPath),
    node: realpathSync(process.execPath),
    entry: file('entry.cjs', ''),
    filter: file('policy.bpf', createSecurityProcessPolicy()),
    opensslConfig: file('empty.cnf', ''),
    canvasAddon: file('addon', ''),
    readFiles: [],
    executeFiles: [],
  };
  file('package.json', '{"type":"commonjs"}');
});
afterEach(() => {
  jest.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const safeStatus = [
  'Uid:\t1000\t1000\t1000\t1000',
  'Gid:\t1000\t1000\t1000\t1000',
  ...['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].map((name) => `${name}:\t0000000000000000`),
].join('\n');
const safeLimits = 'Max core file size        0                    0                    bytes\n';
describe('process preconditions', () => {
  it.each(['core\n', '\n', 'core', ''])(
    'accepts only safe synthetic process facts with pattern %j',
    (pattern) => {
      expect(securityProcessPreconditionsSatisfied(safeStatus, safeLimits, pattern)).toBe(true);
    },
  );
  it.each([
    safeStatus.replace('1000\t1000\t1000\t1000', '0\t0\t0\t0'),
    safeStatus.replace('1000\t1000\t1000\t1000', '1000\t1001\t1000\t1000'),
    safeStatus.replace('Gid:\t1000\t1000\t1000\t1000', 'Gid:\t0\t0\t0\t0'),
    safeStatus.replace('Gid:\t1000\t1000\t1000\t1000', 'Gid:\t1000\t1000\t1001\t1000'),
    safeStatus.replace('Uid:', 'Unknown:'),
    safeStatus + '\nUid:\t1000\t1000\t1000\t1000',
    safeStatus.replace('CapAmb:', 'Unknown:'),
    safeStatus + '\nCapEff:\t0000000000000000',
    safeStatus.replace('0000000000000000', 'not-hex'),
    'x'.repeat(16385),
    ...['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].map((name) =>
      safeStatus.replace(`${name}:\t0000000000000000`, `${name}:\t0000000000000001`),
    ),
  ])('rejects unsafe or unknown identity/capability facts %#', (status) => {
    expect(securityProcessPreconditionsSatisfied(status, safeLimits, 'core\n')).toBe(false);
  });
  it.each([
    '',
    safeLimits + safeLimits,
    safeLimits.replace(/0/g, 'unlimited'),
    safeLimits.replace('0', '1'),
    safeLimits.replace('bytes', 'unknown'),
  ])('rejects unknown or nonzero core limits %#', (limits) => {
    expect(securityProcessPreconditionsSatisfied(safeStatus, limits, 'core\n')).toBe(false);
  });
  it.each([
    '|/handler %p\n',
    '@/socket\n',
    'core.%p\n',
    '/tmp/core\n',
    ' core\n',
    'core\n\n',
    'core\r\n',
    'x'.repeat(257),
  ])('rejects nonordinary core pattern %#', (pattern) => {
    expect(securityProcessPreconditionsSatisfied(safeStatus, safeLimits, pattern)).toBe(false);
  });
  it('rereads fixed kernel facts on every run and rejects a changed prerequisite before another spawn', async () => {
    const contents = new Map([
      ['/proc/self/status', safeStatus],
      ['/proc/self/limits', safeLimits],
      ['/proc/sys/kernel/core_pattern', 'core\n'],
    ]);
    const files = new Map<string, string>();
    for (const [path, contentsText] of contents) {
      const fixture = join(root, `kernel-${files.size}`);
      writeFileSync(fixture, contentsText);
      files.set(path, fixture);
    }
    const actualOpen = fs.openSync;
    const opened = jest
      .spyOn(fs, 'openSync')
      .mockImplementation(((path, ...args) =>
        actualOpen(files.get(String(path)) ?? path, ...args)) as typeof fs.openSync);
    const spawn = jest.spyOn(childProcess, 'spawn').mockImplementation(() => {
      throw new Error('Synthetic spawn boundary only');
    });
    const launcher = createSecurityProcessLauncher(profile);
    await launcher.run({ request, signal: new AbortController().signal });
    expect(spawn).toHaveBeenCalledTimes(1);
    writeFileSync(files.get('/proc/sys/kernel/core_pattern')!, '|/synthetic-handler\n');
    expect(await launcher.run({ request, signal: new AbortController().signal })).toEqual(
      unavailable,
    );
    expect(spawn).toHaveBeenCalledTimes(1);
    for (const path of files.keys())
      expect(opened.mock.calls.filter((call) => call[0] === path)).toHaveLength(2);
  });
  it('fails closed on unreadable and overlarge kernel facts without spawning', async () => {
    const actualOpen = fs.openSync;
    const fixture = join(root, 'oversized-status');
    writeFileSync(fixture, 'x'.repeat(16385));
    const opened = jest.spyOn(fs, 'openSync').mockImplementation(((path, ...args) => {
      if (String(path) === '/proc/self/status') throw new Error('Synthetic denied read');
      return actualOpen(path, ...args);
    }) as typeof fs.openSync);
    const spawn = jest.spyOn(childProcess, 'spawn').mockImplementation(() => {
      throw new Error('Unexpected spawn');
    });
    const launcher = createSecurityProcessLauncher(profile);
    expect(await launcher.run({ request, signal: new AbortController().signal })).toEqual(
      unavailable,
    );
    opened.mockImplementation(((path, ...args) =>
      actualOpen(
        String(path) === '/proc/self/status' ? fixture : path,
        ...args,
      )) as typeof fs.openSync);
    expect(await launcher.run({ request, signal: new AbortController().signal })).toEqual(
      unavailable,
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('trusted security process launch boundary', () => {
  it.each(['relative', '/', '/proc/self/fd/0', '/tmp/../etc/passwd', 'https://host/file'])(
    'refuses noncanonical or non-file profiles: %s',
    (entry) => {
      expect(() => createSecurityProcessLauncher({ ...profile, entry })).toThrow();
    },
  );

  it('refuses symlinks and directory-wide asset grants', () => {
    symlinkSync(profile.entry, join(root, 'alias'));
    expect(() =>
      createSecurityProcessLauncher({ ...profile, entry: join(root, 'alias') }),
    ).toThrow();
    expect(() => createSecurityProcessLauncher({ ...profile, readFiles: [root] })).toThrow();
  });

  it.each(['filter', 'opensslConfig'] as const)(
    'refuses changed %s bytes before spawning',
    async (name) => {
      const launcher = createSecurityProcessLauncher(profile);
      const spawn = jest.spyOn(childProcess, 'spawn');
      chmodSync(profile[name], 0o600);
      writeFileSync(profile[name], 'changed');
      expect(await launcher.run({ request, signal: new AbortController().signal })).toEqual(
        unavailable,
      );
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it('refuses a replaced policy symlink after composition', async () => {
    const launcher = createSecurityProcessLauncher(profile);
    renameSync(profile.filter, join(root, 'original'));
    symlinkSync(join(root, 'original'), profile.filter);
    const spawn = jest.spyOn(childProcess, 'spawn');
    expect(await launcher.run({ request, signal: new AbortController().signal })).toEqual(
      unavailable,
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not execute an invalid request or an already cancelled operation', async () => {
    const launcher = createSecurityProcessLauncher(profile);
    const spawn = jest.spyOn(childProcess, 'spawn');
    const controller = new AbortController();
    controller.abort();
    expect(await launcher.run({ request, signal: controller.signal })).toEqual(unavailable);
    expect(
      await launcher.run({ request: Buffer.from('invalid'), signal: new AbortController().signal }),
    ).toEqual(unavailable);
    expect(spawn).not.toHaveBeenCalled();
  });
});

type NativeProfile = Omit<SecurityProcessProfile, 'entry' | 'filter' | 'opensslConfig'> & {
  canvasModule: string;
  pdfModule: string;
  syscallAddon: string;
};
const nativeProfilePath = process.env.SECURITY_PROCESS_NATIVE_PROFILE;
const localPreconditions = readCurrentSecurityProcessPreconditions();
const native = nativeProfilePath && localPreconditions ? describe : describe.skip;

if (!localPreconditions) {
  it('rejects this actually unqualified host before spawning or forwarding input', async () => {
    expect(readCurrentSecurityProcessPreconditions()).toBe(false);
    const spawn = jest.spyOn(childProcess, 'spawn').mockImplementation(() => {
      throw new Error('Unexpected spawn');
    });
    const launcher = createSecurityProcessLauncher(profile);
    expect(await launcher.run({ request, signal: new AbortController().signal })).toEqual(
      unavailable,
    );
    expect(spawn).not.toHaveBeenCalled();
  });
}

native(
  `real local GNU Node, Landlock, seccomp and observer (${localPreconditions ? 'separate qualification' : 'unavailable identity/core preconditions; not qualified'})`,
  () => {
    let nativeProfile: NativeProfile;
    const owned: {
      child: ChildProcess;
      joined: Promise<void>;
      pid?: number;
      start?: string;
    }[] = [];
    const actualSpawn = childProcess.spawn;
    function identity(pid: number) {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/);
      return { pid, startTicks: fields[19], processGroup: Number(fields[2]), state: fields[0] };
    }
    beforeAll(() => {
      nativeProfile = JSON.parse(readFileSync(nativeProfilePath!, 'utf8'));
      if (!process.env.SECURITY_PROCESS_PROVENANCE_PATH)
        throw new Error('Native actor provenance required');
    });
    beforeEach(() => {
      jest.spyOn(childProcess, 'spawn').mockImplementation(((
        ...args: Parameters<typeof childProcess.spawn>
      ) => {
        const child = actualSpawn(...args);
        const actor = child.pid ? identity(child.pid) : undefined;
        const joined = new Promise<void>((done) => child.once('close', () => done()));
        owned.push({ child, joined, pid: child.pid, start: actor?.startTicks });
        appendFileSync(
          process.env.SECURITY_PROCESS_PROVENANCE_PATH!,
          JSON.stringify({
            owner: '/root/workspace_files',
            scope: 'security-process-launcher',
            repository: process.cwd(),
            session: process.env.SECURITY_PROCESS_SESSION,
            lease: process.env.SECURITY_PROCESS_LEASE,
            bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
            ...actor,
            command: args[0],
            at: new Date().toISOString(),
            cancellation:
              'Own ChildProcess observer deadline plus identity-checked test close join',
          }) + '\n',
        );
        child.once('close', (code, signal) =>
          appendFileSync(
            process.env.SECURITY_PROCESS_PROVENANCE_PATH!,
            JSON.stringify({
              pid: actor?.pid,
              startTicks: actor?.startTicks,
              closed: true,
              code,
              signal,
            }) + '\n',
          ),
        );
        return child;
      }) as typeof childProcess.spawn);
    });
    afterEach(async () => {
      for (const actor of owned.splice(0)) {
        if (actor.pid && actor.child.exitCode === null && actor.child.signalCode === null) {
          try {
            if (identity(actor.pid).startTicks === actor.start) actor.child.kill('SIGKILL');
          } catch {
            /* The owned process may already have exited. */
          }
        }
        await actor.joined;
      }
    });

    function fixture(body: string) {
      const code = `const fs=require('node:fs');
      setTimeout(()=>process.exit(90),5000).unref();
      let length=0;const hash=require('crypto').createHash('sha256');
      process.stdin.on('data',chunk=>{length+=chunk.length;hash.update(chunk)});
      process.stdin.on('end',async()=>{
        try { if(length!==${request.length}||hash.digest('hex')!==${JSON.stringify(createHash('sha256').update(request).digest('hex'))})throw Error('Input mismatch');
          ${body} const result=Buffer.from(${JSON.stringify(JSON.stringify(negative))});const header=Buffer.from(JSON.stringify({version:2,kind:'result',bytes:result.length}));const prefix=Buffer.alloc(4);prefix.writeUInt32BE(header.length);fs.writeSync(3,Buffer.concat([prefix,header,result]));fs.closeSync(3); }
        catch(e){process.exitCode=91;}
      });`;
      chmodSync(profile.entry, 0o600);
      writeFileSync(profile.entry, code);
      chmodSync(profile.entry, 0o400);
      return createSecurityProcessLauncher({
        ...profile,
        ...nativeProfile,
        readFiles: [...nativeProfile.readFiles, join(root, 'package.json')],
      });
    }
    async function run(body: string, timeoutMs = 4000) {
      return fixture(body).run({ request, signal: new AbortController().signal, timeoutMs });
    }
    const completed = {
      result: negative,
      pages: 0,
      localCopiesRemoved: true,
      diagnostics: false,
      directChildStopped: true,
      transportComplete: true,
    };

    it('imports actual Node/Canvas/PDF.js with permitted native threads and no inherited environment', async () => {
      process.env.SECURITY_LAUNCHER_SYNTHETIC_SECRET = 'synthetic-only';
      try {
        expect(
          await run(`
        const assert=require('node:assert/strict');
        assert.equal(process.env.SECURITY_LAUNCHER_SYNTHETIC_SECRET,undefined);
        assert.equal(process.env.PATH,undefined);
        const {createCanvas}=require(${JSON.stringify(nativeProfile.canvasModule)});
        const c=createCanvas(4,4),ctx=c.getContext('2d');ctx.fillStyle='#123456';ctx.fillRect(0,0,4,4);
        assert.deepEqual(Array.from(ctx.getImageData(0,0,1,1).data),[18,52,86,255]);
        const pdf=await import(require('node:url').pathToFileURL(${JSON.stringify(nativeProfile.pdfModule)}));
        assert.equal(pdf.version,'5.4.624');c.width=0;c.height=0;
      `),
        ).toEqual(completed);
      } finally {
        delete process.env.SECURITY_LAUNCHER_SYNTHETIC_SECRET;
      }
    });

    it('denies actual socket/io_uring/foreign-FD/fork syscalls in the installed kernel', async () => {
      expect(
        await run(`
      const assert=require('node:assert/strict');
      const results=require(${JSON.stringify(nativeProfile.syscallAddon)}).probe();
      assert.equal(results.clone3,38);
      assert.equal(results.ipc_name,0);
      assert.equal(results.ipc_type,0);
      assert.equal(results.scheduler_err,0);
      for(const [name,value] of Object.entries(results)) if(!['clone3','ipc_name','ipc_type','scheduler_err'].includes(name))assert.equal(value,1,name);
    `),
      ).toEqual(completed);
    });

    it('isolates synthetic reads, writes, traversal, symlinks and foreign inherited descriptors', async () => {
      const allowed = join(root, 'allowed.txt'),
        secret = join(root, 'secret.txt'),
        alias = join(root, 'alias');
      writeFileSync(allowed, 'permitted');
      writeFileSync(secret, 'synthetic-secret');
      symlinkSync(secret, alias);
      const fd = openSync(secret, 'r');
      const previous = nativeProfile;
      nativeProfile = { ...previous, readFiles: [...previous.readFiles, allowed] };
      try {
        expect(
          await run(`
        const assert=require('node:assert/strict');
        assert.equal(fs.readFileSync(${JSON.stringify(allowed)},'utf8'),'permitted');
        for(const path of ${JSON.stringify([secret, alias, join(root, '..', root.split('/').pop()!, 'secret.txt')])})
          assert.throws(()=>fs.readFileSync(path),{code:'EACCES'});
        assert.throws(()=>fs.writeFileSync(${JSON.stringify(allowed)},'changed'),{code:'EACCES'});
        assert.throws(()=>fs.readFileSync('/proc/${process.pid}/fd/${fd}'),{code:'EACCES'});
        try { assert.notEqual(fs.fstatSync(${fd}).ino,${statSync(secret).ino}); }
        catch(e) { if(e.code!=='EBADF') throw e; }
      `),
        ).toEqual(completed);
      } finally {
        closeSync(fd);
        nativeProfile = previous;
      }
    });

    it('uses the opened verified policy when its pathname is replaced immediately before spawn', async () => {
      const launch = fixture('');
      const trackedSpawn = childProcess.spawn;
      jest.spyOn(childProcess, 'spawn').mockImplementationOnce(((
        ...args: Parameters<typeof childProcess.spawn>
      ) => {
        renameSync(profile.filter, join(root, 'verified.bpf'));
        writeFileSync(profile.filter, Buffer.alloc(createSecurityProcessPolicy().length));
        return trackedSpawn(...args);
      }) as typeof childProcess.spawn);
      expect(await launch.run({ request, signal: new AbortController().signal })).toEqual(
        completed,
      );
    });

    it('keeps the actual built product PDF child negative without OCR', async () => {
      const entry = realpathSync(
        resolve(__dirname, '../../../dist/uploads/security/pdf-child.cjs'),
      );
      const launch = createSecurityProcessLauncher({
        ...profile,
        ...nativeProfile,
        entry,
        readFiles: [...nativeProfile.readFiles, join(root, 'package.json')],
      });
      expect(await launch.run({ request, signal: new AbortController().signal })).toEqual(
        completed,
      );
    });

    it('discards diagnostics and terminates a timed-out own process', async () => {
      expect(
        await run(
          "fs.writeSync(2,'synthetic diagnostic');await new Promise(r=>setTimeout(r,300));",
        ),
      ).toEqual({
        result: null,
        diagnostics: true,
        directChildStopped: true,
        transportComplete: false,
      });
      expect(await run('setInterval(()=>{},100);await new Promise(()=>{});', 100)).toEqual({
        result: null,
        diagnostics: false,
        directChildStopped: true,
        transportComplete: false,
      });
    });
  },
);
