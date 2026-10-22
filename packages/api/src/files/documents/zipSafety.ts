import yauzl from 'yauzl';
import { crc32 } from 'node:zlib';
import { megabyte } from 'librechat-data-provider';

/**
 * Default per-archive total decompressed-size cap. Office documents in
 * normal use rarely exceed a few MB inflated; 100 MB leaves generous
 * headroom for image-heavy templates while still catching the
 * pathological zip-bomb case (e.g. a 1 MB compressed XLSX that inflates
 * to 200+ MB of XML — see SEC review on PR #12934).
 */
const DEFAULT_MAX_TOTAL_BYTES = 100 * megabyte;

/**
 * Default per-entry decompressed-size cap. A single inflated entry
 * larger than this is essentially always either a bomb or content the
 * downstream parser would balk at anyway.
 */
const DEFAULT_MAX_ENTRY_BYTES = 25 * megabyte;

/**
 * Tag-distinct error so callers (e.g. the office HTML producers and the
 * RAG document parser) can distinguish a refused zip-bomb from generic
 * parse failures and emit a sensible "file too large to preview" UI
 * instead of silently degrading.
 */
export class ZipBombError extends Error {
  readonly code = 'ZIP_BOMB';
  constructor(message: string) {
    super(message);
    this.name = 'ZipBombError';
  }
}

export interface ZipSafetyOptions {
  /** Per-archive total decompressed-byte cap. */
  maxTotalBytes?: number;
  /** Per-entry decompressed-byte cap. */
  maxEntryBytes?: number;
  /** Maximum count includes directory entries. */
  maxEntries?: number;
  /** Filename for error messages — does not need to match disk. */
  name?: string;
  /** DOCX reader agreement: canonical ZIP32 envelope, matching headers and actual CRCs. */
  strictEnvelope?: boolean;
}

/** Validate framing only; yauzl remains the sole ZIP reader/inflater. Unknown envelopes fail closed. */
function strictEnvelopeNames(buffer: Buffer, maxEntries: number): Set<string> {
  const invalid = () => new Error('Invalid or unsupported ZIP envelope');
  const bound = (offset: number, size: number, end = buffer.length) => {
    if (offset < 0 || size < 0 || offset + size > end) throw invalid();
  };
  const end = buffer.length - 22;
  bound(end, 22);
  if (
    buffer.readUInt32LE(end) !== 0x06054b50 ||
    buffer.readUInt16LE(end + 4) !== 0 ||
    buffer.readUInt16LE(end + 6) !== 0 ||
    buffer.readUInt16LE(end + 20) !== 0
  )
    throw invalid();
  const count = buffer.readUInt16LE(end + 10);
  const directory = buffer.readUInt32LE(end + 16);
  if (count > maxEntries) throw new ZipBombError('Archive entry count exceeds its cap');
  if (
    count === 0xffff ||
    buffer.readUInt16LE(end + 8) !== count ||
    directory + buffer.readUInt32LE(end + 12) !== end
  )
    throw invalid();
  const names = new Set<string>();
  const folded = new Set<string>();
  const ranges: Array<[number, number]> = [];
  let cursor = directory;
  for (let index = 0; index < count; index++) {
    bound(cursor, 46, end);
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw invalid();
    const version = buffer.readUInt16LE(cursor + 6);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const inflated = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const local = buffer.readUInt32LE(cursor + 42);
    const attributes = buffer.readUInt32LE(cursor + 38);
    const mode = attributes >>> 16;
    bound(cursor + 46, nameLength + extraLength + commentLength, end);
    // Only stored/deflated ZIP32, optional data descriptors and ASCII part names. No encryption,
    // Unicode-path overrides, ZIP64, symlinks, multi-disk archives or unclassified extra fields.
    if (
      ![10, 20].includes(version) ||
      flags & ~0x080e ||
      ![0, 8].includes(method) ||
      (method === 0 && (flags & 6) !== 0) ||
      extraLength !== 0 ||
      commentLength !== 0 ||
      nameLength > 1024 ||
      buffer.readUInt16LE(cursor + 34) !== 0 ||
      ![0, 0x4000, 0x8000].includes(mode & 0xf000)
    )
      throw invalid();
    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = rawName.toString('ascii');
    const segments = name.replace(/\/$/, '').split('/');
    const key = name.replace(/\/$/, '').toLowerCase();
    if (
      !rawName.equals(Buffer.from(name, 'ascii')) ||
      !/^[A-Za-z0-9_[\]./-]+$/.test(name) ||
      segments.some((part) => !part || part === '.' || part === '..') ||
      folded.has(key) ||
      // JSZip treats this DOS bit as a directory even when the name has no trailing slash.
      ((attributes & 0x10) !== 0 && !name.endsWith('/')) ||
      ((mode & 0xf000) === 0x4000 && !name.endsWith('/')) ||
      ((mode & 0xf000) === 0x8000 && name.endsWith('/'))
    )
      throw invalid();
    names.add(name);
    folded.add(key);
    bound(local, 30, directory);
    if (
      buffer.readUInt32LE(local) !== 0x04034b50 ||
      buffer.readUInt16LE(local + 4) !== version ||
      buffer.readUInt16LE(local + 6) !== flags ||
      buffer.readUInt16LE(local + 8) !== method ||
      buffer.readUInt32LE(local + 10) !== buffer.readUInt32LE(cursor + 12) ||
      buffer.readUInt16LE(local + 26) !== nameLength ||
      buffer.readUInt16LE(local + 28) !== 0
    )
      throw invalid();
    bound(local + 30, nameLength + compressed, directory);
    if (!buffer.subarray(local + 30, local + 30 + nameLength).equals(rawName)) throw invalid();
    const localValues = [14, 18, 22].map((offset) => buffer.readUInt32LE(local + offset));
    const expected = [checksum, compressed, inflated];
    if (
      !localValues.every((value, offset) => value === expected[offset]) &&
      !((flags & 8) !== 0 && localValues.every((value) => value === 0))
    )
      throw invalid();
    let finish = local + 30 + nameLength + compressed;
    if (flags & 8) {
      bound(finish, 12, directory);
      if (buffer.readUInt32LE(finish) === 0x08074b50) finish += 4;
      bound(finish, 12, directory);
      if (!expected.every((value, offset) => buffer.readUInt32LE(finish + offset * 4) === value))
        throw invalid();
      finish += 12;
    }
    if (name.endsWith('/') && (method !== 0 || flags & 8 || expected.some((value) => value !== 0)))
      throw invalid();
    ranges.push([local, finish]);
    cursor += 46 + nameLength;
  }
  if (cursor !== end) throw invalid();
  let next = 0;
  for (const [start, finish] of ranges.sort((left, right) => left[0] - right[0])) {
    if (start !== next) throw invalid();
    next = finish;
  }
  if (next !== directory) throw invalid();
  const files = new Set(
    Array.from(names)
      .filter((name) => !name.endsWith('/'))
      .map((name) => name.toLowerCase()),
  );
  for (const name of names) {
    const segments = name.split('/');
    for (let length = 1; length < segments.length; length++) {
      const parent = segments.slice(0, length).join('/').toLowerCase();
      if (files.has(parent)) throw invalid();
    }
  }
  return names;
}

/**
 * Validate that a ZIP-backed buffer (DOCX, XLSX, XLS-as-OOXML, ODS,
 * ODT, PPTX, …) does not blow up under decompression beyond the given
 * caps. Streams every entry through yauzl and counts real decompressed
 * bytes mid-inflate — the central directory's `uncompressedSize` cannot
 * be trusted (it can be falsified to lie about the payload, the
 * specific bypass technique used in the SEC validation PoC for
 * PR #12934).
 *
 * Drops the decompressed bytes immediately (only counts them), so the
 * validator's own memory footprint is bounded by yauzl's stream
 * buffer regardless of payload size. CPU is bounded by `maxTotalBytes`
 * — once the cap fires, the underlying read stream is destroyed and
 * decompression stops.
 *
 * Throws `ZipBombError` on cap violation; throws plain `Error` on a
 * malformed ZIP. Resolves with `void` when the archive is fully walked
 * within caps.
 */
export function assertSafeZipSize(buffer: Buffer, options: ZipSafetyOptions = {}): Promise<void> {
  return readSafeZipEntries(buffer, { ...options, select: () => false }).then(() => undefined);
}

/** One bounded inflate pass; only explicitly selected entries are retained. */
export function readSafeZipEntries(
  buffer: Buffer,
  options: ZipSafetyOptions & { select: (name: string) => boolean },
): Promise<Map<string, Buffer>> {
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxEntryBytes = options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const maxEntries = options.maxEntries ?? 2048;
  const label = options.name ?? 'archive';
  for (const limit of [maxTotalBytes, maxEntryBytes, maxEntries]) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      return Promise.reject(new Error('Invalid ZIP resource limit'));
    }
  }

  let strictNames: Set<string> | undefined;
  try {
    if (options.strictEnvelope) strictNames = strictEnvelopeNames(buffer, maxEntries);
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, strictFileNames: !!strictNames },
      (err, zipfile) => {
        if (err) {
          return reject(err);
        }
        if (!zipfile) {
          return reject(new Error('Failed to open zip buffer'));
        }

        let settled = false;
        let totalDecompressed = 0;
        let entryCount = 0;
        const names = new Set<string>();
        const selected = new Map<string, Buffer>();
        const finish = (error: Error | null) => {
          if (settled) {
            return;
          }
          settled = true;
          try {
            zipfile.close();
          } catch {
            /* zipfile.close() is best-effort — yauzl will throw if a
             * stream is mid-flight. We've already settled the outer
             * promise, so swallow this. */
          }
          if (error) {
            reject(error);
          } else {
            resolve(selected);
          }
        };

        zipfile.readEntry();

        zipfile.on('entry', (entry: yauzl.Entry) => {
          if (settled) {
            return;
          }
          entryCount++;
          if (entryCount > maxEntries) {
            return finish(new ZipBombError(`${label}: archive entry count exceeds its cap`));
          }
          // Ambiguous duplicate parts must not be interpreted differently by another parser.
          if (names.has(entry.fileName)) {
            return finish(new Error('Duplicate ZIP entry'));
          }
          names.add(entry.fileName);
          if (strictNames && !strictNames.has(entry.fileName)) {
            return finish(new Error('Ambiguous ZIP entry name'));
          }
          /* Directory entries (trailing slash) are zero-byte and don't
           * need to be opened. Saves a stream allocation per directory
           * in archives like .docx that have nested subfolders. */
          if (/\/$/.test(entry.fileName)) {
            zipfile.readEntry();
            return;
          }

          zipfile.openReadStream(entry, (streamErr, readStream) => {
            if (streamErr || !readStream) {
              return finish(streamErr ?? new Error('Failed to open zip entry stream'));
            }

            let entryBytes = 0;
            let checksum = 0;
            let entryCapped = false;
            const chunks: Buffer[] = [];
            const keep = options.select(entry.fileName);

            readStream.on('data', (chunk: Buffer) => {
              if (entryCapped) {
                return;
              }
              entryBytes += chunk.byteLength;
              totalDecompressed += chunk.byteLength;
              if (strictNames) checksum = crc32(chunk, checksum);
              if (entryBytes > maxEntryBytes) {
                entryCapped = true;
                readStream.destroy();
                finish(
                  new ZipBombError(
                    `${label}: entry "${entry.fileName}" exceeds the ${
                      maxEntryBytes / megabyte
                    }MB per-entry decompressed cap`,
                  ),
                );
                return;
              }
              if (totalDecompressed > maxTotalBytes) {
                entryCapped = true;
                readStream.destroy();
                finish(
                  new ZipBombError(
                    `${label}: total decompressed size exceeds the ${
                      maxTotalBytes / megabyte
                    }MB cap (zip bomb suspected)`,
                  ),
                );
                return;
              }
              if (keep) {
                chunks.push(chunk);
              }
            });

            readStream.on('end', () => {
              if (!settled) {
                if (
                  strictNames &&
                  (entryBytes !== entry.uncompressedSize || checksum !== entry.crc32)
                ) {
                  finish(new Error('Invalid ZIP entry integrity'));
                  return;
                }
                if (keep) {
                  selected.set(entry.fileName, Buffer.concat(chunks, entryBytes));
                }
                zipfile.readEntry();
              }
            });
            readStream.on('error', (readErr: Error) => {
              if (!entryCapped) {
                finish(readErr);
              }
            });
          });
        });

        zipfile.on('end', () =>
          finish(
            strictNames && names.size !== strictNames.size
              ? new Error('Incomplete ZIP envelope')
              : null,
          ),
        );
        zipfile.on('error', (zipErr: Error) => finish(zipErr));
      },
    );
  });
}
