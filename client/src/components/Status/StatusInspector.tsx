import { statusTranslationKeys } from './classification';
/** Read-only details. Values and explanations always come from the sole public snapshot. */
import { STATUS_METRICS } from 'librechat-data-provider';
import type { StatusSnapshot, StatusMeasurement } from 'librechat-data-provider';
import type { Selection } from './topology';
import { roleLabel, classificationState } from './classification';
import { StatusUsageDetails } from './StatusUsage';
import { nodeState, edgeState } from './topology';
import { useLocalize } from '~/hooks';
export function formatMeasurement(m: StatusMeasurement, locale = 'de-DE'): string {
  if (m.value === null) return '—';
  if (m.unit === 'ratio')
    return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(
      m.value,
    );
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(m.value)} ${m.unit}`;
}
// The strict public DTO owns these bounded identities; never inspect arbitrary metric labels.
function measurementScope(m: StatusMeasurement, t: ReturnType<typeof useLocalize>): string {
  const scope = m.scope;
  switch (scope.kind) {
    case 'host':
      return t('com_status_scope_host');
    case 'gpu':
      return t('com_status_scope_gpu');
    case 'cpu':
      return `${t('com_status_scope_cpu')}: ${scope.cpuId}`;
    case 'interface':
      return `${t('com_status_scope_interface')}: ${scope.interfaceId}`;
    case 'filesystem':
      return `${t('com_status_scope_filesystem')} · ${t('com_status_scope_device')}: ${scope.deviceId} · ${t('com_status_scope_mount')}: ${scope.mountId} · ${t('com_status_scope_fs_type')}: ${scope.fsType}`;
    case 'http':
      return `${t('com_status_scope_http')} · ${t('com_status_scope_method')}: ${scope.method} · ${t('com_status_scope_route')}: ${scope.routeKey} · ${t('com_status_scope_status_code')}: ${scope.statusCode} · ${t('com_status_scope_instance')}: ${scope.instanceId}`;
  }
}
function parameterValue(
  p: StatusSnapshot['parameters'][number],
  t: ReturnType<typeof useLocalize>,
): string {
  if (p.state === 'unknown' || p.value === null) return t('com_status_state_unknown');
  if (typeof p.value === 'boolean') return t(p.value ? 'com_status_yes' : 'com_status_no');
  return String(p.value);
}
export default function StatusInspector({
  usageOpen = false,
  snapshot,
  selection,
  now,
  onSelect,
  onClose,
}: {
  usageOpen?: boolean;
  snapshot: StatusSnapshot;
  selection: Selection;
  now: number;
  onSelect: (value: Selection) => void;
  onClose: () => void;
}) {
  const t = useLocalize();
  if (usageOpen) return <StatusUsageDetails usage={snapshot.usage} now={now} onClose={onClose} />;
  if (!selection) return null;
  const node =
    selection.kind === 'node' ? snapshot.nodes.find((n) => n.id === selection.id) : undefined;
  const edge =
    selection.kind === 'edge' ? snapshot.edges.find((e) => e.id === selection.id) : undefined;
  if (!node && !edge)
    return (
      <aside className="cortex-status-inspector">
        <button onClick={onClose}>{t('com_status_close')}</button>
        <p>{t('com_status_missing_selection')}</p>
      </aside>
    );
  const title =
    node?.label ??
    `${snapshot.nodes.find((n) => n.id === edge?.from)?.label} → ${snapshot.nodes.find((n) => n.id === edge?.to)?.label}`;
  const state = node ? nodeState(node, now) : edgeState(edge!, now);
  const measurements = snapshot.measurements.filter(
    (m) => m.target.kind === selection.kind && m.target.id === selection.id,
  );
  const parameters = snapshot.parameters.filter((p) => p.nodeId === node?.id);
  const connections = node
    ? snapshot.edges.filter((e) => e.from === node.id || e.to === node.id)
    : [];
  return (
    <aside
      className="cortex-status-inspector"
      aria-label={t('com_status_details')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <h2>{title}</h2>
        <button onClick={onClose} aria-label={t('com_status_close')}>
          ×
        </button>
      </div>
      <p className="cortex-status-muted">{t(statusTranslationKeys.state[state])}</p>
      {node && roleLabel(node, t) && (
        <dl>
          <dt>{t('com_status_classification' as never)}</dt>
          <dd>{roleLabel(node, t)}</dd>
          <dt>{t('com_status_basis')}</dt>
          <dd>
            {node.classification
              ? t(statusTranslationKeys.basis[node.classification.basis])
              : t('com_status_state_unknown')}
          </dd>
          <dt>{t('com_status_classification_freshness' as never)}</dt>
          <dd>{t(statusTranslationKeys.classification[classificationState(node, now)])}</dd>
          {node.classification?.evidence.map((proof) => (
            <div className="contents" key={proof.sourceId}>
              <dt>{t('com_status_evidence')}</dt>
              <dd>
                {proof.sourceId} · {new Date(proof.observedAt * 1000).toLocaleString('de-DE')}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {edge && (
        <dl>
          <dt>{t('com_status_direction')}</dt>
          <dd>{title}</dd>
          <dt>{t('com_status_purpose')}</dt>
          <dd>{t(statusTranslationKeys.purpose[edge.purpose])}</dd>
          <dt>{t('com_status_basis')}</dt>
          <dd>{t(statusTranslationKeys.basis[edge.basis])}</dd>
          {edge.membershipRoles && (
            <>
              <dt>{t('com_status_cluster_roles' as never)}</dt>
              <dd>
                {edge.membershipRoles
                  .map((role) => t(statusTranslationKeys.membership[role]))
                  .join(' · ')}
              </dd>
            </>
          )}
          <dt>{t('com_status_reason')}</dt>
          <dd>{t(statusTranslationKeys.reason[edge.reason])}</dd>
        </dl>
      )}
      {node && (
        <>
          <h3>{t('com_status_assessments')}</h3>
          <dl>
            {node.assessments.map((a) => (
              <div key={a.dimension} className="contents">
                <dt>{t(statusTranslationKeys.dimension[a.dimension])}</dt>
                <dd>
                  {t(
                    statusTranslationKeys.state[
                      a.evidence.some((e) => now - e.observedAt > e.maxAgeSeconds) &&
                      ['healthy', 'degraded'].includes(a.state)
                        ? 'stale'
                        : a.state
                    ],
                  )}{' '}
                  · {t(statusTranslationKeys.reason[a.reason])}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
      <h3>{t('com_status_measurements')}</h3>
      {!measurements.length && (
        <p className="cortex-status-muted">{t('com_status_no_measurements')}</p>
      )}
      {measurements.map((m) => {
        const sample = m.samples.find((s) => s.sourceId === m.selectedSourceId);
        const stale = sample && now - sample.observedAt > STATUS_METRICS[m.key].maxAgeSeconds;
        return (
          <div className="cortex-status-parameter" key={m.id}>
            <h4>{m.key}</h4>
            <p className="cortex-status-muted">{measurementScope(m, t)}</p>
            <p>
              {formatMeasurement(m)} · {t(statusTranslationKeys.state[stale ? 'stale' : m.state])}
            </p>
            {sample && (
              <p className="cortex-status-evidence">
                {sample.sourceId} · {new Date(sample.observedAt * 1000).toLocaleString('de-DE')} ·{' '}
                {t('com_status_coverage')}: {sample.coverage.observed}/
                {sample.coverage.expected ?? '—'} · {sample.windowSeconds} {t('com_ui_seconds')}
              </p>
            )}
            {!sample && (
              <p className="cortex-status-muted">{t(statusTranslationKeys.reason[m.reason])}</p>
            )}
          </div>
        );
      })}
      {node && (
        <>
          <h3>{t('com_status_parameters')}</h3>
          {!parameters.length && (
            <p className="cortex-status-muted">{t('com_status_no_parameters')}</p>
          )}
          {parameters.map((p) => (
            <section className="cortex-status-parameter" key={`${p.key}:${p.stage}`}>
              <h4>{p.label}</h4>
              <dl>
                <dt>{t(statusTranslationKeys.stage[p.stage])}</dt>
                <dd>
                  {parameterValue(p, t)} {p.unit !== 'none' && p.unit !== 'boolean' ? p.unit : ''}
                </dd>
                <dt>{t('com_status_state')}</dt>
                <dd>
                  {t(
                    statusTranslationKeys.state[
                      p.state === 'known' &&
                      p.evidence.some((e) => now - e.observedAt > e.maxAgeSeconds)
                        ? 'stale'
                        : p.state
                    ],
                  )}
                </dd>
              </dl>
              <p>
                {p.reason.state === 'known' && p.reason.text
                  ? p.reason.text
                  : t('com_status_no_reason')}
              </p>
              {p.evidence.map((e) => (
                <p key={e.sourceId} className="cortex-status-evidence">
                  {e.sourceId} · {new Date(e.observedAt * 1000).toLocaleString('de-DE')} ·{' '}
                  {t('com_status_coverage')}: {e.coverage.observed}/{e.coverage.expected ?? '—'}
                </p>
              ))}
              {p.reason.evidenceIds.map((id) => {
                const proof = snapshot.parameterEvidence.find((e) => e.id === id);
                return (
                  proof && (
                    <details key={id}>
                      <summary>
                        {t('com_status_evidence')}: {proof.kind}
                      </summary>
                      <p>{proof.summary}</p>
                      <p className="cortex-status-evidence">
                        {proof.sourceId} ·{' '}
                        {new Date(proof.recordedAt * 1000).toLocaleString('de-DE')} ·{' '}
                        {proof.timeBasis}
                        <br />
                        {t('com_status_sha256')} {proof.sha256}
                      </p>
                    </details>
                  )
                );
              })}
            </section>
          ))}
        </>
      )}
      {edge &&
        edge.evidence.map((e) => (
          <p key={e.sourceId} className="cortex-status-evidence">
            {e.sourceId} · {new Date(e.observedAt * 1000).toLocaleString('de-DE')} ·{' '}
            {t('com_status_coverage')}: {e.coverage.observed}/{e.coverage.expected ?? '—'}
          </p>
        ))}
      {!!connections.length && (
        <>
          <h3>{t('com_status_connections')}</h3>
          {connections.map((e) => (
            <button
              key={e.id}
              className="mb-2 w-full text-left"
              onClick={() => onSelect({ kind: 'edge', id: e.id })}
            >
              {snapshot.nodes.find((n) => n.id === e.from)?.label} →{' '}
              {snapshot.nodes.find((n) => n.id === e.to)?.label}
              <br />
              <span className="cortex-status-muted">
                {t(statusTranslationKeys.purpose[e.purpose])} ·{' '}
                {t(statusTranslationKeys.basis[e.basis])}
              </span>
            </button>
          ))}
        </>
      )}
    </aside>
  );
}
