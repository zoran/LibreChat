/** Presentation of validated classifications; labels and hostnames never establish a resource role. */
import type { StatusNode } from 'librechat-data-provider';
import type { useLocalize } from '~/hooks';

type Localize = ReturnType<typeof useLocalize>;
export function resourceKind(node: StatusNode): string {
  const c = node.classification;
  if (c?.kind === 'server') return `${c.role}-server`;
  if (c?.kind === 'kubernetes') return `kubernetes-${c.role}`;
  return node.identity.kind === 'host' ? 'server-unknown' : 'resource';
}
export function roleLabel(node: StatusNode, t: Localize): string {
  const c = node.classification;
  if (c?.kind === 'server') return t(statusTranslationKeys.role[c.role]);
  if (c?.kind === 'kubernetes') return t(statusTranslationKeys.role[c.role]);
  return node.identity.kind === 'host' ? t('com_status_role_unknown' as never) : '';
}
export function classificationState(node: StatusNode, now: number): 'known' | 'stale' | 'unknown' {
  const c = node.classification;
  if (!c) return 'unknown';
  return c.state === 'stale' || c.evidence.some((e) => now - e.observedAt > e.maxAgeSeconds)
    ? 'stale'
    : 'known';
}
export function nodeDescription(node: StatusNode, t: Localize): string {
  const role = roleLabel(node, t);
  return role ? `${node.label} · ${role}` : node.label;
}

/** Literal keys keep the validated status vocabulary visible to localization tooling. */
export const statusTranslationKeys = {
  stage: {
    configured: 'com_status_stage_configured',
    effective: 'com_status_stage_effective',
    proposed: 'com_status_stage_proposed',
  },
  state: {
    healthy: 'com_status_state_healthy',
    degraded: 'com_status_state_degraded',
    unknown: 'com_status_state_unknown',
    stale: 'com_status_state_stale',
    disabled: 'com_status_state_disabled',
    unavailable: 'com_status_state_unavailable',
    disagreement: 'com_status_state_disagreement',
    fresh: 'com_status_state_fresh',
    known: 'com_status_state_known',
  },
  basis: {
    desired: 'com_status_basis_desired',
    observed: 'com_status_basis_observed',
    inferred: 'com_status_basis_inferred',
  },
  dimension: {
    availability: 'com_status_dimension_availability',
    capacity: 'com_status_dimension_capacity',
    qualification: 'com_status_dimension_qualification',
    app_e2e: 'com_status_dimension_app_e2e',
  },
  purpose: {
    physical_containment: 'com_status_purpose_physical_containment',
    runtime_placement: 'com_status_purpose_runtime_placement',
    workload_binding: 'com_status_purpose_workload_binding',
    gpu_allocation: 'com_status_purpose_gpu_allocation',
    model_request: 'com_status_purpose_model_request',
    document_extraction: 'com_status_purpose_document_extraction',
    retrieval: 'com_status_purpose_retrieval',
    embedding: 'com_status_purpose_embedding',
    reranking: 'com_status_purpose_reranking',
    monitoring: 'com_status_purpose_monitoring',
    storage: 'com_status_purpose_storage',
    network_transport: 'com_status_purpose_network_transport',
    cluster_membership: 'com_status_purpose_cluster_membership',
    stack_component: 'com_status_purpose_stack_component',
    configured_placement: 'com_status_purpose_configured_placement',
    orchestration: 'com_status_purpose_orchestration',
  },
  reason: {
    observed: 'com_status_reason_observed',
    not_measured: 'com_status_reason_not_measured',
    not_configured: 'com_status_reason_not_configured',
    source_unavailable: 'com_status_reason_source_unavailable',
    source_stale: 'com_status_reason_source_stale',
    sources_disagree: 'com_status_reason_sources_disagree',
    partial_coverage: 'com_status_reason_partial_coverage',
    no_traffic: 'com_status_reason_no_traffic',
    counter_reset: 'com_status_reason_counter_reset',
    insufficient_samples: 'com_status_reason_insufficient_samples',
    not_qualified: 'com_status_reason_not_qualified',
  },
  role: {
    cpu: 'com_status_role_cpu',
    gpu: 'com_status_role_gpu',
    unknown: 'com_status_role_unknown',
    cluster: 'com_status_role_cluster',
    api_server: 'com_status_role_api_server',
    controller_manager: 'com_status_role_controller_manager',
    scheduler: 'com_status_role_scheduler',
    etcd: 'com_status_role_etcd',
    kubelet: 'com_status_role_kubelet',
    container_runtime: 'com_status_role_container_runtime',
    network: 'com_status_role_network',
    dns: 'com_status_role_dns',
    legend: 'com_status_role_legend',
  },
  basis_short: {
    desired: 'com_status_basis_short_desired',
    observed: 'com_status_basis_short_observed',
  },
  classification: {
    freshness: 'com_status_classification_freshness',
    known: 'com_status_classification_known',
    stale: 'com_status_classification_stale',
    unknown: 'com_status_classification_unknown',
  },
  membership: {
    control_plane: 'com_status_membership_control_plane',
    worker: 'com_status_membership_worker',
    etcd: 'com_status_membership_etcd',
  },
  preset: {
    overview: 'com_status_preset_overview',
    infrastructure: 'com_status_preset_infrastructure',
    processing: 'com_status_preset_processing',
  },
} as const;
