/** Bounded local scanner execution; receipts are volatile, durable ownership belongs to Upload. */
import { isAbsolute } from 'node:path';
import { Worker } from 'node:worker_threads';
import { createHash, randomUUID } from 'node:crypto';
import {
  readUploadSecurityExecution,
  matchesUploadSecurityExecution,
  readUploadSecuritySubject,
  readUploadSecurityInspection,
} from 'librechat-data-provider';
import type {
  UploadSecurityExecution,
  UploadSecuritySettlement,
  UploadSecuritySubject,
  UploadSecurityInspection,
  UploadSecurityDecision,
  UploadSecurityReason,
} from 'librechat-data-provider';
import type { SecurityMarkingPolicy } from './markings';
import type { UploadSecurityPort } from '../contract';
import { inspectSecurityMarkings } from './markings';

export type SecurityWorker = UploadSecurityPort & {
  close(signal: AbortSignal): Promise<{ complete: boolean }>;
};

type Options = {
  instanceId: string;
  policy: SecurityMarkingPolicy;
  policySha256: string;
  threadPath: string;
  now?: () => number;
  maxActive?: number;
  ttlMs?: number;
};
type RecordState = {
  execution: UploadSecurityExecution;
  subject: UploadSecuritySubject;
  state: 'prepared' | 'running' | 'finished';
  controller: AbortController;
  done: Promise<void>;
  inputStopped: boolean;
  threadStopped: boolean;
  bytesRemoved: boolean;
  thread?: Worker;
};
const unavailable = () => new Error('Security worker unavailable');
class ScanFailure extends Error {
  constructor(readonly reason: UploadSecurityReason) {
    super('Security inspection failed');
  }
}
async function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw unavailable();
  let abort = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(unavailable());
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** ThreadPath/policy are trusted composition, never request data. No process/pod sandbox claim. */
export function createSecurityWorker(options: Options): SecurityWorker {
  const now = options.now ?? Date.now;
  const maxActive = options.maxActive ?? 1;
  const ttlMs = options.ttlMs ?? 60_000;
  const policySha256 = options.policySha256;
  const { threadPath, instanceId } = options;
  const validation = inspectSecurityMarkings(options.policy, {
    version: 1,
    coverage: { complete: true, pages: 1, parts: 1 },
    units: [{ part: 1, page: 1, placement: 'body', text: '' }],
  });
  if (
    !isAbsolute(threadPath) ||
    !/^[a-f0-9]{64}$/.test(policySha256) ||
    !Number.isInteger(maxActive) ||
    maxActive < 1 ||
    maxActive > 4 ||
    !Number.isInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > 600_000 ||
    validation.decision !== 'clear'
  )
    throw unavailable();
  const policy: SecurityMarkingPolicy = JSON.parse(JSON.stringify(options.policy));
  const records = new Map<string, RecordState>();
  let closed = false;
  function snapshot(record: RecordState) {
    return { ...record.execution };
  }
  function settlement(
    execution: UploadSecurityExecution,
    record?: RecordState,
  ): UploadSecuritySettlement {
    const stopped =
      !!record && record.state === 'finished' && record.inputStopped && record.threadStopped;
    return {
      execution: { ...execution },
      writerStopped: stopped,
      transientDataRemoved: stopped && !!record?.bytesRemoved,
    };
  }
  function find(value: UploadSecurityExecution) {
    const execution = readUploadSecurityExecution(value);
    if (!execution) throw unavailable();
    const record = records.get(execution.attemptId);
    return {
      execution,
      record:
        record && matchesUploadSecurityExecution(execution, record.execution) ? record : undefined,
    };
  }
  function stop(record: RecordState) {
    record.controller.abort();
    if (record.state === 'prepared') record.state = 'finished';
    if (record.thread) void record.thread.terminate().catch(() => {});
  }
  function live(record: RecordState) {
    if (record.controller.signal.aborted || now() >= Date.parse(record.execution.expiresAt)) {
      stop(record);
      throw unavailable();
    }
  }
  function launch(record: RecordState, bytes: Uint8Array): Promise<unknown> {
    return new Promise((resolve) => {
      let message: unknown;
      let messages = 0;
      let failed = false;
      try {
        const thread = new Worker(threadPath, {
          workerData: { bytes, mediaType: record.subject.mediaType, policy },
          transferList: [bytes.buffer as ArrayBuffer],
          env: {},
          execArgv: [],
          stdout: true,
          stderr: true,
          resourceLimits: {
            maxOldGenerationSizeMb: 32,
            maxYoungGenerationSizeMb: 8,
            stackSizeMb: 2,
          },
        });
        record.thread = thread;
        record.threadStopped = false;
        thread.stdout.resume();
        thread.stderr.resume();
        thread.on('message', (value: unknown) => {
          messages++;
          message = value;
        });
        thread.on('error', () => {
          failed = true;
        });
        thread.once('exit', (code) => {
          record.threadStopped = true;
          record.thread = undefined;
          if (
            !failed &&
            code === 0 &&
            messages === 1 &&
            typeof message === 'string' &&
            message.length <= 512
          ) {
            try {
              resolve(JSON.parse(message));
            } catch {
              resolve(null);
            }
          } else resolve(null);
        });
      } catch {
        resolve(null);
      }
    });
  }
  async function run(
    record: RecordState,
    body: AsyncIterable<Uint8Array>,
  ): Promise<UploadSecurityInspection> {
    let bytes = new Uint8Array(0);
    let iterator: AsyncIterator<Uint8Array> | undefined;
    let decision: UploadSecurityDecision = {
      version: 1,
      decision: 'uninspectable',
      reason: 'scanner_unavailable',
    };
    const timer = setTimeout(
      () => stop(record),
      Math.max(1, Date.parse(record.execution.expiresAt) - now()),
    );
    timer.unref();
    try {
      iterator = body[Symbol.asyncIterator]();
      if (record.subject.bytes > 65_536) throw new ScanFailure('resource_limit');
      bytes = new Uint8Array(record.subject.bytes);
      record.bytesRemoved = false;
      const hash = createHash('sha256');
      let length = 0;
      let chunks = 0;
      while (true) {
        live(record);
        const next = await iterator.next();
        if (next.done) {
          record.inputStopped = true;
          break;
        }
        live(record);
        if (++chunks > 4096) throw new ScanFailure('resource_limit');
        const chunk = next.value;
        if (
          !(chunk instanceof Uint8Array) ||
          chunk.buffer instanceof SharedArrayBuffer ||
          length + chunk.byteLength > bytes.byteLength
        )
          throw new ScanFailure('invalid_content');
        bytes.set(chunk, length);
        hash.update(bytes.subarray(length, length + chunk.byteLength));
        length += chunk.byteLength;
      }
      live(record);
      if (length !== record.subject.bytes || hash.digest('hex') !== record.subject.sha256)
        throw new ScanFailure('invalid_content');
      const result = await launch(record, bytes);
      live(record);
      if (
        result &&
        typeof result === 'object' &&
        Object.keys(result).length === 1 &&
        'decision' in result &&
        result.decision === 'clear'
      ) {
        decision = {
          version: 1,
          decision: 'approved',
          subject: { ...record.subject },
          policySha256,
          scannerVersion: 'txt-worker-v1',
          checkedAt: new Date(now()).toISOString(),
          coverage: { complete: true, pages: 1, parts: 1 },
        };
      } else {
        const parsed = readUploadSecurityInspection({
          decision: result && typeof result === 'object' ? { version: 1, ...result } : null,
          cleanup: { writerStopped: true, transientDataRemoved: true },
        });
        if (parsed && parsed.decision.decision !== 'approved') decision = parsed.decision;
      }
    } catch (error) {
      if (error instanceof ScanFailure)
        decision = { version: 1, decision: 'uninspectable', reason: error.reason };
    } finally {
      if (bytes.byteLength) bytes.fill(0);
      bytes = new Uint8Array(0);
      record.bytesRemoved = true;
      if (!record.inputStopped && iterator?.return) {
        try {
          record.inputStopped = (await iterator.return()).done === true;
        } catch {
          /* unknown */
        }
      }
      clearTimeout(timer);
      record.state = 'finished';
    }
    const proof = settlement(record.execution, record);
    if (!proof.writerStopped || !proof.transientDataRemoved || record.controller.signal.aborted)
      throw unavailable();
    return { decision, cleanup: { writerStopped: true, transientDataRemoved: true } };
  }
  return {
    policySha256,
    async prepare(input: {
      attemptId: string;
      subject: UploadSecuritySubject;
      signal: AbortSignal;
    }) {
      if (closed || input.signal.aborted) throw unavailable();
      const subject = readUploadSecuritySubject(input.subject);
      if (!subject || input.attemptId !== `${subject.operationId}.${subject.transferGeneration}`)
        throw unavailable();
      // Settled expired receipts can be evicted; the durable Upload binding fences attempt reuse.
      for (const [key, record] of records) {
        if (record.state === 'prepared' && now() >= Date.parse(record.execution.expiresAt))
          stop(record);
        if (
          settlement(record.execution, record).transientDataRemoved &&
          now() >= Date.parse(record.execution.expiresAt)
        )
          records.delete(key);
      }
      const previous = records.get(input.attemptId);
      if (previous) {
        live(previous);
        if (
          previous.state === 'finished' ||
          JSON.stringify(previous.subject) !== JSON.stringify(subject)
        )
          throw unavailable();
        return snapshot(previous);
      }
      if (records.size >= 256) throw unavailable();
      const execution = readUploadSecurityExecution({
        version: 1,
        attemptId: input.attemptId,
        instanceId,
        executionId: randomUUID(),
        expiresAt: new Date(now() + ttlMs).toISOString(),
      });
      if (!execution) throw unavailable();
      const record: RecordState = {
        execution,
        subject,
        state: 'prepared',
        controller: new AbortController(),
        done: Promise.resolve(),
        inputStopped: true,
        threadStopped: true,
        bytesRemoved: true,
      };
      records.set(input.attemptId, record);
      return snapshot(record);
    },
    async inspect(input: {
      execution: UploadSecurityExecution;
      subject: UploadSecuritySubject;
      body: AsyncIterable<Uint8Array>;
      signal: AbortSignal;
    }) {
      const { record } = find(input.execution);
      const subject = readUploadSecuritySubject(input.subject);
      if (
        closed ||
        input.signal.aborted ||
        !record ||
        record.state !== 'prepared' ||
        !subject ||
        JSON.stringify(subject) !== JSON.stringify(record.subject) ||
        [...records.values()].filter((item) => item.state === 'running').length >= maxActive
      )
        throw unavailable();
      live(record);
      record.state = 'running';
      record.inputStopped = false;
      const abort = () => stop(record);
      input.signal.addEventListener('abort', abort, { once: true });
      const task = run(record, input.body);
      record.done = task
        .then(
          () => {},
          () => {},
        )
        .finally(() => input.signal.removeEventListener('abort', abort));
      return wait(task, record.controller.signal);
    },
    async cancel(input: { execution: UploadSecurityExecution; signal: AbortSignal }) {
      const { execution, record } = find(input.execution);
      if (record) {
        stop(record);
        try {
          await wait(record.done, input.signal);
        } catch {
          /* no stop inference */
        }
      }
      return settlement(execution, record);
    },
    async close(signal: AbortSignal): Promise<{ complete: boolean }> {
      closed = true;
      for (const record of records.values()) stop(record);
      try {
        await wait(Promise.all([...records.values()].map((record) => record.done)), signal);
      } catch {
        return { complete: false };
      }
      return {
        complete: [...records.values()].every(
          (record) => settlement(record.execution, record).transientDataRemoved,
        ),
      };
    },
  };
}
