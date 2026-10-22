import JSZip from 'jszip';
import { megabyte } from 'librechat-data-provider';
import { assertSafeZipSize, readSafeZipEntries, ZipBombError } from './zipSafety';

/**
 * Build a ZIP archive whose entries inflate to exactly `decompressedBytes`
 * each. The data is highly compressible (single repeated character) so
 * compressed size stays small — roughly 0.5% of inflated size for runs
 * of zero bytes. Used to simulate the zip-bomb attack pattern from the
 * SEC validation PoC on PR #12934.
 */
const buildBombArchive = async (
  entries: Array<{ name: string; decompressedBytes: number }>,
): Promise<Buffer> => {
  const zip = new JSZip();
  for (const { name, decompressedBytes } of entries) {
    zip.file(name, Buffer.alloc(decompressedBytes, 0));
  }
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
};

/** Build a small, well-formed ZIP for the happy-path tests. */
const buildBenignArchive = async (): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file('hello.txt', 'hello world');
  zip.file('subdir/note.txt', 'second entry');
  return zip.generateAsync({ type: 'nodebuffer' });
};

describe('assertSafeZipSize', () => {
  test('passes a benign small archive', async () => {
    const buffer = await buildBenignArchive();
    await expect(assertSafeZipSize(buffer)).resolves.toBeUndefined();
  });

  test('passes an archive whose entries are all under both caps', async () => {
    const buffer = await buildBombArchive([
      { name: 'a.bin', decompressedBytes: 1 * megabyte },
      { name: 'b.bin', decompressedBytes: 1 * megabyte },
    ]);
    await expect(
      assertSafeZipSize(buffer, { maxTotalBytes: 10 * megabyte, maxEntryBytes: 5 * megabyte }),
    ).resolves.toBeUndefined();
  });

  test('throws ZipBombError when a single entry exceeds the per-entry cap', async () => {
    /* Single 5 MB inflated entry compresses to a few KB. Per-entry cap of
     * 1 MB should fire mid-inflate. */
    const buffer = await buildBombArchive([{ name: 'big.bin', decompressedBytes: 5 * megabyte }]);
    await expect(assertSafeZipSize(buffer, { maxEntryBytes: 1 * megabyte })).rejects.toThrow(
      ZipBombError,
    );
  });

  test('throws ZipBombError when total decompressed size exceeds the total cap', async () => {
    /* Many small-but-not-tiny entries that individually pass the per-entry
     * cap but collectively bust the total cap. Catches the multi-entry
     * variant of the attack. */
    const buffer = await buildBombArchive(
      Array.from({ length: 5 }, (_, i) => ({
        name: `chunk${i}.bin`,
        decompressedBytes: 1 * megabyte,
      })),
    );
    await expect(
      assertSafeZipSize(buffer, { maxTotalBytes: 3 * megabyte, maxEntryBytes: 2 * megabyte }),
    ).rejects.toThrow(ZipBombError);
  });

  test('cap-violation error is a ZipBombError, not a generic Error', async () => {
    const buffer = await buildBombArchive([{ name: 'big.bin', decompressedBytes: 5 * megabyte }]);
    /* Distinguishing the bomb case from a generic parse failure lets
     * the UI surface a meaningful "preview unavailable, file too large
     * to inflate" message instead of a vague 500. */
    await expect(assertSafeZipSize(buffer, { maxEntryBytes: 1 * megabyte })).rejects.toMatchObject({
      name: 'ZipBombError',
      code: 'ZIP_BOMB',
    });
  });

  test('rejects a malformed zip', async () => {
    /* Not a real zip — yauzl will throw a parse error (NOT a
     * ZipBombError; that distinction matters to callers). */
    const buffer = Buffer.from('not a real zip');
    await expect(assertSafeZipSize(buffer)).rejects.toThrow();
    await expect(assertSafeZipSize(buffer)).rejects.not.toBeInstanceOf(ZipBombError);
  });

  test('handles archives containing directory entries without crashing', async () => {
    const zip = new JSZip();
    zip.folder('emptydir');
    zip.file('emptydir/file.txt', 'data');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(assertSafeZipSize(buffer)).resolves.toBeUndefined();
  });

  test('uses provided name in the error message for caller-side surfacing', async () => {
    const buffer = await buildBombArchive([{ name: 'big.bin', decompressedBytes: 5 * megabyte }]);
    await expect(
      assertSafeZipSize(buffer, { maxEntryBytes: 1 * megabyte, name: 'evil.docx' }),
    ).rejects.toThrow(/evil\.docx/);
  });

  test('re-PoC: catches the SEC-validation attack pattern (sub-1MB compressed → 100MB+ inflated)', async () => {
    /* Mirrors the SEC validation PoC shape: a sub-1MB compressed
     * archive whose entries inflate to many tens of MB. Tests that the
     * default caps fire on this canonical attack without the caller
     * needing to override anything. The PoC inflated to ~200MB across
     * several entries; we use 50MB for test-suite speed (still well
     * over both default caps). */
    const buffer = await buildBombArchive([
      { name: 'word/document.xml', decompressedBytes: 50 * megabyte },
    ]);
    /* Defense-in-depth check: the compressed payload IS small (proves
     * the input would slip past a compressed-size gate). */
    expect(buffer.length).toBeLessThan(1 * megabyte);
    /* And the validator catches it on default caps. */
    await expect(assertSafeZipSize(buffer)).rejects.toThrow(ZipBombError);
  });
});

describe('opt-in DOCX ZIP envelope agreement', () => {
  async function archive(streamFiles = false, compression: 'STORE' | 'DEFLATE' = 'STORE') {
    const zip = new JSZip();
    zip.file('word/document.xml', 'Native body 😀', { createFolders: false });
    return zip.generateAsync({ type: 'nodebuffer', streamFiles, compression });
  }
  function positions(buffer: Buffer) {
    const end = buffer.length - 22;
    const central = buffer.readUInt32LE(end + 16);
    const local = buffer.readUInt32LE(central + 42);
    const data = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    return { end, central, local, data };
  }
  const strict = (buffer: Buffer) =>
    readSafeZipEntries(buffer, { strictEnvelope: true, select: () => true });
  it('rejects the DOS directory bit on a file name without a trailing slash', async () => {
    const buffer = await archive();
    const central = positions(buffer).central;
    buffer.writeUInt32LE((buffer.readUInt32LE(central + 38) | 0x10) >>> 0, central + 38);
    await expect(strict(buffer)).rejects.toThrow();
  });
  it.each([0, 0x10])('accepts a slash directory with DOS directory bit %i', async (attribute) => {
    const zip = new JSZip();
    zip.folder('word');
    zip.file('word/document.xml', 'Native body', { createFolders: false });
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const central = positions(buffer).central;
    expect(
      buffer.subarray(central + 46, central + 46 + buffer.readUInt16LE(central + 28)).toString(),
    ).toBe('word/');
    buffer.writeUInt32LE(
      ((buffer.readUInt32LE(central + 38) & ~0x10) | attribute) >>> 0,
      central + 38,
    );
    expect((await strict(buffer)).get('word/document.xml')?.toString()).toBe('Native body');
  });
  it.each([false, true])('preserves native bytes with data descriptors=%s', async (streamFiles) => {
    const result = await strict(await archive(streamFiles, 'DEFLATE'));
    expect(result.get('word/document.xml')?.toString()).toBe('Native body 😀');
  });
  it.each([
    [
      'actual CRC',
      (buffer: Buffer) => {
        buffer[positions(buffer).data] ^= 1;
      },
    ],
    [
      'local CRC',
      (buffer: Buffer) => {
        buffer[positions(buffer).local + 14] ^= 1;
      },
    ],
    [
      'local compression',
      (buffer: Buffer) => {
        buffer.writeUInt16LE(8, positions(buffer).local + 8);
      },
    ],
    [
      'local name',
      (buffer: Buffer) => {
        buffer[positions(buffer).local + 30] = 120;
      },
    ],
    [
      'local size',
      (buffer: Buffer) => {
        buffer[positions(buffer).local + 18] ^= 1;
      },
    ],
    [
      'encryption',
      (buffer: Buffer) => {
        const p = positions(buffer);
        buffer.writeUInt16LE(1, p.central + 8);
        buffer.writeUInt16LE(1, p.local + 6);
      },
    ],
    [
      'unknown flags',
      (buffer: Buffer) => {
        const p = positions(buffer);
        buffer.writeUInt16LE(16, p.central + 8);
        buffer.writeUInt16LE(16, p.local + 6);
      },
    ],
    [
      'unsupported compression',
      (buffer: Buffer) => {
        const p = positions(buffer);
        buffer.writeUInt16LE(99, p.central + 10);
        buffer.writeUInt16LE(99, p.local + 8);
      },
    ],
    [
      'multi-disk envelope',
      (buffer: Buffer) => {
        buffer.writeUInt16LE(1, positions(buffer).end + 4);
      },
    ],
    [
      'invalid central directory size',
      (buffer: Buffer) => {
        buffer[positions(buffer).end + 12] ^= 1;
      },
    ],
    [
      'symlink entry',
      (buffer: Buffer) => {
        buffer.writeUInt32LE(0xa1ff0000, positions(buffer).central + 38);
      },
    ],
  ])('refuses %s', async (_label, mutate) => {
    const buffer = await archive();
    (mutate as (buffer: Buffer) => void)(buffer);
    await expect(strict(buffer)).rejects.toThrow();
  });
  it('keeps CRC enforcement opt-in for existing other-format callers', async () => {
    const buffer = await archive();
    buffer[positions(buffer).data] ^= 1;
    await expect(assertSafeZipSize(buffer)).resolves.toBeUndefined();
    await expect(strict(buffer)).rejects.toThrow('integrity');
  });
  it('rejects a falsified data descriptor', async () => {
    const buffer = await archive(true);
    buffer[positions(buffer).central - 12] ^= 1;
    await expect(strict(buffer)).rejects.toThrow();
  });
  it.each([
    'word/../document.xml',
    'word//document.xml',
    'word/%64ocument.xml',
    'word\\document.xml',
  ])('refuses aliased part name %s', async (name) => {
    const zip = new JSZip();
    zip.file(name, 'body', { createFolders: false });
    await expect(strict(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow();
  });
  it('rejects case aliases and file/directory collisions', async () => {
    for (const extra of ['WORD/DOCUMENT.XML', 'word']) {
      const zip = new JSZip();
      zip.file('word/document.xml', 'body', { createFolders: false });
      zip.file(extra, 'other', { createFolders: false });
      await expect(strict(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow();
    }
  });
  it('rejects duplicate raw names even when both local and central names agree', async () => {
    const zip = new JSZip();
    zip.file('a.xml', 'first', { createFolders: false });
    zip.file('b.xml', 'second', { createFolders: false });
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const first = positions(buffer).central;
    const second = first + 46 + buffer.readUInt16LE(first + 28);
    const local = buffer.readUInt32LE(second + 42);
    buffer[second + 46] = 97;
    buffer[local + 30] = 97;
    await expect(strict(buffer)).rejects.toThrow();
  });
  it('rejects unaccounted prefix bytes that a generic ZIP reader can skip', async () => {
    const original = await archive();
    const prefix = Buffer.from('unaccounted');
    const buffer = Buffer.concat([prefix, original]);
    const end = buffer.length - 22;
    const central = positions(original).central + prefix.length;
    buffer.writeUInt32LE(central, end + 16);
    buffer.writeUInt32LE(prefix.length, central + 42);
    await expect(assertSafeZipSize(buffer)).resolves.toBeUndefined();
    await expect(strict(buffer)).rejects.toThrow();
  });
  it('checks strict resource limits while inflating even unselected content', async () => {
    const buffer = await archive(false, 'DEFLATE');
    await expect(
      readSafeZipEntries(buffer, { strictEnvelope: true, maxEntryBytes: 3, select: () => false }),
    ).rejects.toBeInstanceOf(ZipBombError);
    await expect(
      readSafeZipEntries(buffer, { strictEnvelope: true, maxTotalBytes: 3, select: () => false }),
    ).rejects.toBeInstanceOf(ZipBombError);
  });
  it('rejects archive comments and trailing bytes instead of ignoring unaccounted data', async () => {
    const zip = new JSZip();
    zip.file('body.xml', 'body');
    Object.assign(zip, { comment: 'unaccounted' });
    await expect(strict(await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow();
    await expect(
      strict(Buffer.concat([await archive(), Buffer.from('trailing')])),
    ).rejects.toThrow();
  });
});
