/** Exercise real byte decoding and complete-context classification, never a mocked scanner. */
import type { SecurityMarkingPolicy } from './markings';
import { inspectPlainTextSecurity } from './text';

const policy: SecurityMarkingPolicy = {
  version: 1,
  markings: ['VS-NfD', 'VS-VERTRAULICH', 'GEHEIM', 'STRENG GEHEIM'],
  labels: ['Einstufung'],
  prose: [{ before: 'Die Kennzeichnung', after: 'wird hier als Beispiel erläutert.' }],
};
const clear = { decision: 'clear' };
const rejected = { decision: 'rejected', reason: 'classification_marking' };
const ambiguous = { decision: 'uninspectable', reason: 'ambiguous_marking' };
const invalid = { decision: 'uninspectable', reason: 'invalid_content' };
const limited = { decision: 'uninspectable', reason: 'resource_limit' };

function inspect(text: string) {
  return inspectPlainTextSecurity({ bytes: Buffer.from(text), mediaType: 'text/plain', policy });
}

describe('plain text security core', () => {
  it('inspects harmless complete UTF-8, including non-official intern/vertraulich prose', () => {
    expect(
      inspect('Grüße aus Köln.\r\nDiese interne Notiz ist vertraulich.\tGeheimnisse.'),
    ).toEqual(clear);
    expect(inspect('')).toEqual(clear);
  });

  it.each([
    'VS-NfD',
    'VS-VERTRAULICH',
    'GEHEIM',
    'STRENG GEHEIM',
    'vs\u2011nfd',
    'ＶＳ－ＮｆＤ',
    'V S - N f D',
  ])('retains explicit classification fields through UTF-8 decoding: %s', (marking) => {
    expect(inspect(`Vorwort.\n\nEinstufung: ${marking}`)).toEqual(rejected);
  });

  it('does not clear a marking split across lines or paragraphs', () => {
    expect(inspect('VS-\n\nNfD')).toEqual(ambiguous);
    expect(inspect('STRENG\r\n\r\nGEHEIM')).toEqual(ambiguous);
    expect(inspect('V\nS\nN\nf\nD')).toEqual(ambiguous);
    expect(inspect('GEHEIM')).toEqual(ambiguous);
    expect(inspect('Einstufung: VS-\r\nNfD')).toEqual(rejected);
    // Without layout evidence the unchanged classifier keeps a wrapped field after prose ambiguous.
    expect(inspect('Vorwort.\n\nEinstufung: VS-\r\nNfD')).toEqual(ambiguous);
  });

  it('inspects a later paragraph without truncation or prose-exception leakage', () => {
    const explanation = 'Die Kennzeichnung GEHEIM wird hier als Beispiel erläutert.';
    expect(inspect(explanation)).toEqual(clear);
    expect(inspect(`${explanation}\n\nSTRENG\nGEHEIM`)).toEqual(ambiguous);
    expect(inspect(`${'Vorwort.\n'.repeat(7000)}\nEinstufung: GEHEIM`)).toEqual(rejected);
  });

  it.each([
    [0xc3],
    [0xc0, 0xaf],
    [0xed, 0xa0, 0x80],
    [0xf4, 0x90, 0x80, 0x80],
    [0x80],
    [0xff, 0xfe, 0x41, 0x00],
  ])('fails closed instead of repairing malformed UTF-8 %#', (...octets) => {
    expect(
      inspectPlainTextSecurity({ bytes: Uint8Array.from(octets), mediaType: 'text/plain', policy }),
    ).toEqual(invalid);
  });

  it('accepts exactly one leading UTF-8 BOM without losing a following marking', () => {
    expect(inspect('\ufeffGrüße')).toEqual(clear);
    expect(inspect('\ufeffEinstufung: GEHEIM')).toEqual(rejected);
    expect(inspect('\ufeff\ufeffGrüße')).toEqual(ambiguous);
    expect(inspect('Text\ufeffGEHEIM')).toEqual(ambiguous);
  });

  it.each(['\u0000', '\u0001', '\u000c', '\u001b', '\u007f', '\u0085', '\ufffd'])(
    'does not ignore binary/control content %#',
    (control) => {
      expect(inspect(`Anfang${control}Ende`)).toEqual(invalid);
    },
  );

  it.each([
    'application/pdf',
    'text/html',
    'text/markdown',
    'text/csv',
    'text/plain; charset=utf-8',
    '',
  ])('requires the canonical supported media type: %s', (mediaType) => {
    expect(inspectPlainTextSecurity({ bytes: Buffer.from('Text'), mediaType, policy })).toEqual(
      invalid,
    );
  });

  it.each([
    '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>',
    '\ufeff  %PDF-1.7\n',
    'PK\u0003\u0004archive',
    '<!DOCTYPE html><html><body>Text</body></html>',
    '<html><body>Text</body></html>',
    '<?xml version="1.0"?><document>Text</document>',
    '{\\rtf1 Text}',
  ])('refuses recognizable foreign-format content mislabeled text/plain %#', (text) => {
    expect(inspect(text)).toEqual(invalid);
  });

  it('bounds the complete encoded input instead of truncating or unsafe segmenting', () => {
    expect(inspect('a'.repeat(65_536))).toEqual(clear);
    expect(inspect(`${'a'.repeat(65_536)}\nEinstufung: GEHEIM`)).toEqual(limited);
    expect(inspect('ä'.repeat(32_768))).toEqual(clear);
    expect(inspect('ä'.repeat(32_769))).toEqual(limited);
    expect(inspect(`\ufeff${'a'.repeat(65_534)}`)).toEqual(limited);
    expect(
      inspectPlainTextSecurity({
        bytes: new Uint8Array(15 * 1024 * 1024 + 1),
        mediaType: 'text/plain',
        policy,
      }),
    ).toEqual(limited);
  });

  it('inspects exactly the supplied byte view without mutating it or the policy', () => {
    const backing = Buffer.from('Einstufung: GEHEIM|Harmloser Text|Einstufung: GEHEIM');
    const before = Buffer.from(backing);
    const bytes = backing.subarray(19, 33);
    expect(bytes.toString()).toBe('Harmloser Text');
    const frozenPolicy: SecurityMarkingPolicy = Object.freeze({
      version: 1,
      markings: Object.freeze(['GEHEIM']),
    });
    expect(
      inspectPlainTextSecurity({ bytes, mediaType: 'text/plain', policy: frozenPolicy }),
    ).toEqual(clear);
    expect(backing).toEqual(before);
    expect(frozenPolicy).toEqual({ version: 1, markings: ['GEHEIM'] });
  });

  it('does not inspect concurrently mutable shared memory', () => {
    const bytes = new Uint8Array(new SharedArrayBuffer(8));
    bytes.set(Buffer.from('Harmlos'));
    expect(inspectPlainTextSecurity({ bytes, mediaType: 'text/plain', policy })).toEqual(invalid);
  });

  it('returns finite content-free decisions without approval or exceptions containing input', () => {
    expect(inspect('Private-87246')).toEqual(clear);
    expect(inspect('Private-87246\nEinstufung: GEHEIM')).toEqual(rejected);
    expect(inspect('Private-87246 erwähnt GEHEIM.')).toEqual(ambiguous);
    expect(inspect('Private-87246\u0000')).toEqual(invalid);
    expect(inspect(`Private-87246${'x'.repeat(65_536)}`)).toEqual(limited);
  });
});
