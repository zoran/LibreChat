/** Pure classification evidence only. The trusted scanner owns bytes, isolation and approval. */
export type SecurityMarkingPolicy = {
  version: 1;
  markings: readonly string[];
  /** Literal classification field names, without their ':' or '=' separator. */
  labels?: readonly string[];
  /** Whole-body-unit explanatory frames, with exactly one configured marking between them. */
  prose?: readonly { before: string; after: string }[];
};
export type SecurityMarkingEvidence = {
  version: 1;
  /** Trusted scanner assertion; pages and parts are positive, globally numbered from one. */
  coverage: { complete: boolean; pages: number; parts: number };
  /** Complete context blocks, including blank pages and non-page metadata; never truncated snippets. */
  units: readonly {
    part: number;
    page: number | null;
    placement: 'metadata' | 'heading' | 'margin' | 'body';
    text: string;
  }[];
};
export type SecurityMarkingResult =
  | { decision: 'clear' }
  | { decision: 'rejected'; reason: 'classification_marking' }
  | {
      decision: 'uninspectable';
      reason: 'invalid_content' | 'incomplete_coverage' | 'resource_limit' | 'ambiguous_marking';
    };

type FailureReason = Extract<SecurityMarkingResult, { decision: 'uninspectable' }>['reason'];
type PreparedPolicy = {
  markings: string[];
  compact: Set<string>;
  labels: Set<string>;
  prose: Set<string>;
};
type Unit = SecurityMarkingEvidence['units'][number];

class InspectionFailure extends Error {
  constructor(readonly reason: FailureReason) {
    super(reason);
  }
}

function fail(reason: FailureReason): never {
  throw new InspectionFailure(reason);
}

/** Read JSON-shaped own data only, without invoking accessors or accepting extra executable policy. */
function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_content');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('invalid_content');
  const keys = Reflect.ownKeys(value);
  if (keys.length > required.length + optional.length) fail('invalid_content');
  for (const key of keys) {
    if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key)))
      fail('invalid_content');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('invalid_content');
  }
  if (required.some((key) => !keys.includes(key))) fail('invalid_content');
  return value as Record<string, unknown>;
}

function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    fail('invalid_content');
  if (value.length > maximum) fail('resource_limit');
  if (Reflect.ownKeys(value).length !== value.length + 1) fail('invalid_content');
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) fail('invalid_content');
  }
  return value;
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string') fail('invalid_content');
  if (value.length > maximum || Buffer.byteLength(value, 'utf8') > maximum) fail('resource_limit');
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      (code >= 127 && code <= 159) ||
      (code >= 0xd800 && code <= 0xdfff) ||
      code === 0xfffd
    )
      fail('invalid_content');
  }
  return value;
}

function normalized(value: string): string {
  return (
    value
      .normalize('NFKC')
      .toUpperCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.join(' ') ?? ''
  );
}

function uncertainTypography(value: string): boolean {
  if (/\p{Cf}/u.test(value)) return true;
  // Do not guess a Unicode confusable mapping. Mixed Latin/Greek/Cyrillic words need inspection.
  return (value.normalize('NFKC').match(/\p{L}+/gu) ?? []).some((word) => {
    const scripts = [
      /\p{Script=Latin}/u.test(word),
      /\p{Script=Greek}/u.test(word),
      /\p{Script=Cyrillic}/u.test(word),
    ];
    return scripts.filter(Boolean).length > 1;
  });
}

function literal(value: unknown): string {
  const source = text(value, 512).normalize('NFKC');
  if (
    source.length > 128 ||
    !/^[\p{L}\p{N}][\p{L}\p{N}\s\p{Dash_Punctuation}\u2212]*$/u.test(source) ||
    uncertainTypography(source)
  )
    fail('invalid_content');
  const result = normalized(source);
  if (!result) fail('invalid_content');
  return result;
}

function preparePolicy(value: unknown): PreparedPolicy {
  const policy = record(value, ['version', 'markings'], ['labels', 'prose']);
  if (policy.version !== 1) fail('invalid_content');
  const markings = list(policy.markings, 64).map(literal);
  if (!markings.length || new Set(markings).size !== markings.length) fail('invalid_content');
  const labels = policy.labels === undefined ? [] : list(policy.labels, 16).map(literal);
  if (new Set(labels).size !== labels.length) fail('invalid_content');
  const prose = new Set<string>();
  for (const item of policy.prose === undefined ? [] : list(policy.prose, 32)) {
    const frame = record(item, ['before', 'after']);
    const before = text(frame.before, 512);
    const after = text(frame.after, 512);
    if (
      before.length > 128 ||
      after.length > 128 ||
      uncertainTypography(before + after) ||
      !normalized(before) ||
      !normalized(after)
    )
      fail('invalid_content');
    for (const marking of markings) prose.add(normalized(`${before} ${marking} ${after}`));
  }
  return {
    markings,
    compact: new Set(markings.map((marking) => marking.replaceAll(' ', ''))),
    labels: new Set(labels),
    prose,
  };
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function prepareEvidence(value: unknown): Unit[] {
  const evidence = record(value, ['version', 'coverage', 'units']);
  const coverage = record(evidence.coverage, ['complete', 'pages', 'parts']);
  if (
    evidence.version !== 1 ||
    typeof coverage.complete !== 'boolean' ||
    !positiveInteger(coverage.pages) ||
    !positiveInteger(coverage.parts)
  )
    fail('invalid_content');
  if (coverage.pages > 500 || coverage.parts > 2048) fail('resource_limit');
  if (!coverage.complete) fail('incomplete_coverage');
  const pageCount = coverage.pages;
  const partCount = coverage.parts;
  const pages = new Set<number>();
  const parts = new Set<number>();
  let bytes = 0;
  const units = list(evidence.units, 4096).map((item) => {
    const unit = record(item, ['part', 'page', 'placement', 'text']);
    if (
      !positiveInteger(unit.part) ||
      (unit.page !== null && !positiveInteger(unit.page)) ||
      !['metadata', 'heading', 'margin', 'body'].includes(unit.placement as string)
    )
      fail('invalid_content');
    if (
      unit.part > partCount ||
      (unit.page !== null && unit.page > pageCount) ||
      (unit.page === null && unit.placement !== 'metadata')
    )
      fail('incomplete_coverage');
    const content = text(unit.text, 65_536);
    bytes += Buffer.byteLength(content, 'utf8');
    if (bytes > 15 * 1024 * 1024) fail('resource_limit');
    if (unit.page !== null) pages.add(unit.page);
    parts.add(unit.part);
    return { ...unit, text: content } as Unit;
  });
  if (pages.size !== pageCount || parts.size !== partCount) fail('incomplete_coverage');
  return units;
}

function isMarking(value: string, policy: PreparedPolicy): boolean {
  return policy.compact.has(normalized(value).replaceAll(' ', ''));
}

function isLabeledMarking(value: string, policy: PreparedPolicy): boolean {
  const canonical = value.normalize('NFKC');
  const separator = canonical.search(/[:=]/u);
  return (
    separator >= 0 &&
    policy.labels.has(normalized(canonical.slice(0, separator))) &&
    isMarking(canonical.slice(separator + 1), policy)
  );
}

/** Match only complete words (including deliberately separated letters), never a substring of one. */
function containsMarking(canonical: string, policy: PreparedPolicy): boolean {
  const words = canonical.split(' ');
  const boundaries = new Set<number>([0]);
  let offset = 0;
  for (const word of words) {
    offset += word.length;
    boundaries.add(offset);
  }
  const compact = words.join('');
  for (const marking of policy.compact) {
    let position = compact.indexOf(marking);
    while (position >= 0) {
      if (boundaries.has(position) && boundaries.has(position + marking.length)) return true;
      position = compact.indexOf(marking, position + 1);
    }
  }
  return false;
}

/**
 * Pure, bounded evidence classification; `clear` is deliberately NOT UploadSecurityApproval.
 * The caller must supply complete scanner-owned context blocks and independently bind every byte,
 * part, page and policy revision. Unknown semantic mentions remain uninspectable. Literal prose
 * frames are trusted policy, matched to an entire body block, never a substring-based allowlist.
 * Limits: 64 markings, 16 labels, 32 frames, 4096 units, 500 pages, 2048 parts, 64 KiB per unit and
 * 15 MiB total UTF-8 text. No parsing, OCR, model, file, network, logging or policy code execution.
 */
export function inspectSecurityMarkings(policy: unknown, evidence: unknown): SecurityMarkingResult {
  try {
    const prepared = preparePolicy(policy);
    const units = prepareEvidence(evidence);
    let ambiguous = false;
    let rejected = false;
    for (const unit of units) {
      if (uncertainTypography(unit.text)) {
        ambiguous = true;
        continue;
      }
      const candidates = [unit.text, ...unit.text.split(/\r\n|[\r\n\u2028\u2029]/u)];
      if (
        candidates.some(
          (candidate) =>
            isLabeledMarking(candidate, prepared) ||
            (unit.placement !== 'body' && isMarking(candidate, prepared)),
        )
      ) {
        rejected = true;
        continue;
      }
      const canonical = normalized(unit.text);
      if (containsMarking(canonical, prepared)) {
        if (unit.placement !== 'body' || !prepared.prose.has(canonical)) ambiguous = true;
      }
    }
    if (rejected) return { decision: 'rejected', reason: 'classification_marking' };
    if (ambiguous) return { decision: 'uninspectable', reason: 'ambiguous_marking' };
    return { decision: 'clear' };
  } catch (error) {
    return {
      decision: 'uninspectable',
      reason: error instanceof InspectionFailure ? error.reason : 'invalid_content',
    };
  }
}
