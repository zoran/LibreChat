/** Inert final-image collision/copy tests; no root, engine, signature or runtime qualification. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import {
  PACKAGE_SHA256,
  SOURCE_SHA256,
  SOURCE_SIGNATURE_SHA256,
  PROGRAM_SHA256,
  PROGRAM,
  HELPER,
  INTERPRETER,
  digest,
} from './antivirus-assets.mjs';
import {
  validateBundle,
  imagePath,
  installPlan,
  install,
  copySetpriv,
  createFilter,
} from './antivirus-image-assets.mjs';
function fixture(t) {
  const base = fs.realpathSync(process.env.ANTIVIRUS_TEST_TMPDIR ?? os.tmpdir());
  const root = fs.mkdtempSync(path.join(base, 'av-image-'));
  assert.equal(fs.realpathSync(root), root);
  t.after(() => {
    assert.equal(fs.realpathSync(root), root);
    assert.ok(root.startsWith(base + '/'));
    fs.rmSync(root, { recursive: true });
  });
  const image = path.join(root, 'image'),
    bundle = path.join(root, 'bundle');
  fs.mkdirSync(image);
  fs.mkdirSync(bundle);
  const loader = '/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2';
  const m = {
    schema: 1,
    qualification: 'image-assets-only',
    packageSha256: PACKAGE_SHA256,
    programSha256: PROGRAM_SHA256,
    program: PROGRAM,
    helper: HELPER,
    loader,
    files: [
      { path: PROGRAM, sha256: PROGRAM_SHA256, bytes: 216632, executable: true },
      ...[loader, HELPER, '/etc/ld.so.cache'].map((p) => ({
        path: p,
        sha256: digest(Buffer.from(p)),
        bytes: Buffer.byteLength(p),
        executable: p !== '/etc/ld.so.cache',
      })),
    ],
    aliases: [{ path: INTERPRETER, target: loader }],
    signaturesReady: false,
    profileReady: false,
    runtimeQualified: false,
    correspondingSource: {
      included: true,
      licensingAccepted: false,
      archive: {
        path: '/usr/share/doc/cortex-antivirus/clamav-1.4.6.tar.gz',
        sha256: SOURCE_SHA256,
        bytes: 45990124,
      },
      signature: {
        path: '/usr/share/doc/cortex-antivirus/clamav-1.4.6.tar.gz.sig',
        sha256: SOURCE_SIGNATURE_SHA256,
        bytes: 801,
      },
    },
  };
  m.files.push(
    {
      path: m.correspondingSource.archive.path,
      sha256: SOURCE_SHA256,
      bytes: 45990124,
      executable: false,
    },
    {
      path: m.correspondingSource.signature.path,
      sha256: SOURCE_SIGNATURE_SHA256,
      bytes: 801,
      executable: false,
    },
  );
  function populate() {
    assert.ok(
      process.env.ANTIVIRUS_TEST_PROGRAM,
      'qualified public program is an explicit test input',
    );
    const bytes = fs.readFileSync(process.env.ANTIVIRUS_TEST_PROGRAM);
    assert.equal(digest(bytes), PROGRAM_SHA256);
    for (const f of m.files) {
      const p = path.join(bundle, 'root', f.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(
        p,
        f.path === PROGRAM
          ? bytes
          : f.path === m.correspondingSource.archive.path
            ? fs.readFileSync(process.env.ANTIVIRUS_TEST_SOURCE)
            : f.path === m.correspondingSource.signature.path
              ? fs.readFileSync(process.env.ANTIVIRUS_TEST_SOURCE + '.sig')
              : Buffer.from(f.path),
      );
    }
    fs.writeFileSync(path.join(bundle, 'manifest.json'), JSON.stringify(m));
  }
  return { root, image, bundle, m, populate };
}
test('manifest cannot become signature/profile/runtime acceptance or choose alternate assets', (t) => {
  const { m } = fixture(t);
  assert.equal(validateBundle(m), m);
  for (const mutate of [
    (v) => (v.packageSha256 = 'f'.repeat(64)),
    (v) => (v.program = '/tmp/program'),
    (v) => (v.runtimeQualified = true),
    (v) => (v.profileReady = true),
    (v) => (v.signaturesReady = true),
    (v) => (v.aliases[0].target = '/lib/ld-musl-x86_64.so.1'),
    (v) => v.files.push({ ...v.files[1], path: '/lib/ld-musl-x86_64.so.1' }),
    (v) => v.files.push({ ...v.files[0] }),
  ]) {
    const hostile = structuredClone(m);
    mutate(hostile);
    assert.throws(() => validateBundle(hostile));
  }
});
test('standard distro directory aliases are preserved but arbitrary ancestor aliases refuse', (t) => {
  const { image } = fixture(t);
  fs.mkdirSync(path.join(image, 'lib'));
  fs.symlinkSync('lib', path.join(image, 'lib64'));
  assert.equal(imagePath(image, INTERPRETER), path.join(image, 'lib/ld-linux-x86-64.so.2'));
  fs.symlinkSync('/tmp', path.join(image, 'foreign'));
  assert.throws(() => imagePath(image, '/foreign/asset'));
});
test(
  'actual pinned public program installs only after complete collision guard; aliases never overwrite musl',
  { skip: !process.env.ANTIVIRUS_TEST_PROGRAM },
  (t) => {
    const f = fixture(t);
    f.populate();
    fs.mkdirSync(path.join(f.image, 'lib'));
    fs.writeFileSync(path.join(f.image, 'lib/ld-musl-x86_64.so.1'), 'musl-kept');
    fs.symlinkSync('lib', path.join(f.image, 'lib64'));
    const plan = installPlan(f.bundle, f.image);
    install(plan);
    assert.equal(
      fs.readFileSync(path.join(f.image, 'lib/ld-musl-x86_64.so.1'), 'utf8'),
      'musl-kept',
    );
    assert.equal(digest(fs.readFileSync(path.join(f.image, PROGRAM))), PROGRAM_SHA256);
    assert.equal(fs.readlinkSync(path.join(f.image, 'lib/ld-linux-x86-64.so.2')), f.m.loader);
    assert.doesNotThrow(() => installPlan(f.bundle, f.image));
  },
);
test(
  'foreign bytes, hardlinks, writable files, or mismatched aliases refuse before first copy',
  { skip: !process.env.ANTIVIRUS_TEST_PROGRAM },
  (t) => {
    const f = fixture(t);
    f.populate();
    const target = path.join(f.image, f.m.loader);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'foreign');
    assert.throws(() => installPlan(f.bundle, f.image));
    assert.equal(fs.existsSync(path.join(f.image, PROGRAM)), false);
    fs.writeFileSync(target, Buffer.from(f.m.loader));
    fs.chmodSync(target, 0o666);
    assert.throws(() => installPlan(f.bundle, f.image));
    fs.chmodSync(target, 0o444);
    fs.linkSync(target, path.join(f.image, 'hardlink'));
    assert.throws(() => installPlan(f.bundle, f.image));
    fs.unlinkSync(path.join(f.image, 'hardlink'));
    fs.mkdirSync(path.join(f.image, 'lib64'));
    fs.symlinkSync('/foreign', path.join(f.image, INTERPRETER));
    assert.throws(() => installPlan(f.bundle, f.image));
    assert.equal(fs.existsSync(path.join(f.image, PROGRAM)), false);
  },
);
test('AV setpriv is a separate regular bytecopy and never changes the PDF tool', (t) => {
  const { root } = fixture(t),
    source = path.join(root, 'pdf-setpriv'),
    destination = path.join(root, 'av-setpriv');
  fs.writeFileSync(source, 'actual Alpine tool bytes', { mode: 0o755 });
  copySetpriv(source, destination);
  assert.equal(fs.readFileSync(destination, 'utf8'), fs.readFileSync(source, 'utf8'));
  assert.notEqual(fs.statSync(source).ino, fs.statSync(destination).ino);
  assert.equal(fs.statSync(destination).nlink, 1);
  assert.equal(copySetpriv(source, destination), destination);
  fs.unlinkSync(destination);
  fs.symlinkSync(source, destination);
  assert.throws(() => copySetpriv(source, destination));
  assert.equal(fs.readFileSync(source, 'utf8'), 'actual Alpine tool bytes');
});
test('filter uses the actual built policy function bytes and cannot silently overwrite a prior filter', (t) => {
  const { root } = fixture(t),
    file = path.join(root, 'filter');
  const expected = Buffer.alloc(16, 1);
  assert.equal(createFilter({ createAntivirusProcessPolicy: () => expected }, file), file);
  assert.deepEqual(fs.readFileSync(file), expected);
  assert.throws(() => createFilter({ createAntivirusProcessPolicy: () => expected }, file));
  assert.throws(() =>
    createFilter({ createAntivirusProcessPolicy: () => Buffer.alloc(3) }, path.join(root, 'bad')),
  );
});

test(
  'actual currently compiled policy emits the packaged BPF bytes',
  { skip: !process.env.ANTIVIRUS_TEST_POLICY },
  (t) => {
    const { root } = fixture(t),
      file = path.join(root, 'actual.bpf');
    const policy = createRequire(import.meta.url)(process.env.ANTIVIRUS_TEST_POLICY);
    createFilter(policy, file);
    assert.deepEqual(fs.readFileSync(file), policy.createAntivirusProcessPolicy());
    assert.equal(fs.readFileSync(file).length % 8, 0);
  },
);
