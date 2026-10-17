/** Private child entry only; the launcher must isolate credentials, resources and diagnostics. */
import { closeSync, fstatSync, writeSync } from 'node:fs';
import { inspectPdfSecurity, PDF_SECURITY_LIMITS } from './pdf';
import type { PdfSecurityOcr } from './pdf';
import {
  readSecurityProcessRequest,
  readSecurityProcessResult,
  SECURITY_PROCESS_LIMITS,
} from './process-wire';
import type { NegativeSecurityProcessResult } from './process-wire';

class InputFailure extends Error {
  constructor(readonly reason: 'invalid_content' | 'resource_limit') {
    super(reason);
  }
}

/**
 * One bounded stdin frame and one negative fd3 result. stdout/stderr remain private diagnostics,
 * never application logs. OCR is supplied only by trusted composition; the real main has none.
 * This entry provides neither OS isolation nor an approval/cleanup attestation.
 */
export async function runPdfSecurityChild(ocr?: PdfSecurityOcr): Promise<void> {
  let frame: Buffer | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: NegativeSecurityProcessResult = {
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
    result = await inspectPdfSecurity({ ...request, ocr });
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
    let offset = 0;
    while (offset < output.length) {
      const written = writeSync(3, output, offset, output.length - offset);
      if (written <= 0) throw new Error();
      offset += written;
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
