/** Private parser IPC only. This codec cannot issue an approval or certify execution cleanup. */
import { inspectSecurityMarkings } from './markings';
import type { SecurityMarkingPolicy } from './markings';
import type { SecurityInspectionResult } from './inspection';

export const SECURITY_PROCESS_LIMITS: Readonly<{
  documentBytes: number;
  headerBytes: number;
  resultBytes: number;
}> = Object.freeze({
  documentBytes: 4 * 1024 * 1024,
  headerBytes: 32 * 1024,
  resultBytes: 512,
});

export type NegativeSecurityProcessResult = Exclude<
  SecurityInspectionResult,
  { decision: 'clear' }
>;
export type SecurityProcessRequest = {
  mediaType: 'application/pdf';
  policy: SecurityMarkingPolicy;
  bytes: Uint8Array;
};

function validBytes(value: unknown): value is Uint8Array {
  return (
    value instanceof Uint8Array &&
    !(typeof SharedArrayBuffer !== 'undefined' && value.buffer instanceof SharedArrayBuffer)
  );
}

function validPolicy(value: unknown): value is SecurityMarkingPolicy {
  return (
    inspectSecurityMarkings(value, {
      version: 1,
      coverage: { complete: true, pages: 1, parts: 1 },
      units: [{ part: 1, page: 1, placement: 'body', text: '' }],
    }).decision === 'clear'
  );
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

/** Trusted composition supplies the policy; no identities, paths, URLs or launcher options cross. */
export function encodeSecurityProcessRequest(input: SecurityProcessRequest): Uint8Array {
  try {
    if (
      input.mediaType !== 'application/pdf' ||
      !validPolicy(input.policy) ||
      !validBytes(input.bytes) ||
      input.bytes.byteLength < 1 ||
      input.bytes.byteLength > SECURITY_PROCESS_LIMITS.documentBytes
    )
      throw new Error();
    const header = Buffer.from(
      JSON.stringify({
        version: 1,
        mediaType: input.mediaType,
        policy: input.policy,
        bytes: input.bytes.byteLength,
      }),
      'utf8',
    );
    if (header.byteLength > SECURITY_PROCESS_LIMITS.headerBytes) throw new Error();
    const frame = Buffer.alloc(4 + header.byteLength + input.bytes.byteLength);
    frame.writeUInt32BE(header.byteLength);
    header.copy(frame, 4);
    frame.set(input.bytes, 4 + header.byteLength);
    // Validate the serialized policy actually sent, including a changed serialization result.
    if (!readSecurityProcessRequest(frame)) {
      frame.fill(0);
      throw new Error();
    }
    return frame;
  } catch {
    throw new Error('Security process input unavailable');
  }
}

/** The receiver owns and erases the complete frame; bytes is a view, never a retained second copy. */
export function readSecurityProcessRequest(frame: Uint8Array): SecurityProcessRequest | null {
  try {
    if (
      !validBytes(frame) ||
      frame.byteLength < 5 ||
      frame.byteLength >
        4 + SECURITY_PROCESS_LIMITS.headerBytes + SECURITY_PROCESS_LIMITS.documentBytes
    )
      return null;
    const headerBytes = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, false);
    if (
      headerBytes < 1 ||
      headerBytes > SECURITY_PROCESS_LIMITS.headerBytes ||
      4 + headerBytes >= frame.byteLength
    )
      return null;
    const header: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(4, 4 + headerBytes)),
    );
    if (
      !exactKeys(header, ['version', 'mediaType', 'policy', 'bytes']) ||
      header.version !== 1 ||
      header.mediaType !== 'application/pdf' ||
      !Number.isSafeInteger(header.bytes) ||
      (header.bytes as number) < 1 ||
      (header.bytes as number) > SECURITY_PROCESS_LIMITS.documentBytes ||
      4 + headerBytes + (header.bytes as number) !== frame.byteLength ||
      !validPolicy(header.policy)
    )
      return null;
    return {
      mediaType: 'application/pdf',
      policy: header.policy,
      bytes: frame.subarray(4 + headerBytes),
    };
  } catch {
    return null;
  }
}

/** Native PDF is not qualified to clear. Positive results, content and extra fields are refused. */
export function readSecurityProcessResult(bytes: Uint8Array): NegativeSecurityProcessResult | null {
  try {
    if (
      !validBytes(bytes) ||
      bytes.byteLength < 1 ||
      bytes.byteLength > SECURITY_PROCESS_LIMITS.resultBytes
    )
      return null;
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!exactKeys(value, ['decision', 'reason'])) return null;
    if (value.decision === 'rejected' && value.reason === 'classification_marking')
      return { decision: 'rejected', reason: 'classification_marking' };
    if (
      value.decision === 'uninspectable' &&
      (value.reason === 'invalid_content' ||
        value.reason === 'incomplete_coverage' ||
        value.reason === 'resource_limit' ||
        value.reason === 'ambiguous_marking')
    )
      return { decision: 'uninspectable', reason: value.reason };
    return null;
  } catch {
    return null;
  }
}
