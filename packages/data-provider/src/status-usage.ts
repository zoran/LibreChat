import { z } from 'zod';

export const STATUS_USAGE_COLUMNS = {
  users: ['active', 'concurrentMeanMicros', 'concurrentPeak'],
  documents: ['published', 'retainedEnd'],
  tokens: [
    'input',
    'output',
    'primaryInput',
    'primaryOutput',
    'sequentialInput',
    'sequentialOutput',
    'summarizationInput',
    'summarizationOutput',
    'subagentInput',
    'subagentOutput',
    'reasoningOutput',
    'cacheReadInput',
    'cacheWriteInput',
    'terminal',
    'providerUsage',
    'missingUsage',
    'estimatedUsage',
    'retried',
  ],
  latency: [
    'p50Micros',
    'p95Micros',
    'sampleCount',
    'eligibleStarts',
    'missing',
    'aborted',
    'hidden',
    'replayed',
  ],
  valuation: [
    'model1UsdMicros',
    'model2UsdMicros',
    'model3UsdMicros',
    'model1EurMicros',
    'model2EurMicros',
    'model3EurMicros',
    'meanEurMicros',
  ],
} as const;
const names = ['users', 'documents', 'tokens', 'latency', 'valuation'] as const;
const qualities = [
  'complete',
  'partial',
  'unknown',
  'stale',
  'unavailable',
  'unknown',
  'unknown',
  'unknown',
] as const;
const reasons = [
  'observed',
  'partial_coverage',
  'not_measured',
  'source_stale',
  'source_unavailable',
  'counter_reset',
  'insufficient_samples',
  'no_samples',
] as const;
type Basis = 'query_partitions' | 'scheduled_seconds' | 'terminal_attempts' | 'eligible_starts';
const bases: Basis[] = [
  'scheduled_seconds',
  'query_partitions',
  'terminal_attempts',
  'eligible_starts',
  'terminal_attempts',
];
export interface StatusUsageGroup<T> {
  quality: (typeof qualities)[number];
  reason: (typeof reasons)[number];
  sourceId: string | null;
  observedAt: number | null;
  maxAgeSeconds: number;
  coverage: { expected: number | null; observed: number; basis: Basis };
  values: T;
}
type Values<K extends readonly string[]> = { [P in K[number]]: number | null };
export type StatusUsageGroups = {
  [P in keyof typeof STATUS_USAGE_COLUMNS]: StatusUsageGroup<
    Values<(typeof STATUS_USAGE_COLUMNS)[P]>
  >;
};
export interface StatusUsageWindow {
  start: number;
  end: number;
  groups: StatusUsageGroups;
}
export interface StatusUsage {
  current: {
    at: number;
    grants: StatusUsageGroup<{ signedInUsers: number | null }>;
    presence: StatusUsageGroup<{ concurrentUsers: number | null }>;
    documents: StatusUsageGroup<{ retainedUploadedDocuments: number | null }>;
  };
  lastHour: StatusUsageWindow;
  history: { start: number; end: number; stepSeconds: 3600; rows: StatusUsageWindow[] };
  comparisonReference: StatusComparisonReference | null;
}
const uint = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const time = uint.max(8640000000000);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const n = Date.parse(v);
    return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === v;
  });
const tier = z
  .object({
    upperInputTokens: uint.nullable(),
    inputUsdMicrosPerMillion: uint,
    outputUsdMicrosPerMillion: uint,
  })
  .strict();
const model = z
  .object({
    modelId: z.enum(['gpt-6-astra', 'claude-fable-5-1', 'gemini-4-argon']),
    sourceKey: z.enum(['openai_api_pricing', 'anthropic_api_pricing', 'google_api_pricing']),
    tiers: z.array(tier).min(1).max(2),
  })
  .strict();
export const comparisonReferenceShape = z
  .object({
    id: z
      .string()
      .min(1)
      .max(96)
      .regex(/^[A-Za-z0-9_.-]+$/),
    observedAt: time,
    valuationDate: date,
    reviewBefore: date,
    scenario: z.literal('uncached_nominal'),
    weighting: z.literal('equal'),
    models: z.tuple([model, model, model]),
    fx: z
      .object({
        usdPerEurMicros: uint.positive(),
        rateDate: date,
        observedAt: time,
        sourceKey: z.literal('ecb_euro_reference_usd'),
        carriedForward: z.boolean(),
        stale: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type StatusComparisonReference = z.infer<typeof comparisonReferenceShape>;
function group(width: number) {
  return z
    .array(uint.nullable())
    .length(width + 4)
    .superRefine((v, ctx) => {
      if (
        v[0] === null ||
        v[0] > 7 ||
        (v[1] !== null && v[1] > 8640000000000) ||
        v[3] === null ||
        (v[2] !== null && v[3] !== null && v[3] > v[2])
      )
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'usage coverage' });
    });
}
const groups = z.tuple([group(3), group(2), group(18), group(8), group(7)]);
const source = z.number().int().min(-1).max(15);
const age = uint.min(1).max(86400);
export const usageShape = z
  .object({
    sources: z.tuple([source, source, source, source, source]),
    maxAgeSeconds: z.tuple([age, age, age, age, age]),
    current: z
      .object({ at: time, grants: group(1), presence: group(1), documents: group(1) })
      .strict(),
    lastHour: z.object({ end: time, groups }).strict(),
    history: z
      .object({ start: time, stepSeconds: z.literal(3600), rows: z.array(groups).length(168) })
      .strict(),
    comparisonReference: comparisonReferenceShape.nullable(),
  })
  .strict();
export type StatusUsageWire = z.infer<typeof usageShape>;
type Sources = { id: string; kind: string; capturedAt: number }[];
function need(ok: unknown): asserts ok {
  if (!ok) throw Error('STATUS_USAGE_INVALID');
}
export function decodeStatusUsage(
  w: StatusUsageWire,
  sources: Sources,
  generatedAt: number,
): StatusUsage {
  // The window is anchored to aggregate capture, not a later cache delivery time.
  const boundary = Math.floor(w.current.at / 3600) * 3600;
  need(
    w.history.start + 168 * 3600 === boundary &&
      w.current.at <= generatedAt &&
      w.lastHour.end <= generatedAt &&
      w.lastHour.end >= 3600,
  );
  const decode = (
    v: (number | null)[],
    i: number,
    columns: readonly string[],
    basis = bases[i],
  ) => {
    const q = v[0]!,
      at = v[1],
      expected = v[2],
      observed = v[3]!;
    const source = w.sources[i] < 0 ? null : sources[w.sources[i]];
    need(
      w.sources[i] === -1 || (source && ['prometheus', 'application_usage'].includes(source.kind)),
    );
    const values = Object.fromEntries(columns.map((key, j) => [key, v[j + 4]]));
    if (!source)
      need(
        q === 2 &&
          at === null &&
          expected === null &&
          observed === 0 &&
          v.slice(4).every((x) => x === null),
      );
    if (at !== null) need(source && at <= source.capturedAt && at <= generatedAt);
    if (q === 0 || q === 1) need(source && at !== null && generatedAt - at <= w.maxAgeSeconds[i]);
    if (q === 0)
      need(
        expected !== null &&
          observed === expected &&
          (basis !== 'query_partitions' || observed > 0),
      );
    if (q === 0)
      need(
        columns.every(
          (key, j) =>
            v[j + 4] !== null ||
            (i === 2 && ['reasoningOutput', 'cacheReadInput', 'cacheWriteInput'].includes(key)) ||
            (i === 4 && !w.comparisonReference?.fx && j >= 3),
        ),
      );
    if (q === 3) need(at !== null && generatedAt - at > w.maxAgeSeconds[i]);
    if ([2, 4, 5, 6].includes(q)) need(v.slice(4).every((x) => x === null));
    return {
      quality: qualities[q],
      reason: reasons[q],
      sourceId: source?.id ?? null,
      observedAt: at,
      maxAgeSeconds: w.maxAgeSeconds[i],
      coverage: { expected, observed, basis },
      values,
    };
  };
  function window(
    rows: StatusUsageWire['lastHour']['groups'],
    start: number,
    end: number,
  ): StatusUsageWindow {
    const g = Object.fromEntries(
      names.map((name, i) => [name, decode(rows[i], i, STATUS_USAGE_COLUMNS[name])]),
    ) as StatusUsageGroups;
    const t = g.tokens.values;
    for (const [total, parts] of [
      [t.input, [t.primaryInput, t.sequentialInput, t.summarizationInput, t.subagentInput]],
      [t.output, [t.primaryOutput, t.sequentialOutput, t.summarizationOutput, t.subagentOutput]],
    ] as const)
      if (total !== null && parts.every((v) => v !== null))
        need(BigInt(total) === parts.reduce<bigint>((sum, v) => sum + BigInt(v!), BigInt(0)));
    if (g.tokens.quality === 'complete') {
      need(
        Object.entries(t).every(
          ([k, v]) =>
            ['reasoningOutput', 'cacheReadInput', 'cacheWriteInput'].includes(k) || v !== null,
        ),
      );
      need(
        t.input === t.primaryInput! + t.sequentialInput! + t.summarizationInput! + t.subagentInput!,
      );
      need(
        t.output ===
          t.primaryOutput! + t.sequentialOutput! + t.summarizationOutput! + t.subagentOutput!,
      );
      need(t.missingUsage === 0 && t.estimatedUsage === 0 && t.terminal === t.providerUsage);
    }
    if (t.reasoningOutput !== null && t.output !== null) need(t.reasoningOutput <= t.output);
    if (t.cacheReadInput !== null && t.cacheWriteInput !== null && t.input !== null)
      need(t.cacheReadInput + t.cacheWriteInput <= t.input);
    if (t.retried !== null && t.terminal !== null) need(t.retried <= t.terminal);
    const l = g.latency.values;
    if (l.p50Micros !== null || l.p95Micros !== null)
      need(l.sampleCount !== null && l.sampleCount > 0);
    if (l.p50Micros !== null && l.p95Micros !== null) need(l.p50Micros <= l.p95Micros);
    if (g.valuation.quality === 'complete')
      need(
        g.tokens.quality === 'complete' &&
          g.valuation.coverage.expected === g.tokens.coverage.expected &&
          g.valuation.coverage.observed === g.tokens.coverage.observed &&
          g.valuation.observedAt! + g.valuation.maxAgeSeconds <=
            g.tokens.observedAt! + g.tokens.maxAgeSeconds,
      );
    if (!w.comparisonReference) need(Object.values(g.valuation.values).every((v) => v === null));
    if (!w.comparisonReference?.fx)
      need(
        [
          g.valuation.values.model1EurMicros,
          g.valuation.values.model2EurMicros,
          g.valuation.values.model3EurMicros,
          g.valuation.values.meanEurMicros,
        ].every((v) => v === null),
      );
    const euro = g.valuation.values;
    if (
      [euro.model1EurMicros, euro.model2EurMicros, euro.model3EurMicros, euro.meanEurMicros].every(
        (v) => v !== null,
      )
    )
      need(
        BigInt(euro.meanEurMicros!) ===
          (BigInt(euro.model1EurMicros!) +
            BigInt(euro.model2EurMicros!) +
            BigInt(euro.model3EurMicros!) +
            BigInt(1)) /
            BigInt(3),
      );
    return { start, end, groups: g };
  }
  const ref = w.comparisonReference;
  if (ref) {
    need(ref.observedAt <= generatedAt && ref.reviewBefore > ref.valuationDate);
    const ids = ['gpt-6-astra', 'claude-fable-5-1', 'gemini-4-argon'];
    const keys = ['openai_api_pricing', 'anthropic_api_pricing', 'google_api_pricing'];
    ref.models.forEach((m, i) =>
      need(
        m.modelId === ids[i] &&
          m.sourceKey === keys[i] &&
          m.tiers[m.tiers.length - 1]!.upperInputTokens === null &&
          (m.tiers.length === 1 || m.tiers[0].upperInputTokens !== null),
      ),
    );
    if (ref.fx)
      need(
        ref.fx.observedAt <= generatedAt &&
          ref.fx.rateDate <= ref.valuationDate &&
          ref.fx.carriedForward === ref.fx.rateDate < ref.valuationDate,
      );
  }
  return {
    current: {
      at: w.current.at,
      grants: decode(
        w.current.grants,
        0,
        ['signedInUsers'],
        'query_partitions',
      ) as StatusUsage['current']['grants'],
      presence: decode(
        w.current.presence,
        0,
        ['concurrentUsers'],
        'query_partitions',
      ) as StatusUsage['current']['presence'],
      documents: decode(
        w.current.documents,
        1,
        ['retainedUploadedDocuments'],
        'query_partitions',
      ) as StatusUsage['current']['documents'],
    },
    lastHour: window(w.lastHour.groups, w.lastHour.end - 3600, w.lastHour.end),
    history: {
      start: w.history.start,
      end: boundary,
      stepSeconds: 3600,
      rows: w.history.rows.map((r, i) =>
        window(r, w.history.start + i * 3600, w.history.start + (i + 1) * 3600),
      ),
    },
    comparisonReference: ref,
  };
}
export function encodeStatusUsage(u: StatusUsage, sources: Sources): StatusUsageWire {
  const reference = u.lastHour.groups;
  const pack = (
    g: StatusUsageGroup<Record<string, number | null>>,
    columns: readonly string[],
    i: number,
  ) => {
    const base = reference[names[i]];
    need(g.sourceId === base.sourceId && g.maxAgeSeconds === base.maxAgeSeconds);
    const q = reasons.indexOf(g.reason);
    need(q >= 0 && qualities[q] === g.quality);
    return [
      q,
      g.observedAt,
      g.coverage.expected,
      g.coverage.observed,
      ...columns.map((k) => g.values[k]),
    ];
  };
  const row = (r: StatusUsageWindow) =>
    names.map((n, i) => pack(r.groups[n], STATUS_USAGE_COLUMNS[n], i));
  return usageShape.parse({
    sources: names.map((n) =>
      reference[n].sourceId === null
        ? -1
        : sources.findIndex((s) => s.id === reference[n].sourceId),
    ),
    maxAgeSeconds: names.map((n) => reference[n].maxAgeSeconds),
    current: {
      at: u.current.at,
      grants: pack(u.current.grants, ['signedInUsers'], 0),
      presence: pack(u.current.presence, ['concurrentUsers'], 0),
      documents: pack(u.current.documents, ['retainedUploadedDocuments'], 1),
    },
    lastHour: { end: u.lastHour.end, groups: row(u.lastHour) },
    history: { start: u.history.start, stepSeconds: 3600, rows: u.history.rows.map(row) },
    comparisonReference: u.comparisonReference,
  });
}
/** Instrumentation absence is explicit; never substitute zero-valued usage. */
export function createUnknownStatusUsage(now: number): StatusUsage {
  const at = Math.floor(now),
    start = Math.floor(at / 3600) * 3600 - 168 * 3600;
  const absent = (n: number) => [2, null, null, 0, ...Array(n).fill(null)];
  const row = () => names.map((n) => absent(STATUS_USAGE_COLUMNS[n].length));
  const wire = usageShape.parse({
    sources: Array(5).fill(-1),
    maxAgeSeconds: Array(5).fill(90),
    current: { at, grants: absent(1), presence: absent(1), documents: absent(1) },
    lastHour: { end: at, groups: row() },
    history: { start, stepSeconds: 3600, rows: Array.from({ length: 168 }, row) },
    comparisonReference: null,
  });
  return decodeStatusUsage(wire, [], now);
}
