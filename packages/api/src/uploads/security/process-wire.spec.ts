/** Byte-exact private scanner frames; no process-isolation or OCR claim. */
import {
  encodeSecurityProcessRequest,
  readSecurityProcessRequest,
  readSecurityProcessResult,
  SECURITY_PROCESS_LIMITS,
} from './process-wire';

const policy = { version: 1 as const, markings: ['VS-NfD', 'GEHEIM'], labels: ['Einstufung'] };
const source = Buffer.from('%PDF-1.4\nSynthetic protocol fixture\n');
const request = () =>
  encodeSecurityProcessRequest({ mediaType: 'application/pdf', policy, bytes: source });
function frame(value: unknown, bytes = source) {
  const header = Buffer.from(JSON.stringify(value));
  const result = Buffer.alloc(4 + header.length + bytes.length);
  result.writeUInt32BE(header.length);
  header.copy(result, 4);
  bytes.copy(result, 4 + header.length);
  return result;
}
const header = () => ({ version: 1, mediaType: 'application/pdf', policy, bytes: source.length });

describe('private security process request', () => {
  it('round-trips a framed copy without mutating the source and erases the decoded view with its owner', () => {
    const encoded = request();
    const padded = Buffer.concat([Buffer.alloc(3), encoded]);
    const decoded = readSecurityProcessRequest(padded.subarray(3));
    expect(decoded).toEqual({ mediaType: 'application/pdf', policy, bytes: source });
    expect(decoded!.bytes.buffer).toBe(padded.buffer);
    padded.fill(0);
    expect(decoded!.bytes.every((byte) => byte === 0)).toBe(true);
    expect(source.toString()).toBe('%PDF-1.4\nSynthetic protocol fixture\n');
    encoded.fill(0);
  });

  it.each([
    {},
    { ...header(), version: 2 },
    { ...header(), mediaType: 'text/plain' },
    { ...header(), bytes: 0 },
    { ...header(), bytes: source.length - 1 },
    { ...header(), bytes: source.length + 1 },
    { ...header(), bytes: '31' },
    { ...header(), bytes: 1.5 },
    { ...header(), bytes: SECURITY_PROCESS_LIMITS.documentBytes + 1 },
    { ...header(), policy: { version: 1, markings: [] } },
    { ...header(), policy: { ...policy, command: 'synthetic-untrusted' } },
    { ...header(), file: '/synthetic/forbidden' },
    { ...header(), owner: 'synthetic-forbidden' },
  ])('rejects malformed or expanded headers %#', (value) => {
    expect(readSecurityProcessRequest(frame(value))).toBeNull();
  });

  it('rejects every truncated frame and trailing bytes', () => {
    const encoded = request();
    for (let length = 0; length < encoded.length; length++) {
      expect(readSecurityProcessRequest(encoded.subarray(0, length))).toBeNull();
    }
    expect(readSecurityProcessRequest(Buffer.concat([encoded, Buffer.from([0])]))).toBeNull();
  });

  it('rejects invalid UTF-8, oversized headers and shared memory without permissive decoding', () => {
    const invalid = request();
    invalid[4] = 0xff;
    expect(readSecurityProcessRequest(invalid)).toBeNull();
    const oversized = Buffer.from(request());
    oversized.writeUInt32BE(SECURITY_PROCESS_LIMITS.headerBytes + 1);
    expect(readSecurityProcessRequest(oversized)).toBeNull();
    const shared = new Uint8Array(new SharedArrayBuffer(request().length));
    shared.set(request());
    expect(readSecurityProcessRequest(shared)).toBeNull();
    expect(() =>
      encodeSecurityProcessRequest({ mediaType: 'application/pdf', policy, bytes: shared }),
    ).toThrow('Security process input unavailable');
  });

  it('enforces the actual document byte boundary', () => {
    const bytes = new Uint8Array(SECURITY_PROCESS_LIMITS.documentBytes);
    bytes[0] = 1;
    const encoded = encodeSecurityProcessRequest({ mediaType: 'application/pdf', policy, bytes });
    expect(readSecurityProcessRequest(encoded)?.bytes.length).toBe(bytes.length);
    expect(() =>
      encodeSecurityProcessRequest({
        mediaType: 'application/pdf',
        policy,
        bytes: new Uint8Array(bytes.length + 1),
      }),
    ).toThrow('Security process input unavailable');
    expect(() =>
      encodeSecurityProcessRequest({
        mediaType: 'application/pdf',
        policy,
        bytes: new Uint8Array(),
      }),
    ).toThrow('Security process input unavailable');
    encoded.fill(0);
    bytes.fill(0);
  });

  it('does not serialize a policy with an executable override', () => {
    const toJSON = jest.fn(() => ({ version: 1, markings: [] }));
    expect(() =>
      encodeSecurityProcessRequest({
        mediaType: 'application/pdf',
        policy: { ...policy, toJSON } as typeof policy,
        bytes: source,
      }),
    ).toThrow('Security process input unavailable');
    expect(toJSON).not.toHaveBeenCalled();
  });
});

describe('negative-only private security process result', () => {
  it.each([
    { decision: 'rejected', reason: 'classification_marking' },
    ...['invalid_content', 'incomplete_coverage', 'resource_limit', 'ambiguous_marking'].map(
      (reason) => ({ decision: 'uninspectable', reason }),
    ),
  ])('accepts only closed negative evidence %#', (value) => {
    expect(readSecurityProcessResult(Buffer.from(JSON.stringify(value)))).toEqual(value);
  });

  it.each([
    { decision: 'clear', coverage: { complete: true, pages: 1, parts: 1 } },
    { decision: 'approved', coverage: { complete: true, pages: 1, parts: 1 } },
    { decision: 'uninspectable', reason: 'scanner_unavailable' },
    { decision: 'rejected', reason: 'invalid_content' },
    { decision: 'uninspectable', reason: 'incomplete_coverage', content: 'synthetic secret' },
    { decision: 'uninspectable', reason: 'incomplete_coverage', cleanup: true },
    null,
    [],
  ])('refuses positive claims, content and non-contract results %#', (value) => {
    expect(readSecurityProcessResult(Buffer.from(JSON.stringify(value)))).toBeNull();
  });

  it('refuses malformed, duplicate frames, invalid UTF-8 and excessive output', () => {
    const valid = Buffer.from('{"decision":"uninspectable","reason":"incomplete_coverage"}');
    expect(readSecurityProcessResult(valid.subarray(0, -1))).toBeNull();
    expect(readSecurityProcessResult(Buffer.concat([valid, valid]))).toBeNull();
    expect(readSecurityProcessResult(Buffer.from([0xff]))).toBeNull();
    expect(readSecurityProcessResult(Buffer.alloc(513, 0x20))).toBeNull();
  });
});
