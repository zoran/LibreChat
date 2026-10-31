/** Bounded local scanner execution; receipts are volatile, durable ownership belongs to Upload. */
import { isAbsolute } from 'node:path';
import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { createHash, randomUUID } from 'node:crypto';
import {
  readUploadOcrDispatchObservation,
  readUploadSecurityExecution,
  matchesUploadSecurityExecution,
  readUploadSecuritySubject,
  isUploadSecurityDecision,
  isCompleteUploadSecuritySettlement,
  readUploadSecurityScopeReceipt,
} from 'librechat-data-provider';
import type {
  UploadSecurityExecution,
  UploadSecuritySettlement,
  UploadSecuritySubject,
  UploadSecurityInspection,
  UploadSecurityDecision,
  UploadSecurityReason,
  UploadSecurityScopeReceipt,
  UploadAntivirusReceipt,
} from 'librechat-data-provider';
import type { SecurityPdfOcrProvider, SecurityPdfOcrSession } from './pdf-ocr';
import type { AntivirusRuntime, AntivirusSession } from './antivirus-runtime';
import type { createSecurityProcessLauncher } from './process-launcher';
import type { SecurityMarkingPolicy } from './markings';
import type { UploadSecurityPort } from '../contract';
import type { ApplicationWorkPort } from '~/app';
import { waitForSecurityWorker as wait } from './cancellation';
import { encodeSecurityProcessRequest } from './process-wire';
import { SECURITY_INSPECTION_VERSION } from './inspection';
import { inspectSecurityMarkings } from './markings';

export type SecurityWorker = UploadSecurityPort & {
  maintenance: ApplicationWorkPort;
  close(signal: AbortSignal): Promise<{ complete: boolean }>;
};

type Options = {
  antivirus: AntivirusRuntime;
  instanceId: string;
  policy: SecurityMarkingPolicy;
  policySha256: string;
  threadPath: string;
  now?: () => number;
  maxActive?: number;
  ttlMs?: number;
  pdf?: {
    provider: SecurityPdfOcrProvider;
    launcher: ReturnType<typeof createSecurityProcessLauncher>;
  };
};
type RecordState = {
  antivirus: AntivirusSession;
  antivirusReceipt: UploadAntivirusReceipt | null;
  execution: UploadSecurityExecution;
  subject: UploadSecuritySubject;
  state: 'prepared' | 'running' | 'finished';
  controller: AbortController;
  done: Promise<void>;
  active: boolean;
  inputStopped: boolean;
  threadStopped: boolean;
  bytesRemoved: boolean;
  thread?: Worker;
  preparation?: { workDeadline: number; cleanupDeadline: number; flight?: Promise<void> };
  provider?: SecurityPdfOcrSession;
  providerReceipt?: UploadSecurityScopeReceipt | null;
  retirement?: Promise<void>;
  processCopiesRemoved: boolean;
  localDeadline: number;
};
const unavailable = () => new Error('Security worker unavailable');
class ScanFailure extends Error {
  constructor(readonly reason: UploadSecurityReason) {
    super('Security inspection failed');
  }
}

/** ThreadPath/policy are trusted composition, never request data. No process/pod sandbox claim. */
export function createSecurityWorker(options: Options): SecurityWorker {
  if (!options.antivirus?.available()) throw unavailable();
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
  let pausedBy: string | null = null;
  function snapshot(record: RecordState) {
    return readUploadSecurityExecution(record.execution)!;
  }
  function settlement(
    execution: UploadSecurityExecution,
    record?: RecordState,
  ): UploadSecuritySettlement {
    const stopped =
      !!record &&
      record.state === 'finished' &&
      record.inputStopped &&
      record.threadStopped &&
      (!record.preparation || !!record.provider);
    return {
      execution: readUploadSecurityExecution(execution)!,
      antivirusReceipt: record?.antivirusReceipt ?? null,
      writerStopped: stopped && record?.antivirusReceipt?.originalProcessJoined === true,
      transientDataRemoved:
        stopped &&
        record?.antivirusReceipt?.ownedTransientDataRemoved === true &&
        !!record?.bytesRemoved &&
        !!record.processCopiesRemoved &&
        (!record.provider || record.provider.localCopiesRemoved()),
      ...(execution.custody.kind === 'pdf-ocr'
        ? { providerReceipt: record?.providerReceipt ?? null }
        : {}),
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
    if (record.controller.signal.aborted) return;
    record.controller.abort();
    if (record.state === 'prepared') record.state = 'finished';
    if (record.thread) void record.thread.terminate().catch(() => {});
    if (!record.active) void retire(record, true);
  }
  async function retire(record: RecordState, cancel: boolean): Promise<void> {
    if (record.retirement) return record.retirement;
    record.retirement = (async () => {
      record.antivirusReceipt = await record.antivirus.retire();
      if (!record.preparation) return;
      try {
        await record.preparation!.flight;
      } catch {
        /* Original prepare remains unresolved. */
      }
      if (!record.provider || record.execution.custody.kind !== 'pdf-ocr') return;
      const remaining = Math.floor(record.execution.custody.scope.cleanupDeadline * 1000 - now());
      if (remaining <= 0) return;
      try {
        const signal = AbortSignal.timeout(Math.min(31_000, remaining));
        const receipt = await (cancel
          ? record.provider.cancel(signal)
          : record.provider.close(signal));
        record.providerReceipt = readUploadSecurityScopeReceipt(receipt, record.execution);
      } catch {
        /* The original scope stays held; no replacement or renewed cutoff. */
      }
    })().finally(() => {
      record.retirement = undefined;
    });
    return record.retirement;
  }
  async function preparePdf(record: RecordState, signal: AbortSignal): Promise<void> {
    if (!record.preparation || record.provider) return;
    if (!record.preparation.flight) {
      const preparation = record.preparation;
      preparation.flight = (async () => {
        const execution = readUploadSecurityExecution(
          await options.pdf!.provider.prepare({
            execution: snapshot(record),
            subject: { ...record.subject },
            workDeadline: preparation.workDeadline,
            cleanupDeadline: preparation.cleanupDeadline,
            signal,
          }),
        );
        if (
          !execution ||
          execution.custody.kind !== 'pdf-ocr' ||
          execution.attemptId !== record.execution.attemptId ||
          execution.instanceId !== record.execution.instanceId ||
          execution.executionId !== record.execution.executionId ||
          execution.expiresAt !== record.execution.expiresAt ||
          execution.custody.scope.documentSha256 !== record.subject.sha256 ||
          execution.custody.scope.workDeadline !== preparation.workDeadline ||
          execution.custody.scope.cleanupDeadline !== preparation.cleanupDeadline
        )
          throw unavailable();
        record.execution = execution;
        record.provider = options.pdf!.provider.open(execution);
      })().finally(() => {
        preparation.flight = undefined;
      });
    }
    const flight = record.preparation.flight;
    if (!flight) throw unavailable();
    await wait(flight, signal);
    if (record.controller.signal.aborted) {
      await retire(record, true);
      throw unavailable();
    }
  }
  function census() {
    let queuedContinuations = 0;
    let pendingWrites = 0;
    for (const record of records.values()) {
      if (record.state === 'prepared' && now() >= Date.parse(record.execution.expiresAt))
        stop(record);
      if (record.state === 'prepared') queuedContinuations++;
      else if (
        record.active ||
        record.retirement ||
        !isCompleteUploadSecuritySettlement(settlement(record.execution, record), record.execution)
      )
        pendingWrites++;
    }
    if (!pendingWrites && options.antivirus.pending()) pendingWrites++;
    return { queuedContinuations, pendingWrites };
  }
  const maintenance: ApplicationWorkPort = {
    pauseAdmissions(requestId) {
      if (
        closed ||
        typeof requestId !== 'string' ||
        !requestId ||
        (pausedBy !== null && pausedBy !== requestId)
      )
        return false;
      pausedBy = requestId;
      return true;
    },
    resumeAdmissions(requestId) {
      if (closed || pausedBy === null || pausedBy !== requestId) return false;
      const counts = census();
      if (counts.queuedContinuations || counts.pendingWrites) return false;
      pausedBy = null;
      return true;
    },
    async getMaintenanceCensus(requestId) {
      const counts = census();
      return {
        admissionClosed: requestId !== null && pausedBy === requestId,
        ...counts,
        complete: (pausedBy === null || pausedBy === requestId) && counts.pendingWrites === 0,
      };
    },
  };
  function live(record: RecordState) {
    if (
      record.controller.signal.aborted ||
      performance.now() >= record.localDeadline ||
      now() >=
        (record.preparation
          ? record.preparation.workDeadline * 1000
          : Date.parse(record.execution.expiresAt))
    ) {
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
      Math.max(
        1,
        Math.min(
          record.localDeadline - performance.now(),
          (record.preparation
            ? record.preparation.workDeadline * 1000
            : Date.parse(record.execution.expiresAt)) - now(),
        ),
      ),
    );
    timer.unref();
    try {
      iterator = body[Symbol.asyncIterator]();
      await record.antivirus.activate(record.controller.signal);
      live(record);
      if (record.subject.bytes > (record.preparation ? 4 * 1024 * 1024 : 65_536))
        throw new ScanFailure('resource_limit');
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
      const antivirus = await record.antivirus.inspect(bytes, record.controller.signal);
      if (antivirus.verdict !== 'clean') {
        if (antivirus.verdict === 'malicious') throw new ScanFailure('malware');
        if (antivirus.reason === 'encrypted') throw new ScanFailure('encrypted');
        if (antivirus.reason === 'resource_limit') throw new ScanFailure('resource_limit');
        throw new ScanFailure('scanner_unavailable');
      }
      let result: unknown;
      if (record.preparation) {
        if (!record.provider || !options.pdf) throw unavailable();
        const request = encodeSecurityProcessRequest({
          mediaType: 'application/pdf',
          policy,
          bytes,
        });
        record.threadStopped = false;
        record.processCopiesRemoved = false;
        try {
          const observed = await options.pdf.launcher.run({
            request,
            signal: record.controller.signal,
            timeoutMs: Math.max(
              1,
              Math.floor(
                Math.min(
                  record.localDeadline - performance.now(),
                  record.preparation.workDeadline * 1000 - now(),
                ),
              ),
            ),
            ocr: record.provider,
          });
          record.threadStopped = observed.directChildStopped;
          record.processCopiesRemoved = observed.localCopiesRemoved;
          if (
            observed.transportComplete &&
            !observed.diagnostics &&
            observed.directChildStopped &&
            observed.localCopiesRemoved
          )
            result = observed.result;
        } finally {
          request.fill(0);
        }
      } else result = await launch(record, bytes);
      live(record);
      if (
        result &&
        typeof result === 'object' &&
        Object.keys(result).length === 2 &&
        'decision' in result &&
        result.decision === 'clear' &&
        'coverage' in result
      ) {
        const candidate = {
          version: 2,
          decision: 'approved',
          antivirus: antivirus.approval,
          subject: { ...record.subject },
          policySha256,
          scannerVersion: SECURITY_INSPECTION_VERSION,
          checkedAt: new Date(now()).toISOString(),
          coverage: result.coverage,
        };
        if (isUploadSecurityDecision(candidate) && candidate.decision === 'approved')
          decision = candidate;
      } else {
        const candidate = result && typeof result === 'object' ? { version: 1, ...result } : null;
        if (isUploadSecurityDecision(candidate) && candidate.decision !== 'approved')
          decision = candidate;
      }
    } catch (error) {
      if (error instanceof ScanFailure)
        decision =
          error.reason === 'malware'
            ? { version: 1, decision: 'rejected', reason: 'malware' }
            : { version: 1, decision: 'uninspectable', reason: error.reason };
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
      await retire(record, record.controller.signal.aborted);
    }
    const proof = settlement(record.execution, record);
    if (
      !isCompleteUploadSecuritySettlement(proof, record.execution) ||
      record.controller.signal.aborted
    )
      throw unavailable();
    return { decision, settlement: proof };
  }
  return {
    dispatchObservation() {
      const counts = options.pdf?.provider.dispatchCounts?.();
      return counts
        ? readUploadOcrDispatchObservation({
            version: 1,
            source: { instanceId, pid: process.pid, startedAt: performance.timeOrigin },
            observedAt: now(),
            counts,
          })
        : null;
    },
    policySha256,
    maintenance,
    async prepare(input: {
      attemptId: string;
      subject: UploadSecuritySubject;
      signal: AbortSignal;
    }) {
      if (closed || pausedBy !== null || input.signal.aborted) throw unavailable();
      const subject = readUploadSecuritySubject(input.subject);
      if (!subject || input.attemptId !== `${subject.operationId}.${subject.transferGeneration}`)
        throw unavailable();
      // Settled expired receipts can be evicted; the durable Upload binding fences attempt reuse.
      for (const [key, record] of records) {
        if (record.state === 'prepared' && now() >= Date.parse(record.execution.expiresAt))
          stop(record);
        if (
          isCompleteUploadSecuritySettlement(
            settlement(record.execution, record),
            record.execution,
          ) &&
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
        await preparePdf(previous, input.signal);
        live(previous);
        return snapshot(previous);
      }
      if (
        records.size >= 256 ||
        (subject.mediaType === 'application/pdf' && (!options.pdf || ttlMs <= 1000))
      )
        throw unavailable();
      const started = now();
      const expiresAt = options.antivirus.deadline(new Date(started + ttlMs).toISOString());
      const antivirus = await options.antivirus.prepare(subject, expiresAt);
      const execution = readUploadSecurityExecution({
        version: 3,
        antivirus: antivirus.custody,
        custody: { kind: 'none' as const },
        attemptId: input.attemptId,
        instanceId,
        executionId: randomUUID(),
        expiresAt,
      });
      if (!execution) {
        await antivirus.retire();
        throw unavailable();
      }
      const record: RecordState = {
        antivirus,
        antivirusReceipt: null,
        execution,
        subject,
        state: 'prepared',
        controller: new AbortController(),
        done: Promise.resolve(),
        active: false,
        inputStopped: true,
        threadStopped: true,
        bytesRemoved: true,
        processCopiesRemoved: true,
        localDeadline:
          performance.now() +
          (subject.mediaType === 'application/pdf'
            ? Math.min(30_000, Date.parse(expiresAt) - started - 1000)
            : Date.parse(expiresAt) - started),
        ...(subject.mediaType === 'application/pdf'
          ? {
              preparation: {
                workDeadline: Math.min(started + 30_000, Date.parse(expiresAt) - 1000) / 1000,
                cleanupDeadline: Math.min(started + 31_000, Date.parse(expiresAt)) / 1000,
              },
              providerReceipt: null,
            }
          : {}),
      };
      records.set(input.attemptId, record);
      try {
        await preparePdf(record, input.signal);
        live(record);
        return snapshot(record);
      } catch (error) {
        stop(record);
        await retire(record, true);
        throw error;
      }
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
        (record.preparation && !record.provider) ||
        record.state !== 'prepared' ||
        !subject ||
        JSON.stringify(subject) !== JSON.stringify(record.subject) ||
        [...records.values()].filter((item) => item.state === 'running').length >= maxActive
      )
        throw unavailable();
      live(record);
      record.state = 'running';
      record.active = true;
      record.inputStopped = false;
      const abort = () => stop(record);
      input.signal.addEventListener('abort', abort, { once: true });
      const task = run(record, input.body);
      record.done = task
        .then(
          () => {},
          () => {},
        )
        .finally(() => {
          record.active = false;
          input.signal.removeEventListener('abort', abort);
        });
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
      if (record) await retire(record, true);
      // A replacement scanner may retire the original provider but cannot attest old local copies.
      if (!record && execution.custody.kind === 'pdf-ocr' && options.pdf) {
        const proof = settlement(execution);
        try {
          proof.providerReceipt = readUploadSecurityScopeReceipt(
            await options.pdf.provider.open(execution).cancel(input.signal),
            execution,
          );
        } catch {
          /* held */
        }
        return proof;
      }
      return settlement(execution, record);
    },
    async close(signal: AbortSignal): Promise<{ complete: boolean }> {
      if (!closed) {
        closed = true;
        for (const record of records.values()) stop(record);
      }
      try {
        await wait(
          Promise.all(
            [...records.values()].map(async (record) => {
              await record.done;
              await retire(record, true);
            }),
          ),
          signal,
        );
      } catch {
        return { complete: false };
      }
      const av = await options.antivirus.drain();
      return {
        complete:
          av.complete &&
          [...records.values()].every((record) =>
            isCompleteUploadSecuritySettlement(
              settlement(record.execution, record),
              record.execution,
            ),
          ),
      };
    },
  };
}
