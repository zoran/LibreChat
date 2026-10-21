/** Platform aggregates from the sole decoded Status contract. Never infer missing observations. */
import { useEffect, useId, useRef, useState } from 'react';
const detailsId = 'cortex-status-usage-details';
import type { TOptions } from 'i18next';
import type { StatusUsage, StatusUsageGroup, StatusUsageWindow } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

type Group = StatusUsageGroup<Record<string, number | null>>;
type Metric = {
  group: keyof StatusUsageWindow['groups'];
  key: string;
  divisor: number;
  unit: string;
};
const metrics: Record<string, Metric> = {
  active: { group: 'users', key: 'active', divisor: 1, unit: '' },
  concurrent_mean: { group: 'users', key: 'concurrentMeanMicros', divisor: 1e6, unit: '' },
  retained_end: { group: 'documents', key: 'retainedEnd', divisor: 1, unit: '' },
  concurrent: { group: 'users', key: 'concurrentPeak', divisor: 1, unit: '' },
  documents: { group: 'documents', key: 'published', divisor: 1, unit: '' },
  input: { group: 'tokens', key: 'input', divisor: 1, unit: '' },
  output: { group: 'tokens', key: 'output', divisor: 1, unit: '' },
  p50: { group: 'latency', key: 'p50Micros', divisor: 1e6, unit: 's' },
  p95: { group: 'latency', key: 'p95Micros', divisor: 1e6, unit: 's' },
  euro: { group: 'valuation', key: 'meanEurMicros', divisor: 1e6, unit: 'EUR' },
};
const referenceSources = {
  openai_api_pricing: ['OpenAI', 'https://developers.openai.com/api/docs/pricing'],
  anthropic_api_pricing: ['Anthropic', 'https://platform.claude.com/docs/en/about-claude/pricing'],
  google_api_pricing: ['Google', 'https://ai.google.dev/gemini-api/docs/pricing#gemini-4-argon'],
  ecb_euro_reference_usd: [
    'Europäische Zentralbank',
    'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/eurofxref-graph-usd.en.html',
  ],
} as const;
const number = (value: number) =>
  new Intl.NumberFormat('de-DE', { maximumFractionDigits: 6 }).format(value);
const utc = (seconds: number) =>
  `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
export function usageQuality(group: Group, now: number): Group['quality'] {
  if (
    group.observedAt !== null &&
    now - group.observedAt > group.maxAgeSeconds &&
    (group.quality === 'complete' || group.quality === 'partial')
  )
    return 'stale';
  return group.quality;
}
export function usageValue(group: Group, key: string, now: number, divisor = 1): number | null {
  const quality = usageQuality(group, now);
  const value = group.values[key];
  return (quality === 'complete' || quality === 'partial') && typeof value === 'number'
    ? value / divisor
    : null;
}
function useUsageText() {
  const t = useLocalize();
  return (key: string, options?: TOptions) => t(`com_status_usage_${key}` as never, options);
}
function Evidence({ group, now }: { group: Group; now: number }) {
  const text = useUsageText();
  return (
    <span className="cortex-status-evidence">
      {text(usageQuality(group, now))} · {text(group.reason)} · {text('coverage')}:{' '}
      {group.coverage.observed}/{group.coverage.expected ?? '—'} {text(group.coverage.basis)}
      {' · '}
      {text('source')}: {group.sourceId ?? text('missing')}
      {' · '}
      {text('age')}:{' '}
      {group.observedAt === null ? '—' : `${number(Math.max(0, now - group.observedAt))} s`}
    </span>
  );
}
function Value({
  group,
  name,
  now,
  divisor = 1,
  unit = '',
}: {
  group: Group;
  name: string;
  now: number;
  divisor?: number;
  unit?: string;
}) {
  const text = useUsageText();
  const value = usageValue(group, name, now, divisor);
  return (
    <>
      {value === null ? '—' : `${number(value)}${unit ? ` ${unit}` : ''}`}
      {usageQuality(group, now) === 'partial' && value !== null && <> ({text('subtotal')})</>}
    </>
  );
}
export default function StatusUsageSummary({
  usage,
  now,
  onDetails,
  detailsOpen = false,
}: {
  usage: StatusUsage;
  now: number;
  onDetails: () => void;
  detailsOpen?: boolean;
}) {
  const text = useUsageText();
  const [metric, setMetric] = useState('active');
  const [hour, setHour] = useState(167);
  const identity = useId();
  const hourId = `${identity}-hour`;
  const readingId = `${identity}-reading`;
  const selected = metrics[metric];
  const rows = usage.history.rows;
  const values = rows.map((row) =>
    usageValue(row.groups[selected.group], selected.key, now, selected.divisor),
  );
  const peak = Math.max(1, ...values.filter((value): value is number => value !== null));
  const row = rows[Math.min(hour, rows.length - 1)];
  const selectedValue = row
    ? usageValue(row.groups[selected.group], selected.key, now, selected.divisor)
    : null;
  const selectedQuality = row ? usageQuality(row.groups[selected.group], now) : 'unknown';
  const hourDescription = row
    ? `${utc(row.start)} – ${utc(row.end)} · ${text(metric)}: ${selectedValue === null ? '—' : `${number(selectedValue)} ${selected.unit}`.trim()} · ${text(selectedQuality)}${selectedQuality === 'partial' ? ` (${text('subtotal')})` : ''}`
    : text('unknown');
  const reference = usage.comparisonReference;
  const current = [
    ['signed_in', usage.current.grants, 'signedInUsers'],
    ['presence', usage.current.presence, 'concurrentUsers'],
    ['retained', usage.current.documents, 'retainedUploadedDocuments'],
    ['active_last_hour', usage.lastHour.groups.users, 'active'],
  ] as const;
  return (
    <section className="cortex-status-usage" aria-label={text('title')}>
      <dl className="cortex-status-usage-counts">
        {current.map(([label, group, key]) => (
          <div key={label}>
            <dt>{text(label)}</dt>
            <dd>
              <Value group={group} name={key} now={now} />
            </dd>
            <dd className="cortex-status-muted">{text(usageQuality(group, now))}</dd>
          </div>
        ))}
      </dl>
      <div className="cortex-status-usage-heading">
        <label>
          {text('history')}{' '}
          <select value={metric} onChange={(event) => setMetric(event.target.value)}>
            {Object.keys(metrics).map((key) => (
              <option key={key} value={key}>
                {text(key)}
              </option>
            ))}
          </select>
        </label>
        <button
          data-usage-details="true"
          aria-expanded={detailsOpen}
          aria-controls={detailsId}
          onClick={onDetails}
        >
          {text('details')}
        </button>
      </div>
      {metric === 'euro' && (
        <p className="cortex-status-evidence" data-euro-reference="true">
          {reference ? (
            <>
              {text('graph_reference')} {reference.valuationDate} ·{' '}
              {reference.fx ? (
                <>
                  {text('fx')} {reference.fx.rateDate} ·{' '}
                  {text(reference.fx.carriedForward ? 'carried' : 'same_day')}
                  {reference.fx.stale && <> · {text('fx_stale')}</>}
                </>
              ) : (
                text('missing_fx')
              )}
            </>
          ) : (
            text('missing_reference')
          )}
        </p>
      )}
      <svg
        className="cortex-status-usage-chart"
        viewBox="0 0 1008 60"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${text(metric)} · ${text('history')} · ${text('gaps')}`}
      >
        {values.map((value, index) =>
          value === null ? null : (
            <rect
              key={rows[index].start}
              x={index * 6 + 1}
              y={58 - (value / peak) * 56}
              width="4"
              height={Math.max(1, (value / peak) * 56)}
              data-quality={usageQuality(rows[index].groups[selected.group], now)}
            >
              <title>
                {utc(rows[index].start)} · {number(value)} {selected.unit} ·{' '}
                {text(usageQuality(rows[index].groups[selected.group], now))}
              </title>
            </rect>
          ),
        )}
      </svg>
      <div className="cortex-status-usage-axis">
        <span>{utc(usage.history.start)}</span>
        <span>{utc(usage.history.end)}</span>
      </div>
      <label className="cortex-status-usage-hour">
        {text('hour')}
        <input
          id={hourId}
          type="range"
          aria-valuetext={hourDescription}
          aria-describedby={readingId}
          min="0"
          max="167"
          value={hour}
          onChange={(event) => setHour(Number(event.target.value))}
          onKeyDown={(event) => {
            let next: number | null = null;
            if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = 167;
            else if (event.key === 'ArrowRight' || event.key === 'ArrowUp')
              next = Math.min(167, hour + 1);
            else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown')
              next = Math.max(0, hour - 1);
            if (next !== null) {
              event.preventDefault();
              setHour(next);
            }
          }}
        />
      </label>
      {row && (
        <output id={readingId} htmlFor={hourId} className="cortex-status-usage-reading">
          {utc(row.start)} – {utc(row.end)}:{' '}
          <Value
            group={row.groups[selected.group]}
            name={selected.key}
            now={now}
            divisor={selected.divisor}
            unit={selected.unit}
          />{' '}
          <Evidence group={row.groups[selected.group]} now={now} />
        </output>
      )}
      <p className="cortex-status-muted">
        {text('gaps')} · {text('window')}
      </p>
    </section>
  );
}
export function StatusUsageDetails({
  usage,
  now,
  onClose,
}: {
  usage: StatusUsage;
  now: number;
  onClose: () => void;
}) {
  const text = useUsageText();
  const reference = usage.comparisonReference;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <aside
      id={detailsId}
      className="cortex-status-inspector"
      aria-label={text('details')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <h2 ref={heading} tabIndex={-1}>
          {text('title')}
        </h2>
        <button onClick={onClose} aria-label={text('close')}>
          ×
        </button>
      </div>
      <p>{text('definitions')}</p>
      <p>{text('documents_definition')}</p>
      <p className="cortex-status-evidence">
        {text('current_at')}: {utc(usage.current.at)}
      </p>
      {[usage.current.grants, usage.current.presence, usage.current.documents].map(
        (group, index) => (
          <p key={index}>
            <Evidence group={group} now={now} />
          </p>
        ),
      )}
      <h3>{text('last_hour')}</h3>
      <p>
        {utc(usage.lastHour.start)} – {utc(usage.lastHour.end)}
      </p>
      {Object.entries(metrics).map(([key, spec]) => (
        <section key={key} className="cortex-status-parameter">
          <h4>{text(key)}</h4>
          <p>
            <Value
              group={usage.lastHour.groups[spec.group]}
              name={spec.key}
              now={now}
              divisor={spec.divisor}
              unit={spec.unit}
            />
          </p>
          <Evidence group={usage.lastHour.groups[spec.group]} now={now} />
        </section>
      ))}
      <p>{text('latency_definition')}</p>
      <dl>
        {['sampleCount', 'eligibleStarts', 'missing', 'aborted', 'hidden', 'replayed'].map(
          (key) => (
            <div className="contents" key={key}>
              <dt>{text(key)}</dt>
              <dd>
                <Value group={usage.lastHour.groups.latency} name={key} now={now} />
              </dd>
            </div>
          ),
        )}
      </dl>
      <p>{text('tokens_definition')}</p>
      <dl>
        {[
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
        ].map((key) => (
          <div className="contents" key={key}>
            <dt>{text(key)}</dt>
            <dd>
              <Value group={usage.lastHour.groups.tokens} name={key} now={now} />
            </dd>
          </div>
        ))}
      </dl>
      <h3>{text('reference')}</h3>
      <p>{text('valuation_definition')}</p>
      {!reference ? (
        <p>{text('missing_reference')}</p>
      ) : (
        <>
          <p>
            {reference.id} · {text('valuation_date')}: {reference.valuationDate} ·{' '}
            {text('review_before')}: {reference.reviewBefore}
          </p>
          <p>
            {text('captured')}: {utc(reference.observedAt)}
          </p>
          {reference.models.map((model, modelIndex) => (
            <section className="cortex-status-parameter" key={model.modelId}>
              <h4>{model.modelId}</h4>
              <p>
                {text('source')}:{' '}
                <a href={referenceSources[model.sourceKey][1]} target="_blank" rel="noreferrer">
                  {referenceSources[model.sourceKey][0]}
                </a>
              </p>
              <p>
                <Value
                  group={usage.lastHour.groups.valuation}
                  name={`model${modelIndex + 1}UsdMicros`}
                  now={now}
                  divisor={1e6}
                  unit="USD"
                />{' '}
                ·{' '}
                <Value
                  group={usage.lastHour.groups.valuation}
                  name={`model${modelIndex + 1}EurMicros`}
                  now={now}
                  divisor={1e6}
                  unit="EUR"
                />
              </p>
              {model.tiers.map((tier, index) => (
                <p key={index}>
                  {tier.upperInputTokens === null
                    ? text(model.tiers.length === 1 ? 'all_tiers' : 'remaining_tier')
                    : `${text('up_to')} ${number(tier.upperInputTokens)} ${text('input_tokens')}`}{' '}
                  · {number(tier.inputUsdMicrosPerMillion / 1e6)} /{' '}
                  {number(tier.outputUsdMicrosPerMillion / 1e6)} USD {text('per_million')}
                </p>
              ))}
            </section>
          ))}
          {!reference.fx ? (
            <p>{text('missing_fx')}</p>
          ) : (
            <p>
              {text('fx')}:{' '}
              {text('fx_equation', { rate: number(reference.fx.usdPerEurMicros / 1e6) })} ·{' '}
              {reference.fx.rateDate} ·{' '}
              <a href={referenceSources.ecb_euro_reference_usd[1]} target="_blank" rel="noreferrer">
                {referenceSources.ecb_euro_reference_usd[0]}
              </a>{' '}
              · {text(reference.fx.carriedForward ? 'carried' : 'same_day')} ·{' '}
              {text(reference.fx.stale ? 'stale' : 'complete')}
            </p>
          )}
        </>
      )}
    </aside>
  );
}
