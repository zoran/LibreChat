/** Focused packaging checks; never claim native child/host qualification from fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compiledFiles, regular, toolHelp } from './security-process-assets.mjs';

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
