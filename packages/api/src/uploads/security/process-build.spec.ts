/** Built private producer/consumer regression: source-only tests did not require deployable artifacts. */
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import childProcess from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { SecurityProcessProfile } from './process-launcher';
import { encodeSecurityProcessRequest } from './process-wire';

const dist = resolve(__dirname, '../../../dist/uploads/security');
const unavailable = {
  result: null,
  pages: 0,
  localCopiesRemoved: false,
  diagnostics: false,
  directChildStopped: false,
  transportComplete: false,
};
let launcherModule: typeof import('./process-launcher');
let policyModule: typeof import('./process-policy');
let root: string;
let profile: SecurityProcessProfile;
let request: Uint8Array;
let spawn: jest.SpyInstance;

beforeAll(() => {
  launcherModule = jest.requireActual(join(dist, 'process-launcher.cjs'));
  policyModule = jest.requireActual(join(dist, 'process-policy.cjs'));
});

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'security-build-')));
  const file = (name: string, value: string | Buffer) => {
    const path = join(root, name);
    writeFileSync(path, value, { mode: 0o600 });
    return path;
  };
  profile = {
    setpriv: realpathSync(process.execPath),
    node: realpathSync(process.execPath),
    entry: realpathSync(join(dist, 'pdf-child.cjs')),
    filter: file('policy.bpf', policyModule.createSecurityProcessPolicy()),
    opensslConfig: file('empty.cnf', ''),
    canvasAddon: file('addon', ''),
    readFiles: [],
    executeFiles: [],
  };
  request = encodeSecurityProcessRequest({
    mediaType: 'application/pdf',
    policy: { version: 1, markings: ['GEHEIM'], labels: ['Einstufung'] },
    bytes: Buffer.from('%PDF-1.4\nsynthetic build-consumer input only'),
  });
  // Only refusal is under test. An attempted spawn is a test failure, never native execution.
  spawn = jest.spyOn(childProcess, 'spawn').mockImplementation(() => {
    throw new Error('Built refusal consumer unexpectedly attempted native execution');
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  request?.fill(0);
  if (root) rmSync(root, { recursive: true, force: true });
});

it('consumes the emitted policy and real wire frame, then refuses unsafe kernel facts', async () => {
  const status = [
    'Uid:\t1000\t1000\t1000\t1000',
    'Gid:\t1000\t1000\t1000\t1000',
    ...['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].map(
      (name) => `${name}:\t0000000000000000`,
    ),
  ].join('\n');
  const contents = new Map([
    ['/proc/self/status', status],
    [
      '/proc/self/limits',
      'Max core file size        0                    0                    bytes\n',
    ],
    ['/proc/sys/kernel/core_pattern', '|/synthetic-crash-handler\n'],
  ]);
  const fixtures = new Map<string, string>();
  for (const [path, value] of contents) {
    const fixture = join(root, `kernel-${fixtures.size}`);
    writeFileSync(fixture, value);
    fixtures.set(path, fixture);
  }
  const actualOpen = fs.openSync;
  const opened = jest
    .spyOn(fs, 'openSync')
    .mockImplementation(((path, ...args) =>
      actualOpen(fixtures.get(String(path)) ?? path, ...args)) as typeof fs.openSync);
  const launcher = launcherModule.createSecurityProcessLauncher(profile);

  expect(await launcher.run({ request, signal: new AbortController().signal })).toEqual(
    unavailable,
  );
  // Reaching all fixed kernel reads proves the built producer's bytes passed the built consumer.
  for (const path of contents.keys()) {
    expect(opened.mock.calls.filter((call) => call[0] === path)).toHaveLength(1);
  }
  expect(spawn).not.toHaveBeenCalled();
});

it('refuses a same-length change to the emitted policy before reading kernel facts', async () => {
  const launcher = launcherModule.createSecurityProcessLauncher(profile);
  const changed = policyModule.createSecurityProcessPolicy();
  changed[0] ^= 1;
  writeFileSync(profile.filter, changed);
  const opened = jest.spyOn(fs, 'openSync');

  expect(await launcher.run({ request, signal: new AbortController().signal })).toEqual(
    unavailable,
  );
  expect(opened.mock.calls.some((call) => String(call[0]).startsWith('/proc/'))).toBe(false);
  expect(spawn).not.toHaveBeenCalled();
});

it('refuses malformed input and cancellation before opening execution assets', async () => {
  const launcher = launcherModule.createSecurityProcessLauncher(profile);
  const opened = jest.spyOn(fs, 'openSync');
  const controller = new AbortController();
  controller.abort();

  expect(await launcher.run({ request, signal: controller.signal })).toEqual(unavailable);
  expect(
    await launcher.run({ request: Buffer.from('invalid'), signal: new AbortController().signal }),
  ).toEqual(unavailable);
  expect(opened).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});
