/** Package and verify the five compiled frontend/workspace outputs reused by image CI. */
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const BUILD_ROOTS = Object.freeze([
  'client/dist',
  'packages/data-provider/dist',
  'packages/data-schemas/dist',
  'packages/api/dist',
  'packages/client/dist',
]);
const REVISION = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function requireRevision(sourceRevision) {
  if (typeof sourceRevision !== 'string' || !REVISION.test(sourceRevision)) {
    throw new Error('sourceRevision must be an exact lowercase 40-hex Git revision');
  }
}

function resolveDirectory(root, directory) {
  if (typeof directory !== 'string' || directory.length === 0) {
    throw new Error('An explicit artifact directory is required');
  }
  const resolved = path.resolve(root, directory);
  for (const output of BUILD_ROOTS) {
    const target = path.join(root, output);
    const within = (parent, child) => {
      const relative = path.relative(parent, child);
      return (
        relative === '' ||
        (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
      );
    };
    if (within(target, resolved) || within(resolved, target)) {
      throw new Error(`Artifact directory overlaps build output: ${output}`);
    }
  }
  return resolved;
}

// Check ancestors as well as leaf directories; a workspace symlink must never redirect writes.
async function requireDirectory(directory, allowMissing = false) {
  let cursor = path.parse(directory).root;
  for (const segment of directory.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    let stat;
    try {
      stat = await lstat(cursor);
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Expected a directory without symlinks: ${cursor}`);
    }
  }
}

async function inventory(directory) {
  const files = [];
  const directories = [];
  async function visit(relative) {
    for (const name of (await readdir(path.join(directory, relative))).sort()) {
      const entry = relative ? `${relative}/${name}` : name;
      const stat = await lstat(path.join(directory, entry));
      if (stat.isSymbolicLink()) {
        throw new Error(`Symlinks are not allowed in build output: ${entry}`);
      }
      if (stat.isDirectory()) {
        directories.push(entry);
        await visit(entry);
      } else if (stat.isFile()) {
        files.push(entry);
      } else {
        throw new Error(`Only regular files and directories are allowed: ${entry}`);
      }
    }
  }
  await visit('');
  return { files: files.sort(), directories: directories.sort() };
}

async function openRegularFile(filename) {
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error(`Expected a regular file without symlinks: ${filename}`);
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// Hash the bytes actually copied, using bounded memory even for large source maps.
async function fileInfo(filename, destination) {
  const input = await openRegularFile(filename);
  let output;
  try {
    if (destination) {
      output = await open(destination, 'wx', 0o644);
      await output.chmod(0o644);
    }
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of input.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      size += chunk.length;
      if (output) {
        await output.writeFile(chunk);
      }
    }
    return { size, sha256: hash.digest('hex') };
  } finally {
    await output?.close();
    await input.close();
  }
}

function requiredDirectories(files) {
  const directories = new Set(BUILD_ROOTS);
  for (const entry of [...BUILD_ROOTS, ...files.map((file) => file.path)]) {
    let parent = path.posix.dirname(entry);
    while (parent !== '.') {
      directories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  return [...directories].sort();
}

async function createDirectories(root, directories) {
  for (const directory of directories) {
    const target = path.join(root, directory);
    await mkdir(target, { mode: 0o755 });
    await chmod(target, 0o755);
  }
}

function validateManifest(manifest, sourceRevision) {
  if (!manifest || manifest.version !== 1 || manifest.sourceRevision !== sourceRevision) {
    throw new Error('Build artifact version or source revision mismatch');
  }
  if (typeof manifest.packageLockSha256 !== 'string' || !SHA256.test(manifest.packageLockSha256)) {
    throw new Error('Invalid package-lock SHA256 in build manifest');
  }
  if (
    !Array.isArray(manifest.roots) ||
    JSON.stringify(manifest.roots) !== JSON.stringify(BUILD_ROOTS)
  ) {
    throw new Error('Build manifest must contain exactly the five required output roots');
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error('Build manifest files must be an array');
  }
  const seen = new Set();
  for (const file of manifest.files) {
    const name = file?.path;
    if (
      typeof name !== 'string' ||
      name.includes('\\') ||
      name.includes('\0') ||
      name.split('/').some((part) => part === '' || part === '.' || part === '..') ||
      !BUILD_ROOTS.some((root) => name.startsWith(`${root}/`))
    ) {
      throw new Error(`Invalid or out-of-scope build artifact path: ${name}`);
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate build artifact file: ${name}`);
    }
    seen.add(name);
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.sha256 !== 'string' ||
      !SHA256.test(file.sha256)
    ) {
      throw new Error(`Invalid file size or SHA256: ${name}`);
    }
  }
  for (const root of BUILD_ROOTS) {
    if (!manifest.files.some((file) => file.path.startsWith(`${root}/`))) {
      throw new Error(`Build output must contain at least one file: ${root}`);
    }
  }
  const directories = requiredDirectories(manifest.files);
  if (directories.some((directory) => seen.has(directory))) {
    throw new Error('Build manifest uses the same path as both a file and a directory');
  }
  return directories;
}

function requireSamePaths(actual, expected, kind) {
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`Build artifact ${kind} contain missing or unlisted entries`);
  }
}

function requireFileMatch(actual, expected) {
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
    throw new Error(`Build artifact size or SHA256 mismatch: ${expected.path}`);
  }
}

async function requireHead(root, sourceRevision) {
  const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD']);
  if (stdout.trim() !== sourceRevision) {
    throw new Error('Requested source revision does not match actual Git HEAD');
  }
}

/** Create a deterministic manifest and payload from this exact checkout's compiled output. */
export async function createBuildArtifact({ root, outputDir, sourceRevision }) {
  requireRevision(sourceRevision);
  root = path.resolve(root);
  await requireDirectory(root);
  const destination = resolveDirectory(root, outputDir);
  await requireDirectory(path.dirname(destination));
  await requireHead(root, sourceRevision);
  const packageLockSha256 = (await fileInfo(path.join(root, 'package-lock.json'))).sha256;
  const paths = [];
  for (const output of BUILD_ROOTS) {
    await requireDirectory(path.join(root, output));
    const tree = await inventory(path.join(root, output));
    paths.push(...tree.files.map((name) => `${output}/${name}`));
  }
  paths.sort();
  let created = false;
  try {
    await mkdir(destination, { mode: 0o755 });
    created = true;
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
    await requireDirectory(destination);
    if ((await readdir(destination)).length !== 0) {
      throw new Error(
        'Artifact output directory must be empty; refusing to replace existing files',
      );
    }
  }
  try {
    await chmod(destination, 0o755);
    await createDirectories(destination, [
      'files',
      ...requiredDirectories(paths.map((name) => ({ path: name }))).map((name) => `files/${name}`),
    ]);
    const files = [];
    for (const name of paths) {
      files.push({
        path: name,
        ...(await fileInfo(path.join(root, name), path.join(destination, 'files', name))),
      });
    }
    await requireHead(root, sourceRevision);
    if ((await fileInfo(path.join(root, 'package-lock.json'))).sha256 !== packageLockSha256) {
      throw new Error('package-lock changed while packing build output');
    }
    const manifest = {
      version: 1,
      sourceRevision,
      packageLockSha256,
      roots: [...BUILD_ROOTS],
      files,
    };
    validateManifest(manifest, sourceRevision);
    await writeFile(
      path.join(destination, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: 'wx', mode: 0o644 },
    );
    await chmod(path.join(destination, 'manifest.json'), 0o644);
    return manifest;
  } catch (error) {
    // Only this call's newly created bundle is disposable; never clear an arbitrary directory.
    await rm(path.join(destination, 'files'), { recursive: true, force: true });
    await rm(path.join(destination, 'manifest.json'), { force: true });
    if (created) {
      await rmdir(destination);
    }
    throw error;
  }
}

/** Validate the complete bundle before replacing only the five fixed output roots. */
export async function installBuildArtifact({ root, artifactDir, sourceRevision }) {
  requireRevision(sourceRevision);
  root = path.resolve(root);
  await requireDirectory(root);
  const artifact = resolveDirectory(root, artifactDir);
  await requireDirectory(artifact);
  const manifestFile = await openRegularFile(path.join(artifact, 'manifest.json'));
  let manifest;
  try {
    manifest = JSON.parse(await manifestFile.readFile('utf8'));
  } finally {
    await manifestFile.close();
  }
  const directories = validateManifest(manifest, sourceRevision);
  if (
    (await fileInfo(path.join(root, 'package-lock.json'))).sha256 !== manifest.packageLockSha256
  ) {
    throw new Error('Build artifact package-lock SHA256 does not match the target');
  }
  const tree = await inventory(artifact);
  requireSamePaths(
    tree.files,
    ['manifest.json', ...manifest.files.map((file) => `files/${file.path}`)],
    'files',
  );
  requireSamePaths(
    tree.directories,
    ['files', ...directories.map((name) => `files/${name}`)],
    'directories',
  );
  for (const file of manifest.files) {
    requireFileMatch(await fileInfo(path.join(artifact, 'files', file.path)), file);
  }
  for (const output of BUILD_ROOTS) {
    const target = path.join(root, output);
    await requireDirectory(target, true);
    try {
      await inventory(target);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
  const staging = await mkdtemp(path.join(root, '.frontend-build-'));
  try {
    await createDirectories(staging, directories);
    for (const file of manifest.files) {
      requireFileMatch(
        await fileInfo(path.join(artifact, 'files', file.path), path.join(staging, file.path)),
        file,
      );
    }
    // Recheck every destination before the first replacement, after staging has completed.
    for (const output of BUILD_ROOTS) {
      await requireDirectory(path.join(root, output), true);
    }
    for (const output of BUILD_ROOTS) {
      const target = path.join(root, output);
      await mkdir(path.dirname(target), { recursive: true });
      await rm(target, { recursive: true, force: true });
      await rename(path.join(staging, output), target);
    }
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({
      options: { revision: { type: 'string' }, directory: { type: 'string' } },
      allowPositionals: true,
    });
    const [command] = positionals;
    if (
      positionals.length !== 1 ||
      !['pack', 'install'].includes(command) ||
      !values.revision ||
      !values.directory
    ) {
      throw new Error(
        'Usage: node scripts/ci/frontend-build.mjs pack|install --revision SHA --directory DIR',
      );
    }
    const options = { root: process.cwd(), sourceRevision: values.revision };
    const manifest =
      command === 'pack'
        ? await createBuildArtifact({ ...options, outputDir: values.directory })
        : await installBuildArtifact({ ...options, artifactDir: values.directory });
    console.log(
      `${command}: ${manifest.files.length} files verified for ${manifest.sourceRevision}`,
    );
  } catch (error) {
    console.error(`frontend-build: ${error.message}`);
    process.exitCode = 1;
  }
}
