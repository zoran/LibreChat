/** Private IPC observation only; neither an approval nor proof of sandbox/process-tree cleanup. */
import { ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { Readable, Writable } from 'node:stream';
import { readSecurityProcessResult, SECURITY_PROCESS_LIMITS } from './process-wire';
import type { NegativeSecurityProcessResult } from './process-wire';

type Observation = {
  result: NegativeSecurityProcessResult | null;
  diagnostics: boolean;
  directChildStopped: boolean;
  transportComplete: boolean;
};

/** The trusted owner must pass its freshly, synchronously spawned child before consuming any pipe. */
export async function observeSecurityProcess(input: {
  child: ChildProcess;
  request: Uint8Array;
  signal: AbortSignal;
  timeoutMs?: number;
  cleanupMs?: number;
}): Promise<Observation> {
  const empty = (): Observation => ({
    result: null,
    diagnostics: false,
    directChildStopped: false,
    transportComplete: false,
  });
  if (!(input?.child instanceof ChildProcess)) return empty();
  const child = input.child;
  const started = performance.now();
  const within = (value: number, maximum: number) =>
    Number.isSafeInteger(value) && value > 0 && value <= maximum;
  const timeoutMs = input.timeoutMs ?? 30_000;
  const cleanupMs = input.cleanupMs ?? 1_000;
  const validLimits = within(timeoutMs, 30_000) && within(cleanupMs, 1_000);

  return new Promise((resolve) => {
    const stdin = child.stdin;
    const stdout = child.stdout;
    const stderr = child.stderr;
    const resultPipe = child.stdio[3];
    const untouchedOutputs = [stdout, stderr, resultPipe].every(
      (stream) =>
        stream instanceof Readable &&
        stream.readableFlowing === null &&
        stream.readableDidRead === false &&
        stream.listenerCount('data') === 0 &&
        stream.listenerCount('readable') === 0,
    );
    const priorDiagnostics = [stdout, stderr].some(
      (stream) => stream instanceof Readable && stream.readableDidRead === true,
    );
    const resultBuffer = Buffer.alloc(SECURITY_PROCESS_LIMITS.resultBytes);
    let requestBuffer: Buffer | null = null;
    let resultLength = 0;
    let diagnosticBytes = 0;
    let failed = false;
    let settled = false;
    let exitObserved = false;
    let cleanExit = false;
    let childClosed = false;
    let inputFinished = false;
    const ended = new Set<Readable>();
    const detach: Array<() => void> = [];
    const timers: {
      work?: ReturnType<typeof setTimeout>;
      cleanup?: ReturnType<typeof setTimeout>;
    } = {};

    const on = <Args extends unknown[]>(
      target: NodeJS.EventEmitter,
      name: string,
      listener: (...args: Args) => void,
    ) => {
      target.on(name, listener);
      detach.push(() => target.removeListener(name, listener));
    };
    const wipeRequest = () => {
      requestBuffer?.fill(0);
      requestBuffer = null;
    };
    const finish = (result: NegativeSecurityProcessResult | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timers.work);
      clearTimeout(timers.cleanup);
      for (const remove of detach) remove();
      resultBuffer.fill(0);
      wipeRequest();
      resolve({
        result,
        diagnostics: priorDiagnostics || diagnosticBytes > 0,
        directChildStopped: exitObserved,
        transportComplete: result !== null,
      });
    };
    const fail = () => {
      if (settled || failed) return;
      failed = true;
      clearTimeout(timers.work);
      // Only the owned native handle may be signalled; a successful kill is not an exit receipt.
      if (!exitObserved) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Absence of confirmed exit remains visible to the caller.
        }
      }
      for (const stream of [stdin, stdout, stderr, resultPipe]) {
        if (stream instanceof Readable || stream instanceof Writable) stream.destroy();
      }
      const remaining = Math.max(0, 30_000 - (performance.now() - started));
      timers.cleanup = setTimeout(finish, Math.min(validLimits ? cleanupMs : 1_000, remaining));
      if (childClosed) finish();
    };
    const complete = () => {
      if (settled) return;
      if (failed) {
        if (childClosed) finish();
        return;
      }
      if (!childClosed) return;
      if (
        !exitObserved ||
        !cleanExit ||
        !inputFinished ||
        ended.size !== 3 ||
        diagnosticBytes !== 0 ||
        performance.now() - started >= timeoutMs
      ) {
        fail();
        return;
      }
      finish(readSecurityProcessResult(resultBuffer.subarray(0, resultLength)));
    };
    on(child, 'error', fail);
    on(child, 'exit', (code: number | null, signal: NodeJS.Signals | null) => {
      exitObserved = true;
      cleanExit = code === 0 && signal === null;
      if (!cleanExit) fail();
    });
    on(child, 'close', () => {
      childClosed = true;
      complete();
    });

    for (const stream of [stdout, stderr, resultPipe]) {
      if (!(stream instanceof Readable)) continue;
      on(stream, 'error', fail);
      on(stream, 'end', () => ended.add(stream));
      on(stream, 'close', () => {
        if (!ended.has(stream)) fail();
      });
      on(stream, 'data', (chunk: unknown) => {
        if (settled) return;
        if (stream !== resultPipe) {
          const bytes = chunk instanceof Uint8Array ? chunk.byteLength : 1;
          diagnosticBytes = Math.min(Number.MAX_SAFE_INTEGER, diagnosticBytes + bytes);
          if (diagnosticBytes > 0) fail();
          return;
        }
        if (failed) return;
        if (
          !(chunk instanceof Uint8Array) ||
          resultLength + chunk.byteLength > resultBuffer.byteLength ||
          performance.now() - started >= timeoutMs
        ) {
          fail();
          return;
        }
        resultBuffer.set(chunk, resultLength);
        resultLength += chunk.byteLength;
      });
    }
    if (stdin instanceof Writable) {
      on(stdin, 'error', fail);
      on(stdin, 'finish', () => {
        inputFinished = true;
        wipeRequest();
      });
      on(stdin, 'close', () => {
        if (!inputFinished) fail();
      });
    }
    const abort = () => fail();
    if (input.signal instanceof AbortSignal) {
      input.signal.addEventListener('abort', abort, { once: true });
      detach.push(() => input.signal.removeEventListener('abort', abort));
    }

    if (
      !validLimits ||
      !(input.signal instanceof AbortSignal) ||
      input.signal.aborted ||
      !(input.request instanceof Uint8Array) ||
      (typeof SharedArrayBuffer !== 'undefined' &&
        input.request.buffer instanceof SharedArrayBuffer) ||
      input.request.byteLength < 1 ||
      input.request.byteLength >
        SECURITY_PROCESS_LIMITS.documentBytes + SECURITY_PROCESS_LIMITS.headerBytes + 4 ||
      !(stdin instanceof Writable) ||
      stdin.destroyed ||
      stdin.writableEnded ||
      !untouchedOutputs ||
      [stdout, stderr, resultPipe].some(
        (stream) =>
          !(stream instanceof Readable) ||
          stream.destroyed ||
          stream.readableEnded ||
          stream.readableEncoding !== null,
      ) ||
      new Set([stdin, stdout, stderr, resultPipe]).size !== 4 ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      fail();
      return;
    }
    timers.work = setTimeout(fail, timeoutMs);
    try {
      requestBuffer = Buffer.from(input.request);
      stdin.end(requestBuffer, (error?: Error | null) => {
        if (error) fail();
      });
    } catch {
      fail();
    }
  });
}
