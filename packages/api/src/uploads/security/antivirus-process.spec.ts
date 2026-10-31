/** Real inert Node children exercise one permit, terminal evidence and joined retirement; never AV qualification. */
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { antivirusStartupFailure, createAntivirusProcessEvents } from './antivirus-process-events';
import { createAntivirusRetirement } from './antivirus-process';

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
