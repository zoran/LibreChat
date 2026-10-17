/** Exercise real byte decoding and complete-context classification, never a mocked scanner. */
import type { SecurityMarkingPolicy } from './markings';
import { inspectPlainTextSecurity, inspectTextSecurity } from './text';

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

describe('CSV security core with the real shared codec', () => {
  function csv(text: string) {
    return inspectTextSecurity({ bytes: Buffer.from(text), mediaType: 'text/csv', policy });
  }

  it('inspects complete fixed-dialect CSV without type inference or input mutation', () => {
    const source = Buffer.from('Name,Notiz\r\nKöln,"intern, vertraulich"\r\n');
    const before = Buffer.from(source);
    const beforePolicy = JSON.stringify(policy);
    expect(inspectTextSecurity({ bytes: source, mediaType: 'text/csv', policy })).toEqual(clear);
    expect(source).toEqual(before);
    expect(JSON.stringify(policy)).toBe(beforePolicy);
    expect(csv('')).toEqual(clear);
    expect(csv('"Zitat ""Hallo""",Text')).toEqual(clear);
  });

  it.each(['VS-NfD', 'VS-VERTRAULICH', 'GEHEIM', 'STRENG GEHEIM', 'vs\u2011nfd', 'ＶＳ－ＮｆＤ'])(
    'rejects a complete classification in the last cell: %s',
    (marking) => {
      expect(csv(`Spalte,Inhalt\nEinstufung,${marking}`)).toEqual(rejected);
    },
  );

  it('distinguishes a configured classification row from an ambiguous glossary cell', () => {
    expect(csv('Einstufung,VS-NfD')).toEqual(rejected);
    expect(csv('Begriff,VS-NfD')).toEqual(ambiguous);
    expect(csv('VS-NfD')).toEqual(ambiguous);
  });

  it('decodes escaped quotes and line breaks before inspecting actual field boundaries', () => {
    expect(csv('Titel,Wert\nEinstufung,"""GEHEIM"""')).toEqual(rejected);
    expect(csv('Titel,Wert\nEinstufung,"VS-\r\nNfD"')).toEqual(rejected);
    expect(csv('Titel,Wert\nEinstufung,"Einstufung: GEHEIM"')).toEqual(rejected);
  });

  it.each(['VS-,NfD', 'V,S,N,f,D', 'STRENG,GEHEIM', 'VS-\nNfD'])(
    'never clears a marking distributed across cells or rows: %s',
    (source) => {
      expect(csv(source).decision).not.toBe('clear');
    },
  );

  it('allows only complete policy prose and never lets it exempt other cells or rows', () => {
    const prose = 'Die Kennzeichnung GEHEIM wird hier als Beispiel erläutert.';
    expect(csv(`"${prose}"`)).toEqual(clear);
    expect(csv(`"${prose}"\nGEHEIM`)).toEqual(ambiguous);
    expect(csv('Die Kennzeichnung,GEHEIM,wird hier als Beispiel erläutert.')).toEqual(ambiguous);
    expect(csv(`"${prose}"\n"Eine Erwähnung von GEHEIM."`)).toEqual(ambiguous);
  });

  it.each([
    '=1+1',
    ' =SUM(A1)',
    '\t+cmd|run',
    '-cmd|run',
    '@SUM(A1)',
    '\r\n=1',
    '+NaN',
    '-Infinity',
    '+1e',
    '-0x10',
  ])('refuses active or non-literal signed field content %#', (cell) => {
    expect(csv(`Name,Wert\nNotiz,"${cell}"`)).toEqual(invalid);
  });

  it.each(['-1', '+1', '-.5', '+0.25', '-1e-3', '+2E+5', '  -12.5', '\t+2', '0001', '-1 ', '-1\n'])(
    'keeps exact numeric literals as inert text: %s',
    (cell) => {
      expect(csv(`Name,Wert\nNotiz,${cell}`)).toEqual(clear);
    },
  );

  it.each(['"unterminated', 'a,b\nc', 'a"b,c', '"a"extra,b', 'a,b\rc,d'])(
    'rejects malformed syntax through the shared codec %#',
    (source) => expect(csv(source)).toEqual(invalid),
  );

  it('uses fatal UTF-8 and consumes exactly one initial BOM', () => {
    expect(
      inspectTextSecurity({ bytes: Uint8Array.from([0xc3]), mediaType: 'text/csv', policy }),
    ).toEqual(invalid);
    expect(csv('\ufeffName,Wert\nNotiz,1')).toEqual(clear);
    expect(csv('\ufeffEinstufung,GEHEIM')).toEqual(rejected);
    expect(csv('\ufeff\ufeffName,Wert')).toEqual(invalid);
    expect(csv('Name,\ufeffWert')).toEqual(invalid);
    expect(
      inspectTextSecurity({
        bytes: new Uint8Array(new SharedArrayBuffer(4)),
        mediaType: 'text/csv',
        policy,
      }),
    ).toEqual(invalid);
  });

  it.each(['\u0000', '\u001b', '\u007f', '\u0085', '\ufffd'])(
    'rejects controls without content leakage %#',
    (control) => expect(csv(`Private-87246,"${control}"`)).toEqual(invalid),
  );

  it('retains byte, row, column and cell limits without truncating later content', () => {
    expect(csv('a'.repeat(65_536))).toEqual(clear);
    expect(csv('a'.repeat(65_537))).toEqual(limited);
    expect(csv(`\ufeff${'a'.repeat(65_534)}`)).toEqual(limited);
    expect(csv(Array.from({ length: 1025 }, () => 'a').join('\n'))).toEqual(limited);
    expect(csv(Array.from({ length: 129 }, () => 'a').join(','))).toEqual(limited);
    expect(
      csv(Array.from({ length: 17 }, () => Array(128).fill('a').join(',')).join('\n')),
    ).toEqual(limited);
    expect(csv(`${'a,b\n'.repeat(1023)}Einstufung,GEHEIM`)).toEqual(rejected);
  });

  it.each([
    'text/markdown',
    'text/html',
    'application/pdf',
    'text/csv; charset=utf-8',
    'application/octet-stream',
  ])('does not widen supported canonical media types: %s', (mediaType) =>
    expect(inspectTextSecurity({ bytes: Buffer.from('a,b'), mediaType, policy })).toEqual(invalid),
  );

  it('preserves plain-text semantics and refuses recognizable foreign formats', () => {
    expect(
      inspectTextSecurity({ bytes: Buffer.from('GEHEIM'), mediaType: 'text/plain', policy }),
    ).toEqual(ambiguous);
    expect(
      inspectPlainTextSecurity({ bytes: Buffer.from('a,b'), mediaType: 'text/csv', policy }),
    ).toEqual(invalid);
    expect(csv('<html>Private-87246</html>')).toEqual(invalid);
    expect(csv('%PDF-1.7')).toEqual(invalid);
  });
});
