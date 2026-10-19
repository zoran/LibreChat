/** Private IPC observation only; neither an approval nor proof of sandbox/process-tree cleanup. */
import { performance } from 'node:perf_hooks';
import { Readable, Writable } from 'node:stream';
import { ChildProcess } from 'node:child_process';
import type { SecurityProcessResult, SecurityProcessFrame } from './process-wire';
import type { PdfSecurityOcr } from './pdf';
import {
  readSecurityProcessResult,
  SECURITY_PROCESS_LIMITS,
  SecurityProcessFrameReader,
  encodeSecurityProcessFrameHeader,
} from './process-wire';

type Observation = {
  result: SecurityProcessResult | null;
  pages: number;
  localCopiesRemoved: boolean;
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
  ocr?: PdfSecurityOcr;
}): Promise<Observation> {
  const empty = (): Observation => ({
    result: null,
    pages: 0,
    localCopiesRemoved: false,
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
    const reader = new SecurityProcessFrameReader();
    const pageAbort = new AbortController();
    let finalResult: SecurityProcessResult | null = null;
    let finalSeen = false;
    let pageBusy = false;
    let pages = 0;
    let pixels = 0;
    let textBytes = 0;
    let requestBuffer: Buffer | null = null;
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
    const finish = (result: SecurityProcessResult | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timers.work);
      clearTimeout(timers.cleanup);
      for (const remove of detach) remove();
      reader.clear();
      wipeRequest();
      resolve({
        result,
        pages,
        localCopiesRemoved: childClosed && !pageBusy,
        diagnostics: priorDiagnostics || diagnosticBytes > 0,
        directChildStopped: exitObserved,
        transportComplete: result !== null,
      });
    };
    const fail = () => {
      if (settled || failed) return;
      failed = true;
      pageAbort.abort();
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
      const remaining = Math.max(
        0,
        (validLimits ? timeoutMs + cleanupMs : 1000) - (performance.now() - started),
      );
      timers.cleanup = setTimeout(finish, Math.min(validLimits ? cleanupMs : 1_000, remaining));
      if (childClosed && !pageBusy) finish();
    };
    const complete = () => {
      if (settled) return;
      if (failed) {
        if (childClosed && !pageBusy) finish();
        return;
      }
      if (!childClosed || pageBusy) return;
      if (
        !exitObserved ||
        !cleanExit ||
        !inputFinished ||
        ended.size !== 3 ||
        diagnosticBytes !== 0 ||
        !reader.complete ||
        !finalSeen ||
        !finalResult ||
        (finalResult.decision === 'clear' &&
          (finalResult.coverage.pages !== pages || pages === 0)) ||
        performance.now() - started >= timeoutMs
      ) {
        fail();
        return;
      }
      finish(finalResult);
    };
    const write = (bytes: Uint8Array) =>
      new Promise<void>((resolve, reject) => {
        if (!(resultPipe instanceof Writable) || resultPipe.destroyed || failed) {
          reject(new Error());
          return;
        }
        resultPipe.write(bytes, (error?: Error | null) => (error ? reject(error) : resolve()));
      });
    const consume = (frame: SecurityProcessFrame) => {
      if (finalSeen || pageBusy || failed) {
        frame.bytes.fill(0);
        fail();
        return;
      }
      const header = frame.header;
      if (header.kind === 'result') {
        finalSeen = true;
        finalResult = readSecurityProcessResult(frame.bytes);
        frame.bytes.fill(0);
        if (!finalResult) fail();
        return;
      }
      if (
        header.kind !== 'page' ||
        header.page !== pages + 1 ||
        !input.ocr ||
        (pixels += header.width * header.height) > 64_000_000 ||
        !(resultPipe instanceof Readable)
      ) {
        frame.bytes.fill(0);
        fail();
        return;
      }
      pageBusy = true;
      resultPipe.pause();
      void (async () => {
        let text: Buffer | undefined;
        let prefix: Buffer | undefined;
        try {
          const result = await input.ocr!.readPage({
            page: header.page,
            width: header.width,
            height: header.height,
            rgba: new Uint8ClampedArray(
              frame.bytes.buffer,
              frame.bytes.byteOffset,
              frame.bytes.length,
            ),
            signal: pageAbort.signal,
          });
          if (
            failed ||
            pageAbort.signal.aborted ||
            result.complete !== true ||
            result.readable !== true ||
            typeof result.text !== 'string'
          )
            throw new Error();
          text = Buffer.from(result.text, 'utf8');
          if (text.length > 65_536 || (textBytes += text.length) > 1_048_576) throw new Error();
          prefix = encodeSecurityProcessFrameHeader({
            version: 2,
            kind: 'ocr',
            page: header.page,
            complete: true,
            readable: true,
            bytes: text.length,
          });
          await write(prefix);
          await write(text);
          pages++;
        } catch {
          fail();
        } finally {
          prefix?.fill(0);
          text?.fill(0);
          frame.bytes.fill(0);
          pageBusy = false;
          if (!failed && !settled) resultPipe.resume();
          complete();
        }
      })();
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
        if (!(chunk instanceof Uint8Array) || performance.now() - started >= timeoutMs) {
          fail();
          return;
        }
        try {
          reader.push(chunk, consume);
        } catch {
          fail();
        } finally {
          chunk.fill(0);
        }
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
