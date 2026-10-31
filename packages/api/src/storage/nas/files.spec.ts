/** Real private-file invariants; only negative kernel mount metadata is synthetic. */
import path from 'node:path';
import { mkdtemp, writeFile, chmod, symlink, link, rm, readdir } from 'node:fs/promises';
const fs: typeof import('node:fs/promises') = jest.requireActual('node:fs/promises');
import { readNasLocalFile, parseNasCredentials } from './files';
const signal = new AbortController().signal;
const message = 'NAS storage configuration unavailable';
const secret = JSON.stringify({
  schema: 1,
  accessKeyId: 'SYNTHETIC_ACCESS',
  secretAccessKey: 'SYNTHETIC_SECRET',
});
let root: string;
beforeEach(async () => {
  if (!process.env.NAS_TEST_TMPDIR) throw Error('Owned detached test directory required');
  root = await mkdtemp(path.join(process.env.NAS_TEST_TMPDIR, 'nas-files-'));
});
afterEach(async () => {
  jest.restoreAllMocks();
  if (root) await rm(root, { recursive: true });
});
async function file(content = secret, mode = 0o600) {
  const p = path.join(root, 'input.json');
  await writeFile(p, content, { mode });
  return p;
}
async function rejected(p: string, secretFile = true, abort = signal) {
  const failure = await readNasLocalFile(p, { secret: secretFile, signal: abort }).catch(
    (error) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).toBe(message);
  expect(failure.cause).toBeUndefined();
  expect(failure.message).not.toContain(root);
}
it('reads actual private schema1 input and public certificate bytes with joined descriptor lifetime', async () => {
  const p = await file();
  const result = await readNasLocalFile(p, { secret: true, signal });
  expect(result.toString()).toBe(secret);
  expect(parseNasCredentials(result)).toEqual({
    accessKeyId: 'SYNTHETIC_ACCESS',
    secretAccessKey: 'SYNTHETIC_SECRET',
  });
  expect(Object.isFrozen(parseNasCredentials(result))).toBe(true);
  result.fill(0);
  await chmod(p, 0o444);
  expect((await readNasLocalFile(p, { secret: false, signal })).toString()).toBe(secret);
});
it.each([
  'symlink',
  'hardlink',
  'directory',
  'world',
  'execute',
  'group-write',
  'special',
  'empty',
  'large',
  'missing',
  'traversal',
  'ancestor-alias',
  'writable-ancestor',
])('refuses actual %s without exposing content or pathname', async (variant) => {
  expect.hasAssertions();
  let p = await file();
  if (variant === 'symlink') {
    const target = path.join(root, 'alias');
    await symlink(p, target);
    p = target;
  }
  if (variant === 'hardlink') await link(p, path.join(root, 'link'));
  if (variant === 'directory') p = root;
  if (variant === 'world') await chmod(p, 0o644);
  if (variant === 'execute') await chmod(p, 0o700);
  if (variant === 'group-write') await chmod(p, 0o620);
  if (variant === 'special') await chmod(p, 0o4600);
  if (variant === 'empty') await writeFile(p, '');
  if (variant === 'large') await writeFile(p, Buffer.alloc(16385, 1));
  if (variant === 'missing') p = path.join(root, 'absent');
  if (variant === 'traversal') p = root + '/../' + path.basename(root) + '/input.json';
  if (variant === 'ancestor-alias') {
    const d = path.join(root, 'alias');
    await symlink(root, d);
    p = path.join(d, 'input.json');
  }
  if (variant === 'writable-ancestor') await chmod(root, 0o777);
  await rejected(p);
});
it('refuses actual FIFO/nonregular input without waiting for a writer', async () => {
  expect.hasAssertions();
  if (!process.env.NAS_TEST_FIFO) throw Error('Owned FIFO required');
  await rejected(process.env.NAS_TEST_FIFO);
});
it('checks all relevant remote/autofs mount ancestry before any target lookup or open', async () => {
  const p = await file();
  for (const type of ['nfs', 'nfs4', 'cifs', 'autofs', 'unknown']) {
    const metadata = `1 0 0:1 / / rw - overlay overlay rw\n2 1 0:2 / ${root} rw - ${type} synthetic rw\n3 2 0:3 / ${p} rw - tmpfs tmpfs rw\n`;
    const read = jest.spyOn(fs, 'readFile').mockResolvedValue(metadata);
    const open = jest.spyOn(fs, 'open');
    const stat = jest.spyOn(fs, 'lstat');
    await rejected(p);
    expect(open).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    read.mockRestore();
    open.mockRestore();
    stat.mockRestore();
  }
});
it('keeps local siblings independent and rejects malformed/oversized mount evidence', async () => {
  const p = await file();
  const actual = fs.readFile;
  for (const bad of ['', 'malformed', 'x'.repeat(2 * 1024 * 1024 + 1)]) {
    const read = jest.spyOn(fs, 'readFile').mockResolvedValue(bad);
    await rejected(p);
    read.mockRestore();
  }
  const read = jest
    .spyOn(fs, 'readFile')
    .mockImplementation(((filename: unknown, ...args: unknown[]) =>
      filename === '/proc/self/mountinfo'
        ? Promise.resolve(
            `1 0 0:1 / / rw - overlay overlay rw\n2 1 0:2 / ${root}-other rw - nfs synthetic rw\n`,
          )
        : Reflect.apply(actual, fs, [filename, ...args])) as typeof fs.readFile);
  expect((await readNasLocalFile(p, { secret: true, signal })).toString()).toBe(secret);
  read.mockRestore();
});
it('closes descriptors on success/rejection and converts arbitrary abort reasons to the generic error', async () => {
  const p = await file();
  await readNasLocalFile(p, { secret: true, signal });
  const before = (await readdir('/proc/self/fd')).length;
  for (let i = 0; i < 12; i++) {
    await readNasLocalFile(p, { secret: true, signal });
    await rejected(root);
  }
  expect((await readdir('/proc/self/fd')).length).toBeLessThanOrEqual(before);
  const c = new AbortController();
  c.abort(new Error('SYNTHETIC_PRIVATE_ABORT ' + root));
  await rejected(p, true, c.signal);
});
it.each(['\0', '\r', '\n', '\t', '\b', '\u001b', '\u007f'])(
  'rejects every credential control character %#',
  (control) => {
    const bytes = Buffer.from(
      JSON.stringify({
        schema: 1,
        accessKeyId: 'SYNTHETIC' + control,
        secretAccessKey: 'SYNTHETIC_SECRET',
      }),
    );
    expect(() => parseNasCredentials(bytes)).toThrow(message);
  },
);
it.each([
  {},
  [],
  { schema: 2, accessKeyId: 'x', secretAccessKey: 'y' },
  { schema: 1, accessKeyId: 'x' },
  { schema: 1, accessKeyId: 'x', secretAccessKey: 'y', sessionToken: 'forbidden' },
  { schema: 1, accessKeyId: 'x', secretAccessKey: '' },
])('keeps the runtime credential schema closed', (value) => {
  expect(() => parseNasCredentials(Buffer.from(JSON.stringify(value)))).toThrow(message);
});
it('rejects malformed JSON and invalid UTF-8 generically', () => {
  for (const bytes of [Buffer.from('{'), Buffer.from([0xff, 0xfe])])
    expect(() => parseNasCredentials(bytes)).toThrow(message);
});
