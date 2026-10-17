/** Real, fixed, harmless local children. These tests do not certify sandbox or descendant cleanup. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { observeSecurityProcess } from './process-observer';
import { encodeSecurityProcessRequest, SECURITY_PROCESS_LIMITS } from './process-wire';

const negative = { decision: 'uninspectable', reason: 'incomplete_coverage' } as const;
const request = encodeSecurityProcessRequest({
  mediaType: 'application/pdf',
  policy: { version: 1, markings: ['GEHEIM'], labels: ['Einstufung'] },
  bytes: Buffer.from('%PDF- synthetic observer fixture only'),
});
const write = (value: string) => `fs.writeSync(3, ${JSON.stringify(value)});`;
const requestSha256 = createHash('sha256').update(request).digest('hex');
type Owned = { child: ChildProcess; joined: Promise<void>; pid?: number; startTicks?: string };
const owned: Owned[] = [];

function identity(pid: number) {
  const fields = readFileSync(`/proc/${pid}/stat`, 'utf8')
    .split(')')
    .slice(1)
    .join(')')
    .trim()
    .split(/\s+/);
  return { pid, startTicks: fields[19], processGroup: Number(fields[2]), state: fields[0] };
}

function fixture(
  body: string,
  options: { immediate?: boolean; stdio?: SpawnOptions['stdio'] } = {},
) {
  const script = `const fs=require('node:fs');
    setTimeout(()=>process.exit(71),2000).unref();
    ${
      options.immediate
        ? body
        : `let bytes=0; const hash=require('node:crypto').createHash('sha256');
    process.stdin.on('data', b=>{bytes+=b.length;hash.update(b)});
    process.stdin.on('end',()=>{if(bytes!==${request.byteLength}||hash.digest('hex')!==${JSON.stringify(requestSha256)})process.exit(72); ${body}});`
    }`;
  const child = spawn(process.execPath, ['-e', script], {
    stdio: options.stdio ?? ['pipe', 'pipe', 'pipe', 'pipe'],
    env: {},
  });

  track(child, [process.execPath, '-e', script]);
  return child;
}

function track(child: ChildProcess, command: string[]) {
  const ignoreSpawnError = () => undefined;
  child.on('error', ignoreSpawnError);
  const joined = new Promise<void>((resolve) =>
    child.once('close', () => {
      child.removeListener('error', ignoreSpawnError);
      resolve();
    }),
  );
  const actor = child.pid ? identity(child.pid) : undefined;
  owned.push({ child, joined, pid: child.pid, startTicks: actor?.startTicks });
  if (process.env.SECURITY_PROCESS_PROVENANCE_PATH) {
    appendFileSync(
      process.env.SECURITY_PROCESS_PROVENANCE_PATH,
      JSON.stringify({
        repository: process.cwd(),
        session: process.env.SECURITY_PROCESS_SESSION,
        lease: process.env.SECURITY_PROCESS_LEASE,
        owner: '/root/workspace_sources',
        scope: 'security-process-observer',
        bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
        ...actor,
        command,
        at: new Date().toISOString(),
        cancellation:
          'Owned ChildProcess handle only; every fixture has a two-second self-deadline',
      }) + '\n',
    );
  }
}

afterEach(async () => {
  jest.restoreAllMocks();
  for (const actor of owned.splice(0)) {
    if (actor.child.exitCode === null && actor.child.signalCode === null)
      actor.child.kill('SIGKILL');
    await actor.joined;
    if (!actor.pid) continue;
    let remaining;
    try {
      remaining = identity(actor.pid);
    } catch {
      continue;
    }
    if (remaining.startTicks === actor.startTicks && remaining.state !== 'Z') {
      throw new Error('Owned fixture did not stop');
    }
  }
});

const observe = (
  child: ChildProcess,
  extra: Partial<Parameters<typeof observeSecurityProcess>[0]> = {},
) =>
  observeSecurityProcess({
    child,
    request,
    signal: new AbortController().signal,
    timeoutMs: 800,
    ...extra,
  });

describe('bounded private security process observer', () => {
  it('owns a complete request copy through native input completion', async () => {
    const child = fixture(write(JSON.stringify(negative)) + 'process.exit(0);');
    const mutable = Buffer.from(request);
    const result = observe(child, { request: mutable });
    mutable.fill(0);
    expect((await result).result).toEqual(negative);
  });

  it('accepts a negative result only after the complete input, all EOFs and actual exit/close', async () => {
    const child = fixture(write(JSON.stringify(negative)) + 'process.exit(0);');
    const controller = new AbortController();
    const original = Buffer.from(request);
    expect(await observe(child, { signal: controller.signal })).toEqual({
      result: negative,
      diagnostics: false,
      directChildStopped: true,
      transportComplete: true,
    });
    expect(request).toEqual(original);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
    for (const stream of [child.stdout, child.stderr, child.stdio[3]]) {
      expect(stream?.listenerCount('data')).toBe(0);
    }
  });

  it.each([
    [
      'positive',
      JSON.stringify({ decision: 'clear', coverage: { complete: true, pages: 1, parts: 1 } }),
    ],
    ['malformed', '{'],
    ['multiple objects', JSON.stringify(negative) + JSON.stringify(negative)],
    ['truncated', '{"decision":"uninspectable"'],
    ['empty', ''],
    ['over the result limit', 'x'.repeat(SECURITY_PROCESS_LIMITS.resultBytes + 1)],
    ['private extra field', JSON.stringify({ ...negative, text: 'PRIVATE_DIAGNOSTIC' })],
  ])('refuses %s output', async (_name, text) => {
    const result = await observe(fixture(write(text) + 'process.exit(0);'));
    expect(result).toEqual({
      result: null,
      diagnostics: false,
      directChildStopped: true,
      transportComplete: false,
    });
  });

  it.each([
    ['stdout', `fs.writeSync(1,'PRIVATE_DIAGNOSTIC');`],
    ['stderr', `fs.writeSync(2,'PRIVATE_DIAGNOSTIC');`],
    ['import warning', `process.emitWarning('PRIVATE_DIAGNOSTIC');`],
  ])('discards %s diagnostics before result interpretation', async (_name, code) => {
    const result = await observe(
      fixture(code + write(JSON.stringify(negative)) + 'setTimeout(()=>process.exit(0),20);', {
        immediate: true,
      }),
    );
    expect(result).toEqual({
      result: null,
      diagnostics: true,
      directChildStopped: true,
      transportComplete: false,
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_DIAGNOSTIC');
  });

  it('rejects a diagnostic emitted after an otherwise valid result', async () => {
    const result = await observe(
      fixture(
        write(JSON.stringify(negative)) +
          "setTimeout(()=>{fs.writeSync(2,'PRIVATE_DIAGNOSTIC');process.exit(0)},10);",
      ),
    );
    expect(result.result).toBeNull();
    expect(result.diagnostics).toBe(true);
    expect(result.transportComplete).toBe(false);
  });

  it('waits for actual exit even when every output pipe has ended', async () => {
    const result = await observe(
      fixture(
        write(JSON.stringify(negative)) +
          'fs.closeSync(3);process.stdout.end();process.stderr.end();setInterval(()=>{},100);',
      ),
      { timeoutMs: 200 },
    );
    expect(result).toEqual({
      result: null,
      diagnostics: false,
      directChildStopped: true,
      transportComplete: false,
    });
  });

  it('refuses a nonzero child exit despite a valid negative result', async () => {
    expect(
      (await observe(fixture(write(JSON.stringify(negative)) + 'process.exit(3);'))).result,
    ).toBeNull();
  });

  it('refuses an input write that cannot finish before child exit', async () => {
    const child = fixture(
      'fs.closeSync(0);' + write(JSON.stringify(negative)) + 'process.exit(0);',
      { immediate: true },
    );
    const result = await observe(child, {
      request: new Uint8Array(SECURITY_PROCESS_LIMITS.documentBytes),
    });
    expect(result).toEqual({
      result: null,
      diagnostics: false,
      directChildStopped: true,
      transportComplete: false,
    });
  });

  it('stops only its own direct child on abort', async () => {
    const child = fixture('setInterval(()=>{},100);');
    const kill = jest.spyOn(child, 'kill');
    const controller = new AbortController();
    const pending = observe(child, { signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(result).toEqual({
      result: null,
      diagnostics: false,
      directChildStopped: true,
      transportComplete: false,
    });
  });

  it('does not attest direct child stop when cancellation cannot confirm its exit', async () => {
    const child = fixture('setInterval(()=>{},100);');
    const kill = jest.spyOn(child, 'kill').mockReturnValue(false);
    const result = await observe(child, { timeoutMs: 20, cleanupMs: 10 });
    expect(result).toEqual({
      result: null,
      diagnostics: false,
      directChildStopped: false,
      transportComplete: false,
    });
    kill.mockRestore();
  });

  it('handles real spawn failure without interpreting it as successful transport', async () => {
    const command = '/cortex-observer-fixture/executable-does-not-exist';
    const child = spawn(command, [], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: {} });
    track(child, [command]);
    expect(await observe(child)).toEqual({
      result: null,
      diagnostics: false,
      directChildStopped: false,
      transportComplete: false,
    });
  });

  it('refuses a missing dedicated result pipe', async () => {
    expect(
      (await observe(fixture('setInterval(()=>{},100);', { stdio: ['pipe', 'pipe', 'pipe'] })))
        .transportComplete,
    ).toBe(false);
  });

  it('refuses a previously destroyed output stream', async () => {
    const child = fixture('setInterval(()=>{},100);');
    child.stdout?.destroy();
    expect((await observe(child)).transportComplete).toBe(false);
  });

  it('refuses a pipe that may already have been consumed before observation', async () => {
    const child = fixture(write(JSON.stringify(negative)) + 'process.exit(0);');
    child.stderr?.resume();
    expect((await observe(child)).transportComplete).toBe(false);
  });

  it('refuses manually consumed diagnostics even when the stream never flowed', async () => {
    const child = fixture(
      "fs.writeSync(2,'PRIVATE_DIAGNOSTIC');process.stdin.resume();process.stdin.on('end',()=>{" +
        write(JSON.stringify(negative)) +
        'process.exit(0);});',
      { immediate: true },
    );
    const stderr = child.stderr!;
    const deadline = Date.now() + 500;
    let bytes = stderr.read();
    while (bytes === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      bytes = stderr.read();
    }
    expect(bytes).toEqual(Buffer.from('PRIVATE_DIAGNOSTIC'));
    expect(stderr.readableFlowing).toBeNull();
    expect(stderr.readableDidRead).toBe(true);
    expect(await observe(child)).toMatchObject({
      result: null,
      transportComplete: false,
      diagnostics: true,
    });
  });

  it.each([
    { timeoutMs: 30_001 },
    { timeoutMs: 0 },
    { timeoutMs: Number.NaN },
    { cleanupMs: 1_001 },
    { cleanupMs: -1 },
    { request: new Uint8Array(0) },
    {
      request: new Uint8Array(
        SECURITY_PROCESS_LIMITS.documentBytes + SECURITY_PROCESS_LIMITS.headerBytes + 5,
      ),
    },
    { request: new Uint8Array(new SharedArrayBuffer(8)) },
    { signal: null as unknown as AbortSignal },
  ])('fails closed for invalid bounds or input %#', async (extra) => {
    const result = await observe(fixture('setInterval(()=>{},100);'), extra);
    expect(result).toEqual({
      result: null,
      diagnostics: false,
      directChildStopped: true,
      transportComplete: false,
    });
  });

  it('fails closed for an already aborted signal', async () => {
    const result = await observe(fixture('setInterval(()=>{},100);'), {
      signal: AbortSignal.abort(),
    });
    expect(result.result).toBeNull();
    expect(result.directChildStopped).toBe(true);
  });
});
