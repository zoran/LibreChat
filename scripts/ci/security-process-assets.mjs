/** Final-image packaging for the existing SecurityProcessProfile; no host qualification. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SECURITY = '/app/packages/api/dist/uploads/security';
const PROFILE = `${SECURITY}/process-profile.json`;
const need = (ok) => {
  if (!ok) throw new Error('Security process image assets unavailable');
};

/** Paths in the runtime profile identify regular inodes, never aliases or directories. */
export function regular(file) {
  need(
    typeof file === 'string' &&
      path.isAbsolute(file) &&
      path.normalize(file) === file &&
      ![...file].some((character) => {
        const code = character.codePointAt(0);
        return code <= 31 || code === 127 || code === 44 || code === 58;
      }) &&
      fs.realpathSync(file) === file,
  );
  const info = fs.lstatSync(file);
  need(info.isFile() && info.nlink === 1 && info.size <= 256 * 1024 * 1024);
  return file;
}

/** tsdown emits relative shared chunks; follow their literal imports within this dist only. */
export function compiledFiles(entry, dist) {
  const found = new Set();
  function visit(file) {
    regular(file);
    need(file.startsWith(`${dist}/`) && /\.(cjs|mjs|js)$/u.test(file));
    if (found.has(file)) return;
    found.add(file);
    need(found.size <= 128);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
      const specifier = match[1];
      if (specifier.startsWith('.')) visit(path.resolve(path.dirname(file), specifier));
      else
        need(
          specifier.startsWith('node:') ||
            specifier === '@napi-rs/canvas' ||
            specifier === 'pdfjs-dist/legacy/build/pdf.mjs',
        );
    }
  }
  visit(entry);
  return [...found].sort();
}

/** Freeze only admitted image files and their ancestors, leaving application data directories alone. */
export function seal(files) {
  for (const file of [...new Set(files)].sort()) {
    regular(file);
    const mode = fs.statSync(file).mode;
    fs.chownSync(file, 0, 0);
    fs.chmodSync(file, mode & 0o111 ? 0o555 : 0o444);
    for (let parent = path.dirname(file); parent !== '/'; parent = path.dirname(parent)) {
      need(fs.realpathSync(parent) === parent && fs.lstatSync(parent).isDirectory());
      fs.chownSync(parent, 0, 0);
      fs.chmodSync(parent, fs.statSync(parent).mode & 0o755);
    }
  }
  return Object.fromEntries(
    [...new Set(files)].sort().map((file) => [
      file,
      {
        sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
        bytes: fs.statSync(file).size,
      },
    ]),
  );
}

export function toolHelp(tool, options) {
  regular(tool);
  const help = execFileSync(tool, ['--help'], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 65536,
    env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' },
  });
  need(options.every((option) => help.includes(option)));
}

export function generate() {
  need(
    process.platform === 'linux' &&
      process.arch === 'x64' &&
      process.getuid() === 0 &&
      process.execPath === '/usr/local/bin/node' &&
      process.argv.length === 2,
  );
  const alpineRelease = fs.readFileSync(regular('/etc/alpine-release'), 'utf8').trim();
  need(/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(alpineRelease));
  const require = createRequire('/app/packages/api/package.json');
  const setpriv = regular('/usr/bin/setpriv');
  const prlimit = regular('/usr/bin/prlimit');
  toolHelp(setpriv, ['--no-new-privs', '--seccomp-filter', '--landlock-access', '--landlock-rule']);
  toolHelp(prlimit, ['--core']);
  const entry = regular(`${SECURITY}/pdf-child.cjs`);
  const policyModule = regular(`${SECURITY}/process-policy.cjs`);
  const { createSecurityProcessPolicy } = require(policyModule);
  const filter = `${SECURITY}/process-policy.bpf`;
  const opensslConfig = `${SECURITY}/openssl-empty.cnf`;
  fs.writeFileSync(filter, createSecurityProcessPolicy(), { flag: 'wx', mode: 0o444 });
  fs.writeFileSync(opensslConfig, '', { flag: 'wx', mode: 0o444 });
  const canvasRoot = path.dirname(require.resolve('@napi-rs/canvas/package.json'));
  const canvasAddon = regular(require.resolve('@napi-rs/canvas-linux-x64-musl'));
  const pdfRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
  process.env.DISABLE_SYSTEM_FONTS_LOAD = '1';
  process.env.NAPI_RS_NATIVE_LIBRARY_PATH = canvasAddon;
  require('@napi-rs/canvas').createCanvas(1, 1).getContext('2d').fillRect(0, 0, 1, 1);
  // Observe the libraries actually loaded by this final musl Node/Canvas process.
  // This packages dependencies; it does not exercise the restricted child or attest a host.
  const report = process.report.getReport();
  need(!report.header.glibcVersionRuntime);
  const libraries = [
    ...new Set(
      report.sharedObjects
        .filter((file) => file.startsWith('/'))
        .map((file) => fs.realpathSync(file)),
    ),
  ];
  need(
    libraries.includes('/lib/ld-musl-x86_64.so.1') &&
      libraries.includes(canvasAddon) &&
      libraries.every(
        (file) => file === canvasAddon || file.startsWith('/lib/') || file.startsWith('/usr/lib/'),
      ),
  );
  const fonts = fs
    .readdirSync(`${pdfRoot}/standard_fonts`)
    .filter((file) => /\.(pfb|ttf)$/u.test(file));
  need(
    fonts.length > 0 &&
      fonts.length <= 64 &&
      fonts.every((file) => /^[A-Za-z0-9_-]+\.(pfb|ttf)$/u.test(file)),
  );
  const readFiles = [
    ...new Set([
      ...compiledFiles(entry, '/app/packages/api/dist'),
      '/app/package.json',
      '/app/packages/api/package.json',
      ...['package.json', 'index.js', 'js-binding.js', 'geometry.js', 'load-image.js'].map(
        (file) => `${canvasRoot}/${file}`,
      ),
      ...[
        'package.json',
        'legacy/build/pdf.mjs',
        'legacy/build/pdf.worker.mjs',
        ...fonts.map((file) => `standard_fonts/${file}`),
      ].map((file) => `${pdfRoot}/${file}`),
      ...libraries,
    ]),
  ].sort();
  need(readFiles.length <= 512);
  readFiles.forEach(regular);
  const profile = {
    setpriv,
    node: regular(process.execPath),
    entry,
    filter,
    opensslConfig,
    canvasAddon,
    readFiles,
    executeFiles: ['/lib/ld-musl-x86_64.so.1'],
  };
  fs.writeFileSync(PROFILE, `${JSON.stringify(profile, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
  const files = seal([
    PROFILE,
    '/etc/alpine-release',
    setpriv,
    prlimit,
    profile.node,
    entry,
    policyModule,
    filter,
    opensslConfig,
    canvasAddon,
    ...readFiles,
    ...profile.executeFiles,
  ]);
  return {
    alpineRelease,
    profile: PROFILE,
    profileSha256: files[PROFILE].sha256,
    files,
    qualification: 'image-assets-only',
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  console.log(JSON.stringify(generate()));
}
