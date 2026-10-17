import type { ManagedDocumentResult } from 'librechat-data-provider';
import { encodeDocumentResult, decodeDocumentResult } from './result';

const result: ManagedDocumentResult = {
  text: 'Grüße\n\t"🧭"',
  structure: {
    version: 1,
    source: { sha256: 'a'.repeat(64), bytes: 17, mediaType: 'text/plain' },
    extractor: { name: 'native', version: '1' },
    pages: [],
    elements: [{ id: 'e1', kind: 'paragraph', start: 0, end: 12, page: null, parentId: null }],
    quality: { status: 'complete', warnings: [] },
  },
};
result.structure.elements[0].end = result.text.length;

describe('one structured parser IPC frame', () => {
  it('preserves a leading U+FEFF and the exact UTF-16 anchors', () => {
    const input = structuredClone(result);
    input.text = '\uFEFF' + input.text;
    input.structure.elements[0].end = input.text.length;
    expect(decodeDocumentResult(encodeDocumentResult(input))).toEqual(input);
  });
  it('round trips exact Unicode and whitespace without JSON escaping the text', () => {
    const encoded = encodeDocumentResult(result);
    expect(decodeDocumentResult(encoded)).toEqual(result);
    expect(encoded.subarray(4 + encoded.readUInt32BE(0))).toEqual(Buffer.from(result.text));
  });
  it.each(['old text-only reply', '{}', '\0\0\0\0'])(
    'refuses a legacy or malformed reply',
    (value) => {
      expect(() => decodeDocumentResult(Buffer.from(value))).toThrow();
    },
  );
  it('refuses truncation, impossible offsets and invalid UTF-8', () => {
    const encoded = encodeDocumentResult(result);
    expect(() => decodeDocumentResult(encoded.subarray(0, encoded.length - 1))).toThrow();
    const mutated = Buffer.from(encoded);
    mutated[mutated.length - 1] = 0xff;
    expect(() => decodeDocumentResult(mutated)).toThrow();
    expect(() => encodeDocumentResult({ ...result, text: 'x' })).toThrow();
  });
});
