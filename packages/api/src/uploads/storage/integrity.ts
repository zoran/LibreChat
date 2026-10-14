import { createHash } from 'node:crypto';
import {
  UPLOAD_INTEGRITY_CHUNK_BYTES,
  UPLOAD_MAX_FILE_BYTES,
  isUploadOriginalIntegrity,
} from 'librechat-data-provider';
import type { UploadOriginalIntegrity } from 'librechat-data-provider';

const mismatch = () => new Error('Managed original integrity mismatch');
function validBytes(bytes: number): boolean {
  return Number.isSafeInteger(bytes) && bytes > 0 && bytes <= UPLOAD_MAX_FILE_BYTES;
}
function byteView(value: Uint8Array): Buffer {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw mismatch();
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** Incremental identity for the already bounded receive stream; never retains input content. */
export function createOriginalIntegrity(bytes: number): {
  update(chunk: Uint8Array): void;
  finish(): UploadOriginalIntegrity;
} {
  if (!validBytes(bytes)) throw mismatch();
  const whole = createHash('sha256');
  let block = createHash('sha256');
  const chunks: string[] = [];
  let received = 0,
    inBlock = 0,
    sealed = false;
  return {
    update(chunk) {
      if (sealed) throw mismatch();
      let value: Buffer;
      try {
        value = byteView(chunk);
        if (received + value.byteLength > bytes) throw mismatch();
      } catch (error) {
        sealed = true;
        throw error;
      }
      whole.update(value);
      for (let offset = 0; offset < value.byteLength; ) {
        const count = Math.min(UPLOAD_INTEGRITY_CHUNK_BYTES - inBlock, value.byteLength - offset);
        block.update(value.subarray(offset, offset + count));
        offset += count;
        received += count;
        inBlock += count;
        if (inBlock === UPLOAD_INTEGRITY_CHUNK_BYTES) {
          chunks.push(block.digest('hex'));
          block = createHash('sha256');
          inBlock = 0;
        }
      }
    },
    finish() {
      if (sealed) throw mismatch();
      sealed = true;
      if (received !== bytes) throw mismatch();
      if (inBlock) chunks.push(block.digest('hex'));
      const integrity: UploadOriginalIntegrity = {
        version: 1,
        algorithm: 'sha256',
        sha256: whole.digest('hex'),
        chunkBytes: UPLOAD_INTEGRITY_CHUNK_BYTES,
        chunkSha256: chunks,
      };
      Object.freeze(integrity.chunkSha256);
      return Object.freeze(integrity);
    },
  };
}

/** Verify before disclosure, with one working block and no speculative source read-ahead.
 * The caller owns cancellation of a stalled underlying I/O source; iterator cleanup is joined.
 */
export function verifyOriginalIntegrity(
  body: AsyncIterable<Uint8Array>,
  bytes: number,
  integrity: UploadOriginalIntegrity,
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  if (!isUploadOriginalIntegrity(integrity, bytes)) throw mismatch();
  // Snapshot before the first await: mutable caller metadata cannot change the expected identity.
  const expectedSha = integrity.sha256;
  const expectedChunks = integrity.chunkSha256.slice();
  return (async function* () {
    signal.throwIfAborted();
    const whole = createHash('sha256');
    let block = Buffer.allocUnsafe(Math.min(UPLOAD_INTEGRITY_CHUNK_BYTES, bytes));
    let received = 0,
      filled = 0,
      index = 0;
    for await (const chunk of body) {
      signal.throwIfAborted();
      const value = byteView(chunk);
      if (received + value.byteLength > bytes) throw mismatch();
      for (let offset = 0; offset < value.byteLength; ) {
        signal.throwIfAborted();
        const count = Math.min(block.byteLength - filled, value.byteLength - offset);
        const part = value.subarray(offset, offset + count);
        block.set(part, filled);
        whole.update(part);
        offset += count;
        received += count;
        filled += count;
        if (filled === block.byteLength) {
          if (createHash('sha256').update(block).digest('hex') !== expectedChunks[index++])
            throw mismatch();
          if (received < bytes) {
            yield block;
            signal.throwIfAborted();
            block = Buffer.allocUnsafe(Math.min(UPLOAD_INTEGRITY_CHUNK_BYTES, bytes - received));
            filled = 0;
          }
        }
      }
    }
    signal.throwIfAborted();
    if (
      received !== bytes ||
      index !== expectedChunks.length ||
      whole.digest('hex') !== expectedSha
    )
      throw mismatch();
    // Even an exact full final block waits for actual EOF and whole-file verification.
    yield block;
  })();
}
