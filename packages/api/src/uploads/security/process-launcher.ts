/** Private trusted composition only. This does not qualify a deployment or create an approval. */
import { TextDecoder } from 'node:util';
import { spawn } from 'node:child_process';
import { isAbsolute, normalize } from 'node:path';
import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import type { PdfSecurityOcr } from './pdf';
import { createSecurityProcessPolicy } from './process-policy';
import { observeSecurityProcess } from './process-observer';
import { readSecurityProcessRequest } from './process-wire';

export type SecurityProcessProfile = Readonly<{
  setpriv: string;
  node: string;
  entry: string;
  filter: string;
  opensslConfig: string;
  canvasAddon: string;
  readFiles: readonly string[];
  executeFiles: readonly string[];
}>;
type Observation = Awaited<ReturnType<typeof observeSecurityProcess>>;
const unavailable = (): Observation => ({
  result: null,
  pages: 0,
  localCopiesRemoved: false,
  diagnostics: false,
  directChildStopped: false,
  transportComplete: false,
});

/** Pure parsing only; the launcher always obtains these facts itself from fixed kernel paths. */
export function securityProcessPreconditionsSatisfied(
  status: string,
  limits: string,
  pattern: string,
): boolean {
  if (status.length > 16384 || limits.length > 8192 || pattern.length > 256) return false;
  const lines = status.split('\n');
  for (const name of ['Uid', 'Gid']) {
    const matches = lines.filter((line) => line.startsWith(`${name}:`));
    if (matches.length !== 1) return false;
    const ids = new RegExp(
      `^${name}:[ \\t]+([1-9][0-9]{0,9})[ \\t]+([1-9][0-9]{0,9})[ \\t]+([1-9][0-9]{0,9})[ \\t]+([1-9][0-9]{0,9})[ \\t]*$`,
    ).exec(matches[0]);
    if (!ids || ids.slice(1).some((id) => id !== ids[1] || Number(id) > 4294967294)) return false;
  }
  for (const name of ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) {
    const matches = lines.filter((line) => line.startsWith(`${name}:`));
    if (matches.length !== 1 || !new RegExp(`^${name}:[ \\t]+0{16}[ \\t]*$`).test(matches[0]))
      return false;
  }
  const core = limits.split('\n').filter((line) => line.startsWith('Max core file size'));
  return (
    core.length === 1 &&
    /^Max core file size[ \t]+0[ \t]+0[ \t]+bytes[ \t]*$/.test(core[0]) &&
    (pattern === 'core' || pattern === 'core\n' || pattern === '' || pattern === '\n')
  );
}

function boundedKernelRead(path: string, maximum: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error();
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maximum) throw new Error();
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, length),
    );
  } finally {
    closeSync(fd);
  }
}

/** No injected attestation: deployment must keep the host core policy and executable assets immutable. */
export function readCurrentSecurityProcessPreconditions(): boolean {
  try {
    return securityProcessPreconditionsSatisfied(
      boundedKernelRead('/proc/self/status', 16384),
      boundedKernelRead('/proc/self/limits', 8192),
      boundedKernelRead('/proc/sys/kernel/core_pattern', 256),
    );
  } catch {
    return false;
  }
}

function file(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    /[:,]/.test(value) ||
    [...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    realpathSync(value) !== value ||
    !statSync(value).isFile()
  )
    throw new Error('Security process profile unavailable');
  return value;
}

function exactRead(path: string, expected: Buffer): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size !== expected.length) throw new Error();
    const bytes = Buffer.alloc(expected.length);
    let read = 0;
    while (read < bytes.length) {
      const count = readSync(fd, bytes, read, bytes.length - read, read);
      if (count === 0) throw new Error();
      read += count;
    }
    const after = fstatSync(fd);
    if (
      !bytes.equals(expected) ||
      before.ctimeMs !== after.ctimeMs ||
      before.mtimeMs !== after.mtimeMs ||
      after.size !== before.size
    )
      throw new Error();
    return fd;
  } catch {
    closeSync(fd);
    throw new Error('Security process profile unavailable');
  }
}

/** The profile is deployment-owned. Requests can carry only an existing framed PDF and cancellation. */
export function createSecurityProcessLauncher(input: SecurityProcessProfile): Readonly<{
  run(input: {
    request: Uint8Array;
    signal: AbortSignal;
    timeoutMs?: number;
    ocr?: PdfSecurityOcr;
  }): Promise<Observation>;
}> {
  if (
    process.platform !== 'linux' ||
    process.arch !== 'x64' ||
    !Array.isArray(input.readFiles) ||
    !Array.isArray(input.executeFiles) ||
    input.readFiles.length > 512 ||
    input.executeFiles.length > 16
  )
    throw new Error('Security process profile unavailable');
  const profile = {
    setpriv: file(input.setpriv),
    node: file(input.node),
    entry: file(input.entry),
    filter: file(input.filter),
    opensslConfig: file(input.opensslConfig),
    canvasAddon: file(input.canvasAddon),
    readFiles: input.readFiles.map(file),
    executeFiles: input.executeFiles.map(file),
  };
  const reads = [
    ...new Set([...profile.readFiles, profile.entry, profile.opensslConfig, profile.canvasAddon]),
  ];
  const executes = [...new Set([profile.node, ...profile.executeFiles])];
  const args = [
    '--no-new-privs',
    '--inh-caps=-all',
    '--ambient-caps=-all',
    '--seccomp-filter',
    '/proc/self/fd/4',
    '--landlock-access',
    'fs',
  ];
  for (const path of reads) args.push('--landlock-rule', `path-beneath:read-file:${path}`);
  for (const path of executes)
    args.push('--landlock-rule', `path-beneath:read-file,execute:${path}`);
  args.push(
    '--',
    profile.node,
    '--max-old-space-size=64',
    '--disable-wasm-trap-handler',
    profile.entry,
  );
  const env = Object.freeze({
    DISABLE_SYSTEM_FONTS_LOAD: '1',
    NAPI_RS_NATIVE_LIBRARY_PATH: profile.canvasAddon,
    OPENSSL_CONF: profile.opensslConfig,
    UV_THREADPOOL_SIZE: '1',
    TOKIO_WORKER_THREADS: '1',
  });

  return Object.freeze({
    async run({
      request,
      signal,
      timeoutMs,
      ocr,
    }: {
      request: Uint8Array;
      signal: AbortSignal;
      timeoutMs?: number;
      ocr?: PdfSecurityOcr;
    }): Promise<Observation> {
      if (signal.aborted || !readSecurityProcessRequest(request)) return unavailable();
      let policyFd: number | undefined;
      let configFd: number | undefined;
      try {
        policyFd = exactRead(profile.filter, createSecurityProcessPolicy());
        configFd = exactRead(profile.opensslConfig, Buffer.alloc(0));
        if (!readCurrentSecurityProcessPreconditions()) return unavailable();
        // Explicit stdio closes all other inherited descriptors in Node's native spawn owner.
        const child = spawn(profile.setpriv, args, {
          cwd: '/',
          env,
          shell: false,
          detached: false,
          stdio: ['pipe', 'pipe', 'pipe', 'pipe', policyFd],
        });
        return await observeSecurityProcess({ child, request, signal, timeoutMs, ocr });
      } catch {
        return unavailable();
      } finally {
        if (policyFd !== undefined) closeSync(policyFd);
        if (configFd !== undefined) closeSync(configFd);
      }
    },
  });
}
