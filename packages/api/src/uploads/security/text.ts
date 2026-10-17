/** Pure text byte inspection. Execution isolation, byte binding and approval belong to the caller. */
import { TextDecoder } from 'node:util';
import type { SecurityMarkingPolicy } from './markings';
import type { SecurityInspectionResult } from './inspection';
import { inspectCompleteSecurityEvidence } from './inspection';
import { MANAGED_CSV_LIMITS, parseManagedCsv } from '../../files/documents/csv';

// One complete context unit: never split a literal or prose frame across artificial boundaries.
const MAX_TEXT_BYTES = 65_536;
type TextSecurityInput = {
  bytes: Uint8Array;
  mediaType: string;
  policy: SecurityMarkingPolicy;
};

/**
 * Inspect canonical text/plain as strict UTF-8, allowing one leading UTF-8 BOM.
 * The entire text is a body context: TXT has no trustworthy heading/page-layout metadata.
 * Larger inputs remain uninspectable until safe complete-context segmentation is qualified.
 * Known foreign-format prefixes are refused, not parsed; this is no general MIME detector.
 * `clear` is only classification evidence, never UploadSecurityApproval or a sandbox/cleanup proof.
 */
export function inspectPlainTextSecurity(input: TextSecurityInput): SecurityInspectionResult {
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
    return inspectCompleteSecurityEvidence(policy, {
      version: 1,
      coverage: { complete: true, pages: 1, parts: 1 },
      units: [{ part: 1, page: 1, placement: 'body', text }],
    });
  } catch {
    // Never expose decoder errors, source fragments or caller-provided exception messages.
    return { decision: 'uninspectable', reason: 'invalid_content' };
  }
}

/**
 * Trusted thread dispatch. CSV has fixed structural fields, never inferred types or executable
 * formulae. Inspect the entire raw source and decoded field stream as well as every complete cell;
 * a prose exception for one cell can never exempt the rest of the document.
 */
export function inspectTextSecurity(input: TextSecurityInput): SecurityInspectionResult {
  try {
    if (input.mediaType === 'text/plain') return inspectPlainTextSecurity(input);
    const { bytes, mediaType, policy } = input;
    if (
      mediaType !== 'text/csv' ||
      !(bytes instanceof Uint8Array) ||
      (typeof SharedArrayBuffer !== 'undefined' && bytes.buffer instanceof SharedArrayBuffer)
    ) {
      return { decision: 'uninspectable', reason: 'invalid_content' };
    }
    if (bytes.byteLength > MANAGED_CSV_LIMITS.bytes) {
      return { decision: 'uninspectable', reason: 'resource_limit' };
    }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    if (/^\s*(?:%PDF-|%!PS|\{\\rtf\d|<[\w!?/])/iu.test(text)) {
      return { decision: 'uninspectable', reason: 'invalid_content' };
    }
    const parsed = parseManagedCsv(text);
    if (!parsed.ok) return { decision: 'uninspectable', reason: parsed.reason };
    const cells = parsed.rows.flat();
    for (const cell of cells) {
      const value = cell.trim();
      if (
        /^[=+@-]/u.test(value) &&
        /^[+-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/u.exec(value)?.[0] !== value
      ) {
        return { decision: 'uninspectable', reason: 'invalid_content' };
      }
    }
    const coverage = { complete: true, pages: 1, parts: 1 };
    return inspectCompleteSecurityEvidence(policy, {
      version: 1,
      coverage,
      // A cell is not a heading. Only a real two-field row supplies a label/value context;
      // the classifier still requires that exact label in the trusted policy.
      units: [
        text,
        cells.join('\n'),
        ...cells,
        ...parsed.rows.filter((row) => row.length === 2).map((row) => row.join(': ')),
      ].map((content) => ({
        part: 1,
        page: 1,
        placement: 'body',
        text: content,
      })),
    });
  } catch {
    return { decision: 'uninspectable', reason: 'invalid_content' };
  }
}
