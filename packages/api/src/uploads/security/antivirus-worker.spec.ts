/** Actual worker/public receipt readers with inert external AV and classifier process ports. No engine qualification. */
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import {
  isCompleteUploadSecuritySettlement,
  matchesUploadSecurityApproval,
} from 'librechat-data-provider';
import type { UploadSecuritySubject } from 'librechat-data-provider';
import { createInertAntivirusFixture } from './antivirus-fixture.helper';
import { createSecurityWorker } from './worker';

jest.mock('node:worker_threads', () => ({
  Worker: jest.fn().mockImplementation(() => {
    const { EventEmitter } = jest.requireActual<typeof import('node:events')>('node:events');
    const thread = new EventEmitter();
    thread.stdout = { resume() {} };
    thread.stderr = { resume() {} };
    thread.terminate = async () => {
      thread.emit('exit', 0);
      return 0;
    };
    queueMicrotask(() => {
      thread.emit(
        'message',
        JSON.stringify({ decision: 'clear', coverage: { complete: true, pages: 1, parts: 1 } }),
      );
      thread.emit('exit', 0);
    });
    return thread;
  }),
}));

const bytes = Buffer.from('Harmloser eigener Upload');
const subject = (): UploadSecuritySubject => ({
  tenantId: 'tenant',
  userId: 'user',
  operationId: 'upload',
  transferGeneration: 1,
  mediaType: 'text/plain',
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
});
const signal = () => AbortSignal.timeout(3000);
function fixture() {
  const av = createInertAntivirusFixture({ requireBinding: true });
  const worker = createSecurityWorker({
    antivirus: av.runtime,
    instanceId: '11111111-1111-4111-8111-111111111111',
    policy: { version: 1, markings: ['GEHEIM'], labels: ['Einstufung'] },
    policySha256: '2'.repeat(64),
    threadPath: '/owned/inert-classifier.cjs',
  });
  return { ...av, worker };
}

async function* body(events: string[], value: Uint8Array = bytes) {
  events.push('body');
  yield value;
}
beforeEach(() => jest.clearAllMocks());

describe('actual worker with mandatory original antivirus', () => {
  it('binds Execution3 then returns Approval2 only after AV/classifier/original join', async () => {
    const f = fixture();
    const input = subject();
    const execution = await f.worker.prepare({
      attemptId: 'upload.1',
      subject: input,
      signal: signal(),
    });
    expect(execution.version).toBe(3);
    expect(f.events).toEqual(['prepare']);
    f.bind();
    const result = await f.worker.inspect({
      execution,
      subject: input,
      body: body(f.events),
      signal: signal(),
    });
    expect(f.events).toEqual(['prepare', 'activate', 'body', 'scan', 'retire']);
    expect(result.decision).toMatchObject({
      version: 2,
      decision: 'approved',
      antivirus: { custody: execution.antivirus },
    });
    expect(matchesUploadSecurityApproval(result.decision, input, '2'.repeat(64), Date.now())).toBe(
      true,
    );
    expect(isCompleteUploadSecuritySettlement(result.settlement, execution)).toBe(true);
    expect(await f.worker.close(signal())).toEqual({ complete: true });
  });
  it('reads no user bytes if original activation fails before the durable binding', async () => {
    const f = fixture();
    const input = subject();
    const execution = await f.worker.prepare({
      attemptId: 'upload.1',
      subject: input,
      signal: signal(),
    });
    const result = await f.worker.inspect({
      execution,
      subject: input,
      body: body(f.events),
      signal: signal(),
    });
    expect(f.events).not.toContain('body');
    expect(f.events).not.toContain('scan');
    expect(result.decision.decision).not.toBe('approved');
    expect(f.preparations()).toBe(1);
    await f.worker.close(signal());
  });
  it('does not classify or approve malware, and still joins the original', async () => {
    const f = fixture();
    f.bind();
    f.malware();
    const input = subject();
    const execution = await f.worker.prepare({
      attemptId: 'upload.1',
      subject: input,
      signal: signal(),
    });
    const result = await f.worker.inspect({
      execution,
      subject: input,
      body: body(f.events),
      signal: signal(),
    });
    expect(result.decision).toEqual({ version: 1, decision: 'rejected', reason: 'malware' });
    expect(Worker).not.toHaveBeenCalled();
    expect(isCompleteUploadSecuritySettlement(result.settlement, execution)).toBe(true);
    await f.worker.close(signal());
  });
  it('retains unknown original retirement and reobserves the same custody instead of preparing again', async () => {
    const f = fixture();
    f.bind();
    const input = subject();
    const execution = await f.worker.prepare({
      attemptId: 'upload.1',
      subject: input,
      signal: signal(),
    });
    f.unknown();
    await expect(
      f.worker.inspect({ execution, subject: input, body: body(f.events), signal: signal() }),
    ).rejects.toThrow();
    const pending = await f.worker.cancel({ execution, signal: signal() });
    expect(isCompleteUploadSecuritySettlement(pending, execution)).toBe(false);
    expect(f.preparations()).toBe(1);
    f.settle();
    const settled = await f.worker.cancel({ execution, signal: signal() });
    expect(isCompleteUploadSecuritySettlement(settled, execution)).toBe(true);
    expect(f.preparations()).toBe(1);
    await f.worker.close(signal());
  });
  it('rejects substituted AV custody before reading or starting another original', async () => {
    const f = fixture();
    f.bind();
    const input = subject();
    const execution = await f.worker.prepare({
      attemptId: 'upload.1',
      subject: input,
      signal: signal(),
    });
    const forged = JSON.parse(JSON.stringify(execution));
    forged.antivirus.original.configurationSha256 = '3'.repeat(64);
    await expect(
      f.worker.inspect({
        execution: forged,
        subject: input,
        body: body(f.events),
        signal: signal(),
      }),
    ).rejects.toThrow();
    expect(f.events).not.toContain('body');
    expect(f.preparations()).toBe(1);
    await f.worker.cancel({ execution, signal: signal() });
    await f.worker.close(signal());
  });
  it('keeps a subject hash mismatch unapproved without passing bytes to AV', async () => {
    const f = fixture();
    f.bind();
    const input = subject();
    const execution = await f.worker.prepare({
      attemptId: 'upload.1',
      subject: input,
      signal: signal(),
    });
    const changed = Buffer.from(bytes);
    changed[0] ^= 1;
    const result = await f.worker.inspect({
      execution,
      subject: input,
      body: body(f.events, changed),
      signal: signal(),
    });
    expect(result.decision).toEqual({
      version: 1,
      decision: 'uninspectable',
      reason: 'invalid_content',
    });
    expect(f.events).not.toContain('scan');
    await f.worker.close(signal());
  });
});
