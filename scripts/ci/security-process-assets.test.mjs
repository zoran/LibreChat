/** Focused packaging checks; never claim native child/host qualification from fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compiledFiles, regular, toolHelp, validateLibraries } from './security-process-assets.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'security-image-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('both build branches converge before pruning and security asset generation', () => {
  const source = fs.readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
  assert.match(source, /apk add --no-cache[^\n]* setpriv util-linux-misc/);
  assert.match(
    source,
    /fi &&\s*\\\s*npm prune --production &&\s*\\\s*npm cache clean --force[\s\S]*USER root\nRUN node scripts\/ci\/security-process-assets.mjs\nUSER node/,
  );
  assert.equal(source.match(/RUN node scripts\/ci\/security-process-assets.mjs/g)?.length, 1);
});

test('profile assets reject symlinks, directories, hardlinks and ancestor aliases', (t) => {
  const root = fixture(t),
    file = path.join(root, 'entry.cjs');
  fs.writeFileSync(file, 'module.exports = {}');
  assert.equal(regular(file), file);
  fs.symlinkSync(file, path.join(root, 'alias'));
  assert.throws(() => regular(path.join(root, 'alias')));
  assert.throws(() => regular(root));
  fs.symlinkSync(root, path.join(root, 'directory-alias'));
  assert.throws(() => regular(path.join(root, 'directory-alias/entry.cjs')));
  fs.linkSync(file, path.join(root, 'hardlink'));
  assert.throws(() => regular(file));
});

test('actual emitted chunk imports form a bounded recursive file closure', (t) => {
  const root = fixture(t),
    nested = path.join(root, 'uploads/security');
  fs.mkdirSync(nested, { recursive: true });
  const entry = path.join(nested, 'pdf-child.cjs');
  fs.writeFileSync(
    entry,
    'require("../../inspection.cjs"); import("pdfjs-dist/legacy/build/pdf.mjs");',
  );
  fs.writeFileSync(path.join(root, 'inspection.cjs'), 'require("./markings.cjs");');
  fs.writeFileSync(path.join(root, 'markings.cjs'), 'require("node:buffer");');
  assert.deepEqual(
    compiledFiles(entry, root),
    [path.join(root, 'inspection.cjs'), path.join(root, 'markings.cjs'), entry].sort(),
  );
  fs.writeFileSync(path.join(root, 'inspection.cjs'), 'require("./missing.cjs");');
  assert.throws(() => compiledFiles(entry, root));
});

test('dependency escapes and new external runtime requirements fail closed', (t) => {
  const root = fixture(t),
    entry = path.join(root, 'entry.cjs');
  for (const content of ['require("../outside.cjs");', 'require("unknown-runtime-package");']) {
    fs.writeFileSync(entry, content);
    assert.throws(() => compiledFiles(entry, root));
  }
});

test('installed tool capability must actually expose every required option', (t) => {
  const root = fixture(t),
    tool = path.join(root, 'tool');
  fs.writeFileSync(tool, '#!/bin/sh\nprintf "%s\\n" --landlock-access --landlock-rule\n', {
    mode: 0o755,
  });
  toolHelp(tool, ['--landlock-access', '--landlock-rule']);
  assert.throws(() => toolHelp(tool, ['--seccomp-filter']));
});

// The musl image gate must reject the same library sets while exposing safe failure evidence.
test('library diagnostics preserve acceptance and classify every rejected boundary', (t) => {
  const output = [];
  t.mock.method(console, 'error', (line) => output.push(line));
  const loader = '/lib/ld-musl-x86_64.so.1';
  const addon = '/app/node_modules/@napi-rs/canvas-linux-x64-musl/skia.node';
  const valid = [loader, addon, '/usr/lib/libjemalloc.so.2'];
  assert.doesNotThrow(() => validateLibraries(valid, addon));
  assert.deepEqual(output, []);
  for (const [libraries, categories] of [
    [[addon], ['missing-loader']],
    [[loader], ['missing-addon']],
    [[...valid, '/opt/foreign.so'], ['unexpected-root']],
    [['/opt/foreign.so'], ['missing-loader', 'missing-addon', 'unexpected-root']],
  ]) {
    assert.throws(() => validateLibraries(libraries, addon), {
      message: 'Security process image assets unavailable',
    });
    assert.equal(output.length, 1);
    const observation = JSON.parse(output.pop());
    assert.deepEqual(observation.categories, categories);
    assert.deepEqual(observation.libraries, libraries);
    assert.equal(observation.canvasAddon, addon);
    assert.equal(observation.omittedLibraryCount, 0);
  }
});

test('failure observations bound count and path bytes without extra process data', (t) => {
  const output = [];
  t.mock.method(console, 'error', (line) => output.push(line));
  const addon = '/app/canvas.node';
  const libraries = [
    '/lib/ld-musl-x86_64.so.1',
    addon,
    ...Array.from({ length: 64 }, (_, index) => '/tmp/' + index + '-"'.repeat(300) + '\n'),
  ];
  assert.throws(() => validateLibraries(libraries, addon), {
    message: 'Security process image assets unavailable',
  });
  assert.equal(output.length, 1);
  assert.ok(Buffer.byteLength(output[0]) < 18000);
  assert.ok(!output[0].includes('\n'));
  const observation = JSON.parse(output[0]);
  assert.deepEqual(
    Object.keys(observation).sort(),
    [
      'canvasAddon',
      'categories',
      'event',
      'libraries',
      'libraryCount',
      'omittedLibraryCount',
      'pathsTruncated',
    ].sort(),
  );
  assert.deepEqual(observation.categories, ['unexpected-root']);
  assert.equal(observation.libraryCount, 66);
  assert.equal(observation.libraries.length, 32);
  assert.equal(observation.omittedLibraryCount, 34);
  assert.equal(observation.pathsTruncated, true);
  assert.ok(
    observation.libraries.every((file) => file.length <= 256 && /^[\x20-\x7e]*$/u.test(file)),
  );
});

// Complete sharedObjects inventory observed in the Node 24.16 musl image build.
const observedMuslLibraries = [
  '/usr/local/bin/node',
  '/usr/lib/libjemalloc.so.2',
  '/usr/lib/libstdc++.so.6.0.34',
  '/usr/lib/libgcc_s.so.1',
  '/lib/ld-musl-x86_64.so.1',
  '/app/node_modules/@napi-rs/canvas-linux-x64-musl/skia.linux-x64-musl.node',
];

test('the observed musl inventory admits and retains its exact Node executable', (t) => {
  const output = [];
  t.mock.method(console, 'error', (line) => output.push(line));
  const libraries = [...observedMuslLibraries];
  const addon = observedMuslLibraries.at(-1);
  assert.doesNotThrow(() => validateLibraries(libraries, addon));
  assert.deepEqual(libraries, observedMuslLibraries);
  assert.deepEqual(output, []);
});

test('Node path lookalikes and incomplete observed inventories remain rejected', (t) => {
  const output = [];
  t.mock.method(console, 'error', (line) => output.push(line));
  const loader = '/lib/ld-musl-x86_64.so.1';
  const addon = observedMuslLibraries.at(-1);
  const foreignPaths = [
    '/usr/local/bin/nodejs',
    '/usr/local/bin/node.so',
    '/usr/local/bin/node/extra.so',
    '/usr/local/lib/foreign.so',
    '/opt/foreign.so',
  ];
  for (const [libraries, categories] of [
    ...foreignPaths.map((file) => [[...observedMuslLibraries, file], ['unexpected-root']]),
    [observedMuslLibraries.filter((file) => file !== loader), ['missing-loader']],
    [observedMuslLibraries.filter((file) => file !== addon), ['missing-addon']],
  ]) {
    assert.throws(() => validateLibraries(libraries, addon), {
      message: 'Security process image assets unavailable',
    });
    assert.equal(output.length, 1);
    const observation = JSON.parse(output.pop());
    assert.deepEqual(observation.categories, categories);
    assert.deepEqual(observation.libraries, libraries);
    assert.equal(observation.omittedLibraryCount, 0);
    assert.equal(observation.pathsTruncated, false);
  }
});
