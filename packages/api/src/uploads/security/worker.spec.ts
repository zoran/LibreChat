/** Real worker lifecycle and real TXT/CSV validators; fixtures only simulate hostile timing. */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, stat, writeFile, rm } from 'node:fs/promises';
import { matchesUploadSecurityApproval } from 'librechat-data-provider';
import type { UploadSecurityExecution, UploadSecurityScopeReceipt } from 'librechat-data-provider';
import type { SecurityPdfOcrProvider } from './pdf-ocr';
import { observeSecurityProcess } from './process-observer';
import { SECURITY_INSPECTION_VERSION } from './inspection';
import { createSecurityWorker } from './worker';

const policy = { version: 1 as const, markings: ['GEHEIM'], labels: ['Einstufung'] };
const policySha256 = 'a'.repeat(64);
const complete = { decision: 'clear', coverage: { complete: true, pages: 1, parts: 1 } };
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
    threadPath: join(__dirname, '../../../dist/uploads/security/worker-thread.cjs'),
    ...options,
  });
  workers.push(instance);
  return instance;
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'security-worker-'));
  await writeFile(join(directory, 'package.json'), '{"type":"commonjs"}');
  // Reuse the qualified actual thread artifact; this suite never starts a package build.
  await stat(join(__dirname, '../../../dist/uploads/security/worker-thread.cjs'));
  // Controlled failure fixture: posts a claimed result but deliberately never exits.
  await writeFile(
    join(directory, 'no-exit.js'),
    `require('node:worker_threads').parentPort.postMessage(${JSON.stringify(JSON.stringify(complete))}); require('node:fs').writeFileSync(${JSON.stringify(join(directory, 'thread-started'))}, 'started'); setInterval(()=>{},1000);`,
  );
  await writeFile(
    join(directory, 'bad-exit.js'),
    `require('node:worker_threads').parentPort.postMessage(${JSON.stringify(JSON.stringify(complete))}); process.exit(1);`,
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
  async function inspectThreadResult(result: unknown) {
    const threadPath = join(directory, `${randomUUID()}.js`);
    await writeFile(
      threadPath,
      `require('node:worker_threads').parentPort.postMessage(${JSON.stringify(JSON.stringify(result))});`,
    );
    const instance = worker({ threadPath });
    const execution = await instance.prepare({
      attemptId: 'upload.1',
      subject: subject(),
      signal: signal(),
    });
    return {
      execution,
      result: await instance.inspect({
        execution,
        subject: subject(),
        body: body(),
        signal: signal(),
      }),
    };
  }

  it('binds actual multi-page coverage from a joined controlled thread through the public approval reader', async () => {
    const { result, execution } = await inspectThreadResult({
      decision: 'clear',
      coverage: { complete: true, pages: 3, parts: 2 },
    });
    expect(result.decision).toMatchObject({
      decision: 'approved',
      subject: subject(),
      policySha256,
      scannerVersion: SECURITY_INSPECTION_VERSION,
      coverage: { complete: true, pages: 3, parts: 2 },
    });
    expect(
      matchesUploadSecurityApproval(result.decision, subject(), policySha256, Date.now()),
    ).toBe(true);
    expect(result.settlement).toEqual({
      execution,
      writerStopped: true,
      transientDataRemoved: true,
    });
  });

  it.each([
    { decision: 'clear' },
    { decision: 'clear', coverage: { complete: false, pages: 1, parts: 1 } },
    { decision: 'clear', coverage: { complete: true, pages: 0, parts: 1 } },
    { decision: 'clear', coverage: { complete: true, pages: 501, parts: 1 } },
    { decision: 'clear', coverage: { complete: true, pages: 1, parts: 2049 } },
    { decision: 'clear', coverage: { complete: true, pages: 1, parts: 1, untrusted: true } },
    { ...complete, untrusted: true },
  ])('refuses legacy or malformed positive thread evidence %#', async (claimed) => {
    const { result, execution } = await inspectThreadResult(claimed);
    expect(result.decision).toEqual({
      version: 1,
      decision: 'uninspectable',
      reason: 'scanner_unavailable',
    });
    expect(result.settlement).toEqual({
      execution,
      writerStopped: true,
      transientDataRemoved: true,
    });
  });

  it('approves original CSV bytes/MIME with the new scanner version only after real thread exit', async () => {
    const source = '\ufeffName,Wert\r\nNotiz,-1.25\r\n';
    const input = { ...subject(source), mediaType: 'text/csv' };
    const instance = worker();
    const execution = await instance.prepare({
      attemptId: 'upload.1',
      subject: input,
      signal: signal(),
    });
    const result = await instance.inspect({
      execution,
      subject: input,
      body: body(source),
      signal: signal(),
    });
    expect(matchesUploadSecurityApproval(result.decision, input, policySha256, Date.now())).toBe(
      true,
    );
    expect(result.decision).toMatchObject({
      scannerVersion: SECURITY_INSPECTION_VERSION,
      subject: input,
      coverage: { complete: true, pages: 1, parts: 1 },
    });
    expect(
      matchesUploadSecurityApproval(
        result.decision,
        { ...input, mediaType: 'text/plain' },
        policySha256,
        Date.now(),
      ),
    ).toBe(false);
    expect(result.settlement).toEqual({
      execution,
      writerStopped: true,
      transientDataRemoved: true,
    });
  });

  it.each([
    ['Name,Wert\nEinstufung,GEHEIM', 'rejected', 'classification_marking'],
    ['Begriff,GEHEIM', 'uninspectable', 'ambiguous_marking'],
    ['Name,Wert\nNotiz,"=1+1"', 'uninspectable', 'invalid_content'],
    ['a,b\nc', 'uninspectable', 'invalid_content'],
    ['a'.repeat(65_537), 'uninspectable', 'resource_limit'],
  ])(
    'retains negative CSV decisions through the actual thread %#',
    async (source, decision, reason) => {
      const instance = worker();
      const input = { ...subject(source), mediaType: 'text/csv' };
      const execution = await instance.prepare({
        attemptId: 'upload.1',
        subject: input,
        signal: signal(),
      });
      const result = await instance.inspect({
        execution,
        subject: input,
        body: body(source),
        signal: signal(),
      });
      expect(result.decision).toEqual({ version: 1, decision, reason });
      expect(result.settlement).toEqual({
        execution,
        writerStopped: true,
        transientDataRemoved: true,
      });
    },
  );

  it('rejects changed CSV bytes before returning a valid approval', async () => {
    const instance = worker();
    const input = { ...subject('a,b'), mediaType: 'text/csv' };
    const execution = await instance.prepare({
      attemptId: 'upload.1',
      subject: input,
      signal: signal(),
    });
    const result = await instance.inspect({
      execution,
      subject: input,
      body: body('a,c'),
      signal: signal(),
    });
    expect(result.decision).toEqual({
      version: 1,
      decision: 'uninspectable',
      reason: 'invalid_content',
    });
  });

  it('binds maintenance to its requester while prepared inspections and cancellations remain usable', async () => {
    const instance = worker();
    const execution = await instance.prepare({
      attemptId: 'upload.1',
      subject: subject(),
      signal: signal(),
    });
    const cancelled = await instance.prepare({
      attemptId: 'cancelled.1',
      subject: { ...subject(), operationId: 'cancelled' },
      signal: signal(),
    });
    const port = instance.maintenance;
    expect(port.resumeAdmissions('owner')).toBe(false);
    expect(port.pauseAdmissions('')).toBe(false);
    expect(port.pauseAdmissions('owner')).toBe(true);
    expect(port.pauseAdmissions('owner')).toBe(true);
    expect(port.pauseAdmissions('foreign')).toBe(false);
    expect(port.resumeAdmissions('foreign')).toBe(false);
    expect(port.resumeAdmissions('owner')).toBe(false);
    expect(await port.getMaintenanceCensus('owner')).toEqual({
      admissionClosed: true,
      queuedContinuations: 2,
      pendingWrites: 0,
      complete: true,
    });
    expect(await port.getMaintenanceCensus('foreign')).toMatchObject({
      admissionClosed: false,
      complete: false,
    });
    await expect(
      instance.prepare({
        attemptId: 'new.1',
        subject: { ...subject(), operationId: 'new' },
        signal: signal(),
      }),
    ).rejects.toThrow('Security worker unavailable');
    const next = jest.fn(async () => ({ done: true as const, value: undefined }));
    await expect(
      instance.inspect({
        execution: { ...execution, executionId: randomUUID() },
        subject: subject(),
        body: { [Symbol.asyncIterator]: () => ({ next }) },
        signal: signal(),
      }),
    ).rejects.toThrow();
    expect(next).not.toHaveBeenCalled();
    expect(
      (await instance.inspect({ execution, subject: subject(), body: body(), signal: signal() }))
        .decision.decision,
    ).toBe('approved');
    expect((await instance.cancel({ execution: cancelled, signal: signal() })).writerStopped).toBe(
      true,
    );
    expect(await port.getMaintenanceCensus('owner')).toEqual({
      admissionClosed: true,
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
    expect(port.resumeAdmissions('owner')).toBe(true);
    expect(port.resumeAdmissions('owner')).toBe(false);
    await expect(
      instance.prepare({
        attemptId: 'new.1',
        subject: { ...subject(), operationId: 'new' },
        signal: signal(),
      }),
    ).resolves.toMatchObject({ attemptId: 'new.1' });
  });

  it('accounts for prepared expiry without needing another admission', async () => {
    let now = Date.now();
    const instance = worker({ now: () => now, ttlMs: 10 });
    await instance.prepare({ attemptId: 'upload.1', subject: subject(), signal: signal() });
    expect(instance.maintenance.pauseAdmissions('owner')).toBe(true);
    expect((await instance.maintenance.getMaintenanceCensus('owner')).queuedContinuations).toBe(1);
    now += 11;
    expect(await instance.maintenance.getMaintenanceCensus('owner')).toMatchObject({
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    });
    expect(instance.maintenance.resumeAdmissions('owner')).toBe(true);
  });

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
    expect(result.settlement).toEqual({
      execution,
      writerStopped: true,
      transientDataRemoved: true,
    });
    expect(await instance.cancel({ execution, signal: signal() })).toEqual(result.settlement);
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
    const instance = worker({ threadPath: join(directory, 'no-exit.js'), ttlMs: 1000 });
    const input = subject();
    const execution = await instance.prepare({
      attemptId: 'upload.1',
      subject: input,
      signal: signal(),
    });
    const inspecting = instance.inspect({
      execution,
      subject: input,
      body: body(),
      signal: signal(),
    });
    const failed = inspecting.catch((error: unknown) => error);
    const deadline = Date.now() + 900;
    while (!(await stat(join(directory, 'thread-started')).catch(() => undefined))) {
      if (Date.now() >= deadline) throw new Error('Controlled worker did not start');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // The real producer reached EOF before thread launch; this obligation is the live thread.
    expect(instance.maintenance.pauseAdmissions('owner')).toBe(true);
    expect(await instance.maintenance.getMaintenanceCensus('owner')).toEqual({
      admissionClosed: true,
      queuedContinuations: 0,
      pendingWrites: 1,
      complete: false,
    });
    expect(instance.maintenance.resumeAdmissions('owner')).toBe(false);
    expect(await failed).toEqual(new Error('Security worker unavailable'));
    expect((await instance.cancel({ execution, signal: signal() })).writerStopped).toBe(true);
    expect(instance.maintenance.resumeAdmissions('owner')).toBe(true);
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
      if (input.mediaType === 'application/pdf') {
        await expect(
          instance.prepare({ attemptId: 'upload.1', subject: input, signal: signal() }),
        ).rejects.toThrow('Security worker unavailable');
        expect(await instance.maintenance.getMaintenanceCensus(null)).toMatchObject({
          queuedContinuations: 0,
          pendingWrites: 0,
        });
        continue;
      }
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
    const nextSubject = { ...input, operationId: 'next' };
    const next = await instance.prepare({
      attemptId: 'next.1',
      subject: nextSubject,
      signal: signal(),
    });
    const abort = new AbortController();
    const inspecting = instance.inspect({
      execution,
      subject: input,
      body: stream,
      signal: abort.signal,
    });
    const failed = inspecting.catch((error: unknown) => error);
    expect(instance.maintenance.pauseAdmissions('owner')).toBe(true);
    abort.abort();
    expect(await failed).toEqual(new Error('Security worker unavailable'));
    expect(await instance.maintenance.getMaintenanceCensus('owner')).toEqual({
      admissionClosed: true,
      queuedContinuations: 1,
      pendingWrites: 1,
      complete: false,
    });
    expect(instance.maintenance.resumeAdmissions('owner')).toBe(false);
    expect(await instance.cancel({ execution, signal: AbortSignal.timeout(20) })).toEqual({
      execution,
      writerStopped: false,
      transientDataRemoved: false,
    });
    await expect(
      instance.inspect({ execution: next, subject: nextSubject, body: body(), signal: signal() }),
    ).rejects.toThrow();
    expect(await instance.close(AbortSignal.timeout(20))).toEqual({ complete: false });
    expect(await instance.close(AbortSignal.abort())).toEqual({ complete: false });
    release({ done: true, value: undefined });
    expect(await instance.cancel({ execution, signal: signal() })).toEqual({
      execution,
      writerStopped: true,
      transientDataRemoved: true,
    });
    expect(await instance.close(signal())).toEqual({ complete: true });
    expect(await instance.close(signal())).toEqual({ complete: true });
    expect((await instance.maintenance.getMaintenanceCensus('owner')).pendingWrites).toBe(0);
    expect(instance.maintenance.resumeAdmissions('owner')).toBe(false);
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

describe('original PDF scope through actual worker and built child', () => {
  function document(): Buffer {
    const stream = 'BT /F1 10 Tf 10 50 Td (Synthetic source) Tj ET';
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ];
    let text = '%PDF-1.4\n';
    const offsets = [0];
    for (const [i, item] of objects.entries()) {
      offsets.push(Buffer.byteLength(text));
      text += `${i + 1} 0 obj\n${item}\nendobj\n`;
    }
    const offset = Buffer.byteLength(text);
    text +=
      `xref\n0 ${offsets.length}\n0000000000 65535 f \n` +
      offsets
        .slice(1)
        .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
        .join('');
    return Buffer.from(
      text + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
    );
  }
  function composition() {
    const bytes = document();
    const input = {
      ...subject(),
      mediaType: 'application/pdf',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    let original: UploadSecurityExecution | undefined;
    let pages = 0;
    let retire = true;
    const calls: unknown[] = [];
    const receipt = (): UploadSecurityScopeReceipt | null =>
      original?.custody.kind === 'pdf-ocr' && retire
        ? {
            version: 1,
            scope: original.custody.scope,
            state: 'retired',
            writerStopped: true,
            transientDataRemoved: true,
            dispatchedPages: Array.from({ length: pages }, (_, index) => index + 1),
          }
        : null;
    const session = {
      readPage: jest.fn(async () => {
        pages++;
        return { complete: true, readable: true, text: 'Synthetic text' };
      }),
      close: jest.fn(async () => receipt()),
      cancel: jest.fn(async () => receipt()),
      localCopiesRemoved: () => true,
    };
    const prepare = jest.fn<
      ReturnType<SecurityPdfOcrProvider['prepare']>,
      Parameters<SecurityPdfOcrProvider['prepare']>
    >(async (value) => {
      calls.push({
        execution: value.execution,
        workDeadline: value.workDeadline,
        cleanupDeadline: value.cleanupDeadline,
      });
      original ??= {
        ...value.execution,
        custody: {
          kind: 'pdf-ocr',
          scope: {
            version: 1,
            scopeId: 'scope-fixture',
            attemptId: value.execution.attemptId,
            scannerInstanceId: value.execution.instanceId,
            scannerExecutionId: value.execution.executionId,
            expiresAt: value.execution.expiresAt,
            documentSha256: input.sha256,
            pageLimit: 32,
            requestIdScheme: 'cortex-ocr-page-sha256-v1',
            workDeadline: value.workDeadline,
            cleanupDeadline: value.cleanupDeadline,
            providerBinding: {
              podUid: 'pod-fixture',
              containerId: 'a'.repeat(64),
              runtimeImage: 'registry.invalid/ocr@sha256:' + 'b'.repeat(64),
              sourceManifestSha256: 'c'.repeat(64),
              modelRevision: 'aaa02f3811945a91062062994c5c4a3f4c0af2b0',
              profileSha256: 'd'.repeat(64),
              apiIncarnation: 'api-fixture',
              engineIncarnation: 'engine-fixture',
              workerIncarnation: 'worker-fixture',
            },
          },
        },
      };
      return original;
    });
    const provider: SecurityPdfOcrProvider = { prepare, open: () => session };
    const launcher = {
      run: jest.fn(
        async (
          request: Parameters<
            NonNullable<Parameters<typeof createSecurityWorker>[0]['pdf']>['launcher']['run']
          >[0],
        ) => {
          const child = spawn(
            process.execPath,
            [join(__dirname, '../../../dist/uploads/security/pdf-child.cjs')],
            {
              stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
              env: { NODE_ENV: 'test' },
            },
          );
          const joined = new Promise<void>((resolve) => child.once('close', () => resolve()));
          try {
            return await observeSecurityProcess({ child, ...request });
          } finally {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            await joined;
          }
        },
      ),
    };
    const instance = worker({ pdf: { provider, launcher } });
    return {
      bytes,
      input,
      prepare,
      instance,
      provider,
      launcher,
      session,
      calls,
      unknown: () => {
        retire = false;
      },
      known: () => {
        retire = true;
      },
    };
  }
  it('does no content work before prepare returns and joins actual parser/pages plus original provider before approval', async () => {
    const test = composition();
    const execution = await test.instance.prepare({
      attemptId: 'upload.1',
      subject: test.input,
      signal: signal(),
    });
    expect(test.session.readPage).not.toHaveBeenCalled();
    expect(test.launcher.run).not.toHaveBeenCalled();
    const result = await test.instance.inspect({
      execution,
      subject: test.input,
      signal: signal(),
      body: (async function* () {
        yield test.bytes;
      })(),
    });
    expect(result.decision).toMatchObject({
      decision: 'approved',
      coverage: { complete: true, pages: 1, parts: 1 },
    });
    expect(result.settlement).toMatchObject({
      execution,
      writerStopped: true,
      transientDataRemoved: true,
      providerReceipt: { state: 'retired', dispatchedPages: [1] },
    });
    expect(test.session.close).toHaveBeenCalledTimes(1);
    expect(test.launcher.run).toHaveBeenCalledTimes(1);
  });
  it('retries lost inert prepare acknowledgement with the same original IDs and both cutoffs', async () => {
    const test = composition();
    const implementation = test.prepare.getMockImplementation()!;
    test.prepare.mockImplementationOnce(async (input) => {
      await implementation(input);
      throw new Error('fixture-lost-ack');
    });
    await expect(
      test.instance.prepare({ attemptId: 'upload.1', subject: test.input, signal: signal() }),
    ).rejects.toThrow();
    expect(test.session.readPage).not.toHaveBeenCalled();
    const execution = await test.instance.prepare({
      attemptId: 'upload.1',
      subject: test.input,
      signal: signal(),
    });
    expect(test.calls).toHaveLength(2);
    expect(test.calls[0]).toEqual(test.calls[1]);
    expect(await test.instance.cancel({ execution, signal: signal() })).toMatchObject({
      providerReceipt: { state: 'retired', dispatchedPages: [] },
    });
  });
  it('withholds a complete local parse while the original API retirement is unknown, then observes only that scope', async () => {
    const test = composition();
    const execution = await test.instance.prepare({
      attemptId: 'upload.1',
      subject: test.input,
      signal: signal(),
    });
    test.unknown();
    await expect(
      test.instance.inspect({
        execution,
        subject: test.input,
        signal: signal(),
        body: (async function* () {
          yield test.bytes;
        })(),
      }),
    ).rejects.toThrow();
    expect(await test.instance.maintenance.getMaintenanceCensus(null)).toMatchObject({
      pendingWrites: 1,
      complete: false,
    });
    expect(await test.instance.cancel({ execution, signal: signal() })).toMatchObject({
      providerReceipt: null,
    });
    test.known();
    expect(await test.instance.cancel({ execution, signal: signal() })).toMatchObject({
      providerReceipt: { state: 'retired' },
    });
    expect(test.session.readPage).toHaveBeenCalledTimes(1);
  });
  it('a replacement scanner cannot combine remote retirement with invented original local cleanup', async () => {
    const test = composition();
    const execution = await test.instance.prepare({
      attemptId: 'upload.1',
      subject: test.input,
      signal: signal(),
    });
    const replacement = worker({ pdf: { provider: test.provider, launcher: test.launcher } });
    expect(await replacement.cancel({ execution, signal: signal() })).toMatchObject({
      writerStopped: false,
      transientDataRemoved: false,
      providerReceipt: { state: 'retired', dispatchedPages: [] },
    });
    expect(test.launcher.run).not.toHaveBeenCalled();
  });
});
