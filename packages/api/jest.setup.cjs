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

// This shared afterEnv owner provisions actual private fixture storage for both API suites.
// Allocate after module discovery, so an import failure has no scratch root to leak.
const fs = jest.requireActual('node:fs');
const { spawnSync } = jest.requireActual('node:child_process');
const { tmpdir } = require('node:os');
const path = require('node:path');
const tempKeys = ['TMPDIR', 'UPLOAD_TEST_TMPDIR', 'NAS_TEST_TMPDIR', 'NAS_TEST_FIFO'];
const prior = Object.fromEntries(tempKeys.map((key) => [key, process.env[key]]));
const memoryFilesystems = new Set([0x01021994, 0x858458f6]);
let root;
let rootIdentity;

function trustedParent(directory, create = false) {
  if (!path.isAbsolute(directory)) throw Error('Fixture parent must be absolute');
  const resolved = path.resolve(directory);
  if (!fs.existsSync(resolved) && create) {
    const parent = trustedParent(path.dirname(resolved));
    fs.mkdirSync(path.join(parent, path.basename(resolved)), { mode: 0o700 });
  }
  const info = fs.lstatSync(resolved);
  const uid = process.getuid?.();
  const trustedOwner = info.uid === uid || info.uid === 0;
  const writableByOthers = (info.mode & 0o022) !== 0;
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    fs.realpathSync(resolved) !== resolved ||
    !trustedOwner ||
    (writableByOthers && (info.mode & 0o1000) === 0)
  )
    throw Error('Untrusted fixture parent');
  return resolved;
}
function disk(directory) {
  const type = Number(fs.statfsSync(directory, { bigint: true }).type);
  return Number.isSafeInteger(type) && type !== 0 && !memoryFilesystems.has(type);
}
function restore() {
  for (const key of tempKeys) {
    if (prior[key] === undefined) delete process.env[key];
    else process.env[key] = prior[key];
  }
}
function cleanup() {
  const owned = root;
  const identity = rootIdentity;
  root = undefined;
  rootIdentity = undefined;
  try {
    if (owned && fs.existsSync(owned)) {
      const actual = fs.lstatSync(owned);
      if (!identity || actual.dev !== identity.dev || actual.ino !== identity.ino)
        throw Error('Owned fixture root was replaced');
      fs.rmSync(owned, { recursive: true, force: true });
    }
  } finally {
    restore();
  }
}
beforeAll(() => {
  try {
    let parent;
    let prefix = 'librechat-api-nas-';
    if (prior.UPLOAD_TEST_TMPDIR) {
      parent = trustedParent(prior.UPLOAD_TEST_TMPDIR, true);
      if (!disk(parent)) throw Error('Explicit upload fixture parent must be disk-backed');
    } else {
      parent = trustedParent(prior.NAS_TEST_TMPDIR || prior.TMPDIR || tmpdir());
      if (!disk(parent)) {
        parent = trustedParent(path.resolve(__dirname, '../../.tmp'), true);
        if (!disk(parent)) throw Error('Checkout fixture parent must be disk-backed');
        prefix = 'jest-disk-';
      }
    }
    root = fs.mkdtempSync(path.join(parent, prefix));
    const info = fs.lstatSync(root);
    rootIdentity = { dev: info.dev, ino: info.ino };
    if (info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700)
      throw Error('Invalid owned fixture root');
    process.env.TMPDIR = root;
    process.env.UPLOAD_TEST_TMPDIR = root;
    process.env.NAS_TEST_TMPDIR = root;
    if (!prior.NAS_TEST_FIFO) {
      const fifo = path.join(root, 'original.fifo');
      const result = spawnSync('/usr/bin/mkfifo', [fifo], { timeout: 1000, encoding: 'utf8' });
      if (result.error || result.status !== 0) throw Error('Owned NAS FIFO fixture unavailable');
      process.env.NAS_TEST_FIFO = fifo;
    } else process.env.NAS_TEST_FIFO = prior.NAS_TEST_FIFO;
  } catch (error) {
    cleanup();
    throw error;
  }
});
afterAll(cleanup);
