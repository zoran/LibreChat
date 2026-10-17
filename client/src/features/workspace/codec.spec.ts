import { decodeWorkspaceText, encodeWorkspaceText, WorkspaceTextError } from './codec';

const bytes = (text: string) => new TextEncoder().encode(text);

/** Exact original bytes are the saved document; Monaco's normalized display is not a new revision. */
describe('workspace UTF-8 codec', () => {
  it.each(['', 'Grüße 🌱', 'eins\nzwei\n\n', '\uFEFFeins\r\nzwei\r\n', 'a\rb\nc\r\n'])(
    'keeps unchanged original bytes and never encodes them again: %p',
    (original) => {
      const snapshot = decodeWorkspaceText(bytes(original));
      const encode = jest.spyOn(TextEncoder.prototype, 'encode');
      const result = encodeWorkspaceText(snapshot, snapshot.text);
      expect(result.status).toBe('unchanged');
      if (result.status !== 'unchanged') throw new Error('Expected unchanged bytes');
      expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(result.bytes)).toBe(original);
      expect(encode).not.toHaveBeenCalled();
    },
  );

  it('copies originals on entry and access, preserving one metadata BOM and one text BOM', () => {
    const original = bytes('\uFEFF\uFEFFÄ\r\n');
    const snapshot = decodeWorkspaceText(original);
    original.fill(0);
    snapshot.originalBytes.fill(0);
    expect(snapshot.text).toBe('\uFEFFÄ\n');
    expect(snapshot.bom).toBe(true);
    expect(snapshot.eol).toBe('crlf');
    const result = encodeWorkspaceText(snapshot, snapshot.text + 'Ö\n');
    expect(result.status).toBe('changed');
    if (result.status !== 'changed') throw new Error('Expected changed bytes');
    expect(result.bytes).toEqual(bytes('\uFEFF\uFEFFÄ\r\nÖ\r\n'));
    expect(snapshot.originalBytes).toEqual(bytes('\uFEFF\uFEFFÄ\r\n'));
  });

  it.each([
    ['a\nb\n', 'lf', 'x\ny\n'],
    ['a\r\nb\r\n', 'crlf', 'x\r\ny\r\n'],
    ['', 'none', 'x\ny\n'],
  ])('retains uniform EOL and trailing newline for changed content', (original, eol, expected) => {
    const snapshot = decodeWorkspaceText(bytes(original));
    expect(snapshot.eol).toBe(eol);
    const result = encodeWorkspaceText(snapshot, 'x\ny\n');
    expect(result).toMatchObject({ status: 'changed', bytes: bytes(expected) });
  });

  it.each(['a\rb\r', 'a\rb\nc\r\n'])(
    'requires explicit normalization of %p only after an edit',
    (text) => {
      const snapshot = decodeWorkspaceText(bytes(text));
      expect(encodeWorkspaceText(snapshot, snapshot.text)).toMatchObject({ status: 'unchanged' });
      expect(encodeWorkspaceText(snapshot, snapshot.text + '!')).toMatchObject({
        status: 'normalization-required',
      });
      expect(encodeWorkspaceText(snapshot, snapshot.text + '!', 'crlf')).toMatchObject({
        status: 'changed',
        bytes: bytes(snapshot.text.replace(/\n/g, '\r\n') + '!'),
      });
      expect(encodeWorkspaceText(snapshot, snapshot.text + '!', 'lf')).toMatchObject({
        status: 'changed',
        bytes: bytes(snapshot.text + '!'),
      });
    },
  );

  it.each([[0xff], [0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80]])(
    'rejects invalid UTF-8 %p',
    (...input) => {
      expect(() => decodeWorkspaceText(new Uint8Array(input))).toThrow(WorkspaceTextError);
    },
  );

  it.each(['\uD800', 'a\uDC00', '\uD800\uD800'])(
    'rejects invalid Unicode without encoder replacement',
    (text) => {
      const snapshot = decodeWorkspaceText(bytes(''));
      expect(() => encodeWorkspaceText(snapshot, text)).toThrow(WorkspaceTextError);
    },
  );

  it('rejects noncanonical model text instead of silently treating an EOL change as an edit', () => {
    const snapshot = decodeWorkspaceText(bytes('a\r\n'));
    expect(() => encodeWorkspaceText(snapshot, 'a\r\n')).toThrow(WorkspaceTextError);
  });
});
