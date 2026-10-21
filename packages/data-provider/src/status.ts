/** Public Status v3 reader: bounds and cross-resource coherence; schemas remain internal. */
import { decodeStatusWire, packStatusWire } from './status-wire';
export type { StatusWireSnapshot } from './status-wire';
export type {
  StatusUsage,
  StatusUsageWindow,
  StatusUsageGroup,
  StatusUsageGroups,
  StatusComparisonReference,
} from './status-usage';
export { createUnknownStatusUsage, STATUS_USAGE_COLUMNS } from './status-usage';
import type { StatusSnapshot, StatusEvidence } from './status-schema';
import {
  shape,
  STATUS_LIMITS,
  STATUS_METRICS,
  STATUS_PARAMETERS,
  statusNodeId,
} from './status-schema';
export {
  STATUS_LIMITS,
  STATUS_ZOOM_PRESETS,
  STATUS_METRICS,
  STATUS_PARAMETERS,
  STATUS_KUBERNETES_ROLES,
  statusNodeId,
} from './status-schema';
export type {
  StatusSnapshot,
  StatusNode,
  StatusEdge,
  StatusMeasurement,
  StatusParameter,
  StatusIdentity,
  StatusMetricKey,
  StatusParameterKey,
  StatusEvidence,
  StatusNodeClassification,
} from './status-schema';

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
  const validEvidence = (items: StatusEvidence[]) =>
    new Set(items.map((v) => v.sourceId)).size === items.length &&
    items.every((v) => {
      const source = sources.get(v.sourceId);
      return source !== undefined && v.observedAt <= source.capturedAt;
    });
  const validState = (v: {
    state: StatusSnapshot['edges'][number]['state'];
    reason: StatusSnapshot['edges'][number]['reason'];
    evidence: StatusEvidence[];
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
    const c = n.classification;
    if (c) {
      const sourceKind = c.basis === 'desired' ? 'inventory' : 'runtime';
      if (
        !validEvidence(c.evidence) ||
        c.evidence.some(
          (e) => sources.get(e.sourceId)?.kind !== sourceKind || e.coverage.observed < 1,
        )
      )
        return false;
      const old = c.evidence.some((e) => s.generatedAt - e.observedAt > e.maxAgeSeconds);
      if ((c.state === 'stale') !== old) return false;
      if (c.kind === 'server') {
        if (n.identity.scope !== 'physical' || n.identity.kind !== 'host' || n.layer !== 'hardware')
          return false;
      } else {
        if (n.layer !== 'orchestration') return false;
        if (
          c.basis === 'desired' &&
          (n.identity.scope !== 'logical' || n.identity.kind !== 'service')
        )
          return false;
        if (c.basis === 'observed' && (n.identity.scope !== 'runtime' || c.role === 'cluster'))
          return false;
      }
    }
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
    if (e.kind === 'membership') purpose = ['cluster_membership', 'stack_component'];
    else if (e.kind === 'placement') purpose = ['configured_placement'];
    else if (e.kind === 'contains') purpose = ['physical_containment'];
    else if (e.kind === 'allocation') purpose = ['gpu_allocation'];
    else if (e.kind === 'deployment')
      purpose = [to.identity.scope === 'physical' ? 'runtime_placement' : 'workload_binding'];
    else
      purpose = [
        'orchestration',
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
    const cluster =
      to.classification?.kind === 'kubernetes' && to.classification.role === 'cluster';
    const component =
      from.classification?.kind === 'kubernetes' && from.classification.role !== 'cluster';
    if (e.kind === 'membership') {
      if (!cluster) return false;
      if (e.purpose === 'cluster_membership') {
        if (
          from.identity.scope !== 'physical' ||
          from.identity.kind !== 'host' ||
          e.basis !== 'desired' ||
          !e.membershipRoles ||
          new Set(e.membershipRoles).size !== e.membershipRoles.length
        )
          return false;
      } else if (
        !component ||
        e.membershipRoles !== undefined ||
        e.basis !== from.classification?.basis
      )
        return false;
    } else if (e.membershipRoles !== undefined) return false;
    if (
      e.kind === 'placement' &&
      (!component ||
        from.identity.scope !== 'logical' ||
        to.identity.scope !== 'physical' ||
        to.identity.kind !== 'host' ||
        e.basis !== 'desired')
    )
      return false;
    if (e.kind === 'membership' || e.kind === 'placement') {
      const sourceKind = e.basis === 'desired' ? 'inventory' : 'runtime';
      if (
        e.basis === 'inferred' ||
        e.evidence.length === 0 ||
        e.evidence.some(
          (v) => sources.get(v.sourceId)?.kind !== sourceKind || v.coverage.observed < 1,
        )
      )
        return false;
    }

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
    const result = decodeStatusWire(data);
    return result && coherent(result) ? result : null;
  } catch {
    return null;
  }
}

/** One external wire contract; internal rich objects are never accepted by the reader. */
export function encodeStatusSnapshot(value: StatusSnapshot) {
  const clean = detached(value) as StatusSnapshot;
  const { usage, ...base } = clean;
  if (!shape.safeParse(base).success || !coherent(clean)) throw new Error('STATUS_DTO_INVALID');
  const wire = packStatusWire({ ...base, usage } as StatusSnapshot);
  if (!readStatusSnapshot(wire)) throw new Error('STATUS_DTO_INVALID');
  return wire;
}
