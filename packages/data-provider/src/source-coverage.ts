/** Metadata for prepared retained sources, never a claim that a model read their contents. */
export type ExtractedTextCoverage = {
  unit: 'utf16';
  start: 0;
  end: number;
  total: number;
  complete: boolean;
};
export type PreparedFileCoverage = {
  file_id: string;
  coverage: ExtractedTextCoverage;
  extraction: 'not_assessed';
};
export type SourceCoverageOrigin = { kind: 'message' | 'steer'; id: string };
export type SourceCoverage = {
  version: 1;
  stage: 'prepared';
  scope: 'retained_sources';
  entries: (PreparedFileCoverage & { source: SourceCoverageOrigin })[];
};

function fields(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length) return null;
  const result: Record<string, unknown> = Object.create(null);
  for (const key of actual) {
    if (typeof key !== 'string' || !keys.includes(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function identifier(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || (code >= 127 && code <= 159)) return false;
  }
  return true;
}

/** Closed descriptor-only validation returns detached data, without invoking caller accessors. */
export function readSourceCoverage(value: unknown): SourceCoverage | null {
  try {
    const root = fields(value, ['version', 'stage', 'scope', 'entries']);
    if (
      !root ||
      root.version !== 1 ||
      root.stage !== 'prepared' ||
      root.scope !== 'retained_sources'
    )
      return null;
    const list = root.entries;
    if (!Array.isArray(list) || Object.getPrototypeOf(list) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(list, 'length')?.value;
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > 64 ||
      Reflect.ownKeys(list).length !== length + 1
    )
      return null;
    const entries: SourceCoverage['entries'] = [];
    const bindings = new Set<string>();
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(list, String(index));
      if (!descriptor?.enumerable || !('value' in descriptor)) return null;
      const entry = fields(descriptor.value, ['file_id', 'coverage', 'extraction', 'source']);
      if (!entry || !identifier(entry.file_id) || entry.extraction !== 'not_assessed') return null;
      const coverage = fields(entry.coverage, ['unit', 'start', 'end', 'total', 'complete']);
      const source = fields(entry.source, ['kind', 'id']);
      if (
        !coverage ||
        coverage.unit !== 'utf16' ||
        coverage.start !== 0 ||
        typeof coverage.end !== 'number' ||
        !Number.isSafeInteger(coverage.end) ||
        coverage.end < 0 ||
        typeof coverage.total !== 'number' ||
        !Number.isSafeInteger(coverage.total) ||
        coverage.total < coverage.end ||
        typeof coverage.complete !== 'boolean' ||
        coverage.complete !== (coverage.end === coverage.total) ||
        !source ||
        (source.kind !== 'message' && source.kind !== 'steer') ||
        !identifier(source.id)
      )
        return null;
      const binding = JSON.stringify([entry.file_id, source.kind, source.id]);
      if (bindings.has(binding)) return null;
      bindings.add(binding);
      entries.push({
        file_id: entry.file_id,
        extraction: 'not_assessed',
        coverage: {
          unit: 'utf16',
          start: 0,
          end: coverage.end,
          total: coverage.total,
          complete: coverage.complete,
        },
        source: { kind: source.kind, id: source.id },
      });
    }
    const result: SourceCoverage = {
      version: 1,
      stage: 'prepared',
      scope: 'retained_sources',
      entries,
    };
    return new TextEncoder().encode(JSON.stringify(result)).length <= 32 * 1024 ? result : null;
  } catch {
    return null;
  }
}
