/** Build-stage ClamAV packaging: pinned public input, static ELF closure; never executes ClamAV. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PACKAGE_SHA256 = 'd3ee9e401974855a1edc1761b1425417d126de618d5f0c91cd51209f69f6fcc2';
export const SOURCE_SHA256 = '06dbc7adf96e2f6a27c548a841ce83c95360d1e121b106a6f7cf56f282a3c61b';
export const SOURCE_SIGNATURE_SHA256 =
  'f55ae2aa17482cf870f16578e56c2d77885c22ac748ebee9f6808c4dbba93bea';
export const SOURCE_URL = 'https://www.clamav.net/downloads/production/clamav-1.4.6.tar.gz';
export const TALOS_PRIMARY = '5BADCA2665EF59DCF8A23D8B707F0DB480836771';
export const PROGRAM_SHA256 = '03a1bea28cba1cf7dd5aec447e2317c61bac188e3057e342d09119a34d277839';
export const PROGRAM = '/usr/local/sbin/clamd';
export const HELPER = '/app/packages/api/dist/uploads/security/native/antivirus-scope';
export const INTERPRETER = '/lib64/ld-linux-x86-64.so.2';
export const VENDOR_URL =
  'https://www.clamav.net/downloads/production/clamav-1.4.6.linux.x86_64.deb';
export const need = (ok) => {
  if (!ok) throw Error('Antivirus image assets refused');
};
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function assetPath(p) {
  need(
    typeof p === 'string' &&
      p.startsWith('/') &&
      path.posix.normalize(p) === p &&
      !/[\x00-\x20,:]/u.test(p) &&
      !p.split('/').includes('..'),
  );
  return p;
}
export function boundedFile(p) {
  const s = fs.lstatSync(p);
  need(
    s.isFile() &&
      !s.isSymbolicLink() &&
      s.nlink === 1 &&
      s.size >= 0 &&
      s.size <= 256 * 1024 * 1024,
  );
  return fs.readFileSync(p);
}
/** readelf output only; no ldd, loader --list, dlopen or binary --version execution. */
export function parseElf(text) {
  need(
    /Class:\s+ELF64/u.test(text) &&
      /Data:\s+2's complement, little endian/u.test(text) &&
      /Machine:\s+Advanced Micro Devices X86-64/u.test(text),
  );
  const needed = [...text.matchAll(/\(NEEDED\)[^\n]*\[([^\]]+)\]/gu)].map((m) => m[1]);
  const interpreter = [...text.matchAll(/Requesting program interpreter:\s*([^\]]+)\]/gu)].map(
    (m) => m[1],
  );
  need(
    needed.length <= 64 &&
      needed.every((n) => /^[A-Za-z0-9_.+-]+$/u.test(n)) &&
      interpreter.length <= 1 &&
      interpreter.every((p) => p === INTERPRETER),
  );
  // The checksum-pinned vendor program uses precisely this immutable packaged root.
  // No environment expansion, relative directory or alternate search path is admitted.
  need(!/\((?:RPATH|AUDIT|DEPAUDIT|FILTER|AUXILIARY)\)/u.test(text));
  const runpaths = [...text.matchAll(/\(RUNPATH\)[^\n]*\[([^\]]+)\]/gu)].map((m) => m[1]);
  need(runpaths.length <= 1 && runpaths.every((p) => p === '/usr/local/lib'));
  const versions = {},
    definitions = [];
  let section = '',
    file;
  for (const line of text.split('\n')) {
    if (line.startsWith('Version needs section')) {
      section = 'needs';
      file = undefined;
    } else if (line.startsWith('Version definition section')) section = 'defs';
    else if (line.startsWith('Version symbols section')) section = 'symbols';
    if (section === 'needs') {
      const f = line.match(/File:\s*(\S+)/u);
      if (f) {
        file = f[1];
        versions[file] ??= [];
      }
      const n = line.match(/Name:\s*(\S+)/u);
      if (n) {
        need(file);
        versions[file].push(n[1]);
      }
    }
    if (section === 'defs') {
      const n = line.match(/Name:\s*(\S+)/u);
      if (n) definitions.push(n[1]);
    }
  }
  need(Object.keys(versions).every((n) => needed.includes(n)));
  return { needed, interpreter: interpreter[0] ?? null, versions, definitions };
}
export function inspectElf(file) {
  const bytes = boundedFile(file),
    sha256 = digest(bytes);
  const elf = parseElf(
    execFileSync('/usr/bin/readelf', ['-W', '-h', '-l', '-d', '-V', file], {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    }),
  );
  need(digest(boundedFile(file)) === sha256);
  return { ...elf, sha256 };
}

/** Resolve through the declared Debian build root/vendor tree, never an ambient runtime inventory. */
export function resolveLibrary(name, vendorRoot, systemRoot = '/') {
  need(/^[A-Za-z0-9_.+-]+$/u.test(name));
  for (const [root, prefix] of [
    [vendorRoot, '/usr/local/lib'],
    [systemRoot, '/usr/lib/x86_64-linux-gnu'],
    [systemRoot, '/lib/x86_64-linux-gnu'],
  ]) {
    const source = path.join(root, prefix, name);
    if (!fs.existsSync(source)) continue;
    const real = fs.realpathSync(source),
      base = fs.realpathSync(root);
    need(real.startsWith(base === '/' ? '/' : base + '/'));
    const target = assetPath('/' + path.relative(base, real));
    need(target.startsWith('/usr/local/lib/') || target.startsWith('/usr/lib/x86_64-linux-gnu/'));
    boundedFile(real);
    return { source: real, path: target, alias: assetPath(prefix + '/' + name) };
  }
  throw Error('Antivirus ELF dependency missing');
}
/** Every symbol-version edge is checked against its actual SONAME provider, not a global union. */
export function collectClosure(entries, resolve, inspect = inspectElf) {
  const files = new Map(),
    aliases = new Map(),
    edges = [];
  const alias = (p, target) => {
    need(!aliases.has(p) || aliases.get(p) === target);
    aliases.set(p, target);
  };
  const visit = (entry) => {
    assetPath(entry.path);
    if (files.has(entry.path)) {
      need(files.get(entry.path).source === entry.source);
      return;
    }
    need(files.size < 128);
    const elf = inspect(entry.source);
    files.set(entry.path, { ...entry, elf });
    if (entry.alias && entry.alias !== entry.path) alias(entry.alias, entry.path);
    for (const name of elf.needed) {
      const dependency = resolve(name);
      visit(dependency);
      if (dependency.alias !== dependency.path) alias(dependency.alias, dependency.path);
      edges.push({
        from: entry.path,
        name,
        to: dependency.path,
        versions: elf.versions[name] ?? [],
      });
    }
    if (elf.interpreter) {
      const loader = resolve('ld-linux-x86-64.so.2');
      visit(loader);
      alias(elf.interpreter, loader.path);
    }
  };
  entries.forEach(visit);
  for (const edge of edges)
    need(edge.versions.every((v) => files.get(edge.to).elf.definitions.includes(v)));
  return {
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
    aliases: [...aliases]
      .map(([p, target]) => ({ path: p, target }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    edges,
  };
}
function copy(source, dest, expected) {
  const bytes = boundedFile(source);
  need(expected === undefined || digest(bytes) === expected);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 });
  need(!fs.existsSync(dest));
  fs.writeFileSync(dest, bytes, { flag: 'wx' });
  fs.chmodSync(dest, fs.statSync(source).mode & 0o111 ? 0o555 : 0o444);
}
/** Preserve full vendor documentation and public build-runtime licenses; no license waiver is emitted. */
export function copyNotices(
  source,
  destination,
  files = [],
  allowedRoot = path.dirname(source),
  depth = 0,
) {
  need(depth <= 16);
  const real = fs.realpathSync(source),
    base = fs.realpathSync(allowedRoot);
  need(real === base || real.startsWith(base + '/'));
  const info = fs.lstatSync(real);
  if (info.isDirectory()) {
    for (const name of fs.readdirSync(real).sort())
      copyNotices(
        path.join(real, name),
        path.join(destination, name),
        files,
        allowedRoot,
        depth + 1,
      );
  } else {
    need(files.length < 1024);
    copy(real, destination);
    files.push(destination);
  }
  return files;
}

/** Exact installed binary/source identifiers; repository policy is retained without guessing origin. */
export function parseDebianPackage(line, policy) {
  const fields = line.trim().split('\t');
  need(fields.length === 5 && fields.every((v) => v.length > 0 && v.length <= 256));
  const [binaryPackage, version, sourcePackage, sourceVersion, architecture] = fields;
  need(
    /^[a-z0-9][a-z0-9+.-]*(?::amd64)?$/.test(binaryPackage) &&
      /^[a-z0-9][a-z0-9+.-]*$/.test(sourcePackage) &&
      architecture === 'amd64' &&
      typeof policy === 'string' &&
      Buffer.byteLength(policy) <= 65536 &&
      policy.includes('Installed: ' + version),
  );
  const repositories = [...new Set(policy.match(/https?:\/\/[^\s]+/g) ?? [])];
  need(
    repositories.every((uri) =>
      /^https?:\/\/(?:deb\.debian\.org|security\.debian\.org)\//.test(uri),
    ),
  );
  return {
    binaryPackage,
    version,
    sourcePackage,
    sourceVersion,
    architecture,
    origins: {
      repositories,
      policy,
      policySha256: digest(policy),
      status:
        'actual installed metadata and repository policy; no inferred source-distribution acceptance',
    },
  };
}
function runtimePackages(entries) {
  const packages = new Set();
  const run = (tool, args) =>
    execFileSync(tool, args, {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 65536,
      env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    });
  for (const e of entries.filter((e) => e.path.startsWith('/usr/lib/x86_64-linux-gnu/'))) {
    let owner;
    for (const name of [e.source, e.source.replace(/^\/usr\/lib\//, '/lib/')]) {
      if (!fs.existsSync(name) || fs.realpathSync(name) !== e.source) continue;
      try {
        const lines = run('/usr/bin/dpkg-query', ['-S', name]).trim().split('\n');
        need(lines.length === 1);
        owner = lines[0].split(': ')[0];
        break;
      } catch (error) {
        if (error.status !== 1) throw error;
      }
    }
    need(typeof owner === 'string' && /^[a-z0-9][a-z0-9+.-]*(?::amd64)?$/.test(owner));
    packages.add(owner);
  }
  need(packages.size > 0 && packages.size <= 32);
  return [...packages]
    .sort()
    .map((name) =>
      parseDebianPackage(
        run('/usr/bin/dpkg-query', [
          '-W',
          '-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\t${Architecture}\n',
          name,
        ]),
        run('/usr/bin/apt-cache', ['policy', name]),
      ),
    );
}
/** Copy the exact officially signed corresponding-source input; never execute/extract its archive. */
export function copyCorrespondingSource(archive, signature, root) {
  need(
    digest(boundedFile(archive)) === SOURCE_SHA256 &&
      digest(boundedFile(signature)) === SOURCE_SIGNATURE_SHA256,
  );
  const base = '/usr/share/doc/cortex-antivirus/clamav-1.4.6.tar.gz';
  copy(archive, path.join(root, base), SOURCE_SHA256);
  copy(signature, path.join(root, base + '.sig'), SOURCE_SIGNATURE_SHA256);
  return {
    included: true,
    archive: {
      path: base,
      sha256: SOURCE_SHA256,
      bytes: fs.statSync(archive).size,
      url: SOURCE_URL,
    },
    signature: {
      path: base + '.sig',
      sha256: SOURCE_SIGNATURE_SHA256,
      bytes: fs.statSync(signature).size,
      primaryFingerprint: TALOS_PRIMARY,
      qualification:
        'checksum pin of authentic Talos-verified acquisition; build does not claim a new PGP check',
    },
    licensingAccepted: false,
    releaseObligation:
      'Official ClamAV corresponding source is included; applicable vendor/runtime/helper redistribution obligations and notices remain binding.',
  };
}
export function build({ vendorRoot, output, packageFile, helper, helperSource, systemRoot = '/' }) {
  need(
    process.platform === 'linux' &&
      process.arch === 'x64' &&
      fs.realpathSync(output) === output &&
      fs.readdirSync(output).length === 0,
  );
  need(digest(boundedFile(packageFile)) === PACKAGE_SHA256);
  const program = path.join(vendorRoot, PROGRAM);
  need(digest(boundedFile(program)) === PROGRAM_SHA256);
  const resolve = (name) => resolveLibrary(name, vendorRoot, systemRoot);
  const roots = [
    { path: PROGRAM, source: program },
    { path: HELPER, source: helper },
    ...['libclamunrar_iface.so.12', 'libclamunrar.so.12'].map(resolve),
  ];
  const closure = collectClosure(roots, resolve);
  const root = path.join(output, 'root');
  fs.mkdirSync(root);
  for (const entry of closure.files)
    copy(entry.source, path.join(root, entry.path), entry.elf.sha256);
  for (const alias of closure.aliases) {
    const target = path.join(root, alias.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    need(!fs.existsSync(target));
    fs.symlinkSync(alias.target, target);
  }
  fs.mkdirSync(path.join(root, 'etc'), { recursive: true });
  // Only this generated glibc cache is copied; Alpine musl's loader/config remain unchanged.
  execFileSync(
    '/sbin/ldconfig',
    ['-r', root, '-C', '/etc/ld.so.cache', '/usr/local/lib', '/usr/lib/x86_64-linux-gnu'],
    {
      timeout: 10000,
      maxBuffer: 65536,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' },
    },
  );
  const notices = '/usr/share/doc/cortex-antivirus';
  const correspondingSource = copyCorrespondingSource(
    '/build/clamav-source.tar.gz',
    '/build/clamav-source.tar.gz.sig',
    root,
  );
  copyNotices(
    path.join(vendorRoot, 'usr/local/share/doc/ClamAV'),
    path.join(root, notices, 'vendor'),
  );
  copy(packageFile, path.join(root, notices, 'clamav-1.4.6-1-amd64.deb'));
  copy(helperSource, path.join(root, notices, 'antivirus-scope.c'));
  const runtime = runtimePackages(closure.files);
  for (const pkg of runtime) {
    const name = pkg.binaryPackage.replace(/:amd64$/, '');
    copyNotices(
      path.join(systemRoot, 'usr/share/doc', name),
      path.join(root, notices, 'runtime', name),
      [],
      path.join(systemRoot, 'usr/share'),
    );
    const copyright = path.join(root, notices, 'runtime', name, 'copyright');
    pkg.copyright = {
      path: '/' + path.relative(root, copyright),
      sha256: digest(boundedFile(copyright)),
    };
  }
  copyNotices(
    path.join(systemRoot, 'usr/share/common-licenses'),
    path.join(root, notices, 'common-licenses'),
  );
  const files = [];
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scan(p);
      else if (e.isFile())
        files.push({
          path: '/' + path.relative(root, p),
          sha256: digest(boundedFile(p)),
          bytes: fs.statSync(p).size,
          executable: !!(fs.statSync(p).mode & 0o111),
        });
      else need(e.isSymbolicLink());
    }
  };
  scan(root);
  const aliases = [];
  const flattened = (p, depth = 0) => {
    need(depth <= 16 && p.startsWith(root + '/'));
    const info = fs.lstatSync(p);
    if (info.isSymbolicLink()) {
      const target = fs.readlinkSync(p);
      return flattened(
        target.startsWith('/') ? path.join(root, target) : path.resolve(path.dirname(p), target),
        depth + 1,
      );
    }
    need(info.isFile());
    return '/' + path.relative(root, p);
  };
  const scanLinks = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) scanLinks(p);
      else if (e.isSymbolicLink())
        aliases.push({ path: '/' + path.relative(root, p), target: flattened(p) });
    }
  };
  scanLinks(root);
  need(files.length <= 1536 && aliases.length <= 256);
  const manifest = {
    schema: 1,
    qualification: 'image-assets-only',
    packageSha256: PACKAGE_SHA256,
    programSha256: PROGRAM_SHA256,
    vendor: { version: '1.4.6-1', architecture: 'amd64', url: VENDOR_URL },
    program: PROGRAM,
    helper: HELPER,
    loader: closure.files.find((e) => path.basename(e.path) === 'ld-linux-x86-64.so.2').path,
    helperSourceSha256: digest(boundedFile(helperSource)),
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    aliases: aliases.sort((a, b) => a.path.localeCompare(b.path)),
    elfEdges: closure.edges,
    runtimePackages: runtime,
    notices,
    correspondingSource,
    signaturesReady: false,
    profileReady: false,
    runtimeQualified: false,
  };
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o444,
  });
  return manifest;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  need(process.argv.length === 2 && process.getuid() === 0);
  build({
    vendorRoot: '/build/vendor',
    output: '/out',
    packageFile: '/build/clamav.deb',
    helper: '/build/antivirus-scope',
    helperSource: '/build/antivirus-scope.c',
  });
}
