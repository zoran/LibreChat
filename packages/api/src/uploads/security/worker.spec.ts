import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stat, writeFile } from 'node:fs/promises';
import { matchesUploadSecurityApproval } from 'librechat-data-provider';
import { createSecurityWorkerFixture } from './worker-fixture.helper';
import { antivirusReceiptFixture } from './antivirus-fixture.helper';
import { SECURITY_INSPECTION_VERSION } from './inspection';
const fixture = createSecurityWorkerFixture();
const { policySha256, complete, signal, subject, body, worker } = fixture;
describe('bounded security worker', () => {
  async function inspectThreadResult(result: unknown) {
    const threadPath = join(fixture.directory, `${randomUUID()}.js`);
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
      antivirusReceipt: antivirusReceiptFixture(execution),
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
      antivirusReceipt: antivirusReceiptFixture(execution),
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
      antivirusReceipt: antivirusReceiptFixture(execution),
      writerStopped: true,
      transientDataRemoved: true,
    });
  });
  it.each([
    ['Name,Wert\nEinstufung,GEHEIM', 'rejected', 'classification_marking'],
    ['Begriff,GEHEIM', 'uninspectable', 'ambiguous_marking'],
    ['Name,Wert\nNotiz,"=1+1"', 'uninspectable', 'invalid_content'],
    ['a,b\nc', 'uninspectable', 'invalid_content'],
    ['a'.repeat(65537), 'uninspectable', 'resource_limit'],
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
        antivirusReceipt: antivirusReceiptFixture(execution),
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
      antivirusReceipt: antivirusReceiptFixture(execution),
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
      antivirusReceipt: null,
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
    const instance = worker({ threadPath: join(fixture.directory, 'no-exit.js'), ttlMs: 1000 });
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
    while (!(await stat(join(fixture.directory, 'thread-started')).catch(() => undefined))) {
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
    const instance = worker({ threadPath: join(fixture.directory, 'bad-exit.js') });
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
      subject('x'.repeat(65537)),
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
        body: body(input.bytes > 65536 ? 'x'.repeat(65537) : undefined),
        signal: signal(),
      });
      expect(result.decision).toEqual({
        version: 1,
        decision: 'uninspectable',
        reason: input.bytes > 65536 ? 'resource_limit' : 'invalid_content',
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
      antivirusReceipt: antivirusReceiptFixture(execution),
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
      antivirusReceipt: antivirusReceiptFixture(execution),
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
