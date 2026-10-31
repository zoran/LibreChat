/** Private AV child events own one permit dispatch and bounded terminal facts, never engine readiness. */
import { performance } from 'node:perf_hooks';
import type { ChildProcess } from 'node:child_process';

type Stage = 'spawn-error' | 'permit-error' | 'permit-closed' | 'permit-timeout' | 'child-exit';
type Facts = Readonly<{
  stage: Stage;
  spawnCode: string | null;
  permitCode: string | null;
  exitCode: number | null;
  signal: string | null;
  exited: boolean;
  closed: boolean;
}>;
const errno = new Set([
  'EPIPE',
  'ENOENT',
  'EACCES',
  'EPERM',
  'ENOMEM',
  'EMFILE',
  'ENFILE',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
]);
const signals = new Set([
  'SIGTERM',
  'SIGKILL',
  'SIGSYS',
  'SIGSEGV',
  'SIGABRT',
  'SIGBUS',
  'SIGILL',
  'SIGINT',
  'SIGHUP',
  'SIGPIPE',
]);
const errorCode = (error: unknown): string => {
  const descriptor =
    typeof error === 'object' && error !== null
      ? Object.getOwnPropertyDescriptor(error, 'code')
      : undefined;
  const code = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  return typeof code === 'string' && errno.has(code) ? code : 'OTHER';
};
class OriginalFailure extends Error {
  constructor(readonly facts: () => Facts) {
    super('Antivirus original unavailable');
  }
}
/** Only this module's closed typed facts can reach existing startup stderr; never raw child output. */
export function antivirusStartupFailure(error: unknown): string | null {
  if (!(error instanceof OriginalFailure)) return null;
  const text = JSON.stringify(error.facts());
  return Buffer.byteLength(text, 'utf8') <= 512 ? text : null;
}

/** Install handlers immediately after spawn; closing the consumed one-byte channel is expected. */
export function createAntivirusProcessEvents(
  child: ChildProcess,
  deadlineAtMs: number,
  monotonicDeadline: number,
) {
  const pipe = child.stdio[3];
  const permit = pipe && 'write' in pipe ? pipe : null;
  let stage: Stage | undefined;
  let spawnCode: string | null = null,
    permitCode: string | null = null;
  let exitCode: number | null = null,
    signal: string | null = null;
  let exited = false,
    closed = false,
    attempted = false,
    dispatched = false;
  let settle: ((ok: boolean) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (ok: boolean) => {
    if (timer) clearTimeout(timer);
    const resolve = settle;
    settle = undefined;
    resolve?.(ok);
  };
  const fail = (reason: Stage) => {
    stage ??= reason;
    finish(false);
  };
  const failure = new OriginalFailure(() => {
    if (!stage) throw new Error('Antivirus failure not observed');
    return { stage, spawnCode, permitCode, exitCode, signal, exited, closed };
  });
  const terminal = (code: number | null, value: NodeJS.Signals | null) => {
    exitCode =
      typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 255 ? code : null;
    signal = value;
    if (value !== null && !signals.has(value)) signal = 'OTHER';
    fail('child-exit');
  };
  child.on('error', (error) => {
    spawnCode = errorCode(error);
    fail('spawn-error');
  });
  child.once('exit', (code, value) => {
    exited = true;
    terminal(code, value);
  });
  const joined = new Promise<void>((resolve) =>
    child.once('close', (code, value) => {
      closed = true;
      terminal(code, value);
      resolve();
    }),
  );
  permit?.on('error', (error) => {
    permitCode = errorCode(error);
    fail('permit-error');
  });
  permit?.once('close', () => {
    if (!dispatched) fail('permit-closed');
  });
  return Object.freeze({
    joined,
    state: () => ({ exited, closed }),
    failure: (): Error | null => (stage ? failure : null),
    activate(): Promise<boolean> {
      if (attempted || stage || exited || closed || !permit || permit.destroyed)
        return Promise.resolve(false);
      attempted = true;
      const remaining = Math.min(
        deadlineAtMs - Date.now() - 10_000,
        monotonicDeadline - performance.now() - 10_000,
      );
      if (remaining <= 0) {
        fail('permit-timeout');
        return Promise.resolve(false);
      }
      return new Promise<boolean>((resolve) => {
        settle = resolve;
        timer = setTimeout(() => fail('permit-timeout'), remaining);
        try {
          // The helper consumes G then closes FD3 before its post-gate work. Do not
          // send a later socket shutdown: write completion proves dispatch only.
          permit.write('G', (error) => {
            if (error) {
              permitCode = errorCode(error);
              fail('permit-error');
            } else if (!stage && !exited && !closed) {
              dispatched = true;
              finish(true);
            } else finish(false);
            permit.destroy();
          });
        } catch (error) {
          permitCode = errorCode(error);
          fail('permit-error');
          permit.destroy();
        }
      });
    },
  });
}
