/** Private child entry only; the launcher must isolate credentials, resources and diagnostics. */
import { closeSync, fstatSync, readSync, writeSync } from 'node:fs';
import type { SecurityProcessResult } from './process-wire';
import type { PdfSecurityOcr } from './pdf';
import {
  readSecurityProcessRequest,
  readSecurityProcessResult,
  SECURITY_PROCESS_LIMITS,
  encodeSecurityProcessFrameHeader,
  readSecurityProcessFrameHeader,
} from './process-wire';
import { inspectPdfSecurity, PDF_SECURITY_LIMITS } from './pdf';

class InputFailure extends Error {
  constructor(readonly reason: 'invalid_content' | 'resource_limit') {
    super(reason);
  }
}

/**
 * One bounded stdin frame and bounded fd3 page/result frames. stdout/stderr remain private
 * diagnostics. The actual child asks its trusted parent for OCR through its inherited fd3 only.
 * This entry provides neither OS isolation nor an approval/cleanup attestation.
 */
export async function runPdfSecurityChild(ocr?: PdfSecurityOcr): Promise<void> {
  const write = (bytes: Uint8Array) => {
    let offset = 0;
    while (offset < bytes.length) {
      const count = writeSync(3, bytes, offset, Math.min(65536, bytes.length - offset));
      if (count <= 0) throw new InputFailure('invalid_content');
      offset += count;
    }
  };
  const read = (length: number) => {
    const bytes = Buffer.alloc(length);
    try {
      let offset = 0;
      while (offset < length) {
        const count = readSync(3, bytes, offset, length - offset, null);
        if (count <= 0) throw new InputFailure('invalid_content');
        offset += count;
      }
      return bytes;
    } catch (error) {
      bytes.fill(0);
      throw error;
    }
  };
  const broker: PdfSecurityOcr = {
    async readPage({ page, width, height, rgba, signal }) {
      signal.throwIfAborted();
      const header = encodeSecurityProcessFrameHeader({
        version: 2,
        kind: 'page',
        page,
        width,
        height,
        bytes: rgba.length,
      });
      let prefix: Buffer | undefined;
      let encoded: Buffer | undefined;
      let text: Buffer | undefined;
      try {
        write(header);
        write(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength));
        prefix = read(4);
        const size = prefix.readUInt32BE();
        if (size < 1 || size > 1024) throw new InputFailure('invalid_content');
        encoded = read(size);
        const response = readSecurityProcessFrameHeader(encoded);
        if (!response || response.kind !== 'ocr' || response.page !== page)
          throw new InputFailure('invalid_content');
        text = read(response.bytes);
        signal.throwIfAborted();
        return {
          complete: response.complete,
          readable: response.readable,
          text: new TextDecoder('utf-8', { fatal: true }).decode(text),
        };
      } finally {
        header.fill(0);
        prefix?.fill(0);
        encoded?.fill(0);
        text?.fill(0);
      }
    },
  };
  let frame: Buffer | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: SecurityProcessResult = {
    decision: 'uninspectable',
    reason: 'invalid_content',
  };
  try {
    const maximum = 4 + SECURITY_PROCESS_LIMITS.headerBytes + SECURITY_PROCESS_LIMITS.documentBytes;
    frame = Buffer.alloc(maximum);
    let length = 0;
    timer = setTimeout(
      () => process.stdin.destroy(new InputFailure('resource_limit')),
      PDF_SECURITY_LIMITS.timeoutMs,
    );
    for await (const chunk of process.stdin) {
      if (!Buffer.isBuffer(chunk)) throw new InputFailure('invalid_content');
      try {
        if (chunk.length > maximum - length) throw new InputFailure('resource_limit');
        chunk.copy(frame, length);
        length += chunk.length;
      } finally {
        chunk.fill(0);
      }
    }
    clearTimeout(timer);
    const request = readSecurityProcessRequest(frame.subarray(0, length));
    if (!request) throw new InputFailure('invalid_content');
    result = await inspectPdfSecurity({ ...request, ocr: ocr ?? broker });
    process.exitCode = 0;
  } catch (error) {
    result = {
      decision: 'uninspectable',
      reason: error instanceof InputFailure ? error.reason : 'invalid_content',
    };
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    frame?.fill(0);
    process.stdin.destroy();
  }

  let output = Buffer.from(JSON.stringify(result), 'utf8');
  if (!readSecurityProcessResult(output)) {
    output.fill(0);
    output = Buffer.from('{"decision":"uninspectable","reason":"invalid_content"}');
    process.exitCode = 1;
  }
  let resultPipe = false;
  try {
    const descriptor = fstatSync(3);
    resultPipe = descriptor.isFIFO() || descriptor.isSocket();
    if (!resultPipe) throw new Error();
    const header = encodeSecurityProcessFrameHeader({
      version: 2,
      kind: 'result',
      bytes: output.length,
    });
    try {
      write(header);
      write(output);
    } finally {
      header.fill(0);
    }
  } catch {
    process.exitCode = 2;
  } finally {
    output.fill(0);
    if (resultPipe) {
      try {
        closeSync(3);
      } catch {
        process.exitCode = 2;
      }
    }
  }
}

if (require.main === module) {
  void runPdfSecurityChild().catch(() => {
    process.exitCode = 2;
  });
}
