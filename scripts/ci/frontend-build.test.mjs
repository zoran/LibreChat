/** Exercises the shipped CI artifact producer and installer before Docker reuses built output. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createBuildArtifact, installBuildArtifact } from './frontend-build.mjs';

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const cli = fileURLToPath(new URL('./frontend-build.mjs', import.meta.url));
const outputRoots = [
  'client/dist',
  'packages/data-provider/dist',
  'packages/data-schemas/dist',
  'packages/api/dist',
  'packages/client/dist',
];
const lockfile = '{"name":"frontend-build-fixture","lockfileVersion":3,"packages":{}}\n';
const builtFiles = new Map([
  ['client/dist/index.html', Buffer.from('<script src="./assets/app.js"></script>\n')],
  ['client/dist/assets/app.js', Buffer.from('window.frontendBuild = "qualified";\n')],
  ['client/dist/assets/logo.bin', Buffer.from([0, 255, 128, 13, 10])],
  ['client/dist/.vite/manifest.json', Buffer.from('{"index.html":{"file":"assets/app.js"}}\n')],
  ['packages/data-provider/dist/index.js', Buffer.from('exports.provider = "built";\n')],
  ['packages/data-schemas/dist/index.js', Buffer.from('exports.schema = "built";\n')],
  ['packages/api/dist/index.js', Buffer.from('exports.api = "built";\n')],
  ['packages/api/dist/index.d.ts', Buffer.from('export declare const api: string;\n')],
  ['packages/client/dist/index.js', Buffer.from('exports.client = "built";\n')],
]);

async function write(root, relative, contents) {
  const filename = path.join(root, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, contents);
}

// Record directories and symlinks as well as bytes, without following a hostile link.
async function snapshot(root, prefix = '') {
  const entries = [];
  for (const name of (await readdir(root)).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const filename = path.join(root, name);
    const stat = await lstat(filename);
    if (stat.isSymbolicLink()) {
      entries.push([relative, 'symlink', await readlink(filename)]);
    } else if (stat.isDirectory()) {
      entries.push([relative, 'directory']);
      entries.push(...(await snapshot(filename, relative)));
    } else {
      entries.push([relative, 'file', (await readFile(filename)).toString('base64')]);
    }
  }
  return entries;
}

async function fixture(temporary, name, revision) {
  const directory = path.join(temporary, name);
  const root = path.join(directory, 'source');
  const target = path.join(directory, 'target');
  const artifactDir = path.join(directory, 'artifact');
  for (const destination of [root, target]) {
    await write(destination, 'package-lock.json', lockfile);
    await write(destination, 'source.txt', 'source files must survive installation\n');
  }
  for (const [filename, bytes] of builtFiles) await write(root, filename, bytes);
  for (const output of outputRoots) await write(target, `${output}/stale.js`, 'old build\n');
  return {
    directory,
    root,
    target,
    artifactDir,
    sourceRevision: revision,
    pack() {
      return createBuildArtifact({ root, outputDir: artifactDir, sourceRevision: revision });
    },
    install(options = {}) {
      return installBuildArtifact({
        root: target,
        artifactDir,
        sourceRevision: revision,
        ...options,
      });
    },
    async changeManifest(change) {
      const filename = path.join(artifactDir, 'manifest.json');
      const manifest = JSON.parse(await readFile(filename, 'utf8'));
      change(manifest);
      await writeFile(filename, `${JSON.stringify(manifest)}\n`);
    },
  };
}

async function assertInstalled(target) {
  const actualFiles = (await snapshot(target))
    .filter(([, kind]) => kind === 'file')
    .map(([filename, , bytes]) => [filename, bytes])
    .sort(([left], [right]) => left.localeCompare(right));
  const expectedFiles = [
    ...builtFiles,
    ['package-lock.json', Buffer.from(lockfile)],
    ['source.txt', Buffer.from('source files must survive installation\n')],
  ]
    .map(([filename, bytes]) => [filename, bytes.toString('base64')])
    .sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(
    actualFiles,
    expectedFiles,
    'install all five outputs and remove stale files only',
  );
}

// These fixtures inherit the real checkout's HEAD through ordinary Git discovery. They never
// initialize or modify Git metadata. Only this test-created scratch directory is removed.
test(
  'frontend build artifacts preserve qualified output and reject unsafe reuse',
  { timeout: 30000 },
  async (t) => {
    const { stdout } = await execute('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryRoot,
      timeout: 5000,
    });
    const revision = stdout.trim();
    assert.match(revision, /^[a-f0-9]{40}$/);
    const otherRevision = `${revision[0] === 'a' ? 'b' : 'a'}${revision.slice(1)}`;
    const temporary = await mkdtemp(path.join(repositoryRoot, '.frontend-build-test-'));
    t.diagnostic(
      `Test-owned fixture directory: ${temporary}; cleanup is confined to this exact path.`,
    );
    try {
      await t.test(
        'API round trip preserves binary, nested and hidden files in all five outputs',
        async () => {
          const f = await fixture(temporary, 'api-roundtrip', revision);
          const sourceBefore = await snapshot(f.root);
          const manifest = await f.pack();
          assert.equal(manifest.sourceRevision, revision);
          assert.equal(
            manifest.packageLockSha256,
            createHash('sha256').update(lockfile).digest('hex'),
          );
          assert.deepEqual([...manifest.roots].sort(), [...outputRoots].sort());
          assert.deepEqual(
            manifest.files.map((entry) => entry.path).sort(),
            [...builtFiles.keys()].sort(),
          );
          await f.install();
          await assertInstalled(f.target);
          assert.deepEqual(
            await snapshot(f.root),
            sourceBefore,
            'packing must leave source output intact',
          );
          await f.install();
          await assertInstalled(f.target);
        },
      );

      await t.test(
        'CLI installs into a clean target and rejects a wrong revision without writes',
        async () => {
          const f = await fixture(temporary, 'cli-roundtrip', revision);
          for (const output of outputRoots)
            await rm(path.join(f.target, output), { recursive: true });
          await execute(
            process.execPath,
            [cli, 'pack', '--revision', revision, '--directory', f.artifactDir],
            {
              cwd: f.root,
              timeout: 5000,
            },
          );
          const targetBefore = await snapshot(f.target);
          await assert.rejects(
            execute(
              process.execPath,
              [cli, 'install', '--revision', otherRevision, '--directory', f.artifactDir],
              {
                cwd: f.target,
                timeout: 5000,
              },
            ),
            (error) => typeof error.code === 'number' && error.code !== 0,
          );
          assert.deepEqual(await snapshot(f.target), targetBefore);
          await execute(
            process.execPath,
            [cli, 'install', '--revision', revision, '--directory', f.artifactDir],
            {
              cwd: f.target,
              timeout: 5000,
            },
          );
          await assertInstalled(f.target);
        },
      );

      await t.test(
        'pack rejects a claimed revision different from the actual Git HEAD',
        async () => {
          const f = await fixture(temporary, 'wrong-head', revision);
          await assert.rejects(
            createBuildArtifact({
              root: f.root,
              outputDir: f.artifactDir,
              sourceRevision: otherRevision,
            }),
            /revision|commit|HEAD/i,
          );
        },
      );

      await t.test('pack refuses an incomplete build', async () => {
        const f = await fixture(temporary, 'incomplete-build', revision);
        await rm(path.join(f.root, 'packages/data-schemas/dist'), { recursive: true });
        await assert.rejects(f.pack());
      });

      await t.test(
        'pack rejects a symlink even when its target contains the expected bytes',
        async () => {
          const f = await fixture(temporary, 'linked-source', revision);
          const relative = 'client/dist/assets/app.js';
          await write(f.directory, 'linked.js', builtFiles.get(relative));
          await rm(path.join(f.root, relative));
          await symlink(path.join(f.directory, 'linked.js'), path.join(f.root, relative));
          await assert.rejects(f.pack(), /symbolic|symlink/i);
        },
      );

      await t.test('pack refuses an empty output directory', async () => {
        const f = await fixture(temporary, 'empty-build', revision);
        await rm(path.join(f.root, 'packages/data-schemas/dist/index.js'));
        await assert.rejects(f.pack(), /at least one file/);
      });

      const invalidArtifacts = [
        [
          'manifest revision differs from the requested source',
          async (f) => {
            await f.changeManifest((manifest) => {
              manifest.sourceRevision = otherRevision;
            });
          },
        ],
        [
          'destination lockfile differs from the qualified dependency graph',
          async (f) => {
            await write(f.target, 'package-lock.json', `${lockfile} `);
          },
        ],
        [
          'file contents change without changing file size',
          async (f) => {
            const relative = 'client/dist/assets/app.js';
            const bytes = Buffer.from(builtFiles.get(relative));
            bytes[0] ^= 1;
            await write(f.artifactDir, `files/${relative}`, bytes);
          },
        ],
        [
          'file size changes',
          async (f) => {
            await write(f.artifactDir, 'files/packages/client/dist/index.js', 'truncated');
          },
        ],
        [
          'a listed file is missing',
          async (f) => {
            await rm(path.join(f.artifactDir, 'files/packages/api/dist/index.d.ts'));
          },
        ],
        [
          'an unlisted file is added beneath an output root',
          async (f) => {
            await write(f.artifactDir, 'files/client/dist/injected.js', 'unexpected code');
          },
        ],
        [
          'an unlisted file is added outside the output roots',
          async (f) => {
            await write(f.artifactDir, 'files/api/server/injected.js', 'unexpected code');
          },
        ],
        [
          'a required output is omitted from both manifest and artifact',
          async (f) => {
            const omitted = 'packages/data-schemas/dist';
            await rm(path.join(f.artifactDir, 'files', omitted), { recursive: true });
            await f.changeManifest((manifest) => {
              manifest.roots = manifest.roots.filter((root) => root !== omitted);
              manifest.files = manifest.files.filter(
                (file) => !file.path.startsWith(`${omitted}/`),
              );
            });
          },
        ],
        [
          'a manifest path traverses outside its output root',
          async (f) => {
            const relative = 'client/dist/index.html';
            await rename(
              path.join(f.artifactDir, 'files', relative),
              path.join(f.artifactDir, 'files/source.txt'),
            );
            await f.changeManifest((manifest) => {
              manifest.files.find((file) => file.path === relative).path =
                'client/dist/../../source.txt';
            });
          },
        ],
        [
          'a declared output has no files in either manifest or artifact',
          async (f) => {
            const empty = 'packages/data-schemas/dist';
            await rm(path.join(f.artifactDir, 'files', empty, 'index.js'));
            await f.changeManifest((manifest) => {
              manifest.files = manifest.files.filter((file) => !file.path.startsWith(`${empty}/`));
            });
          },
        ],
        [
          'an artifact file is a symlink to otherwise valid bytes',
          async (f) => {
            const relative = 'packages/api/dist/index.js';
            await rm(path.join(f.artifactDir, 'files', relative));
            await symlink(path.join(f.root, relative), path.join(f.artifactDir, 'files', relative));
          },
        ],
        [
          'an artifact output directory is a symlink',
          async (f) => {
            const output = path.join(f.artifactDir, 'files/packages/api/dist');
            const linked = path.join(f.directory, 'linked-dist');
            await rename(output, linked);
            await symlink(linked, output, 'dir');
          },
        ],
        [
          'the destination contains a symlinked package ancestor',
          async (f) => {
            const output = path.join(f.target, 'packages/api');
            const linked = path.join(f.directory, 'external-api');
            await rename(output, linked);
            await symlink(linked, output, 'dir');
            f.externalPath = linked;
          },
        ],
      ];
      for (const [index, [name, corrupt]] of invalidArtifacts.entries()) {
        await t.test(`install leaves the destination unchanged when ${name}`, async () => {
          const f = await fixture(temporary, `invalid-${index}`, revision);
          await f.pack();
          await corrupt(f);
          const targetBefore = await snapshot(f.target);
          const externalBefore = f.externalPath ? await snapshot(f.externalPath) : undefined;
          await assert.rejects(f.install());
          assert.deepEqual(await snapshot(f.target), targetBefore);
          if (f.externalPath) assert.deepEqual(await snapshot(f.externalPath), externalBefore);
        });
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    await assert.rejects(lstat(temporary), { code: 'ENOENT' });
  },
);
