/** Bounded literal CSV grammar shared by inspection and extraction; never security approval. */
export const MANAGED_CSV_LIMITS: Readonly<{
  bytes: number;
  rows: number;
  columns: number;
  cells: number;
}> = Object.freeze({ bytes: 65_536, rows: 1024, columns: 128, cells: 2048 });

/**
 * Fixed comma/quote grammar with LF or CRLF records, no inference or evaluation.
 * The caller decodes fatal UTF-8 and consumes its one permitted leading BOM.
 * Empty input is one empty cell; a final record separator adds no phantom row.
 */
export function parseManagedCsv(
  text: string,
): { ok: true; rows: string[][] } | { ok: false; reason: 'invalid_content' | 'resource_limit' } {
  const invalid = { ok: false, reason: 'invalid_content' } as const;
  const limited = { ok: false, reason: 'resource_limit' } as const;
  if (typeof text !== 'string') return invalid;
  if (text.length > MANAGED_CSV_LIMITS.bytes) return limited;

  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      (code >= 127 && code <= 159) ||
      (code >= 0xd800 && code <= 0xdfff) ||
      code === 0xfeff
    )
      return invalid;
    if (code <= 0x7f) bytes++;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
    if (bytes > MANAGED_CSV_LIMITS.bytes) return limited;
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let cells = 0;
  let columns: number | undefined;
  let state: 'start' | 'unquoted' | 'quoted' | 'closed' = 'start';
  let recordOpen = true;
  const finishCell = () => {
    if (row.length >= MANAGED_CSV_LIMITS.columns || cells >= MANAGED_CSV_LIMITS.cells) return false;
    row.push(cell);
    cells++;
    cell = '';
    state = 'start';
    return true;
  };
  const finishRow = () => {
    if (rows.length >= MANAGED_CSV_LIMITS.rows) return limited;
    if (columns !== undefined && row.length !== columns) return invalid;
    columns = row.length;
    rows.push(row);
    row = [];
    return null;
  };

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    recordOpen = true;
    if (state === 'quoted') {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index++;
        } else state = 'closed';
      } else cell += character;
      continue;
    }
    if (character === ',' || character === '\n' || character === '\r') {
      if (character === '\r') {
        if (text[index + 1] !== '\n') return invalid;
        index++;
      }
      if (!finishCell()) return limited;
      if (character !== ',') {
        const failure = finishRow();
        if (failure) return failure;
        recordOpen = false;
      }
      continue;
    }
    if (state === 'closed') return invalid;
    if (character === '"') {
      if (state !== 'start') return invalid;
      state = 'quoted';
    } else {
      cell += character;
      state = 'unquoted';
    }
  }
  if (state === 'quoted') return invalid;
  if (recordOpen) {
    if (!finishCell()) return limited;
    const failure = finishRow();
    if (failure) return failure;
  }
  return { ok: true, rows };
}
