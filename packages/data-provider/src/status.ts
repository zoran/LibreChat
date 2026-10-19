import { z } from 'zod';
import type { StatusParameterKey } from './status-parameters';
import { STATUS_PARAMETERS } from './status-parameters';
export { STATUS_PARAMETERS };
export type { StatusParameterKey };

/** One public, read-only snapshot for all zoom presets. All timestamps are Unix seconds.
 * Validation establishes shape/coherence, not collector authority, health or deployment proof.
 * Transport must reject bodies above maxBytes BEFORE JSON parsing. No raw PromQL/URLs/labels.
 */
export const STATUS_LIMITS = Object.freeze({
  maxBytes: 512 * 1024,
  maxNodes: 256,
  maxEdges: 1024,
  maxMeasurements: 2048,
  maxSources: 16,
  maxParameters: 512,
  maxParametersPerNode: 24,
  maxParameterEvidence: 128,
  maxSamples: 2,
  maxDepth: 16,
  maxValues: 100000,
});
export const STATUS_ZOOM_PRESETS = ['overview', 'infrastructure', 'processing'] as const;

type MetricDefinition = {
  unit:
    | 'ratio'
    | 'bytes'
    | 'count'
    | 'bytes_per_second'
    | 'packets_per_second'
    | 'errors_per_second'
    | 'watts'
    | 'requests_per_second'
    | 'seconds';
  scope: 'host' | 'cpu' | 'filesystem' | 'interface' | 'gpu' | 'http';
  windowSeconds: 0 | 120;
  maxAgeSeconds: 60 | 90;
};
function metric(
  unit: MetricDefinition['unit'],
  scope: MetricDefinition['scope'],
  rate = false,
): MetricDefinition {
  return Object.freeze({
    unit,
    scope,
    windowSeconds: rate ? 120 : 0,
    maxAgeSeconds: scope === 'gpu' ? 60 : 90,
  });
}
/** Keys/units/windows bind the existing Observability producer. No unsupported node averages. */
export const STATUS_METRICS = Object.freeze({
  'cpu.utilization': metric('ratio', 'cpu', true),
  'memory.available': metric('bytes', 'host'),
  'memory.available_ratio': metric('ratio', 'host'),
  'pressure.cpu_waiting': metric('ratio', 'host', true),
  'pressure.io_waiting': metric('ratio', 'host', true),
  'pressure.io_stalled': metric('ratio', 'host', true),
  'pressure.memory_waiting': metric('ratio', 'host', true),
  'pressure.memory_stalled': metric('ratio', 'host', true),
  'filesystem.available': metric('bytes', 'filesystem'),
  'filesystem.inodes_free': metric('count', 'filesystem'),
  'filesystem.available_ratio': metric('ratio', 'filesystem'),
  'filesystem.inodes_free_ratio': metric('ratio', 'filesystem'),
  'network.rx': metric('bytes_per_second', 'interface', true),
  'network.tx': metric('bytes_per_second', 'interface', true),
  'network.rx_drops': metric('packets_per_second', 'interface', true),
  'network.tx_drops': metric('packets_per_second', 'interface', true),
  'network.rx_errors': metric('errors_per_second', 'interface', true),
  'network.tx_errors': metric('errors_per_second', 'interface', true),
  'gpu.utilization': metric('ratio', 'gpu'),
  'gpu.memory_used': metric('bytes', 'gpu'),
  'gpu.power': metric('watts', 'gpu'),
  'http.request_rate': metric('requests_per_second', 'http', true),
  'http.latency_p95': metric('seconds', 'http', true),
});
export type StatusMetricKey = keyof typeof STATUS_METRICS;
const token = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9_.-]+$/);
const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const hasControlCharacters = (value: string): boolean =>
  Array.from(value).some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
const label = z
  .string()
  .min(1)
  .max(96)
  .refine((value) => !hasControlCharacters(value));
const time = z.number().finite().min(0).max(8640000000000);
const count = z.number().int().min(0).max(1000000);
const coverage = z
  .object({ expected: count.nullable(), observed: count })
  .strict()
  .refine((v) => v.expected === null || v.observed <= v.expected, 'invalid coverage');
const evidence = z
  .object({
    sourceId: token,
    observedAt: time,
    maxAgeSeconds: z.number().int().min(1).max(86400),
    coverage,
  })
  .strict();
const state = z.enum([
  'healthy',
  'degraded',
  'unknown',
  'stale',
  'disabled',
  'unavailable',
  'disagreement',
]);
const reason = z.enum([
  'observed',
  'not_measured',
  'not_configured',
  'source_unavailable',
  'source_stale',
  'sources_disagree',
  'partial_coverage',
  'no_traffic',
  'counter_reset',
  'insufficient_samples',
  'not_qualified',
]);
const identity = z.discriminatedUnion('scope', [
  z
    .object({
      scope: z.literal('physical'),
      kind: z.enum(['host', 'cpu', 'memory', 'gpu', 'disk', 'interface']),
      key: token,
    })
    .strict(),
  z
    .object({
      scope: z.literal('logical'),
      kind: z.enum(['entry', 'service', 'model', 'queue', 'network']),
      key: token,
    })
    .strict(),
  z.object({ scope: z.literal('runtime'), kind: z.enum(['pod', 'process']), key: token }).strict(),
]);
export type StatusIdentity = z.infer<typeof identity>;
/** Physical key is the inventory asset/device identity (GPU UUID); runtime key is an incarnation. */
export function statusNodeId(value: StatusIdentity): string {
  return `${value.scope}:${value.kind}:${value.key}`;
}
const node = z
  .object({
    id,
    identity,
    label,
    layer: z.enum([
      'entry',
      'network',
      'application',
      'data',
      'inference',
      'documents',
      'monitoring',
      'hardware',
    ]),
    assessments: z
      .array(
        z
          .object({
            dimension: z.enum(['availability', 'capacity', 'qualification', 'app_e2e']),
            state,
            reason,
            evidence: z.array(evidence).max(2),
          })
          .strict(),
      )
      .max(4),
  })
  .strict();
const edge = z
  .object({
    id,
    from: id,
    to: id,
    kind: z.enum(['contains', 'deployment', 'allocation', 'request', 'dependency']),
    purpose: z.enum([
      'physical_containment',
      'runtime_placement',
      'workload_binding',
      'gpu_allocation',
      'model_request',
      'document_extraction',
      'retrieval',
      'embedding',
      'reranking',
      'monitoring',
      'storage',
      'network_transport',
    ]),
    basis: z.enum(['desired', 'observed', 'inferred']),
    state,
    reason,
    evidence: z.array(evidence).max(2),
  })
  .strict();
const scope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('host') }).strict(),
  z.object({ kind: z.literal('cpu'), cpuId: token }).strict(),
  z
    .object({ kind: z.literal('filesystem'), deviceId: token, mountId: token, fsType: token })
    .strict(),
  z.object({ kind: z.literal('interface'), interfaceId: token }).strict(),
  z.object({ kind: z.literal('gpu') }).strict(),
  z
    .object({
      kind: z.literal('http'),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
      routeKey: token,
      statusCode: z.number().int().min(100).max(599),
      instanceId: token,
    })
    .strict(),
]);
const sample = z
  .object({
    sourceId: token,
    observedAt: time,
    value: z.number().finite().nonnegative(),
    windowSeconds: z.union([z.literal(0), z.literal(120)]),
    sampleCount: count,
    resetCount: count,
    coverage,
  })
  .strict();
const measurement = z
  .object({
    id,
    target: z.object({ kind: z.enum(['node', 'edge']), id }).strict(),
    key: z.custom<StatusMetricKey>(
      (v) => typeof v === 'string' && Object.prototype.hasOwnProperty.call(STATUS_METRICS, v),
    ),
    unit: z.enum([
      'ratio',
      'bytes',
      'count',
      'bytes_per_second',
      'packets_per_second',
      'errors_per_second',
      'watts',
      'requests_per_second',
      'seconds',
    ]),
    scope,
    state: z.enum(['fresh', 'unknown', 'stale', 'disabled', 'unavailable', 'disagreement']),
    reason,
    value: z.number().finite().nonnegative().nullable(),
    selectedSourceId: token.nullable(),
    samples: z.array(sample).max(STATUS_LIMITS.maxSamples),
  })
  .strict();
// Curated public explanations, never raw command output, env variables, credentials or paths.
const explanation = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[^/@\\$=]+$/)
  .refine((value) => !hasControlCharacters(value))
  .refine((v) => !/(?:https?:|bearer\s|sk-[a-z0-9]{12})/i.test(v), 'private explanation');
const parameterEvidence = z
  .object({
    id: token,
    kind: z.enum(['decision', 'benchmark']),
    sourceId: token,
    nodeId: id,
    parameterKey: z.custom<StatusParameterKey>(
      (v) => typeof v === 'string' && Object.prototype.hasOwnProperty.call(STATUS_PARAMETERS, v),
    ),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    recordedAt: time,
    timeBasis: z.enum(['source_capture', 'decision_record', 'benchmark_run']),
    summary: explanation,
  })
  .strict();
const parameter = z
  .object({
    nodeId: id,
    key: z.custom<StatusParameterKey>(
      (v) => typeof v === 'string' && Object.prototype.hasOwnProperty.call(STATUS_PARAMETERS, v),
    ),
    label,
    unit: z.enum(['tokens', 'seconds', 'count', 'ratio', 'bytes', 'boolean', 'none']),
    stage: z.enum(['configured', 'effective', 'proposed']),
    state: z.enum(['known', 'unknown', 'stale']),
    value: z
      .union([z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER), z.boolean(), token])
      .nullable(),
    evidence: z.array(evidence).max(2),
    reason: z
      .object({
        state: z.enum(['known', 'unknown']),
        text: explanation.nullable(),
        evidenceIds: z.array(token).max(4),
      })
      .strict(),
  })
  .strict();

const shape = z
  .object({
    version: z.literal(1),
    generatedAt: time,
    selectedObserverId: token.nullable(),
    sources: z
      .array(
        z
          .object({
            id: token,
            kind: z.enum([
              'prometheus',
              'inventory',
              'runtime',
              'acceptance',
              'decision',
              'benchmark',
            ]),
            observerId: token,
            capturedAt: time,
          })
          .strict(),
      )
      .max(STATUS_LIMITS.maxSources),
    nodes: z.array(node).max(STATUS_LIMITS.maxNodes),
    edges: z.array(edge).max(STATUS_LIMITS.maxEdges),
    measurements: z.array(measurement).max(STATUS_LIMITS.maxMeasurements),
    parameters: z.array(parameter).max(STATUS_LIMITS.maxParameters),
    parameterEvidence: z.array(parameterEvidence).max(STATUS_LIMITS.maxParameterEvidence),
  })
  .strict();
export type StatusSnapshot = z.infer<typeof shape>;
export type StatusNode = StatusSnapshot['nodes'][number];
export type StatusEdge = StatusSnapshot['edges'][number];
export type StatusMeasurement = StatusSnapshot['measurements'][number];
export type StatusParameter = StatusSnapshot['parameters'][number];

function coherent(s: StatusSnapshot): boolean {
  const sources = new Map(s.sources.map((v) => [v.id, v]));
  const nodes = new Map(s.nodes.map((v) => [v.id, v]));
  const edges = new Map(s.edges.map((v) => [v.id, v]));
  if (
    sources.size !== s.sources.length ||
    nodes.size !== s.nodes.length ||
    edges.size !== s.edges.length
  )
    return false;
  if (new Set(s.measurements.map((v) => v.id)).size !== s.measurements.length) return false;
  if (s.sources.some((v) => v.capturedAt > s.generatedAt)) return false;
  if (new Set(s.sources.map((v) => `${v.kind}:${v.observerId}`)).size !== s.sources.length)
    return false;
  if (
    s.selectedObserverId !== null &&
    !s.sources.some((v) => v.kind === 'prometheus' && v.observerId === s.selectedObserverId)
  )
    return false;
  if (
    new Set(s.edges.map((v) => JSON.stringify([v.from, v.to, v.kind, v.basis]))).size !==
    s.edges.length
  )
    return false;
  const validEvidence = (items: z.infer<typeof evidence>[]) =>
    new Set(items.map((v) => v.sourceId)).size === items.length &&
    items.every((v) => {
      const source = sources.get(v.sourceId);
      return source !== undefined && v.observedAt <= source.capturedAt;
    });
  const validState = (v: {
    state: z.infer<typeof state>;
    reason: z.infer<typeof reason>;
    evidence: z.infer<typeof evidence>[];
  }) => {
    const admittedReasons = {
      healthy: ['observed'],
      degraded: ['observed', 'partial_coverage'],
      unknown: [
        'not_measured',
        'not_qualified',
        'no_traffic',
        'counter_reset',
        'insufficient_samples',
      ],
      stale: ['source_stale'],
      disabled: ['not_configured'],
      unavailable: ['source_unavailable'],
      disagreement: ['sources_disagree'],
    };
    if (!admittedReasons[v.state].includes(v.reason) || !validEvidence(v.evidence)) return false;
    if (v.state === 'healthy' || v.state === 'degraded')
      return (
        v.evidence.length > 0 &&
        v.evidence.every(
          (e) => e.coverage.observed > 0 && s.generatedAt - e.observedAt <= e.maxAgeSeconds,
        )
      );
    if (v.state === 'stale')
      return v.evidence.some((e) => s.generatedAt - e.observedAt > e.maxAgeSeconds);
    if (v.state === 'disagreement') return v.evidence.length === 2;
    return true;
  };
  for (const n of s.nodes) {
    if (
      n.identity.scope === 'physical' &&
      n.identity.kind === 'gpu' &&
      !/^GPU-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(n.identity.key)
    )
      return false;
    if (
      n.id !== statusNodeId(n.identity) ||
      new Set(n.assessments.map((a) => a.dimension)).size !== n.assessments.length
    )
      return false;
    for (const a of n.assessments) {
      if (!validState(a)) return false;
      if (
        (a.dimension === 'qualification' || a.dimension === 'app_e2e') &&
        a.state === 'healthy' &&
        a.evidence.some((v) => sources.get(v.sourceId)?.kind !== 'acceptance')
      )
        return false;
    }
  }
  const references = new Map(s.parameterEvidence.map((v) => [v.id, v]));
  if (references.size !== s.parameterEvidence.length) return false;
  for (const ref of s.parameterEvidence) {
    if (
      (ref.kind === 'decision' && ref.timeBasis === 'benchmark_run') ||
      (ref.kind === 'benchmark' && ref.timeBasis === 'decision_record')
    )
      return false;
    const source = sources.get(ref.sourceId);
    if (
      !source ||
      !nodes.has(ref.nodeId) ||
      source.kind !== ref.kind ||
      ref.recordedAt > source.capturedAt
    )
      return false;
  }
  const parameterBindings = new Set<string>();
  const parameterCounts = new Map<string, number>();
  for (const p of s.parameters) {
    const target = nodes.get(p.nodeId);
    const def = STATUS_PARAMETERS[p.key];
    const binding = `${p.nodeId}:${p.key}:${p.stage}`;
    if (!target || p.label !== def.label || p.unit !== def.unit || parameterBindings.has(binding))
      return false;
    parameterBindings.add(binding);
    const perNode = (parameterCounts.get(p.nodeId) ?? 0) + 1;
    if (perNode > STATUS_LIMITS.maxParametersPerNode) return false;
    parameterCounts.set(p.nodeId, perNode);
    if (
      target.identity.scope === 'physical' &&
      (target.identity.kind !== 'host' || !p.key.startsWith('cpu.'))
    )
      return false;
    if (p.stage === 'effective' && target.identity.scope === 'logical') return false;
    if (!validEvidence(p.evidence)) return false;
    if (p.state === 'unknown') {
      if (p.value !== null || p.evidence.length !== 0) return false;
    } else {
      if (p.value === null) return false;
      if (def.kind === 'boolean' && typeof p.value !== 'boolean') return false;
      if (
        def.kind === 'enum' &&
        (typeof p.value !== 'string' || !(def.values as readonly string[]).includes(p.value))
      )
        return false;
      if ((def.kind === 'number' || def.kind === 'integer') && typeof p.value !== 'number')
        return false;
      if (def.kind === 'integer' && !Number.isSafeInteger(p.value)) return false;
      if (def.unit === 'ratio' && typeof p.value === 'number' && p.value > 1) return false;
      if (p.stage !== 'proposed') {
        const required = p.stage === 'configured' ? 'inventory' : 'runtime';
        if (
          p.evidence.length === 0 ||
          p.evidence.some(
            (e) => sources.get(e.sourceId)?.kind !== required || e.coverage.observed < 1,
          )
        )
          return false;
        const old = p.evidence.some((e) => s.generatedAt - e.observedAt > e.maxAgeSeconds);
        if ((p.state === 'stale') !== old) return false;
      } else if (p.state !== 'known' || p.evidence.length !== 0) return false;
    }
    if (
      new Set(p.reason.evidenceIds).size !== p.reason.evidenceIds.length ||
      p.reason.evidenceIds.some(
        (v) => references.get(v)?.nodeId !== p.nodeId || references.get(v)?.parameterKey !== p.key,
      )
    )
      return false;
    if (p.reason.state === 'unknown') {
      if (p.reason.text !== null || p.reason.evidenceIds.length !== 0) return false;
    } else if (p.reason.text === null || p.reason.evidenceIds.length === 0) return false;
    if (p.stage === 'proposed' && p.state === 'known' && p.reason.state !== 'known') return false;
  }

  const currentGpuHosts = new Map<string, string>();
  for (const e of s.edges) {
    const from = nodes.get(e.from);
    const to = nodes.get(e.to);
    if (!from || !to || from === to || !validState(e)) return false;
    let purpose: string[];
    if (e.kind === 'contains') purpose = ['physical_containment'];
    else if (e.kind === 'allocation') purpose = ['gpu_allocation'];
    else if (e.kind === 'deployment')
      purpose = [to.identity.scope === 'physical' ? 'runtime_placement' : 'workload_binding'];
    else
      purpose = [
        'model_request',
        'document_extraction',
        'retrieval',
        'embedding',
        'reranking',
        'monitoring',
        'storage',
        'network_transport',
      ];
    if (!purpose.includes(e.purpose)) return false;
    if (
      e.kind === 'allocation' &&
      (from.identity.scope !== 'runtime' ||
        to.identity.scope !== 'physical' ||
        to.identity.kind !== 'gpu')
    )
      return false;
    if (
      e.kind === 'deployment' &&
      (from.identity.scope !== 'runtime' || to.identity.scope === 'runtime')
    )
      return false;
    if (
      e.kind === 'contains' &&
      (from.identity.scope !== 'physical' ||
        from.identity.kind !== 'host' ||
        to.identity.scope !== 'physical' ||
        to.identity.kind === 'host')
    )
      return false;
    if (
      e.kind === 'request' &&
      (from.identity.scope === 'physical' || to.identity.scope === 'physical')
    )
      return false;
    if (e.basis === 'observed' && e.evidence.length === 0) return false;
    if (
      e.kind === 'contains' &&
      e.basis === 'observed' &&
      to.identity.kind === 'gpu' &&
      (e.state === 'healthy' || e.state === 'degraded')
    ) {
      const current = currentGpuHosts.get(e.to);
      if (current !== undefined && current !== e.from) return false;
      currentGpuHosts.set(e.to, e.from);
    }
    if (
      e.kind === 'allocation' &&
      e.basis === 'observed' &&
      e.evidence.some((v) => sources.get(v.sourceId)?.kind !== 'runtime')
    )
      return false;
    if (
      e.basis === 'desired' &&
      e.state !== 'unknown' &&
      e.state !== 'disabled' &&
      e.state !== 'stale'
    )
      return false;
    if (
      e.basis === 'desired' &&
      e.evidence.some((v) => sources.get(v.sourceId)?.kind !== 'inventory')
    )
      return false;
  }
  const bindings = new Set<string>();
  for (const m of s.measurements) {
    const def = STATUS_METRICS[m.key];
    const binding = JSON.stringify([m.target, m.key, m.scope]);
    if (bindings.has(binding)) return false;
    bindings.add(binding);
    if (m.unit !== def.unit || m.scope.kind !== def.scope) return false;
    const target = m.target.kind === 'node' ? nodes.get(m.target.id) : edges.get(m.target.id);
    if (!target) return false;
    // Current producer keys have no independently observed caller/callee binding.
    if (m.target.kind === 'edge') return false;
    const resource = nodes.get(m.target.id)!;
    if (
      def.scope === 'gpu' &&
      (resource.identity.scope !== 'physical' || resource.identity.kind !== 'gpu')
    )
      return false;
    if (
      ['host', 'cpu', 'filesystem', 'interface'].includes(def.scope) &&
      (resource.identity.scope !== 'physical' || resource.identity.kind !== 'host')
    )
      return false;
    if (
      m.scope.kind === 'http' &&
      (resource.identity.scope !== 'runtime' || m.scope.instanceId !== resource.identity.key)
    )
      return false;
    const allowedReasons = {
      fresh: ['observed', 'partial_coverage'],
      stale: ['source_stale'],
      unknown: [
        'not_measured',
        'no_traffic',
        'counter_reset',
        'insufficient_samples',
        'not_qualified',
      ],
      unavailable: ['source_unavailable'],
      disabled: ['not_configured'],
      disagreement: ['sources_disagree'],
    };
    if (!allowedReasons[m.state].includes(m.reason)) return false;
    if (new Set(m.samples.map((v) => v.sourceId)).size !== m.samples.length) return false;
    for (const v of m.samples) {
      const source = sources.get(v.sourceId);
      if (
        !source ||
        source.kind !== 'prometheus' ||
        v.observedAt > source.capturedAt ||
        v.windowSeconds !== def.windowSeconds
      )
        return false;
      if (
        v.coverage.observed < 1 ||
        (def.unit === 'ratio' && v.value > 1) ||
        (def.unit === 'count' && !Number.isInteger(v.value))
      )
        return false;
      if (v.sampleCount < (def.windowSeconds ? 4 : 1) || v.resetCount !== 0) return false;
    }
    const selected = m.samples.find((v) => v.sourceId === m.selectedSourceId);
    if (m.state === 'fresh' || m.state === 'stale') {
      if (
        !selected ||
        m.value !== selected.value ||
        sources.get(selected.sourceId)?.observerId !== s.selectedObserverId
      )
        return false;
      const aged = s.generatedAt - selected.observedAt > def.maxAgeSeconds;
      const complete =
        selected.coverage.expected !== null &&
        selected.coverage.observed === selected.coverage.expected;
      if (m.state === 'fresh' && (m.reason === 'observed') !== complete) return false;
      if ((m.state === 'stale') !== aged) return false;
      if (m.samples.some((v) => v.value !== selected.value || v.observedAt !== selected.observedAt))
        return false;
    } else {
      if (m.value !== null || m.selectedSourceId !== null) return false;
      if (m.state === 'disagreement') {
        if (
          m.samples.length !== 2 ||
          (m.samples[0].value === m.samples[1].value &&
            m.samples[0].observedAt === m.samples[1].observedAt)
        )
          return false;
      } else if (m.samples.length !== 0) return false;
    }
  }
  return true;
}

/** Bound traversal and reject accessors/prototypes/sparse arrays before Zod sees caller data. */
function detached(value: unknown): unknown {
  let remaining = STATUS_LIMITS.maxValues;
  const seen = new WeakSet<object>();
  function visit(v: unknown, depth: number): unknown {
    if (--remaining < 0 || depth > STATUS_LIMITS.maxDepth) throw new Error('bounds');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error('number');
      return v;
    }
    if (typeof v === 'string') {
      if (v.length > 256) throw new Error('string');
      return v;
    }
    if (!v || typeof v !== 'object' || seen.has(v)) throw new Error('object');
    seen.add(v);
    const array = Array.isArray(v);
    const proto = Object.getPrototypeOf(v);
    if (proto !== (array ? Array.prototype : Object.prototype) && !(proto === null && !array))
      throw new Error('prototype');
    const keys = Reflect.ownKeys(v);
    if (keys.length > STATUS_LIMITS.maxValues) throw new Error('keys');
    const result: unknown[] | Record<string, unknown> = array ? [] : Object.create(null);
    if (array) {
      const size = Object.getOwnPropertyDescriptor(v, 'length')?.value;
      if (
        !Number.isInteger(size) ||
        size < 0 ||
        size > STATUS_LIMITS.maxMeasurements ||
        keys.length !== size + 1
      )
        throw new Error('array');
      for (let i = 0; i < size; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d?.enumerable || !('value' in d)) throw new Error('descriptor');
        (result as unknown[]).push(visit(d.value, depth + 1));
      }
    } else {
      for (const key of keys) {
        if (typeof key !== 'string' || key.length > 64 || key === '__proto__')
          throw new Error('key');
        const d = Object.getOwnPropertyDescriptor(v, key);
        if (!d?.enumerable || !('value' in d)) throw new Error('descriptor');
        (result as Record<string, unknown>)[key] = visit(d.value, depth + 1);
      }
    }
    seen.delete(v);
    return result;
  }
  return visit(value, 0);
}
export function readStatusSnapshot(value: unknown): StatusSnapshot | null {
  try {
    const data = detached(value);
    if (new TextEncoder().encode(JSON.stringify(data)).byteLength > STATUS_LIMITS.maxBytes)
      return null;
    const result = shape.safeParse(data);
    return result.success && coherent(result.data) ? result.data : null;
  } catch {
    return null;
  }
}
