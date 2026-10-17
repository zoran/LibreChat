/** Pure TXT byte inspection. Execution isolation, byte binding and approval belong to the caller. */
import { TextDecoder } from 'node:util';
import type { SecurityMarkingPolicy, SecurityMarkingResult } from './markings';
import { inspectSecurityMarkings } from './markings';

// One complete context unit: never split a literal or prose frame across artificial boundaries.
const MAX_TEXT_BYTES = 65_536;

/**
 * Inspect canonical text/plain as strict UTF-8, allowing one leading UTF-8 BOM.
 * The entire text is a body context: TXT has no trustworthy heading/page-layout metadata.
 * Larger inputs remain uninspectable until safe complete-context segmentation is qualified.
 * Known foreign-format prefixes are refused, not parsed; this is no general MIME detector.
 * `clear` is only classification evidence, never UploadSecurityApproval or a sandbox/cleanup proof.
 */
export function inspectPlainTextSecurity(input: {
  bytes: Uint8Array;
  mediaType: string;
  policy: SecurityMarkingPolicy;
}): SecurityMarkingResult {
  try {
    const { bytes, mediaType, policy } = input;
    if (
      mediaType !== 'text/plain' ||
      !(bytes instanceof Uint8Array) ||
      (typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer)
    ) {
      return { decision: 'uninspectable', reason: 'invalid_content' };
    }
    if (bytes.byteLength > MAX_TEXT_BYTES) {
      return { decision: 'uninspectable', reason: 'resource_limit' };
    }
    // fatal rejects replacement decoding. ignoreBOM:false consumes exactly the initial BOM;
    // any additional/interior BOM remains visible to the classifier's ambiguity check.
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    if (/^\s*(?:%PDF-|%!PS|\{\\rtf\d|<[\w!?/])/iu.test(text)) {
      return { decision: 'uninspectable', reason: 'invalid_content' };
    }
    return inspectSecurityMarkings(policy, {
      version: 1,
      coverage: { complete: true, pages: 1, parts: 1 },
      units: [{ part: 1, page: 1, placement: 'body', text }],
    });
  } catch {
    // Never expose decoder errors, source fragments or caller-provided exception messages.
    return { decision: 'uninspectable', reason: 'invalid_content' };
  }
}
