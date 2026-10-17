/** Real worker lifecycle and real TXT/receipt validators; fixtures only simulate hostile timing. */
import ts from 'typescript';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { matchesUploadSecurityApproval } from 'librechat-data-provider';
import { createSecurityWorker } from './worker';

const policy = { version: 1 as const, markings: ['GEHEIM'], labels: ['Einstufung'] };
const policySha256 = 'a'.repeat(64);
const signal = () => AbortSignal.timeout(3000);
const subject = (text = 'Harmloser Text') => ({
  tenantId: 'tenant',
  userId: 'user',
  operationId: 'upload',
  transferGeneration: 1,
  mediaType: 'text/plain',
  bytes: Buffer.byteLength(text),
  sha256: createHash('sha256').update(text).digest('hex'),
});
async function* body(text = 'Harmloser Text') {
  yield Buffer.from(text);
}
let directory: string;
const workers: ReturnType<typeof createSecurityWorker>[] = [];
function worker(options: Partial<Parameters<typeof createSecurityWorker>[0]> = {}) {
  const instance = createSecurityWorker({
    instanceId: randomUUID(),
    policy,
    policySha256,
    threadPath: join(directory, 'worker-thread.js'),
    ...options,
  });
  workers.push(instance);
  return instance;
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'security-worker-'));
  await writeFile(join(directory, 'package.json'), '{"type":"commonjs"}');
  // Compile the actual shipped thread and its pure dependencies, not a replacement implementation.
  for (const name of ['worker-thread', 'text', 'markings']) {
    const source = await readFile(join(__dirname, `${name}.ts`), 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
    });
    await writeFile(join(directory, `${name}.js`), compiled.outputText);
  }
  // Controlled failure fixture: posts a claimed result but deliberately never exits.
  await writeFile(
    join(directory, 'no-exit.js'),
    "require('node:worker_threads').parentPort.postMessage(JSON.stringify({decision:'clear'})); setInterval(()=>{},1000);",
  );
  await writeFile(
    join(directory, 'bad-exit.js'),
    "require('node:worker_threads').parentPort.postMessage(JSON.stringify({decision:'clear'})); process.exit(1);",
  );
});
afterEach(async () => {
  for (const instance of workers.splice(0)) {
    if (!(await instance.close(signal())).complete) throw new Error('Owned worker did not settle');
  }
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('bounded security worker', () => {
  it('prepares inert independent receipts and approves exact bytes only after a real thread exits', async () => {
    const instance = worker();
    const input = subject();
    const execution = await instance.prepare({
      attemptId: 'upload.1',
      subject: input,
      signal: signal(),
    });
    expect(
      await instance.prepare({ attemptId: 'upload.1', subject: input, signal: signal() }),
    ).toEqual(execution);
    const result = await instance.inspect({
      execution,
      subject: input,
      body: body(),
      signal: signal(),
    });
    expect(matchesUploadSecurityApproval(result.decision, input, policySha256, Date.now())).toBe(
      true,
    );
    expect(result.cleanup).toEqual({ writerStopped: true, transientDataRemoved: true });
    expect(await instance.cancel({ execution, signal: signal() })).toEqual({
      execution,
      ...result.cleanup,
    });
    await expect(
      instance.inspect({ execution, subject: input, body: body(), signal: signal() }),
    ).rejects.toThrow('Security worker unavailable');
  });

  it.each(['Einstufung: GEHEIM', 'Eine Erwähnung von GEHEIM.'])(
    'retains negative TXT decisions: %s',
    async (text) => {
      const instance = worker();
      const input = subject(text);
      const execution = await instance.prepare({
        attemptId: 'upload.1',
        subject: input,
        signal: signal(),
      });
      const result = await instance.inspect({
        execution,
        subject: input,
        body: body(text),
        signal: signal(),
      });
      expect(result.decision).toEqual(
        text.startsWith('Einstufung')
          ? { version: 1, decision: 'rejected', reason: 'classification_marking' }
          : { version: 1, decision: 'uninspectable', reason: 'ambiguous_marking' },
      );
    },
  );

  it.each(['wrong length', 'Harmloser Texx'])(
    'refuses mismatched stream bytes: %s',
    async (text) => {
      const instance = worker();
      const input = subject();
      const execution = await instance.prepare({
        attemptId: 'upload.1',
        subject: input,
        signal: signal(),
      });
      const result = await instance.inspect({
        execution,
        subject: input,
        body: body(text),
        signal: signal(),
      });
      expect(result.decision).toEqual({
        version: 1,
        decision: 'uninspectable',
        reason: 'invalid_content',
      });
    },
  );

  it('fences prepared cancellation, expiration, subject changes and foreign receipts before reading', async () => {
    let now = Date.now();
    const instance = worker({ now: () => now, ttlMs: 100 });
    const input = subject();
    const execution = await instance.prepare({
      attemptId: 'upload.1',
      subject: input,
      signal: signal(),
    });
    let read = false;
    async function* untouched() {
      read = true;
      yield Buffer.from('secret');
    }
    await expect(
      instance.inspect({
        execution,
        subject: { ...input, userId: 'other' },
        body: untouched(),
        signal: signal(),
      }),
    ).rejects.toThrow();
    const foreign = { ...execution, instanceId: randomUUID() };
    expect(await instance.cancel({ execution: foreign, signal: signal() })).toEqual({
      execution: foreign,
      writerStopped: false,
      transientDataRemoved: false,
    });
    expect((await instance.cancel({ execution, signal: signal() })).writerStopped).toBe(true);
    await expect(
      instance.inspect({ execution, subject: input, body: untouched(), signal: signal() }),
    ).rejects.toThrow();
    const later = await instance.prepare({
      attemptId: 'later.1',
      subject: { ...input, operationId: 'later' },
      signal: signal(),
    });
    now += 101;
    await expect(
      instance.inspect({
        execution: later,
        subject: { ...input, operationId: 'later' },
        body: untouched(),
        signal: signal(),
      }),
    ).rejects.toThrow();
    expect(read).toBe(false);
  });

  it('never treats a message as thread exit; TTL terminates the controlled no-exit fixture', async () => {
    const instance = worker({ threadPath: join(directory, 'no-exit.js'), ttlMs: 150 });
    const input = subject();
    const execution = await instance.prepare({
      attemptId: 'upload.1',
      subject: input,
      signal: signal(),
    });
    await expect(
      instance.inspect({ execution, subject: input, body: body(), signal: signal() }),
    ).rejects.toThrow('Security worker unavailable');
    expect((await instance.cancel({ execution, signal: signal() })).writerStopped).toBe(true);
  });

  it('refuses a claimed clear result followed by an abnormal exit in a controlled thread fixture', async () => {
    const instance = worker({ threadPath: join(directory, 'bad-exit.js') });
    const input = subject();
    const execution = await instance.prepare({
      attemptId: 'upload.1',
      subject: input,
      signal: signal(),
    });
    expect(
      (await instance.inspect({ execution, subject: input, body: body(), signal: signal() }))
        .decision,
    ).toEqual({
      version: 1,
      decision: 'uninspectable',
      reason: 'scanner_unavailable',
    });
  });

  it('refuses unsupported or oversized inputs without manufacturing approval', async () => {
    for (const input of [
      { ...subject(), mediaType: 'application/pdf' },
      subject('x'.repeat(65_537)),
    ]) {
      const instance = worker();
      const execution = await instance.prepare({
        attemptId: 'upload.1',
        subject: input,
        signal: signal(),
      });
      const result = await instance.inspect({
        execution,
        subject: input,
        body: body(input.bytes > 65_536 ? 'x'.repeat(65_537) : undefined),
        signal: signal(),
      });
      expect(result.decision).toEqual({
        version: 1,
        decision: 'uninspectable',
        reason: input.bytes > 65_536 ? 'resource_limit' : 'invalid_content',
      });
    }
  });

  it('keeps uncooperative streams unknown, bounds active work and refuses late starts after cancel', async () => {
    const instance = worker();
    const input = subject();
    const execution = await instance.prepare({
      attemptId: 'upload.1',
      subject: input,
      signal: signal(),
    });
    let release!: (value: IteratorResult<Uint8Array>) => void;
    const pending = new Promise<IteratorResult<Uint8Array>>((resolve) => {
      release = resolve;
    });
    const stream: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({ next: () => pending }),
    };
    const abort = new AbortController();
    const inspecting = instance.inspect({
      execution,
      subject: input,
      body: stream,
      signal: abort.signal,
    });
    const failed = inspecting.catch((error: unknown) => error);
    abort.abort();
    expect(await failed).toEqual(new Error('Security worker unavailable'));
    expect(await instance.cancel({ execution, signal: AbortSignal.timeout(20) })).toEqual({
      execution,
      writerStopped: false,
      transientDataRemoved: false,
    });
    const nextSubject = { ...input, operationId: 'next' };
    const next = await instance.prepare({
      attemptId: 'next.1',
      subject: nextSubject,
      signal: signal(),
    });
    await expect(
      instance.inspect({ execution: next, subject: nextSubject, body: body(), signal: signal() }),
    ).rejects.toThrow();
    release({ done: true, value: undefined });
    expect(await instance.cancel({ execution, signal: signal() })).toEqual({
      execution,
      writerStopped: true,
      transientDataRemoved: true,
    });
  });

  it('caps receipts and refuses work after close', async () => {
    const instance = worker();
    for (let i = 0; i < 256; i++) {
      await instance.prepare({
        attemptId: `op${i}.1`,
        subject: { ...subject(), operationId: `op${i}` },
        signal: signal(),
      });
    }
    await expect(
      instance.prepare({
        attemptId: 'overflow.1',
        subject: { ...subject(), operationId: 'overflow' },
        signal: signal(),
      }),
    ).rejects.toThrow();
    expect(await instance.close(signal())).toEqual({ complete: true });
    await expect(
      instance.prepare({ attemptId: 'upload.1', subject: subject(), signal: signal() }),
    ).rejects.toThrow();
  });
});
