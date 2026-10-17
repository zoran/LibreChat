import { readSourceCoverage } from './source-coverage';
import type { SourceCoverage } from './source-coverage';

const fixture = (): SourceCoverage => ({
  version: 1,
  stage: 'prepared',
  scope: 'retained_sources',
  entries: [
    {
      file_id: 'file-1',
      source: { kind: 'message', id: 'message-1' },
      coverage: { unit: 'utf16', start: 0, end: 2, total: 4, complete: false },
      extraction: 'not_assessed',
    },
  ],
});

describe('prepared retained-source coverage', () => {
  it('returns an independent closed snapshot without source content', () => {
    const input = fixture();
    const output = readSourceCoverage(input)!;
    expect(output).toEqual(input);
    output.entries[0].coverage.end = 1;
    output.entries[0].source.id = 'changed';
    expect(input).toEqual(fixture());
    expect(readSourceCoverage({ ...fixture(), entries: [] })?.entries).toEqual([]);
  });
  it.each([0, 1, Number.MAX_SAFE_INTEGER])('accepts complete safe coverage %s', (total) => {
    const input = fixture();
    input.entries[0].coverage = { unit: 'utf16', start: 0, end: total, total, complete: true };
    expect(readSourceCoverage(input)).toEqual(input);
  });
  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null])(
    'rejects invalid offsets %#',
    (value) => {
      for (const key of ['end', 'total']) {
        const input = fixture();
        Object.assign(input.entries[0].coverage, { [key]: value });
        expect(readSourceCoverage(input)).toBeNull();
      }
    },
  );
  it.each([
    { start: 1 },
    { unit: 'bytes' },
    { end: 5 },
    { complete: true },
    { complete: 0 },
    { end: 4, complete: false },
    { text: 'PRIVATE' },
  ])('rejects contradictory or extra coverage fields %#', (change) => {
    const input = fixture();
    Object.assign(input.entries[0].coverage, change);
    expect(readSourceCoverage(input)).toBeNull();
  });
  it.each(['', 'a'.repeat(129), 'line\nbreak', '\u0000', '\u007f', '\u0085'])(
    'rejects invalid file and source IDs %#',
    (id) => {
      const input = fixture();
      input.entries[0].file_id = id;
      expect(readSourceCoverage(input)).toBeNull();
      const other = fixture();
      other.entries[0].source.id = id;
      expect(readSourceCoverage(other)).toBeNull();
    },
  );
  it('rejects extra fields at every level and unsupported discriminants', () => {
    for (const select of [
      (input: SourceCoverage) => input,
      (input: SourceCoverage) => input.entries[0],
      (input: SourceCoverage) => input.entries[0].source,
    ]) {
      const input = fixture();
      Object.assign(select(input), { filename: 'PRIVATE' });
      expect(readSourceCoverage(input)).toBeNull();
    }
    for (const field of [{ version: 2 }, { stage: 'read' }, { scope: 'all_sources' }]) {
      expect(readSourceCoverage({ ...fixture(), ...field })).toBeNull();
    }
    const input = fixture();
    Object.assign(input.entries[0], { extraction: 'complete' });
    expect(readSourceCoverage(input)).toBeNull();
    Object.assign(input.entries[0], { extraction: 'not_assessed' });
    Object.assign(input.entries[0].source, { kind: 'tool' });
    expect(readSourceCoverage(input)).toBeNull();
  });
  it('rejects exact duplicate bindings while allowing the same file at a different origin', () => {
    const input = fixture();
    input.entries.push(fixture().entries[0]);
    expect(readSourceCoverage(input)).toBeNull();
    input.entries[1].source.kind = 'steer';
    expect(readSourceCoverage(input)).toEqual(input);
    input.entries[1].source.kind = 'message';
    input.entries[1].source.id = 'message-2';
    expect(readSourceCoverage(input)).toEqual(input);
  });
  it('bounds entry count and actual serialized UTF-8 bytes', () => {
    const input = fixture();
    input.entries = Array.from({ length: 64 }, (_, i) => ({
      ...fixture().entries[0],
      file_id: `f${i}`,
    }));
    expect(readSourceCoverage(input)).toEqual(input);
    expect(
      readSourceCoverage({ ...input, entries: [...input.entries, fixture().entries[0]] }),
    ).toBeNull();
    input.entries = input.entries.map((entry, i) => ({
      ...entry,
      file_id: `${i}${'界'.repeat(125)}`,
      source: { kind: 'message', id: '界'.repeat(128) },
    }));
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(32 * 1024);
    expect(readSourceCoverage(input)).toBeNull();
  });
  it('rejects accessors without invoking them, prototypes, sparse arrays and hidden properties', () => {
    const getter = jest.fn(() => 'file-1');
    const input = fixture();
    Object.defineProperty(input.entries[0], 'file_id', { enumerable: true, get: getter });
    expect(readSourceCoverage(input)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    expect(
      readSourceCoverage(Object.assign(Object.create({ inherited: true }), fixture())),
    ).toBeNull();
    const sparse = fixture();
    delete sparse.entries[0];
    expect(readSourceCoverage(sparse)).toBeNull();
    const extra = fixture();
    Object.defineProperty(extra.entries, 'hidden', { value: true });
    expect(readSourceCoverage(extra)).toBeNull();
    const symbol = fixture();
    Object.assign(symbol.entries[0].coverage, { [Symbol('hidden')]: 1 });
    expect(readSourceCoverage(symbol)).toBeNull();
  });
});
