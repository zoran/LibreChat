/** Final Alpine image AV assets only; signature generations/profile/host acceptance stay separate. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { compiledFiles, regular, seal, toolHelp } from './security-process-assets.mjs';
import {
  PACKAGE_SHA256,
  SOURCE_SHA256,
  SOURCE_SIGNATURE_SHA256,
  PROGRAM_SHA256,
  PROGRAM,
  HELPER,
  INTERPRETER,
  need,
  digest,
  assetPath,
} from './antivirus-assets.mjs';

const SECURITY = '/app/packages/api/dist/uploads/security';
const POLICY = SECURITY + '/antivirus-policy.cjs';
const FILTER = '/etc/cortex-document-security/antivirus-profile.bpf';
const MANIFEST = '/etc/cortex-document-security/antivirus-image-assets.json';
const BUNDLE = '/antivirus-build';
const allowedFile = (p) =>
  p === PROGRAM ||
  p === HELPER ||
  p === '/etc/ld.so.cache' ||
  p.startsWith('/usr/local/lib/') ||
  p.startsWith('/usr/lib/x86_64-linux-gnu/') ||
  p.startsWith('/usr/share/doc/cortex-antivirus/');
const allowedAlias = (p) =>
  p === INTERPRETER ||
  p.startsWith('/usr/local/lib/') ||
  p.startsWith('/usr/lib/x86_64-linux-gnu/') ||
  p.startsWith('/lib/x86_64-linux-gnu/');
/** Chroot-style path resolution: fixture aliases cannot accidentally access the real host. */
export function imagePath(root, absolute) {
  assetPath(absolute);
  need(fs.realpathSync(root) === root);
  const rootInfo = fs.lstatSync(root);
  need(rootInfo.isDirectory() && !(rootInfo.mode & 0o022));
  const owner = rootInfo.uid;
  let parts = absolute.slice(1).split('/'),
    resolved = [],
    links = 0;
  while (parts.length) {
    const part = parts.shift();
    need(part !== '..');
    if (!part || part === '.') continue;
    const current = path.join(root, ...resolved, part);
    if (
      fs.existsSync(current) ||
      (() => {
        try {
          fs.lstatSync(current);
          return true;
        } catch {
          return false;
        }
      })()
    ) {
      const s = fs.lstatSync(current);
      if (s.isSymbolicLink()) {
        need(++links <= 16);
        const target = fs.readlinkSync(current);
        // Preserve only normal distro directory aliases, never a caller-selected asset alias.
        const logical = '/' + [...resolved, part].join('/');
        need(
          (logical === '/lib64' && ['/lib', 'lib'].includes(target)) ||
            (logical === '/lib' && ['/usr/lib', 'usr/lib'].includes(target)),
        );
        const next = target.startsWith('/')
          ? target
          : path.posix.resolve('/' + resolved.join('/'), target);
        resolved = [];
        parts = [...next.slice(1).split('/'), ...parts];
        continue;
      }
      if (parts.length) need(s.isDirectory() && s.uid === owner && !(s.mode & 0o022));
    }
    resolved.push(part);
  }
  return path.join(root, ...resolved);
}
export function validateBundle(m) {
  need(
    m &&
      m.schema === 1 &&
      m.qualification === 'image-assets-only' &&
      m.packageSha256 === PACKAGE_SHA256 &&
      m.programSha256 === PROGRAM_SHA256 &&
      m.program === PROGRAM &&
      m.helper === HELPER &&
      typeof m.loader === 'string' &&
      m.loader.startsWith('/usr/lib/x86_64-linux-gnu/') &&
      m.signaturesReady === false &&
      m.profileReady === false &&
      m.runtimeQualified === false &&
      Array.isArray(m.files) &&
      m.files.length > 3 &&
      m.files.length <= 1536 &&
      Array.isArray(m.aliases) &&
      m.aliases.length <= 256 &&
      m.correspondingSource?.included === true &&
      m.correspondingSource.licensingAccepted === false,
  );
  const names = new Set();
  for (const f of m.files) {
    assetPath(f.path);
    need(
      allowedFile(f.path) &&
        !names.has(f.path) &&
        /^[a-f0-9]{64}$/u.test(f.sha256) &&
        Number.isSafeInteger(f.bytes) &&
        f.bytes >= 0 &&
        f.bytes <= 256 * 1024 * 1024 &&
        typeof f.executable === 'boolean',
    );
    names.add(f.path);
  }
  need(
    m.files.find((f) => f.path === PROGRAM)?.sha256 === PROGRAM_SHA256 &&
      names.has(m.loader) &&
      names.has(HELPER) &&
      names.has('/etc/ld.so.cache'),
  );
  for (const a of m.aliases) {
    assetPath(a.path);
    assetPath(a.target);
    need(allowedAlias(a.path) && names.has(a.target) && !names.has(a.path));
    names.add(a.path);
  }
  need(m.aliases.some((a) => a.path === INTERPRETER && a.target === m.loader));
  const source = m.correspondingSource;
  need(
    source.archive?.path === '/usr/share/doc/cortex-antivirus/clamav-1.4.6.tar.gz' &&
      source.archive.sha256 === SOURCE_SHA256 &&
      source.signature?.path === source.archive.path + '.sig' &&
      source.signature.sha256 === SOURCE_SIGNATURE_SHA256,
  );
  need(
    m.files.some(
      (f) =>
        f.path === source.archive.path &&
        f.sha256 === SOURCE_SHA256 &&
        f.bytes === source.archive.bytes,
    ) &&
      m.files.some(
        (f) =>
          f.path === source.signature.path &&
          f.sha256 === SOURCE_SIGNATURE_SHA256 &&
          f.bytes === source.signature.bytes,
      ),
  );
  return m;
}
/** Complete collision/preimage validation precedes every copy. No ordinary file is overwritten. */
export function installPlan(bundle, root = '/') {
  const m = validateBundle(
    JSON.parse(fs.readFileSync(regular(path.join(bundle, 'manifest.json')), 'utf8')),
  );
  const files = [],
    aliases = [],
    owner = fs.lstatSync(root).uid;
  for (const f of m.files) {
    const source = regular(path.join(bundle, 'root', f.path));
    need(fs.statSync(source).size === f.bytes && digest(fs.readFileSync(source)) === f.sha256);
    const destination = imagePath(root, f.path);
    if (
      fs.existsSync(destination) ||
      (() => {
        try {
          fs.lstatSync(destination);
          return true;
        } catch {
          return false;
        }
      })()
    ) {
      const s = fs.lstatSync(destination);
      need(
        s.isFile() &&
          !s.isSymbolicLink() &&
          s.nlink === 1 &&
          s.uid === owner &&
          !(s.mode & 0o022) &&
          digest(fs.readFileSync(destination)) === f.sha256,
      );
    }
    files.push({ ...f, source, destination });
  }
  for (const a of m.aliases) {
    const destination =
      imagePath(root, path.posix.dirname(a.path)) + '/' + path.posix.basename(a.path);
    try {
      const s = fs.lstatSync(destination);
      need(s.isSymbolicLink() && s.uid === owner && fs.readlinkSync(destination) === a.target);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    aliases.push({ ...a, destination });
  }
  return { manifest: m, files, aliases };
}
export function install(plan) {
  for (const f of plan.files)
    if (!fs.existsSync(f.destination)) {
      fs.mkdirSync(path.dirname(f.destination), { recursive: true, mode: 0o755 });
      fs.copyFileSync(f.source, f.destination, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(f.destination, f.executable ? 0o555 : 0o444);
    }
  for (const a of plan.aliases) {
    try {
      fs.lstatSync(a.destination);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      fs.mkdirSync(path.dirname(a.destination), { recursive: true, mode: 0o755 });
      fs.symlinkSync(a.target, a.destination);
    }
  }
}
/** AV needs a regular fixed path; PDF continues to use the original Alpine /bin/setpriv. */
export function copySetpriv(source = '/bin/setpriv', destination = '/usr/bin/setpriv') {
  regular(source);
  const bytes = fs.readFileSync(source);
  try {
    regular(destination);
    need(digest(fs.readFileSync(destination)) === digest(bytes));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  }
  need(fs.lstatSync(destination).nlink === 1 && fs.realpathSync(destination) === destination);
  return destination;
}
export function createFilter(policy, file) {
  need(typeof policy.createAntivirusProcessPolicy === 'function');
  const bytes = policy.createAntivirusProcessPolicy();
  need(
    Buffer.isBuffer(bytes) && bytes.length >= 8 && bytes.length <= 65536 && bytes.length % 8 === 0,
  );
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o444 });
  return file;
}
export function generate() {
  need(
    process.platform === 'linux' &&
      process.arch === 'x64' &&
      process.getuid() === 0 &&
      process.execPath === '/usr/local/bin/node' &&
      process.argv.length === 2,
  );
  regular('/etc/alpine-release');
  const plan = installPlan(BUNDLE);
  // Fixed AV tool collision must also be known before installing any glibc/vendor payload.
  regular('/bin/setpriv');
  try {
    regular('/usr/bin/setpriv');
    need(digest(fs.readFileSync('/usr/bin/setpriv')) === digest(fs.readFileSync('/bin/setpriv')));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  install(plan);
  const setpriv = copySetpriv();
  toolHelp(setpriv, ['--no-new-privs', '--seccomp-filter', '--landlock-access', '--landlock-rule']);
  const require = createRequire('/app/packages/api/package.json');
  const policy = regular(POLICY),
    compiled = compiledFiles(policy, '/app/packages/api/dist');
  createFilter(require(policy), FILTER);
  const libraryPaths = plan.files
    .filter(
      (f) =>
        f.path !== PROGRAM &&
        f.path !== HELPER &&
        (f.path.startsWith('/usr/local/lib/') ||
          f.path.startsWith('/usr/lib/x86_64-linux-gnu/') ||
          f.path === '/etc/ld.so.cache'),
    )
    .map((f) => f.path);
  need(libraryPaths.length >= 1 && libraryPaths.length <= 256);
  const files = seal([...plan.files.map((f) => f.path), setpriv, FILTER, ...compiled]);
  const asset = (p) => ({ path: p, sha256: files[p].sha256 });
  const result = {
    schema: 1,
    qualification: 'image-assets-only',
    packageSha256: PACKAGE_SHA256,
    program: asset(PROGRAM),
    loader: asset(plan.manifest.loader),
    setpriv: asset(setpriv),
    scopeHelper: asset(HELPER),
    filter: asset(FILTER),
    libraries: libraryPaths.map(asset),
    aliases: plan.manifest.aliases,
    notices: plan.manifest.notices,
    correspondingSource: plan.manifest.correspondingSource,
    helperSourceSha256: plan.manifest.helperSourceSha256,
    runtimePackages: plan.manifest.runtimePackages,
    files,
    signaturesReady: false,
    profileReady: false,
    runtimeQualified: false,
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o444 });
  seal([MANIFEST]);
  return result;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  console.log(JSON.stringify(generate()));
