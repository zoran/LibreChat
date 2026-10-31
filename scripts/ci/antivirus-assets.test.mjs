/** Static ClamAV packaging tests; no vendor executable is loaded or run. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  parseElf,
  collectClosure,
  resolveLibrary,
  copyNotices,
  digest,
  PROGRAM_SHA256,
  parseDebianPackage,
  copyCorrespondingSource,
  SOURCE_SHA256,
  SOURCE_SIGNATURE_SHA256,
} from './antivirus-assets.mjs';
const header = `Class: ELF64\nData: 2's complement, little endian\nMachine: Advanced Micro Devices X86-64\n`;
const metadata = (extra = '') => header + extra;
function scratch(t) {
  const base = fs.realpathSync(process.env.ANTIVIRUS_TEST_TMPDIR ?? os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'av-assets-'));
  assert.equal(fs.realpathSync(root), root);
  t.after(() => {
    assert.equal(fs.realpathSync(root), root);
    assert.ok(root.startsWith(base + '/'));
    fs.rmSync(root, { recursive: true });
  });
  return root;
}
test(
  'actual ClamD bytes and readelf report retain the qualified immutable input',
  { skip: !process.env.ANTIVIRUS_TEST_PROGRAM },
  () => {
    const program = fs.readFileSync(process.env.ANTIVIRUS_TEST_PROGRAM);
    assert.equal(digest(program), PROGRAM_SHA256);
    const elf = parseElf(fs.readFileSync(process.env.ANTIVIRUS_TEST_ELF, 'utf8'));
    assert.equal(elf.interpreter, '/lib64/ld-linux-x86-64.so.2');
    assert.ok(elf.needed.includes('libclamav.so.12'));
    assert.ok(elf.needed.includes('libc.so.6'));
    assert.ok(Object.keys(elf.versions).length > 0);
  },
);
test('static parser binds requested ABI/interpreter and rejects loader injection', () => {
  const valid = metadata(
    ` [Requesting program interpreter: /lib64/ld-linux-x86-64.so.2]\n (NEEDED) Shared library: [libc.so.6]\nVersion needs section '.gnu.version_r':\n File: libc.so.6 Cnt: 1\n Name: GLIBC_2.2.5 Flags: none\n`,
  );
  assert.deepEqual(parseElf(valid).versions, { 'libc.so.6': ['GLIBC_2.2.5'] });
  assert.doesNotThrow(() => parseElf(valid + '\n (RUNPATH) Library runpath: [/usr/local/lib]'));
  for (const p of ['$ORIGIN', '/tmp', '/usr/local/lib:/tmp'])
    assert.throws(() => parseElf(valid + '\n (RUNPATH) Library runpath: [' + p + ']'));
  for (const bad of [
    valid.replace('X86-64', 'AArch64'),
    valid.replace('/lib64/ld-linux-x86-64.so.2', '/tmp/loader'),
    valid + '\n (RUNPATH) Library runpath: [/foreign]',
    valid.replace('little endian', 'big endian'),
  ])
    assert.throws(() => parseElf(bad));
});
test('recursive closure checks each version against its own actual SONAME provider', () => {
  const shape = {
    program: {
      needed: ['liba.so', 'libb.so'],
      interpreter: null,
      versions: { 'liba.so': ['A_1'] },
      definitions: [],
    },
    a: { needed: ['libb.so'], interpreter: null, versions: {}, definitions: ['A_1'] },
    b: { needed: [], interpreter: null, versions: {}, definitions: ['B_1'] },
  };
  const resolve = (n) => ({
    source: n === 'liba.so' ? 'a' : 'b',
    path: '/usr/local/lib/' + n + '.1',
    alias: '/usr/local/lib/' + n,
  });
  const roots = [{ source: 'program', path: '/usr/local/sbin/clamd' }];
  const result = collectClosure(roots, resolve, (s) => shape[s]);
  assert.equal(result.files.length, 3);
  assert.equal(result.edges.length, 3);
  assert.ok(result.aliases.some((a) => a.path === '/usr/local/lib/liba.so'));
  shape.a.definitions = [];
  shape.b.definitions.push('A_1');
  assert.throws(() => collectClosure(roots, resolve, (s) => shape[s]));
  assert.throws(() =>
    collectClosure(
      roots,
      () => {
        throw Error('missing provider');
      },
      (s) => shape[s],
    ),
  );
});
test('public build-root library resolver preserves regular canonical bytes and exact alias', (t) => {
  const root = scratch(t),
    vendor = path.join(root, 'vendor'),
    system = path.join(root, 'system');
  fs.mkdirSync(path.join(vendor, 'usr/local/lib'), { recursive: true });
  fs.mkdirSync(system);
  const lib = path.join(vendor, 'usr/local/lib/libexample.so.1.2');
  fs.writeFileSync(lib, 'ELF fixture');
  fs.symlinkSync('libexample.so.1.2', path.join(vendor, 'usr/local/lib/libexample.so.1'));
  const found = resolveLibrary('libexample.so.1', vendor, system);
  assert.equal(found.source, lib);
  assert.equal(found.path, '/usr/local/lib/libexample.so.1.2');
  assert.equal(found.alias, '/usr/local/lib/libexample.so.1');
  assert.throws(() => resolveLibrary('../escape', vendor, system));
  fs.symlinkSync('/etc/passwd', path.join(vendor, 'usr/local/lib/libescape.so'));
  assert.throws(() => resolveLibrary('libescape.so', vendor, system));
});
test('all vendor/runtime notices are retained, while source aliases cannot escape their public tree', (t) => {
  const root = scratch(t),
    source = path.join(root, 'public'),
    out = path.join(root, 'out');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'COPYING'), 'GPL notice');
  fs.writeFileSync(path.join(source, 'empty-notice'), '');
  fs.symlinkSync('COPYING', path.join(source, 'license-alias'));
  assert.equal(copyNotices(source, out).length, 3);
  assert.equal(fs.readFileSync(path.join(out, 'license-alias'), 'utf8'), 'GPL notice');
  fs.symlinkSync('/etc/passwd', path.join(source, 'escape'));
  assert.throws(() => copyNotices(source, path.join(root, 'refused'), [], source));
});
test('both normal Docker recipes preserve Alpine/PDF and compile current helper in a glibc-only build stage', () => {
  for (const name of ['Dockerfile', 'Dockerfile.multi']) {
    const text = fs.readFileSync(new URL('../../' + name, import.meta.url), 'utf8');
    assert.match(text, /FROM node:24\.16\.0-bookworm-slim AS antivirus-build/);
    assert.match(text, /FROM node:24\.16\.0-alpine AS (?:node|base-min)/);
    assert.match(
      text,
      /ADD --checksum=sha256:d3ee9e401974855a1edc1761b1425417d126de618d5f0c91cd51209f69f6fcc2 https:\/\/www\.clamav\.net/,
    );
    assert.match(text, /COPY packages\/api\/src\/uploads\/security\/native\/antivirus-scope\.c/);
    assert.match(
      text,
      /cc -O2[\s\S]*-o \/build\/antivirus-scope[\s\S]*node \/build\/antivirus-assets\.mjs/,
    );
    assert.match(
      text,
      /RUN --mount=type=bind,from=antivirus-build,source=\/out,target=\/antivirus-build,ro/,
    );
    assert.match(text, /node scripts\/ci\/security-process-assets\.mjs/);
    assert.doesNotMatch(
      text,
      /(?:clamd|clamscan|freshclam|antivirus-scope) --(?:version|help|gate)/,
    );
    assert.doesNotMatch(text, /\.tmp\/|\.auth\/|antivirus-scope-1649/);
  }
});

test('runtime manifest captures exact binary/source versions and actual public origin policy without upgrading a claim', () => {
  const row = 'libc6:amd64\t2.36-9+deb12u99\tglibc\t2.36-9+deb12u99\tamd64\n';
  const policy =
    'libc6:\n  Installed: 2.36-9+deb12u99\n  Version table:\n *** 2.36-9+deb12u99 500\n 500 http://deb.debian.org/debian bookworm/main amd64 Packages\n';
  const meta = parseDebianPackage(row, policy);
  assert.equal(meta.sourcePackage, 'glibc');
  assert.equal(meta.version, '2.36-9+deb12u99');
  assert.deepEqual(meta.origins.repositories, ['http://deb.debian.org/debian']);
  assert.equal(meta.origins.policy, policy);
  assert.throws(() => parseDebianPackage(row, policy.replace('2.36-9+deb12u99', 'wrong')));
  assert.throws(() =>
    parseDebianPackage(row, policy.replace('deb.debian.org', 'untrusted.invalid')),
  );
});

test(
  'actual officially signed corresponding source is copied by the real producer without extraction or license-acceptance claims',
  { skip: !process.env.ANTIVIRUS_TEST_SOURCE },
  (t) => {
    const root = scratch(t),
      input = process.env.ANTIVIRUS_TEST_SOURCE;
    const result = copyCorrespondingSource(input, input + '.sig', root);
    assert.equal(result.included, true);
    assert.equal(result.licensingAccepted, false);
    assert.equal(digest(fs.readFileSync(path.join(root, result.archive.path))), SOURCE_SHA256);
    assert.equal(
      digest(fs.readFileSync(path.join(root, result.signature.path))),
      SOURCE_SIGNATURE_SHA256,
    );
    const wrong = path.join(root, 'wrong');
    fs.writeFileSync(wrong, 'not corresponding source');
    assert.throws(() => copyCorrespondingSource(wrong, input + '.sig', root));
  },
);
