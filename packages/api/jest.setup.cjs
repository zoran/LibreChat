/**
 * `undici` (transitive dep of `@librechat/agents` and others) references
 * `globalThis.File` from `node:buffer`. Node 20+ exposes it as a global;
 * Node 18 / certain WSL toolchains do not, which surfaces as a
 * `ReferenceError: File is not defined` at module-load time the first
 * time a test imports `@librechat/agents`. Jest under those Node
 * versions blows up before the suite can even start.
 *
 * Pull `File` from `node:buffer` (available since Node 18.x) and assign
 * it onto `globalThis` if missing. Production code never depends on
 * this — the polyfill only activates inside Jest.
 */
if (typeof globalThis.File === 'undefined') {
  try {
    const { File } = require('node:buffer');
    if (File != null) {
      globalThis.File = File;
    }
  } catch {
    // Older Node versions without `node:buffer.File`. LibreChat doesn't
    // support those anyway; let the test fail loudly rather than mask a
    // real environment issue.
  }
}

// Allocate only once the suite can run: a failed module import must not leak a scratch root.
// Every suite owns its private child of a supplied root or the inherited temporary directory.
const { mkdtempSync, rmSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const { join, isAbsolute } = require('node:path');
const parentRoot = process.env.NAS_TEST_TMPDIR || undefined;
const suppliedFifo = process.env.NAS_TEST_FIFO;
let root;
let fifo;
beforeAll(() => {
  if (parentRoot && !isAbsolute(parentRoot)) throw Error('Owned NAS fixture root must be absolute');
  root = mkdtempSync(join(parentRoot ?? tmpdir(), 'librechat-api-nas-'));
  process.env.NAS_TEST_TMPDIR = root;
  if (!suppliedFifo) {
    fifo = join(root, 'original.fifo');
    const result = spawnSync('/usr/bin/mkfifo', [fifo], { timeout: 1000, encoding: 'utf8' });
    if (result.error || result.status !== 0) throw Error('Owned NAS FIFO fixture unavailable');
    process.env.NAS_TEST_FIFO = fifo;
  }
});
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  if (process.env.NAS_TEST_TMPDIR === root) {
    if (parentRoot === undefined) delete process.env.NAS_TEST_TMPDIR;
    else process.env.NAS_TEST_TMPDIR = parentRoot;
  }
  if (process.env.NAS_TEST_FIFO === fifo) delete process.env.NAS_TEST_FIFO;
});
