/** Real built parser and Unix IPC qualification; no storage, database or model service. */
import JSZip from 'jszip';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type { UploadParserResourceOwner } from '../platform/parserResources';
import type { DocumentSidecar } from './sidecar';
import { MANAGED_DOCUMENT_LIMITS } from '../../files/documents/managed';
import fixtures from './fixtures/managed-documents/manifest.json';
import { createUnixDocumentPort } from './client';
import { startDocumentSidecar } from './sidecar';

const fixtureRoot = path.join(__dirname, 'fixtures/managed-documents');
const childEntry = path.resolve(__dirname, '../../../dist/uploads/processing/parser-child.cjs');

describe('built managed document flow', () => {
  let root: string;
  let stagingRoot: string;
  let scratchRoot: string;
  let socketPath: string;
  let sidecar: DocumentSidecar | undefined;
  let documents: ReturnType<typeof createUnixDocumentPort>;
  // This trusted test port admits only the isolated fixture. Native cgroup qualification is separate.
  const resources: UploadParserResourceOwner = {
    start: jest.fn(async () => undefined),
    claim: jest.fn(),
    release: jest.fn(),
    safe: () => true,
    current: () => undefined,
    close: jest.fn(),
  };

  beforeAll(async () => {
    // A missing build is a qualification failure, never a skipped parser or an implicit rebuild.
    await stat(childEntry).catch(() => {
      throw new Error(
        'Built managed parser unavailable; run npm run build:api from the repository root',
      );
    });
    const directory = process.env.UPLOAD_TEST_TMPDIR ?? tmpdir();
    await mkdir(directory, { recursive: true });
    root = await mkdtemp(path.join(directory, 'flow-'));
    stagingRoot = path.join(root, 'staging');
    scratchRoot = path.join(root, 'scratch');
    socketPath = path.join(root, 'parser.sock');
    if (Buffer.byteLength(socketPath) >= 100)
      throw new Error('Upload fixture root must allow a short Unix socket path');
    await mkdir(stagingRoot, { mode: 0o700 });
    await mkdir(scratchRoot, { mode: 0o700 });
    sidecar = await startDocumentSidecar({
      socketPath,
      stagingRoot,
      scratchRoot,
      childEntry,
      resourceOwner: resources,
    });
    documents = createUnixDocumentPort({ socketPath, stagingRoot });
  });

  afterAll(async () => {
    await sidecar?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function stage(attemptId: string, data: Buffer) {
    const directory = path.join(stagingRoot, attemptId);
    await mkdir(directory, { mode: 0o700 });
    const original = path.join(directory, 'original');
    await writeFile(original, data, { flag: 'wx', mode: 0o600 });
    return { directory, original };
  }

  async function extract(attemptId: string, mediaType: string) {
    const signal = new AbortController().signal;
    const execution = await documents.prepare({ attemptId, mediaType, signal });
    const result = await documents.extract({ execution, signal });
    expect(result.writerStopped).toBe(true);
    const original = await readFile(path.join(stagingRoot, attemptId, 'original'));
    expect(result.structure.source).toEqual({
      sha256: createHash('sha256').update(original).digest('hex'),
      bytes: original.length,
      mediaType,
    });
    for (const element of result.structure.elements) {
      expect(element.end).toBeLessThanOrEqual(result.text.length);
      expect(element.start).toBeLessThanOrEqual(element.end);
    }
    if (mediaType === 'application/pdf') expect(result.structure.pages[0]?.kind).toBe('page');
    if (mediaType.includes('presentationml')) expect(result.structure.pages[0]?.kind).toBe('slide');
    // A terminal receipt also acknowledges cancellation without relaunching the child.
    await expect(documents.cancel({ execution, signal })).resolves.toEqual({ writerStopped: true });
    return result.text;
  }

  it.each(fixtures.fixtures)(
    'extracts real $filename facts and joins before cleanup',
    async (fixture) => {
      const original = await readFile(path.join(fixtureRoot, fixture.filename));
      expect(original.byteLength).toBe(fixture.bytes);
      expect(createHash('sha256').update(original).digest('hex')).toBe(fixture.sha256);
      const attemptId = `golden-${fixture.slot}.1`;
      const staged = await stage(attemptId, original);
      const text = await extract(attemptId, fixture.mediaType);
      for (const marker of fixture.markers) expect(text).toContain(marker);
      if (fixture.slot === 'D') {
        expect(text.indexOf('Reihenfolge Anfang')).toBeLessThan(text.indexOf('Reihenfolge Ende'));
      }
      // The parser cannot delete the retained original or leave an extraction tree behind.
      expect(await readFile(staged.original)).toEqual(original);
      expect(await readdir(scratchRoot)).toEqual([]);
      await rm(staged.directory, { recursive: true });
      await expect(stat(staged.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('accepts exactly 30 MiB once and rejects one additional input byte', async () => {
    const fixture = fixtures.fixtures.find((item) => item.slot === 'C')!;
    const zip = await JSZip.loadAsync(await readFile(path.join(fixtureRoot, fixture.filename)));
    // Two unused STORE entries keep every entry below 25 MiB and total inflation below 100 MiB.
    zip.file('padding-a.bin', Buffer.alloc(0));
    zip.file('padding-b.bin', Buffer.alloc(0));
    const options = { type: 'nodebuffer' as const, compression: 'STORE' as const };
    const overhead = (await zip.generateAsync(options)).byteLength;
    const padding = MANAGED_DOCUMENT_LIMITS.inputBytes - overhead;
    zip.file('padding-a.bin', Buffer.alloc(16 * 1024 * 1024));
    zip.file('padding-b.bin', Buffer.alloc(padding - 16 * 1024 * 1024));
    const original = await zip.generateAsync(options);
    expect(original.byteLength).toBe(30 * 1024 * 1024);
    const staged = await stage('boundary.1', original);
    const text = await extract('boundary.1', fixture.mediaType);
    for (const marker of fixture.markers) expect(text).toContain(marker);
    await rm(staged.directory, { recursive: true });

    const oversized = await stage('boundary.2', original);
    await appendFile(oversized.original, Buffer.from([0]));
    expect((await stat(oversized.original)).size).toBe(30 * 1024 * 1024 + 1);
    await expect(extract('boundary.2', fixture.mediaType)).rejects.toMatchObject({
      code: 'resource_limit',
      writerStopped: true,
    });
    await rm(oversized.directory, { recursive: true });
  }, 30_000);

  it('rejects output above 15 MiB without publishing partial text', async () => {
    const staged = await stage('output-cap.1', Buffer.alloc(15 * 1024 * 1024 + 1, 'a'));
    await expect(extract('output-cap.1', 'text/plain')).rejects.toMatchObject({
      code: 'resource_limit',
      writerStopped: true,
    });
    await rm(staged.directory, { recursive: true });
  });

  it('fences a prepared attempt without running a delayed extraction', async () => {
    const staged = await stage('cancelled.1', Buffer.from('must not be published'));
    const signal = new AbortController().signal;
    const execution = await documents.prepare({
      attemptId: 'cancelled.1',
      mediaType: 'text/plain',
      signal,
    });
    await expect(documents.cancel({ execution, signal })).resolves.toEqual({ writerStopped: true });
    const claims = (resources.claim as jest.Mock).mock.calls.length;
    await expect(documents.extract({ execution, signal })).rejects.toMatchObject({
      code: 'cancelled',
      writerStopped: true,
    });
    expect(resources.claim).toHaveBeenCalledTimes(claims);
    await rm(staged.directory, { recursive: true });
  });
});
