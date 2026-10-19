/** Private parser IPC only. This codec cannot issue an approval or certify execution cleanup. */
import type { SecurityInspectionResult } from './inspection';
import type { SecurityMarkingPolicy } from './markings';
import { inspectSecurityMarkings } from './markings';

export const SECURITY_PROCESS_LIMITS: Readonly<{
  documentBytes: number;
  headerBytes: number;
  resultBytes: number;
}> = Object.freeze({
  documentBytes: 4 * 1024 * 1024,
  headerBytes: 32 * 1024,
  resultBytes: 512,
});

export type SecurityProcessResult = SecurityInspectionResult;
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
        version: 2,
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
      header.version !== 2 ||
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

/** Parser evidence only; the observer and worker independently join pages, diagnostics and custody. */
export function readSecurityProcessResult(bytes: Uint8Array): SecurityProcessResult | null {
  try {
    if (
      !validBytes(bytes) ||
      bytes.byteLength < 1 ||
      bytes.byteLength > SECURITY_PROCESS_LIMITS.resultBytes
    )
      return null;
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (
      exactKeys(value, ['decision', 'coverage']) &&
      value.decision === 'clear' &&
      exactKeys(value.coverage, ['complete', 'pages', 'parts']) &&
      value.coverage.complete === true &&
      Number.isSafeInteger(value.coverage.pages) &&
      Number(value.coverage.pages) >= 1 &&
      Number(value.coverage.pages) <= 32 &&
      value.coverage.parts === 1
    ) {
      return {
        decision: 'clear',
        coverage: { complete: true, pages: Number(value.coverage.pages), parts: 1 },
      };
    }
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

/** One bounded duplex fd3 protocol; frames never contain credentials or cleanup attestations. */
export type SecurityProcessFrameHeader =
  | { version: 2; kind: 'page'; page: number; width: number; height: number; bytes: number }
  | { version: 2; kind: 'ocr'; page: number; complete: boolean; readable: boolean; bytes: number }
  | { version: 2; kind: 'result'; bytes: number };
export type SecurityProcessFrame = { header: SecurityProcessFrameHeader; bytes: Buffer };
export function readSecurityProcessFrameHeader(
  bytes: Uint8Array,
): SecurityProcessFrameHeader | null {
  try {
    if (!validBytes(bytes) || bytes.length < 1 || bytes.length > 1024) return null;
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (value?.version !== 2 || !Number.isSafeInteger(value.bytes) || value.bytes < 0) return null;
    if (
      exactKeys(value, ['version', 'kind', 'bytes']) &&
      value.kind === 'result' &&
      Number(value.bytes) > 0 &&
      Number(value.bytes) <= SECURITY_PROCESS_LIMITS.resultBytes
    )
      return { version: 2, kind: 'result', bytes: Number(value.bytes) };
    if (!Number.isSafeInteger(value.page) || value.page < 1 || value.page > 32) return null;
    if (
      exactKeys(value, ['version', 'kind', 'page', 'width', 'height', 'bytes']) &&
      value.kind === 'page' &&
      Number.isSafeInteger(value.width) &&
      Number(value.width) > 0 &&
      Number.isSafeInteger(value.height) &&
      Number(value.height) > 0 &&
      Number.isSafeInteger(Number(value.width) * Number(value.height)) &&
      Number(value.width) * Number(value.height) <= 8_000_000 &&
      value.bytes === Number(value.width) * Number(value.height) * 4
    )
      return {
        version: 2,
        kind: 'page',
        page: Number(value.page),
        width: Number(value.width),
        height: Number(value.height),
        bytes: Number(value.bytes),
      };
    if (
      exactKeys(value, ['version', 'kind', 'page', 'complete', 'readable', 'bytes']) &&
      value.kind === 'ocr' &&
      typeof value.complete === 'boolean' &&
      typeof value.readable === 'boolean' &&
      Number(value.bytes) <= 65_536
    )
      return {
        version: 2,
        kind: 'ocr',
        page: Number(value.page),
        complete: value.complete,
        readable: value.readable,
        bytes: Number(value.bytes),
      };
    return null;
  } catch {
    return null;
  }
}
export function encodeSecurityProcessFrameHeader(header: SecurityProcessFrameHeader): Buffer {
  const json = Buffer.from(JSON.stringify(header));
  if (!readSecurityProcessFrameHeader(json)) throw new Error('Security IPC frame unavailable');
  const prefix = Buffer.alloc(4 + json.length);
  prefix.writeUInt32BE(json.length);
  json.copy(prefix, 4);
  json.fill(0);
  return prefix;
}

/** Allocates a payload only after its exact bounded header; the receiving callback owns erasure. */
export class SecurityProcessFrameReader {
  private prefix = Buffer.alloc(4);
  private prefixLength = 0;
  private encoded: Buffer | undefined;
  private encodedLength = 0;
  private header: SecurityProcessFrameHeader | undefined;
  private body: Buffer | undefined;
  private bodyLength = 0;
  get complete(): boolean {
    return this.prefixLength === 0 && !this.header;
  }

  clear(): void {
    this.prefix.fill(0);
    this.encoded?.fill(0);
    this.body?.fill(0);
    this.prefixLength = 0;
    this.encoded = undefined;
    this.encodedLength = 0;
    this.header = undefined;
    this.body = undefined;
    this.bodyLength = 0;
  }

  push(chunk: Uint8Array, consume: (frame: SecurityProcessFrame) => void): void {
    if (!validBytes(chunk)) throw new Error('Invalid security IPC bytes');
    let offset = 0;
    while (offset < chunk.length || (this.header && this.bodyLength === this.header.bytes)) {
      if (this.prefixLength < 4) {
        const length = Math.min(4 - this.prefixLength, chunk.length - offset);
        this.prefix.set(chunk.subarray(offset, offset + length), this.prefixLength);
        offset += length;
        this.prefixLength += length;
        if (this.prefixLength !== 4) return;
        const size = this.prefix.readUInt32BE();
        if (size < 1 || size > 1024) throw new Error('Invalid security IPC header');
        this.encoded = Buffer.alloc(size);
      }
      if (!this.header) {
        const encoded = this.encoded!;
        const length = Math.min(encoded.length - this.encodedLength, chunk.length - offset);
        encoded.set(chunk.subarray(offset, offset + length), this.encodedLength);
        offset += length;
        this.encodedLength += length;
        if (this.encodedLength !== encoded.length) return;
        const header = readSecurityProcessFrameHeader(encoded);
        if (!header) throw new Error('Invalid security IPC frame');
        this.header = header;
        this.body = Buffer.alloc(header.bytes);
      }
      const length = Math.min(this.header.bytes - this.bodyLength, chunk.length - offset);
      this.body!.set(chunk.subarray(offset, offset + length), this.bodyLength);
      offset += length;
      this.bodyLength += length;
      if (this.bodyLength !== this.header.bytes) return;
      const frame = { header: this.header, bytes: this.body! };
      this.body = undefined;
      this.clear();
      try {
        consume(frame);
      } catch (error) {
        frame.bytes.fill(0);
        throw error;
      }
    }
  }
}
