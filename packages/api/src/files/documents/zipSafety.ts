import yauzl from 'yauzl';
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

  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
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
          let entryCapped = false;
          const chunks: Buffer[] = [];
          const keep = options.select(entry.fileName);

          readStream.on('data', (chunk: Buffer) => {
            if (entryCapped) {
              return;
            }
            entryBytes += chunk.byteLength;
            totalDecompressed += chunk.byteLength;
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

      zipfile.on('end', () => finish(null));
      zipfile.on('error', (zipErr: Error) => finish(zipErr));
    });
  });
}
