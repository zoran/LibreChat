/** Internal shapes for the single public Status v2 contract; no observation or transport authority. */
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
export const STATUS_KUBERNETES_ROLES = [
  'cluster',
  'api_server',
  'controller_manager',
  'scheduler',
  'etcd',
  'kubelet',
  'container_runtime',
  'network',
  'dns',
] as const;
const classificationEvidence = z.array(evidence).min(1).max(2);
const classification = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('server'),
        role: z.enum(['cpu', 'gpu']),
        basis: z.literal('desired'),
        state: z.enum(['known', 'stale']),
        evidence: classificationEvidence,
      })
      .strict(),
    z
      .object({
        kind: z.literal('kubernetes'),
        role: z.enum(STATUS_KUBERNETES_ROLES),
        basis: z.enum(['desired', 'observed']),
        state: z.enum(['known', 'stale']),
        evidence: classificationEvidence,
      })
      .strict(),
  ])
  .nullable();
const node = z
  .object({
    id,
    identity,
    label,
    classification,
    layer: z.enum([
      'entry',
      'network',
      'application',
      'data',
      'inference',
      'documents',
      'monitoring',
      'hardware',
      'orchestration',
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
    kind: z.enum([
      'contains',
      'deployment',
      'allocation',
      'request',
      'dependency',
      'membership',
      'placement',
    ]),
    membershipRoles: z
      .array(z.enum(['control_plane', 'worker', 'etcd']))
      .min(1)
      .max(3)
      .optional(),
    purpose: z.enum([
      'cluster_membership',
      'stack_component',
      'configured_placement',
      'orchestration',
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

export const shape = z
  .object({
    version: z.literal(2),
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

export type StatusEvidence = z.infer<typeof evidence>;
export type StatusNodeClassification = z.infer<typeof classification>;
