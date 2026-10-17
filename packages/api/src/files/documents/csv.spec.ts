import { MANAGED_CSV_LIMITS, parseManagedCsv } from './csv';

const invalid = { ok: false, reason: 'invalid_content' };
const limited = { ok: false, reason: 'resource_limit' };

describe('bounded native CSV codec', () => {
  it.each([
    ['', [['']]],
    ['\n', [['']]],
    ['\r\n', [['']]],
    [',', [['', '']]],
    ['""', [['']]],
    [
      'a,b\nc,d',
      [
        ['a', 'b'],
        ['c', 'd'],
      ],
    ],
    [
      'a,b\r\nc,d\r\n',
      [
        ['a', 'b'],
        ['c', 'd'],
      ],
    ],
    ['a\n\n', [['a'], ['']]],
    ['"a,b","say ""hello"""', [['a,b', 'say "hello"']]],
    ['"a\r\nb\nc\rd",end', [['a\r\nb\nc\rd', 'end']]],
    [
      '  a ," b "\n\tc\t, d ',
      [
        ['  a ', ' b '],
        ['\tc\t', ' d '],
      ],
    ],
    [
      'Köln,🧭\n東京,é',
      [
        ['Köln', '🧭'],
        ['東京', 'é'],
      ],
    ],
    ['001,=1+1,+2,-3,@SUM(A1),true', [['001', '=1+1', '+2', '-3', '@SUM(A1)', 'true']]],
  ] as const)('preserves the complete literal cells for case %#', (text, rows) => {
    expect(parseManagedCsv(text)).toEqual({ ok: true, rows });
  });

  it.each([
    '"unterminated',
    '"a"tail',
    '"a" ',
    ' "a"',
    'a"b',
    '"a""',
    'a\rb',
    'a\r',
    'a,b\nc',
    'a\nb,c',
    'a,b\n\n',
    '\ufeffa',
    'a\ufeffb',
    '\u0000',
    '\u001b',
    '\u007f',
    '\u0085',
    '\ud800',
    '\udc00',
    '"\ud800"',
  ])('rejects malformed, nonrectangular or invalid text %#', (text) => {
    expect(parseManagedCsv(text)).toEqual(invalid);
  });

  it('never coerces non-string input or invokes caller conversion hooks', () => {
    const toString = jest.fn(() => 'a,b');
    for (const value of [null, undefined, 4, {}, [], { toString }]) {
      expect(parseManagedCsv(value as unknown as string)).toEqual(invalid);
    }
    expect(toString).not.toHaveBeenCalled();
  });

  it('bounds UTF-8 bytes and UTF-16 input without truncation', () => {
    expect(parseManagedCsv('a'.repeat(65_536)).ok).toBe(true);
    expect(parseManagedCsv('a'.repeat(65_537))).toEqual(limited);
    expect(parseManagedCsv('ä'.repeat(32_768)).ok).toBe(true);
    expect(parseManagedCsv('ä'.repeat(32_769))).toEqual(limited);
    expect(parseManagedCsv('🧭'.repeat(16_384)).ok).toBe(true);
    expect(parseManagedCsv('🧭'.repeat(16_385))).toEqual(limited);
    expect(parseManagedCsv('"' + 'a'.repeat(65_534) + '"').ok).toBe(true);
    expect(parseManagedCsv('"' + 'a'.repeat(65_535) + '"')).toEqual(limited);
  });

  it('bounds rows including empty records but not a phantom trailing record', () => {
    expect(parseManagedCsv('x\n'.repeat(1024))).toMatchObject({ ok: true });
    expect(parseManagedCsv('\n'.repeat(1024))).toMatchObject({ ok: true });
    expect(parseManagedCsv('x\n'.repeat(1025))).toEqual(limited);
    expect(parseManagedCsv('\n'.repeat(1025))).toEqual(limited);
  });

  it('bounds columns including trailing empty fields', () => {
    expect(parseManagedCsv(','.repeat(127))).toMatchObject({ ok: true });
    expect(parseManagedCsv(','.repeat(128))).toEqual(limited);
  });

  it('bounds total cells independently of rows and columns', () => {
    const row = ','.repeat(127) + '\n';
    const result = parseManagedCsv(row.repeat(16));
    expect(result.ok && result.rows.flat().length).toBe(2048);
    expect(parseManagedCsv(row.repeat(17))).toEqual(limited);
  });

  it('keeps limits immutable and results independent between calls', () => {
    expect(Object.isFrozen(MANAGED_CSV_LIMITS)).toBe(true);
    expect(MANAGED_CSV_LIMITS).toEqual({ bytes: 65_536, rows: 1024, columns: 128, cells: 2048 });
    const text = 'a,b\nc,d';
    const first = parseManagedCsv(text);
    if (!first.ok) throw new Error('Expected valid fixture');
    first.rows[0][0] = 'changed';
    first.rows.push(['new']);
    expect(parseManagedCsv(text)).toEqual({
      ok: true,
      rows: [
        ['a', 'b'],
        ['c', 'd'],
      ],
    });
    expect(text).toBe('a,b\nc,d');
  });
});
